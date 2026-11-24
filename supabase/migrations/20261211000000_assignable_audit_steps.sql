-- 稽核室的一般關卡（子公司擔當稽核）發出後由廠區管理員分派；台北稽核人員不再是每條流程必備（Q143，2026-11-19
-- 使用者決定，#207 照 Word 原檔簽核欄重排流程時提出）。
--
-- 原本稽核室覆核的關卡一定要在流程上存簽核人（route_step_signer_audit_only），只有廠區端的關卡是發出後分派。各廠
-- 原檔的「子公司擔當稽核」是哪一位要由廠區決定，所以：
--   流程     稽核室的一般關卡可以不存人（空值＝發出後分派）；廠區端照舊一律不存人。連動的台北稽核人員、稽核主管照舊
--            要存人（權限管理帶入 linked_signer，不連動時用流程上存的人，所以不能空著）。
--   自評表   沒有人的關卡只能是還沒輪到（pending），不分廠區端或稽核室（assessment_step_signer_when_turn）。輪到沒有人的
--            關卡就停在那裡等分派（refresh_assessment_steps 原本就把沒有人的關卡算 pending）。
--   分派     assign_step_signer 改成只擋連動關卡（hint linked_step，原本擋所有稽核室關卡 audit_step）：廠區管理員與稽核
--            主管可以分派、更換子公司擔當稽核這類一般的稽核室關卡；分派表匯入（import_assignment）走同一支，跟著放行。
--   登入     is_admitted 原本只認被分派到廠區端關卡的人，改成任何關卡（被分派成子公司擔當稽核的人也能換到登入）。
--   發起檢查 missing_links 只看稽核主管：每條流程要有稽核主管連動關卡（且排最後，audit_chief_not_last 照舊）；台北
--            稽核人員可有可無（SY、SAMOA、LH-14 的原檔沒有這一關），有的話照舊連動。修訂 #187 定案。
-- 其餘同 20261114000000（assign_step_signer）、20261113000000（is_admitted）、20261210000000（launch_check）。

-- 流程與自評表的簽核人規則 --------------------------------------------------------------------------------------
alter table public.route_step disable trigger user;
alter table public.route_step drop constraint route_step_signer_audit_only;
alter table public.route_step
  add constraint route_step_signer_rule check (
    (step_group = 'plant' and signer_emp_id is null)
    or (step_group = 'audit_review' and (link is null or signer_emp_id is not null))
  );
alter table public.route_step enable trigger user;
comment on column public.route_step.signer_emp_id is
  '稽核室關卡的簽核人工號（空值＝自評表發出後由廠區管理員分派，Q143）；廠區端的關卡一律空值，發出後分派（Q116 (5)）。';

alter table public.assessment_step drop constraint assessment_step_signer_when_turn;
alter table public.assessment_step
  add constraint assessment_step_signer_when_turn check (signer_emp_id is not null or state = 'pending');
comment on column public.assessment_step.signer_emp_id is
  '這一關的簽核人工號；空值＝待分派（只有還沒輪到的關卡會是空值；廠區端與稽核室的一般關卡都可能，Q143）。';

-- 分派 -------------------------------------------------------------------------------------------------------
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
  -- 連動的台北稽核人員、稽核主管由權限管理決定（#190）；稽核室的一般關卡（子公司擔當稽核）由廠區分派（Q143）。
  if s.link is not null then
    raise exception '連動的稽核室關卡由權限管理決定，不由廠區分派' using errcode = '23514', hint = 'linked_step';
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

-- 登入 -------------------------------------------------------------------------------------------------------
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
             and a.status = 'in_progress'
         )
$$;
comment on function public.is_admitted(text) is
  '這個工號能不能換到 CSA 的登入：在放行名單上，或被分派到還沒結案的自評表的任何關卡（Q116 (8)、Q143）。只給換證服務（service_role）呼叫。';

-- 發起檢查 ---------------------------------------------------------------------------------------------------
create or replace function public.launch_check(r public.approval_route)
returns jsonb
language sql
stable
set search_path = public
as $$
  with steps as (
    select rs.position, rs.editable_unit_id, rs.branch_unit_id, rs.link
    from public.route_step rs
    where rs.route_id = r.id
  ),
  used as (
    select o.assessing_unit_id as unit_id, o.first_seen
    from public.template_unit_order(r.template_id) o
  ),
  missing as (
    select u.id, u.name, used.first_seen
    from used
    join public.assessing_unit u on u.id = used.unit_id
    where not exists (select 1 from steps where steps.editable_unit_id = used.unit_id)
  ),
  unused as (
    select u.id, u.name, min(steps.position) as first_step
    from steps
    join public.assessing_unit u on u.id = steps.editable_unit_id
    where not exists (select 1 from used where used.unit_id = steps.editable_unit_id)
    group by u.id, u.name
  ),
  -- 每條分流位置最前面的關卡；已列在 missing 的單位不重複列。
  branch_first as (
    select distinct on (branch_unit_id) branch_unit_id, editable_unit_id, position
    from steps
    where branch_unit_id is not null
    order by branch_unit_id, position
  ),
  misordered as (
    select u.id, u.name, f.position
    from branch_first f
    join public.assessing_unit u on u.id = f.branch_unit_id
    where f.editable_unit_id is null
      and not exists (select 1 from missing where missing.id = f.branch_unit_id)
  ),
  facts as (
    select
      not exists (select 1 from steps) as no_steps,
      exists (select 1 from steps) and not exists (select 1 from steps where branch_unit_id is null) as no_merge_steps,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by first_seen) from missing), '[]'::jsonb) as missing_units,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by first_step) from unused), '[]'::jsonb) as unused_units,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by position) from misordered), '[]'::jsonb) as branch_first_step_not_editable,
      -- 必備的連動關卡只有稽核主管（Q143）；台北稽核人員可有可無。
      coalesce((select jsonb_agg(l.link order by l.ord) from public.route_links() l
                where l.link = 'audit_chief' and not exists (select 1 from steps where steps.link = l.link)), '[]'::jsonb) as missing_links,
      -- 有稽核主管、但匯流後還有關卡排在它後面（#187：每條流程最後一關是稽核主管）。分流的關卡與匯流後各自排順序，
      -- 位置數字在它後面不算。
      exists (select 1 from steps c where c.link = 'audit_chief'
                and exists (select 1 from steps s where s.branch_unit_id is null and s.position > c.position))
        as audit_chief_not_last,
      (select count(distinct cp.id)::int
       from public.template_section s
       join public.control_point cp on cp.section_id = s.id
       join public.control_point_unit cpu on cpu.control_point_id = cp.id
       join public.assessing_unit u on u.id = cpu.assessing_unit_id
       where s.template_id = r.template_id and u.name = '待指定單位') as pending_unit_points
  )
  select jsonb_build_object(
    'ready', not no_steps and not no_merge_steps and not audit_chief_not_last
             and jsonb_array_length(missing_units) = 0 and jsonb_array_length(unused_units) = 0
             and jsonb_array_length(branch_first_step_not_editable) = 0
             and jsonb_array_length(missing_links) = 0
             and pending_unit_points = 0,
    'no_steps', no_steps,
    'no_merge_steps', no_merge_steps,
    'missing_units', missing_units,
    'unused_units', unused_units,
    'branch_first_step_not_editable', branch_first_step_not_editable,
    'missing_links', missing_links,
    'audit_chief_not_last', audit_chief_not_last,
    'pending_unit_points', pending_unit_points
  )
  from facts
$$;
comment on function public.launch_check(public.approval_route) is
  '簽核流程的發起檢查（原啟用檢查，Q137 (6)）：{ready, no_steps, no_merge_steps, missing_units, unused_units, branch_first_step_not_editable, '
  'missing_links, audit_chief_not_last, pending_unit_points}（單位為 [{id,name}]；missing_links 只看稽核主管，台北稽核人員可有可無，Q143；'
  'pending_unit_points 是範本還掛著「待指定單位」的控制要點數，Q142）；也是 PostgREST 計算欄位。不通過的組合年度發起不能勾。';
