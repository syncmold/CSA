-- 範本管理編輯 (工單 #10)：稽核管理者可以新增問卷範本、編輯抬頭與適用廠區、增刪改排章節與控制要點、
-- 維護集團共用的自評單位清單。用語依 GLOSSARY.md，實作決定見需求決策紀錄 Q83。
--
-- 寫入一律只給稽核管理者，規則都在這裡 (ADR-0001)：
--   範本抬頭   只能透過 create_template／update_template（抬頭與適用廠區同一個交易）；不開放刪除，停用即可，
--              因為自評表與簽核流程都參照它
--   版型       建立後不可更改：update_template 沒有這個參數，觸發器再擋其他所有身分（含 service_role）
--   自評單位   控制活動類的控制要點必填；要素類選填（紙本沒有這欄，但 #5 的可編輯範圍以自評單位決定誰作答，
--              所以要素類可以整份掛同一個自評單位，交給一個自行檢查人員答）
--   順序       位置只由資料庫決定：新增排到最後、刪除後重編成 1..n、拖曳排序走 reorder_* 函式；API 不能直接寫位置
-- 已被自評表引用的範本照樣可以改：自評表在發起時已凍結自己的快照 (ADR-0004)。
--
-- 寫位置、鎖上層列的函式是 security definer，因為稽核管理者沒有 position 欄與範本表的寫入權限；
-- 它們只動呼叫者這次新增、刪除或排序的那些列，並自己檢查稽核管理者。

-- 排序要一次搬動多列：唯一約束改成「整個陳述式結束才檢查」，否則互換位置的 update 中途就撞約束。
alter table public.template_section
  drop constraint template_section_template_id_position_key,
  add constraint template_section_template_id_position_key unique (template_id, position) deferrable initially immediate;
alter table public.control_point
  drop constraint control_point_section_id_position_key,
  add constraint control_point_section_id_position_key unique (section_id, position) deferrable initially immediate;

-- 版型不可更改 ------------------------------------------------------------------

create or replace function public.forbid_template_layout_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.layout is distinct from old.layout then
    raise exception '問卷範本的版型建立後不可更改（%）', old.code using errcode = '22023';
  end if;
  return new;
end
$$;

create trigger questionnaire_template_layout_fixed
  before update on public.questionnaire_template
  for each row execute function public.forbid_template_layout_change();

-- 自評單位依版型 ----------------------------------------------------------------
-- security definer：要讀上層章節與範本的版型，service_role 以外的呼叫者不一定讀得到它們。

create or replace function public.check_control_point_unit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assessing_unit_id is null and exists (
    select 1
    from public.template_section s
    join public.questionnaire_template t on t.id = s.template_id
    where s.id = new.section_id and t.layout = 'control_activity'
  ) then
    raise exception '控制活動類的控制要點必須指定自評單位' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger control_point_unit_matches_layout
  before insert or update of section_id, assessing_unit_id on public.control_point
  for each row execute function public.check_control_point_unit();

-- 順序：新增排最後、刪除後重編 ---------------------------------------------------
-- 新增時先鎖上層列，兩個同時新增的請求才不會算出同一個位置。不給位置才補（種子與測試準備會自己給）。

create or replace function public.append_template_section()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.position is null then
    perform 1 from public.questionnaire_template where id = new.template_id for update;
    select coalesce(max(position), 0) + 1 into new.position
    from public.template_section where template_id = new.template_id;
  end if;
  return new;
end
$$;

create trigger template_section_append
  before insert on public.template_section
  for each row execute function public.append_template_section();

create or replace function public.append_control_point()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.position is null then
    perform 1 from public.template_section where id = new.section_id for update;
    select coalesce(max(position), 0) + 1 into new.position
    from public.control_point where section_id = new.section_id;
  end if;
  return new;
end
$$;

create trigger control_point_append
  before insert on public.control_point
  for each row execute function public.append_control_point();

create or replace function public.renumber_template_sections()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.template_section s
  set position = r.rn
  from (
    select id, row_number() over (partition by template_id order by position) as rn
    from public.template_section
    where template_id in (select template_id from deleted_rows)
  ) r
  where s.id = r.id and s.position <> r.rn;
  return null;
end
$$;

create trigger template_section_renumber
  after delete on public.template_section
  referencing old table as deleted_rows
  for each statement execute function public.renumber_template_sections();

create or replace function public.renumber_control_points()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.control_point c
  set position = r.rn
  from (
    select id, row_number() over (partition by section_id order by position) as rn
    from public.control_point
    where section_id in (select section_id from deleted_rows)
  ) r
  where c.id = r.id and c.position <> r.rn;
  return null;
end
$$;

create trigger control_point_renumber
  after delete on public.control_point
  referencing old table as deleted_rows
  for each statement execute function public.renumber_control_points();

-- 章節、控制要點、自評單位：直接寫表，授權與 RLS --------------------------------
-- 刻意不含 position：位置只由上面的觸發器與 reorder_* 決定。範本抬頭與適用廠區沒有直接寫入授權，走下面的函式。

grant insert (template_id, name), update (name), delete on public.template_section to authenticated;
grant insert (section_id, text, assessing_unit_id), update (text, assessing_unit_id), delete on public.control_point to authenticated;
grant insert (name), update (name), delete on public.assessing_unit to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['template_section', 'control_point', 'assessing_unit']
  loop
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.is_audit_admin())',
      t || '_insert_audit_admin', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.is_audit_admin()) with check (public.is_audit_admin())',
      t || '_update_audit_admin', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_audit_admin())',
      t || '_delete_audit_admin', t);
  end loop;
end
$$;

-- 範本抬頭與適用廠區 -------------------------------------------------------------
-- 新增與編輯都是一個函式一個交易，抬頭存了廠區沒存的半套狀態不會發生。
-- 適用廠區：OMS 廠區代碼去空白、轉大寫、去重複、去掉空值；all_plants 為真時清空代碼清單。
-- 錯誤：不是稽核管理者 42501；編號、名稱、版本空白 23514；編號＋版本重複 23505；範本不存在 P0002。

create or replace function public.replace_template_plants(p_template_id uuid, p_all_plants boolean, p_factory_codes text[])
returns void
language sql
set search_path = public
as $$
  with codes as (
    select distinct upper(btrim(c)) as code
    from unnest(coalesce(p_factory_codes, '{}')) c
    where not p_all_plants and c is not null and btrim(c) <> ''
  ),
  removed as (
    delete from public.template_plant tp
    where tp.template_id = p_template_id and tp.factory_code not in (select code from codes)
  )
  insert into public.template_plant (template_id, factory_code)
  select p_template_id, code from codes
  on conflict do nothing
$$;
comment on function public.replace_template_plants(uuid, boolean, text[]) is
  '內部用：換掉一份範本的適用廠區代碼。只給 create_template／update_template 呼叫，不開放 API。';

create or replace function public.check_template_header(p_code text, p_name text, p_version text)
returns void
language plpgsql
set search_path = public
as $$
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can edit templates' using errcode = '42501';
  end if;
  if coalesce(btrim(p_code), '') = '' or coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_version), '') = '' then
    raise exception '問卷範本的編號、名稱、版本不可空白' using errcode = '23514';
  end if;
end
$$;
comment on function public.check_template_header(text, text, text) is '內部用：範本抬頭寫入前的共同檢查。';

create or replace function public.create_template(
  p_code           text,
  p_name           text,
  p_layout         public.template_layout,
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
  insert into public.questionnaire_template (code, name, layout, version, status, all_plants)
  values (btrim(p_code), btrim(p_name), p_layout, btrim(p_version), p_status, p_all_plants)
  returning id into v_id;
  perform public.replace_template_plants(v_id, p_all_plants, p_factory_codes);
  return v_id;
end
$$;
comment on function public.create_template(text, text, public.template_layout, text, public.template_status, boolean, text[]) is
  '稽核管理者新增問卷範本（版型選定後不可更改）與它的適用廠區；回傳範本 id。';

create or replace function public.update_template(
  p_template_id    uuid,
  p_code           text,
  p_name           text,
  p_version        text,
  p_status         public.template_status,
  p_all_plants     boolean,
  p_factory_codes  text[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.check_template_header(p_code, p_name, p_version);
  update public.questionnaire_template
  set code = btrim(p_code), name = btrim(p_name), version = btrim(p_version), status = p_status, all_plants = p_all_plants
  where id = p_template_id;
  if not found then
    raise exception 'template % not found', p_template_id using errcode = 'P0002';
  end if;
  perform public.replace_template_plants(p_template_id, p_all_plants, p_factory_codes);
end
$$;
comment on function public.update_template(uuid, text, text, text, public.template_status, boolean, text[]) is
  '稽核管理者修改問卷範本的編號、名稱、版本、狀態與適用廠區（沒有版型：建立後不可更改）。';

-- 排序 --------------------------------------------------------------------------
-- 拖曳排序送來的是排好後的完整 id 清單；不是剛好那一組（少了、多了、重複、別份範本的）就拒絕，
-- 以免畫面過期時把別的章節或控制要點排進來。

create or replace function public.reorder_template_sections(p_template_id uuid, p_section_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can reorder sections' using errcode = '42501';
  end if;
  if (select array_agg(id order by id) from public.template_section where template_id = p_template_id)
     is distinct from (select array_agg(x order by x) from unnest(p_section_ids) x) then
    raise exception 'p_section_ids must list every section of the template exactly once' using errcode = '22023';
  end if;
  update public.template_section s
  set position = o.ord
  from unnest(p_section_ids) with ordinality as o(id, ord)
  where s.id = o.id and s.position <> o.ord;
end
$$;
comment on function public.reorder_template_sections(uuid, uuid[]) is '稽核管理者重排一份範本的章節：依給的 id 順序編成 1..n。';

create or replace function public.reorder_control_points(p_section_id uuid, p_control_point_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can reorder control points' using errcode = '42501';
  end if;
  if (select array_agg(id order by id) from public.control_point where section_id = p_section_id)
     is distinct from (select array_agg(x order by x) from unnest(p_control_point_ids) x) then
    raise exception 'p_control_point_ids must list every control point of the section exactly once' using errcode = '22023';
  end if;
  update public.control_point c
  set position = o.ord
  from unnest(p_control_point_ids) with ordinality as o(id, ord)
  where c.id = o.id and c.position <> o.ord;
end
$$;
comment on function public.reorder_control_points(uuid, uuid[]) is '稽核管理者重排一個章節的控制要點：依給的 id 順序編成 1..n。';

-- 執行權限：預設會給 public／anon。開放給登入者的函式內仍檢查稽核管理者；內部用的兩支不開放。
revoke execute on function public.replace_template_plants(uuid, boolean, text[]) from public, anon, authenticated;
revoke execute on function public.check_template_header(text, text, text) from public, anon, authenticated;
revoke execute on function public.create_template(text, text, public.template_layout, text, public.template_status, boolean, text[]) from public, anon;
revoke execute on function public.update_template(uuid, text, text, text, public.template_status, boolean, text[]) from public, anon;
revoke execute on function public.reorder_template_sections(uuid, uuid[]) from public, anon;
revoke execute on function public.reorder_control_points(uuid, uuid[]) from public, anon;
grant execute on function public.create_template(text, text, public.template_layout, text, public.template_status, boolean, text[]) to authenticated;
grant execute on function public.update_template(uuid, text, text, text, public.template_status, boolean, text[]) to authenticated;
grant execute on function public.reorder_template_sections(uuid, uuid[]) to authenticated;
grant execute on function public.reorder_control_points(uuid, uuid[]) to authenticated;
