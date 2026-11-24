-- 稽核人員維護負責廠區的範本與簽核流程（Q144，修訂 Q136 (2)）。使用者 2026-11-19：
--   * 稽核人員看得到全部廠區的範本、自評單位、簽核流程（唯讀）；
--   * 他擔任廠區管理員的廠區（負責的廠區），範本與簽核流程能做稽核主管在這兩頁能做的全部動作：
--     新增、修改、刪除、啟用／停用範本，新增、修改、刪除流程；
--   * 自評單位清單全集團共用一份，他只能新增；改名、刪除仍只有稽核主管。
-- 年度發起、補發、作廢、權限管理不變，仍只有稽核主管與系統維護員。
--
-- 「負責廠區的範本」：適用廠區至少一個、不是全部廠區，而且每一個適用廠區都是他負責的。跨到別廠的範本他只能看：
-- 改它就改到別廠的題目。「負責廠區的流程」：流程的廠區是他負責的（流程一條只屬於一個廠區）。
-- 廠區端的人當廠區管理員（角色不是稽核人員）沒有這些：他只分派、換人（Q136 (3)）。
--
-- 做法同 20261115000000（可見集合）：每個查詢先算一次「我能改的範本／章節／流程」，policy 拿列的 id 去比，不逐列呼叫函式。

-- 判斷 -------------------------------------------------------------------------------------------------------

create function public.is_audit_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_audit_role() = 'audit_staff', false)
$$;
comment on function public.is_audit_staff() is '呼叫者的權限角色是稽核人員嗎（#187）。';
revoke execute on function public.is_audit_staff() from public, anon;
grant execute on function public.is_audit_staff() to authenticated;

create function public.can_read_settings()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_read_all() or public.is_audit_staff()
$$;
comment on function public.can_read_settings() is
  '呼叫者看得到全部廠區的範本、自評單位、內控依據與簽核流程嗎：稽核主管、系統維護員，以及稽核人員（Q144；他只能改負責的廠區）。'
  '和 can_read_all() 分開：稽核人員看不到別廠的自評表與答案。';
revoke execute on function public.can_read_settings() from public, anon;
grant execute on function public.can_read_settings() to authenticated;

create function public.my_staff_plant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select case when public.is_audit_staff()
    then coalesce((select array_agg(pc.plant_id) from public.plant_coordinator pc where pc.emp_id = public.current_emp_id()), '{}')
    else '{}'::uuid[]
  end
$$;
comment on function public.my_staff_plant_ids() is
  '呼叫者以稽核人員身分負責的廠區（他是稽核人員，而且是這些廠的廠區管理員）；不是稽核人員就是空的（Q144）。';
revoke execute on function public.my_staff_plant_ids() from public, anon;
grant execute on function public.my_staff_plant_ids() to authenticated;

create function public.my_editable_template_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select p.factory_code from public.plant p where p.id = any(public.my_staff_plant_ids())
  )
  select coalesce(array_agg(t.id), '{}')
  from public.questionnaire_template t
  where exists (select 1 from mine)
    and not t.all_plants
    and exists (select 1 from public.template_plant tp where tp.template_id = t.id)
    and not exists (
      select 1 from public.template_plant tp
      where tp.template_id = t.id and tp.factory_code not in (select factory_code from mine))
$$;
comment on function public.my_editable_template_ids() is
  '稽核人員能改的範本（Q144）：有適用廠區、不是全部廠區，而且每個適用廠區都是他負責的。稽核主管不看這裡（is_audit_admin）。';
revoke execute on function public.my_editable_template_ids() from public, anon;
grant execute on function public.my_editable_template_ids() to authenticated;

create function public.my_editable_section_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(s.id), '{}')
  from public.template_section s
  where s.template_id = any(public.my_editable_template_ids())
$$;
comment on function public.my_editable_section_ids() is '稽核人員能改的範本的章節（Q144）；刪控制要點的 policy 用。';
revoke execute on function public.my_editable_section_ids() from public, anon;
grant execute on function public.my_editable_section_ids() to authenticated;

create function public.my_editable_route_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(r.id), '{}')
  from public.approval_route r
  where r.plant_id = any(public.my_staff_plant_ids())
$$;
comment on function public.my_editable_route_ids() is '稽核人員能改的簽核流程（Q144）：流程的廠區是他負責的。稽核主管不看這裡（is_audit_admin）。';
revoke execute on function public.my_editable_route_ids() from public, anon;
grant execute on function public.my_editable_route_ids() to authenticated;

create function public.can_add_assessing_unit()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_audit_admin() or cardinality(public.my_staff_plant_ids()) > 0
$$;
comment on function public.can_add_assessing_unit() is
  '呼叫者能在自評單位清單新增單位嗎：稽核主管、系統維護員，以及有負責廠區的稽核人員（Q144：清單全集團共用，他只新增，不改名、不刪除）。';
revoke execute on function public.can_add_assessing_unit() from public, anon;
grant execute on function public.can_add_assessing_unit() to authenticated;

create function public.require_template_editor(p_template_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.is_audit_admin() or coalesce(p_template_id = any(public.my_editable_template_ids()), false)) then
    raise exception '只有稽核主管，或負責這份範本每個適用廠區的稽核人員能修改它'
      using errcode = '42501', hint = 'not_template_editor';
  end if;
end
$$;
comment on function public.require_template_editor(uuid) is '內部用：範本的寫入函式共用的身分檢查（Q144）。';
revoke execute on function public.require_template_editor(uuid) from public, anon, authenticated;

create function public.require_route_editor(p_route_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.is_audit_admin() or coalesce(p_route_id = any(public.my_editable_route_ids()), false)) then
    raise exception '只有稽核主管，或負責這個廠區的稽核人員能修改這條簽核流程'
      using errcode = '42501', hint = 'not_route_editor';
  end if;
end
$$;
comment on function public.require_route_editor(uuid) is '內部用：簽核流程的寫入函式共用的身分檢查（Q144）。';
revoke execute on function public.require_route_editor(uuid) from public, anon, authenticated;

-- 讀：稽核人員看得到全部廠區的設定 -----------------------------------------------------------------------------

alter policy questionnaire_template_select_audit_admin on public.questionnaire_template using ((select public.can_read_settings()));
alter policy template_plant_select_audit_admin on public.template_plant using ((select public.can_read_settings()));
alter policy template_section_select_audit_admin on public.template_section using ((select public.can_read_settings()));
alter policy control_point_select_audit_admin on public.control_point using ((select public.can_read_settings()));
alter policy control_point_unit_select_audit_admin on public.control_point_unit using ((select public.can_read_settings()));
alter policy assessing_unit_select_audit_admin on public.assessing_unit using ((select public.can_read_settings()));
alter policy approval_route_select_audit_admin on public.approval_route using ((select public.can_read_settings()));
alter policy route_step_select_audit_admin on public.route_step using ((select public.can_read_settings()));
alter policy control_document_select_audit_admin on public.control_document using ((select public.can_read_settings()));
alter policy control_document_version_select_audit_admin on public.control_document_version using ((select public.can_read_settings()));
alter policy control_clause_select_audit_admin on public.control_clause using ((select public.can_read_settings()));
alter policy control_reference_select_audit_admin on public.control_reference using ((select public.can_read_settings()));
alter policy section_control_document_select_audit_admin on public.section_control_document using ((select public.can_read_settings()));

-- 寫：直接寫表的部分（章節、刪控制要點、關卡、新增流程、新增自評單位） ---------------------------------------------

alter policy template_section_insert_audit_admin on public.template_section
  with check ((select public.is_audit_admin()) or template_id = any((select public.my_editable_template_ids())::uuid[]));
alter policy template_section_update_audit_admin on public.template_section
  using ((select public.is_audit_admin()) or template_id = any((select public.my_editable_template_ids())::uuid[]))
  with check ((select public.is_audit_admin()) or template_id = any((select public.my_editable_template_ids())::uuid[]));
alter policy template_section_delete_audit_admin on public.template_section
  using ((select public.is_audit_admin()) or template_id = any((select public.my_editable_template_ids())::uuid[]));

alter policy control_point_delete_audit_admin on public.control_point
  using ((select public.is_audit_admin()) or section_id = any((select public.my_editable_section_ids())::uuid[]));

alter policy route_step_update_audit_admin on public.route_step
  using ((select public.is_audit_admin()) or route_id = any((select public.my_editable_route_ids())::uuid[]))
  with check ((select public.is_audit_admin()) or route_id = any((select public.my_editable_route_ids())::uuid[]));
alter policy route_step_delete_audit_admin on public.route_step
  using ((select public.is_audit_admin()) or route_id = any((select public.my_editable_route_ids())::uuid[]));

-- 範本適不適用這個廠區仍由 approval_route_plant_applicable 擋。
alter policy approval_route_insert_audit_admin on public.approval_route
  with check ((select public.is_audit_admin()) or plant_id = any((select public.my_staff_plant_ids())::uuid[]));

-- 改名（update）、刪除（delete）的 policy 不動：仍只有稽核主管。
alter policy assessing_unit_insert_audit_admin on public.assessing_unit
  with check ((select public.can_add_assessing_unit()));

-- 寫：經函式的部分 ----------------------------------------------------------------------------------------------
-- 以下各函式與原本相同，只把「是不是稽核主管」換成 require_template_editor／require_route_editor。

-- 抬頭的共同檢查：先擋完全沒有資格的人（沒負責廠區的稽核人員、其他角色），是哪一份範本由呼叫的函式再檢查。
create or replace function public.check_template_header(p_code text, p_name text)
returns void
language plpgsql
set search_path = public
as $$
begin
  if not (public.is_audit_admin() or cardinality(public.my_staff_plant_ids()) > 0) then
    raise exception 'only a 稽核主管 or a 稽核人員 who runs a plant can edit templates' using errcode = '42501';
  end if;
  if coalesce(btrim(p_code), '') = '' or coalesce(btrim(p_name), '') = '' then
    raise exception '問卷範本的編號、名稱不可空白' using errcode = '23514';
  end if;
end
$$;

create or replace function public.create_template(
  p_code text,
  p_name text,
  p_component public.control_component,
  p_all_plants boolean default false,
  p_factory_codes text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.check_template_header(p_code, p_name);
  if p_component is null then
    raise exception '請選擇問卷範本的組成要素' using errcode = '23514', hint = 'component_required';
  end if;
  insert into public.questionnaire_template (code, name, layout, all_plants, component)
  values (
    btrim(p_code), btrim(p_name),
    case when p_component = 'control_activities' then 'control_activity' else 'element' end::public.template_layout,
    p_all_plants, p_component)
  returning id into v_id;
  perform public.replace_template_plants(v_id, p_all_plants, p_factory_codes);
  -- 稽核人員新增的範本只能適用他負責的廠區：寫好適用廠區再看，和修改用同一條規則。
  perform public.require_template_editor(v_id);
  return v_id;
end
$$;
comment on function public.create_template(text, text, public.control_component, boolean, text[]) is
  '新增問卷範本與它的適用廠區（新範本是啟用，Q137 (5)）；版型由組成要素決定（控制作業→控制活動類，其餘→要素類）；回傳範本 id。'
  '稽核主管，或稽核人員新增只適用他負責廠區的範本（Q144）。';

create or replace function public.update_template(
  p_template_id uuid,
  p_code text,
  p_name text,
  p_status public.template_status,
  p_all_plants boolean,
  p_factory_codes text[] default '{}',
  p_component public.control_component default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_layout public.template_layout;
begin
  perform public.check_template_header(p_code, p_name);
  perform public.require_template_editor(p_template_id);
  select layout into v_layout from public.questionnaire_template where id = p_template_id for update;
  if not found then
    raise exception 'template % not found', p_template_id using errcode = 'P0002';
  end if;
  if p_component is not null and (v_layout = 'control_activity') <> (p_component = 'control_activities') then
    raise exception '範本 % 的組成要素不能在控制作業與其他組成要素之間改：兩者的答題欄位不同', btrim(p_code)
      using errcode = '23514', hint = 'component_layout';
  end if;
  update public.questionnaire_template
  set code = btrim(p_code), name = btrim(p_name), status = p_status, all_plants = p_all_plants,
      component = coalesce(p_component, component)
  where id = p_template_id;
  perform public.replace_template_plants(p_template_id, p_all_plants, p_factory_codes);
  -- 改完的適用廠區也要都是他負責的：稽核人員不能把範本加到別廠或改成全部廠區。
  perform public.require_template_editor(p_template_id);
end
$$;
comment on function public.update_template(uuid, text, text, public.template_status, boolean, text[], public.control_component) is
  '修改問卷範本的編號、名稱、狀態（啟用／停用）、適用廠區與組成要素（沒有版型：建立後不可更改）。'
  '稽核主管，或負責這份範本每個適用廠區的稽核人員；他改完的適用廠區也只能是負責的廠區（Q144）。';

create or replace function public.delete_template(p_template_id uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template public.questionnaire_template;
begin
  perform public.require_template_editor(p_template_id);

  -- 鎖住範本列：同時進行的年度發起或新增流程要等這裡結束，不會在檢查之後才參照它。
  select * into v_template from public.questionnaire_template where id = p_template_id for update;
  if not found then
    raise exception 'template % not found', p_template_id using errcode = 'P0002';
  end if;
  if btrim(coalesce(p_code, '')) <> v_template.code then
    raise exception '確認的編號與問卷範本的編號（%）不符', v_template.code using errcode = '22023';
  end if;

  if public.in_use(v_template) then
    raise exception '問卷範本 % 已被自評表或簽核流程使用，不能刪除，請改用停用', v_template.code using errcode = '23503';
  end if;

  begin
    delete from public.questionnaire_template where id = p_template_id;
  exception when foreign_key_violation then
    raise exception '問卷範本 % 已被其他資料使用，不能刪除，請改用停用', v_template.code using errcode = '23503';
  end;
end
$$;
comment on function public.delete_template(uuid, text) is
  '刪除從未使用過（沒有自評表、沒有簽核流程）的問卷範本，連同章節、控制要點與適用廠區；p_code 為確認用的範本編號。'
  '稽核主管，或負責這份範本每個適用廠區的稽核人員（Q144）。';

create or replace function public.reorder_template_sections(p_template_id uuid, p_section_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_template_editor(p_template_id);
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

create or replace function public.create_control_point(
  p_section_id uuid,
  p_text text,
  p_unit_ids uuid[] default '{}',
  p_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.require_template_editor((select template_id from public.template_section where id = p_section_id));
  if not exists (select 1 from public.template_section where id = p_section_id) then
    raise exception 'section % not found', p_section_id using errcode = 'P0002';
  end if;
  insert into public.control_point (section_id, text, code)
  values (p_section_id, btrim(p_text), nullif(btrim(p_code), ''))
  returning id into v_id;
  perform public.replace_control_point_units(v_id, p_unit_ids);
  return v_id;
end
$$;

create or replace function public.update_control_point(
  p_control_point_id uuid,
  p_text text,
  p_unit_ids uuid[] default '{}',
  p_code text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_template_editor((
    select s.template_id
    from public.control_point c join public.template_section s on s.id = c.section_id
    where c.id = p_control_point_id));
  update public.control_point set text = btrim(p_text), code = nullif(btrim(p_code), '') where id = p_control_point_id;
  if not found then
    raise exception 'control point % not found', p_control_point_id using errcode = 'P0002';
  end if;
  perform public.replace_control_point_units(p_control_point_id, p_unit_ids);
end
$$;

create or replace function public.reorder_control_points(p_section_id uuid, p_control_point_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_template_editor((select template_id from public.template_section where id = p_section_id));
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

create or replace function public.delete_route(p_route_id uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  perform public.require_route_editor(p_route_id);
  select t.code into v_code
  from public.approval_route r join public.questionnaire_template t on t.id = r.template_id
  where r.id = p_route_id
  for update of r;
  if not found then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
  if btrim(coalesce(p_code, '')) <> v_code then
    raise exception '確認的編號與簽核流程的範本編號（%）不符', v_code using errcode = '22023';
  end if;
  delete from public.approval_route where id = p_route_id;
end
$$;
comment on function public.delete_route(uuid, text) is
  '刪除一條簽核流程連同關卡（自評表不參照流程，已發出的不受影響）；p_code 為確認用的範本編號（畫面要親手輸入「刪除 ＜編號＞」）。'
  '稽核主管，或負責這個廠區的稽核人員（Q144）。';

create or replace function public.add_route_branch(p_route_id uuid, p_unit_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit    text;
  v_before  integer;
begin
  perform public.require_route_editor(p_route_id);
  perform 1 from public.approval_route where id = p_route_id for update;
  if not found then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
  select name into v_unit from public.assessing_unit where id = p_unit_id;
  if v_unit is null then
    raise exception 'assessing unit % not found', p_unit_id using errcode = 'P0002';
  end if;
  if exists (select 1 from public.route_step where route_id = p_route_id and editable_unit_id = p_unit_id) then
    raise exception '「%」已經有分流', v_unit using errcode = '23505', hint = 'branch_exists';
  end if;
  select min(position) into v_before from public.route_step where route_id = p_route_id and branch_unit_id is null;
  perform public.insert_route_step(p_route_id, '自行檢查人員－' || v_unit, 'plant', null, p_unit_id, v_before, p_unit_id);
  perform public.insert_route_step(p_route_id, '部門主管－' || v_unit, 'plant', null, null, v_before + 1, p_unit_id);
end
$$;

create or replace function public.insert_route_step(
  p_route_id uuid,
  p_name text,
  p_step_group public.step_group,
  p_signer_emp_id text,
  p_editable_unit_id uuid default null,
  p_before_position integer default null,
  p_branch_unit_id uuid default null,
  p_link text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count  integer;
  v_id     uuid;
  v_link   text := nullif(btrim(p_link), '');
begin
  perform public.require_route_editor(p_route_id);
  perform 1 from public.approval_route where id = p_route_id for update;
  if not found then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
  if v_link is not null and exists (select 1 from public.route_step where route_id = p_route_id and link = v_link) then
    raise exception '這條流程已經有這個連動關卡' using errcode = '23505', hint = 'link_exists';
  end if;
  select count(*) into v_count from public.route_step where route_id = p_route_id;
  if p_before_position is not null and (p_before_position < 1 or p_before_position > v_count) then
    raise exception 'p_before_position must be between 1 and %', v_count using errcode = '22023';
  end if;
  if p_before_position is not null then
    update public.route_step set position = position + 1
    where route_id = p_route_id and position >= p_before_position;
  end if;
  insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id, branch_unit_id, link)
  values (p_route_id, p_before_position, btrim(p_name), p_step_group, nullif(btrim(p_signer_emp_id), ''), p_editable_unit_id, p_branch_unit_id, v_link)
  returning id into v_id;
  return v_id;
end
$$;

create or replace function public.reorder_route_steps(p_route_id uuid, p_step_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_route_editor(p_route_id);
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
