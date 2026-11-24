-- 首頁改版（Q115）：「我的自評表」一張卡（待處理／我參與的，Q115 (6)）與稽核人員的各廠填單進度。
-- 待處理在畫面上不分填寫與簽核，資料庫仍分（my_part 的 fill／sign），每列的按鈕依它決定。
--
-- 首頁要的判斷都留在資料庫，前端只依欄位分頁、上色（ADR-0001）：
--   階段 stage        自評表停在哪一種關卡：填寫中（目前關卡有可編輯範圍，也就是答題關）／簽核中（只核准的關卡）／結案。
--                     「填寫中」只在 assessment_stage 定義一次，my_assessment 與 tracking_assessment 共用。
--   我的部分 my_part   fill＝輪到我答題（my_editable_unit 有值，答題規則仍只在那裡）；sign＝輪到我、這關只簽核；
--                     upcoming＝還沒輪到我（後面還有我的關卡，例如退回到我前面，或稽核管理者看得到但還沒到他）；
--                     done＝我的部分已完成（我的關卡都在目前關卡之前，或已結案）。
--   我的填寫進度       只在 fill：我這關的自評單位應答幾題、已答幾題；「已答」與送出時的「未作答」是同一條規則
--                     （answer_is_complete，送出也改用它）。整體結論不算題數。
--                     my_started＝動過沒有（任何一題填了任一欄，或寫了整體結論）：開始填寫／繼續填寫依它，
--                     只填了一半欄位、還沒有一題算答完的，也是「繼續填寫」。
--   距截止日天數       台北時間的日曆天，截止日 − 今天；負的就是逾期幾天（和停留天數一樣在資料庫算）。

-- 階段 ---------------------------------------------------------------------------------

create type public.assessment_stage as enum ('filling', 'signing', 'closed');
comment on type public.assessment_stage is '自評表停在哪一種關卡：填寫中（答題關）／簽核中（只核准的關卡）／結案（Q115）。';

-- p_editable_unit_name：目前關卡的可編輯範圍（assessment_step.editable_unit_name），有值就是答題關。
create function public.assessment_stage(p_status public.assessment_status, p_editable_unit_name text)
returns public.assessment_stage
language sql
immutable
as $$
  select case
    when p_status = 'closed' then 'closed'
    when p_editable_unit_name is not null then 'filling'
    else 'signing'
  end::public.assessment_stage
$$;
comment on function public.assessment_stage(public.assessment_status, text) is
  '「填寫中」的唯一定義：簽核中而且目前關卡有可編輯範圍（答題關）；其餘簽核中的是簽核中，結案是結案。';
revoke execute on function public.assessment_stage(public.assessment_status, text) from public, anon;
grant execute on function public.assessment_stage(public.assessment_status, text) to authenticated;

create function public.taipei_days_until(p_date date)
returns integer
language sql
stable
as $$
  select p_date - (now() at time zone 'Asia/Taipei')::date
$$;
comment on function public.taipei_days_until(date) is '從今天（台北時間）到這一天還有幾個日曆天；過了是負數。';
revoke execute on function public.taipei_days_until(date) from public, anon;
grant execute on function public.taipei_days_until(date) to authenticated;

-- 已答 ---------------------------------------------------------------------------------

create function public.answer_is_complete(
  p_layout        public.template_layout,
  p_design        public.design_status,
  p_execution     public.execution_status,
  p_satisfaction  public.satisfaction_level
)
returns boolean
language sql
immutable
as $$
  select p_execution is not null and p_satisfaction is not null
     and (p_layout <> 'control_activity' or p_design is not null)
$$;
comment on function public.answer_is_complete(public.template_layout, public.design_status, public.execution_status, public.satisfaction_level) is
  '一題（控制要點 × 自評單位）算不算答完：執行情形與滿意度都有，控制活動類還要有內控設計。送出的「未作答」與首頁的已答題數共用。';
revoke execute on function public.answer_is_complete(public.template_layout, public.design_status, public.execution_status, public.satisfaction_level) from public, anon;
grant execute on function public.answer_is_complete(public.template_layout, public.design_status, public.execution_status, public.satisfaction_level) to authenticated;

-- 送出：「未作答」改用 answer_is_complete，其餘與 20261025000000 相同。
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
    where not public.answer_is_complete(v_layout, design, execution, satisfaction)
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

-- 我的自評表 -----------------------------------------------------------------------------

create type public.my_assessment_part as enum ('fill', 'sign', 'upcoming', 'done');
comment on type public.my_assessment_part is
  '我在這張自評表的部分：輪到我答題／輪到我簽核／還沒輪到我／我的部分已完成（Q115）。';

-- 前 11 欄與 20261028000000 相同（create or replace view 只能在最後加欄），出發點與 lateral 的理由見那裡。
create or replace view public.my_assessment
with (security_invoker = true) as
select
  m.assessment_id,
  m.year,
  m.due_date,
  m.template_code,
  m.template_name,
  m.factory_code,
  m.plant_name,
  m.status,
  m.current_step_position,
  m.current_step_name,
  (m.status = 'in_progress' and m.current_signer_emp_id = public.current_emp_id()) as my_turn,
  public.assessment_stage(m.status, m.current_editable_unit) as stage,
  public.taipei_days_until(m.due_date) as due_in_days,
  case
    when m.my_unit is not null then 'fill'
    when m.status = 'in_progress' and m.current_signer_emp_id = public.current_emp_id() then 'sign'
    when m.status = 'in_progress' and m.my_step_ahead then 'upcoming'
    else 'done'
  end::public.my_assessment_part as my_part,
  progress.answered as my_answered,
  progress.total    as my_question_count,
  progress.started  as my_started
from public.my_route_assessment_ids() mine (assessment_id)
cross join lateral (
  select
    a.id              as assessment_id,
    c.year,
    c.due_date,
    a.template_code,
    a.template_name,
    p.factory_code,
    p.name            as plant_name,
    a.status,
    a.current_step_position,
    s.name            as current_step_name,
    s.signer_emp_id   as current_signer_emp_id,
    s.editable_unit_name as current_editable_unit,
    a.template_layout,
    -- 答題的規則只在 my_editable_unit：有值就是輪到我答這個自評單位。
    public.my_editable_unit(a) as my_unit,
    exists (
      select 1 from public.assessment_step later
      where later.assessment_id = a.id and later.position > a.current_step_position
        and later.signer_emp_id = public.current_emp_id()
    ) as my_step_ahead
  from public.assessment a
  join public.annual_cycle c on c.id = a.cycle_id
  join public.plant p on p.id = a.plant_id
  join public.assessment_step s
    on s.assessment_id = a.id and s.position = a.current_step_position
  where a.id = mine.assessment_id
  offset 0
) m
-- 只有輪到我答題的才數題目（on 條件讓其他列拿到空值，不是 0）。
left join lateral (
  select
    count(*)::int as total,
    count(*) filter (where public.answer_is_complete(m.template_layout, ans.design, ans.execution, ans.satisfaction))::int as answered,
    count(*) filter (
      where ans.design is not null or ans.execution is not null or ans.satisfaction is not null
         or nullif(btrim(ans.improvement), '') is not null
    ) > 0
    or exists (
      select 1 from public.assessment_conclusion c
      where c.assessment_id = m.assessment_id and c.assessing_unit_name = m.my_unit
    ) as started
  from public.assessment_control_point_unit u
  left join public.assessment_answer ans
    on ans.control_point_id = u.control_point_id and ans.assessing_unit_name = u.assessing_unit_name
  where u.assessment_id = m.assessment_id and u.assessing_unit_name = m.my_unit
) progress on m.my_unit is not null;
comment on view public.my_assessment is
  '我參與的自評表：目前登入者在流程上、而且看得到的自評表（簽核中與結案）；my_turn＝簽核中而且目前關卡是我；'
  'stage＝填寫中／簽核中／結案；my_part＝待填寫、待簽核、還沒輪到我、我的部分已完成；'
  'my_answered／my_question_count／my_started 只在待填寫時有值（我這關的自評單位；my_started＝動過沒有）；'
  'due_in_days＝距截止日的台北日曆天。';

-- 追蹤總覽：加上階段與距截止日天數（首頁的各廠填單進度用；前面的欄與 20261030000000 相同）。
create or replace view public.tracking_assessment
with (security_invoker = true) as
with me as materialized (
  select public.is_audit_admin() as all_plants, public.my_viewer_plant_ids() as plant_ids
)
select
  a.id                        as assessment_id,
  c.year,
  c.due_date,
  co.id                       as company_id,
  co.name                     as company_name,
  p.id                        as plant_id,
  p.factory_code,
  p.name                      as plant_name,
  a.template_id,
  a.template_code,
  a.template_name,
  a.template_version,
  a.status,
  a.current_step_position,
  (select count(*)::int from public.assessment_step n where n.assessment_id = a.id) as step_count,
  s.name                      as current_step_name,
  s.signer_emp_id             as current_signer_emp_id,
  n.name                      as current_signer_name,
  m.entered_step_at,
  case when a.status = 'in_progress'
    then (now() at time zone 'Asia/Taipei')::date - (m.entered_step_at at time zone 'Asia/Taipei')::date
  end                         as days_at_step,
  case when a.status = 'closed' then m.entered_step_at end as closed_at,
  public.assessment_stage(a.status, s.editable_unit_name) as stage,
  public.taipei_days_until(c.due_date) as due_in_days
from public.assessment a
join public.annual_cycle c on c.id = a.cycle_id
join public.plant p on p.id = a.plant_id
join public.company co on co.id = p.company_id
join public.assessment_step s
  on s.assessment_id = a.id and s.position = a.current_step_position
left join public.tracking_signer_names() n on n.emp_id = s.signer_emp_id
cross join me
cross join lateral (
  select coalesce(
    (select max(g.signed_at) from public.assessment_signoff g where g.assessment_id = a.id),
    a.created_at
  ) as entered_step_at
) m
where me.all_plants or a.plant_id = any(me.plant_ids);
comment on view public.tracking_assessment is
  '追蹤總覽（稽核管理者看全部、檢視者看檢視廠區）：每張自評表的目前關卡、簽核人與停留天數；停留天數從最後一筆簽核紀錄或發起時間起算（Q95）；'
  'stage＝填寫中／簽核中／結案，due_in_days＝距截止日的台北日曆天（Q115）。';
