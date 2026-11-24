-- 系統維護員 (#159, Q122 (1)–(4))：管權限管理，其他全部唯讀，不改稽核業務的資料。
--
-- 系統維護員：權限管理的全部（放行名單、所有角色、檢視廠區、廠區負責人、權限異動紀錄）；看得到稽核管理者看得到的
-- 全部（自評表、答案、追蹤總覽、範本、自評單位、內控依據、簽核流程），好回答使用者的問題（使用者 2026-11-11 選 B）；
-- 不能改範本、自評單位、內控依據、簽核流程，不能年度發起、作廢、換人。讀取規則改成 can_read_all()，寫入規則
-- 仍只認 is_audit_admin()。他若也在某條流程上，照簽核人的規則簽自己那一關（Q117 (1)）。
-- 稽核管理者在權限管理只管一般使用者與檢視者，以及指定廠區負責人；設成或改動稽核管理者、系統維護員的人只有系統維護員能做。
-- 規則全在這裡（ADR-0001），畫面只負責顯示與隱藏。

-- 身分判斷 -------------------------------------------------------------------------------------------------

-- 只有系統維護員能做的事都看這一個函式。#161 的管理員帳號（不在 employee_ref）之後也要讓它回 true。
create or replace function public.is_system_maintainer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_audit_role() = 'system_maintainer', false)
$$;
comment on function public.is_system_maintainer() is
  '呼叫者是系統維護員嗎（Q122）？只有系統維護員能做的事都看它；#161 的管理員帳號也要通過它。';

-- 誰能進權限管理：稽核管理者與系統維護員。能改誰、能設什麼角色另由 require_may_manage 判斷。
create or replace function public.can_manage_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_audit_admin() or public.is_system_maintainer()
$$;
comment on function public.can_manage_access() is '呼叫者能用權限管理嗎：稽核管理者或系統維護員（Q122 (2)(3)）。';

-- 誰看得到全部（唯讀）：稽核管理者與系統維護員。現在和 can_manage_access 是同一群人，但問的是另一件事：OPEN-6 若加
-- 「稽核人員」這類看全部、不管權限的角色，只改這裡。
create or replace function public.can_read_all()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_audit_admin() or public.is_system_maintainer()
$$;
comment on function public.can_read_all() is
  '呼叫者看得到全部廠區的自評表、答案、追蹤總覽與範本、流程等設定嗎：稽核管理者或系統維護員（唯讀，Q122 (2)）。';

-- 呼叫者不能用權限管理就 42501。取代原本只認稽核管理者的 require_audit_admin（檔尾刪掉）。
create or replace function public.require_access_manager()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_manage_access() then
    raise exception '只有稽核管理者與系統維護員能維護權限' using errcode = '42501';
  end if;
end
$$;
revoke execute on function public.require_access_manager() from public, anon, authenticated;

-- 稽核管理者只管一般使用者與檢視者（Q122 (3)）：要設的角色（p_role，移除時是空值）和對象現在的角色，都不能是稽核管理者或
-- 系統維護員；系統維護員什麼都能設。拒絕時 42501，hint maintainer_only。
-- 對象那一列先鎖住再看角色：系統維護員同時把他升成稽核管理者時，等那邊 commit 後再判斷，不會在檢查之後被蓋掉。
create or replace function public.require_may_manage(p_emp_id text, p_role public.audit_role)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_system_maintainer() then
    return;
  end if;
  perform 1 from public.employee_ref where emp_id = p_emp_id for update;
  if coalesce(p_role in ('audit_admin', 'system_maintainer'), false)
     or exists (select 1 from public.employee_ref
                 where emp_id = p_emp_id and audit_role in ('audit_admin', 'system_maintainer')) then
    raise exception '只有系統維護員能設定或變更稽核管理者與系統維護員' using errcode = '42501', hint = 'maintainer_only';
  end if;
end
$$;
revoke execute on function public.require_may_manage(text, public.audit_role) from public, anon, authenticated;

-- 讀得到權限管理的資料 -------------------------------------------------------------------------------------
-- 原本只給稽核管理者的四條讀取規則，改成稽核管理者與系統維護員；employee_ref 仍讓每個人讀自己那一列。

alter policy employee_ref_select_self_or_admin on public.employee_ref
  using (emp_id = (select public.current_emp_id()) or (select public.can_manage_access()));
alter policy access_allowlist_audit_admin_read on public.access_allowlist
  using ((select public.can_manage_access()));
alter policy access_allowlist_audit_admin_read on public.access_allowlist rename to access_allowlist_access_manager_read;
alter policy access_change_log_audit_admin_read on public.access_change_log
  using ((select public.can_manage_access()));
alter policy access_change_log_audit_admin_read on public.access_change_log rename to access_change_log_access_manager_read;
alter policy plant_coordinator_admin_or_self_read on public.plant_coordinator
  using ((select public.can_manage_access()) or emp_id = (select public.current_emp_id()));

comment on view public.access_member is
  '權限管理的人員清單（稽核管理者與系統維護員）：放行名單上的人與他們的角色、檢視廠區、負責廠區、最後使用時間。';
comment on table public.access_change_log is
  '權限異動紀錄（Q98 (7)）：只新增，任何身分都不能改或刪；只有稽核管理者與系統維護員讀得到。操作者空值＝部署指令或 db:set-role。';

-- 看得到全部（唯讀）-----------------------------------------------------------------------------------------
-- 讀取規則從「稽核管理者」改成 can_read_all()，寫入規則（insert、update、delete 的 policy 與各寫入函式）都不動。

-- 只認稽核管理者的讀取 policy（範本、章節、控制要點、自評單位、內控依據、簽核流程與關卡、分流轉換問題…）：
-- 條件換成 can_read_all()，名稱、指令、對象角色都不變（同 20261108000000 的迴圈）。條件本來就只有這一句的才換，
-- 新加的讀取 policy 要自己寫 (select public.can_read_all())。pg_policies 依 search_path 決定印不印 public.（見 20261108000000）。
do $$
declare
  p record;
begin
  for p in
    select tablename, policyname from pg_policies
     where schemaname = 'public' and cmd = 'SELECT'
       and qual ~ '^\( SELECT (public\.)?is_audit_admin\(\) AS is_audit_admin\)$'
  loop
    execute format('alter policy %I on public.%I using ((select public.can_read_all()))', p.policyname, p.tablename);
  end loop;
end
$$;

-- 自評表與答案（20261115000000）：「因為角色而看得到的自評表」多系統維護員，其餘可見性與答案都跟著它走。
create or replace function public.my_plant_wide_assessment_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select a.id
  from public.assessment a
  where (select public.can_read_all())
     or a.plant_id = any((select public.my_tracking_plant_ids())::uuid[])
$$;
comment on function public.my_plant_wide_assessment_ids() is
  '內部用：呼叫者因為角色而看得到的自評表：稽核管理者與系統維護員全部，檢視者的檢視廠區，廠區負責人負責的廠區。';

-- 追蹤總覽：與 20261110000000 相同，只把「看全部」換成 can_read_all()。
create or replace function public.tracking_template()
returns table (
  template_id         uuid,
  template_code       text,
  template_name       text,
  template_version    text,
  template_component  public.control_component,
  applies_to          uuid[]
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
  select t.id, t.code, t.name, t.version, t.component,
         coalesce((select array_agg(ap.plant_id order by ap.plant_id) from applies ap where ap.template_id = t.id), '{}')
    from public.questionnaire_template t
   where t.id in (select template_id from applies union select template_id from used)
$$;
comment on function public.tracking_template() is
  '追蹤總覽的範本（#86）：呼叫者看得到的廠區上，啟用中適用的範本與自評表用到的範本，各帶組成要素與適用的廠區（applies_to，'
  '只算啟用中的範本、照範本現在的設定）。稽核管理者與系統維護員看全部廠區，檢視者與廠區負責人看檢視廠區與負責的廠區，'
  '其他人拿到空清單。';

create or replace function public.tracking_signer_names()
returns table (emp_id text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select e.emp_id, e.name from public.employee_ref e
   where public.can_read_all() or public.current_audit_role() = 'viewer'
      or exists (select 1 from public.plant_coordinator pc where pc.emp_id = public.current_emp_id())
$$;
comment on function public.tracking_signer_names() is '追蹤總覽的簽核人姓名；只回給稽核管理者、系統維護員、檢視者與廠區負責人。';

-- tracking_assessment（最後定義在 20261113000000）只有 me 那一行的 is_audit_admin() 要換：照現在的定義重建，
-- 不整段抄一份。註解與授權跟著 view 本身，create or replace 不會動到。
do $$
declare
  v_def text := pg_get_viewdef('public.tracking_assessment'::regclass);
begin
  if v_def !~ 'SELECT (public\.)?is_audit_admin\(\) AS all_plants' then
    raise exception 'tracking_assessment 的定義和預期不同，請改寫這段 migration';
  end if;
  execute 'create or replace view public.tracking_assessment with (security_invoker = true) as '
    || regexp_replace(v_def, 'SELECT (public\.)?is_audit_admin\(\) AS all_plants', 'SELECT public.can_read_all() AS all_plants');
end
$$;
comment on view public.tracking_assessment is
  '追蹤總覽（稽核管理者與系統維護員看全部、檢視者與廠區負責人看自己的廠區）：每張自評表顯示的關卡、簽核人與停留天數。匯流前顯示最久沒動的那條分流'
  '目前的關卡（待分派的分流是它的第一關，簽核人空值），停留天數從那條分流最後一筆簽核紀錄（或發起）起算；匯流後與結案是最前面一個輪到的'
  '關卡，從最後一筆簽核紀錄起算（Q95、Q116 (11)）。branch_count／branches_done＝適用單位數／已核准單位數；stage＝填寫中／簽核中／結案（Q115）。';

-- 維護函式 -------------------------------------------------------------------------------------------------
-- 與 20261030000000（加入、移除）、20261110000000（修改）相同，只換守門：能用權限管理，而且每個對象都要 require_may_manage。

create or replace function public.add_access_members(
  p_people jsonb,
  p_role public.audit_role,
  p_viewer_plant_ids uuid[],
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_person jsonb;
  v_emp_id text;
  v_added text[] := '{}';
  v_skipped text[] := '{}';
begin
  perform public.require_access_manager();
  if jsonb_typeof(p_people) is distinct from 'array' then
    raise exception 'p_people 要是陣列' using errcode = '22023';
  end if;

  for v_person in select * from jsonb_array_elements(p_people)
  loop
    v_emp_id := upper(btrim(coalesce(v_person ->> 'emp_id', '')));
    if v_emp_id = '' then
      raise exception '工號不能空白' using errcode = '22023';
    end if;
    -- 同一批貼了兩次的工號只算一次。
    continue when v_emp_id = any(v_added) or v_emp_id = any(v_skipped);
    if exists (select 1 from public.access_allowlist where emp_id = v_emp_id) then
      v_skipped := v_skipped || v_emp_id;
      continue;
    end if;
    perform public.require_may_manage(v_emp_id, p_role);

    insert into public.employee_ref (emp_id, name, factory_code, audit_role, viewer_plant_ids)
    values (v_emp_id, nullif(btrim(v_person ->> 'name'), ''), nullif(btrim(v_person ->> 'factory_code'), ''),
            p_role, coalesce(p_viewer_plant_ids, '{}'))
    on conflict (emp_id) do update set audit_role = excluded.audit_role, viewer_plant_ids = excluded.viewer_plant_ids;

    insert into public.access_allowlist (emp_id, note, added_by)
    values (v_emp_id, nullif(btrim(p_note), ''), public.current_emp_id());
    v_added := v_added || v_emp_id;
  end loop;

  return jsonb_build_object('added', to_jsonb(v_added), 'skipped', to_jsonb(v_skipped));
end
$$;
comment on function public.add_access_members(jsonb, public.audit_role, uuid[], text) is
  '權限管理：把 OMS 名單上找到的人加入放行名單並設角色（Q98 (3)）；已在名單的略過。稽核管理者只能加一般使用者與檢視者，'
  '系統維護員什麼角色都能加（Q122）。';

create or replace function public.update_access_member(
  p_emp_id text,
  p_role public.audit_role,
  p_viewer_plant_ids uuid[],
  p_note text,
  p_coordinator_assign uuid[] default null,
  p_coordinator_unassign uuid[] default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp_id text := upper(btrim(coalesce(p_emp_id, '')));
  v_plant uuid;
begin
  perform public.require_access_manager();
  if not exists (select 1 from public.access_allowlist where emp_id = v_emp_id) then
    raise exception '工號 % 不在放行名單上', v_emp_id using errcode = 'P0002';
  end if;
  perform public.require_may_manage(v_emp_id, p_role);
  update public.employee_ref
     set audit_role = p_role, viewer_plant_ids = coalesce(p_viewer_plant_ids, '{}')
   where emp_id = v_emp_id;
  if not found then
    -- 部署指令加入、還沒登入過的人沒有 employee_ref 那一列。
    insert into public.employee_ref (emp_id, audit_role, viewer_plant_ids)
    values (v_emp_id, p_role, coalesce(p_viewer_plant_ids, '{}'));
  end if;
  update public.access_allowlist set note = nullif(btrim(p_note), '') where emp_id = v_emp_id;

  delete from public.plant_coordinator where emp_id = v_emp_id and plant_id = any(coalesce(p_coordinator_unassign, '{}'));
  foreach v_plant in array coalesce(p_coordinator_assign, '{}') loop
    perform public.assign_plant_coordinator(v_plant, v_emp_id);
  end loop;
end
$$;
comment on function public.update_access_member(text, public.audit_role, uuid[], text, uuid[], uuid[]) is
  '權限管理：改放行名單上一個人的角色、檢視廠區、備註，以及（有給時）新加與拿掉的負責廠區（Q98、Q117）。'
  '稽核管理者只能改一般使用者與檢視者、也只能設成這兩種，系統維護員都能改（Q122）。';

create or replace function public.remove_access_member(p_emp_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp_id text := upper(btrim(coalesce(p_emp_id, '')));
begin
  perform public.require_access_manager();
  perform public.require_may_manage(v_emp_id, null);
  delete from public.access_allowlist where emp_id = v_emp_id;
  if not found then
    raise exception '工號 % 不在放行名單上', v_emp_id using errcode = 'P0002';
  end if;
  update public.employee_ref set audit_role = 'signer', viewer_plant_ids = '{}' where emp_id = v_emp_id;
end
$$;
comment on function public.remove_access_member(text) is
  '權限管理：移出放行名單，角色改回一般使用者、清空檢視廠區（Q98 (5)）。稽核管理者不能移除稽核管理者與系統維護員（Q122 (3)）。';

-- 與 20261109000000 相同，只換守門。
create or replace function public.access_removal_impact(p_emp_id text)
returns table (
  kind            text,
  assessment_id   uuid,
  route_id        uuid,
  year            integer,
  template_code   text,
  template_name   text,
  factory_code    text,
  plant_name      text,
  step_position   integer,
  step_name       text
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
       and r.status = 'active'
    order by 1, 4, 7, 5, 9;
end
$$;
comment on function public.access_removal_impact(text) is
  '移除確認框的提醒：簽核中自評表上目前／之後輪到這個人的關卡，與啟用中流程用到他的關卡（Q98 (5)）。只給稽核管理者與系統維護員。';

-- 廠區負責人 -----------------------------------------------------------------------------------------------
-- 稽核管理者與系統維護員都能指定（Q122 (2)(3)）。系統維護員不能當廠區負責人：廠區負責人要分派填寫人、替關卡換人，
-- 是稽核業務的寫入，系統維護員不做（Q122 (2)）。指定時擋下（23514，hint maintainer_not_coordinator）；
-- 已負責廠區的人改成系統維護員就一併卸任，同角色不是檢視者就清空檢視廠區。

-- 與 20261110000000 相同，只多系統維護員那一條。
create or replace function public.assign_plant_coordinator(p_plant_id uuid, p_emp_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.plant where id = p_plant_id) then
    raise exception '廠區 % 不在廠區主檔裡', p_plant_id using errcode = '23503';
  end if;
  if not exists (select 1 from public.access_allowlist where emp_id = p_emp_id) then
    raise exception '工號 % 不在放行名單上', p_emp_id using errcode = 'P0002';
  end if;
  if exists (select 1 from public.employee_ref where emp_id = p_emp_id and audit_role = 'system_maintainer') then
    raise exception '系統維護員不能當廠區負責人' using errcode = '23514', hint = 'maintainer_not_coordinator';
  end if;
  insert into public.plant_coordinator (plant_id, emp_id, assigned_by)
  values (p_plant_id, p_emp_id, public.current_emp_id())
  on conflict (plant_id) do update
    set emp_id = excluded.emp_id, assigned_at = now(), assigned_by = excluded.assigned_by
    where plant_coordinator.emp_id <> excluded.emp_id;
end
$$;

create or replace function public.set_plant_coordinator(p_plant_id uuid, p_emp_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_access_manager();
  perform public.assign_plant_coordinator(p_plant_id, upper(btrim(coalesce(p_emp_id, ''))));
end
$$;
comment on function public.set_plant_coordinator(uuid, text) is
  '權限管理：指定或更換廠區負責人（Q116 (5)）；只能是放行名單上、不是系統維護員的人。只給稽核管理者與系統維護員。';

create or replace function public.remove_plant_coordinator(p_plant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_access_manager();
  delete from public.plant_coordinator where plant_id = p_plant_id;
  if not found then
    raise exception '廠區 % 沒有廠區負責人', p_plant_id using errcode = 'P0002';
  end if;
end
$$;
comment on function public.remove_plant_coordinator(uuid) is
  '權限管理：移除廠區負責人，廠區從缺（Q116 (5)）。只給稽核管理者與系統維護員。';

-- 改成系統維護員就卸任負責的廠區（每一筆照常記進權限異動紀錄）。對所有身分都成立，部署指令與 db:set-role 也一樣。
create or replace function public.maintainer_runs_no_plant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.plant_coordinator where emp_id = new.emp_id;
  return null;
end
$$;
create trigger employee_ref_maintainer_runs_no_plant
  after insert or update of audit_role on public.employee_ref
  for each row when (new.audit_role = 'system_maintainer')
  execute function public.maintainer_runs_no_plant();

-- 至少留一位 ------------------------------------------------------------------------------------------------
-- 「至少留一位稽核管理者」（Q98 (4)、Q99 (1)）的觸發器改成依角色共用，另加「至少留一位系統維護員」，規則相同（Q122 (4)）：
-- 角色是它、而且在放行名單上的人才算；只檢查讓一位這樣的人消失的變更，所以還沒有任何一位的資料庫照樣能設第一位。
-- 對所有身分都擋，含 service_role、部署指令與 db:set-role；兩個交易同時各降一位時以 advisory lock 排隊。
-- 拒絕時 23514，hint 是 last_audit_admin 或 last_system_maintainer，畫面依它說是哪一種。

create or replace function public.guard_last_holder()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.audit_role := tg_argv[0]::public.audit_role;
  v_was boolean;
begin
  if tg_table_name = 'employee_ref' then
    v_was := old.audit_role = v_role
      and exists (select 1 from public.access_allowlist where emp_id = old.emp_id);
  else
    v_was := exists (select 1 from public.employee_ref where emp_id = old.emp_id and audit_role = v_role);
  end if;
  if not v_was then
    return null;
  end if;
  -- 稽核管理者沿用原本的鎖名（csa.last_audit_admin）。
  perform pg_advisory_xact_lock(hashtext('csa.last_' || v_role::text));
  if not exists (
    select 1 from public.employee_ref e join public.access_allowlist a on a.emp_id = e.emp_id
     where e.audit_role = v_role
  ) then
    raise exception '至少要留一位%', case v_role when 'audit_admin' then '稽核管理者' when 'system_maintainer' then '系統維護員' end
      using errcode = '23514', hint = 'last_' || v_role::text;
  end if;
  return null;
end
$$;

drop trigger employee_ref_keep_an_audit_admin on public.employee_ref;
drop trigger access_allowlist_keep_an_audit_admin on public.access_allowlist;
drop function public.guard_last_audit_admin();

create trigger employee_ref_keep_an_audit_admin
  after update of audit_role or delete on public.employee_ref
  for each row when (old.audit_role = 'audit_admin')
  execute function public.guard_last_holder('audit_admin');
create trigger access_allowlist_keep_an_audit_admin
  after delete on public.access_allowlist
  for each row execute function public.guard_last_holder('audit_admin');
create trigger employee_ref_keep_a_system_maintainer
  after update of audit_role or delete on public.employee_ref
  for each row when (old.audit_role = 'system_maintainer')
  execute function public.guard_last_holder('system_maintainer');
create trigger access_allowlist_keep_a_system_maintainer
  after delete on public.access_allowlist
  for each row execute function public.guard_last_holder('system_maintainer');

-- 上面的維護函式都改用 require_access_manager，原本只認稽核管理者的守門沒有人用了。
drop function public.require_audit_admin();
