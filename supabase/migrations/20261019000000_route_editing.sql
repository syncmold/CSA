-- 流程編輯器與啟用檢查 (工單 #11)：稽核管理者為「問卷範本 × 廠區」建立簽核流程，逐關新增、排序、刪除，
-- 按「啟用」時由資料庫檢查流程能不能用。用語依 GLOSSARY.md，實作決定見需求決策紀錄 Q86。
--
-- 寫入一律只給稽核管理者，規則都在這裡 (ADR-0001)：
--   流程     新增（一律是草稿）與刪除直接寫表；啟用中的不能刪，先停用。狀態只能透過 activate_route／deactivate_route 改。
--            範本必須適用該廠區（all_plants 或列在 template_plant），否則年度發起永遠用不到它
--   關卡     新增走 insert_route_step（可指定插在第幾關之前，預設排最後）；修改、刪除直接寫表；
--            位置只由資料庫決定（新增、刪除後重編、拖曳走 reorder_route_steps）
--   簽核人   OMS 工號 (Q61)，不是外鍵；名單在 OMS，CSA 只檢查不是空白
--   稽核室覆核關卡只能唯讀（可編輯範圍只給廠區端，Q13）
-- 啟用檢查 activation_check（Q54、Q86）：
--   no_steps            流程沒有關卡
--   missing_units       範本用到的自評單位（有控制要點掛著它的）沒有任何關卡的可編輯範圍涵蓋它；沒有自評單位的控制要點
--                       （要素類可以不填，Q83）不會產生這一項，因為沒有哪個單位負責它，也就沒有哪一關要涵蓋它
--   last_step_editable  最後一關有可編輯範圍：自行檢查人員送出後要有下一關，結案只由最後一關「核准」(#5、#6)
--   unused_units        關卡的可編輯範圍是範本沒有用到的自評單位：那一關沒有控制要點可答，卻仍要填整體結論
-- 啟用中的流程也可以直接修改；稽核管理者的每一次修改在交易結束前重跑啟用檢查，只要比修改前多出問題就整筆拒絕
-- (23514)。所以人透過 API 不會把啟用中的流程改壞；範本後來改過、本來就不通過的流程，仍可以一關一關補回來。
-- 已發出的自評表（含簽核中的）不受影響：發起時已複製關卡 (ADR-0004)，之後只能在自評表上加簽、換人 (#13)。

-- 排序要一次搬動多列：唯一約束改成「整個陳述式結束才檢查」。
alter table public.route_step
  drop constraint route_step_route_id_position_key,
  add constraint route_step_route_id_position_key unique (route_id, position) deferrable initially immediate,
  add constraint route_step_name_present check (btrim(name) <> ''),
  add constraint route_step_signer_present check (signer_emp_id <> '' and signer_emp_id = btrim(signer_emp_id)),
  add constraint route_step_audit_review_read_only check (step_group = 'plant' or editable_unit_id is null);

-- 啟用檢查 ----------------------------------------------------------------------
-- 參數是流程那一列，所以它同時是 PostgREST 的計算欄位：清單與編輯頁 select `activation_check` 就拿到結果，
-- 啟用函式也用它，畫面與資料庫只有一份規則。security invoker：稽核管理者讀得到流程、關卡與範本內容。

create or replace function public.activation_check(r public.approval_route)
returns jsonb
language sql
stable
set search_path = public
as $$
  with steps as (
    select position, editable_unit_id from public.route_step where route_id = r.id
  ),
  used as (
    -- 範本用到的自評單位，依紙本上第一次出現的位置排序。
    select cp.assessing_unit_id as unit_id, min(array[s.position, cp.position]) as first_seen
    from public.template_section s
    join public.control_point cp on cp.section_id = s.id
    where s.template_id = r.template_id and cp.assessing_unit_id is not null
    group by cp.assessing_unit_id
  ),
  missing as (
    select u.id, u.name, used.first_seen
    from used
    join public.assessing_unit u on u.id = used.unit_id
    where not exists (select 1 from steps where steps.editable_unit_id = used.unit_id)
  ),
  unused as (
    -- 關卡指定了、範本卻沒用到的自評單位，依關卡順序。
    select u.id, u.name, min(steps.position) as first_step
    from steps
    join public.assessing_unit u on u.id = steps.editable_unit_id
    where not exists (select 1 from used where used.unit_id = steps.editable_unit_id)
    group by u.id, u.name
  ),
  facts as (
    select
      not exists (select 1 from steps) as no_steps,
      coalesce((select editable_unit_id is not null from steps order by position desc limit 1), false) as last_step_editable,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by first_seen) from missing), '[]'::jsonb) as missing_units,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by first_step) from unused), '[]'::jsonb) as unused_units
  )
  select jsonb_build_object(
    'ready', not no_steps and not last_step_editable
             and jsonb_array_length(missing_units) = 0 and jsonb_array_length(unused_units) = 0,
    'no_steps', no_steps,
    'last_step_editable', last_step_editable,
    'missing_units', missing_units,
    'unused_units', unused_units
  )
  from facts
$$;
comment on function public.activation_check(public.approval_route) is
  '簽核流程的啟用檢查：{ready, no_steps, last_step_editable, missing_units, unused_units}（單位為 [{id,name}]）；也是 PostgREST 計算欄位。';

-- 修改後才出現的問題：after 有、before 沒有的那些，形狀與啟用檢查相同；沒有新問題回 null。
create or replace function public.activation_regressions(p_before jsonb, p_after jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  with diff as (
    select
      coalesce((p_after ->> 'no_steps')::boolean, false)
        and not coalesce((p_before ->> 'no_steps')::boolean, false) as no_steps,
      coalesce((p_after ->> 'last_step_editable')::boolean, false)
        and not coalesce((p_before ->> 'last_step_editable')::boolean, false) as last_step_editable,
      coalesce((
        select jsonb_agg(u) from jsonb_array_elements(coalesce(p_after -> 'missing_units', '[]'::jsonb)) u
        where not coalesce(p_before -> 'missing_units', '[]'::jsonb) @> jsonb_build_array(u)
      ), '[]'::jsonb) as missing_units,
      coalesce((
        select jsonb_agg(u) from jsonb_array_elements(coalesce(p_after -> 'unused_units', '[]'::jsonb)) u
        where not coalesce(p_before -> 'unused_units', '[]'::jsonb) @> jsonb_build_array(u)
      ), '[]'::jsonb) as unused_units
  )
  select case
    when no_steps or last_step_editable or jsonb_array_length(missing_units) > 0 or jsonb_array_length(unused_units) > 0
    then jsonb_build_object(
      'ready', false, 'no_steps', no_steps, 'last_step_editable', last_step_editable,
      'missing_units', missing_units, 'unused_units', unused_units)
  end
  from diff
$$;
comment on function public.activation_regressions(jsonb, jsonb) is '內部用：兩次啟用檢查之間新出現的問題；沒有就回 null。';

-- 範本必須適用該廠區 ---------------------------------------------------------------
-- 所有身分都擋（含 service_role）：不適用的組合年度發起永遠用不到（launch_annual_cycle 只取適用廠區）。
-- hint 帶機器可讀的原因，畫面據以顯示訊息。

create or replace function public.check_route_plant_applicable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.questionnaire_template t
    join public.plant p on p.id = new.plant_id
    where t.id = new.template_id
      and (t.all_plants or exists (
        select 1 from public.template_plant tp where tp.template_id = t.id and tp.factory_code = p.factory_code))
  ) then
    raise exception '問卷範本不適用這個廠區，不能建立簽核流程' using errcode = '23514', hint = 'plant_not_applicable';
  end if;
  return new;
end
$$;

create trigger approval_route_plant_applicable
  before insert or update of template_id, plant_id on public.approval_route
  for each row execute function public.check_route_plant_applicable();

-- 關卡：鎖流程、排最後、刪除後重編 -------------------------------------------------
-- 一個交易第一次寫某條流程的關卡時：更新流程那一列的 updated_at（記下最後修改時間，也鎖住流程，同一條流程的
-- 關卡修改與「啟用」一個一個來，同時新增也不會算出同一個位置），並把修改前的啟用檢查存進交易內的設定值，
-- 交易結束時拿來比對。同一交易之後的列（排序、重編）不再重做。

create or replace function public.route_txn_key(p_kind text, p_route_id uuid)
returns text
language sql
immutable
as $$
  select 'csa.route_' || p_kind || '_' || replace(p_route_id::text, '-', '')
$$;
comment on function public.route_txn_key(text, uuid) is '內部用：流程在這個交易裡的暫存設定值名稱（流程 id 去掉連字號）。';

create or replace function public.route_step_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_route  uuid := case tg_op when 'DELETE' then old.route_id else new.route_id end;
  r        public.approval_route;
begin
  if coalesce(current_setting(public.route_txn_key('before', v_route), true), '') = '' then
    update public.approval_route set updated_at = now() where id = v_route
    returning * into r;
    perform set_config(
      public.route_txn_key('before', v_route),
      case when r.status = 'active' then public.activation_check(r)::text else '{}' end,
      true);
  end if;
  if tg_op = 'INSERT' and new.position is null then
    select coalesce(max(position), 0) + 1 into new.position
    from public.route_step where route_id = new.route_id;
  end if;
  return case tg_op when 'DELETE' then old else new end;
end
$$;

create trigger route_step_before_write
  before insert or update or delete on public.route_step
  for each row execute function public.route_step_before_write();

create or replace function public.renumber_route_steps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.route_step rs
  set position = r.rn
  from (
    select id, row_number() over (partition by route_id order by position) as rn
    from public.route_step
    where route_id in (select route_id from deleted_rows)
  ) r
  where rs.id = r.id and rs.position <> r.rn;
  return null;
end
$$;

create trigger route_step_renumber
  after delete on public.route_step
  referencing old table as deleted_rows
  for each statement execute function public.renumber_route_steps();

-- 啟用中的流程保持可用 -------------------------------------------------------------
-- 交易結束前（排序、刪除後重編都做完）比對修改前後的啟用檢查，多出問題就拒絕，details 只列新出現的問題。
-- 每條流程每個交易只比一次：延後的觸發都在交易結束時才跑，第一個看到的已是最後的關卡。
-- 只約束「人」的修改：service_role 與種子腳本（測試準備、db:seed-route）沒有工號，它們會先建啟用的流程再逐關加入，
-- 中途本來就不完整。日後的對話寫入 (ADR-0006) 要以稽核管理者的身分寫，才會受這條約束。

create or replace function public.keep_active_route_ready()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_route   uuid := case tg_op when 'DELETE' then old.route_id else new.route_id end;
  r         public.approval_route;
  v_before  text;
  v_worse   jsonb;
begin
  if public.current_emp_id() is null
     or coalesce(current_setting(public.route_txn_key('checked', v_route), true), '') <> '' then
    return null;
  end if;
  perform set_config(public.route_txn_key('checked', v_route), '1', true);
  select * into r from public.approval_route where id = v_route;
  if not found or r.status <> 'active' then
    return null;
  end if;
  -- 修改前不是啟用中（或沒記到）就當作原本完全通過。
  v_before := nullif(coalesce(current_setting(public.route_txn_key('before', v_route), true), ''), '');
  v_worse := public.activation_regressions(coalesce(v_before, '{}')::jsonb, public.activation_check(r));
  if v_worse is not null then
    raise exception '這項修改會讓啟用中的簽核流程多出啟用檢查的問題' using errcode = '23514', detail = v_worse::text;
  end if;
  return null;
end
$$;

create constraint trigger route_step_keep_active_route_ready
  after insert or update or delete on public.route_step
  deferrable initially deferred
  for each row execute function public.keep_active_route_ready();

-- 直接寫表的授權與 RLS --------------------------------------------------------------
-- 流程只開放新增（範本與廠區）與刪除，狀態走下面的函式；關卡只開放修改與刪除，刻意不含 position 與 route_id。
-- 關卡的新增走 insert_route_step：插在中間要先挪動後面的關卡，必須同一個交易，啟用中的流程才不會在中途
-- 被判成「最後一關有可編輯範圍」。

grant insert (template_id, plant_id), delete on public.approval_route to authenticated;
grant update (name, step_group, signer_emp_id, editable_unit_id), delete on public.route_step to authenticated;

create policy approval_route_insert_audit_admin on public.approval_route
  for insert to authenticated with check (public.is_audit_admin());
-- 啟用中的流程不能刪（年度發起要用它），先停用。
create policy approval_route_delete_audit_admin on public.approval_route
  for delete to authenticated using (public.is_audit_admin() and status <> 'active');

create policy route_step_update_audit_admin on public.route_step
  for update to authenticated using (public.is_audit_admin()) with check (public.is_audit_admin());
create policy route_step_delete_audit_admin on public.route_step
  for delete to authenticated using (public.is_audit_admin());

-- 啟用、停用、排序 ----------------------------------------------------------------
-- 啟用：檢查不通過回 {ok:false, error:'not_ready', no_steps, last_step_editable, missing_units, unused_units}，什麼都不改；
-- 通過就把同一「範本 × 廠區」原本啟用的流程改為停用（同時只能有一條，Q81），回 {ok:true, replaced}。
-- 錯誤：不是稽核管理者 42501；流程不存在 P0002。

create or replace function public.activate_route(p_route_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r           public.approval_route;
  v_check     jsonb;
  v_replaced  uuid;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can activate a route' using errcode = '42501';
  end if;
  select * into r from public.approval_route where id = p_route_id for update;
  if not found then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
  v_check := public.activation_check(r);
  if not (v_check ->> 'ready')::boolean then
    return jsonb_build_object('ok', false, 'error', 'not_ready') || (v_check - 'ready');
  end if;
  if r.status <> 'active' then
    update public.approval_route
    set status = 'inactive'
    where template_id = r.template_id and plant_id = r.plant_id and status = 'active'
    returning id into v_replaced;
    update public.approval_route set status = 'active' where id = p_route_id;
  end if;
  return jsonb_build_object('ok', true, 'replaced', v_replaced);
end
$$;
comment on function public.activate_route(uuid) is
  '稽核管理者啟用簽核流程：通過啟用檢查才啟用，並停用同一範本 × 廠區原本啟用的流程。';

create or replace function public.deactivate_route(p_route_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can deactivate a route' using errcode = '42501';
  end if;
  update public.approval_route set status = 'inactive' where id = p_route_id and status = 'active';
  if not found and not exists (select 1 from public.approval_route where id = p_route_id) then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
end
$$;
comment on function public.deactivate_route(uuid) is '稽核管理者停用簽核流程（已停用或草稿則不變）。';

-- 新增關卡：p_before_position 為空值＝排最後；給 1..n＝插在原本第 p 關之前（第 p 關起往後挪一位）。
-- 錯誤：不是稽核管理者 42501；流程不存在 P0002；位置不在 1..n 22023；名稱、簽核人空白或稽核室覆核有可編輯範圍 23514。
create or replace function public.insert_route_step(
  p_route_id          uuid,
  p_name              text,
  p_step_group        public.step_group,
  p_signer_emp_id     text,
  p_editable_unit_id  uuid default null,
  p_before_position   integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count  integer;
  v_id     uuid;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can add steps' using errcode = '42501';
  end if;
  perform 1 from public.approval_route where id = p_route_id for update;
  if not found then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
  select count(*) into v_count from public.route_step where route_id = p_route_id;
  if p_before_position is not null and (p_before_position < 1 or p_before_position > v_count) then
    raise exception 'p_before_position must be between 1 and %', v_count using errcode = '22023';
  end if;
  if p_before_position is not null then
    update public.route_step set position = position + 1
    where route_id = p_route_id and position >= p_before_position;
  end if;
  insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id)
  values (p_route_id, p_before_position, btrim(p_name), p_step_group, btrim(p_signer_emp_id), p_editable_unit_id)
  returning id into v_id;
  return v_id;
end
$$;
comment on function public.insert_route_step(uuid, text, public.step_group, text, uuid, integer) is
  '稽核管理者新增關卡：排最後，或插在第 p_before_position 關之前；回傳關卡 id。';

-- 拖曳排序送來的是排好後的完整 id 清單；不是剛好那一組就拒絕，以免畫面過期時排進別條流程的關卡。
create or replace function public.reorder_route_steps(p_route_id uuid, p_step_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can reorder steps' using errcode = '42501';
  end if;
  if (select array_agg(id order by id) from public.route_step where route_id = p_route_id)
     is distinct from (select array_agg(x order by x) from unnest(p_step_ids) x) then
    raise exception 'p_step_ids must list every step of the route exactly once' using errcode = '22023';
  end if;
  update public.route_step rs
  set position = o.ord
  from unnest(p_step_ids) with ordinality as o(id, ord)
  where rs.id = o.id and rs.position <> o.ord;
end
$$;
comment on function public.reorder_route_steps(uuid, uuid[]) is '稽核管理者重排一條流程的關卡：依給的 id 順序編成 1..n。';

-- 執行權限：預設會給 public／anon。開放給登入者的函式內仍檢查稽核管理者。
revoke execute on function public.activate_route(uuid) from public, anon;
revoke execute on function public.deactivate_route(uuid) from public, anon;
revoke execute on function public.reorder_route_steps(uuid, uuid[]) from public, anon;
revoke execute on function public.insert_route_step(uuid, text, public.step_group, text, uuid, integer) from public, anon;
revoke execute on function public.activation_check(public.approval_route) from public, anon;
revoke execute on function public.activation_regressions(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.route_txn_key(text, uuid) from public, anon, authenticated;
grant execute on function public.activate_route(uuid) to authenticated;
grant execute on function public.deactivate_route(uuid) to authenticated;
grant execute on function public.reorder_route_steps(uuid, uuid[]) to authenticated;
grant execute on function public.insert_route_step(uuid, text, public.step_group, text, uuid, integer) to authenticated;
grant execute on function public.activation_check(public.approval_route) to authenticated;
