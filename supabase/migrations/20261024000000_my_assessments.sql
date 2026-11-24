-- #37 首頁「我參與的自評表」（Q91）。
--
-- 列出目前登入者「在流程上、而且看得到」的自評表：正在簽、已簽過與已結案的。
-- 看不看得到不另寫規則：security_invoker 讓自評表的 RLS（can_view_assessment，Q81(5)、Q85(6)）照常生效，
-- 這裡只再加「目前是它某一關的簽核人」，所以稽核管理者也只列自己在流程上的（看全部自評表是 #14 追蹤總覽）；
-- 被換人 (#13) 換掉的人不再是任何一關的簽核人，自然不列。

create view public.my_assessment
with (security_invoker = true) as
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
  s.name            as current_step_name
from public.assessment a
join public.annual_cycle c on c.id = a.cycle_id
join public.plant p on p.id = a.plant_id
join public.assessment_step s
  on s.assessment_id = a.id and s.position = a.current_step_position
where exists (
  select 1 from public.assessment_step mine
  where mine.assessment_id = a.id and mine.signer_emp_id = public.current_emp_id()
);
comment on view public.my_assessment is
  '我參與的自評表：目前登入者在流程上、而且看得到的自評表（簽核中與結案）。';

grant select on public.my_assessment to authenticated;
revoke all on public.my_assessment from anon;
