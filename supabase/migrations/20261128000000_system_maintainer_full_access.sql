-- 系統維護員有全部功能（Q129，修訂 Q122 (2)）：使用者 2026-11-16 要求，系統更新測試時維護員要能自己操作、看到實際變化，
-- 全部環境都一樣。原本「權限管理＋其他唯讀」的職責分離不再成立。
--
-- 做法：稽核業務的寫入（範本、自評單位、內控依據、簽核流程、年度發起、作廢、分派填寫人、換人）與「看全部」都經
-- is_audit_admin()，所以只要它對系統維護員也回 true，各 policy 與寫入函式不必一一改。名稱不換：它問的是「能做稽核管理者
-- 的事嗎」。仍然只看角色本身的地方不受影響：
--   * 權限管理裡誰能設定稽核管理者、系統維護員（require_may_manage 看 employee_ref.audit_role）——維護員本來就全部能設；
--   * 至少留一位稽核管理者／系統維護員（guard_last_holder 看 audit_role）；
--   * 系統維護員不能當廠區管理員（assign_plant_coordinator 看 audit_role）：他已經能分派、換人全部廠區，不必再負責某一廠；
--   * 作答、送出、核准、退回仍只在輪到自己的關卡（看簽核人，不看角色）。
-- 管理員帳號（#161）的角色就是系統維護員，跟著有全部功能。

create or replace function public.is_audit_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_audit_role() in ('audit_admin', 'system_maintainer'), false)
$$;
comment on function public.is_audit_admin() is
  '呼叫者能做稽核管理者的事嗎：稽核管理者或系統維護員（Q129 修訂 Q122 (2)：維護員有全部功能）。各表 RLS 與稽核業務的寫入函式共用。';

-- can_read_all() 的內容不變（現在和 is_audit_admin() 是同一群人），只更新說明：維護員不再是唯讀。
comment on function public.can_read_all() is
  '呼叫者看得到全部廠區的自評表、答案、追蹤總覽與範本、流程等設定嗎：稽核管理者或系統維護員（Q122 (2)、Q129）。'
  '和 is_audit_admin() 分開問：OPEN-6 若加看全部、不改東西的角色，只改這裡。';
