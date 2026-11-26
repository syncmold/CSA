-- 首頁「我參與的」提早列出還沒輪到的關卡（Q152，修訂 Q91 (2)）：發出後，流程上每個人都在「我參與的」看到自己有份的
-- 自評表，狀態「尚未輪到我」。可見性（Q81 (5)、Q85 (6)）不變：還沒輪到、也沒簽過的人看不到自評表的內容，這一列只有
-- 抬頭（年度、廠區、題庫編號與名稱、截止日），can_open＝false，畫面上不給連結；輪到他那一關才打得開。目前關卡也不給
-- （空值）：流程走到哪一關是表的內容，輪到他之前不知道。
--
-- 為什麼另寫一個 security definer 函式：my_assessment 是 security_invoker，自評表的 RLS 擋掉看不到的那幾張，
-- view 裡讀不到它們的抬頭。函式只回呼叫者自己有一關還沒輪到、而且看不到的簽核中自評表，不多給任何一張。
-- 抬頭的讀法與 my_assessment 的第一段相同（自評表 → 年度作業、廠區）；改一邊時另一邊一起改。

-- 我在流程上、還沒輪到、看不到內容的自評表：只有抬頭與階段（填寫中／簽核中）。
create function public.my_unopened_upcoming_assessments()
returns table (
  assessment_id uuid,
  year          integer,
  due_date      date,
  template_code text,
  template_name text,
  factory_code  text,
  plant_name    text,
  status        public.assessment_status,
  stage         public.assessment_stage
)
language sql
stable
security definer
set search_path = public
rows 10
as $$
  select a.id, c.year, c.due_date, a.template_code, a.template_name, p.factory_code, p.name, a.status,
         public.assessment_stage(a)
  from public.assessment a
  join public.annual_cycle c on c.id = a.cycle_id
  join public.plant p on p.id = a.plant_id
  -- 「還沒輪到」＝我的關卡是 pending，與 my_step_summary 的 my_step_ahead 同一個判斷
  where a.status = 'in_progress'
    and a.id in (select s.assessment_id from public.assessment_step s
                 where s.signer_emp_id = (select public.current_emp_id()) and s.state = 'pending')
    and a.id not in (select public.my_visible_assessment_ids())
$$;
comment on function public.my_unopened_upcoming_assessments() is
  '我在流程上、還沒輪到也沒簽過、所以看不到內容的簽核中自評表：只有抬頭與階段，給首頁「我參與的」列「尚未輪到我」（Q152）。'
  '抬頭的讀法與 view my_assessment 相同，改一邊時另一邊一起改。';

revoke execute on function public.my_unopened_upcoming_assessments() from public, anon;
grant execute on function public.my_unopened_upcoming_assessments() to authenticated;

-- 與 20261119000000 相同，再接上看不到內容的「尚未輪到我」，最後多 can_open（create or replace view 只能在最後加欄）。
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
  (m.my_step_position is not null) as my_turn,
  m.stage,
  public.taipei_days_until(m.due_date) as due_in_days,
  case
    when cardinality(m.my_units) > 0 then 'fill'
    when m.my_step_position is not null then 'sign'
    when m.status = 'in_progress' and m.my_step_ahead then 'upcoming'
    else 'done'
  end::public.my_assessment_part as my_part,
  m.my_answered,
  m.my_question_count,
  m.my_started,
  m.my_step_position,
  m.my_step_name,
  public.stays_on_home(m.status, m.year) as on_home,
  true as can_open
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
    cur.position      as current_step_position,
    cur.name          as current_step_name,
    public.assessment_stage(a) as stage,
    -- 答題的規則只在 my_editable_units：有值就是輪到我答這些自評單位。
    public.my_editable_units(a) as my_units,
    my.my_step_position,
    my.my_step_name,
    my.my_step_ahead,
    progress.my_answered,
    progress.my_question_count,
    progress.my_started
  from public.assessment a
  join public.annual_cycle c on c.id = a.cycle_id
  join public.plant p on p.id = a.plant_id
  -- lateral：依 (assessment_id, position) 讀那一關，RLS 只檢查這一列。
  cross join lateral (
    select s.position, s.name from public.assessment_step s
    where s.assessment_id = a.id and s.position = public.current_step_position(a)
  ) cur
  cross join lateral public.my_step_summary(a) my
  -- 只有輪到我答題的才數題目（其他列是空值，不是 0）。
  cross join lateral public.my_answer_progress(a) progress
  where a.id = mine.assessment_id
  offset 0
) m
union all
-- 看不到內容的「尚未輪到我」（抬頭由 my_unopened_upcoming_assessments 讀，與上面同一個讀法）：不是我的回合、
-- 沒有目前關卡與我的填寫進度；簽核中所以一定留在首頁。
select
  u.assessment_id,
  u.year,
  u.due_date,
  u.template_code,
  u.template_name,
  u.factory_code,
  u.plant_name,
  u.status,
  null::integer,
  null::text,
  false,
  u.stage,
  public.taipei_days_until(u.due_date),
  'upcoming'::public.my_assessment_part,
  null::integer,
  null::integer,
  null::boolean,
  null::integer,
  null::text,
  public.stays_on_home(u.status, u.year),
  false
from public.my_unopened_upcoming_assessments() u;
comment on view public.my_assessment is
  '我參與的自評表（我在流程上的）：一張一列，含階段、我的部分與我的填寫進度（Q115）；分流並行時我輪到好幾關也是一列（Q116）。'
  '還沒輪到、看不到內容的也列，my_part＝upcoming、can_open＝false，目前關卡是空值（Q152）。'
  'on_home＝留在首頁：最新年度的，加上任何年度還沒結案的；其餘（往年已結案）在自評表紀錄（Q124 (1)）。';
