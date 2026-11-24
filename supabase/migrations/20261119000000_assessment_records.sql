-- 自評表紀錄（工單 #164；Q124，修訂 Q91 (4)、Q115 的「我參與的」）：首頁只留當期，往年已結案的到新頁面
-- 「自評表紀錄」看。不刪任何資料，只是換地方顯示。
--
--   首頁     my_assessment 多一欄 on_home（stays_on_home）：最新年度（已發起的年度作業中最大的一年）的，加上任何年度
--            還沒結案的。看結案、不看截止日：逾期沒結案的正是要被看到的。首頁只讀 on_home 的列；往年已結案的只數張數
--            （my_past_closed_count，不經 my_assessment 那些逐列計算）。my_assessment 本身照舊列出我在流程上的全部，
--            我的待簽（my_pending_assessment）不受影響。
--   紀錄頁   assessment_record：看得到哪些全由自評表的讀取規則（my_visible_assessment_ids）決定，不另寫規則；
--            結案日＝結案的自評表最後一筆簽核紀錄（就是最後一關的核准）的時間，算法同追蹤總覽的 closed_at，不新增欄位。
--            my_record_scope()：標題旁的範圍標籤用，看全部，或因為角色看得到哪些廠區（其餘是自己在流程上的）。

-- 最新年度 ----------------------------------------------------------------------------------------------------

-- 年度作業所有登入的人都讀得到（20261015000000），不必 security definer。
create function public.latest_cycle_year()
returns integer
language sql
stable
set search_path = public
as $$
  select max(year) from public.annual_cycle
$$;
comment on function public.latest_cycle_year() is '最新年度：已發起的年度作業中最大的一年；還沒發起過是空值（Q124 (1)）。';

revoke execute on function public.latest_cycle_year() from public, anon;
grant execute on function public.latest_cycle_year() to authenticated;

-- 留在首頁的規則只寫這一次：首頁的清單（my_assessment.on_home）與往年已結案的張數都用它。
create function public.stays_on_home(p_status public.assessment_status, p_year integer)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_status = 'in_progress' or p_year = public.latest_cycle_year()
$$;
comment on function public.stays_on_home(public.assessment_status, integer) is
  '自評表留在首頁「我參與的」：還沒結案，或屬於最新年度（Q124 (1)）。';

revoke execute on function public.stays_on_home(public.assessment_status, integer) from public, anon;
grant execute on function public.stays_on_home(public.assessment_status, integer) to authenticated;

-- 首頁「我參與的」 -----------------------------------------------------------------------------------------------

-- 與 20261109000000 相同，只在最後多 on_home（create or replace view 只能在最後加欄）。
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
  public.stays_on_home(m.status, m.year) as on_home
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
) m;
comment on view public.my_assessment is
  '我參與的自評表（我在流程上而且看得到的）：一張一列，含階段、我的部分與我的填寫進度（Q115）；分流並行時我輪到好幾關也是一列（Q116）。'
  'on_home＝留在首頁：最新年度的，加上任何年度還沒結案的；其餘（往年已結案）在自評表紀錄（Q124 (1)）。';

-- 往年已結案的張數：首頁表格最下面那一行。從我在流程上的自評表出發（同 my_assessment），但不算階段與填寫進度。
create function public.my_past_closed_count()
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::int
  from public.my_route_assessment_ids() mine (assessment_id)
  join public.assessment a on a.id = mine.assessment_id
  join public.annual_cycle c on c.id = a.cycle_id
  where not public.stays_on_home(a.status, c.year)
$$;
comment on function public.my_past_closed_count() is '我在流程上、不在首頁的自評表張數（往年已結案的），在自評表紀錄看（Q124 (1)）。';

revoke execute on function public.my_past_closed_count() from public, anon;
grant execute on function public.my_past_closed_count() to authenticated;

-- 自評表紀錄 ---------------------------------------------------------------------------------------------------

-- security_invoker：自評表與簽核紀錄的 RLS 照舊套用，所以看得到的就是 my_visible_assessment_ids 那些（稽核管理者與
-- 系統維護員全部、檢視者的檢視廠區、廠區負責人負責的廠區、自己在流程上的，取聯集，Q117 (4)、Q122 (2)）。
create view public.assessment_record
with (security_invoker = true) as
select
  a.id               as assessment_id,
  c.year,
  co.id              as company_id,
  co.name            as company_name,
  p.id               as plant_id,
  p.factory_code,
  p.name             as plant_name,
  a.template_code,
  a.template_name,
  a.status,
  closed.closed_at
from public.assessment a
join public.annual_cycle c on c.id = a.cycle_id
join public.plant p on p.id = a.plant_id
join public.company co on co.id = p.company_id
left join lateral (
  select max(g.signed_at) as closed_at
  from public.assessment_signoff g
  where g.assessment_id = a.id
) closed on a.status = 'closed';
comment on view public.assessment_record is
  '自評表紀錄（Q124 (2)）：呼叫者看得到的全部自評表，不限年度；closed_at＝結案日（最後一筆簽核紀錄，即最後一關核准的時間），簽核中是空值。';

grant select on public.assessment_record to authenticated;
revoke all on public.assessment_record from anon;

-- 範圍標籤：和 my_plant_wide_assessment_ids 同一組條件，只是回答「看全部」與「哪些廠區」，不回自評表。
create function public.my_record_scope(out all_plants boolean, out plant_ids uuid[])
language sql
stable
security definer
set search_path = public
as $$
  select public.can_read_all(), public.my_tracking_plant_ids()
$$;
comment on function public.my_record_scope() is
  '自評表紀錄標題旁的範圍：all_plants＝看得到全部廠區（稽核管理者、系統維護員），否則 plant_ids＝因為角色看得到全部自評表的廠區'
  '（檢視廠區與負責的廠區），兩者以外是自己在流程上的。';

revoke execute on function public.my_record_scope() from public, anon;
grant execute on function public.my_record_scope() to authenticated;
