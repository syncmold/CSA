-- 稽核主管當廠區管理員時，台北稽核人員也連動他（Q140，2026-11-19 使用者決定；修訂 #187 定案第 1 點、20261205000000）。
--
-- 原本台北稽核人員只連動「角色是稽核人員」的廠區管理員。測試環境 12 個廠區的廠區管理員是稽核主管本人，這些廠的台北稽核
-- 人員都不連動；使用者決定規則讓稽核主管也算。結果是那幾廠的台北稽核人員與稽核主管是同一個人，各簽各的關卡。
--   規則   linked_signer('taipei_auditor')：那一廠的廠區管理員，角色是稽核人員或稽核主管（系統維護員不負責廠區，Q129）。
--   同步   角色改成稽核主管時，和改成稽核人員一樣，他負責的廠區的台北稽核人員換成他（sync_links_on_role）；不再是稽核主管
--          （接任時前一位降級）照舊不處理，保留原本的人（#187 定案第 3、4 點）。
--   現有   廠區管理員已經是稽核主管的廠區，在這裡同步一次：還沒簽的台北稽核人員關卡與流程上的台北稽核人員換成他，每一關記
--          一筆換人（同 sync_linked_steps）。

create or replace function public.linked_signer(p_link text, p_plant_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case p_link
    when 'taipei_auditor' then (
      select c.emp_id
      from public.plant_coordinator c
      join public.employee_ref e on e.emp_id = c.emp_id
      where c.plant_id = p_plant_id and e.audit_role in ('audit_staff', 'audit_admin')
    )
    when 'audit_chief' then public.audit_chief_emp_id()
  end
$$;
comment on function public.linked_signer(text, uuid) is
  '內部用：連動關卡現在該由誰簽（#187、#190）：台北稽核人員＝這一廠是稽核人員或稽核主管的廠區管理員（Q140），稽核主管＝現任'
  '稽核主管；不連動（一般關卡、廠區管理員是廠區端的人或從缺、稽核主管不是剛好一位）回空值。';

comment on function public.linked_now(public.route_step) is
  '連動關卡現在是否跟著權限管理（#190）：台北稽核人員要那一廠的廠區管理員是稽核人員或稽核主管（Q140），稽核主管要剛好一位；'
  '否就照流程上存的人、在流程編輯器裡選。一般關卡是否。PostgREST 計算欄位。';

create or replace function public.sync_links_on_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old    public.audit_role := case when tg_op = 'UPDATE' then old.audit_role end;
  v_plant  uuid;
begin
  if new.audit_role is not distinct from v_old then
    return null;
  end if;
  if new.audit_role in ('audit_staff', 'audit_admin') then
    for v_plant in select plant_id from public.plant_coordinator where emp_id = new.emp_id order by plant_id loop
      perform public.sync_linked_steps('taipei_auditor', v_plant);
    end loop;
  end if;
  if new.audit_role = 'audit_admin' or v_old is not distinct from 'audit_admin' then
    perform public.sync_linked_steps('audit_chief');
  end if;
  return null;
end
$$;
comment on function public.sync_links_on_role() is
  '角色改變時同步連動關卡（#190）：成為稽核人員或稽核主管 → 他負責的廠區的台北稽核人員（Q140）；稽核主管換人 → 全部廠區的稽核主管。';

do $$
declare
  v_plant uuid;
begin
  for v_plant in
    select c.plant_id
    from public.plant_coordinator c
    join public.employee_ref e on e.emp_id = c.emp_id
    where e.audit_role = 'audit_admin'
    order by c.plant_id
  loop
    perform public.sync_linked_steps('taipei_auditor', v_plant);
  end loop;
end
$$;
