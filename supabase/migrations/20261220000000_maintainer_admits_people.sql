-- 只有系統維護員能放行與設定系統角色（Q150）：加入、移出放行名單，以及改角色、檢視廠區、備註，都只有系統維護員能做。
-- 稽核主管留下廠區管理員的指定、更換、卸任，與人員名單、權限異動紀錄的唯讀查看（can_manage_access 不變）。
--
-- add_access_members、update_access_member、remove_access_member 都經 require_may_manage 檢查，所以改這一個就好；
-- update_access_member 另外也收廠區管理員的變更（權限管理「廠區權限」），稽核主管只改負責廠區時不能被擋，
-- 所以它改成只有角色、檢視廠區或備註真的有變時才查 require_may_manage。

-- 參數保留不用：三個呼叫端（加入、修改、移除，見 20261203000001、20261117000001）不必跟著改。
create or replace function public.require_may_manage(p_emp_id text, p_role public.audit_role)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_system_maintainer() then
    raise exception '只有系統維護員能放行人員與設定系統角色' using errcode = '42501', hint = 'maintainer_only';
  end if;
end
$$;
comment on function public.require_may_manage(text, public.audit_role) is
  '放行（加入、移出放行名單）與設定角色、檢視廠區、備註只有系統維護員能做（Q150，修訂 Q122 (3)、#187）。';

-- 與 20261203000001 相同，只多「角色、檢視廠區、備註有變才查 require_may_manage」與鎖住 employee_ref 那一列。
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
  v_old_role public.audit_role;
  v_old_viewer uuid[];
  v_old_note text;
begin
  perform public.require_access_manager();
  -- 設成稽核主管時，先拿「接任稽核主管」的鎖再寫任何一列：判斷有沒有前任、降級前任都在鎖裡，同時有人降級別的稽核主管
  -- （guard_last_holder 拿同一把鎖）也只會排隊，不會漏記或互卡（deadlock）。
  if p_role = 'audit_admin' then
    perform pg_advisory_xact_lock(hashtext('csa.last_audit_admin'));
  end if;
  select note into v_old_note from public.access_allowlist where emp_id = v_emp_id;
  if not found then
    raise exception '工號 % 不在放行名單上', v_emp_id using errcode = 'P0002';
  end if;
  select audit_role, viewer_plant_ids into v_old_role, v_old_viewer from public.employee_ref where emp_id = v_emp_id for update;
  -- 只改負責廠區（稽核主管在「廠區權限」指定廠區管理員）不算設定角色；角色、檢視廠區、備註有任何一項變了才要系統維護員。
  -- 部署指令加入、還沒登入過的人沒有 employee_ref 那一列，視同一般使用者、沒有檢視廠區。
  if p_role is distinct from coalesce(v_old_role, 'signer')
     or array(select unnest(coalesce(p_viewer_plant_ids, '{}')) order by 1)
        is distinct from array(select unnest(coalesce(v_old_viewer, '{}')) order by 1)
     or nullif(btrim(p_note), '') is distinct from v_old_note then
    perform public.require_may_manage(v_emp_id, p_role);
  end if;
  -- 要接任稽核主管（原本不是、現在是，而且有前任）：接手的人只記「接任稽核主管」一筆，這一列的「角色」異動不另記
  -- （異動紀錄的觸發器看這個設定，hand_over_audit_admin 用完會清掉）。沒有前任就照常記「角色」。
  if p_role = 'audit_admin' and v_old_role is distinct from 'audit_admin'
     and exists (select 1 from public.employee_ref where audit_role = 'audit_admin' and emp_id <> v_emp_id) then
    perform set_config('csa.audit_admin_handover', v_emp_id, true);
  end if;
  update public.employee_ref
     set audit_role = p_role, viewer_plant_ids = coalesce(p_viewer_plant_ids, '{}')
   where emp_id = v_emp_id;
  if not found then
    insert into public.employee_ref (emp_id, audit_role, viewer_plant_ids)
    values (v_emp_id, p_role, coalesce(p_viewer_plant_ids, '{}'));
  end if;
  update public.access_allowlist set note = nullif(btrim(p_note), '') where emp_id = v_emp_id;

  -- 原本不是稽核主管、現在是：前任降級。原本就是的只改備註之類，不動別人（測試環境若有多位，不藉機降級）。
  if p_role = 'audit_admin' and v_old_role is distinct from 'audit_admin' then
    perform public.hand_over_audit_admin(v_emp_id);
  end if;

  delete from public.plant_coordinator where emp_id = v_emp_id and plant_id = any(coalesce(p_coordinator_unassign, '{}'));
  foreach v_plant in array coalesce(p_coordinator_assign, '{}') loop
    perform public.assign_plant_coordinator(v_plant, v_emp_id);
  end loop;
end
$$;
comment on function public.update_access_member(text, public.audit_role, uuid[], text, uuid[], uuid[]) is
  '權限管理：改放行名單上一個人的角色、檢視廠區、備註，以及（有給時）新加與拿掉的負責廠區（Q98、Q117）。'
  '角色、檢視廠區、備註只有系統維護員能改；稽核主管只能改負責廠區（Q150）。設成稽核主管時前任自動降級（稽核主管剛好一位）。';

-- 不再自動放行（Q150，修訂 Q116 (8)、Q143）---------------------------------------------------------------------
-- 只有放行名單上的人能登入；被分派到自評表或流程上的關卡不再放行。所以排進關卡的人一定要先在名單上，
-- 還排在關卡上的人也不能直接移出名單（先換人）。

-- 上線前已經排在流程或簽核中自評表上、以前靠分派放行的人，一次加進放行名單，部署當下不會有人被擋在外面。
-- 寫進權限異動紀錄的「加入」，操作者空值（同部署指令），備註寫明來由。
insert into public.access_allowlist (emp_id, note)
select distinct upper(btrim(x.emp_id)), '分派帶入（Q150 上線時已在流程上）'
  from (
    select rs.signer_emp_id as emp_id from public.route_step rs
    union
    select s.signer_emp_id
      from public.assessment_step s
      join public.assessment a on a.id = s.assessment_id
     where a.status = 'in_progress'
  ) x
 where nullif(btrim(x.emp_id), '') is not null
on conflict (emp_id) do nothing;

-- 20261211000000 的版本另外放行被分派到簽核中自評表的人；Q150 起只看放行名單。
create or replace function public.is_admitted(p_emp_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.access_allowlist where emp_id = upper(btrim(p_emp_id)))
$$;
comment on function public.is_admitted(text) is
  '這個工號能不能換到 CSA 的登入：在放行名單上（Q150 起被分派不再放行）。開關 CSA_REQUIRE_OMS_AUTH 打開時，'
  '另外還要 OMS 授權頁勾了 CSA。只給換證服務（service_role）呼叫。';

-- 排進關卡的人要在放行名單上：發出前在流程上分派、發出後換人、匯入分派表、流程編輯器、年度發起照抄流程、連動關卡
-- 都寫這兩張表的 signer_emp_id，在這裡一起擋，不必每個函式各查一次。只看新寫入或換掉的人，已經在關卡上的不重查。
create function public.require_listed_signer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(btrim(new.signer_emp_id), '') is not null
     and (tg_op = 'INSERT' or new.signer_emp_id is distinct from old.signer_emp_id)
     and not exists (select 1 from public.access_allowlist where emp_id = upper(btrim(new.signer_emp_id))) then
    raise exception '工號 % 不在放行名單上：請先請系統維護員開通，才能排進關卡', btrim(new.signer_emp_id)
      using errcode = '23514', hint = 'signer_not_listed';
  end if;
  return new;
end
$$;
comment on function public.require_listed_signer() is
  '關卡的簽核人要在放行名單上（Q150）；不在的 23514，hint signer_not_listed。';
revoke execute on function public.require_listed_signer() from public, anon, authenticated;

create trigger route_step_signer_listed
  before insert or update of signer_emp_id on public.route_step
  for each row execute function public.require_listed_signer();
create trigger assessment_step_signer_listed
  before insert or update of signer_emp_id on public.assessment_step
  for each row execute function public.require_listed_signer();

-- 還排在關卡上的人不能移出名單：移出後他進不來，輪到他時沒有人能簽，而且下次發出會照抄流程上的他。
-- 直接問移除確認框用的 access_removal_impact（簽核中自評表還沒簽的關卡，與簽核流程的關卡），兩邊不會對不上。
-- 其餘同 20261117000001。
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
  if exists (select 1 from public.access_removal_impact(v_emp_id)) then
    raise exception '工號 % 還排在關卡上，請先換人再移除', v_emp_id using errcode = '23514', hint = 'still_assigned';
  end if;
  delete from public.access_allowlist where emp_id = v_emp_id;
  if not found then
    raise exception '工號 % 不在放行名單上', v_emp_id using errcode = 'P0002';
  end if;
  update public.employee_ref set audit_role = 'signer', viewer_plant_ids = '{}' where emp_id = v_emp_id;
end
$$;
comment on function public.remove_access_member(text) is
  '權限管理：移出放行名單，角色改回一般使用者、清空檢視廠區（Q98 (5)）。只有系統維護員能移除；還排在簽核中自評表'
  '或簽核流程關卡上的人不能移除，先換人（Q150，23514 hint still_assigned）。';

-- 移除確認框列的關卡：工號照 OMS 的寫法存，比對時統一大寫（原本直接比，小寫存的會漏列）。其餘同 20261207000000。
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
     where upper(btrim(s.signer_emp_id)) = upper(btrim(p_emp_id))
       and a.status = 'in_progress'
       and s.state <> 'done'
    union all
    select 'route', null::uuid, r.id, null::integer, t.code, t.name, p.factory_code, p.name, rs.position, rs.name
      from public.route_step rs
      join public.approval_route r on r.id = rs.route_id
      join public.questionnaire_template t on t.id = r.template_id
      join public.plant p on p.id = r.plant_id
     where upper(btrim(rs.signer_emp_id)) = upper(btrim(p_emp_id))
    order by 1, 4, 7, 5, 9;
end
$$;

-- 選人時先問哪些工號在放行名單上：分派、換人、流程編輯器與匯入分派表在寫入前就告訴使用者誰還沒開通（寫入時
-- require_listed_signer 照樣擋）。給能向 OMS 查人的人（people_lookup_limit > 0），只回答問到的工號在不在名單上。
create function public.listed_emp_ids(p_emp_ids text[])
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select a.emp_id
    from public.access_allowlist a
   where (select public.people_lookup_limit()) > 0
     and a.emp_id = any (array(select upper(btrim(x)) from unnest(coalesce(p_emp_ids, '{}')) x))
$$;
comment on function public.listed_emp_ids(text[]) is
  '問到的工號裡哪些在放行名單上（大寫，Q150）：給能用工號查人的人（people_lookup_limit > 0），其他人一律空。';
revoke execute on function public.listed_emp_ids(text[]) from public, anon;
grant execute on function public.listed_emp_ids(text[]) to authenticated;

-- 分派選人的名單只列放行名單上的人：不在名單上的人選了也排不進關卡（Q150）。其餘同 20261215000000。
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
       and exists (select 1 from public.access_allowlist l where l.emp_id = upper(btrim(x.emp_id)))
     order by 1;
end
$$;
comment on function public.plant_form_people(text) is
  '分派選人的名單（#218 規則 ④）：這一廠的自評表（不分年度）與簽核流程上、由分派決定的關卡已經排過的人（工號、CSA 存的姓名，Q147）；'
  '只給這一廠的廠區管理員、稽核主管與系統維護員（can_assign_plant）。只列放行名單上的人（Q150）；名單以外的人輸入完整工號向 OMS 查。';
