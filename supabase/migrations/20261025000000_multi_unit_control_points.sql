-- 一個控制要點多個自評單位（工單 #46）。用語依 GLOSSARY.md，實作決定見需求決策紀錄 Q92。
--
-- 紙本上同一格控制要點可以由幾個自評單位各答一列（Word 垂直合併）。原本每個控制要點只有一個自評單位，
-- 這種控制要點暫時轉成「每個單位各一個控制要點」（Q90(5)），同一句話佔好幾個題號。這裡改成：
--   範本   控制要點掛一組有順序的自評單位 control_point_unit；控制活動類至少一個，要素類可以沒有（Q83(3)），也不限個數。
--          文字與自評單位只能一起存：create_control_point／update_control_point（一個函式一個交易）。
--   快照   發起時一併複製成 assessment_control_point_unit（自評單位存名稱，ADR-0004）。
--   答案   「快照控制要點 × 自評單位」各一筆；越權檢查和整體結論一樣經 can_edit_unit，規則仍只在 my_editable_unit。
-- 現有資料：同一章節裡相鄰、文字相同的控制要點合併成一個多單位的控制要點（範本與已發出的自評表都一樣，見檔尾）。

-- 範本：控制要點的自評單位 ---------------------------------------------------------------

create table public.control_point_unit (
  control_point_id   uuid not null references public.control_point (id) on delete cascade,
  position           integer not null check (position > 0),
  assessing_unit_id  uuid not null references public.assessing_unit (id),
  primary key (control_point_id, assessing_unit_id),
  unique (control_point_id, position)
);
create index control_point_unit_assessing_unit_idx on public.control_point_unit (assessing_unit_id);
comment on table public.control_point_unit is
  '控制要點的自評單位：依作答順序（紙本上的列順序），一個單位一列；同一個控制要點不重複。';

insert into public.control_point_unit (control_point_id, position, assessing_unit_id)
select id, 1, assessing_unit_id from public.control_point where assessing_unit_id is not null;

drop trigger control_point_unit_matches_layout on public.control_point;
drop function public.check_control_point_unit();
alter table public.control_point drop column assessing_unit_id;

-- 控制活動類至少一個自評單位（取代 #10 的 check_control_point_unit）：控制要點與它的單位分在兩張表，
-- 所以在交易結束時才檢查，所有身分都擋（含 service_role 與草稿途徑）。控制要點已被刪掉（連帶刪除）就不檢查。
-- security definer：要讀上層章節與範本的版型。
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
    raise exception '控制活動類的控制要點至少要有一個自評單位' using errcode = '23514';
  end if;
  return null;
end
$$;

create constraint trigger control_point_has_unit
  after insert or update of section_id on public.control_point
  deferrable initially deferred
  for each row execute function public.check_control_point_has_unit();
create constraint trigger control_point_unit_keeps_one
  after update or delete on public.control_point_unit
  deferrable initially deferred
  for each row execute function public.check_control_point_has_unit();

alter table public.control_point_unit enable row level security;
create policy control_point_unit_select_audit_admin on public.control_point_unit
  for select to authenticated using (public.is_audit_admin());
grant select on public.control_point_unit to authenticated;
revoke insert, update, delete on public.control_point_unit from authenticated, anon;
revoke all on public.control_point_unit from anon;

-- 文字與自評單位一起存 -----------------------------------------------------------------
-- security definer：位置只由資料庫決定（Q83(4)），API 沒有 control_point_unit 的寫入權限；函式自己檢查稽核管理者。
-- p_unit_ids 的順序就是作答順序。錯誤：不是稽核管理者 42501；章節或控制要點不存在 P0002；
-- 單位重複 23505；單位不存在 23503；清單有空值 22023；控制活動類沒有單位、文字空白 23514（見下方觸發器）。

create or replace function public.replace_control_point_units(p_control_point_id uuid, p_unit_ids uuid[])
returns void
language plpgsql
set search_path = public
as $$
begin
  if array_position(coalesce(p_unit_ids, '{}'), null) is not null then
    raise exception '自評單位清單不能有空值' using errcode = '22023';
  end if;
  delete from public.control_point_unit where control_point_id = p_control_point_id;
  insert into public.control_point_unit (control_point_id, position, assessing_unit_id)
  select p_control_point_id, o.ord, o.id
  from unnest(coalesce(p_unit_ids, '{}')) with ordinality as o(id, ord);
end
$$;
comment on function public.replace_control_point_units(uuid, uuid[]) is
  '內部用：換掉一個控制要點的自評單位（依清單順序）。只給 create_control_point／update_control_point 與草稿途徑呼叫。';

create or replace function public.create_control_point(p_section_id uuid, p_text text, p_unit_ids uuid[] default '{}')
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
  insert into public.control_point (section_id, text) values (p_section_id, btrim(p_text)) returning id into v_id;
  perform public.replace_control_point_units(v_id, p_unit_ids);
  return v_id;
end
$$;
comment on function public.create_control_point(uuid, text, uuid[]) is
  '稽核管理者新增控制要點（排在章節最後）與它的自評單位（依清單順序）；回傳控制要點 id。';

create or replace function public.update_control_point(p_control_point_id uuid, p_text text, p_unit_ids uuid[] default '{}')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can edit templates' using errcode = '42501';
  end if;
  update public.control_point set text = btrim(p_text) where id = p_control_point_id;
  if not found then
    raise exception 'control point % not found', p_control_point_id using errcode = 'P0002';
  end if;
  perform public.replace_control_point_units(p_control_point_id, p_unit_ids);
end
$$;
comment on function public.update_control_point(uuid, text, uuid[]) is
  '稽核管理者修改控制要點的文字與自評單位（整組取代，依清單順序）。';

revoke execute on function public.replace_control_point_units(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.create_control_point(uuid, text, uuid[]) from public, anon;
revoke execute on function public.update_control_point(uuid, text, uuid[]) from public, anon;
grant execute on function public.create_control_point(uuid, text, uuid[]) to authenticated;
grant execute on function public.update_control_point(uuid, text, uuid[]) to authenticated;

-- 控制要點只能經上面兩支函式寫（文字與自評單位一起）：收回 #10 開給稽核管理者的直接新增與修改，只留刪除
-- （範本管理的刪除鈕；刪除後的題號重編照舊由觸發器做）。否則要素類可以直接寫表存成沒有單位、或只改文字。
revoke insert, update on public.control_point from authenticated;
drop policy control_point_insert_audit_admin on public.control_point;
drop policy control_point_update_audit_admin on public.control_point;

-- 啟用檢查（Q86(3)）：「範本用到的自評單位」改從控制要點的單位清單取，依紙本上第一次出現的位置
-- （章節、控制要點、單位在控制要點內的順序）排序；其餘與 #11 相同。
create or replace function public.activation_check(r public.approval_route)
returns jsonb
language sql
stable
set search_path = public
as $$
  with steps as (
    select position, editable_unit_id from public.route_step where route_id = r.id
  ),
  used as (
    select cpu.assessing_unit_id as unit_id, min(array[s.position, cp.position, cpu.position]) as first_seen
    from public.template_section s
    join public.control_point cp on cp.section_id = s.id
    join public.control_point_unit cpu on cpu.control_point_id = cp.id
    where s.template_id = r.template_id
    group by cpu.assessing_unit_id
  ),
  missing as (
    select u.id, u.name, used.first_seen
    from used
    join public.assessing_unit u on u.id = used.unit_id
    where not exists (select 1 from steps where steps.editable_unit_id = used.unit_id)
  ),
  unused as (
    select u.id, u.name, min(steps.position) as first_step
    from steps
    join public.assessing_unit u on u.id = steps.editable_unit_id
    where not exists (select 1 from used where used.unit_id = steps.editable_unit_id)
    group by u.id, u.name
  ),
  facts as (
    select
      not exists (select 1 from steps) as no_steps,
      coalesce((select editable_unit_id is not null from steps order by position desc limit 1), false) as last_step_editable,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by first_seen) from missing), '[]'::jsonb) as missing_units,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by first_step) from unused), '[]'::jsonb) as unused_units
  )
  select jsonb_build_object(
    'ready', not no_steps and not last_step_editable
             and jsonb_array_length(missing_units) = 0 and jsonb_array_length(unused_units) = 0,
    'no_steps', no_steps,
    'last_step_editable', last_step_editable,
    'missing_units', missing_units,
    'unused_units', unused_units
  )
  from facts
$$;

-- 快照：自評表上控制要點的自評單位 ---------------------------------------------------------
-- 和 assessment_control_point 一樣只在發起時寫入（ADR-0004）：沒有任何 API 寫入授權，看得到自評表的人都讀得到。

create table public.assessment_control_point_unit (
  -- assessment_id 與控制要點重複，是為了讓 RLS 與答案的外鍵不必 join 控制要點。
  assessment_id        uuid not null,
  control_point_id     uuid not null,
  position             integer not null check (position > 0),
  assessing_unit_name  text not null,
  primary key (control_point_id, assessing_unit_name),
  unique (control_point_id, position),
  unique (assessment_id, control_point_id, assessing_unit_name),
  foreign key (assessment_id, control_point_id)
    references public.assessment_control_point (assessment_id, id) on delete cascade
);
create index assessment_control_point_unit_assessment_idx on public.assessment_control_point_unit (assessment_id);
comment on table public.assessment_control_point_unit is
  '自評表上控制要點的自評單位快照（存名稱）：依作答順序，一個單位一列，各自作答。';

insert into public.assessment_control_point_unit (assessment_id, control_point_id, position, assessing_unit_name)
select assessment_id, id, 1, assessing_unit_name from public.assessment_control_point where assessing_unit_name is not null;

alter table public.assessment_control_point_unit enable row level security;
create policy assessment_control_point_unit_select_visible on public.assessment_control_point_unit
  for select to authenticated using (public.can_view_assessment(assessment_id));
grant select on public.assessment_control_point_unit to authenticated;
revoke insert, update, delete on public.assessment_control_point_unit from authenticated, anon;
revoke all on public.assessment_control_point_unit from anon;

-- 答案：快照控制要點 × 自評單位 -----------------------------------------------------------
-- 既有的答案帶上它的控制要點的單位。結案的自評表（觸發器 guard_assessment_write 擋所有寫入）與寫入者戳記
-- （stamp_writer 會改掉 updated_by／updated_at）都不該作用在這次搬資料上，所以暫停這張表的觸發器。

alter table public.assessment_answer add column assessing_unit_name text;
alter table public.assessment_answer disable trigger user;
update public.assessment_answer a
set assessing_unit_name = cp.assessing_unit_name
from public.assessment_control_point cp
where cp.id = a.control_point_id;
alter table public.assessment_answer enable trigger user;

do $$
begin
  -- 沒有自評單位的控制要點沒有人能作答（Q86(3)），照理不會有答案；有的話停下來，不默默丟掉。
  if exists (select 1 from public.assessment_answer where assessing_unit_name is null) then
    raise exception '有答案的控制要點沒有自評單位，無法轉換（請先查明這些答案從哪裡來）';
  end if;
end
$$;

drop policy assessment_answer_insert_editable on public.assessment_answer;
drop policy assessment_answer_update_editable on public.assessment_answer;

alter table public.assessment_answer
  alter column assessing_unit_name set not null,
  drop constraint assessment_answer_assessment_id_control_point_id_fkey,
  drop constraint assessment_answer_assessment_id_control_point_id_key,
  drop constraint assessment_answer_pkey,
  add primary key (control_point_id, assessing_unit_name),
  -- 與主鍵重複，但讓 PostgREST 把「控制要點的自評單位 → 答案」認成一對一，頁面嵌入時拿到物件而不是陣列。
  add constraint assessment_answer_unit_key unique (assessment_id, control_point_id, assessing_unit_name),
  add constraint assessment_answer_unit_fkey foreign key (assessment_id, control_point_id, assessing_unit_name)
    references public.assessment_control_point_unit (assessment_id, control_point_id, assessing_unit_name) on delete cascade;
comment on table public.assessment_answer is
  '答案：自評表上一個控制要點、一個自評單位的作答；暫存時可以缺欄位，送出時才驗證。';

-- 誰能寫：和整體結論一樣看自評單位（規則仍只在 my_editable_unit，經 can_edit_unit）。
create policy assessment_answer_insert_editable on public.assessment_answer
  for insert to authenticated with check (public.can_edit_unit(assessment_id, assessing_unit_name));
create policy assessment_answer_update_editable on public.assessment_answer
  for update to authenticated
  using (public.can_edit_unit(assessment_id, assessing_unit_name))
  with check (public.can_edit_unit(assessment_id, assessing_unit_name));

-- 寫入守門（Q85(9)(10)）：答案改用自己的自評單位重驗；其餘不變。
create or replace function public.guard_assessment_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_status   public.assessment_status;
  v_allowed  boolean;
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  r := case when tg_op = 'DELETE' then old else new end;

  select status into v_status from public.assessment where id = r.assessment_id for share;
  if v_status = 'closed' then
    raise exception '自評表已結案，不能再修改' using errcode = '42501';
  end if;

  if tg_op <> 'DELETE' and public.current_emp_id() is not null then
    if tg_table_name in ('assessment_answer', 'assessment_conclusion') then
      v_allowed := public.can_edit_unit(r.assessment_id, r.assessing_unit_name);
    else
      v_allowed := true;
    end if;
    if not v_allowed then
      raise exception '這一關現在不能修改這個自評單位' using errcode = '42501';
    end if;
  end if;

  return r;
end
$$;

drop function public.can_edit_control_point(uuid);
alter table public.assessment_control_point drop column assessing_unit_name;

-- 暫存（Q84(3)）：每一筆答案多帶自評單位。
--   p_answers  [{control_point_id, assessing_unit_name, design, execution, satisfaction, improvement}, …]
create or replace function public.save_assessment_answers(
  p_assessment_id  uuid,
  p_answers        jsonb default '[]',
  p_conclusions    jsonb default '[]'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_answers      integer;
  v_conclusions  integer;
begin
  insert into public.assessment_answer (control_point_id, assessing_unit_name, assessment_id, design, execution, satisfaction, improvement)
  select x.control_point_id, x.assessing_unit_name, p_assessment_id, x.design, x.execution, x.satisfaction, x.improvement
  from jsonb_to_recordset(coalesce(p_answers, '[]')) as x(
    control_point_id uuid,
    assessing_unit_name text,
    design public.design_status,
    execution public.execution_status,
    satisfaction public.satisfaction_level,
    improvement text
  )
  on conflict (control_point_id, assessing_unit_name) do update
    set design = excluded.design,
        execution = excluded.execution,
        satisfaction = excluded.satisfaction,
        improvement = excluded.improvement;
  get diagnostics v_answers = row_count;

  insert into public.assessment_conclusion (assessment_id, assessing_unit_name, conclusion, exceptions)
  select p_assessment_id, x.assessing_unit_name, x.conclusion, x.exceptions
  from jsonb_to_recordset(coalesce(p_conclusions, '[]')) as x(
    assessing_unit_name text,
    conclusion public.conclusion_kind,
    exceptions text
  )
  on conflict (assessment_id, assessing_unit_name) do update
    set conclusion = excluded.conclusion,
        exceptions = excluded.exceptions;
  get diagnostics v_conclusions = row_count;

  return jsonb_build_object('ok', true, 'answers', v_answers, 'conclusions', v_conclusions);
end
$$;

-- 送出（Q84(3)、Q85）：只驗自己自評單位的那幾列（控制要點 × 這個單位）；違規的形狀與回傳不變。
create or replace function public.submit_assessment_step(p_assessment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s             public.assessment_step;
  v_layout      public.template_layout;
  v_violations  jsonb;
  v_next        integer;
begin
  s := public.lock_my_current_step(p_assessment_id);
  if s.editable_unit_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_self_check_step');
  end if;
  v_next := public.next_step_position(s);
  if v_next is null then
    return jsonb_build_object('ok', false, 'error', 'no_next_step');
  end if;
  select template_layout into v_layout from public.assessment where id = s.assessment_id;

  with points as (
    select cp.id, sec.position as section_position, cp.position,
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
    where execution is null or satisfaction is null
       or (v_layout = 'control_activity' and design is null)
    union all
    select section_position, position, 2,
           jsonb_build_object('kind', 'control_point', 'control_point_id', id, 'section_position', section_position,
                              'position', position, 'rule', 'improvement_required')
    from points
    where (execution = 'no' or design = 'no_rule' or satisfaction in ('needs_improvement', 'dissatisfied'))
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
  update public.assessment set current_step_position = v_next where id = s.assessment_id;
  return jsonb_build_object('ok', true, 'current_step_position', v_next);
end
$$;

-- 年度發起（Q89）：快照多複製控制要點的自評單位；其餘與 20261022000000_launch_screen 相同。
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

-- 範本內容寫入先鎖範本（Q89(4)）：控制要點的自評單位也算範本內容，發起進行中改它要等發起結束。 ------------
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
  elsif tg_table_name = 'control_point' then
    -- 刪除整個章節時連帶刪除的控制要點，章節已不在；範本已由章節那一層鎖住。
    select s.template_id into v_template
    from public.template_section s
    where s.id = case when tg_op = 'DELETE' then old.section_id else new.section_id end;
  else
    -- control_point_unit：連帶刪除時控制要點已不在，範本已由上一層鎖住。
    select s.template_id into v_template
    from public.control_point cp
    join public.template_section s on s.id = cp.section_id
    where cp.id = case when tg_op = 'DELETE' then old.control_point_id else new.control_point_id end;
  end if;
  perform 1 from public.questionnaire_template where id = v_template for no key update;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create trigger control_point_unit_lock_template
  before insert or update or delete on public.control_point_unit
  for each row execute function public.lock_template_for_content_write();

-- 草稿途徑（Q90）：控制要點的自評單位歸它的範本管，和控制要點一樣只放行草稿範本底下的。 ------------------
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
    when 'control_point_unit' then (
      select t.status::text
      from public.control_point cp
      join public.template_section s on s.id = cp.section_id
      join public.questionnaire_template t on t.id = s.template_id
      where cp.id = (p_row ->> 'control_point_id')::uuid)
    when 'route_step' then (select status::text from public.approval_route where id = (p_row ->> 'route_id')::uuid)
  end
$$;

create trigger control_point_unit_guard_draft_path
  before insert or update or delete on public.control_point_unit
  for each row execute function public.guard_draft_path();

-- 範本草稿：控制要點的自評單位改成名稱清單 assessingUnits（依作答順序）。
--   sections: [{ name, controlPoints: [{ text, assessingUnits?: [自評單位名稱] }] }]
-- 舊格式的單一 assessingUnit 不再接受（22023），免得舊的定義檔默默少了單位；同一題重複的單位 23505。
-- 其餘規則與回傳同 #15。
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
  if exists (
    select 1 from jsonb_array_elements(p_def -> 'sections') sec where coalesce(btrim(sec ->> 'name'), '') = ''
  ) or exists (
    select 1
    from jsonb_array_elements(p_def -> 'sections') sec, jsonb_array_elements(coalesce(sec -> 'controlPoints', '[]'::jsonb)) cp
    where coalesce(btrim(cp ->> 'text'), '') = ''
  ) then
    raise exception '範本 % 有空白的章節名稱或控制要點文字', v_code using errcode = '23514';
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
    insert into public.template_section (template_id, position, name)
    select v_id, t.ord, btrim(t.sec ->> 'name')
    from jsonb_array_elements(p_def -> 'sections') with ordinality as t(sec, ord)
    returning id, position
  )
  insert into public.control_point (section_id, position, text)
  select s.id, cp.ord, btrim(cp.item ->> 'text')
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

-- 現有資料：合併「每個單位各一個控制要點」的暫行轉法（Q90(5)） ----------------------------------------
-- 同一章節裡相鄰、文字完全相同的控制要點，合併成第一個控制要點，其他控制要點的自評單位依原本的順序接在後面，
-- 刪掉其他的，題號重編。範本（不分狀態，草稿途徑寫入的 03.1、04、05 共 15 列）與已發出的自評表一樣處理
-- （2026-10-19 使用者決定：已發出的都是測試資料；答案跟著搬到合併後的控制要點，作答人與時間不變）。
-- 同一段裡有重複的自評單位就不合併、只發 notice：那不是「一題多單位」，而是原檔真的重複了一題。

do $$
declare
  g        record;
  v_rest   uuid[];
begin
  for g in
    with ordered as (
      select cp.id, cp.section_id, cp.position,
             case when lag(cp.text) over w is distinct from cp.text then 1 else 0 end as starts
      from public.control_point cp
      window w as (partition by cp.section_id order by cp.position)
    ),
    runs as (
      select *, sum(starts) over (partition by section_id order by position) as run from ordered
    )
    select array_agg(id order by position) as ids
    from runs
    group by section_id, run
    having count(*) > 1
  loop
    v_rest := g.ids[2:];
    if (select count(*) <> count(distinct assessing_unit_id) from public.control_point_unit where control_point_id = any(g.ids)) then
      raise notice '範本控制要點 % 與後面相同文字的控制要點有重複的自評單位，不合併', g.ids[1];
      continue;
    end if;
    insert into public.control_point_unit (control_point_id, position, assessing_unit_id)
    select g.ids[1],
           coalesce((select max(position) from public.control_point_unit where control_point_id = g.ids[1]), 0)
             + row_number() over (order by k.ord, u.position),
           u.assessing_unit_id
    from unnest(v_rest) with ordinality as k(id, ord)
    join public.control_point_unit u on u.control_point_id = k.id;
    -- 刪除後由 #10 的觸發器把章節裡的題號重編成 1..n。
    delete from public.control_point where id = any(v_rest);
  end loop;
end
$$;

-- 快照沒有重編觸發器：題號的唯一約束改成陳述式結束才檢查，下面一次重編。
alter table public.assessment_control_point
  drop constraint assessment_control_point_section_id_position_key,
  add constraint assessment_control_point_section_id_position_key unique (section_id, position) deferrable initially immediate;

alter table public.assessment_answer disable trigger user;
do $$
declare
  g        record;
  v_rest   uuid[];
begin
  for g in
    with ordered as (
      select cp.id, cp.assessment_id, cp.section_id, cp.position,
             case when lag(cp.text) over w is distinct from cp.text then 1 else 0 end as starts
      from public.assessment_control_point cp
      window w as (partition by cp.section_id order by cp.position)
    ),
    runs as (
      select *, sum(starts) over (partition by section_id order by position) as run from ordered
    )
    select min(assessment_id::text)::uuid as assessment_id, array_agg(id order by position) as ids
    from runs
    group by section_id, run
    having count(*) > 1
  loop
    v_rest := g.ids[2:];
    if (select count(*) <> count(distinct assessing_unit_name) from public.assessment_control_point_unit where control_point_id = any(g.ids)) then
      raise notice '自評表控制要點 % 與後面相同文字的控制要點有重複的自評單位，不合併', g.ids[1];
      continue;
    end if;
    insert into public.assessment_control_point_unit (assessment_id, control_point_id, position, assessing_unit_name)
    select g.assessment_id, g.ids[1],
           coalesce((select max(position) from public.assessment_control_point_unit where control_point_id = g.ids[1]), 0)
             + row_number() over (order by k.ord, u.position),
           u.assessing_unit_name
    from unnest(v_rest) with ordinality as k(id, ord)
    join public.assessment_control_point_unit u on u.control_point_id = k.id;
    update public.assessment_answer set control_point_id = g.ids[1] where control_point_id = any(v_rest);
    delete from public.assessment_control_point where id = any(v_rest);
  end loop;

  update public.assessment_control_point cp
  set position = r.rn
  from (
    select id, row_number() over (partition by section_id order by position) as rn
    from public.assessment_control_point
  ) r
  where cp.id = r.id and cp.position <> r.rn;
end
$$;
alter table public.assessment_answer enable trigger user;

-- 合併與重編做完，題號的唯一約束改回原本的立即檢查：快照只在發起時寫入，不需要延後檢查。
alter table public.assessment_control_point
  drop constraint assessment_control_point_section_id_position_key,
  add constraint assessment_control_point_section_id_position_key unique (section_id, position);

