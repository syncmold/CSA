-- 組成要素的 code review 後續 (工單 #62／#64 review，需求決策紀錄 Q101(5)–(7))：
--
--   版型由組成要素決定  規則搬進資料庫 (ADR-0001)：create_template 不再收版型，由組成要素推出
--                       （控制作業→控制活動類，其餘→要素類）；update_template 想在控制作業與其他四類之間改，
--                       明確拒絕並說明原因，不再默默忽略
--   草稿途徑            定義檔可以帶 component；沒帶照舊（控制活動類自動、要素類依編號 A–D 推定）
--   訊息                畫面與草稿途徑看得到的訊息不再用「版型」「要素類」「控制活動類」（不是正式名稱），
--                       改說「控制作業」「控制作業以外的組成要素」

-- 範本抬頭 ------------------------------------------------------------------------

drop function public.create_template(text, text, public.template_layout, text, public.template_status, boolean, text[], public.control_component);

create function public.create_template(
  p_code           text,
  p_name           text,
  p_component      public.control_component,
  p_version        text,
  p_status         public.template_status default 'draft',
  p_all_plants     boolean default false,
  p_factory_codes  text[] default '{}'
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
  if p_component is null then
    raise exception '請選擇問卷範本的組成要素' using errcode = '23514', hint = 'component_required';
  end if;
  insert into public.questionnaire_template (code, name, layout, version, status, all_plants, component)
  values (
    btrim(p_code), btrim(p_name),
    case when p_component = 'control_activities' then 'control_activity' else 'element' end::public.template_layout,
    btrim(p_version), p_status, p_all_plants, p_component)
  returning id into v_id;
  perform public.replace_template_plants(v_id, p_all_plants, p_factory_codes);
  return v_id;
end
$$;
comment on function public.create_template(text, text, public.control_component, text, public.template_status, boolean, text[]) is
  '稽核管理者新增問卷範本與它的適用廠區；版型由組成要素決定（控制作業→控制活動類，其餘→要素類）；回傳範本 id。';

create or replace function public.update_template(
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
declare
  v_layout public.template_layout;
begin
  perform public.check_template_header(p_code, p_name, p_version);
  select layout into v_layout from public.questionnaire_template where id = p_template_id for update;
  if not found then
    raise exception 'template % not found', p_template_id using errcode = 'P0002';
  end if;
  if p_component is not null and (v_layout = 'control_activity') <> (p_component = 'control_activities') then
    raise exception '範本 % 的組成要素不能在控制作業與其他組成要素之間改：兩者的答題欄位不同', btrim(p_code)
      using errcode = '23514', hint = 'component_layout';
  end if;
  update public.questionnaire_template
  set code = btrim(p_code), name = btrim(p_name), version = btrim(p_version), status = p_status, all_plants = p_all_plants,
      component = coalesce(p_component, component)
  where id = p_template_id;
  perform public.replace_template_plants(p_template_id, p_all_plants, p_factory_codes);
end
$$;

revoke execute on function public.create_template(text, text, public.control_component, text, public.template_status, boolean, text[]) from public, anon;
grant execute on function public.create_template(text, text, public.control_component, text, public.template_status, boolean, text[]) to authenticated;

-- 訊息改用正式說法（函式內容不變，只換文字） ------------------------------------------

create or replace function public.forbid_template_layout_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.layout is distinct from old.layout then
    raise exception '問卷範本 % 不能在控制作業與其他組成要素之間改：兩者的答題欄位不同', old.code using errcode = '22023';
  end if;
  return new;
end
$$;

create or replace function public.check_control_point_has_unit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_point uuid;
begin
  -- 用 if 而不是 case：兩張表的欄位不同，case 會把每個分支都解析一次。
  if tg_table_name = 'control_point' then
    v_point := new.id;
  else
    v_point := old.control_point_id;
  end if;
  if exists (
    select 1
    from public.control_point cp
    join public.template_section s on s.id = cp.section_id
    join public.questionnaire_template t on t.id = s.template_id
    where cp.id = v_point and t.layout = 'control_activity'
      and not exists (select 1 from public.control_point_unit u where u.control_point_id = cp.id)
  ) then
    raise exception '控制作業的控制要點至少要有一個自評單位' using errcode = '23514';
  end if;
  return null;
end
$$;

create or replace function public.check_answer_layout()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select template_layout from public.assessment where id = new.assessment_id) = 'element'
     and (new.design is not null or new.execution = 'no_case') then
    raise exception '控制作業以外的組成要素沒有內控設計，執行情形只有是／否／不適用' using errcode = '23514';
  end if;
  return new;
end
$$;

-- 草稿途徑：定義檔可以帶 component ----------------------------------------------------
-- 原本的 draft_template 改名成 draft_template_contents（只給這裡呼叫），外面包一層先檢查 component、寫完再設定。

alter function public.draft_template(jsonb) rename to draft_template_contents;
revoke execute on function public.draft_template_contents(jsonb) from public, anon, authenticated, csa_drafter;
comment on function public.draft_template_contents(jsonb) is '內部用：draft_template 寫入範本內容的部分（組成要素以外的一切）。';

create function public.draft_template(p_def jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code       text := btrim(p_def ->> 'code');
  v_component  text := nullif(btrim(p_def ->> 'component'), '');
  v_result     jsonb;
begin
  if v_component is not null then
    if v_component <> all (enum_range(null::public.control_component)::text[]) then
      raise exception '範本 % 的 component「%」不是組成要素；請用 %', v_code, v_component,
        array_to_string(enum_range(null::public.control_component)::text[], '、')
        using errcode = '22023', hint = 'component_value';
    end if;
    if (p_def ->> 'layout' = 'control_activity') <> (v_component = 'control_activities') then
      raise exception '範本 % 的 component「%」和 layout「%」對不上：控制作業一定是 control_activity，其他組成要素一定是 element',
        v_code, v_component, p_def ->> 'layout'
        using errcode = '23514', hint = 'component_layout';
    end if;
  end if;

  v_result := public.draft_template_contents(p_def);
  if v_component is not null then
    update public.questionnaire_template set component = v_component::public.control_component
    where id = (v_result ->> 'template_id')::uuid;
  end if;
  return v_result;
end
$$;
comment on function public.draft_template(jsonb) is
  '草稿途徑：把一份問卷範本定義寫成草稿（同編號＋版本的草稿整份取代）；可帶 component 指定組成要素；只給 csa_drafter (Q90、Q101)。';

revoke execute on function public.draft_template(jsonb) from public, anon, authenticated;
grant execute on function public.draft_template(jsonb) to csa_drafter;
