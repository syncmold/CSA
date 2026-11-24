-- 草稿途徑 (工單 #15，ADR-0006)：Claude 把分析後的問卷範本與簽核流程寫進資料庫，而且只能寫成草稿；
-- 稽核管理者在範本管理與流程編輯器檢查後按「啟用」才生效。用語依 GLOSSARY.md，實作決定見需求決策紀錄 Q90。
--
--   角色     csa_drafter：沒有任何資料表的授權，寫入只能經由下面的草稿函式（PUBLIC 可執行的唯讀判斷函式對它一律回否）。登入密碼由 `npm run db:init`
--            依 CSA_DRAFTER_PASSWORD 設定，`npm run drafts:write` 以它連線；這裡只確保角色存在（CI 的 Supabase 堆疊）。
--   函式     draft_template(定義)、draft_route(定義)：security definer，一律寫成草稿。
--            同編號＋版本的範本已啟用或停用就拒絕，要改請寫新版本；同編號＋版本的草稿整份取代。
--   標記     草稿函式一開始就把這個交易標成「走草稿途徑」(csa.draft_path)；觸發器看到標記，只放行草稿範本、
--            草稿流程與它們底下的資料。函式日後寫錯（或 #39 加內控文件的函式），也寫不出啟用中的資料。
--            標記只會多加限制、不會放寬任何權限，所以誰都能設定它也無妨。
-- 延伸到內控文件 (#39)：加一支 draft_control_procedure，開頭同樣呼叫 enter_draft_path，並把它的資料表掛上 guard 觸發器。

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'csa_drafter') then
    create role csa_drafter nologin noinherit;
  end if;
end
$$;
grant usage on schema public to csa_drafter;

-- 標記 ---------------------------------------------------------------------------

create or replace function public.enter_draft_path()
returns void
language sql
set search_path = public
as $$
  select set_config('csa.draft_path', 'on', true)
$$;
comment on function public.enter_draft_path() is '內部用：把目前交易標成走草稿途徑，之後的寫入只放行草稿。';

create or replace function public.in_draft_path()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(current_setting('csa.draft_path', true), '') = 'on'
$$;
comment on function public.in_draft_path() is '目前交易是否走草稿途徑 (Q90)。';

-- 走草稿途徑時只放行草稿 ---------------------------------------------------------------
-- 一列資料「歸誰管」：範本與流程看自己的狀態；章節、適用廠區看所屬範本；控制要點看所屬章節的範本；關卡看所屬流程。
-- 修改前（OLD）與修改後（NEW）都要歸草稿管：所以既改不到啟用中的資料，也不能把它搬到草稿底下。
-- 上層已不在（連帶刪除、或外鍵本來就會擋的新增）時沒有狀態，放行。
-- 自評單位是集團共用清單，沒有狀態：只放行新增，不能改名或刪除（會影響啟用中的範本）。

create or replace function public.draft_path_governing_status(p_table text, p_row jsonb)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case p_table
    when 'questionnaire_template' then p_row ->> 'status'
    when 'approval_route' then p_row ->> 'status'
    when 'template_section' then (select status::text from public.questionnaire_template where id = (p_row ->> 'template_id')::uuid)
    when 'template_plant' then (select status::text from public.questionnaire_template where id = (p_row ->> 'template_id')::uuid)
    when 'control_point' then (
      select t.status::text
      from public.template_section s join public.questionnaire_template t on t.id = s.template_id
      where s.id = (p_row ->> 'section_id')::uuid)
    when 'route_step' then (select status::text from public.approval_route where id = (p_row ->> 'route_id')::uuid)
  end
$$;
comment on function public.draft_path_governing_status(text, jsonb) is
  '內部用：草稿途徑判斷一列資料歸哪個範本或流程管，回傳那個範本或流程的狀態；上層不在時為 null。';

create or replace function public.guard_draft_path()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record := case tg_op when 'DELETE' then old else new end;
begin
  if not public.in_draft_path() then
    return v_row;
  end if;
  if tg_table_name = 'assessing_unit' then
    if tg_op <> 'INSERT' then
      raise exception '草稿途徑只能新增自評單位，不能改名或刪除' using errcode = '42501', hint = 'draft_only';
    end if;
    return v_row;
  end if;
  if (tg_op <> 'DELETE' and public.draft_path_governing_status(tg_table_name, to_jsonb(new)) <> 'draft')
     or (tg_op <> 'INSERT' and public.draft_path_governing_status(tg_table_name, to_jsonb(old)) <> 'draft') then
    raise exception '草稿途徑只能寫入草稿（%）', tg_table_name using errcode = '42501', hint = 'draft_only';
  end if;
  return v_row;
end
$$;
comment on function public.guard_draft_path() is '觸發器：走草稿途徑的交易只能寫入草稿範本、草稿流程與它們底下的資料 (Q90)。';

do $$
declare
  t text;
begin
  foreach t in array array['questionnaire_template', 'template_plant', 'template_section', 'control_point', 'assessing_unit', 'approval_route', 'route_step']
  loop
    execute format(
      'create trigger %I before insert or update or delete on public.%I for each row execute function public.guard_draft_path()',
      t || '_guard_draft_path', t);
  end loop;
end
$$;

-- 範本草稿 ---------------------------------------------------------------------------
-- 定義（和 supabase/drafts/templates/*.json 同形狀；其他鍵忽略）：
--   { code, name, layout: 'element'|'control_activity', version, allPlants, factoryCodes?: [OMS 廠區代碼],
--     sections: [{ name, controlPoints: [{ text, assessingUnit?: 自評單位名稱 }] }] }
-- 自評單位以名稱對應集團共用清單，清單沒有的就新增（新增的單位立即出現在清單上；它只是名稱，沒有範本或流程用到前不影響任何東西）。
-- 版型的自評單位規則沿用 #10 的觸發器（控制活動類必填）。
-- 已被自評表引用的範本（啟用、發起後又被改回草稿）不取代：自評表要能回溯當年的範本 (Q87)。
-- 回傳 {ok:true, template_id, replaced, sections, control_points}。
-- 錯誤：定義帶了草稿以外的 status 22023；取代草稿時改了版型 22023（#10 的觸發器）；
--       編號、名稱、版本空白，沒有章節，或章節名稱、控制要點文字空白 23514；
--       同編號＋版本已不是草稿、或已被自評表引用 42501；同一份新範本同時被另一個寫入建立 40001（重跑即可）。
-- 不檢查「限定廠區卻沒有給廠區代碼」：照樣寫入，由稽核管理者檢查抬頭時補上（2026-10-19 使用者決定，Q90）；drafts:write 會提醒。

-- 兩支草稿函式共用：定義不能自帶草稿以外的狀態，啟用只能由稽核管理者在畫面上按。
create or replace function public.reject_non_draft_status(p_def jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_def ? 'status' and p_def ->> 'status' is distinct from 'draft' then
    raise exception '草稿途徑只能寫成草稿，請拿掉 status（啟用由稽核管理者在範本管理或流程編輯器按）'
      using errcode = '22023', hint = 'draft_only';
  end if;
end
$$;
comment on function public.reject_non_draft_status(jsonb) is '內部用：草稿定義帶了草稿以外的 status 就拒絕 (Q90)。';

create or replace function public.draft_template(p_def jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code      text := btrim(p_def ->> 'code');
  v_name      text := btrim(p_def ->> 'name');
  v_version   text := btrim(p_def ->> 'version');
  v_all       boolean := coalesce((p_def ->> 'allPlants')::boolean, false);
  v_existing  public.questionnaire_template;
  v_id        uuid;
  v_points    integer;
begin
  perform public.enter_draft_path();
  perform public.reject_non_draft_status(p_def);
  if coalesce(v_code, '') = '' or coalesce(v_name, '') = '' or coalesce(v_version, '') = '' then
    raise exception '問卷範本的編號、名稱、版本不可空白' using errcode = '23514';
  end if;
  if jsonb_typeof(p_def -> 'sections') is distinct from 'array' or jsonb_array_length(p_def -> 'sections') = 0 then
    raise exception '範本 % 沒有章節', v_code using errcode = '23514';
  end if;
  -- 章節與控制要點的表沒有「不可空白」的約束（畫面的表單自己擋）；草稿途徑在這裡擋，Claude 漏抓文字時不會多出空白題。
  if exists (
    select 1 from jsonb_array_elements(p_def -> 'sections') sec where coalesce(btrim(sec ->> 'name'), '') = ''
  ) or exists (
    select 1
    from jsonb_array_elements(p_def -> 'sections') sec, jsonb_array_elements(coalesce(sec -> 'controlPoints', '[]'::jsonb)) cp
    where coalesce(btrim(cp ->> 'text'), '') = ''
  ) then
    raise exception '範本 % 有空白的章節名稱或控制要點文字', v_code using errcode = '23514';
  end if;

  select * into v_existing from public.questionnaire_template where code = v_code and version = v_version for update;
  if found then
    if v_existing.status <> 'draft' then
      raise exception '範本 % 版本 % 已是%，草稿途徑不能覆寫；請改用新的版本號', v_code, v_version, v_existing.status
        using errcode = '42501', hint = 'not_draft';
    end if;
    if exists (select 1 from public.assessment where template_id = v_existing.id) then
      raise exception '範本 % 版本 % 已發出過自評表，草稿途徑不能覆寫；請改用新的版本號', v_code, v_version
        using errcode = '42501', hint = 'issued';
    end if;
    v_id := v_existing.id;
    update public.questionnaire_template
    set name = v_name, layout = (p_def ->> 'layout')::public.template_layout, all_plants = v_all
    where id = v_id;
    delete from public.template_section where template_id = v_id;
  else
    -- 同一份新範本被兩個寫入同時建立時，後到的不丟原始的 unique 錯誤，而是請它重跑（重跑會走上面「取代草稿」）。
    insert into public.questionnaire_template (code, name, layout, version, status, all_plants)
    values (v_code, v_name, (p_def ->> 'layout')::public.template_layout, v_version, 'draft', v_all)
    on conflict (code, version) do nothing
    returning id into v_id;
    if v_id is null then
      raise exception '範本 % 版本 % 正好被另一個寫入同時建立，請重跑一次', v_code, v_version
        using errcode = '40001', hint = 'concurrent';
    end if;
  end if;

  perform public.replace_template_plants(
    v_id, v_all, array(select jsonb_array_elements_text(coalesce(p_def -> 'factoryCodes', '[]'::jsonb))));

  insert into public.assessing_unit (name)
  select distinct btrim(cp ->> 'assessingUnit')
  from jsonb_array_elements(p_def -> 'sections') sec, jsonb_array_elements(sec -> 'controlPoints') cp
  where coalesce(btrim(cp ->> 'assessingUnit'), '') <> ''
  on conflict (name) do nothing;

  with s as (
    insert into public.template_section (template_id, position, name)
    select v_id, t.ord, btrim(t.sec ->> 'name')
    from jsonb_array_elements(p_def -> 'sections') with ordinality as t(sec, ord)
    returning id, position
  )
  insert into public.control_point (section_id, position, text, assessing_unit_id)
  select s.id, cp.ord, btrim(cp.item ->> 'text'), au.id
  from jsonb_array_elements(p_def -> 'sections') with ordinality as t(sec, sord)
  join s on s.position = t.sord
  cross join lateral jsonb_array_elements(coalesce(t.sec -> 'controlPoints', '[]'::jsonb)) with ordinality as cp(item, ord)
  left join public.assessing_unit au on au.name = btrim(cp.item ->> 'assessingUnit');
  get diagnostics v_points = row_count;

  return jsonb_build_object(
    'ok', true, 'template_id', v_id, 'replaced', v_existing.id is not null,
    'sections', jsonb_array_length(p_def -> 'sections'), 'control_points', v_points);
end
$$;
comment on function public.draft_template(jsonb) is
  '草稿途徑：把一份問卷範本定義寫成草稿（同編號＋版本的草稿整份取代）；只給 csa_drafter (Q90)。';

-- 流程草稿 ---------------------------------------------------------------------------
-- 定義（簽核人是真實 OMS 工號，所以流程定義檔不進版控，見操作說明）：
--   { templateCode, templateVersion, factoryCode,
--     steps: [{ name, group: 'plant'|'audit_review', signer: OMS 工號, editableUnit?: 自評單位名稱 }] }
-- 每次呼叫都建一條新的草稿流程（不取代既有的流程：草稿可能是稽核管理者自己建的）。
-- 關卡的規則沿用 #11 的約束與觸發器：名稱、簽核人不可空白，稽核室覆核關卡只能唯讀，範本要適用該廠區。
-- 自評單位必須已在清單上（範本草稿會先建好），打錯的名稱不默默新增。
-- 回傳 {ok:true, route_id, steps}。
-- 錯誤：定義帶了草稿以外的 status 22023；沒有關卡 23514；範本、廠區、自評單位不存在 P0002。

create or replace function public.draft_route(p_def jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template  uuid;
  v_plant     uuid;
  v_route     uuid;
  v_unknown   text;
  v_steps     integer;
begin
  perform public.enter_draft_path();
  perform public.reject_non_draft_status(p_def);
  if jsonb_typeof(p_def -> 'steps') is distinct from 'array' or jsonb_array_length(p_def -> 'steps') = 0 then
    raise exception '簽核流程沒有關卡' using errcode = '23514';
  end if;

  select id into v_template from public.questionnaire_template
  where code = btrim(p_def ->> 'templateCode') and version = btrim(p_def ->> 'templateVersion');
  if v_template is null then
    raise exception '找不到範本 % 版本 %', p_def ->> 'templateCode', p_def ->> 'templateVersion' using errcode = 'P0002';
  end if;
  select id into v_plant from public.plant where factory_code = upper(btrim(p_def ->> 'factoryCode'));
  if v_plant is null then
    raise exception '找不到廠區 %', p_def ->> 'factoryCode' using errcode = 'P0002';
  end if;
  select st ->> 'editableUnit' into v_unknown
  from jsonb_array_elements(p_def -> 'steps') st
  where coalesce(btrim(st ->> 'editableUnit'), '') <> ''
    and not exists (select 1 from public.assessing_unit u where u.name = btrim(st ->> 'editableUnit'))
  limit 1;
  if v_unknown is not null then
    raise exception '自評單位清單上沒有「%」', v_unknown using errcode = 'P0002';
  end if;

  insert into public.approval_route (template_id, plant_id, status)
  values (v_template, v_plant, 'draft')
  returning id into v_route;

  insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id)
  select v_route, t.ord, btrim(t.st ->> 'name'), (t.st ->> 'group')::public.step_group, btrim(t.st ->> 'signer'), u.id
  from jsonb_array_elements(p_def -> 'steps') with ordinality as t(st, ord)
  left join public.assessing_unit u on u.name = btrim(t.st ->> 'editableUnit');
  get diagnostics v_steps = row_count;

  return jsonb_build_object('ok', true, 'route_id', v_route, 'steps', v_steps);
end
$$;
comment on function public.draft_route(jsonb) is
  '草稿途徑：把一條簽核流程定義寫成新的草稿流程；只給 csa_drafter (Q90)。';

-- 執行權限：草稿函式只給 csa_drafter；內部用的標記函式不開放。
revoke execute on function public.enter_draft_path() from public, anon, authenticated;
revoke execute on function public.reject_non_draft_status(jsonb) from public, anon, authenticated;
revoke execute on function public.draft_path_governing_status(text, jsonb) from public, anon, authenticated;
revoke execute on function public.draft_template(jsonb) from public, anon, authenticated;
revoke execute on function public.draft_route(jsonb) from public, anon, authenticated;
grant execute on function public.draft_template(jsonb) to csa_drafter;
grant execute on function public.draft_route(jsonb) to csa_drafter;
