-- 內控文件、條文與內控依據（工單 #9）。用語依 GLOSSARY.md，實作決定見需求決策紀錄 Q94。
--
--   內控文件   廠區的作業程序文件（如福清 FQQP-PR01 供應商管理作業），簡碼 PR01；有版本（文件改廢履歷表的版次）。
--   條文       一個版本裡第 5 節作業內容、第 6 節控制重點的每一條（Q39），條號＋原文；永遠顯示原文、不翻譯。
--   內控依據   範本的「控制要點 × 廠區 → 條文」，可一對多（Q34、Q39）；章節另記本章依據的內控文件版本（Q40）。
--   快照       發起時連同條文原文複製進自評表（Q36、ADR-0004），之後文件改版、依據改指新版都不影響已發出的自評表。
-- 這些主檔目前只由種子 migration 寫入（scripts/controls/convert.mjs 產生）；API 沒有任何寫入授權，稽核管理者讀得到。
-- 轉成的 PDF 不進資料庫、也不進版控：版本只記檔名，放在本機設定的資料夾（CSA_CONTROL_DOC_DIR），由網站以
-- /csa/control-docs/<檔名> 提供給答題頁的側邊欄。

-- 內控文件、版本與條文 ---------------------------------------------------------------

create table public.control_document (
  id          uuid primary key default gen_random_uuid(),
  plant_id    uuid not null references public.plant (id),
  -- 文件編號（FQQP-PR01）與簡碼（PR01）：畫面與 PDF 印簡碼，同一廠區不重複。
  number      text not null check (number <> ''),
  code        text not null check (code <> ''),
  name        text not null check (name <> ''),
  created_at  timestamptz not null default now(),
  unique (plant_id, number),
  unique (plant_id, code)
);
comment on table public.control_document is '內控文件：廠區的作業程序文件，如福清 FQQP-PR01 供應商管理作業（簡碼 PR01）。';

create table public.control_document_version (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.control_document (id) on delete cascade,
  version         text not null check (version <> ''),
  effective_date  date not null,
  -- 轉成的 PDF 在本機設定資料夾裡的檔名（不含路徑）；沒有 PDF 時為空值，側邊欄就說沒有。
  pdf_file        text check (pdf_file is null or pdf_file ~ '^[^/\\]+\.pdf$'),
  unique (document_id, version)
);
comment on table public.control_document_version is '內控文件的一個版本（文件改廢履歷表的版次與實施日期），條文掛在版本底下。';

create table public.control_clause (
  id          uuid primary key default gen_random_uuid(),
  version_id  uuid not null references public.control_document_version (id) on delete cascade,
  position    integer not null check (position > 0),
  number      text not null check (number ~ '^\d+(\.\d+)*$'),
  text        text not null,
  unique (version_id, number),
  unique (version_id, position)
);
comment on table public.control_clause is '條文：內控文件一個版本裡的一條（條號＋原文），依文件順序；子條文以條號區分（5.1.1 屬於 5.1）。';

-- 內控依據 -----------------------------------------------------------------------------
-- 參照條文與版本的外鍵不 cascade：還有內控依據指著的版本刪不掉，要先改指新版。

create table public.control_reference (
  control_point_id  uuid not null references public.control_point (id) on delete cascade,
  plant_id          uuid not null references public.plant (id) on delete cascade,
  position          integer not null check (position > 0),
  clause_id         uuid not null references public.control_clause (id),
  primary key (control_point_id, plant_id, clause_id),
  unique (control_point_id, plant_id, position)
);
create index control_reference_clause_idx on public.control_reference (clause_id);
create index control_reference_plant_idx on public.control_reference (plant_id);
comment on table public.control_reference is
  '內控依據：範本的控制要點在某廠區對到的條文，依顯示順序；沒有對應條文的控制要點沒有列（畫面留白，Q41）。';

create table public.section_control_document (
  section_id  uuid not null references public.template_section (id) on delete cascade,
  plant_id    uuid not null references public.plant (id) on delete cascade,
  position    integer not null check (position > 0),
  version_id  uuid not null references public.control_document_version (id),
  primary key (section_id, plant_id, version_id),
  unique (section_id, plant_id, position)
);
create index section_control_document_version_idx on public.section_control_document (version_id);
create index section_control_document_plant_idx on public.section_control_document (plant_id);
comment on table public.section_control_document is '本章依據：範本的章節在某廠區依據的內控文件版本（Q40），章節標題旁顯示。';

-- 依據只能指向同一廠區的內控文件：內控依據與本章依據都帶廠區，條文與版本也屬於某廠區的文件，兩者要一致，
-- 否則一個廠區的自評表會凍結進別廠的條文。所有身分都擋（含 service_role 與種子），回 23514。
create or replace function public.check_reference_plant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plant uuid;
begin
  if tg_table_name = 'control_reference' then
    select d.plant_id into v_plant
    from public.control_clause c
    join public.control_document_version v on v.id = c.version_id
    join public.control_document d on d.id = v.document_id
    where c.id = new.clause_id;
  else
    select d.plant_id into v_plant
    from public.control_document_version v
    join public.control_document d on d.id = v.document_id
    where v.id = new.version_id;
  end if;
  if v_plant is distinct from new.plant_id then
    raise exception '內控依據只能指向同一廠區的內控文件' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger control_reference_same_plant
  before insert or update on public.control_reference
  for each row execute function public.check_reference_plant();
create trigger section_control_document_same_plant
  before insert or update on public.section_control_document
  for each row execute function public.check_reference_plant();

-- 條文連同子條文 ---------------------------------------------------------------------------
-- 依據指到「5.2」時，展開的原文要連同 5.2.1、5.2.2…，一條一行、前面是條號；5.20 不是 5.2 的子條文。

create or replace function public.clause_text_with_subclauses(p_clause_id uuid)
returns text
language sql
stable
set search_path = public
as $$
  select string_agg(sub.number || ' ' || sub.text, E'\n' order by sub.position)
  from public.control_clause c
  join public.control_clause sub
    on sub.version_id = c.version_id and (sub.number = c.number or sub.number like c.number || '.%')
  where c.id = p_clause_id
$$;
comment on function public.clause_text_with_subclauses(uuid) is '一條條文連同它的子條文，一條一行（條號＋原文），依文件順序。';
revoke execute on function public.clause_text_with_subclauses(uuid) from public, anon, authenticated;

-- 快照 ---------------------------------------------------------------------------------------
-- 和其他快照表一樣只在發起時寫入：沒有任何 API 寫入授權，看得到自評表的人都讀得到。文件資訊與條文原文都存複本，
-- 不參照主檔（ADR-0004），所以主檔改版、刪除、改指都不影響已發出的自評表。

alter table public.assessment_section
  add constraint assessment_section_assessment_id_id_key unique (assessment_id, id);

create table public.assessment_section_document (
  assessment_id     uuid not null,
  section_id        uuid not null,
  position          integer not null check (position > 0),
  document_number   text not null,
  document_code     text not null,
  document_name     text not null,
  document_version  text not null,
  pdf_file          text,
  primary key (section_id, position),
  foreign key (assessment_id, section_id) references public.assessment_section (assessment_id, id) on delete cascade
);
create index assessment_section_document_assessment_idx on public.assessment_section_document (assessment_id);
comment on table public.assessment_section_document is '自評表章節的本章依據快照：發起時的內控文件與版本。';

create table public.assessment_control_reference (
  assessment_id     uuid not null,
  control_point_id  uuid not null,
  position          integer not null check (position > 0),
  document_number   text not null,
  document_code     text not null,
  document_name     text not null,
  document_version  text not null,
  pdf_file          text,
  clause_number     text not null,
  -- 條文連同子條文的原文（clause_text_with_subclauses），一條一行。
  clause_text       text not null,
  primary key (control_point_id, position),
  foreign key (assessment_id, control_point_id) references public.assessment_control_point (assessment_id, id) on delete cascade
);
create index assessment_control_reference_assessment_idx on public.assessment_control_reference (assessment_id);
comment on table public.assessment_control_reference is '自評表控制要點的內控依據快照：發起時的條文原文與文件版本，依顯示順序。';

-- 用過的版本只增不刪（2026-10-20 使用者決定）：自評表凍結過的版本，就算已經沒有內控依據指著它，也不能刪
-- （連帶刪整份文件也不行），因為已發出的自評表還要能從側邊欄開那一版的 PDF。快照只存文件編號與版次的複本，
-- 所以這裡依「廠區 × 文件編號 × 版次」去找。所有身分都擋，回 23503（和外鍵擋下的一樣）。
create or replace function public.document_version_frozen(p_plant_id uuid, p_number text, p_version text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.assessment a
    where a.plant_id = p_plant_id
      and (
        exists (select 1 from public.assessment_control_reference r
                where r.assessment_id = a.id and r.document_number = p_number
                  and (p_version is null or r.document_version = p_version))
        or exists (select 1 from public.assessment_section_document s
                   where s.assessment_id = a.id and s.document_number = p_number
                     and (p_version is null or s.document_version = p_version))
      )
  )
$$;
comment on function public.document_version_frozen(uuid, text, text) is
  '這個廠區的內控文件（某一版；版次空值＝任何一版）是否已凍結進某張自評表。';
revoke execute on function public.document_version_frozen(uuid, text, text) from public, anon, authenticated;

-- 刪整份文件時版本是連帶刪除，那時文件列已不在，所以文件與版本各擋一次。
create or replace function public.forbid_deleting_frozen_document()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.control_document;
begin
  if tg_table_name = 'control_document' then
    if public.document_version_frozen(old.plant_id, old.number, null) then
      raise exception '內控文件 % 已被自評表使用，不能刪除', old.number using errcode = '23503';
    end if;
  else
    select * into d from public.control_document where id = old.document_id;
    if d.id is not null and public.document_version_frozen(d.plant_id, d.number, old.version) then
      raise exception '內控文件 % 第 % 版已被自評表使用，不能刪除', d.number, old.version using errcode = '23503';
    end if;
  end if;
  return old;
end
$$;

create trigger control_document_keep_frozen
  before delete on public.control_document
  for each row execute function public.forbid_deleting_frozen_document();
create trigger control_document_version_keep_frozen
  before delete on public.control_document_version
  for each row execute function public.forbid_deleting_frozen_document();

-- 誰讀得到什麼 ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  -- 主檔與範本的內控依據：和範本、流程一樣只給稽核管理者讀（簽核人看的是自評表裡的快照）。
  foreach t in array array['control_document', 'control_document_version', 'control_clause', 'control_reference', 'section_control_document']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_audit_admin())',
      t || '_select_audit_admin', t);
  end loop;

  foreach t in array array['assessment_section_document', 'assessment_control_reference']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.can_view_assessment(assessment_id))',
      t || '_select_visible', t);
  end loop;

  foreach t in array array[
    'control_document', 'control_document_version', 'control_clause', 'control_reference', 'section_control_document',
    'assessment_section_document', 'assessment_control_reference'
  ]
  loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('revoke insert, update, delete on public.%I from authenticated, anon', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end
$$;

-- 年度發起（Q89）：快照多複製本章依據與內控依據（只取該廠區的）；其餘與 20261025000000_multi_unit_control_points 相同。
create or replace function public.launch_annual_cycle(
  p_year      integer,
  p_due_date  date,
  p_combos    jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_selected jsonb;
  v_invalid  jsonb;
  v_missing  jsonb;
  v_cycle    uuid;
  v_new      uuid;
  v_count    integer := 0;
  r          record;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can launch an annual cycle' using errcode = '42501';
  end if;

  if exists (select 1 from public.annual_cycle where year = p_year) then
    return jsonb_build_object('ok', false, 'error', 'cycle_exists');
  end if;

  if p_combos is not null then
    if jsonb_typeof(p_combos) <> 'array' then
      return jsonb_build_object('ok', false, 'error', 'invalid_combo', 'invalid', jsonb_build_array(p_combos));
    end if;
    select jsonb_agg(e) into v_invalid
    from jsonb_array_elements(p_combos) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'template_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(e ->> 'plant_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    if v_invalid is not null then
      return jsonb_build_object('ok', false, 'error', 'invalid_combo', 'invalid', v_invalid);
    end if;
  end if;

  perform 1
  from public.questionnaire_template t
  where t.status = 'active'
    and (p_combos is null or exists (select 1 from jsonb_array_elements(p_combos) e where (e ->> 'template_id')::uuid = t.id))
  order by t.id
  for share;

  perform 1
  from public.approval_route ar
  where ar.status = 'active'
    and (
      p_combos is null
      or exists (
        select 1 from jsonb_array_elements(p_combos) e
        where (e ->> 'template_id')::uuid = ar.template_id and (e ->> 'plant_id')::uuid = ar.plant_id
      )
    )
  order by ar.id
  for share;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.template_code, c.factory_code), '[]'::jsonb)
  into v_selected
  from public.launch_candidates() c
  where p_combos is null
     or exists (
       select 1 from jsonb_array_elements(p_combos) e
       where (e ->> 'template_id')::uuid = c.template_id and (e ->> 'plant_id')::uuid = c.plant_id
     );

  if p_combos is not null then
    select jsonb_agg(e) into v_invalid
    from jsonb_array_elements(p_combos) e
    where not exists (
      select 1 from jsonb_array_elements(v_selected) c
      where (c ->> 'template_id')::uuid = (e ->> 'template_id')::uuid
        and (c ->> 'plant_id')::uuid = (e ->> 'plant_id')::uuid
    );
    if v_invalid is not null then
      return jsonb_build_object('ok', false, 'error', 'invalid_combo', 'invalid', v_invalid);
    end if;
  end if;

  if jsonb_array_length(v_selected) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_combos');
  end if;

  select jsonb_agg(c order by ord)
  into v_missing
  from jsonb_array_elements(v_selected) with ordinality as x(c, ord)
  where c ->> 'problem' is not null;
  if v_missing is not null then
    return jsonb_build_object('ok', false, 'error', 'missing_route', 'missing', v_missing);
  end if;

  begin
    insert into public.annual_cycle (year, due_date)
    values (p_year, p_due_date)
    returning id into v_cycle;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'cycle_exists');
  end;

  for r in
    select t.id as template_id, t.code, t.name, t.layout, t.version, c.plant_id, c.route_id
    from jsonb_to_recordset(v_selected) as c(template_id uuid, plant_id uuid, route_id uuid, template_code text, factory_code text)
    join public.questionnaire_template t on t.id = c.template_id
    order by c.template_code, c.factory_code
  loop
    insert into public.assessment (
      cycle_id, plant_id, template_id, template_code, template_name, template_layout, template_version,
      current_step_position
    )
    values (
      v_cycle, r.plant_id, r.template_id, r.code, r.name, r.layout, r.version,
      (select min(position) from public.route_step where route_id = r.route_id)
    )
    returning id into v_new;

    insert into public.assessment_section (assessment_id, position, name)
    select v_new, s.position, s.name
    from public.template_section s
    where s.template_id = r.template_id;

    insert into public.assessment_control_point (assessment_id, section_id, position, text)
    select v_new, snap.id, cp.position, cp.text
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.control_point cp on cp.section_id = ts.id
    where ts.template_id = r.template_id;

    insert into public.assessment_control_point_unit (assessment_id, control_point_id, position, assessing_unit_name)
    select v_new, snap_cp.id, cpu.position, u.name
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.control_point cp on cp.section_id = ts.id
    join public.assessment_control_point snap_cp on snap_cp.section_id = snap.id and snap_cp.position = cp.position
    join public.control_point_unit cpu on cpu.control_point_id = cp.id
    join public.assessing_unit u on u.id = cpu.assessing_unit_id
    where ts.template_id = r.template_id;

    insert into public.assessment_section_document (
      assessment_id, section_id, position, document_number, document_code, document_name, document_version, pdf_file
    )
    select v_new, snap.id, scd.position, d.number, d.code, d.name, ver.version, ver.pdf_file
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.section_control_document scd on scd.section_id = ts.id and scd.plant_id = r.plant_id
    join public.control_document_version ver on ver.id = scd.version_id
    join public.control_document d on d.id = ver.document_id
    where ts.template_id = r.template_id;

    insert into public.assessment_control_reference (
      assessment_id, control_point_id, position, document_number, document_code, document_name, document_version, pdf_file,
      clause_number, clause_text
    )
    select v_new, snap_cp.id, cr.position, d.number, d.code, d.name, ver.version, ver.pdf_file,
           cl.number, public.clause_text_with_subclauses(cl.id)
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.control_point cp on cp.section_id = ts.id
    join public.assessment_control_point snap_cp on snap_cp.section_id = snap.id and snap_cp.position = cp.position
    join public.control_reference cr on cr.control_point_id = cp.id and cr.plant_id = r.plant_id
    join public.control_clause cl on cl.id = cr.clause_id
    join public.control_document_version ver on ver.id = cl.version_id
    join public.control_document d on d.id = ver.document_id
    where ts.template_id = r.template_id;

    insert into public.assessment_step (assessment_id, position, name, step_group, signer_emp_id, editable_unit_name)
    select v_new, rs.position, rs.name, rs.step_group, rs.signer_emp_id, u.name
    from public.route_step rs
    left join public.assessing_unit u on u.id = rs.editable_unit_id
    where rs.route_id = r.route_id;

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'cycle_id', v_cycle, 'assessments', v_count);
end
$$;

