-- 分派選人的名單改成「這一廠的自評表已經排過的人」（#218 第 2 步，Q133 (11) 規則 ④；使用者 2026-11-23）。
--
-- 原本選人讀 OMS 的 employees_picker（已被 OMS 刪除，Q133 (9)），讀不到時的退路是 plant_access_members：列出權限管理
-- 名單上所有人、不限廠區（Q132、Q134 暫行）。這份名單要保密，退路拿掉；改成兩種選法：
--   1. 從這一廠的自評表（不分年度）已經排過的人裡選：這些人的姓名，能分派這一廠的人本來就看得到（visible_people）。
--   2. 直接輸入完整工號，由 CSA 後端向 OMS 查（…/oms-people，people_lookup_limit）。
-- 選定之後照舊走 assign_step_signer。

drop function public.plant_access_members(text, text, integer);

create function public.plant_form_people(p_factory_code text)
returns table (emp_id text, name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_assign_plant(p_factory_code) then
    raise exception 'only the 廠區管理員 of this plant, a 稽核主管 or a 系統維護員 can list its people' using errcode = '42501';
  end if;

  return query
    select distinct s.signer_emp_id, e.name
      from public.assessment_step s
      join public.assessment a on a.id = s.assessment_id
      join public.plant p on p.id = a.plant_id
      left join public.employee_ref e on e.emp_id = s.signer_emp_id
     where p.factory_code = p_factory_code
       and s.signer_emp_id is not null
       -- 廠區分派的關卡：廠區端，加上稽核室不連動的一般關卡（子公司擔當稽核，Q143）；連動的稽核主管、台北稽核人員不列。
       and (s.step_group = 'plant' or s.link is null)
     order by 1;
end
$$;
comment on function public.plant_form_people(text) is
  '分派選人的名單（#218 規則 ④）：這一廠的自評表（不分年度）上、由廠區分派的關卡已經排過的人（工號、CSA 存的姓名）；'
  '只給這一廠的廠區管理員、稽核主管與系統維護員（can_assign_plant）。名單以外的人輸入完整工號向 OMS 查。';
revoke execute on function public.plant_form_people(text) from public, anon;
grant execute on function public.plant_form_people(text) to authenticated;
