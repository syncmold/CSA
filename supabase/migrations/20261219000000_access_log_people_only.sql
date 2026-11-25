-- 權限異動紀錄只記人員異動（Q149）：放行名單的加入與移除、角色（含接任稽核主管）、檢視廠區、備註、廠區管理員的
-- 指定／更換／卸任。分派類（發出前在流程上分派與換人、發出後自評表的分派、換人、從缺、帶入去年，以及連動關卡
-- 跟著換人）不再記，也不另外記在別處。
--
-- 寫分派紀錄的函式很多（分派、換人、年度發起、連動同步、Excel 匯入），都經 log_access_change 寫入，所以只在這裡
-- 擋掉分派類，那些函式不動。已寫進去的舊分派列不刪（紀錄只新增），讀取規則不再讓人讀到它們。

-- 哪些動作是分派類：寫入（log_access_change）與讀取規則共用這一份。不帶參數、回傳整份清單，讀取規則包成
-- (select ...) 每個查詢只算一次（rls_initplan 測試）。
create function public.assignment_actions()
returns public.access_change_action[]
language sql
immutable
set search_path = public
as $$
  select array['step_assigned', 'step_reassigned', 'step_vacated', 'step_carried', 'route_step_assigned', 'route_step_reassigned']::public.access_change_action[]
$$;
comment on function public.assignment_actions() is
  '分派類的權限異動動作（分派、換人、從缺、帶入去年、流程上的分派與換人）：Q149 起不記，舊列不給讀。';
revoke execute on function public.assignment_actions() from public, anon;
grant execute on function public.assignment_actions() to authenticated;

create or replace function public.log_access_change(
  p_target text,
  p_action public.access_change_action,
  p_before jsonb,
  p_after jsonb,
  p_target_name text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.access_change_log (actor_emp_id, actor_name, target_emp_id, target_name, action, before, after)
  select public.current_emp_id(),
         (select name from public.employee_ref where emp_id = public.current_emp_id()),
         p_target,
         coalesce((select name from public.employee_ref where emp_id = p_target), p_target_name),
         p_action, p_before, p_after
  where p_action <> all (public.assignment_actions())
$$;
revoke execute on function public.log_access_change(text, public.access_change_action, jsonb, jsonb, text) from public, anon, authenticated;
comment on function public.log_access_change(text, public.access_change_action, jsonb, jsonb, text) is
  '寫一筆權限異動紀錄；分派類（step_*、route_step_*）不記（Q149）。只給資料庫自己的函式與觸發器呼叫。';

alter policy access_change_log_access_manager_read on public.access_change_log
  using (
    (select public.can_manage_access())
    and action <> all ((select public.assignment_actions())::public.access_change_action[])
  );

comment on type public.access_change_action is
  '加入放行名單、移出放行名單、角色、檢視廠區、備註；指定、更換、移除廠區管理員；稽核主管接任。分派、換人、從缺、帶入去年、'
  '流程上的分派與換人是 Q149 以前的分派類，不再寫入（assignment_actions()）。';

comment on table public.access_change_log is
  '權限異動紀錄（Q98 (7)、Q149）：人員異動，只新增，任何身分都不能改或刪；只有稽核主管與系統維護員讀得到。'
  '操作者空值＝部署指令或 db:set-role。2026-11-25 以前寫進的分派類列（step_*、route_step_*）留在表裡，讀取規則不給讀。';

comment on function public.assign_route_signer(uuid, text, text) is
  '發出前分派（Q147）：替簽核流程上非連動的關卡指定或更換簽核人，發出時照抄進自評表。稽核主管、系統維護員或該流程廠區的'
  '廠區管理員可呼叫；連動關卡拒絕（hint linked_step）；不記權限異動紀錄（Q149）。';
