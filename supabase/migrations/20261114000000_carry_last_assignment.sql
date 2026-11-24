-- 發起時帶入去年的分派，離職的人從缺（工單 #102；Q116 (6)(8)，暫定 OPEN-6；ADR 0007）。用語依 GLOSSARY.md 的分派。
--
--   帶入     launch_step_signer 依去年同一範本 × 廠區、同一分流、同一關卡名稱，取那一關最後的簽核人（含換過的人）。
--            範本改版後 id 會變，改編號時發出的自評表留著舊編號（ADR-0004），所以 id 或編號相同都算同一範本。
--            去年沒有的就是空值，和 #101 的待分派一樣。人都齊了的分流在發起時開始。
--   在職     資料庫連不到 OMS：發起畫面先用 last_year_signers 取得要查的工號，向 OMS 查好，把離職的工號傳給
--            launch_annual_cycle 的 p_departed。只在發起時查一次，之後不再查（Q116 (6)）。
--   從缺     關卡記下原本的人（vacated_emp_id、vacated_name），簽核人留空，也就是待分派；分派新的人時一併清掉。
--            離職的人已不在 OMS 名單，姓名只能從 CSA 自己的 employee_ref 來。
--   紀錄     從缺逐關記 step_vacated。帶入每人每廠記一筆 step_carried（被帶入的人從此能登入，Q116 (8)），逐關記的話
--            一次發起就塞滿紀錄頁。
--   提醒     my_assignment_todo 多 vacancies，首頁的待分派提醒列出從缺的關卡與原本的人。

alter type public.access_change_action add value 'step_carried';
comment on type public.access_change_action is
  '加入放行名單、移出放行名單、角色、檢視廠區、備註；指定、更換、移除廠區負責人；分派、換人、從缺、帶入去年。';

alter table public.assessment_step
  add column vacated_emp_id text,
  add column vacated_name text,
  add constraint assessment_step_vacated_is_empty check (vacated_emp_id is null or signer_emp_id is null);
comment on column public.assessment_step.vacated_emp_id is '從缺：發起時帶入去年的人已離職，這裡記原本的工號；分派新的人後清掉。';
comment on column public.assessment_step.vacated_name is '從缺的人的姓名（發起時的快照）；CSA 沒有這個人的姓名時是空值。';

-- 發起畫面要向 OMS 查在職狀態的工號：去年廠區端關卡的簽核人。
create function public.last_year_signers(p_year integer)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can launch an annual cycle' using errcode = '42501';
  end if;
  return coalesce((
    select array_agg(distinct s.signer_emp_id)
    from public.annual_cycle c
    join public.assessment a on a.cycle_id = c.id
    join public.assessment_step s on s.assessment_id = a.id
    where c.year = p_year - 1 and s.step_group = 'plant' and s.signer_emp_id is not null
  ), '{}');
end
$$;
comment on function public.last_year_signers(integer) is
  '發起 p_year 前要向 OMS 查在職狀態的工號：前一年廠區端關卡的簽核人。';
revoke execute on function public.last_year_signers(integer) from public, anon;
grant execute on function public.last_year_signers(integer) to authenticated;

-- 發起時決定關卡簽核人的唯一一處。稽核室關卡照流程；廠區端帶入去年，p_departed（大寫）裡的人從缺。
drop function public.launch_step_signer(public.route_step);
create function public.launch_step_signer(
  p_step           public.route_step,
  p_branch_unit    text,
  p_template_id    uuid,
  p_template_code  text,
  p_plant_id       uuid,
  p_year           integer,
  p_departed       text[]
)
returns table (signer_emp_id text, vacated_emp_id text, vacated_name text)
language sql
stable
security definer
set search_path = public
as $$
  with last_year as (
    select s.signer_emp_id as emp_id
    from public.annual_cycle c
    join public.assessment a on a.cycle_id = c.id
    join public.assessment_step s on s.assessment_id = a.id
    where p_step.step_group = 'plant'
      and c.year = p_year - 1
      and a.plant_id = p_plant_id
      and (a.template_id = p_template_id or a.template_code = p_template_code)
      and s.step_group = 'plant'
      and s.name = p_step.name
      and s.branch_unit_name is not distinct from p_branch_unit
    order by a.created_at desc, s.position
    limit 1
  ),
  chosen as (
    select coalesce(p_step.signer_emp_id, l.emp_id) as emp_id,
           coalesce(upper(l.emp_id) = any (p_departed), false) as departed
    from (select 1) as one
    left join last_year l on true
  )
  select case when c.departed then null else c.emp_id end,
         case when c.departed then c.emp_id end,
         case when c.departed then (select e.name from public.employee_ref e where e.emp_id = c.emp_id) end
  from chosen c
$$;
comment on function public.launch_step_signer(public.route_step, text, uuid, text, uuid, integer, text[]) is
  '內部用：發起時這一關的簽核人。稽核室照流程；廠區端帶入去年同一範本 × 廠區同一關，離職的人從缺，去年沒有的待分派。';
revoke execute on function public.launch_step_signer(public.route_step, text, uuid, text, uuid, integer, text[]) from public, anon, authenticated;

-- 多 p_departed（OMS 查到離職的工號）；關卡帶入去年、寫紀錄、回傳帶入與從缺的關數。其餘同 20261113000000。
drop function public.launch_annual_cycle(integer, date, jsonb);
create function public.launch_annual_cycle(
  p_year      integer,
  p_due_date  date,
  p_combos    jsonb default null,
  p_departed  text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_selected jsonb;
  v_invalid  jsonb;
  v_missing  jsonb;
  v_cycle    uuid;
  v_new      uuid;
  v_count    integer := 0;
  v_departed text[];
  v_counts   record;
  r          record;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can launch an annual cycle' using errcode = '42501';
  end if;

  if exists (select 1 from public.annual_cycle where year = p_year) then
    return jsonb_build_object('ok', false, 'error', 'cycle_exists');
  end if;

  if p_combos is not null then
    if jsonb_typeof(p_combos) <> 'array' then
      return jsonb_build_object('ok', false, 'error', 'invalid_combo', 'invalid', jsonb_build_array(p_combos));
    end if;
    select jsonb_agg(e) into v_invalid
    from jsonb_array_elements(p_combos) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'template_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(e ->> 'plant_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    if v_invalid is not null then
      return jsonb_build_object('ok', false, 'error', 'invalid_combo', 'invalid', v_invalid);
    end if;
  end if;

  perform 1
  from public.questionnaire_template t
  where t.status = 'active'
    and (p_combos is null or exists (select 1 from jsonb_array_elements(p_combos) e where (e ->> 'template_id')::uuid = t.id))
  order by t.id
  for share;

  perform 1
  from public.approval_route ar
  where ar.status = 'active'
    and (
      p_combos is null
      or exists (
        select 1 from jsonb_array_elements(p_combos) e
        where (e ->> 'template_id')::uuid = ar.template_id and (e ->> 'plant_id')::uuid = ar.plant_id
      )
    )
  order by ar.id
  for share;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.template_code, c.factory_code), '[]'::jsonb)
  into v_selected
  from public.launch_candidates() c
  where p_combos is null
     or exists (
       select 1 from jsonb_array_elements(p_combos) e
       where (e ->> 'template_id')::uuid = c.template_id and (e ->> 'plant_id')::uuid = c.plant_id
     );

  if p_combos is not null then
    select jsonb_agg(e) into v_invalid
    from jsonb_array_elements(p_combos) e
    where not exists (
      select 1 from jsonb_array_elements(v_selected) c
      where (c ->> 'template_id')::uuid = (e ->> 'template_id')::uuid
        and (c ->> 'plant_id')::uuid = (e ->> 'plant_id')::uuid
    );
    if v_invalid is not null then
      return jsonb_build_object('ok', false, 'error', 'invalid_combo', 'invalid', v_invalid);
    end if;
  end if;

  if jsonb_array_length(v_selected) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_combos');
  end if;

  select jsonb_agg(c order by ord)
  into v_missing
  from jsonb_array_elements(v_selected) with ordinality as x(c, ord)
  where c ->> 'problem' is not null;
  if v_missing is not null then
    return jsonb_build_object('ok', false, 'error', 'missing_route', 'missing', v_missing);
  end if;

  v_departed := array(select upper(btrim(d)) from unnest(p_departed) d);

  begin
    insert into public.annual_cycle (year, due_date)
    values (p_year, p_due_date)
    returning id into v_cycle;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'cycle_exists');
  end;

  for r in
    select t.id as template_id, t.code, t.name, t.layout, t.version, c.plant_id, c.route_id
    from jsonb_to_recordset(v_selected) as c(template_id uuid, plant_id uuid, route_id uuid, template_code text, factory_code text)
    join public.questionnaire_template t on t.id = c.template_id
    order by c.template_code, c.factory_code
  loop
    insert into public.assessment (
      cycle_id, plant_id, template_id, template_code, template_name, template_layout, template_version
    )
    values (
      v_cycle, r.plant_id, r.template_id, r.code, r.name, r.layout, r.version
    )
    returning id into v_new;

    insert into public.assessment_section (assessment_id, position, name)
    select v_new, s.position, s.name
    from public.template_section s
    where s.template_id = r.template_id;

    insert into public.assessment_control_point (assessment_id, section_id, position, text)
    select v_new, snap.id, cp.position, cp.text
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.control_point cp on cp.section_id = ts.id
    where ts.template_id = r.template_id;

    insert into public.assessment_control_point_unit (assessment_id, control_point_id, position, assessing_unit_name)
    select v_new, snap_cp.id, cpu.position, u.name
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.control_point cp on cp.section_id = ts.id
    join public.assessment_control_point snap_cp on snap_cp.section_id = snap.id and snap_cp.position = cp.position
    join public.control_point_unit cpu on cpu.control_point_id = cp.id
    join public.assessing_unit u on u.id = cpu.assessing_unit_id
    where ts.template_id = r.template_id;

    insert into public.assessment_section_document (
      assessment_id, section_id, position, document_number, document_code, document_name, document_version, pdf_file
    )
    select v_new, snap.id, scd.position, d.number, d.code, d.name, ver.version, ver.pdf_file
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.section_control_document scd on scd.section_id = ts.id and scd.plant_id = r.plant_id
    join public.control_document_version ver on ver.id = scd.version_id
    join public.control_document d on d.id = ver.document_id
    where ts.template_id = r.template_id;

    insert into public.assessment_control_reference (
      assessment_id, control_point_id, position, document_number, document_code, document_name, document_version, pdf_file,
      clause_number, clause_text
    )
    select v_new, snap_cp.id, cr.position, d.number, d.code, d.name, ver.version, ver.pdf_file,
           cl.number, public.clause_text_with_subclauses(cl.id)
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.control_point cp on cp.section_id = ts.id
    join public.assessment_control_point snap_cp on snap_cp.section_id = snap.id and snap_cp.position = cp.position
    join public.control_reference cr on cr.control_point_id = cp.id and cr.plant_id = r.plant_id
    join public.control_clause cl on cl.id = cr.clause_id
    join public.control_document_version ver on ver.id = cl.version_id
    join public.control_document d on d.id = ver.document_id
    where ts.template_id = r.template_id;

    insert into public.assessment_step (
      assessment_id, position, name, step_group, signer_emp_id, editable_unit_name, branch_unit_name, vacated_emp_id, vacated_name
    )
    select v_new, rs.position, rs.name, rs.step_group, who.signer_emp_id, u.name, bu.name, who.vacated_emp_id, who.vacated_name
    from public.route_step rs
    left join public.assessing_unit u on u.id = rs.editable_unit_id
    left join public.assessing_unit bu on bu.id = rs.branch_unit_id
    cross join lateral public.launch_step_signer(rs, bu.name, r.template_id, r.code, r.plant_id, p_year, v_departed) who
    where rs.route_id = r.route_id;
    -- 人都齊了的分流同時開始（Q116 (1)）；待分派的等分派。
    perform public.refresh_assessment_steps(v_new);

    v_count := v_count + 1;
  end loop;

  perform public.log_access_change(
    s.vacated_emp_id, 'step_vacated', null,
    jsonb_build_object('year', p_year, 'plant', p.factory_code, 'template', a.template_code, 'step', s.name, 'branch', s.branch_unit_name),
    s.vacated_name
  )
  from public.assessment a
  join public.plant p on p.id = a.plant_id
  join public.assessment_step s on s.assessment_id = a.id
  where a.cycle_id = v_cycle and s.vacated_emp_id is not null;

  perform public.log_access_change(x.signer_emp_id, 'step_carried', null,
    jsonb_build_object('year', p_year, 'plant', x.factory_code, 'steps', x.steps))
  from (
    select s.signer_emp_id, p.factory_code, count(*)::int as steps
    from public.assessment a
    join public.plant p on p.id = a.plant_id
    join public.assessment_step s on s.assessment_id = a.id
    where a.cycle_id = v_cycle and s.step_group = 'plant' and s.signer_emp_id is not null
    group by s.signer_emp_id, p.factory_code
  ) x;

  select count(*) filter (where s.signer_emp_id is not null)::int as carried,
         count(*) filter (where s.vacated_emp_id is not null)::int as vacated,
         count(*) filter (where s.signer_emp_id is null and s.vacated_emp_id is null)::int as unassigned
  into v_counts
  from public.assessment a
  join public.assessment_step s on s.assessment_id = a.id
  where a.cycle_id = v_cycle and s.step_group = 'plant';

  return jsonb_build_object(
    'ok', true, 'cycle_id', v_cycle, 'assessments', v_count,
    'carried', v_counts.carried, 'vacated', v_counts.vacated, 'unassigned', v_counts.unassigned
  );
end
$$;
comment on function public.launch_annual_cycle(integer, date, jsonb, text[]) is
  '依啟用範本與適用廠區發起年度作業；組合資格與候選清單同一來源（launch_candidates）。p_departed 是 OMS 查到離職的工號，帶入去年時那一關從缺（Q116 (6)）。';
revoke execute on function public.launch_annual_cycle(integer, date, jsonb, text[]) from public, anon;
grant execute on function public.launch_annual_cycle(integer, date, jsonb, text[]) to authenticated;

-- 分派新的人時清掉從缺的記號；其餘同 20261113000000。
create or replace function public.assign_step_signer(p_step_id uuid, p_emp_id text, p_emp_name text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s        public.assessment_step;
  a        public.assessment;
  -- 照 OMS 名單給的寫法存，輪到誰一律和登入的工號直接比對；放行名單那種統一大寫只有 is_admitted 比對時用。
  v_emp    text := btrim(p_emp_id);
  v_where  jsonb;
begin
  select assessment_id into s.assessment_id from public.assessment_step where id = p_step_id;
  if s.assessment_id is null then
    raise exception 'step % not found', p_step_id using errcode = 'P0002';
  end if;
  if not (public.is_audit_admin() or public.coordinates_assessment_plant(s.assessment_id)) then
    raise exception 'only the 廠區負責人 of this plant or a 稽核管理者 can assign a 關卡' using errcode = '42501';
  end if;
  -- 和送出、核准、退回同樣依自評表那一列排隊，鎖到之後才讀關卡的狀態。
  select * into a from public.assessment where id = s.assessment_id for update;
  select * into s from public.assessment_step where id = p_step_id;

  if a.status <> 'in_progress' then
    raise exception '這張自評表已結案' using errcode = '23514', hint = 'assessment_closed';
  end if;
  if s.step_group <> 'plant' then
    raise exception '稽核室的關卡不由廠區分派' using errcode = '23514', hint = 'audit_step';
  end if;
  if s.state = 'done' then
    raise exception '已簽的關卡不能換人' using errcode = '23514', hint = 'step_signed';
  end if;
  if coalesce(v_emp, '') = '' then
    raise exception '簽核人不能空白' using errcode = '23514', hint = 'signer_required';
  end if;
  if s.signer_emp_id is not distinct from v_emp then
    return;
  end if;

  update public.assessment_step set signer_emp_id = v_emp, vacated_emp_id = null, vacated_name = null where id = s.id;
  perform public.refresh_assessment_steps(a.id);

  v_where := jsonb_build_object(
    'year', (select c.year from public.annual_cycle c where c.id = a.cycle_id),
    'plant', (select p.factory_code from public.plant p where p.id = a.plant_id),
    'template', a.template_code,
    'step', s.name,
    'branch', s.branch_unit_name
  );
  if s.signer_emp_id is null then
    perform public.log_access_change(v_emp, 'step_assigned', null, v_where, nullif(btrim(p_emp_name), ''));
  else
    perform public.log_access_change(v_emp, 'step_reassigned',
      jsonb_build_object('emp_id', s.signer_emp_id, 'name', (select name from public.employee_ref where emp_id = s.signer_emp_id)),
      v_where, nullif(btrim(p_emp_name), ''));
  end if;
end
$$;

-- 待分派提醒多列從缺的關卡與原本的人；其餘同 20261113000000。
create or replace view public.my_assignment_todo
with (security_invoker = true) as
select
  p.id                             as plant_id,
  p.factory_code,
  p.name                           as plant_name,
  c.year,
  c.due_date,
  count(distinct a.id)::int        as assessments,
  count(*)::int                    as steps,
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'template_code', a.template_code,
        'name', s.name,
        'branch_unit_name', s.branch_unit_name,
        'vacated_emp_id', s.vacated_emp_id,
        'vacated_name', s.vacated_name
      ) order by a.template_code, s.position
    ) filter (where s.vacated_emp_id is not null),
    '[]'::jsonb
  )                                as vacancies
from public.plant_coordinator pc
join public.plant p on p.id = pc.plant_id
join public.assessment a on a.plant_id = p.id and a.status = 'in_progress'
join public.annual_cycle c on c.id = a.cycle_id
join public.assessment_step s on s.assessment_id = a.id and s.signer_emp_id is null
where pc.emp_id = public.current_emp_id()
group by p.id, p.factory_code, p.name, c.year, c.due_date;
comment on view public.my_assignment_todo is
  '目前登入者負責的廠區還有多少待分派：一廠一年度一列，assessments 張、steps 關，vacancies 是其中從缺的關卡。';
