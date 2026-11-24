-- 廠區負責人分派填寫人與換人（工單 #101；Q116 (5)(7)(8)、Q117 (5)，暫定 OPEN-6；ADR 0007）。用語依 GLOSSARY.md 的
-- 分派、換人、放行名單。
--
--   流程     廠區端的關卡（分流與匯流後的廠區經理人）不再設人名，只有稽核室的關卡有簽核人。現有流程的廠區端人名一併
--            清掉：已發出的自評表有自己的快照，#102 帶入去年也是從去年的自評表帶。
--   發起     關卡的簽核人只在 launch_step_signer 一處決定（#102 改這裡帶入去年）；廠區端是空值，也就是待分派。
--            廠區沒有廠區負責人就不能發起（launch_candidates 的 no_coordinator）：沒有人收得到待分派提醒。
--   開始     一條分流要所有關卡都有人才開始，別的分流不受影響；匯流後的關卡有人才輪得到。還沒開始的關卡 state 是
--            pending（只由 refresh_assessment_steps 判斷），不需要新的狀態；「待分派」＝ signer_emp_id 是空值。
--   分派換人 同一個 assign_step_signer：廠區負責人管本廠、稽核管理者管全部；只有廠區端、還沒簽（state 不是 done）的關卡
--            可以改，正在輪到的也可以，答案屬於自評表，新的人接著填。本廠的限制在畫面的名單（OMS 名單只有瀏覽器
--            讀得到，資料庫沒有員工主檔可以驗）。
--   放行     做法 A：is_admitted 多看分派，還有沒結案的自評表的廠區端關卡就放行，全部結案後下一次換證就擋下
--            （Q117 (5)）；不寫放行名單，名單維持由稽核管理者維護。
--   紀錄     權限異動紀錄多 step_assigned、step_reassigned、step_vacated（從缺，#102 發起時寫）。

alter type public.access_change_action add value 'step_assigned';
alter type public.access_change_action add value 'step_reassigned';
alter type public.access_change_action add value 'step_vacated';
comment on type public.access_change_action is
  '加入放行名單、移出放行名單、角色、檢視廠區、備註；指定、更換、移除廠區負責人；分派、換人、從缺。';

-- 流程與自評表的簽核人 ------------------------------------------------------------------------------------

-- 清人名不影響啟用檢查，也不是「修改流程」：關掉 before_write（它會改 updated_at）與 keep_active_route_ready，
-- 否則延遲觸發器還沒跑，下面的 add constraint 會失敗。
alter table public.route_step disable trigger user;
alter table public.route_step alter column signer_emp_id drop not null;
update public.route_step set signer_emp_id = null where step_group = 'plant';
alter table public.route_step enable trigger user;
alter table public.route_step
  add constraint route_step_signer_audit_only check ((step_group = 'plant') = (signer_emp_id is null));
comment on column public.route_step.signer_emp_id is
  '稽核室關卡的簽核人工號；廠區端的關卡一律空值，自評表發出後由廠區負責人分派（Q116 (5)）。';

alter table public.assessment_step alter column signer_emp_id drop not null;
alter table public.assessment_step
  add constraint assessment_step_signer_when_turn check (
    signer_emp_id is not null or (step_group = 'plant' and state = 'pending')
  );
comment on column public.assessment_step.signer_emp_id is
  '這一關的簽核人工號；空值＝待分派（只有還沒開始的廠區端關卡會是空值）。';

-- 發起時決定關卡簽核人的唯一一處：稽核室關卡照流程，廠區端是空值（待分派）。
create function public.launch_step_signer(p_step public.route_step)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p_step.signer_emp_id
$$;
comment on function public.launch_step_signer(public.route_step) is
  '內部用：發起時這一關的簽核人；廠區端是空值（待分派），之後由廠區負責人分派。';
revoke execute on function public.launch_step_signer(public.route_step) from public, anon, authenticated;

-- 沒有廠區負責人的廠區不能發起。其餘同 20261022000000。
create or replace function public.launch_candidates()
returns table (
  template_id      uuid,
  template_code    text,
  template_name    text,
  template_version text,
  plant_id         uuid,
  factory_code     text,
  plant_name       text,
  route_id         uuid,
  step_count       integer,
  problem          text,
  activation_check jsonb
)
language sql
stable
set search_path = public
as $$
  select
    t.id, t.code, t.name, t.version,
    p.id, p.factory_code, p.name,
    ar.id,
    (select count(*)::integer from public.route_step rs where rs.route_id = ar.id),
    case
      when ar.id is null then 'no_route'
      when not (chk.result ->> 'ready')::boolean then 'not_ready'
      when not exists (select 1 from public.plant_coordinator pc where pc.plant_id = p.id) then 'no_coordinator'
    end,
    chk.result
  from public.questionnaire_template t
  join public.plant p
    on t.all_plants
    or exists (select 1 from public.template_plant tp where tp.template_id = t.id and tp.factory_code = p.factory_code)
  left join public.approval_route ar
    on ar.template_id = t.id and ar.plant_id = p.id and ar.status = 'active'
  left join lateral (select public.activation_check(ar) as result where ar.id is not null) chk on true
  where t.status = 'active'
  order by t.code, p.factory_code
$$;
comment on function public.launch_candidates() is
  '年度發起的候選組合（啟用範本 × 適用廠區）與能否發起：problem null／no_route／not_ready／no_coordinator。';

-- 簽核人改由 launch_step_signer 決定；其餘同 20261109000000。
create or replace function public.launch_annual_cycle(
  p_year      integer,
  p_due_date  date,
  p_combos    jsonb default null
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
      assessment_id, position, name, step_group, signer_emp_id, editable_unit_name, branch_unit_name
    )
    select v_new, rs.position, rs.name, rs.step_group, public.launch_step_signer(rs), u.name, bu.name
    from public.route_step rs
    left join public.assessing_unit u on u.id = rs.editable_unit_id
    left join public.assessing_unit bu on bu.id = rs.branch_unit_id
    where rs.route_id = r.route_id;
    -- 人都齊了的分流同時開始（Q116 (1)）；待分派的等分派。
    perform public.refresh_assessment_steps(v_new);

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'cycle_id', v_cycle, 'assessments', v_count);
end
$$;

-- 關卡的狀態（同 20261109000000，多兩個條件）：分流要所有關卡都有人才開始；匯流後輪到的關卡要有人。
create or replace function public.refresh_assessment_steps(p_assessment_id uuid)
returns public.assessment_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status    public.assessment_status;
  v_all_done  boolean;
begin
  select status into v_status from public.assessment where id = p_assessment_id;
  if v_status is distinct from 'in_progress' then
    return v_status;
  end if;

  with steps as (
    select s.id, s.position, s.branch_unit_name, s.signer_emp_id, s.state,
           exists (
             select 1 from public.assessment_signoff g
             where g.step_id = s.id and g.action in ('submit', 'approve') and g.voided_by is null
           ) as signed
    from public.assessment_step s
    where s.assessment_id = p_assessment_id
  ),
  per_branch as (
    select steps.*,
           min(position) filter (where not signed) over (partition by branch_unit_name) as first_open,
           bool_and(signed) filter (where branch_unit_name is not null) over () as merged,
           bool_or(signer_emp_id is null) over (partition by branch_unit_name) as line_has_vacancy
    from steps
  ),
  derived as (
    select id, state as old_state,
           case
             when branch_unit_name is null and not coalesce(merged, true) then 'pending'
             when first_open is null or position < first_open then 'done'
             when position > first_open then 'pending'
             when signer_emp_id is null or (branch_unit_name is not null and line_has_vacancy) then 'pending'
             else 'current'
           end::public.step_state as new_state
    from per_branch
  ),
  changed as (
    update public.assessment_step s
    set state = d.new_state
    from derived d
    where s.id = d.id and d.new_state <> d.old_state
    returning s.id
  )
  select bool_and(new_state = 'done') into v_all_done from derived;

  -- 每次都寫自評表那一列：結案，或只更新 updated_at（和原本推進 current_step_position 一樣記下最後異動）。
  update public.assessment
  set status = case when v_all_done then 'closed'::public.assessment_status else status end
  where id = p_assessment_id
  returning status into v_status;
  return v_status;
end
$$;
comment on function public.refresh_assessment_steps(uuid) is
  '內部用：依有效的送出與核准重算一張自評表每一關的狀態（各分流並行、人都齊了才開始、全部完成才匯流），全部完成就結案。';

-- 摘要的「目前關卡」：還沒有人輪到（全部待分派，或匯流後等廠區經理人）時是最前面一個還沒完成的關卡。
create or replace function public.current_step_position(a public.assessment)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when a.status = 'closed' then (select max(s.position) from public.assessment_step s where s.assessment_id = a.id)
    else (
      select coalesce(min(s.position) filter (where s.state = 'current'), min(s.position))
      from public.assessment_step s
      where s.assessment_id = a.id and s.state <> 'done'
    )
  end
$$;
comment on function public.current_step_position(public.assessment) is
  '摘要：簽核中＝最前面一個輪到的關卡順序，沒有人輪到（待分派）時是最前面一個還沒完成的關卡；結案＝最後一關。規則請讀 assessment_step.state。';

-- 階段：還有單位沒送出就是填寫中，待分派的單位也算（Q116 (11)）。
create or replace function public.assessment_stage(a public.assessment)
returns public.assessment_stage
language sql
stable
security definer
set search_path = public
as $$
  select case
    when a.status = 'closed' then 'closed'
    when exists (
      select 1 from public.assessment_step s
      where s.assessment_id = a.id and s.state <> 'done' and s.editable_unit_name is not null
    ) then 'filling'
    else 'signing'
  end::public.assessment_stage
$$;
comment on function public.assessment_stage(public.assessment) is
  '「填寫中」的唯一定義：簽核中而且有任何一個單位還沒送出（含還在待分派的）；其餘簽核中的是簽核中，結案是結案（Q115、Q116 (11)）。';

-- 追蹤總覽：同 20261112000000，待分派的分流也算還在等，所以停留天數算得到它；它的簽核人是空值。
create or replace view public.tracking_assessment
with (security_invoker = true) as
with me as materialized (
  select public.is_audit_admin() as all_plants, public.my_tracking_plant_ids() as plant_ids
)
select
  a.id                        as assessment_id,
  c.year,
  c.due_date,
  co.id                       as company_id,
  co.name                     as company_name,
  p.id                        as plant_id,
  p.factory_code,
  p.name                      as plant_name,
  a.template_id,
  a.template_code,
  a.template_name,
  a.template_version,
  a.status,
  s.position                  as current_step_position,
  (select count(*)::int from public.assessment_step n where n.assessment_id = a.id) as step_count,
  s.name                      as current_step_name,
  s.signer_emp_id             as current_signer_emp_id,
  n.name                      as current_signer_name,
  s.entered_step_at,
  case when a.status = 'in_progress'
    then (now() at time zone 'Asia/Taipei')::date - (s.entered_step_at at time zone 'Asia/Taipei')::date
  end                         as days_at_step,
  case when a.status = 'closed' then s.entered_step_at end as closed_at,
  public.assessment_stage(a)  as stage,
  public.taipei_days_until(c.due_date) as due_in_days,
  b.branch_count,
  b.branches_done,
  s.branch_unit_name          as current_step_branch_unit
from public.assessment a
join public.annual_cycle c on c.id = a.cycle_id
join public.plant p on p.id = a.plant_id
join public.company co on co.id = p.company_id
cross join me
cross join lateral (
  select count(*)::int as branch_count, count(*) filter (where u.done)::int as branches_done
  from (
    select bool_and(u.state = 'done') as done
    from public.assessment_step u
    where u.assessment_id = a.id and u.branch_unit_name is not null
    group by u.branch_unit_name
  ) u
) b
cross join lateral (
  -- 匯流前：每條沒完成的分流目前的關卡（待分派的分流是它的第一關），取最久沒動的那條（同樣久取關卡順序在前的）。
  -- 其餘：最前面一個輪到的關卡。
  select st.position, st.name, st.signer_emp_id, st.branch_unit_name, act.at as entered_step_at
  from public.assessment_step st
  cross join lateral (
    select coalesce(max(g.signed_at), a.created_at) as at
    from public.assessment_signoff g
    where g.assessment_id = a.id
      and (
        st.branch_unit_name is null
        or exists (
          select 1 from public.assessment_step bs
          where bs.assessment_id = a.id and bs.branch_unit_name = st.branch_unit_name
            and bs.position in (g.step_position, g.return_to_position)
        )
      )
  ) act
  -- 最前面一個輪到的關卡一定在候選裡，所以每張表都有一列；匯流前它本身也是某條分流的關卡。
  where st.assessment_id = a.id
    and (
      st.position = public.current_step_position(a)
      or (
        a.status = 'in_progress' and b.branches_done < b.branch_count and st.branch_unit_name is not null
        and (
          st.state = 'current'
          or (
            st.state = 'pending'
            and not exists (
              select 1 from public.assessment_step e
              where e.assessment_id = a.id and e.branch_unit_name = st.branch_unit_name and e.position < st.position
            )
            and exists (
              select 1 from public.assessment_step v
              where v.assessment_id = a.id and v.branch_unit_name = st.branch_unit_name and v.signer_emp_id is null
            )
          )
        )
      )
    )
  order by act.at, st.position
  limit 1
) s
left join public.tracking_signer_names() n on n.emp_id = s.signer_emp_id
where me.all_plants or a.plant_id = any(me.plant_ids);
comment on view public.tracking_assessment is
  '追蹤總覽（稽核管理者看全部、檢視者與廠區負責人看自己的廠區）：每張自評表顯示的關卡、簽核人與停留天數。匯流前顯示最久沒動的那條分流'
  '目前的關卡（待分派的分流是它的第一關，簽核人空值），停留天數從那條分流最後一筆簽核紀錄（或發起）起算；匯流後與結案是最前面一個輪到的'
  '關卡，從最後一筆簽核紀錄起算（Q95、Q116 (11)）。branch_count／branches_done＝適用單位數／已核准單位數；stage＝填寫中／簽核中／結案（Q115）。';

-- 自動放行（做法 A，Q116 (8)、Q117 (5)）------------------------------------------------------------------

create or replace function public.is_admitted(p_emp_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.access_allowlist where emp_id = upper(btrim(p_emp_id)))
      or exists (
           select 1
           from public.assessment_step s
           join public.assessment a on a.id = s.assessment_id
           where upper(s.signer_emp_id) = upper(btrim(p_emp_id))
             and s.step_group = 'plant'
             and a.status = 'in_progress'
         )
$$;
comment on function public.is_admitted(text) is
  '這個工號能不能換到 CSA 的登入：在放行名單上，或被分派到還沒結案的自評表（Q116 (8)）。只給換證服務（service_role）呼叫。';

-- 分派與換人 ---------------------------------------------------------------------------------------------

-- 被分派的人多半還沒登入過，employee_ref 沒有他的姓名，所以由呼叫端帶 OMS 名單上的姓名。
drop function public.log_access_change(text, public.access_change_action, jsonb, jsonb);
create function public.log_access_change(
  p_target text,
  p_action public.access_change_action,
  p_before jsonb,
  p_after jsonb,
  p_target_name text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.access_change_log (actor_emp_id, actor_name, target_emp_id, target_name, action, before, after)
  select public.current_emp_id(),
         (select name from public.employee_ref where emp_id = public.current_emp_id()),
         p_target,
         coalesce((select name from public.employee_ref where emp_id = p_target), p_target_name),
         p_action, p_before, p_after
$$;
revoke execute on function public.log_access_change(text, public.access_change_action, jsonb, jsonb, text) from public, anon, authenticated;

-- 指定或更換一關的簽核人。第一次有人記分派，原本有人記換人（前一人寫在 before）；同一個人什麼都不做。
-- 錯誤：關卡不存在 P0002；不是這一廠的廠區負責人或稽核管理者 42501；已結案、稽核室關卡、已簽的關卡 23514
-- （hint assessment_closed／audit_step／step_signed）；工號空白 23514（hint signer_required）。
create function public.assign_step_signer(p_step_id uuid, p_emp_id text, p_emp_name text default null)
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

  update public.assessment_step set signer_emp_id = v_emp where id = s.id;
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
comment on function public.assign_step_signer(uuid, text, text) is
  '廠區負責人（本廠）或稽核管理者分派、更換廠區端還沒簽的關卡的簽核人；人齊了那條分流就開始，寫進權限異動紀錄。';
revoke execute on function public.assign_step_signer(uuid, text, text) from public, anon;
grant execute on function public.assign_step_signer(uuid, text, text) to authenticated;

-- 廠區負責人的待分派提醒：本廠還有多少張自評表、多少關沒有人，一廠一年度一列（首頁與選單用）。
create view public.my_assignment_todo
with (security_invoker = true) as
select
  p.id                             as plant_id,
  p.factory_code,
  p.name                           as plant_name,
  c.year,
  c.due_date,
  count(distinct a.id)::int        as assessments,
  count(*)::int                    as steps
from public.plant_coordinator pc
join public.plant p on p.id = pc.plant_id
join public.assessment a on a.plant_id = p.id and a.status = 'in_progress'
join public.annual_cycle c on c.id = a.cycle_id
join public.assessment_step s on s.assessment_id = a.id and s.signer_emp_id is null
where pc.emp_id = public.current_emp_id()
group by p.id, p.factory_code, p.name, c.year, c.due_date;
comment on view public.my_assignment_todo is '目前登入者負責的廠區還有多少待分派：一廠一年度一列，assessments 張、steps 關。';
grant select on public.my_assignment_todo to authenticated;
revoke all on public.my_assignment_todo from anon;

-- 流程編輯：廠區端不設人名 ------------------------------------------------------------------------------------

-- 同 20261109000000，簽核人可以是空值（廠區端）；空字串當成空值，對不上群組由 route_step_signer_audit_only 擋下。
create or replace function public.insert_route_step(
  p_route_id          uuid,
  p_name              text,
  p_step_group        public.step_group,
  p_signer_emp_id     text,
  p_editable_unit_id  uuid default null,
  p_before_position   integer default null,
  p_branch_unit_id    uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count  integer;
  v_id     uuid;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can add steps' using errcode = '42501';
  end if;
  perform 1 from public.approval_route where id = p_route_id for update;
  if not found then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
  select count(*) into v_count from public.route_step where route_id = p_route_id;
  if p_before_position is not null and (p_before_position < 1 or p_before_position > v_count) then
    raise exception 'p_before_position must be between 1 and %', v_count using errcode = '22023';
  end if;
  if p_before_position is not null then
    update public.route_step set position = position + 1
    where route_id = p_route_id and position >= p_before_position;
  end if;
  insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id, branch_unit_id)
  values (p_route_id, p_before_position, btrim(p_name), p_step_group, nullif(btrim(p_signer_emp_id), ''), p_editable_unit_id, p_branch_unit_id)
  returning id into v_id;
  return v_id;
end
$$;

-- 新的分流不用選人。錯誤同 20261111000000，少了簽核人空白。
drop function public.add_route_branch(uuid, uuid, text, text);
create function public.add_route_branch(p_route_id uuid, p_unit_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit    text;
  v_before  integer;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can add branches' using errcode = '42501';
  end if;
  perform 1 from public.approval_route where id = p_route_id for update;
  if not found then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
  select name into v_unit from public.assessing_unit where id = p_unit_id;
  if v_unit is null then
    raise exception 'assessing unit % not found', p_unit_id using errcode = 'P0002';
  end if;
  if exists (select 1 from public.route_step where route_id = p_route_id and editable_unit_id = p_unit_id) then
    raise exception '「%」已經有分流', v_unit using errcode = '23505', hint = 'branch_exists';
  end if;
  select min(position) into v_before from public.route_step where route_id = p_route_id and branch_unit_id is null;
  perform public.insert_route_step(p_route_id, '自行檢查人員－' || v_unit, 'plant', null, p_unit_id, v_before, p_unit_id);
  perform public.insert_route_step(p_route_id, '部門主管－' || v_unit, 'plant', null, null, v_before + 1, p_unit_id);
end
$$;
comment on function public.add_route_branch(uuid, uuid) is
  '稽核管理者替一個自評單位建分流：自行檢查人員與部門主管兩關，排在匯流後的關卡之前；人名發出後才分派。';
revoke execute on function public.add_route_branch(uuid, uuid) from public, anon;
grant execute on function public.add_route_branch(uuid, uuid) to authenticated;

-- 草稿途徑：廠區端不再要人名（Q116 (5)）。其餘同 20261109000000。
create or replace function public.draft_route(p_def jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template  uuid;
  v_plant     uuid;
  v_route     uuid;
  v_unknown   text;
  v_steps     integer;
begin
  perform public.enter_draft_path();
  perform public.reject_non_draft_status(p_def);
  if jsonb_typeof(p_def -> 'steps') is distinct from 'array' or jsonb_array_length(p_def -> 'steps') = 0 then
    raise exception '簽核流程沒有關卡' using errcode = '23514';
  end if;

  select id into v_template from public.questionnaire_template
  where code = btrim(p_def ->> 'templateCode') and version = btrim(p_def ->> 'templateVersion');
  if v_template is null then
    raise exception '找不到範本 % 版本 %', p_def ->> 'templateCode', p_def ->> 'templateVersion' using errcode = 'P0002';
  end if;
  select id into v_plant from public.plant where factory_code = upper(btrim(p_def ->> 'factoryCode'));
  if v_plant is null then
    raise exception '找不到廠區 %', p_def ->> 'factoryCode' using errcode = 'P0002';
  end if;
  select btrim(named.unit) into v_unknown
  from jsonb_array_elements(p_def -> 'steps') st
  cross join lateral (values (st ->> 'editableUnit'), (st ->> 'branchUnit')) named (unit)
  where coalesce(btrim(named.unit), '') <> ''
    and not exists (select 1 from public.assessing_unit u where u.name = btrim(named.unit))
  limit 1;
  if v_unknown is not null then
    raise exception '自評單位清單上沒有「%」', v_unknown using errcode = 'P0002';
  end if;

  insert into public.approval_route (template_id, plant_id, status)
  values (v_template, v_plant, 'draft')
  returning id into v_route;

  -- 分流：自行檢查人員關卡由觸發器帶可編輯範圍；其他廠區端關卡（部門主管、多加的那一關）照 branchUnit。
  -- 廠區端不設人名，定義檔寫了 signer 也不看。
  insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id, branch_unit_id)
  select v_route, t.ord, btrim(t.st ->> 'name'), (t.st ->> 'group')::public.step_group,
         case when t.st ->> 'group' = 'plant' then null else btrim(t.st ->> 'signer') end, u.id, b.id
  from jsonb_array_elements(p_def -> 'steps') with ordinality as t(st, ord)
  left join public.assessing_unit u on u.name = btrim(t.st ->> 'editableUnit')
  left join public.assessing_unit b on b.name = btrim(t.st ->> 'branchUnit');
  get diagnostics v_steps = row_count;

  return jsonb_build_object('ok', true, 'route_id', v_route, 'steps', v_steps);
end
$$;
