-- #44 「我參與的自評表」「我的待簽」從「我的關卡」出發（Q96）。
--
-- 兩個 view 都是 security_invoker：自評表與關卡的 RLS（can_view_assessment）比 view 自己的「簽核人是我」先執行，
-- 所以原本的計畫是掃全部自評表、全部關卡，每一列都檢查一次可見性，隨結案的自評表越積越多（Q91 不限年度）。
-- 現在先由 my_route_assessment_ids() 走簽核人索引找出「我在流程上、看得到」的自評表 id，再接自評表，
-- RLS 就只檢查這幾張與它們的目前關卡。看不看得到仍只由 can_view_assessment 決定（ADR-0001、Q81(5)、Q85(6)、Q91），
-- 函式裡也用它過濾，所以函式回傳的不會比 my_assessment 本身多。
--
-- my_pending_assessment 改建在 my_assessment 上（簽核中、目前關卡是我），兩邊共同的欄位與 join 只寫在 my_assessment。
-- 欄位名稱不變（我的待簽仍是 step_position、step_name），前端與測試不受影響。

-- rows 10：告訴 planner 大約回傳幾張（一個人在流程上的自評表通常是個位數到幾十張；不寫的預設是 1000）。
-- 從這裡出發逐張讀已由下面的 lateral 固定，這個值只影響外層的成本估計，例如呼叫端再接別的表、排序時怎麼做。
create or replace function public.my_route_assessment_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
rows 10
as $$
  select distinct s.assessment_id
  from public.assessment_step s
  where s.signer_emp_id = public.current_emp_id()
    and public.can_view_assessment(s.assessment_id)
$$;
comment on function public.my_route_assessment_ids() is
  '目前登入者在流程上（某一關的簽核人）而且看得到的自評表 id；my_assessment 從這裡出發，RLS 才不必逐張檢查全庫。';

revoke execute on function public.my_route_assessment_ids() from public, anon;
grant execute on function public.my_route_assessment_ids() to authenticated;

drop view public.my_pending_assessment;

-- 欄位只能加在最後（create or replace view）；my_turn 是我的待簽的條件。
-- 每一張自評表（連同目前關卡、年度作業、廠區）在 lateral 子查詢裡依 id 讀，offset 0 讓 planner 不能把它攤平重排。
-- 否則統計值過時或呼叫端多加條件（例如依年度）時，planner 會改從年度作業、廠區掃全部自評表，
-- 或把年度作業放在最外層、每一列都重跑一次，RLS 的檢查跟著乘上去（兩種都實測過）。
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
  (m.status = 'in_progress' and m.current_signer_emp_id = public.current_emp_id()) as my_turn
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
    s.signer_emp_id   as current_signer_emp_id
  from public.assessment a
  join public.annual_cycle c on c.id = a.cycle_id
  join public.plant p on p.id = a.plant_id
  join public.assessment_step s
    on s.assessment_id = a.id and s.position = a.current_step_position
  where a.id = mine.assessment_id
  offset 0
) m;
comment on view public.my_assessment is
  '我參與的自評表：目前登入者在流程上、而且看得到的自評表（簽核中與結案）；my_turn＝簽核中而且目前關卡是我。';

-- 「輪到我的自評表」。稽核管理者看得到全部自評表，但待簽只列目前關卡是自己的，所以條件放在資料庫而不是前端。
create view public.my_pending_assessment
with (security_invoker = true) as
select
  assessment_id,
  year,
  due_date,
  template_code,
  template_name,
  factory_code,
  plant_name,
  current_step_position as step_position,
  current_step_name     as step_name
from public.my_assessment
where my_turn;
comment on view public.my_pending_assessment is '輪到目前登入者簽核的自評表（我的待簽）。';

grant select on public.my_pending_assessment to authenticated;
revoke all on public.my_pending_assessment from anon;
