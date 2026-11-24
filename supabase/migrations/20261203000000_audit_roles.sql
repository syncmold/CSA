-- 稽核角色重整 (#187、#188)：權限角色多「稽核人員」，權限異動紀錄多「接任稽核主管」一種動作。
-- 稽核主管（原稽核管理者）的資料庫值 audit_admin 不改，只改畫面與文件的用語。
-- 新加的 enum 值要等這個交易 commit 之後才能用（Postgres 的限制），所以用到它們的規則放在下一個 migration。
alter type public.audit_role add value 'audit_staff';
alter type public.access_change_action add value 'audit_admin_replaced';

comment on type public.audit_role is
  '權限角色：signer＝一般使用者、viewer＝檢視者、audit_admin＝稽核主管（剛好一位）、audit_staff＝稽核人員、'
  'system_maintainer＝系統維護員（Q117、Q122、#187）。廠區管理員按廠區指定，不在這裡（plant_coordinator）。';
comment on type public.access_change_action is
  '加入放行名單、移出放行名單、角色、檢視廠區、備註；指定、更換、移除廠區管理員；分派、換人、從缺、帶入去年；接任稽核主管。';
