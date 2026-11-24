-- Q137 (4)(5)(6)(7)（#202）：範本沒有版本與草稿、只剩啟用／停用；簽核流程沒有狀態，每個「範本 × 廠區」一條；
-- 「啟用檢查」改叫「發起檢查」；對話寫入（ADR-0006）改用暫行做法。
--
--   資料收斂（Q137 (7) ②，使用者 2026-11-18 定案）
--     · 草稿範本一律改成啟用：現有範本都是從各廠實際的自評表轉來、真的要用的資料（測試環境 183 份、正式版 293 份）。
--     · 同一編號有多份範本、同一範本 × 廠區有多條流程：兩個環境都沒有，遇到就中止並列出，不自動挑留哪一份
--       （本機開發資料庫遇到就重建）。
--     · 草稿流程與停用流程直接成為那個組合唯一的流程（測試環境只有 SH-A × SH 一條、沒有關卡，發起檢查不通過）。
--     · 收斂不算一次人的修改：改型別不觸發列觸發器，範本與流程的最後修改時間、修改人都不動。
--   範本     拿掉 version 與生效年月檢查（Q102）；unique (code, version) → unique (code)；狀態只剩 active／inactive，
--            新範本預設 active。
--   流程     拿掉 status（route_status）與啟用、停用；unique (template_id, plant_id)。改關卡不再擋「讓啟用中的流程多出
--            問題」（keep_active_route_ready）：流程隨時能改，發起檢查（launch_check，原 activation_check）在清單與編輯
--            畫面隨時顯示，年度發起時不通過的組合不能勾（Q89 照舊在發起時重跑）。刪除改走 delete_route，要親手輸入
--            「刪除 ＜範本編號＞」，資料庫再核對一次（同 Q87 (4)）。
--   自評表   拿掉 template_version；issued_template、tracking_assessment 跟著拿掉版本欄。
--   對話寫入 暫行做法（Q137 (7) ①）：只能寫入資料庫還沒有的範本編號，寫成停用，由稽核主管檢查後啟用；流程只能寫給
--            停用範本、還沒有流程的範本 × 廠區（流程沒有狀態，寫給啟用中的範本就等於直接能發起）；其餘擋下並請到範本管理／
--            簽核流程直接修改。函式名稱 draft_template／draft_route 與
--            csa_drafter 角色不變。

-- 0. 資料檢查 -------------------------------------------------------------------------------------------------

do $$
declare
  v_dup text;
begin
  select string_agg(format('%s（%s 份）', code, n), '、' order by code) into v_dup
  from (select code, count(*) as n from public.questionnaire_template group by code having count(*) > 1) d;
  if v_dup is not null then
    raise exception '同一編號有多份範本，請先人工決定留哪一份再套用這個 migration：%', v_dup;
  end if;

  select string_agg(format('%s × %s（%s 條）', t.code, p.factory_code, d.n), '、' order by t.code, p.factory_code) into v_dup
  from (select template_id, plant_id, count(*) as n from public.approval_route group by 1, 2 having count(*) > 1) d
  join public.questionnaire_template t on t.id = d.template_id
  join public.plant p on p.id = d.plant_id;
  if v_dup is not null then
    raise exception '同一範本 × 廠區有多條簽核流程，請先人工決定留哪一條再套用這個 migration：%', v_dup;
  end if;
end
$$;

-- 1. 先拿掉會用到舊欄位、舊型別的函式、規則與檢視 -------------------------------------------------------------------

drop trigger route_step_keep_active_route_ready on public.route_step;
drop function public.keep_active_route_ready();
drop function public.activation_regressions(jsonb, jsonb);
drop function public.activate_route(uuid);
drop function public.deactivate_route(uuid);
drop function public.create_template(text, text, public.control_component, text, public.template_status, boolean, text[]);
drop function public.update_template(uuid, text, text, text, public.template_status, boolean, text[], public.control_component);
drop function public.check_template_header(text, text, text);
drop function public.launch_candidates();
drop function public.tracking_template();
drop function public.reject_non_draft_status(jsonb);
drop policy approval_route_delete_audit_admin on public.approval_route;

-- 2. 範本：拿掉版本，狀態只剩啟用／停用 --------------------------------------------------------------------------------

drop trigger questionnaire_template_version_month on public.questionnaire_template;
alter table public.questionnaire_template drop constraint questionnaire_template_version_month;
drop function public.check_template_version();
drop function public.is_month_version(text);
alter table public.questionnaire_template drop constraint questionnaire_template_code_version_key;
alter table public.questionnaire_template drop column version;
alter table public.questionnaire_template add constraint questionnaire_template_code_key unique (code);

create type public.template_status_new as enum ('active', 'inactive');
alter table public.questionnaire_template alter column status drop default;
alter table public.questionnaire_template
  alter column status type public.template_status_new
  using (case status::text when 'draft' then 'active' else status::text end)::public.template_status_new;
drop type public.template_status;
alter type public.template_status_new rename to template_status;
alter table public.questionnaire_template alter column status set default 'active';
comment on type public.template_status is '問卷範本的狀態：啟用／停用（Q137 (5)：沒有草稿，新範本預設啟用；停用的不再發起，內容留著、可再啟用）。';
comment on table public.questionnaire_template is
  '問卷範本：編號（一個編號一份，Q137 (4)）、名稱、版型、組成要素、狀態（啟用／停用）、適用廠區。';

-- 3. 流程：沒有狀態，每個範本 × 廠區一條 -------------------------------------------------------------------------------

alter table public.approval_route drop column status;  -- 連同只限啟用流程的唯一索引
drop type public.route_status;
alter table public.approval_route
  add constraint approval_route_template_plant_key unique (template_id, plant_id);
comment on table public.approval_route is
  '簽核流程：一份問卷範本在某廠區要經過的有序關卡清單；每個範本 × 廠區只有一條，沒有狀態，直接修改（Q137 (6)）。';

-- 自評表不參照流程（發起時已把關卡凍結在自評表裡），所以哪一條都能刪；要親手輸入編號，見 delete_route。
revoke delete on public.approval_route from authenticated;

-- 4. 自評表：拿掉版本 ------------------------------------------------------------------------------------------------

drop view public.issued_template;

do $$
declare
  v_def text := pg_get_viewdef('public.tracking_assessment'::regclass);
  v_new text := regexp_replace(v_def, '\n\s*a\.template_version,', '');
begin
  if v_new = v_def then
    raise exception 'tracking_assessment 的定義和預期不同（找不到 a.template_version），請改寫這段 migration';
  end if;
  drop view public.tracking_assessment;
  execute 'create view public.tracking_assessment with (security_invoker = true) as ' || v_new;
end
$$;
comment on view public.tracking_assessment is
  '追蹤總覽（稽核主管與系統維護員看全部、檢視者與廠區管理員看自己的廠區）：每張自評表顯示的關卡、簽核人與停留天數。匯流前顯示最久沒動的那條分流'
  '目前的關卡（待分派的分流是它的第一關，簽核人空值），停留天數從那條分流最後一筆簽核紀錄（或發起）起算；匯流後與結案是最前面一個輪到的'
  '關卡，從最後一筆簽核紀錄起算（Q95、Q116 (11)）。branch_count／branches_done＝適用單位數／已核准單位數；stage＝填寫中／簽核中／結案（Q115）。';
grant select on public.tracking_assessment to authenticated;
revoke all on public.tracking_assessment from anon;

alter table public.assessment drop column template_version;

create view public.issued_template
with (security_invoker = true) as
select
  a.id                 as assessment_id,
  c.year,
  a.template_id,
  a.plant_id,
  p.factory_code,
  a.template_code      as code,
  a.template_name      as name,
  a.template_layout    as layout,
  t.component,
  (select count(*)::integer from public.assessment_control_point cp where cp.assessment_id = a.id) as control_point_count
from public.assessment a
join public.annual_cycle c on c.id = a.cycle_id
join public.plant p on p.id = a.plant_id
left join public.questionnaire_template t on t.id = a.template_id;
comment on view public.issued_template is
  '已發起年度的範本（Q128 (4)）：每張自評表一列，編號、名稱、版型取自當年快照，control_point_count＝快照的控制要點數；呼叫者看得到的自評表才有列。';
grant select on public.issued_template to authenticated;
revoke all on public.issued_template from anon;

-- 5. 範本管理的寫入 --------------------------------------------------------------------------------------------------

create function public.check_template_header(p_code text, p_name text)
returns void
language plpgsql
set search_path = public
as $$
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核主管 can edit templates' using errcode = '42501';
  end if;
  if coalesce(btrim(p_code), '') = '' or coalesce(btrim(p_name), '') = '' then
    raise exception '問卷範本的編號、名稱不可空白' using errcode = '23514';
  end if;
end
$$;
comment on function public.check_template_header(text, text) is '內部用：範本抬頭寫入前的共同檢查。';
revoke execute on function public.check_template_header(text, text) from public, anon, authenticated;

create function public.create_template(
  p_code text,
  p_name text,
  p_component public.control_component,
  p_all_plants boolean default false,
  p_factory_codes text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.check_template_header(p_code, p_name);
  if p_component is null then
    raise exception '請選擇問卷範本的組成要素' using errcode = '23514', hint = 'component_required';
  end if;
  insert into public.questionnaire_template (code, name, layout, all_plants, component)
  values (
    btrim(p_code), btrim(p_name),
    case when p_component = 'control_activities' then 'control_activity' else 'element' end::public.template_layout,
    p_all_plants, p_component)
  returning id into v_id;
  perform public.replace_template_plants(v_id, p_all_plants, p_factory_codes);
  return v_id;
end
$$;
comment on function public.create_template(text, text, public.control_component, boolean, text[]) is
  '稽核主管新增問卷範本與它的適用廠區（新範本是啟用，Q137 (5)）；版型由組成要素決定（控制作業→控制活動類，其餘→要素類）；回傳範本 id。';
revoke execute on function public.create_template(text, text, public.control_component, boolean, text[]) from public, anon;
grant execute on function public.create_template(text, text, public.control_component, boolean, text[]) to authenticated;

create function public.update_template(
  p_template_id uuid,
  p_code text,
  p_name text,
  p_status public.template_status,
  p_all_plants boolean,
  p_factory_codes text[] default '{}',
  p_component public.control_component default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_layout public.template_layout;
begin
  perform public.check_template_header(p_code, p_name);
  select layout into v_layout from public.questionnaire_template where id = p_template_id for update;
  if not found then
    raise exception 'template % not found', p_template_id using errcode = 'P0002';
  end if;
  if p_component is not null and (v_layout = 'control_activity') <> (p_component = 'control_activities') then
    raise exception '範本 % 的組成要素不能在控制作業與其他組成要素之間改：兩者的答題欄位不同', btrim(p_code)
      using errcode = '23514', hint = 'component_layout';
  end if;
  update public.questionnaire_template
  set code = btrim(p_code), name = btrim(p_name), status = p_status, all_plants = p_all_plants,
      component = coalesce(p_component, component)
  where id = p_template_id;
  perform public.replace_template_plants(p_template_id, p_all_plants, p_factory_codes);
end
$$;
comment on function public.update_template(uuid, text, text, public.template_status, boolean, text[], public.control_component) is
  '稽核主管修改問卷範本的編號、名稱、狀態（啟用／停用）、適用廠區與組成要素（沒有版型：建立後不可更改）。';
revoke execute on function public.update_template(uuid, text, text, public.template_status, boolean, text[], public.control_component) from public, anon;
grant execute on function public.update_template(uuid, text, text, public.template_status, boolean, text[], public.control_component) to authenticated;

-- 6. 簽核流程：發起檢查、改關卡、刪除、連動 -----------------------------------------------------------------------------

alter function public.activation_check(public.approval_route) rename to launch_check;
comment on function public.launch_check(public.approval_route) is
  '簽核流程的發起檢查（原啟用檢查，Q137 (6)）：{ready, no_steps, no_merge_steps, missing_units, unused_units, branch_first_step_not_editable, '
  'missing_links, audit_chief_not_last}（單位為 [{id,name}]，missing_links 是缺的標記）；也是 PostgREST 計算欄位。不通過的組合年度發起不能勾。';

-- 改任何關卡＝改了流程：更新流程那一列（最後修改時間與修改人由它的觸發器記，#201）。每個交易每條流程只更新一次；
-- sync_linked_steps 先記下鍵，換連動簽核人就不算修改。原本記在鍵裡的啟用檢查（給 keep_active_route_ready 比對）不再需要。
create or replace function public.route_step_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_route uuid := case tg_op when 'DELETE' then old.route_id else new.route_id end;
begin
  if coalesce(current_setting(public.route_txn_key('before', v_route), true), '') = '' then
    update public.approval_route set updated_at = now() where id = v_route;
    perform set_config(public.route_txn_key('before', v_route), '1', true);
  end if;
  if tg_op = 'INSERT' and new.position is null then
    select coalesce(max(position), 0) + 1 into new.position
    from public.route_step where route_id = new.route_id;
  end if;
  return case tg_op when 'DELETE' then old else new end;
end
$$;

create function public.delete_route(p_route_id uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核主管 can delete routes' using errcode = '42501';
  end if;
  select t.code into v_code
  from public.approval_route r join public.questionnaire_template t on t.id = r.template_id
  where r.id = p_route_id
  for update of r;
  if not found then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
  if btrim(coalesce(p_code, '')) <> v_code then
    raise exception '確認的編號與簽核流程的範本編號（%）不符', v_code using errcode = '22023';
  end if;
  delete from public.approval_route where id = p_route_id;
end
$$;
comment on function public.delete_route(uuid, text) is
  '稽核主管刪除一條簽核流程連同關卡（自評表不參照流程，已發出的不受影響）；p_code 為確認用的範本編號（畫面要親手輸入「刪除 ＜編號＞」）。';
revoke execute on function public.delete_route(uuid, text) from public, anon;
grant execute on function public.delete_route(uuid, text) to authenticated;

create or replace function public.sync_linked_steps(p_link text, p_plant_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_to  text := public.linked_signer(p_link, p_plant_id);
  s     record;
begin
  if v_to is null then
    return;
  end if;

  -- 流程：連動關卡的簽核人跟著權限管理走，不算修改流程，所以不改流程的最後修改時間，也不鎖流程那一列（換稽核主管一次動到
  -- 全部流程，鎖了會和同時改流程的人互卡）。做法是先替這個交易記下鍵（route_step_before_write 看到已經記過就不再改流程那一列）。
  -- （記下的值整個交易有效：同一交易之後若再改這幾條流程，也不會改最後修改時間；同步由權限管理觸發，不會和改流程同一個交易。）
  perform set_config(public.route_txn_key('before', ar.id), '1', true)
  from public.approval_route ar
  where (p_link = 'audit_chief' or ar.plant_id = p_plant_id)
    and coalesce(current_setting(public.route_txn_key('before', ar.id), true), '') = ''
    and exists (select 1 from public.route_step rs
                where rs.route_id = ar.id and rs.link = p_link and rs.signer_emp_id is distinct from v_to);

  -- 關卡依 id 上鎖，兩個同步同時跑時不會互卡。
  perform 1
  from public.route_step rs
  join public.approval_route ar on ar.id = rs.route_id
  where rs.link = p_link
    and (p_link = 'audit_chief' or ar.plant_id = p_plant_id)
    and rs.signer_emp_id is distinct from v_to
  order by rs.id
  for update of rs;

  update public.route_step rs
  set signer_emp_id = v_to
  from public.approval_route ar
  where ar.id = rs.route_id
    and rs.link = p_link
    and (p_link = 'audit_chief' or ar.plant_id = p_plant_id)
    and rs.signer_emp_id is distinct from v_to;

  for s in
    select st.id, st.signer_emp_id as prev, st.name, st.branch_unit_name, a.template_code, c.year, p.factory_code
    from public.assessment a
    join public.assessment_step st on st.assessment_id = a.id
    join public.annual_cycle c on c.id = a.cycle_id
    join public.plant p on p.id = a.plant_id
    where a.status = 'in_progress'
      and (p_link = 'audit_chief' or a.plant_id = p_plant_id)
      and st.link = p_link
      and st.state <> 'done'
      and st.signer_emp_id is distinct from v_to
    order by a.id
    for update of a, st
  loop
    update public.assessment_step set signer_emp_id = v_to where id = s.id;
    perform public.log_access_change(
      v_to, 'step_reassigned',
      jsonb_build_object('emp_id', s.prev, 'name', (select e.name from public.employee_ref e where e.emp_id = s.prev)),
      jsonb_build_object('year', s.year, 'plant', s.factory_code, 'template', s.template_code, 'step', s.name, 'branch', s.branch_unit_name)
    );
  end loop;
end
$$;
comment on function public.sync_linked_steps(text, uuid) is
  '內部用：把簽核中自評表上還沒簽的連動關卡，與所有簽核流程的連動關卡，換成 linked_signer 的人，每一關記一筆換人（#190）；'
  '沒有連動的人就不動。由 plant_coordinator 與 employee_ref 的觸發器呼叫。';

create or replace function public.access_removal_impact(p_emp_id text)
returns table (
  kind text, assessment_id uuid, route_id uuid, year integer, template_code text, template_name text,
  factory_code text, plant_name text, step_position integer, step_name text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_access_manager();
  return query
    select case when s.state = 'current' then 'current' else 'later' end,
           a.id, null::uuid, c.year, a.template_code, a.template_name, p.factory_code, p.name, s.position, s.name
      from public.assessment_step s
      join public.assessment a on a.id = s.assessment_id
      join public.annual_cycle c on c.id = a.cycle_id
      join public.plant p on p.id = a.plant_id
     where s.signer_emp_id = upper(btrim(p_emp_id))
       and a.status = 'in_progress'
       and s.state <> 'done'
    union all
    select 'route', null::uuid, r.id, null::integer, t.code, t.name, p.factory_code, p.name, rs.position, rs.name
      from public.route_step rs
      join public.approval_route r on r.id = rs.route_id
      join public.questionnaire_template t on t.id = r.template_id
      join public.plant p on p.id = r.plant_id
     where rs.signer_emp_id = upper(btrim(p_emp_id))
    order by 1, 4, 7, 5, 9;
end
$$;
comment on function public.access_removal_impact(text) is
  '移除確認框的提醒：簽核中自評表上目前／之後輪到這個人的關卡，與簽核流程用到他的關卡（Q98 (5)）。只給稽核主管與系統維護員。';

-- 7. 年度發起與追蹤總覽 ------------------------------------------------------------------------------------------------

create function public.launch_candidates()
returns table (
  template_id uuid, template_code text, template_name text,
  plant_id uuid, factory_code text, plant_name text,
  route_id uuid, step_count integer, problem text, launch_check jsonb, launched_years integer[]
)
language sql
stable
set search_path = public
as $$
  select
    t.id, t.code, t.name,
    p.id, p.factory_code, p.name,
    ar.id,
    (select count(*)::integer from public.route_step rs where rs.route_id = ar.id),
    case
      when ar.id is null then 'no_route'
      when not (chk.result ->> 'ready')::boolean then 'not_ready'
      when not exists (select 1 from public.plant_coordinator pc where pc.plant_id = p.id) then 'no_coordinator'
    end,
    chk.result,
    coalesce((
      select array_agg(distinct c.year order by c.year)
      from public.assessment a
      join public.annual_cycle c on c.id = a.cycle_id
      where a.plant_id = p.id and (a.template_id = t.id or a.template_code = t.code)
    ), '{}')
  from public.questionnaire_template t
  join public.plant p
    on t.all_plants
    or exists (select 1 from public.template_plant tp where tp.template_id = t.id and tp.factory_code = p.factory_code)
  left join public.approval_route ar on ar.template_id = t.id and ar.plant_id = p.id
  left join lateral (select public.launch_check(ar) as result where ar.id is not null) chk on true
  where t.status = 'active'
  order by t.code, p.factory_code
$$;
comment on function public.launch_candidates() is
  '年度發起的候選組合（啟用範本 × 適用廠區）與能否發起：problem null／no_route／not_ready（沒通過發起檢查）／no_coordinator；'
  'launched_years 是這個組合已發起的年度。';
revoke execute on function public.launch_candidates() from public, anon;
grant execute on function public.launch_candidates() to authenticated;

-- launch_annual_cycle：拿掉流程狀態與版本快照，其餘照 20261204000000。
do $$
declare
  v_def text := pg_get_functiondef('public.launch_annual_cycle(integer, date, jsonb, text[], boolean)'::regprocedure);
  v_new text := v_def;
  v_from text[] := array[
    E'  where ar.status = ''active''\n    and (\n      p_combos is null',
    't.layout, t.version, c.plant_id',
    'template_layout, template_version',
    'r.name, r.layout, r.version'
  ];
  v_to text[] := array[
    E'  where (\n      p_combos is null',
    't.layout, c.plant_id',
    'template_layout',
    'r.name, r.layout'
  ];
begin
  for i in 1 .. array_length(v_from, 1) loop
    if position(v_from[i] in v_new) = 0 then
      raise exception 'launch_annual_cycle 的定義和預期不同（找不到「%」），請改寫這段 migration', v_from[i];
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  execute v_new;
end
$$;

create function public.tracking_template()
returns table (
  template_id uuid, template_code text, template_name text, template_component public.control_component, applies_to uuid[]
)
language sql
stable
security definer
set search_path = public
as $$
  with me as materialized (
    select public.can_read_all() as all_plants, public.my_tracking_plant_ids() as plant_ids
  ),
  visible as (
    select p.id, p.factory_code from public.plant p cross join me
     where me.all_plants or p.id = any(me.plant_ids)
  ),
  applies as (
    select t.id as template_id, v.id as plant_id
      from public.questionnaire_template t
      join visible v
        on t.all_plants
        or exists (select 1 from public.template_plant tp where tp.template_id = t.id and tp.factory_code = v.factory_code)
     where t.status = 'active'
  ),
  used as (
    select distinct a.template_id from public.assessment a join visible v on v.id = a.plant_id
  )
  select t.id, t.code, t.name, t.component,
         coalesce((select array_agg(ap.plant_id order by ap.plant_id) from applies ap where ap.template_id = t.id), '{}')
    from public.questionnaire_template t
   where t.id in (select template_id from applies union select template_id from used)
$$;
comment on function public.tracking_template() is
  '追蹤總覽的範本（#86）：呼叫者看得到的廠區上，啟用中適用的範本與自評表用到的範本，各帶組成要素與適用的廠區（applies_to，只算啟用中的範本、照範本現在的設定）。'
  '稽核主管與系統維護員看全部廠區，檢視者與廠區管理員看檢視廠區與負責的廠區，其他人拿到空清單。';
revoke execute on function public.tracking_template() from public, anon;
grant execute on function public.tracking_template() to authenticated;

-- 8. 對話寫入（ADR-0006）的暫行做法 -------------------------------------------------------------------------------------
--
-- 寫入函式先把自己新建的範本或流程 id 記進這個交易（draft_path_claim），guard_draft_path 只放行歸這些 id 管的資料：
-- 函式日後寫錯也碰不到既有的範本與流程。「寫到哪裡」只在 draft_template_contents／draft_route 決定，這是可替換的接縫：
-- 日後定案改成別的寫法（例如覆寫停用中的範本），改那兩支的目標並把目標 id 記進來即可，觸發器與 csa_drafter 不動。
-- 標記與記下的 id 都只會多加限制（只有走對話寫入的交易才看），所以誰都能設定也無妨。

create function public.draft_path_claim(p_id uuid)
returns void
language sql
set search_path = public
as $$
  select set_config('csa.draft_new', concat_ws(',', nullif(current_setting('csa.draft_new', true), ''), p_id::text), true)
$$;
comment on function public.draft_path_claim(uuid) is '內部用：對話寫入把這個交易新建的範本或流程 id 記下來，guard_draft_path 只放行歸它們管的資料。';
revoke execute on function public.draft_path_claim(uuid) from public, anon, authenticated;

drop function public.draft_path_governing_status(text, jsonb);
create function public.draft_path_governing_id(p_table text, p_row jsonb)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case p_table
    when 'questionnaire_template' then (p_row ->> 'id')::uuid
    when 'approval_route' then (p_row ->> 'id')::uuid
    when 'template_section' then (p_row ->> 'template_id')::uuid
    when 'template_plant' then (p_row ->> 'template_id')::uuid
    when 'control_point' then (select template_id from public.template_section where id = (p_row ->> 'section_id')::uuid)
    when 'control_point_unit' then (
      select s.template_id
      from public.control_point cp join public.template_section s on s.id = cp.section_id
      where cp.id = (p_row ->> 'control_point_id')::uuid)
    when 'route_step' then (p_row ->> 'route_id')::uuid
  end
$$;
comment on function public.draft_path_governing_id(text, jsonb) is
  '內部用：對話寫入判斷一列資料歸哪個範本或流程管，回傳它的 id；上層不在時為 null。';
revoke execute on function public.draft_path_governing_id(text, jsonb) from public, anon, authenticated;

create or replace function public.guard_draft_path()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record := case tg_op when 'DELETE' then old else new end;
  v_claimed uuid[];
begin
  if not public.in_draft_path() then
    return v_row;
  end if;
  if tg_table_name = 'assessing_unit' then
    if tg_op <> 'INSERT' then
      raise exception '對話寫入只能新增自評單位，不能改名或刪除' using errcode = '42501', hint = 'draft_only';
    end if;
    return v_row;
  end if;
  v_claimed := coalesce(string_to_array(nullif(current_setting('csa.draft_new', true), ''), ',')::uuid[], '{}');
  -- 上層不在（null）也不算記下的。
  if (tg_op <> 'DELETE'
      and not coalesce(public.draft_path_governing_id(tg_table_name, to_jsonb(new)) = any (v_claimed), false))
     or (tg_op <> 'INSERT'
      and not coalesce(public.draft_path_governing_id(tg_table_name, to_jsonb(old)) = any (v_claimed), false)) then
    raise exception '對話寫入只能寫入這次新建的範本或流程（%）', tg_table_name using errcode = '42501', hint = 'draft_only';
  end if;
  return v_row;
end
$$;
comment on function public.guard_draft_path() is
  '觸發器：走對話寫入的交易只能寫入這個交易新建的範本、流程與它們底下的資料，以及新增自評單位（Q90、Q137 (7) ①）。';

create or replace function public.draft_template_contents(p_def jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code      text := btrim(p_def ->> 'code');
  v_name      text := btrim(p_def ->> 'name');
  v_all       boolean := coalesce((p_def ->> 'allPlants')::boolean, false);
  v_id        uuid := gen_random_uuid();
  v_points    integer;
  v_bad       text;
begin
  perform public.enter_draft_path();
  if p_def ? 'status' then
    raise exception '對話寫入的範本一律寫成停用，請拿掉 status（啟用由稽核主管在範本管理按）'
      using errcode = '22023', hint = 'draft_only';
  end if;
  if p_def ? 'version' then
    raise exception '範本不再有版本（Q137），請拿掉 version' using errcode = '22023', hint = 'no_version';
  end if;
  if coalesce(v_code, '') = '' or coalesce(v_name, '') = '' then
    raise exception '問卷範本的編號、名稱不可空白' using errcode = '23514';
  end if;
  if jsonb_typeof(p_def -> 'sections') is distinct from 'array' or jsonb_array_length(p_def -> 'sections') = 0 then
    raise exception '範本 % 沒有章節', v_code using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_def -> 'sections') sec where coalesce(btrim(sec ->> 'name'), '') = ''
  ) or exists (
    select 1
    from jsonb_array_elements(p_def -> 'sections') sec, jsonb_array_elements(coalesce(sec -> 'controlPoints', '[]'::jsonb)) cp
    where coalesce(btrim(cp ->> 'text'), '') = ''
  ) then
    raise exception '範本 % 有空白的章節名稱或控制要點文字', v_code using errcode = '23514';
  end if;
  -- 層級：1–3，第一個是 1，每個最多比前一個深一層。不是 1–3 的先換成 null 再比，不讓轉型失敗搶在這個訊息前面。
  select format('第 %s 個章節「%s」的 level「%s」', t.ord, t.sec ->> 'name', t.sec ->> 'level') into v_bad
  from (
    select sec, ord, level, lag(level) over (order by ord) as prev
    from (
      select sec, ord, case when coalesce(sec ->> 'level', '1') in ('1', '2', '3') then coalesce(sec ->> 'level', '1')::int end as level
      from jsonb_array_elements(p_def -> 'sections') with ordinality as x(sec, ord)
    ) l
  ) t
  where t.level is null or t.level > coalesce(t.prev, 0) + 1
  order by t.ord
  limit 1;
  if v_bad is not null then
    raise exception '範本 % %不對：層級是 1–3，第一個章節是 1，往下一次只能深一層', v_code, v_bad
      using errcode = '22023', hint = 'section_level';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_def -> 'sections') sec, jsonb_array_elements(coalesce(sec -> 'controlPoints', '[]'::jsonb)) cp
    where cp ? 'assessingUnit'
       or (cp ? 'assessingUnits' and jsonb_typeof(cp -> 'assessingUnits') <> 'array')
  ) then
    raise exception '範本 % 的控制要點請用 assessingUnits（自評單位名稱的清單），不再接受單一的 assessingUnit', v_code
      using errcode = '22023', hint = 'assessing_units_list';
  end if;
  -- 空白的單位名稱整份拒絕，不默默丟掉（Claude 漏抓單位時，要素類會變成沒有單位而不報錯）。
  if exists (
    select 1
    from jsonb_array_elements(p_def -> 'sections') sec,
         jsonb_array_elements(coalesce(sec -> 'controlPoints', '[]'::jsonb)) cp,
         jsonb_array_elements_text(coalesce(cp -> 'assessingUnits', '[]'::jsonb)) u
    where coalesce(btrim(u), '') = ''
  ) then
    raise exception '範本 % 有空白的自評單位名稱', v_code using errcode = '23514';
  end if;

  -- 暫行做法（Q137 (7) ①）：只寫資料庫還沒有的編號，寫成停用。
  if exists (select 1 from public.questionnaire_template where code = v_code) then
    raise exception '範本 % 已在使用，請到範本管理直接修改', v_code using errcode = '42501', hint = 'template_exists';
  end if;
  perform public.draft_path_claim(v_id);
  insert into public.questionnaire_template (id, code, name, layout, status, all_plants)
  values (v_id, v_code, v_name, (p_def ->> 'layout')::public.template_layout, 'inactive', v_all)
  on conflict (code) do nothing;
  if not found then
    raise exception '範本 % 正好被另一個寫入同時建立，請重跑一次', v_code using errcode = '40001', hint = 'concurrent';
  end if;

  perform public.replace_template_plants(
    v_id, v_all, array(select jsonb_array_elements_text(coalesce(p_def -> 'factoryCodes', '[]'::jsonb))));

  insert into public.assessing_unit (name)
  select distinct btrim(u)
  from jsonb_array_elements(p_def -> 'sections') sec,
       jsonb_array_elements(coalesce(sec -> 'controlPoints', '[]'::jsonb)) cp,
       jsonb_array_elements_text(coalesce(cp -> 'assessingUnits', '[]'::jsonb)) u
  where coalesce(btrim(u), '') <> ''
  on conflict (name) do nothing;

  -- 章節與控制要點分兩句寫：控制要點的觸發器要讀得到章節，才查得到它歸哪份範本管。
  insert into public.template_section (template_id, position, name, level, code)
  select v_id, t.ord, btrim(t.sec ->> 'name'), coalesce((t.sec ->> 'level')::smallint, 1), nullif(btrim(t.sec ->> 'code'), '')
  from jsonb_array_elements(p_def -> 'sections') with ordinality as t(sec, ord);

  insert into public.control_point (section_id, position, text, code)
  select s.id, cp.ord, btrim(cp.item ->> 'text'), nullif(btrim(cp.item ->> 'code'), '')
  from jsonb_array_elements(p_def -> 'sections') with ordinality as t(sec, sord)
  join public.template_section s on s.template_id = v_id and s.position = t.sord
  cross join lateral jsonb_array_elements(coalesce(t.sec -> 'controlPoints', '[]'::jsonb)) with ordinality as cp(item, ord);
  get diagnostics v_points = row_count;

  insert into public.control_point_unit (control_point_id, position, assessing_unit_id)
  select p.id, u.ord, au.id
  from jsonb_array_elements(p_def -> 'sections') with ordinality as t(sec, sord)
  join public.template_section s on s.template_id = v_id and s.position = t.sord
  cross join lateral jsonb_array_elements(coalesce(t.sec -> 'controlPoints', '[]'::jsonb)) with ordinality as cp(item, ord)
  join public.control_point p on p.section_id = s.id and p.position = cp.ord
  cross join lateral jsonb_array_elements_text(coalesce(cp.item -> 'assessingUnits', '[]'::jsonb)) with ordinality as u(name, ord)
  join public.assessing_unit au on au.name = btrim(u.name)
  where coalesce(btrim(u.name), '') <> '';

  return jsonb_build_object(
    'ok', true, 'template_id', v_id,
    'sections', jsonb_array_length(p_def -> 'sections'), 'control_points', v_points);
end
$$;
comment on function public.draft_template_contents(jsonb) is '內部用：draft_template 寫入範本內容的部分（組成要素以外的一切）。';

comment on function public.draft_template(jsonb) is
  '對話寫入：把一份問卷範本定義寫成新的停用範本（只接受資料庫還沒有的編號，已有的請到範本管理改，Q137 (7) ①）；'
  '可帶 component 指定組成要素；只給 csa_drafter (Q90、Q101)。';

create or replace function public.draft_route(p_def jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template  uuid;
  v_status    public.template_status;
  v_plant     uuid;
  v_route     uuid := gen_random_uuid();
  v_unknown   text;
  v_steps     integer;
begin
  perform public.enter_draft_path();
  if p_def ? 'status' then
    raise exception '簽核流程沒有狀態（Q137），請拿掉 status' using errcode = '22023', hint = 'no_status';
  end if;
  if p_def ? 'templateVersion' then
    raise exception '範本不再有版本（Q137），請拿掉 templateVersion' using errcode = '22023', hint = 'no_version';
  end if;
  if jsonb_typeof(p_def -> 'steps') is distinct from 'array' or jsonb_array_length(p_def -> 'steps') = 0 then
    raise exception '簽核流程沒有關卡' using errcode = '23514';
  end if;

  select id, status into v_template, v_status from public.questionnaire_template where code = btrim(p_def ->> 'templateCode');
  if v_template is null then
    raise exception '找不到範本 %', p_def ->> 'templateCode' using errcode = 'P0002';
  end if;
  -- 流程沒有狀態，寫進去就能發起：只寫給還停用（稽核主管還沒檢查）的範本，和範本一起檢查後啟用（Q137 (7) ①）。
  if v_status = 'active' then
    raise exception '範本 % 已啟用，流程請到簽核流程直接新增或修改', btrim(p_def ->> 'templateCode')
      using errcode = '42501', hint = 'template_active';
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

  -- 暫行做法（Q137 (7) ①）：只寫還沒有流程的範本 × 廠區。
  if exists (select 1 from public.approval_route where template_id = v_template and plant_id = v_plant) then
    raise exception '範本 % × 廠區 % 已有簽核流程，請到簽核流程直接修改', btrim(p_def ->> 'templateCode'), upper(btrim(p_def ->> 'factoryCode'))
      using errcode = '42501', hint = 'route_exists';
  end if;
  perform public.draft_path_claim(v_route);
  insert into public.approval_route (id, template_id, plant_id)
  values (v_route, v_template, v_plant)
  on conflict (template_id, plant_id) do nothing;
  if not found then
    raise exception '範本 % × 廠區 % 的簽核流程正好被另一個寫入同時建立，請重跑一次', btrim(p_def ->> 'templateCode'), upper(btrim(p_def ->> 'factoryCode'))
      using errcode = '40001', hint = 'concurrent';
  end if;

  -- 分流：自行檢查人員關卡由觸發器帶可編輯範圍；其他廠區端關卡（部門主管、多加的那一關）照 branchUnit。
  -- 廠區端不設人名，定義檔寫了 signer 也不看。
  insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id, branch_unit_id, link)
  select v_route, t.ord, btrim(t.st ->> 'name'), (t.st ->> 'group')::public.step_group,
         case when t.st ->> 'group' = 'plant' then null else btrim(t.st ->> 'signer') end, u.id, b.id,
         nullif(btrim(t.st ->> 'link'), '')
  from jsonb_array_elements(p_def -> 'steps') with ordinality as t(st, ord)
  left join public.assessing_unit u on u.name = btrim(t.st ->> 'editableUnit')
  left join public.assessing_unit b on b.name = btrim(t.st ->> 'branchUnit');
  get diagnostics v_steps = row_count;

  return jsonb_build_object('ok', true, 'route_id', v_route, 'steps', v_steps);
end
$$;
comment on function public.draft_route(jsonb) is
  '對話寫入：把一條簽核流程定義寫成新的流程（只接受停用範本、還沒有流程的範本 × 廠區，其餘請到簽核流程改，Q137 (7) ①；'
  '每一關可帶 branchUnit 指定分流、link 指定連動標記）；只給 csa_drafter (Q90)。';
