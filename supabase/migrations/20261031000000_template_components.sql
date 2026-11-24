-- 範本的組成要素 (工單 #62)：範本管理與簽核流程兩頁依《公開發行公司建立內部控制制度處理準則》第 6 條
-- 的五大組成要素分組。用語依 GLOSSARY.md，實作決定見需求決策紀錄 Q101。
--
--   控制活動類  一律是「控制作業」（觸發器填入，傳別的也照樣改成控制作業）
--   要素類      其餘四類擇一，由稽核管理者在範本抬頭選；沒給的話依編號 A–D 推定（A 控制環境、B 風險評估、
--               C 資訊與溝通、D 監督作業），推不出來就留空，畫面上列為「未分類」等稽核管理者補
-- 不走範本管理畫面的寫入（草稿途徑 Q90、轉檔種子、測試）不用改，照樣得到組成要素。
-- 組成要素只影響管理畫面的分組，不進自評表快照 (ADR-0004)。

create type public.control_component as enum (
  'control_environment', 'risk_assessment', 'control_activities', 'information_communication', 'monitoring'
);
comment on type public.control_component is
  '內部控制制度的組成要素（處理準則第 6 條），列舉順序即準則順序：控制環境、風險評估、控制作業、資訊與溝通、監督作業。';

alter table public.questionnaire_template add column component public.control_component;
comment on column public.questionnaire_template.component is
  '組成要素：控制活動類一律 control_activities；要素類為其餘四類之一，空值＝未分類。';

-- 依編號推定要素類的組成要素：只看開頭的 A–D（後面不能緊接英文字母，免得把 AB 之類的編號當成 A）。
create or replace function public.component_from_code(p_code text)
returns public.control_component
language sql
immutable
set search_path = public
as $$
  select case substring(upper(btrim(p_code)) from '^([A-D])([^A-Z]|$)')
    when 'A' then 'control_environment'::public.control_component
    when 'B' then 'risk_assessment'
    when 'C' then 'information_communication'
    when 'D' then 'monitoring'
  end
$$;
comment on function public.component_from_code(text) is '內部用：要素類沒指定組成要素時，依編號 A–D 推定；推不出來回 null。';

update public.questionnaire_template
set component = case when layout = 'control_activity' then 'control_activities' else public.component_from_code(code) end;

create or replace function public.fill_template_component()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.layout = 'control_activity' then
    new.component := 'control_activities';
  elsif new.component is null then
    new.component := public.component_from_code(new.code);
  end if;
  return new;
end
$$;
comment on function public.fill_template_component() is '內部用：新增範本時補組成要素（控制活動類固定控制作業；要素類沒給就依編號推定）。';

create trigger questionnaire_template_fill_component
  before insert on public.questionnaire_template
  for each row execute function public.fill_template_component();

-- 版型建立後不可更改（Q83），所以「控制活動類 ⇔ 控制作業」只要擋要素類被設成控制作業。
alter table public.questionnaire_template
  add constraint questionnaire_template_component_matches_layout
  check ((layout = 'control_activity') = (component is not distinct from 'control_activities'));

-- 範本抬頭的寫入函式多一個組成要素參數；換參數就是換函式，舊的先拿掉，免得 PostgREST 遇到兩個同名函式。
drop function public.create_template(text, text, public.template_layout, text, public.template_status, boolean, text[]);
drop function public.update_template(uuid, text, text, text, public.template_status, boolean, text[]);

create function public.create_template(
  p_code           text,
  p_name           text,
  p_layout         public.template_layout,
  p_version        text,
  p_status         public.template_status default 'draft',
  p_all_plants     boolean default false,
  p_factory_codes  text[] default '{}',
  p_component      public.control_component default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.check_template_header(p_code, p_name, p_version);
  insert into public.questionnaire_template (code, name, layout, version, status, all_plants, component)
  values (btrim(p_code), btrim(p_name), p_layout, btrim(p_version), p_status, p_all_plants, p_component)
  returning id into v_id;
  perform public.replace_template_plants(v_id, p_all_plants, p_factory_codes);
  return v_id;
end
$$;
comment on function public.create_template(text, text, public.template_layout, text, public.template_status, boolean, text[], public.control_component) is
  '稽核管理者新增問卷範本（版型選定後不可更改）與它的適用廠區；組成要素控制活動類自動、要素類沒給就依編號推定；回傳範本 id。';

create function public.update_template(
  p_template_id    uuid,
  p_code           text,
  p_name           text,
  p_version        text,
  p_status         public.template_status,
  p_all_plants     boolean,
  p_factory_codes  text[] default '{}',
  p_component      public.control_component default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.check_template_header(p_code, p_name, p_version);
  update public.questionnaire_template
  set code = btrim(p_code), name = btrim(p_name), version = btrim(p_version), status = p_status, all_plants = p_all_plants,
      -- 控制活動類固定控制作業；要素類沒給就不動。
      component = case when layout = 'control_activity' then component else coalesce(p_component, component) end
  where id = p_template_id;
  if not found then
    raise exception 'template % not found', p_template_id using errcode = 'P0002';
  end if;
  perform public.replace_template_plants(p_template_id, p_all_plants, p_factory_codes);
end
$$;
comment on function public.update_template(uuid, text, text, text, public.template_status, boolean, text[], public.control_component) is
  '稽核管理者修改問卷範本的編號、名稱、版本、狀態、適用廠區與組成要素（沒有版型：建立後不可更改）。';

revoke execute on function public.component_from_code(text) from public, anon;
revoke execute on function public.create_template(text, text, public.template_layout, text, public.template_status, boolean, text[], public.control_component) from public, anon;
revoke execute on function public.update_template(uuid, text, text, text, public.template_status, boolean, text[], public.control_component) from public, anon;
grant execute on function public.create_template(text, text, public.template_layout, text, public.template_status, boolean, text[], public.control_component) to authenticated;
grant execute on function public.update_template(uuid, text, text, text, public.template_status, boolean, text[], public.control_component) to authenticated;
