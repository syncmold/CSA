-- 年度發起畫面（工單 #12、Q89）
--
-- launch_candidates()：發起畫面列出的「啟用範本 × 適用廠區」，每一列帶它的啟用流程能不能發起
--   problem：null＝可以發起；'no_route'＝沒有啟用的流程；'not_ready'＝啟用中的流程不通過啟用檢查（Q86 (6)）。
--   security invoker：稽核管理者以外的人讀不到範本與流程（RLS），所以拿到空清單。
--   launch_annual_cycle 也用它決定候選組合與缺少的流程，畫面看到的就是發起時檢查的，前端不另寫規則。

create or replace function public.launch_candidates()
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
  activation_check jsonb
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
    end,
    chk.result
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
  '年度發起的候選組合（啟用範本 × 適用廠區）與流程能否發起：problem null／no_route／not_ready。';

revoke execute on function public.launch_candidates() from public, anon;
grant execute on function public.launch_candidates() to authenticated;

-- launch_annual_cycle：與 Q81 (4) 相同的規則與回傳，改動三處——
--   (1) 候選組合與缺少的流程都取自 launch_candidates，所以啟用中但不通過啟用檢查的流程也整批擋下（Q86 (6)、Q89）；
--       `missing` 的每一列就是 launch_candidates 那一列（多了 `problem`、`activation_check` 等），畫面據以說明缺什麼。
--   (2) 同一年度同時發起兩次時，後到的那個撞 annual_cycle.year 的 unique，回 cycle_exists 而不是例外。
--   (3) 檢查前先以 FOR SHARE 鎖住要發的範本與啟用流程：停用、刪除、改關卡（關卡寫入會更新流程那一列）、
--       改章節或控制要點（見下方 lock_template_for_content_write）都要等發起結束，已在進行的修改則先等它提交，
--       所以檢查過的範本與流程就是複製進自評表的那一份。
--   (4) 其餘（只有稽核管理者、組合格式、invalid_combo、no_combos、快照的複製）不變。
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

  -- 先驗格式，之後的 ::uuid 轉型才不會把壞輸入變成例外而不是結構化錯誤。
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

  -- 先範本、後流程，各依 id 排序。
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

  -- 要發的組合：不給 combos＝所有候選組合，否則只取指定的那些（security definer，看得到全部範本與流程）。
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

  -- 不能發的組合原樣回傳（launch_candidates 的那一列），之後候選清單多的欄位也會一起帶到。
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
    -- 另一個同年度的發起剛提交（上面的 exists 沒看到它）。
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

    insert into public.assessment_control_point (assessment_id, section_id, position, text, assessing_unit_name)
    select v_new, snap.id, cp.position, cp.text, u.name
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.control_point cp on cp.section_id = ts.id
    left join public.assessing_unit u on u.id = cp.assessing_unit_id
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
comment on function public.launch_annual_cycle(integer, date, jsonb) is
  '發起年度作業（稽核管理者）：對每個「範本 × 廠區」建立自評表並凍結範本與簽核流程；缺流程或流程不通過啟用檢查就整批拒絕。';

-- 章節與控制要點的每一次寫入（新增、修改、刪除、重編順序，所有身分），先以 FOR NO KEY UPDATE 鎖住所屬範本那一列。
-- 它與發起的 FOR SHARE 互斥：發起進行中改範本內容要等發起結束，所以發起的啟用檢查與快照看到的是同一份範本（Q89）。
-- 範本抬頭與適用廠區由 update_template 改，本來就會更新範本那一列。
-- security definer：API 角色對範本表沒有 UPDATE 權限（範本只能經函式改），而加鎖需要它；函式除了加鎖什麼都不做。
create or replace function public.lock_template_for_content_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template uuid;
begin
  if tg_table_name = 'template_section' then
    v_template := case when tg_op = 'DELETE' then old.template_id else new.template_id end;
  else
    -- 刪除整個章節時連帶刪除的控制要點，章節已不在；範本已由章節那一層鎖住。
    select s.template_id into v_template
    from public.template_section s
    where s.id = case when tg_op = 'DELETE' then old.section_id else new.section_id end;
  end if;
  perform 1 from public.questionnaire_template where id = v_template for no key update;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

revoke execute on function public.lock_template_for_content_write() from public, anon;

create trigger template_section_lock_template
  before insert or update or delete on public.template_section
  for each row execute function public.lock_template_for_content_write();

create trigger control_point_lock_template
  before insert or update or delete on public.control_point
  for each row execute function public.lock_template_for_content_write();
