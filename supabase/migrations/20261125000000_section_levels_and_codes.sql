-- 多層章節與原檔題號 (工單 #166，需求決策紀錄 Q125)。用語依 GLOSSARY.md。
--
--   章節層級   章節加層級（1–3）。第一層是畫面上的一張卡片，第二、三層是卡片裡的分段列；一個章節列可以只當上層
--              標題，底下沒有控制要點（後面接更深一層的章節）。原本多層的章節被轉檔接成「上層／下層」一個名稱
--              （每章重複上層），這裡拆回去。章節的順序照舊是 position，層級只決定怎麼分段。
--   原檔題號   章節與控制要點各加可空的題號。有就照原檔的寫法顯示（「1.1.1-1」「1.2.」，結尾的點也照原檔），
--              沒有就照舊由畫面編：同一張卡片（第一層）內連續 1～n，單層的範本和原本一樣是每章從 1 編。
--   範本與快照 範本（template_section、control_point）與已發出的自評表快照（assessment_section、
--              assessment_control_point）都加；年度發起照抄（ADR-0004）。
--   既有資料   下面的轉換把 2026-11-11 檢查清單上的範本與它們的快照（含已結案，使用者決定）轉成分層＋題號，
--              只改結構、不改文字：拆開後接回去要和原文逐字相同（題號與文字之間的空白不保留），一份範本有任何
--              一處對不上就整份不動，以 notice 列出。

-- 欄位 ---------------------------------------------------------------------------------------------

alter table public.template_section
  add column level smallint not null default 1 check (level between 1 and 3),
  add column code text check (code is null or (code <> '' and code = btrim(code)));
comment on column public.template_section.level is
  '章節層級 1–3：1＝卡片，2、3＝卡片內的分段列；只當上層標題的章節沒有控制要點 (Q125)。';
comment on column public.template_section.code is '原檔的章節題號（「1」「1.1」）；null＝沒有，由畫面編 (Q125)。';

alter table public.control_point
  add column code text check (code is null or (code <> '' and code = btrim(code)));
comment on column public.control_point.code is
  '原檔的題號（「1.1.1-1」）；null＝沒有，畫面依同一張卡片內的順序編 (Q125)。';

alter table public.assessment_section
  add column level smallint not null default 1 check (level between 1 and 3),
  add column code text;
comment on column public.assessment_section.level is '發起時照抄的章節層級 (Q125, ADR-0004)。';
comment on column public.assessment_section.code is '發起時照抄的章節題號 (Q125, ADR-0004)。';

alter table public.assessment_control_point add column code text;
comment on column public.assessment_control_point.code is '發起時照抄的題號 (Q125, ADR-0004)。';

-- 範本管理直接寫章節表（#10）：層級與題號和名稱一樣可以寫。
grant insert (level, code), update (level, code) on public.template_section to authenticated;

-- 控制要點的題號：和文字、自評單位一起經這兩支函式寫（#46）。空白＝沒有題號。其餘同 20261025000000。 ----------

drop function public.create_control_point(uuid, text, uuid[]);
drop function public.update_control_point(uuid, text, uuid[]);

create function public.create_control_point(p_section_id uuid, p_text text, p_unit_ids uuid[] default '{}', p_code text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can edit templates' using errcode = '42501';
  end if;
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
comment on function public.create_control_point(uuid, text, uuid[], text) is
  '稽核管理者新增控制要點（排在章節最後）、它的自評單位（依清單順序）與原檔題號（空白＝由系統編）；回傳控制要點 id。';

create function public.update_control_point(p_control_point_id uuid, p_text text, p_unit_ids uuid[] default '{}', p_code text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can edit templates' using errcode = '42501';
  end if;
  update public.control_point set text = btrim(p_text), code = nullif(btrim(p_code), '') where id = p_control_point_id;
  if not found then
    raise exception 'control point % not found', p_control_point_id using errcode = 'P0002';
  end if;
  perform public.replace_control_point_units(p_control_point_id, p_unit_ids);
end
$$;
comment on function public.update_control_point(uuid, text, uuid[], text) is
  '稽核管理者修改控制要點的文字、自評單位（整組取代，依清單順序）與原檔題號（空白＝由系統編）。';

revoke execute on function public.create_control_point(uuid, text, uuid[], text) from public, anon;
revoke execute on function public.update_control_point(uuid, text, uuid[], text) from public, anon;
grant execute on function public.create_control_point(uuid, text, uuid[], text) to authenticated;
grant execute on function public.update_control_point(uuid, text, uuid[], text) to authenticated;

-- 內容指紋（Q111）：層級與題號也是內容。其餘同 20261104000000。 -------------------------------------------

create or replace function public.content_fingerprint(t public.questionnaire_template)
returns text
language sql
stable
set search_path = public
as $$
  select md5(string_agg(
    s.level || chr(26) || coalesce(s.code, '') || chr(26) || s.name || chr(31) || coalesce(p.points, ''), chr(30) order by s.position))
  from public.template_section s
  left join lateral (
    select string_agg(coalesce(cp.code, '') || chr(26) || cp.text || chr(29) || coalesce(u.units, ''), chr(28) order by cp.position) as points
    from public.control_point cp
    left join lateral (
      select string_agg(au.name, chr(27) order by cpu.position) as units
      from public.control_point_unit cpu
      join public.assessing_unit au on au.id = cpu.assessing_unit_id
      where cpu.control_point_id = cp.id
    ) u on true
    where cp.section_id = s.id
  ) p on true
  where s.template_id = t.id
$$;
comment on function public.content_fingerprint(public.questionnaire_template) is
  '問卷範本內容（章節層級、題號與名稱，控制要點題號、文字與各題自評單位，依順序）的雜湊，沒有章節時是 null；'
  '範本管理用來列出內容相同的其他廠區（Q111、Q125）。';

-- 草稿途徑：章節可帶 level（1–3，預設 1）與 code，控制要點可帶 code。 -------------------------------------
--   sections: [{ name, level?, code?, controlPoints: [{ text, code?, assessingUnits?: [自評單位名稱] }] }]
-- 第一個章節是第 1 層，往下一次只能深一層（22023）；題號空白視同沒有。其餘同 20261025000000。

create or replace function public.draft_template_contents(p_def jsonb)
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
  v_bad       text;
begin
  perform public.enter_draft_path();
  perform public.reject_non_draft_status(p_def);
  if coalesce(v_code, '') = '' or coalesce(v_name, '') = '' or coalesce(v_version, '') = '' then
    raise exception '問卷範本的編號、名稱、版本不可空白' using errcode = '23514';
  end if;
  if jsonb_typeof(p_def -> 'sections') is distinct from 'array' or jsonb_array_length(p_def -> 'sections') = 0 then
    raise exception '範本 % 沒有章節', v_code using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_def -> 'sections') sec where coalesce(btrim(sec ->> 'name'), '') = ''
  ) or exists (
    select 1
    from jsonb_array_elements(p_def -> 'sections') sec, jsonb_array_elements(coalesce(sec -> 'controlPoints', '[]'::jsonb)) cp
    where coalesce(btrim(cp ->> 'text'), '') = ''
  ) then
    raise exception '範本 % 有空白的章節名稱或控制要點文字', v_code using errcode = '23514';
  end if;
  -- 層級：1–3，第一個是 1，每個最多比前一個深一層。不是 1–3 的先換成 null 再比，不讓轉型失敗搶在這個訊息前面。
  select format('第 %s 個章節「%s」的 level「%s」', t.ord, t.sec ->> 'name', t.sec ->> 'level') into v_bad
  from (
    select sec, ord, level, lag(level) over (order by ord) as prev
    from (
      select sec, ord, case when coalesce(sec ->> 'level', '1') in ('1', '2', '3') then coalesce(sec ->> 'level', '1')::int end as level
      from jsonb_array_elements(p_def -> 'sections') with ordinality as x(sec, ord)
    ) l
  ) t
  where t.level is null or t.level > coalesce(t.prev, 0) + 1
  order by t.ord
  limit 1;
  if v_bad is not null then
    raise exception '範本 % %不對：層級是 1–3，第一個章節是 1，往下一次只能深一層', v_code, v_bad
      using errcode = '22023', hint = 'section_level';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_def -> 'sections') sec, jsonb_array_elements(coalesce(sec -> 'controlPoints', '[]'::jsonb)) cp
    where cp ? 'assessingUnit'
       or (cp ? 'assessingUnits' and jsonb_typeof(cp -> 'assessingUnits') <> 'array')
  ) then
    raise exception '範本 % 的控制要點請用 assessingUnits（自評單位名稱的清單），不再接受單一的 assessingUnit', v_code
      using errcode = '22023', hint = 'assessing_units_list';
  end if;
  -- 空白的單位名稱整份拒絕，不默默丟掉（Claude 漏抓單位時，要素類會變成沒有單位而不報錯）。
  if exists (
    select 1
    from jsonb_array_elements(p_def -> 'sections') sec,
         jsonb_array_elements(coalesce(sec -> 'controlPoints', '[]'::jsonb)) cp,
         jsonb_array_elements_text(coalesce(cp -> 'assessingUnits', '[]'::jsonb)) u
    where coalesce(btrim(u), '') = ''
  ) then
    raise exception '範本 % 有空白的自評單位名稱', v_code using errcode = '23514';
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
  select distinct btrim(u)
  from jsonb_array_elements(p_def -> 'sections') sec,
       jsonb_array_elements(coalesce(sec -> 'controlPoints', '[]'::jsonb)) cp,
       jsonb_array_elements_text(coalesce(cp -> 'assessingUnits', '[]'::jsonb)) u
  where coalesce(btrim(u), '') <> ''
  on conflict (name) do nothing;

  with s as (
    insert into public.template_section (template_id, position, name, level, code)
    select v_id, t.ord, btrim(t.sec ->> 'name'), coalesce((t.sec ->> 'level')::smallint, 1), nullif(btrim(t.sec ->> 'code'), '')
    from jsonb_array_elements(p_def -> 'sections') with ordinality as t(sec, ord)
    returning id, position
  )
  insert into public.control_point (section_id, position, text, code)
  select s.id, cp.ord, btrim(cp.item ->> 'text'), nullif(btrim(cp.item ->> 'code'), '')
  from jsonb_array_elements(p_def -> 'sections') with ordinality as t(sec, sord)
  join s on s.position = t.sord
  cross join lateral jsonb_array_elements(coalesce(t.sec -> 'controlPoints', '[]'::jsonb)) with ordinality as cp(item, ord);
  get diagnostics v_points = row_count;

  insert into public.control_point_unit (control_point_id, position, assessing_unit_id)
  select p.id, u.ord, au.id
  from jsonb_array_elements(p_def -> 'sections') with ordinality as t(sec, sord)
  join public.template_section s on s.template_id = v_id and s.position = t.sord
  cross join lateral jsonb_array_elements(coalesce(t.sec -> 'controlPoints', '[]'::jsonb)) with ordinality as cp(item, ord)
  join public.control_point p on p.section_id = s.id and p.position = cp.ord
  cross join lateral jsonb_array_elements_text(coalesce(cp.item -> 'assessingUnits', '[]'::jsonb)) with ordinality as u(name, ord)
  join public.assessing_unit au on au.name = btrim(u.name)
  where coalesce(btrim(u.name), '') <> '';

  return jsonb_build_object(
    'ok', true, 'template_id', v_id, 'replaced', v_existing.id is not null,
    'sections', jsonb_array_length(p_def -> 'sections'), 'control_points', v_points);
end
$$;

-- 年度發起：快照照抄章節層級與題號。其餘同 20261116000000。 ---------------------------------------

create or replace function public.launch_annual_cycle(
  p_year      integer,
  p_due_date  date,
  p_combos    jsonb default null,
  p_departed  text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_selected jsonb;
  v_invalid  jsonb;
  v_launched jsonb;
  v_missing  jsonb;
  v_cycle    uuid;
  v_due      date;
  v_top_up   boolean;
  v_new      uuid;
  v_ids      uuid[] := '{}';
  v_departed text[];
  v_counts   record;
  r          record;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can launch an annual cycle' using errcode = '42501';
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

  -- 同一年度的發起排隊：後到的在先到的提交之後才讀已發起的組合（之後每一句都看得到它的結果）。
  perform pg_advisory_xact_lock(hashtext('csa.launch_annual_cycle'), p_year);

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

  -- 不給組合＝該年度還沒發過的全部；給了就照給的，已發過的留著下面拒絕。
  select coalesce(jsonb_agg(to_jsonb(c) order by c.template_code, c.factory_code), '[]'::jsonb)
  into v_selected
  from public.launch_candidates() c
  where (p_combos is null and not p_year = any (c.launched_years))
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
  into v_launched
  from jsonb_array_elements(v_selected) with ordinality as x(c, ord)
  where c -> 'launched_years' @> to_jsonb(p_year);
  if v_launched is not null then
    return jsonb_build_object('ok', false, 'error', 'already_launched', 'launched', v_launched);
  end if;

  select jsonb_agg(c order by ord)
  into v_missing
  from jsonb_array_elements(v_selected) with ordinality as x(c, ord)
  where c ->> 'problem' is not null;
  if v_missing is not null then
    return jsonb_build_object('ok', false, 'error', 'missing_route', 'missing', v_missing);
  end if;

  v_departed := array(select upper(btrim(d)) from unnest(p_departed) d);

  select id, due_date into v_cycle, v_due from public.annual_cycle where year = p_year;
  v_top_up := v_cycle is not null;
  if not v_top_up then
    insert into public.annual_cycle (year, due_date)
    values (p_year, p_due_date)
    returning id, due_date into v_cycle, v_due;
  end if;

  for r in
    select t.id as template_id, t.code, t.name, t.layout, t.version, c.plant_id, c.route_id
    from jsonb_to_recordset(v_selected) as c(template_id uuid, plant_id uuid, route_id uuid, template_code text, factory_code text)
    join public.questionnaire_template t on t.id = c.template_id
    order by c.template_code, c.factory_code
  loop
    insert into public.assessment (
      cycle_id, plant_id, template_id, template_code, template_name, template_layout, template_version
    )
    values (
      v_cycle, r.plant_id, r.template_id, r.code, r.name, r.layout, r.version
    )
    returning id into v_new;
    v_ids := v_ids || v_new;

    insert into public.assessment_section (assessment_id, position, name, level, code)
    select v_new, s.position, s.name, s.level, s.code
    from public.template_section s
    where s.template_id = r.template_id;

    insert into public.assessment_control_point (assessment_id, section_id, position, text, code)
    select v_new, snap.id, cp.position, cp.text, cp.code
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

    insert into public.assessment_step (
      assessment_id, position, name, step_group, signer_emp_id, editable_unit_name, branch_unit_name, vacated_emp_id, vacated_name
    )
    select v_new, rs.position, rs.name, rs.step_group, who.signer_emp_id, u.name, bu.name, who.vacated_emp_id, who.vacated_name
    from public.route_step rs
    left join public.assessing_unit u on u.id = rs.editable_unit_id
    left join public.assessing_unit bu on bu.id = rs.branch_unit_id
    cross join lateral public.launch_step_signer(rs, bu.name, r.template_id, r.code, r.plant_id, p_year, v_departed) who
    where rs.route_id = r.route_id;
    -- 人都齊了的分流同時開始（Q116 (1)）；待分派的等分派。
    perform public.refresh_assessment_steps(v_new);
  end loop;

  perform public.log_access_change(
    s.vacated_emp_id, 'step_vacated', null,
    jsonb_build_object('year', p_year, 'plant', p.factory_code, 'template', a.template_code, 'step', s.name, 'branch', s.branch_unit_name),
    s.vacated_name
  )
  from public.assessment a
  join public.plant p on p.id = a.plant_id
  join public.assessment_step s on s.assessment_id = a.id
  where a.id = any (v_ids) and s.vacated_emp_id is not null;

  perform public.log_access_change(x.signer_emp_id, 'step_carried', null,
    jsonb_build_object('year', p_year, 'plant', x.factory_code, 'steps', x.steps))
  from (
    select s.signer_emp_id, p.factory_code, count(*)::int as steps
    from public.assessment a
    join public.plant p on p.id = a.plant_id
    join public.assessment_step s on s.assessment_id = a.id
    where a.id = any (v_ids) and s.step_group = 'plant' and s.signer_emp_id is not null
    group by s.signer_emp_id, p.factory_code
  ) x;

  select count(*) filter (where s.signer_emp_id is not null)::int as carried,
         count(*) filter (where s.vacated_emp_id is not null)::int as vacated,
         count(*) filter (where s.signer_emp_id is null and s.vacated_emp_id is null)::int as unassigned
  into v_counts
  from public.assessment_step s
  where s.assessment_id = any (v_ids) and s.step_group = 'plant';

  return jsonb_build_object(
    'ok', true, 'cycle_id', v_cycle, 'top_up', v_top_up, 'due_date', v_due, 'assessments', cardinality(v_ids),
    'carried', v_counts.carried, 'vacated', v_counts.vacated, 'unassigned', v_counts.unassigned
  );
end
$$;


-- 既有資料：拆開多層章節、取出原檔題號 ---------------------------------------------------------------
-- 對象是 2026-11-11 檢查清單上的範本（依編號，不分版本與狀態）與發出它們的自評表快照（依發出時的編號，含已結案，
-- 使用者決定），各自獨立判斷、獨立寫入：
--   拆章節   章節名稱以「／」分段：最後一段是這一章自己，層級＝段數；前面幾段是上層標題，和前一章相同的不重複，
--            不同的新增一列只當標題的章節（沒有控制要點）。超過三層或有空白段就整份不動。
--   取題號   只在原檔有題號的範本（台北總公司 A～D 的章節與控制要點，SY-08、VN-10.1 文字開頭手打的題號）：開頭的
--            「數字（.數字或 -數字）＊」加上可有可無的結尾點，後面接中文才算題號；題號與文字之間的空白不保留。
--   SAMOA    紙本每個作業從 1 重編（使用者決定照紙本）：題號寫成作業（第二層章節）內的順序。
--   比對     拆完把每個原本的章節照新的上層標題、題號、空白、名稱接回去，必須和原本的名稱逐字相同；控制要點的
--            題號＋空白＋文字必須等於原文。一份裡有任何一處對不上，整份不動、以 notice 列出。
-- 只換結構與題號：章節與控制要點的 id、答案、內控依據都不動，也不更新 updated_at（觸發器暫停）。

create function public.q125_split_code(p_text text, out code text, out gap text, out rest text)
language sql
immutable
set search_path = public
as $$
  select m[1], m[2], m[3]
  from (select regexp_match(p_text, '^([0-9]+(?:[.-][0-9]+)*\.?)( *)([^ -~].*)$') as m) x
  where m is not null
$$;

-- 一份範本或一張自評表原本的章節（[{id, name}]，依順序）→ 拆開後的每一列：既有章節保留 id，新增的上層標題列 id 為
-- null；gap 是題號與名稱之間被拿掉的空白，只給比對用。
create function public.q125_split_sections(p_sections jsonb, p_split boolean, p_coded boolean)
returns table (ord integer, id uuid, level smallint, code text, gap text, name text)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_prev   text[] := '{}';
  v_parts  text[];
  v_n      integer;
  v_same   integer;
  v_ord    integer := 0;
  v_code   record;
  s        jsonb;
  i        integer;
begin
  for s in select e from jsonb_array_elements(p_sections) e
  loop
    v_parts := case when p_split then string_to_array(s ->> 'name', '／') else array[s ->> 'name'] end;
    v_n := cardinality(v_parts);
    if v_n > 3 or exists (select 1 from unnest(v_parts) p where btrim(p) = '') then
      raise exception '章節「%」超過三層或有空白段', s ->> 'name' using errcode = '22023';
    end if;
    -- 和前一章相同的上層（從第一層依序比到第一個不同的地方）不重複。
    v_same := 0;
    while v_same < v_n - 1 and v_same < cardinality(v_prev) - 1 and v_parts[v_same + 1] = v_prev[v_same + 1] loop
      v_same := v_same + 1;
    end loop;
    for i in v_same + 1 .. v_n loop
      v_ord := v_ord + 1;
      ord := v_ord;
      id := case when i = v_n then (s ->> 'id')::uuid end;
      level := i;
      code := null;
      gap := '';
      name := v_parts[i];
      if p_coded then
        select * into v_code from public.q125_split_code(v_parts[i]);
        if v_code.code is not null then
          code := v_code.code;
          gap := v_code.gap;
          name := v_code.rest;
        end if;
      end if;
      return next;
    end loop;
    v_prev := v_parts;
  end loop;
end
$$;

alter table public.template_section disable trigger user;
alter table public.control_point disable trigger user;
alter table public.assessment_section disable trigger user;
alter table public.assessment_control_point disable trigger user;

do $$
declare
  -- 2026-11-11 的檢查清單（Q125、#166）。
  v_split    text[] := array[
    'SY-A', 'SY-B', 'SY-C', 'SY-D',
    'CF-10.1', 'FF-10.1', 'FQ-10.1', 'JS-10.1', 'SF-10.1', 'VN-10.1',
    'GT-05', 'SH-05', 'SY-05', 'TC-05',
    'GH-10.2', 'LH-05.1', 'LS-5.1',
    'SAMOA-01', 'SAMOA-02'];
  v_coded    text[] := array['SY-A', 'SY-B', 'SY-C', 'SY-D', 'SY-08', 'VN-10.1'];
  v_restart  text[] := array['SAMOA-01', 'SAMOA-02'];
  v_kind     text;
  v_sec      text;
  v_cp       text;
  v_owner    text;
  o          record;
  c          record;
  v_sections jsonb;
  v_done     boolean;
  v_problem  text;
  v_path     text[];
  v_original text;
  v_points   integer;
  v_count    integer;
  v_skipped  integer;
begin
  create temp table q125_rows (ord integer, id uuid, level smallint, code text, gap text, name text) on commit drop;
  create temp table q125_points (id uuid, code text, gap text, text text, original text) on commit drop;

  foreach v_kind in array array['template', 'assessment']
  loop
    if v_kind = 'template' then
      v_sec := 'template_section'; v_cp := 'control_point'; v_owner := 'template_id';
    else
      v_sec := 'assessment_section'; v_cp := 'assessment_control_point'; v_owner := 'assessment_id';
    end if;
    v_count := 0;
    v_skipped := 0;

    for o in
      select t.id, t.code, t.code || ' ' || t.version as label
      from public.questionnaire_template t
      where v_kind = 'template' and (t.code = any (v_split) or t.code = any (v_coded))
      union all
      select a.id, a.template_code, a.template_code || ' ' || a.template_version || ' 自評表 ' || a.id
      from public.assessment a
      where v_kind = 'assessment' and (a.template_code = any (v_split) or a.template_code = any (v_coded))
      order by 2, 3
    loop
      -- 新轉檔寫入的草稿已經是分層＋題號的：不再轉。
      execute format('select exists (select 1 from public.%I where %I = $1 and (level <> 1 or code is not null))', v_sec, v_owner)
      into v_done using o.id;
      if v_done then
        continue;
      end if;

      execute format(
        'select coalesce(jsonb_agg(jsonb_build_object(''id'', id, ''name'', name) order by position), ''[]'') from public.%I where %I = $1',
        v_sec, v_owner)
      into v_sections using o.id;

      truncate q125_rows, q125_points;
      v_problem := null;
      begin
        insert into q125_rows select * from public.q125_split_sections(v_sections, o.code = any (v_split), o.code = any (v_coded));
      exception when sqlstate '22023' then
        v_problem := sqlerrm;
      end;
      if o.code = any (v_coded) then
        execute format(
          'insert into q125_points
           select cp.id, x.code, x.gap, x.rest, cp.text
           from public.%I cp
           join public.%I s on s.id = cp.section_id
           cross join lateral public.q125_split_code(cp.text) x
           where s.%I = $1 and x.code is not null',
          v_cp, v_sec, v_owner)
        using o.id;
      end if;

      -- 逐字比對：每個原本的章節照它的上層標題接回去；控制要點的題號＋空白＋文字。
      if v_problem is null then
        v_path := '{}';
        for c in select * from q125_rows order by ord loop
          v_path := v_path[1:c.level - 1] || (coalesce(c.code, '') || c.gap || c.name);
          if c.id is not null then
            v_original := (select e ->> 'name' from jsonb_array_elements(v_sections) e where (e ->> 'id')::uuid = c.id);
            if array_to_string(v_path, '／') is distinct from v_original then
              v_problem := format('章節「%s」接回去是「%s」', v_original, array_to_string(v_path, '／'));
              exit;
            end if;
          end if;
        end loop;
      end if;
      if v_problem is null then
        select format('控制要點「%s」拆成「%s」＋「%s」', original, code, text) into v_problem
        from q125_points
        where code || gap || text is distinct from original
        limit 1;
      end if;
      if v_problem is null and (select count(*) from q125_rows where id is not null) <> jsonb_array_length(v_sections) then
        v_problem := '拆開後的章節數對不上';
      end if;
      if v_problem is not null then
        raise notice '% 沒有轉換：%', o.label, v_problem;
        v_skipped := v_skipped + 1;
        continue;
      end if;

      -- 寫入：先把原本的位置挪開，再依新的順序寫回；上層標題列新增。
      execute format('update public.%I set position = position + 100000 where %I = $1', v_sec, v_owner) using o.id;
      execute format(
        'update public.%I s set position = r.ord, level = r.level, code = r.code, name = r.name from q125_rows r where r.id = s.id',
        v_sec);
      execute format(
        'insert into public.%I (%I, position, level, code, name) select $1, ord, level, code, name from q125_rows where id is null',
        v_sec, v_owner)
      using o.id;
      execute format('update public.%I cp set code = p.code, text = p.text from q125_points p where p.id = cp.id', v_cp);
      v_points := (select count(*) from q125_points);
      if o.code = any (v_restart) then
        execute format(
          'update public.%I cp set code = cp.position::text from public.%I s where s.id = cp.section_id and s.%I = $1 and s.level > 1',
          v_cp, v_sec, v_owner)
        using o.id;
        get diagnostics v_points = row_count;
      end if;

      raise notice '% 轉換：% 章 → % 列（新增上層標題 % 列），章節題號 % 個，控制要點題號 % 個',
        o.label, jsonb_array_length(v_sections), (select count(*) from q125_rows), (select count(*) from q125_rows where id is null),
        (select count(*) from q125_rows where code is not null), v_points;
      v_count := v_count + 1;
    end loop;
    raise notice '%：轉換 % 份，沒有轉換 % 份', case v_kind when 'template' then '範本' else '自評表快照' end, v_count, v_skipped;
  end loop;
end
$$;

alter table public.template_section enable trigger user;
alter table public.control_point enable trigger user;
alter table public.assessment_section enable trigger user;
alter table public.assessment_control_point enable trigger user;

drop function public.q125_split_sections(jsonb, boolean, boolean);
drop function public.q125_split_code(text);
