-- OMS 連不上時照樣發起，不帶入去年（Q131，修訂 Q116 (17)）：前端查不到在職狀態就送 p_carry = false，廠區端關卡
-- 一律待分派（不算從缺、不記從缺紀錄），由廠區管理員分派；稽核室關卡照流程。回傳多一個 carry，畫面據此說明。
-- p_carry 預設 true，其餘同 20261125000000（launch_annual_cycle）與 20261114000000（launch_step_signer）。

drop function public.launch_annual_cycle(integer, date, jsonb, text[]);
drop function public.launch_step_signer(public.route_step, text, uuid, text, uuid, integer, text[]);

-- 發起時決定關卡簽核人的唯一一處。稽核室關卡照流程；廠區端 p_carry 時帶入去年，p_departed（大寫）裡的人從缺。
create function public.launch_step_signer(
  p_step           public.route_step,
  p_branch_unit    text,
  p_template_id    uuid,
  p_template_code  text,
  p_plant_id       uuid,
  p_year           integer,
  p_departed       text[],
  p_carry          boolean
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
    where p_carry
      and p_step.step_group = 'plant'
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
comment on function public.launch_step_signer(public.route_step, text, uuid, text, uuid, integer, text[], boolean) is
  '內部用：發起時這一關的簽核人。稽核室照流程；廠區端 p_carry 時帶入去年同一範本 × 廠區同一關，離職的人從缺，去年沒有的或不帶入時待分派。';
revoke execute on function public.launch_step_signer(public.route_step, text, uuid, text, uuid, integer, text[], boolean) from public, anon, authenticated;

create function public.launch_annual_cycle(
  p_year      integer,
  p_due_date  date,
  p_combos    jsonb default null,
  p_departed  text[] default '{}',
  p_carry     boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_selected jsonb;
  v_invalid  jsonb;
  v_launched jsonb;
  v_missing  jsonb;
  v_cycle    uuid;
  v_due      date;
  v_top_up   boolean;
  v_new      uuid;
  v_ids      uuid[] := '{}';
  v_departed text[];
  v_counts   record;
  r          record;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can launch an annual cycle' using errcode = '42501';
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

  -- 同一年度的發起排隊：後到的在先到的提交之後才讀已發起的組合（之後每一句都看得到它的結果）。
  perform pg_advisory_xact_lock(hashtext('csa.launch_annual_cycle'), p_year);

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

  -- 不給組合＝該年度還沒發過的全部；給了就照給的，已發過的留著下面拒絕。
  select coalesce(jsonb_agg(to_jsonb(c) order by c.template_code, c.factory_code), '[]'::jsonb)
  into v_selected
  from public.launch_candidates() c
  where (p_combos is null and not p_year = any (c.launched_years))
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
  into v_launched
  from jsonb_array_elements(v_selected) with ordinality as x(c, ord)
  where c -> 'launched_years' @> to_jsonb(p_year);
  if v_launched is not null then
    return jsonb_build_object('ok', false, 'error', 'already_launched', 'launched', v_launched);
  end if;

  select jsonb_agg(c order by ord)
  into v_missing
  from jsonb_array_elements(v_selected) with ordinality as x(c, ord)
  where c ->> 'problem' is not null;
  if v_missing is not null then
    return jsonb_build_object('ok', false, 'error', 'missing_route', 'missing', v_missing);
  end if;

  v_departed := array(select upper(btrim(d)) from unnest(p_departed) d);

  select id, due_date into v_cycle, v_due from public.annual_cycle where year = p_year;
  v_top_up := v_cycle is not null;
  if not v_top_up then
    insert into public.annual_cycle (year, due_date)
    values (p_year, p_due_date)
    returning id, due_date into v_cycle, v_due;
  end if;

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
    v_ids := v_ids || v_new;

    insert into public.assessment_section (assessment_id, position, name, level, code)
    select v_new, s.position, s.name, s.level, s.code
    from public.template_section s
    where s.template_id = r.template_id;

    insert into public.assessment_control_point (assessment_id, section_id, position, text, code)
    select v_new, snap.id, cp.position, cp.text, cp.code
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
    cross join lateral public.launch_step_signer(rs, bu.name, r.template_id, r.code, r.plant_id, p_year, v_departed, p_carry) who
    where rs.route_id = r.route_id;
    -- 人都齊了的分流同時開始（Q116 (1)）；待分派的等分派。
    perform public.refresh_assessment_steps(v_new);
  end loop;

  perform public.log_access_change(
    s.vacated_emp_id, 'step_vacated', null,
    jsonb_build_object('year', p_year, 'plant', p.factory_code, 'template', a.template_code, 'step', s.name, 'branch', s.branch_unit_name),
    s.vacated_name
  )
  from public.assessment a
  join public.plant p on p.id = a.plant_id
  join public.assessment_step s on s.assessment_id = a.id
  where a.id = any (v_ids) and s.vacated_emp_id is not null;

  perform public.log_access_change(x.signer_emp_id, 'step_carried', null,
    jsonb_build_object('year', p_year, 'plant', x.factory_code, 'steps', x.steps))
  from (
    select s.signer_emp_id, p.factory_code, count(*)::int as steps
    from public.assessment a
    join public.plant p on p.id = a.plant_id
    join public.assessment_step s on s.assessment_id = a.id
    where a.id = any (v_ids) and s.step_group = 'plant' and s.signer_emp_id is not null
    group by s.signer_emp_id, p.factory_code
  ) x;

  select count(*) filter (where s.signer_emp_id is not null)::int as carried,
         count(*) filter (where s.vacated_emp_id is not null)::int as vacated,
         count(*) filter (where s.signer_emp_id is null and s.vacated_emp_id is null)::int as unassigned
  into v_counts
  from public.assessment_step s
  where s.assessment_id = any (v_ids) and s.step_group = 'plant';

  return jsonb_build_object(
    'ok', true, 'cycle_id', v_cycle, 'top_up', v_top_up, 'due_date', v_due, 'assessments', cardinality(v_ids),
    'carried', v_counts.carried, 'vacated', v_counts.vacated, 'unassigned', v_counts.unassigned, 'carry', p_carry
  );
end
$$;
comment on function public.launch_annual_cycle(integer, date, jsonb, text[], boolean) is
  '依啟用範本與適用廠區發起年度作業；年度已存在就補發，沿用它的截止日，只發還沒發過的組合（Q119）。組合資格與候選清單同一來源（launch_candidates）。p_departed 是 OMS 查到離職的工號（Q116 (6)）；p_carry = false 是 OMS 連不上，廠區端不帶入去年、全部待分派（Q131）。';
revoke execute on function public.launch_annual_cycle(integer, date, jsonb, text[], boolean) from public, anon;
grant execute on function public.launch_annual_cycle(integer, date, jsonb, text[], boolean) to authenticated;
