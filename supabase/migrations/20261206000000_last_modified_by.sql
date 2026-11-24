-- Q137 (3)（#201）：範本與簽核流程的「最後修改」＝時間＋修改人，只記最後一次（Q128 (1) 不變，不留歷次紀錄）。
--
--   範本   抬頭照舊由觸發器更新時間，另外記修改人；章節、控制要點、控制要點的自評單位的新增、修改、刪除、重排也算
--          一次修改：鎖範本的觸發器原本只以 FOR NO KEY UPDATE 鎖住範本那一列，改成更新那一列（UPDATE 取的是同一種
--          列鎖），所以和年度發起的 FOR SHARE 照舊互斥（Q89）。
--   流程   改任何關卡本來就會更新流程那一列的 updated_at（route_step_before_write，#11），那一列的觸發器一併記修改人。
--   修改人 寫入者的工號（current_emp_id()，新增時是建立人）。管理員帳號記它 session 上的 admin（#161），畫面顯示
--          「管理員帳號」，同權限異動紀錄的操作者（使用者 2026-11-18）；對話寫入（csa_drafter）、系統轉換等沒有工號的
--          寫入留空。
--   種子、轉換類 migration 照舊暫停 questionnaire_template_touch_updated_at／approval_route_touch_updated_at：
--          觸發器名稱不變，暫停它就連同時間與修改人都不動（內容寫入的更新也只是交給它去填）。

-- 既有的列留空（不知道是誰改的）；新增的範本與流程記建立人，和 updated_at 預設為建立時間一致。
alter table public.questionnaire_template add column updated_by text;
alter table public.approval_route add column updated_by text;
alter table public.questionnaire_template alter column updated_by set default public.current_emp_id();
alter table public.approval_route alter column updated_by set default public.current_emp_id();
comment on column public.questionnaire_template.updated_by is
  '最後修改人的工號（Q137 (3)）：抬頭、章節、控制要點、自評單位任何一次寫入都會更新；管理員帳號是 admin；沒有工號的寫入（對話寫入、系統轉換）為空。';
comment on column public.approval_route.updated_by is
  '最後修改人的工號（Q137 (3)）：流程本身或任何關卡的寫入都會更新；沒有工號的寫入為空。';

-- 時間＋修改人：取代兩張表原本的 touch_updated_at（其他表照舊用它）。觸發器名稱不變，暫停的寫法照舊。
create function public.touch_last_modified()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  new.updated_by = public.current_emp_id();
  return new;
end
$$;
comment on function public.touch_last_modified() is '觸發器：記下最後修改的時間與修改人工號（範本、簽核流程，Q137 (3)）。';
revoke execute on function public.touch_last_modified() from public, anon, authenticated;

drop trigger questionnaire_template_touch_updated_at on public.questionnaire_template;
create trigger questionnaire_template_touch_updated_at
  before update on public.questionnaire_template
  for each row execute function public.touch_last_modified();

drop trigger approval_route_touch_updated_at on public.approval_route;
create trigger approval_route_touch_updated_at
  before update on public.approval_route
  for each row execute function public.touch_last_modified();

-- 範本內容寫入：鎖住並更新所屬範本 ------------------------------------------------------------------------------
-- 每個交易對每份範本只更新一次（之後的列，例如重編順序，只要已持有的列鎖）：交易內的設定值記下已更新過的範本，
-- 與流程關卡的 route_txn_key 同一做法。時間是交易開始的時間，修改人是同一人，更新一次就夠。
create function public.template_txn_key(p_template_id uuid)
returns text
language sql
immutable
as $$
  select 'csa.template_touched_' || replace(p_template_id::text, '-', '')
$$;
comment on function public.template_txn_key(uuid) is '內部用：範本在這個交易裡已記過最後修改的暫存設定值名稱（範本 id 去掉連字號）。';
revoke execute on function public.template_txn_key(uuid) from public, anon, authenticated;

-- 章節、控制要點、控制要點的自評單位的每一次寫入（所有身分），先更新所屬範本那一列：UPDATE 取 FOR NO KEY UPDATE 列鎖，
-- 與發起的 FOR SHARE 互斥，發起進行中改範本內容要等發起結束（Q89）；更新本身交給範本的 touch 觸發器填時間與修改人。
-- security definer：API 角色對範本表沒有 UPDATE 權限（範本只能經函式改），而更新需要它；函式除此之外什麼都不做。
-- 這個更新也會觸發範本列的其他 before update 觸發器：草稿途徑的 guard_draft_path（內容寫入本來就只在草稿範本下放行，
-- 範本列同樣是草稿）、版型不可改（版型沒變），都照常通過。
create or replace function public.lock_template_for_content_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template uuid;
begin
  if tg_table_name = 'template_section' then
    v_template := case when tg_op = 'DELETE' then old.template_id else new.template_id end;
  elsif tg_table_name = 'control_point' then
    -- 刪除整個章節時連帶刪除的控制要點，章節已不在；範本已由章節那一層更新。
    select s.template_id into v_template
    from public.template_section s
    where s.id = case when tg_op = 'DELETE' then old.section_id else new.section_id end;
  else
    -- control_point_unit：連帶刪除時控制要點已不在，範本已由上一層更新。
    select s.template_id into v_template
    from public.control_point cp
    join public.template_section s on s.id = cp.section_id
    where cp.id = case when tg_op = 'DELETE' then old.control_point_id else new.control_point_id end;
  end if;
  if v_template is not null and coalesce(current_setting(public.template_txn_key(v_template), true), '') = '' then
    update public.questionnaire_template set updated_at = updated_at where id = v_template;
    perform set_config(public.template_txn_key(v_template), 'touched', true);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
comment on function public.lock_template_for_content_write() is
  '觸發器：範本內容（章節、控制要點、自評單位）的寫入更新所屬範本那一列，記下最後修改並與發起的 FOR SHARE 互斥（Q89、Q137 (3)）。';

-- 修改人姓名（計算欄位）------------------------------------------------------------------------------------
-- 從員工參照取姓名（換證時寫入的快照）；查不到就是 null，畫面改顯示工號，沒有工號顯示「—」。
-- security definer：員工參照只有本人與稽核管理者讀得到。只回傳真的是這一列最後修改人的姓名（比對表上的值），
-- 不能拿任意工號來查名字。
create function public.updated_by_name(t public.questionnaire_template)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select e.name
  from public.questionnaire_template x
  join public.employee_ref e on e.emp_id = x.updated_by
  where x.id = t.id and x.updated_by = t.updated_by
$$;
comment on function public.updated_by_name(public.questionnaire_template) is '計算欄位：範本最後修改人的姓名（員工參照）；查不到為 null。';

create function public.updated_by_name(r public.approval_route)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select e.name
  from public.approval_route x
  join public.employee_ref e on e.emp_id = x.updated_by
  where x.id = r.id and x.updated_by = r.updated_by
$$;
comment on function public.updated_by_name(public.approval_route) is '計算欄位：簽核流程最後修改人的姓名（員工參照）；查不到為 null。';

revoke execute on function public.updated_by_name(public.questionnaire_template) from public, anon;
revoke execute on function public.updated_by_name(public.approval_route) from public, anon;
grant execute on function public.updated_by_name(public.questionnaire_template) to authenticated;
grant execute on function public.updated_by_name(public.approval_route) to authenticated;
