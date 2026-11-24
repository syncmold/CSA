-- 用工號查人、CSA 自己存的姓名、誰看得到誰（#218，Q133 (6)；使用者 2026-11-23 定的四條保密規則的前三條）。
--
-- 背景：OMS 刪掉了 employees_picker（Q133 (9)），改開一條只能從後端呼叫的專用查詢通道（Q133 (10)）：給工號、回這個人，
-- 不能搜尋、不能列名單，一天 5,000 個工號。所以姓名改由 CSA 自己存在員工參照，畫面讀 CSA 的；這份名單要保密：
--   1. 整份名單只有稽核主管、系統維護員看得到（權限管理；employee_ref 原本的讀取規則，不動）。
--   2. 用工號向 OMS 查人：只有稽核主管、系統維護員、稽核人員、廠區管理員（people_lookup_limit，CSA 後端先問它）；
--      一次能查幾個也由它定，免得有人拿連號的工號一次掃出一大批人。
--   3. 其他人只看得到自己本來就看得到的自評表上那些簽核人的姓名；看得到簽核流程的人看得到流程上的簽核人
--      （visible_people）。
-- 這個檔案也把 tracking_signer_names 收緊成同一條規則：原本檢視者與廠區管理員可以直接呼叫它拿到整份員工參照的姓名。

-- 誰能用工號向 OMS 查人 ------------------------------------------------------------------------------------

create function public.people_lookup_limit()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.can_manage_access() then 200
    when public.is_audit_staff()
      or exists (select 1 from public.plant_coordinator pc where pc.emp_id = public.current_emp_id()) then 20
    else 0
  end
$$;
comment on function public.people_lookup_limit() is
  '呼叫者一次能用工號向 OMS 查幾個人（#218 規則 2），0 是不能查：稽核主管與系統維護員 200（權限管理一次貼一批、OMS 單次上限），'
  '稽核人員與任何一廠的廠區管理員 20（選人是一次一位）。CSA 後端查 OMS 之前先問。';
revoke execute on function public.people_lookup_limit() from public, anon;
grant execute on function public.people_lookup_limit() to authenticated;

-- 查到的人把姓名記下來 ----------------------------------------------------------------------------------------
-- 只記姓名（Q133 (6)：廠區、在職狀態、有沒有勾 CSA 每次要判斷時才問 OMS）；角色、檢視廠區、最後登入都不動。
-- 工號照 OMS 主檔的寫法（後端傳來的就是），和登入時 record_login、分派時 assign_step_signer 存的一樣，不另外轉大寫。
-- 新的一列是一般使用者、不在放行名單，所以不會進異動紀錄（log_employee_access_change 只記放行名單上的人）。

create function public.record_people(p_people jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.employee_ref (emp_id, name)
  select distinct on (btrim(p ->> 'emp_id')) btrim(p ->> 'emp_id'), btrim(p ->> 'name')
    from jsonb_array_elements(p_people) p
   where btrim(coalesce(p ->> 'emp_id', '')) <> '' and btrim(coalesce(p ->> 'name', '')) <> ''
  on conflict (emp_id) do update set name = excluded.name
   where public.employee_ref.name is distinct from excluded.name
$$;
comment on function public.record_people(jsonb) is
  '把向 OMS 查到的人的姓名記進員工參照（#218）：[{emp_id, name}]。只給 CSA 後端（service_role）呼叫。';
revoke execute on function public.record_people(jsonb) from public, anon, authenticated;
grant execute on function public.record_people(jsonb) to service_role;

-- 呼叫者看得到哪些人的姓名 ------------------------------------------------------------------------------------

create function public.visible_people()
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
$$;
comment on function public.visible_people() is
  '呼叫者看得到姓名的人（#218 規則 1、3）：稽核主管與系統維護員看全部；其他人看自己、自己看得到的自評表上的簽核人，'
  '看得到簽核流程的人（稽核人員）再加流程上的簽核人。姓名是 CSA 自己存的（登入時、有人用工號查到時寫入）。';
revoke execute on function public.visible_people() from public, anon;
grant execute on function public.visible_people() to authenticated;

-- 追蹤總覽的簽核人姓名跟著同一條規則（view 的定義不變，仍然 join 這個函式）。
create or replace function public.tracking_signer_names()
returns table (emp_id text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select v.emp_id, v.name from public.visible_people() v
$$;
comment on function public.tracking_signer_names() is
  '追蹤總覽的簽核人姓名：只有呼叫者看得到的自評表上的簽核人（visible_people，#218）；稽核主管與系統維護員看全部。';
