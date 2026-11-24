-- 分派填寫人搬到發出表單之前；發出後只有稽核主管能換人（Q147，2026-11-23 定案；工單 #222，規格 #221）。用語依 GLOSSARY.md。
--
-- 新順序：確認範本 → 確認簽核流程 → 分派填寫人 → 發出表單。分派存在簽核流程上，發出時照抄進自評表：
--   流程     route_step.signer_emp_id 廠區端也能存人（route_step_signer_rule 只剩「連動關卡要有人」）。廠區管理員讀得到
--            自己廠區的流程、關卡，與它們用到的範本、自評單位（新的讀取規則，不給寫入）。
--   分派     assign_route_signer：稽核主管（含系統維護員，is_audit_admin()）或該流程廠區的廠區管理員，替流程上非連動的關卡
--            指定簽核人；連動關卡由權限管理決定（hint linked_step）。每次記一筆 route_step_assigned／route_step_reassigned。
--   發起檢查 launch_check 多 unassigned_steps：流程上非連動、還沒有簽核人的關卡；有就不能發起（not_ready）。
--   發出     launch_step_signer 只剩「連動關卡帶入權限管理的人，其餘照流程」：拿掉帶入去年、從缺與 p_carry。
--            launch_annual_cycle 改收 p_departed（流程上已離職的工號，前端經 OMS 通道查）與 p_checked（有沒有查過）：有人
--            離職的話整批拒絕（departed_signers，列出範本、廠區、關卡、工號、姓名）；OMS 連不上時前端送 p_checked = false，
--            照樣發出，回傳 checked 讓畫面提示沒檢查離職。回傳拿掉 carried／vacated／unassigned／carry。
--            last_year_signers 換成 launch_signers：這些組合發出時會照抄的人（前端拿去問 OMS 在不在職）。
--   換人     assign_step_signer（發出後換自評表上的人）只准稽核主管；換人同時寫回對應的流程關卡（同範本 × 廠區、同關卡
--            名稱與分流），明年沿用。分派表匯入（import_assignment）走同一支，跟著只剩稽核主管。
--   既有資料 每條流程非連動、還沒有人的關卡，用最近一次發出的自評表上同一關的人回填（沒有就留空）。
--   待辦     my_assignment_todo 改成兩種列：廠區管理員的「本廠還沒分派好的流程」（kind = route），與稽核主管的「Q147 前
--            發出、還有關卡待分派的自評表」（kind = assessment）。
--   選人     plant_form_people 也列出這一廠流程上已經排的人（發出前分派時從這裡選）。

-- 1. 流程存簽核人 ------------------------------------------------------------------------------------------------

alter table public.route_step drop constraint route_step_signer_rule;
alter table public.route_step
  add constraint route_step_signer_rule check (link is null or signer_emp_id is not null);
comment on column public.route_step.signer_emp_id is
  '這一關的簽核人工號（Q147：發出前分派在流程上，發出時照抄進自評表；稽核主管發出後換人時寫回）；空值＝還沒分派，'
  '不能發起。連動關卡一定有人（權限管理帶入，不連動時用這裡存的人）。';

-- 2. 異動紀錄的新種類 ---------------------------------------------------------------------------------------------

alter type public.access_change_action add value 'route_step_assigned';
alter type public.access_change_action add value 'route_step_reassigned';
comment on type public.access_change_action is
  '加入放行名單、移出放行名單、角色、檢視廠區、備註；指定、更換、移除廠區管理員；分派、換人、從缺、帶入去年（Q147 前）；'
  '稽核主管接任；流程上的分派與換人（Q147）。';

-- 3. 廠區管理員讀得到自己廠區的流程 -----------------------------------------------------------------------------------
-- 只讀：寫入照舊只有稽核主管與負責廠區的稽核人員（流程編輯器）。分派走 assign_route_signer。

create function public.my_coordinated_route_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(ar.id), '{}')
  from public.approval_route ar
  join public.plant_coordinator pc on pc.plant_id = ar.plant_id
  where pc.emp_id = public.current_emp_id()
$$;
comment on function public.my_coordinated_route_ids() is
  '目前登入者以廠區管理員負責的廠區的簽核流程（Q147：發出前在流程上分派）。RLS 用，每個查詢算一次。';
revoke execute on function public.my_coordinated_route_ids() from public, anon;
grant execute on function public.my_coordinated_route_ids() to authenticated;

create policy approval_route_select_coordinator on public.approval_route
  for select to authenticated
  using (id = any ((select public.my_coordinated_route_ids())::uuid[]));
create policy route_step_select_coordinator on public.route_step
  for select to authenticated
  using (route_id = any ((select public.my_coordinated_route_ids())::uuid[]));
-- 流程用到的範本（編號、名稱、狀態）與自評單位（分流、可編輯範圍的名稱）；範本內容（章節、控制要點）照舊看不到。
create policy questionnaire_template_select_coordinator on public.questionnaire_template
  for select to authenticated
  using (id in (select ar.template_id from public.approval_route ar
                 where ar.id = any ((select public.my_coordinated_route_ids())::uuid[])));
create policy template_plant_select_coordinator on public.template_plant
  for select to authenticated
  using (template_id in (select ar.template_id from public.approval_route ar
                          where ar.id = any ((select public.my_coordinated_route_ids())::uuid[])));
create policy assessing_unit_select_coordinator on public.assessing_unit
  for select to authenticated
  using (id in (select u.id from public.route_step rs
                  cross join lateral (values (rs.editable_unit_id), (rs.branch_unit_id)) as u(id)
                 where rs.route_id = any ((select public.my_coordinated_route_ids())::uuid[])));

-- 看得到流程的人看得到流程上的簽核人（#218 規則 3）：廠區管理員也包括自己廠區的流程。其餘同 20261213000000。
create or replace function public.visible_people()
returns table (emp_id text, name text, factory_code text)
language sql
stable
security definer
set search_path = public
as $$
  select e.emp_id, e.name, e.factory_code
    from public.employee_ref e
   where (select public.can_manage_access())
      or e.emp_id = (select public.current_emp_id())
      or e.emp_id in (
           select s.signer_emp_id from public.assessment_step s
            where s.signer_emp_id is not null and s.assessment_id in (select public.my_visible_assessment_ids()))
      or ((select public.can_read_settings())
          and e.emp_id in (select r.signer_emp_id from public.route_step r where r.signer_emp_id is not null))
      or e.emp_id in (
           select r.signer_emp_id from public.route_step r
            where r.signer_emp_id is not null and r.route_id = any ((select public.my_coordinated_route_ids())::uuid[]))
$$;

-- 分派選人：這一廠自評表上排過的人，加上這一廠流程上已經排的人。其餘同 20261214000000。
create or replace function public.plant_form_people(p_factory_code text)
returns table (emp_id text, name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_assign_plant(p_factory_code) then
    raise exception 'only the 廠區管理員 of this plant, a 稽核主管 or a 系統維護員 can list its people' using errcode = '42501';
  end if;

  return query
    select distinct x.emp_id, e.name
      from (
        select s.signer_emp_id as emp_id
          from public.assessment_step s
          join public.assessment a on a.id = s.assessment_id
          join public.plant p on p.id = a.plant_id
         where p.factory_code = p_factory_code
           -- 廠區分派的關卡：廠區端，加上稽核室不連動的一般關卡（子公司擔當稽核，Q143）；連動的稽核主管、台北稽核人員不列。
           and (s.step_group = 'plant' or s.link is null)
        union
        select rs.signer_emp_id
          from public.route_step rs
          join public.approval_route ar on ar.id = rs.route_id
          join public.plant p on p.id = ar.plant_id
         where p.factory_code = p_factory_code and rs.link is null
      ) x
      left join public.employee_ref e on e.emp_id = x.emp_id
     where x.emp_id is not null
     order by 1;
end
$$;
comment on function public.plant_form_people(text) is
  '分派選人的名單（#218 規則 ④）：這一廠的自評表（不分年度）與簽核流程上、由分派決定的關卡已經排過的人（工號、CSA 存的姓名，Q147）；'
  '只給這一廠的廠區管理員、稽核主管與系統維護員（can_assign_plant）。名單以外的人輸入完整工號向 OMS 查。';

-- 4. 發出前分派 -----------------------------------------------------------------------------------------------------

create function public.assign_route_signer(p_route_step_id uuid, p_emp_id text, p_emp_name text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s        public.route_step;
  v_plant  uuid;
  -- 照 OMS 給的寫法存（同 assign_step_signer）：發出時照抄，輪到誰一律和登入的工號直接比對。
  v_emp    text := btrim(p_emp_id);
  v_where  jsonb;
begin
  select ar.plant_id into v_plant
  from public.route_step rs join public.approval_route ar on ar.id = rs.route_id
  where rs.id = p_route_step_id;
  if v_plant is null then
    raise exception 'route step % not found', p_route_step_id using errcode = 'P0002';
  end if;
  if not (public.is_audit_admin()
          or exists (select 1 from public.plant_coordinator pc where pc.plant_id = v_plant and pc.emp_id = public.current_emp_id())) then
    raise exception 'only the 廠區管理員 of this plant or a 稽核主管 can assign a 關卡 of its routes' using errcode = '42501';
  end if;
  -- 和發起（for share 鎖流程）、流程編輯器排隊；鎖到之後才讀關卡。
  perform 1 from public.approval_route ar where ar.id = (select route_id from public.route_step where id = p_route_step_id) for update;
  select * into s from public.route_step where id = p_route_step_id;
  if not found then
    raise exception 'route step % not found', p_route_step_id using errcode = 'P0002';
  end if;

  if s.link is not null then
    raise exception '連動的稽核室關卡由權限管理決定，不由分派決定' using errcode = '23514', hint = 'linked_step';
  end if;
  if coalesce(v_emp, '') = '' then
    raise exception '簽核人不能空白' using errcode = '23514', hint = 'signer_required';
  end if;
  if s.signer_emp_id is not distinct from v_emp then
    return;
  end if;

  -- 分派不算修改流程（同 sync_linked_steps）：不改流程的最後修改時間與修改人，紀錄在權限異動紀錄。
  perform set_config(public.route_txn_key('before', s.route_id), '1', true);
  update public.route_step set signer_emp_id = v_emp where id = s.id;

  v_where := jsonb_build_object(
    'plant', (select p.factory_code from public.plant p where p.id = v_plant),
    'template', (select t.code from public.approval_route ar join public.questionnaire_template t on t.id = ar.template_id where ar.id = s.route_id),
    'step', s.name,
    'branch', (select u.name from public.assessing_unit u where u.id = s.branch_unit_id)
  );
  if s.signer_emp_id is null then
    perform public.log_access_change(v_emp, 'route_step_assigned', null, v_where, nullif(btrim(p_emp_name), ''));
  else
    perform public.log_access_change(v_emp, 'route_step_reassigned',
      jsonb_build_object('emp_id', s.signer_emp_id, 'name', (select name from public.employee_ref where emp_id = s.signer_emp_id)),
      v_where, nullif(btrim(p_emp_name), ''));
  end if;
end
$$;
comment on function public.assign_route_signer(uuid, text, text) is
  '發出前分派（Q147）：替簽核流程上非連動的關卡指定或更換簽核人，發出時照抄進自評表。稽核主管、系統維護員或該流程廠區的'
  '廠區管理員可呼叫；連動關卡拒絕（hint linked_step）；記 route_step_assigned／route_step_reassigned。';
revoke execute on function public.assign_route_signer(uuid, text, text) from public, anon;
grant execute on function public.assign_route_signer(uuid, text, text) to authenticated;

-- 5. 發起檢查 ------------------------------------------------------------------------------------------------------
-- 同 20261211000000，多 unassigned_steps：流程上非連動、還沒有簽核人的關卡（依分流、位置），有就不能發起（Q147 (4)）。
-- 改成以擁有者身分讀：廠區管理員現在讀得到自己廠區的流程，但讀不到範本內容（章節、控制要點），以呼叫者身分算的話
-- 「範本用到的單位」是空的，檢查會錯。只回給本來就讀得到這條流程的人（看得到設定的人、這一廠的廠區管理員），其他人拿到空值。

create or replace function public.launch_check(r public.approval_route)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with steps as (
    select rs.id, rs.position, rs.name, rs.editable_unit_id, rs.branch_unit_id, rs.link, rs.signer_emp_id
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
  -- 還沒分派（Q147）：分流的在前（依分流第一次出現的位置），匯流後的在後，各自依位置。
  unassigned as (
    select steps.id, steps.name, steps.position, steps.branch_unit_id, bu.name as branch_unit_name,
           min(steps.position) over (partition by steps.branch_unit_id) as branch_first
    from steps
    left join public.assessing_unit bu on bu.id = steps.branch_unit_id
    where steps.link is null and steps.signer_emp_id is null
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
       where s.template_id = r.template_id and u.name = '待指定單位') as pending_unit_points,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'branch_unit_id', branch_unit_id, 'branch_unit_name', branch_unit_name)
                                 order by branch_unit_id is null, branch_first, position)
                from unassigned), '[]'::jsonb) as unassigned_steps
  )
  select jsonb_build_object(
    'ready', not no_steps and not no_merge_steps and not audit_chief_not_last
             and jsonb_array_length(missing_units) = 0 and jsonb_array_length(unused_units) = 0
             and jsonb_array_length(branch_first_step_not_editable) = 0
             and jsonb_array_length(missing_links) = 0
             and pending_unit_points = 0
             and jsonb_array_length(unassigned_steps) = 0,
    'no_steps', no_steps,
    'no_merge_steps', no_merge_steps,
    'missing_units', missing_units,
    'unused_units', unused_units,
    'branch_first_step_not_editable', branch_first_step_not_editable,
    'missing_links', missing_links,
    'audit_chief_not_last', audit_chief_not_last,
    'pending_unit_points', pending_unit_points,
    'unassigned_steps', unassigned_steps
  )
  from facts
  where (select public.can_read_settings()) or r.id = any ((select public.my_coordinated_route_ids())::uuid[])
$$;
comment on function public.launch_check(public.approval_route) is
  '簽核流程的發起檢查（原啟用檢查，Q137 (6)）：{ready, no_steps, no_merge_steps, missing_units, unused_units, branch_first_step_not_editable, '
  'missing_links, audit_chief_not_last, pending_unit_points, unassigned_steps}（單位為 [{id,name}]；missing_links 只看稽核主管，台北稽核人員可有可無，Q143；'
  'pending_unit_points 是範本還掛著「待指定單位」的控制要點數，Q142；unassigned_steps 是非連動、還沒分派簽核人的關卡 '
  '[{id,name,branch_unit_id,branch_unit_name}]，Q147）；也是 PostgREST 計算欄位。不通過的組合年度發起不能勾。';

-- 6. 發出時照抄流程上的人 ----------------------------------------------------------------------------------------

drop function public.launch_annual_cycle(integer, date, jsonb, text[], boolean);
drop function public.launch_step_signer(public.route_step, text, uuid, text, uuid, integer, text[], boolean);
drop function public.last_year_signers(integer);

create function public.launch_step_signer(p_step public.route_step, p_plant_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.linked_signer(p_step.link, p_plant_id), p_step.signer_emp_id)
$$;
comment on function public.launch_step_signer(public.route_step, uuid) is
  '內部用：發起時這一關的簽核人（Q147）。連動關卡帶入權限管理決定的人（linked_signer，#190），其餘照流程上分派的人。';
revoke execute on function public.launch_step_signer(public.route_step, uuid) from public, anon, authenticated;

-- 這些組合發出時會照抄進自評表的人：前端拿去經 OMS 通道查在不在職（Q147 (4)）。OMS 通道一天有額度，所以一定要給組合，
-- 只查要發的；不分年度，所以不收年度。
create function public.launch_signers(p_combos jsonb)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核主管 can launch an annual cycle' using errcode = '42501';
  end if;
  if jsonb_typeof(p_combos) is distinct from 'array' then
    raise exception 'p_combos must be an array of {template_id, plant_id}' using errcode = '22023';
  end if;
  return coalesce((
    select array_agg(distinct who.emp_id order by who.emp_id)
    from public.approval_route ar
    join public.route_step rs on rs.route_id = ar.id
    cross join lateral (select public.launch_step_signer(rs, ar.plant_id) as emp_id) who
    where who.emp_id is not null
      and exists (select 1 from jsonb_array_elements(p_combos) e
                   where e ->> 'template_id' = ar.template_id::text and e ->> 'plant_id' = ar.plant_id::text)
  ), '{}');
end
$$;
comment on function public.launch_signers(jsonb) is
  '發起前要向 OMS 查在職狀態的工號（Q147 (4)，取代 last_year_signers）：這些組合的簽核流程發出時會照抄進自評表的人。只給稽核主管。';
revoke execute on function public.launch_signers(jsonb) from public, anon;
grant execute on function public.launch_signers(jsonb) to authenticated;

create function public.launch_annual_cycle(
  p_year      integer,
  p_due_date  date,
  p_combos    jsonb default null,
  p_departed  text[] default '{}',
  p_checked   boolean default false
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
  v_left     jsonb;
  v_cycle    uuid;
  v_due      date;
  v_top_up   boolean;
  v_new      uuid;
  v_ids      uuid[] := '{}';
  v_departed text[];
  r          record;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核主管 can launch an annual cycle' using errcode = '42501';
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

  -- 流程鎖住（分派 assign_route_signer 與流程編輯器要等發起做完），發起檢查與照抄的人是同一份。
  perform 1
  from public.approval_route ar
  where (
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

  -- 沒流程、沒通過發起檢查（含還沒分派，Q147）、沒有廠區管理員。
  select jsonb_agg(c order by ord)
  into v_missing
  from jsonb_array_elements(v_selected) with ordinality as x(c, ord)
  where c ->> 'problem' is not null;
  if v_missing is not null then
    return jsonb_build_object('ok', false, 'error', 'missing_route', 'missing', v_missing);
  end if;

  -- 流程上的人已離職（Q147 (4)）：整批拒絕，列出是誰，要先換人。
  v_departed := array(select upper(btrim(d)) from unnest(coalesce(p_departed, '{}')) d);
  select jsonb_agg(jsonb_build_object(
           'template_id', c.template_id, 'template_code', c.template_code, 'template_name', c.template_name,
           'plant_id', c.plant_id, 'factory_code', c.factory_code, 'plant_name', c.plant_name,
           'step_id', rs.id, 'step', rs.name, 'branch_unit_name', bu.name, 'link', rs.link,
           'emp_id', who.emp_id, 'name', (select e.name from public.employee_ref e where e.emp_id = who.emp_id)
         ) order by c.template_code, c.factory_code, rs.position)
  into v_left
  from jsonb_to_recordset(v_selected) as c(
    template_id uuid, template_code text, template_name text, plant_id uuid, factory_code text, plant_name text, route_id uuid
  )
  join public.route_step rs on rs.route_id = c.route_id
  left join public.assessing_unit bu on bu.id = rs.branch_unit_id
  cross join lateral (select public.launch_step_signer(rs, c.plant_id) as emp_id) who
  where upper(who.emp_id) = any (v_departed);
  if v_left is not null then
    return jsonb_build_object('ok', false, 'error', 'departed_signers', 'departed', v_left);
  end if;

  select id, due_date into v_cycle, v_due from public.annual_cycle where year = p_year;
  v_top_up := v_cycle is not null;
  if not v_top_up then
    insert into public.annual_cycle (year, due_date)
    values (p_year, p_due_date)
    returning id, due_date into v_cycle, v_due;
  end if;

  for r in
    select t.id as template_id, t.code, t.name, t.layout, c.plant_id, c.route_id
    from jsonb_to_recordset(v_selected) as c(template_id uuid, plant_id uuid, route_id uuid, template_code text, factory_code text)
    join public.questionnaire_template t on t.id = c.template_id
    order by c.template_code, c.factory_code
  loop
    insert into public.assessment (
      cycle_id, plant_id, template_id, template_code, template_name, template_layout
    )
    values (
      v_cycle, r.plant_id, r.template_id, r.code, r.name, r.layout
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

    -- 照抄流程上的人（Q147 (3)）：發起檢查已確定每一關都有人。
    insert into public.assessment_step (
      assessment_id, position, name, step_group, signer_emp_id, editable_unit_name, branch_unit_name, link
    )
    select v_new, rs.position, rs.name, rs.step_group, public.launch_step_signer(rs, r.plant_id), u.name, bu.name, rs.link
    from public.route_step rs
    left join public.assessing_unit u on u.id = rs.editable_unit_id
    left join public.assessing_unit bu on bu.id = rs.branch_unit_id
    where rs.route_id = r.route_id;
    -- 每條分流同時開始（Q116 (1)）。
    perform public.refresh_assessment_steps(v_new);
  end loop;

  return jsonb_build_object(
    'ok', true, 'cycle_id', v_cycle, 'top_up', v_top_up, 'due_date', v_due, 'assessments', cardinality(v_ids),
    'checked', coalesce(p_checked, false)
  );
end
$$;
comment on function public.launch_annual_cycle(integer, date, jsonb, text[], boolean) is
  '依啟用範本與適用廠區發起年度作業；年度已存在就補發，沿用它的截止日，只發還沒發過的組合（Q119）。組合資格與候選清單同一來源（launch_candidates），'
  '流程上的人照抄進自評表（Q147）。p_departed 是 OMS 查到不在職的工號：流程上有這些人就整批拒絕（departed_signers）；'
  'p_checked 是有沒有查過 OMS（連不上時 false，照樣發出，回傳 checked 讓畫面提示，Q147 (4)）。';
revoke execute on function public.launch_annual_cycle(integer, date, jsonb, text[], boolean) from public, anon;
grant execute on function public.launch_annual_cycle(integer, date, jsonb, text[], boolean) to authenticated;

-- 7. 發出後只有稽核主管換人，並寫回流程 ------------------------------------------------------------------------------
-- 同 20261211000000，只改誰能呼叫（廠區管理員不行了，Q147 (2)），並把新的人寫回流程上的同一關（Q147 (3)）。

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
  v_route  uuid;
begin
  select assessment_id into s.assessment_id from public.assessment_step where id = p_step_id;
  if s.assessment_id is null then
    raise exception 'step % not found', p_step_id using errcode = 'P0002';
  end if;
  if not public.is_audit_admin() then
    raise exception 'only a 稽核主管 can replace the 簽核人 of an issued 自評表' using errcode = '42501';
  end if;
  -- 和送出、核准、退回同樣依自評表那一列排隊，鎖到之後才讀關卡的狀態。
  select * into a from public.assessment where id = s.assessment_id for update;
  select * into s from public.assessment_step where id = p_step_id;

  if a.status <> 'in_progress' then
    raise exception '這張自評表已結案' using errcode = '23514', hint = 'assessment_closed';
  end if;
  -- 連動的台北稽核人員、稽核主管由權限管理決定（#190）。
  if s.link is not null then
    raise exception '連動的稽核室關卡由權限管理決定，不由分派決定' using errcode = '23514', hint = 'linked_step';
  end if;
  if s.state = 'done' then
    raise exception '已簽的關卡不能換人' using errcode = '23514', hint = 'step_signed';
  end if;
  if coalesce(v_emp, '') = '' then
    raise exception '簽核人不能空白' using errcode = '23514', hint = 'signer_required';
  end if;
  if s.signer_emp_id is distinct from v_emp then
    update public.assessment_step set signer_emp_id = v_emp, vacated_emp_id = null, vacated_name = null where id = s.id;
    perform public.refresh_assessment_steps(a.id);
  end if;

  -- 寫回流程（明年沿用）：同範本 × 廠區的流程上，同名、同分流、同一組（廠區端或稽核室）的非連動關卡；同名不只一關時
  -- 取位置相同的，否則最前面的。流程後來刪掉或改了那一關就不寫。表上已經是這個人時也寫（流程可能後來換過）。分派不算
  -- 修改流程：不改流程的最後修改時間（同 assign_route_signer）。
  select ar.id into v_route
  from public.approval_route ar
  left join public.questionnaire_template t on t.id = ar.template_id
  where ar.plant_id = a.plant_id and (ar.template_id = a.template_id or t.code = a.template_code)
  order by ar.template_id = a.template_id desc
  limit 1;
  if v_route is not null then
    perform 1 from public.approval_route where id = v_route for update;
    perform set_config(public.route_txn_key('before', v_route), '1', true);
    update public.route_step rs
    set signer_emp_id = v_emp
    where rs.id = (
      select x.id
      from public.route_step x
      left join public.assessing_unit bu on bu.id = x.branch_unit_id
      where x.route_id = v_route and x.link is null and x.name = s.name and x.step_group = s.step_group
        and bu.name is not distinct from s.branch_unit_name
      order by x.position = s.position desc, x.position
      limit 1
    )
      and rs.signer_emp_id is distinct from v_emp;
  end if;

  -- 表上本來就是這個人：只對齊流程，不記紀錄。
  if s.signer_emp_id is not distinct from v_emp then
    return;
  end if;

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
  '發出後替自評表上還沒簽的非連動關卡分派或換人（Q147：只有稽核主管與系統維護員）；同時寫回簽核流程上的同一關，明年沿用。'
  '分派表匯入（import_assignment）走這一支。';

-- 8. 既有流程回填 --------------------------------------------------------------------------------------------------
-- 每條流程非連動、還沒有人的關卡：同範本 × 廠區最近一次發出、有這一關（同名同分流同組）的自評表上那一關的人；那一關
-- 沒人（待分派、從缺）或從沒發過就留空，不往更早的年度找（那時的人多半也不在了），發起檢查會列為還沒分派。這是資料搬移，不算修改流程：關掉觸發器，不改最後修改時間、不記異動紀錄。

alter table public.route_step disable trigger user;
update public.route_step rs
set signer_emp_id = pick.emp_id
from (
  select x.id as step_id, (
    select s.signer_emp_id
    from public.assessment a
    join public.annual_cycle c on c.id = a.cycle_id
    join public.assessment_step s on s.assessment_id = a.id
    where a.plant_id = ar.plant_id
      and (a.template_id = ar.template_id or a.template_code = t.code)
      and s.name = x.name and s.step_group = x.step_group
      and s.branch_unit_name is not distinct from bu.name
    order by c.year desc, a.created_at desc, (s.position = x.position) desc, s.position
    limit 1
  ) as emp_id
  from public.route_step x
  join public.approval_route ar on ar.id = x.route_id
  left join public.questionnaire_template t on t.id = ar.template_id
  left join public.assessing_unit bu on bu.id = x.branch_unit_id
  where x.link is null and x.signer_emp_id is null
) as pick
where rs.id = pick.step_id and pick.emp_id is not null;
alter table public.route_step enable trigger user;

-- 9. 待辦 ----------------------------------------------------------------------------------------------------------
-- 兩種列（一廠一列；舊自評表一廠一年度一列）：
--   route       目前登入者以廠區管理員負責的廠區，啟用範本的流程還有非連動關卡沒分派（發出前要分派好，Q147）。
--   assessment  稽核主管（含系統維護員）：Q147 前發出、還在簽核中的自評表上待分派的關卡（Q147 (6)：由稽核主管補分派）。
-- forms 是流程條數或自評表張數，steps 是關卡數，pending 是那些關卡（舊自評表的帶著從缺的原本的人）。

drop view public.my_assignment_todo;
create view public.my_assignment_todo
with (security_invoker = true) as
select
  'route'::text                    as kind,
  p.id                             as plant_id,
  p.factory_code,
  p.name                           as plant_name,
  null::integer                    as year,
  null::date                       as due_date,
  count(distinct ar.id)::int       as forms,
  count(*)::int                    as steps,
  jsonb_agg(
    jsonb_build_object('template_code', t.code, 'name', rs.name, 'branch_unit_name', bu.name)
    order by t.code, rs.position
  )                                as pending
from public.plant_coordinator pc
join public.plant p on p.id = pc.plant_id
join public.approval_route ar on ar.plant_id = p.id
join public.questionnaire_template t
  on t.id = ar.template_id and t.status = 'active'
 and (t.all_plants or exists (select 1 from public.template_plant tp where tp.template_id = t.id and tp.factory_code = p.factory_code))
join public.route_step rs on rs.route_id = ar.id and rs.link is null and rs.signer_emp_id is null
left join public.assessing_unit bu on bu.id = rs.branch_unit_id
where pc.emp_id = (select public.current_emp_id())
group by p.id, p.factory_code, p.name
union all
select
  'assessment'::text,
  p.id,
  p.factory_code,
  p.name,
  c.year,
  c.due_date,
  count(distinct a.id)::int,
  count(*)::int,
  jsonb_agg(
    jsonb_build_object(
      'template_code', a.template_code, 'name', s.name, 'branch_unit_name', s.branch_unit_name,
      'vacated_emp_id', s.vacated_emp_id, 'vacated_name', s.vacated_name
    ) order by a.template_code, s.position
  )
from public.assessment a
join public.plant p on p.id = a.plant_id
join public.annual_cycle c on c.id = a.cycle_id
join public.assessment_step s on s.assessment_id = a.id and s.signer_emp_id is null
where a.status = 'in_progress' and (select public.is_audit_admin())
group by p.id, p.factory_code, p.name, c.year, c.due_date;
comment on view public.my_assignment_todo is
  '目前登入者還要分派的（Q147）：kind = route 是負責廠區還沒分派好的流程（一廠一列，forms 條流程、steps 關），'
  'kind = assessment 給稽核主管：Q147 前發出、還有關卡待分派的自評表（一廠一年度一列，forms 張、steps 關）；pending 是那些關卡。';
grant select on public.my_assignment_todo to authenticated;
revoke all on public.my_assignment_todo from anon;
