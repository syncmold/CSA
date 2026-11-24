-- 系統維護員 (#159, Q122 (1))：權限角色多一個值，和稽核管理者分開。一人一個值，所以兩者互斥。
-- 新加的 enum 值要等這個交易 commit 之後才能用（Postgres 的限制），所以用到它的規則放在下一個 migration。
alter type public.audit_role add value 'system_maintainer';
comment on type public.audit_role is
  '權限角色：signer＝一般使用者、viewer＝檢視者、audit_admin＝稽核管理者、system_maintainer＝系統維護員（Q117、Q122）。'
  '廠區負責人按廠區指定，不在這裡（plant_coordinator）。';
