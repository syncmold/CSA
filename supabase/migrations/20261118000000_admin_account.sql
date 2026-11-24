-- 管理員帳號 (#161, Q122 (5))：OMS 上的系統管理帳號 admin@id.syncmold.com.tw，不屬於任何員工；權限同系統維護員，
-- 不受放行名單限制，不能被移除或降級。
--
-- OMS 上它沒有工號，所以換證比照主管的 GHG 以 Email 認它（exchange/adminAccount.ts 的 ADMIN_EMAIL），發給它的 session 帶
-- 工號 admin 與 app_metadata.admin_account = true。它的權限只來自這個 session 標記，不在放行名單與 employee_ref：
-- 名單上沒有它可移除，employee_ref 沒有它的角色可降級，而這兩張表任何身分（含系統維護員、service_role、部署指令與
-- db:set-role）都寫不進它的工號，所以也沒辦法用加一列的方式改掉它。它的操作照常寫進權限異動紀錄，操作者工號是 admin
-- （畫面顯示「管理員帳號」）。規則全在這裡（ADR-0001）。

-- 呼叫者是管理員帳號嗎？只有換證服務簽得出帶這個標記的 session。
create or replace function public.is_admin_account()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'admin_account', '') = 'true'
$$;
comment on function public.is_admin_account() is
  '呼叫者是管理員帳號嗎（Q122 (5)）？看換證發的 session 上的 admin_account 標記。';

-- 管理員帳號的角色就是系統維護員：is_system_maintainer()、can_manage_access()、can_read_all() 與前端判斷角色都經這裡，
-- 不必一一加條件。其他人照舊讀自己 employee_ref 那一列。
create or replace function public.current_audit_role()
returns public.audit_role
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.is_admin_account() then 'system_maintainer'::public.audit_role
    else (select audit_role from public.employee_ref where emp_id = public.current_emp_id())
  end
$$;
comment on function public.current_audit_role() is
  '呼叫者的權限角色：員工看 employee_ref，管理員帳號是系統維護員（Q122 (5)）。前端也以 /rpc/current_audit_role 讀。';

comment on function public.is_system_maintainer() is
  '呼叫者是系統維護員嗎（Q122）？只有系統維護員能做的事都看它；管理員帳號（#161）經 current_audit_role() 也通過它。';

-- 管理員帳號的工號（exchange/adminAccount.ts 的 ADMIN_EMP_ID，兩邊要一起改）不能進放行名單與 employee_ref（工號比對不分
-- 大小寫、去頭尾空白，同 is_admitted）。對所有身分都擋，含 service_role、部署指令與 db:set-role，比照「至少留一位稽核
-- 管理者」。拒絕時 42501，hint admin_account。
create or replace function public.keep_admin_account_off_the_list()
returns trigger
language plpgsql
as $$
begin
  if upper(btrim(new.emp_id)) = 'ADMIN' then
    raise exception '管理員帳號不屬於任何員工，不能加入放行名單或設定角色' using errcode = '42501', hint = 'admin_account';
  end if;
  return new;
end
$$;
revoke execute on function public.keep_admin_account_off_the_list() from public, anon, authenticated;

create trigger employee_ref_no_admin_account
  before insert or update on public.employee_ref
  for each row execute function public.keep_admin_account_off_the_list();
create trigger access_allowlist_no_admin_account
  before insert or update on public.access_allowlist
  for each row execute function public.keep_admin_account_off_the_list();
