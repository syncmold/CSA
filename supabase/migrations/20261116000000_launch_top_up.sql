-- 年度發起：同一年度可以補發（工單 #115；Q119，修訂 Q89 (3)(4)）。
--
--   規則     「同一年度只能發起一次」改成「同一廠區、同一範本一年只發一次」。年度已有年度作業時沿用同一筆
--            annual_cycle 與它的截止日（截止日一年一個，p_due_date 只在第一次發起時用），只產生還沒發過的組合。
--            同一範本同 launch_step_signer：id 或編號相同都算（改版後 id 會變，自評表留著發起時的編號）。
--   已發起   launch_candidates 每列多 launched_years：這個組合發過的年度。畫面據以標「已發起」、不能勾、不算張數，
--            也據以決定預設年度；不必為每個年度各查一次。
--   拒絕     勾選的組合已在該年度發過，整批拒絕，回 already_launched 與那些組合（launch_candidates 的那一列）。
--            同一年度的發起以 advisory lock 排隊，所以兩人同時補發同一組合時，後到的等先到的提交後才檢查，
--            看到已發起而得到 already_launched，不是 unique 的例外。不給組合（腳本）＝該年度還沒發過的全部。
--   統計     帶入、從缺、待分派的關數與權限異動紀錄只算這次產生的自評表，不含同一年度先前發的。

comment on table public.annual_cycle is
  '年度作業：一年一個，有年度與截止日；同一年度可以分次發起（補發），截止日一年一個（Q119）。';

-- 多 launched_years；其餘同 20261113000000。
drop function public.launch_candidates();
create function public.launch_candidates()
returns table (
  template_id      uuid,
  template_code    text,
  template_name    text,
  template_version text,
  plant_id         uuid,
  factory_code     text,
  plant_name       text,
  route_id         uuid,
  step_count       integer,
  problem          text,
  activation_check jsonb,
  launched_years   integer[]
)
language sql
stable
set search_path = public
as $$
  select
    t.id, t.code, t.name, t.version,
    p.id, p.factory_code, p.name,
    ar.id,
    (select count(*)::integer from public.route_step rs where rs.route_id = ar.id),
    case
      when ar.id is null then 'no_route'
      when not (chk.result ->> 'ready')::boolean then 'not_ready'
      when not exists (select 1 from public.plant_coordinator pc where pc.plant_id = p.id) then 'no_coordinator'
    end,
    chk.result,
    coalesce((
      select array_agg(distinct c.year order by c.year)
      from public.assessment a
      join public.annual_cycle c on c.id = a.cycle_id
      where a.plant_id = p.id and (a.template_id = t.id or a.template_code = t.code)
    ), '{}')
  from public.questionnaire_template t
  join public.plant p
    on t.all_plants
    or exists (select 1 from public.template_plant tp where tp.template_id = t.id and tp.factory_code = p.factory_code)
  left join public.approval_route ar
    on ar.template_id = t.id and ar.plant_id = p.id and ar.status = 'active'
  left join lateral (select public.activation_check(ar) as result where ar.id is not null) chk on true
  where t.status = 'active'
  order by t.code, p.factory_code
$$;
comment on function public.launch_candidates() is
  '年度發起的候選組合（啟用範本 × 適用廠區）與能否發起：problem null／no_route／not_ready／no_coordinator；launched_years 是這個組合已發起的年度。';
revoke execute on function public.launch_candidates() from public, anon;
grant execute on function public.launch_candidates() to authenticated;

-- 年度已存在就補發；排除已發過的組合；統計只算這次的。其餘同 20261114000000。
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
comment on function public.launch_annual_cycle(integer, date, jsonb, text[]) is
  '依啟用範本與適用廠區發起年度作業；年度已存在就補發，沿用它的截止日，只發還沒發過的組合（Q119）。組合資格與候選清單同一來源（launch_candidates）。p_departed 是 OMS 查到離職的工號（Q116 (6)）。';
