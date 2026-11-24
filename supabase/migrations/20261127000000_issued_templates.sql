-- 範本管理依年度（工單 #173，Q128 (4)）：已發起的年度唯讀，題目取自當年發出的自評表快照。
--
-- issued_template：每張自評表一列＝某年度發給某廠區的那份範本，帶當年快照的編號、名稱、版型、版本與控制要點數，
-- 範本管理的已發起年度列表就讀它（第 2 張的簽核流程也用它找當年那張）。題目本身讀自評表的快照表
-- （assessment_section／assessment_control_point／assessment_control_point_unit），不另建資料。
--
-- security_invoker：看得到哪些全由自評表的讀取規則（my_visible_assessment_ids）決定，不另寫規則；稽核管理者與
-- 系統維護員看得到全部。組成要素取自來源範本（快照沒有存，範本讀不到的人拿到空值，他們本來就不用範本管理）。

create view public.issued_template
with (security_invoker = true) as
select
  a.id                 as assessment_id,
  c.year,
  a.template_id,
  a.plant_id,
  p.factory_code,
  a.template_code      as code,
  a.template_name      as name,
  a.template_layout    as layout,
  a.template_version   as version,
  t.component,
  (select count(*)::integer from public.assessment_control_point cp where cp.assessment_id = a.id) as control_point_count
from public.assessment a
join public.annual_cycle c on c.id = a.cycle_id
join public.plant p on p.id = a.plant_id
left join public.questionnaire_template t on t.id = a.template_id;
comment on view public.issued_template is
  '已發起年度的範本（Q128 (4)）：每張自評表一列，編號、名稱、版型、版本取自當年快照，control_point_count＝快照的控制要點數；呼叫者看得到的自評表才有列。';

grant select on public.issued_template to authenticated;
revoke all on public.issued_template from anon;
