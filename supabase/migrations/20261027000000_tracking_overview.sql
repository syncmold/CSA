-- #14 追蹤總覽（Q95）。
--
-- 每張自評表一列：公司、廠區、範本、目前關卡、目前簽核人、進入目前關卡的時間與停留天數。只給稽核管理者：
-- security_invoker 讓自評表的 RLS 照常生效，另外以 is_audit_admin() 擋下其他人——一般簽核人看得到自己流程上的
-- 自評表，但追蹤總覽本身不給他們（#14 驗收「非稽核管理者看不到追蹤總覽」）。
--
-- 「進入目前關卡的時間」不另存欄位，由既有資料推出（Q95）：
--   這張自評表最後一筆簽核紀錄（送出、核准、退回，含已作廢的）的 signed_at；還沒有任何紀錄就是發起時間 created_at。
-- 目前關卡只會被送出、核准、退回移動，三者都經 record_signoff 寫一筆紀錄，所以最後一筆就是最近一次移動；
-- 退回本身是最後一筆，停留天數因此從退回重新算。已結案的，這個時間就是結案時間。
-- 換人、加簽（#13）若不移動目前關卡、也不寫簽核紀錄，停留天數不重算；#13 改寫簽核核心時要維持
-- 「每次移動目前關卡都留一筆有 signed_at 的紀錄」，否則要一起改這裡。
--
-- 停留天數以台北時間的日曆天計：今天 − 進入那天；結案後為空值。

create view public.tracking_assessment
with (security_invoker = true) as
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
  e.name                      as current_signer_name,
  m.entered_step_at,
  case when a.status = 'in_progress'
    then (now() at time zone 'Asia/Taipei')::date - (m.entered_step_at at time zone 'Asia/Taipei')::date
  end                         as days_at_step,
  case when a.status = 'closed' then m.entered_step_at end as closed_at
from public.assessment a
join public.annual_cycle c on c.id = a.cycle_id
join public.plant p on p.id = a.plant_id
join public.company co on co.id = p.company_id
join public.assessment_step s
  on s.assessment_id = a.id and s.position = a.current_step_position
left join public.employee_ref e on e.emp_id = s.signer_emp_id
cross join lateral (
  select coalesce(
    (select max(g.signed_at) from public.assessment_signoff g where g.assessment_id = a.id),
    a.created_at
  ) as entered_step_at
) m
where public.is_audit_admin();
comment on view public.tracking_assessment is
  '追蹤總覽（稽核管理者限定）：每張自評表的目前關卡、簽核人與停留天數；停留天數從最後一筆簽核紀錄或發起時間起算（Q95）。';

grant select on public.tracking_assessment to authenticated;
revoke all on public.tracking_assessment from anon;
