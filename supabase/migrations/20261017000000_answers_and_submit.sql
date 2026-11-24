-- 答題 (工單 #5)：自行檢查人員對自己自評單位的控制要點作答、填整體結論、暫存與送出。用語依 GLOSSARY.md。
--
-- 答案與整體結論屬於自評表（暫存屬於自評表，不屬於填答的人；換人後新的簽核人接續，#13）。
-- 誰能寫 (ADR-0001)：自評表目前關卡的簽核人，只能寫該關卡可編輯範圍那個自評單位的答案與整體結論；
-- 規則只寫在 my_editable_unit 一處（頁面也讀它決定哪幾列可輸入），RLS 的 insert/update policy 經 can_edit_unit 共用它，所以不論走「暫存」函式或直接
-- 對資料表寫入，越權一律被 RLS 拒絕 (42501)。結案、還沒輪到、已送出的關卡都不能寫。
-- 「送出」函式在資料庫驗證並推進關卡；前端只呈現它回傳的違規清單。簽核紀錄（誰在何時送出）由 #6 建立。

-- 答題欄位：依紙本表頭，值固定 (ADR-0005) --------------------------------------

create type public.design_status as enum ('has_rule', 'no_rule');
comment on type public.design_status is '內部控制制度設計：有內控規範／無內控規範（只有控制活動類）。';

create type public.execution_status as enum ('yes', 'no', 'not_applicable', 'no_case');
comment on type public.execution_status is
  '內部控制制度執行情形：是／否／不適用／無此情形；要素類只用是／否／不適用。';

create type public.satisfaction_level as enum ('very_satisfied', 'satisfied', 'adequate', 'needs_improvement', 'dissatisfied');
comment on type public.satisfaction_level is '設計、執行有效控制滿意度：非常滿意／滿意／剛好／需要加強／不滿意。';

create type public.conclusion_kind as enum ('satisfied', 'satisfied_except');
comment on type public.conclusion_kind is '整體結論：尚屬滿意／除下列事項外，尚屬滿意（後者必填說明）。';

-- 答案與整體結論 ----------------------------------------------------------------

-- 答案用 (assessment_id, control_point_id) 參照控制要點，保證答案的 assessment_id 與控制要點一致，
-- RLS 才能直接用答案上的 assessment_id 判斷可見性。
alter table public.assessment_control_point
  add constraint assessment_control_point_assessment_id_id_key unique (assessment_id, id);

create table public.assessment_answer (
  control_point_id  uuid primary key,
  assessment_id     uuid not null,
  design            public.design_status,
  execution         public.execution_status,
  satisfaction      public.satisfaction_level,
  -- 所需採行之改善措施／其他考量（要素類為補充說明）。
  improvement       text,
  updated_by        text,
  updated_at        timestamptz not null default now(),
  -- 與主鍵重複，但讓 PostgREST 把「控制要點 → 答案」認成一對一，頁面嵌入時拿到物件而不是陣列。
  unique (assessment_id, control_point_id),
  foreign key (assessment_id, control_point_id)
    references public.assessment_control_point (assessment_id, id) on delete cascade
);
create index assessment_answer_assessment_idx on public.assessment_answer (assessment_id);
comment on table public.assessment_answer is '答案：自評表上一個控制要點的作答；暫存時可以缺欄位，送出時才驗證。';

create table public.assessment_conclusion (
  assessment_id        uuid not null references public.assessment (id) on delete cascade,
  -- 自評單位存名稱，與快照一致 (ADR-0004)。
  assessing_unit_name  text not null,
  conclusion           public.conclusion_kind,
  -- 「除下列事項外」的事項說明。
  exceptions           text,
  updated_by           text,
  updated_at           timestamptz not null default now(),
  primary key (assessment_id, assessing_unit_name)
);
comment on table public.assessment_conclusion is '整體結論：自評表上一個自評單位的總評。';

-- 寫入規則 ----------------------------------------------------------------------

-- 可編輯範圍的唯一定義。參數是 assessment 列，所以 PostgREST 把它當成自評表的計算欄位：
-- 頁面 select `my_editable_unit` 就知道哪幾列要顯示輸入欄，前端不必再寫一份規則。
create or replace function public.my_editable_unit(a public.assessment)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.editable_unit_name
  from public.assessment_step s
  where s.assessment_id = a.id
    and s.position = a.current_step_position
    and a.status = 'in_progress'
    and s.signer_emp_id = public.current_emp_id()
$$;
comment on function public.my_editable_unit(public.assessment) is
  '呼叫者現在能作答的自評單位：簽核中、呼叫者是目前關卡的簽核人時，該關卡的可編輯範圍；否則空值（唯讀）。';

create or replace function public.can_edit_unit(p_assessment_id uuid, p_unit_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select public.my_editable_unit(a) = p_unit_name
    from public.assessment a
    where a.id = p_assessment_id
  ), false)
$$;
comment on function public.can_edit_unit(uuid, text) is '呼叫者現在能不能寫這張自評表上這個自評單位的答案與整體結論。';

create or replace function public.can_edit_control_point(p_control_point_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select public.can_edit_unit(cp.assessment_id, cp.assessing_unit_name)
    from public.assessment_control_point cp
    where cp.id = p_control_point_id
  ), false)
$$;
comment on function public.can_edit_control_point(uuid) is '呼叫者現在能不能作答這個控制要點（依它的自評單位）。';

-- 寫入時記下是誰寫的（不信任呼叫者送來的值）。
create or replace function public.stamp_writer()
returns trigger
language plpgsql
as $$
begin
  new.updated_by := public.current_emp_id();
  new.updated_at := now();
  return new;
end
$$;

-- 擋下版型沒有的選項：要素類沒有「內控設計」也沒有「無此情形」。
create or replace function public.check_answer_layout()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select template_layout from public.assessment where id = new.assessment_id) = 'element'
     and (new.design is not null or new.execution = 'no_case') then
    raise exception '要素類的控制要點沒有內控設計，執行情形只有是／否／不適用' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger assessment_answer_stamp
  before insert or update on public.assessment_answer
  for each row execute function public.stamp_writer();
create trigger assessment_answer_check_layout
  before insert or update on public.assessment_answer
  for each row execute function public.check_answer_layout();
create trigger assessment_conclusion_stamp
  before insert or update on public.assessment_conclusion
  for each row execute function public.stamp_writer();

alter table public.assessment_answer enable row level security;
alter table public.assessment_conclusion enable row level security;

-- 看得到自評表的人都看得到全部答案（其他單位的唯讀）；只有可編輯範圍內的能寫。
create policy assessment_answer_select_visible on public.assessment_answer
  for select to authenticated using (public.can_view_assessment(assessment_id));
create policy assessment_answer_insert_editable on public.assessment_answer
  for insert to authenticated with check (public.can_edit_control_point(control_point_id));
create policy assessment_answer_update_editable on public.assessment_answer
  for update to authenticated
  using (public.can_edit_control_point(control_point_id))
  with check (public.can_edit_control_point(control_point_id));

create policy assessment_conclusion_select_visible on public.assessment_conclusion
  for select to authenticated using (public.can_view_assessment(assessment_id));
create policy assessment_conclusion_insert_editable on public.assessment_conclusion
  for insert to authenticated with check (public.can_edit_unit(assessment_id, assessing_unit_name));
create policy assessment_conclusion_update_editable on public.assessment_conclusion
  for update to authenticated
  using (public.can_edit_unit(assessment_id, assessing_unit_name))
  with check (public.can_edit_unit(assessment_id, assessing_unit_name));

grant select, insert, update on public.assessment_answer, public.assessment_conclusion to authenticated;
revoke delete on public.assessment_answer, public.assessment_conclusion from authenticated;
revoke all on public.assessment_answer, public.assessment_conclusion from anon;

-- 暫存 --------------------------------------------------------------------------
-- 一次寫入多個控制要點的答案與整體結論（全部成功或全部不寫）。security invoker：越權由上面的 RLS 擋，
-- 這裡不另寫一份規則。每一列是整列取代：沒給的欄位存成空值。
--   p_answers      [{control_point_id, design, execution, satisfaction, improvement}, …]
--   p_conclusions  [{assessing_unit_name, conclusion, exceptions}, …]
-- 回傳 {ok:true, answers, conclusions}（寫入筆數）。與送出的先後順序見下方「送出」的鎖。

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
  insert into public.assessment_answer (control_point_id, assessment_id, design, execution, satisfaction, improvement)
  select x.control_point_id, p_assessment_id, x.design, x.execution, x.satisfaction, x.improvement
  from jsonb_to_recordset(coalesce(p_answers, '[]')) as x(
    control_point_id uuid,
    design public.design_status,
    execution public.execution_status,
    satisfaction public.satisfaction_level,
    improvement text
  )
  on conflict (control_point_id) do update
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
comment on function public.save_assessment_answers(uuid, jsonb, jsonb) is
  '暫存：寫入可編輯範圍內的答案與整體結論；越權由 RLS 拒絕。';

-- 送出 --------------------------------------------------------------------------
-- 自行檢查人員送出自己的關卡：驗證可編輯範圍那個自評單位的每個控制要點與整體結論，全部通過才推進到下一關。
-- 驗證規則（任一成立就是違規，同一個控制要點可以同時違反兩條）：
--   控制要點 unanswered            沒作答，或缺內控設計（控制活動類）、執行情形、滿意度任一欄
--   控制要點 improvement_required  勾「否」「無內控規範」「需要加強」「不滿意」卻沒填改善措施
--   整體結論 unanswered            沒選結論
--   整體結論 explanation_required  選「除下列事項外」卻沒填說明
-- 只填空白字元視同沒填。違規時回傳 {ok:false, error:'incomplete', violations:[…]}，什麼都不改：
--   {kind:'control_point', control_point_id, section_position, position, rule}
--   {kind:'conclusion', assessing_unit_name, rule}
-- 目前關卡沒有可編輯範圍（主管、稽核關卡，它們用 #6 的核准）回 {ok:false, error:'not_self_check_step'}。
-- 目前關卡已是最後一關回 {ok:false, error:'no_next_step'}：結案只發生在最後一關「核准」(#6)，
-- 自行檢查人員關卡排在最後是流程設錯，留給流程編輯器 (#11) 擋。
-- 成功回傳 {ok:true, current_step_position}（推進後的關卡）。
-- 呼叫者不是目前關卡的簽核人、自評表不存在或已結案，丟 42501。
--
-- 鎖：先鎖答案與整體結論兩張表 (share row exclusive)，等正在寫的交易（暫存函式或直接寫表）提交，
-- 並擋住新的寫入直到推進提交；被擋住的寫入在推進後才取得快照，RLS 看到的已是下一關而拒絕。
-- 這樣驗證過的內容就是送出的內容。鎖只持續一次送出的交易，期間其他自評表的暫存會短暫排隊。

create or replace function public.submit_assessment_step(p_assessment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a             public.assessment;
  s             public.assessment_step;
  v_violations  jsonb;
  v_next        integer;
begin
  lock table public.assessment_answer, public.assessment_conclusion in share row exclusive mode;

  select * into a from public.assessment where id = p_assessment_id for update;
  if not found or a.status <> 'in_progress' then
    raise exception 'this 自評表 is not open for submission' using errcode = '42501';
  end if;

  select * into s from public.assessment_step
  where assessment_id = a.id and position = a.current_step_position;
  if s.signer_emp_id is distinct from public.current_emp_id() then
    raise exception 'only the 簽核人 of the current 關卡 can submit it' using errcode = '42501';
  end if;
  if s.editable_unit_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_self_check_step');
  end if;

  select min(position) into v_next
  from public.assessment_step
  where assessment_id = a.id and position > a.current_step_position;
  if v_next is null then
    return jsonb_build_object('ok', false, 'error', 'no_next_step');
  end if;

  with points as (
    select cp.id, sec.position as section_position, cp.position,
           ans.design, ans.execution, ans.satisfaction, nullif(btrim(ans.improvement), '') as improvement
    from public.assessment_control_point cp
    join public.assessment_section sec on sec.id = cp.section_id
    left join public.assessment_answer ans on ans.control_point_id = cp.id
    where cp.assessment_id = a.id and cp.assessing_unit_name = s.editable_unit_name
  ),
  -- 排序鍵：控制要點依紙本順序（章、題、規則），整體結論排最後。
  violations as (
    select section_position, position, 1 as rule_order,
           jsonb_build_object('kind', 'control_point', 'control_point_id', id, 'section_position', section_position,
                              'position', position, 'rule', 'unanswered') as v
    from points
    where execution is null or satisfaction is null
       or (a.template_layout = 'control_activity' and design is null)
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
      on c.assessment_id = a.id and c.assessing_unit_name = s.editable_unit_name
    where c.conclusion is null
       or (c.conclusion = 'satisfied_except' and nullif(btrim(c.exceptions), '') is null)
  )
  select jsonb_agg(v order by section_position, position, rule_order) into v_violations
  from violations;

  if v_violations is not null then
    return jsonb_build_object('ok', false, 'error', 'incomplete', 'violations', v_violations);
  end if;

  update public.assessment set current_step_position = v_next where id = a.id;
  return jsonb_build_object('ok', true, 'current_step_position', v_next);
end
$$;
comment on function public.submit_assessment_step(uuid) is
  '送出（自行檢查人員）：驗證自己自評單位的答案與整體結論，通過才推進到下一關。';

revoke execute on function public.save_assessment_answers(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_assessment_answers(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.submit_assessment_step(uuid) from public, anon;
grant execute on function public.submit_assessment_step(uuid) to authenticated;
