-- 反向題目（Q148，#233）。使用者 2026-11-25 看過 mockup 後選定：
--   * 控制要點多一個「反向題目」屬性（預設否）。反向題帶否定語意，答「否」才是好的。
--   * 只翻轉執行情形（評估結果）：一般題答「否」要填改善措施／補充說明；反向題改成答「是」要填，答「否」不用。
--     「無內控規範」與滿意度「需要加強／不滿意」照舊要填。
--   * 年度發起時跟題目一起凍結進自評表（ADR-0004）：之後在範本改勾選，不影響已發出的自評表。
--   * 範本管理的清單直接勾（set_control_point_reverse），新增／修改視窗也能勾（create／update_control_point 多一個參數）。
-- 題目文字、PDF 不動；既有題目不依文字自動打勾，由稽核逐題勾選。

-- 欄位 --------------------------------------------------------------------------------------------------------

alter table public.control_point add column is_reverse boolean not null default false;
comment on column public.control_point.is_reverse is
  '反向題目（Q148）：執行情形答「是」才要填改善措施／補充說明，答「否」不用。發起時照抄進 assessment_control_point。';

alter table public.assessment_control_point add column is_reverse boolean not null default false;
comment on column public.assessment_control_point.is_reverse is
  '發起當時範本控制要點的反向題目設定（Q148，凍結）；送出檢查依它決定「是」或「否」要填改善措施。';

-- 新增、修改控制要點：多一個 p_is_reverse ----------------------------------------------------------------------
-- 修改時傳 null（或不傳）表示不改，舊的呼叫方式不會把反向題悄悄改回一般題。

drop function public.create_control_point(uuid, text, uuid[], text);
drop function public.update_control_point(uuid, text, uuid[], text);

create function public.create_control_point(
  p_section_id uuid,
  p_text text,
  p_unit_ids uuid[] default '{}',
  p_code text default null,
  p_is_reverse boolean default false
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
  insert into public.control_point (section_id, text, code, is_reverse)
  values (p_section_id, btrim(p_text), nullif(btrim(p_code), ''), coalesce(p_is_reverse, false))
  returning id into v_id;
  perform public.replace_control_point_units(v_id, p_unit_ids);
  return v_id;
end
$$;
comment on function public.create_control_point(uuid, text, uuid[], text, boolean) is
  '在章節最後新增一個控制要點，文字、題號、自評單位（依順序）與反向題目（Q148）一起存；只給能改這份範本的人（Q144）。';

create function public.update_control_point(
  p_control_point_id uuid,
  p_text text,
  p_unit_ids uuid[] default '{}',
  p_code text default null,
  p_is_reverse boolean default null
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
  update public.control_point
  set text = btrim(p_text), code = nullif(btrim(p_code), ''), is_reverse = coalesce(p_is_reverse, is_reverse)
  where id = p_control_point_id;
  if not found then
    raise exception 'control point % not found', p_control_point_id using errcode = 'P0002';
  end if;
  perform public.replace_control_point_units(p_control_point_id, p_unit_ids);
end
$$;
comment on function public.update_control_point(uuid, text, uuid[], text, boolean) is
  '修改控制要點的文字、題號與自評單位（整組換掉，依順序），p_is_reverse 不是 null 時一併改反向題目（Q148）；'
  '只給能改這份範本的人（Q144）。';

revoke execute on function public.create_control_point(uuid, text, uuid[], text, boolean) from public, anon;
revoke execute on function public.update_control_point(uuid, text, uuid[], text, boolean) from public, anon;
grant execute on function public.create_control_point(uuid, text, uuid[], text, boolean) to authenticated;
grant execute on function public.update_control_point(uuid, text, uuid[], text, boolean) to authenticated;

-- 範本管理清單上的勾選框：只改反向題目 --------------------------------------------------------------------

create function public.set_control_point_reverse(p_control_point_id uuid, p_is_reverse boolean)
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
  update public.control_point set is_reverse = coalesce(p_is_reverse, false) where id = p_control_point_id;
  if not found then
    raise exception 'control point % not found', p_control_point_id using errcode = 'P0002';
  end if;
end
$$;
comment on function public.set_control_point_reverse(uuid, boolean) is
  '把一個控制要點設為（或取消）反向題目（Q148）：範本管理清單上的勾選框；只給能改這份範本的人（Q144）。';
revoke execute on function public.set_control_point_reverse(uuid, boolean) from public, anon;
grant execute on function public.set_control_point_reverse(uuid, boolean) to authenticated;

-- 內容指紋：反向題目也是內容 ---------------------------------------------------------------------------------
-- 只在反向題多加一個記號，沒有反向題的範本指紋不變。其餘同 20261125000000。

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
    select string_agg(
             coalesce(cp.code, '') || chr(26) || cp.text || case when cp.is_reverse then chr(26) || 'R' else '' end
               || chr(29) || coalesce(u.units, ''),
             chr(28) order by cp.position) as points
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
  '問卷範本內容（章節層級、題號與名稱，控制要點題號、文字、反向題目與各題自評單位，依順序）的雜湊，沒有章節時是 null；'
  '範本管理用來列出內容相同的其他廠區（Q111、Q125、Q148）。';

-- 年度發起：反向題目跟題目一起凍結。其餘同 20261215000000。 ---------------------------------------------------

create or replace function public.launch_annual_cycle(
  p_year      integer,
  p_due_date  date,
  p_combos    jsonb default null,
  p_departed  text[] default '{}',
  p_checked   boolean default false
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
  v_left     jsonb;
  v_cycle    uuid;
  v_due      date;
  v_top_up   boolean;
  v_new      uuid;
  v_ids      uuid[] := '{}';
  v_departed text[];
  r          record;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核主管 can launch an annual cycle' using errcode = '42501';
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

  -- 流程鎖住（分派 assign_route_signer 與流程編輯器要等發起做完），發起檢查與照抄的人是同一份。
  perform 1
  from public.approval_route ar
  where (
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

  -- 沒流程、沒通過發起檢查（含還沒分派，Q147）、沒有廠區管理員。
  select jsonb_agg(c order by ord)
  into v_missing
  from jsonb_array_elements(v_selected) with ordinality as x(c, ord)
  where c ->> 'problem' is not null;
  if v_missing is not null then
    return jsonb_build_object('ok', false, 'error', 'missing_route', 'missing', v_missing);
  end if;

  -- 流程上的人已離職（Q147 (4)）：整批拒絕，列出是誰，要先換人。
  v_departed := array(select upper(btrim(d)) from unnest(coalesce(p_departed, '{}')) d);
  select jsonb_agg(jsonb_build_object(
           'template_id', c.template_id, 'template_code', c.template_code, 'template_name', c.template_name,
           'plant_id', c.plant_id, 'factory_code', c.factory_code, 'plant_name', c.plant_name,
           'step_id', rs.id, 'step', rs.name, 'branch_unit_name', bu.name, 'link', rs.link,
           'emp_id', who.emp_id, 'name', (select e.name from public.employee_ref e where e.emp_id = who.emp_id)
         ) order by c.template_code, c.factory_code, rs.position)
  into v_left
  from jsonb_to_recordset(v_selected) as c(
    template_id uuid, template_code text, template_name text, plant_id uuid, factory_code text, plant_name text, route_id uuid
  )
  join public.route_step rs on rs.route_id = c.route_id
  left join public.assessing_unit bu on bu.id = rs.branch_unit_id
  cross join lateral (select public.launch_step_signer(rs, c.plant_id) as emp_id) who
  where upper(who.emp_id) = any (v_departed);
  if v_left is not null then
    return jsonb_build_object('ok', false, 'error', 'departed_signers', 'departed', v_left);
  end if;

  select id, due_date into v_cycle, v_due from public.annual_cycle where year = p_year;
  v_top_up := v_cycle is not null;
  if not v_top_up then
    insert into public.annual_cycle (year, due_date)
    values (p_year, p_due_date)
    returning id, due_date into v_cycle, v_due;
  end if;

  for r in
    select t.id as template_id, t.code, t.name, t.layout, c.plant_id, c.route_id
    from jsonb_to_recordset(v_selected) as c(template_id uuid, plant_id uuid, route_id uuid, template_code text, factory_code text)
    join public.questionnaire_template t on t.id = c.template_id
    order by c.template_code, c.factory_code
  loop
    insert into public.assessment (
      cycle_id, plant_id, template_id, template_code, template_name, template_layout
    )
    values (
      v_cycle, r.plant_id, r.template_id, r.code, r.name, r.layout
    )
    returning id into v_new;
    v_ids := v_ids || v_new;

    insert into public.assessment_section (assessment_id, position, name, level, code)
    select v_new, s.position, s.name, s.level, s.code
    from public.template_section s
    where s.template_id = r.template_id;

    insert into public.assessment_control_point (assessment_id, section_id, position, text, code, is_reverse)
    select v_new, snap.id, cp.position, cp.text, cp.code, cp.is_reverse
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

    -- 照抄流程上的人（Q147 (3)）：發起檢查已確定每一關都有人。
    insert into public.assessment_step (
      assessment_id, position, name, step_group, signer_emp_id, editable_unit_name, branch_unit_name, link
    )
    select v_new, rs.position, rs.name, rs.step_group, public.launch_step_signer(rs, r.plant_id), u.name, bu.name, rs.link
    from public.route_step rs
    left join public.assessing_unit u on u.id = rs.editable_unit_id
    left join public.assessing_unit bu on bu.id = rs.branch_unit_id
    where rs.route_id = r.route_id;
    -- 每條分流同時開始（Q116 (1)）。
    perform public.refresh_assessment_steps(v_new);
  end loop;

  return jsonb_build_object(
    'ok', true, 'cycle_id', v_cycle, 'top_up', v_top_up, 'due_date', v_due, 'assessments', cardinality(v_ids),
    'checked', coalesce(p_checked, false)
  );
end
$$;

-- 送出：反向題答「是」才要填改善措施／補充說明。其餘同 20261109000000。 -----------------------------------------

create or replace function public.submit_assessment_step(p_assessment_id uuid, p_step_position integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s             public.assessment_step;
  v_layout      public.template_layout;
  v_violations  jsonb;
begin
  s := public.lock_my_current_step(p_assessment_id, p_step_position, true);
  if s.editable_unit_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_self_check_step');
  end if;
  if not exists (
    select 1 from public.assessment_step n
    where n.assessment_id = s.assessment_id
      and (n.branch_unit_name is null or (n.branch_unit_name = s.branch_unit_name and n.position > s.position))
  ) then
    return jsonb_build_object('ok', false, 'error', 'no_next_step');
  end if;
  select template_layout into v_layout from public.assessment where id = s.assessment_id;

  with points as (
    select cp.id, sec.position as section_position, cp.position, cp.is_reverse,
           ans.design, ans.execution, ans.satisfaction, nullif(btrim(ans.improvement), '') as improvement
    from public.assessment_control_point_unit u
    join public.assessment_control_point cp on cp.id = u.control_point_id
    join public.assessment_section sec on sec.id = cp.section_id
    left join public.assessment_answer ans
      on ans.control_point_id = u.control_point_id and ans.assessing_unit_name = u.assessing_unit_name
    where u.assessment_id = s.assessment_id and u.assessing_unit_name = s.editable_unit_name
  ),
  -- 排序鍵：控制要點依紙本順序（章、題、規則），整體結論排最後。
  violations as (
    select section_position, position, 1 as rule_order,
           jsonb_build_object('kind', 'control_point', 'control_point_id', id, 'section_position', section_position,
                              'position', position, 'rule', 'unanswered') as v
    from points
    where not public.answer_is_complete(v_layout, design, execution, satisfaction)
    union all
    select section_position, position, 2,
           jsonb_build_object('kind', 'control_point', 'control_point_id', id, 'section_position', section_position,
                              'position', position, 'rule', 'improvement_required')
    from points
    -- 反向題（Q148）：執行情形答「是」才要填，答「否」不用；其餘照舊。
    where (execution = (case when is_reverse then 'yes' else 'no' end)::public.execution_status
           or design = 'no_rule' or satisfaction in ('needs_improvement', 'dissatisfied'))
      and improvement is null
    union all
    select 2147483647, 0, 0,
           jsonb_build_object('kind', 'conclusion', 'assessing_unit_name', s.editable_unit_name, 'rule',
             case when c.conclusion is null then 'unanswered' else 'explanation_required' end)
    from (select 1) one
    left join public.assessment_conclusion c
      on c.assessment_id = s.assessment_id and c.assessing_unit_name = s.editable_unit_name
    where c.conclusion is null
       or (c.conclusion = 'satisfied_except' and nullif(btrim(c.exceptions), '') is null)
  )
  select jsonb_agg(v order by section_position, position, rule_order) into v_violations
  from violations;

  if v_violations is not null then
    return jsonb_build_object('ok', false, 'error', 'incomplete', 'violations', v_violations);
  end if;

  perform public.record_signoff(s, 'submit');
  perform public.refresh_assessment_steps(s.assessment_id);
  return jsonb_build_object('ok', true, 'current_step_position', public.next_current_position(s));
end
$$;

