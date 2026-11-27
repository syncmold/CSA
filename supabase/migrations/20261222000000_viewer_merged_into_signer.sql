-- Q153（#240）：取消「檢視者」角色，併入一般使用者。
--
-- 「檢視廠區」不再是一種角色，而是一般使用者（signer）身上一個選填的設定：有填的人，除了自己被排到的自評表，
-- 還看得到那些廠區的全部自評表與答案、進度追蹤（就是原本檢視者能看的）；沒填的人照舊。填寫、簽核照舊只看關卡。
-- 只有一般使用者能有檢視廠區；誰能設定不變（Q150：只有系統維護員，update_access_member／add_access_members 沒有動）。
--
-- 這支只做四件事：
--   1. 檢視廠區的規則從「只有檢視者能有」改成「只有一般使用者能有」（trigger 與 check）。
--   2. 既有的檢視者轉成一般使用者，檢視廠區原樣保留；人員異動紀錄每人留一筆「角色」（操作者是空的＝系統）。
--   3. viewer 這個 enum 值留著但不能再用（Postgres 不能從 enum 拿掉一個值；硬刪要重建型別與所有用到它的函式）。
--   4. my_tracking_plant_ids() 不再看角色，只看檢視廠區。它是唯一判斷「檢視者看得到哪些廠區」的地方，
--      my_plant_wide_assessment_ids、my_record_scope、tracking_template 與 view tracking_assessment 都經過它，
--      所以轉換前後同一個人看得到的資料相同。

-- 1. 先拿掉舊的 check，轉換才寫得進去。
alter table public.employee_ref drop constraint employee_ref_viewer_plants_only_for_viewers;

create or replace function public.normalize_viewer_plants()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_missing uuid;
begin
  if new.audit_role = 'viewer' then
    raise exception '檢視者角色已取消（Q153）：請設為一般使用者，再填檢視廠區' using errcode = '22023', hint = 'viewer_retired';
  end if;
  -- 只有一般使用者能有檢視廠區；換成別的角色就清空（他們看的範圍由負責廠區或全部廠區決定）。
  if new.audit_role <> 'signer' then
    new.viewer_plant_ids := '{}';
    return new;
  end if;
  new.viewer_plant_ids := coalesce(array(select distinct unnest(new.viewer_plant_ids) order by 1), '{}');
  select id into v_missing from unnest(new.viewer_plant_ids) as v(id)
   where not exists (select 1 from public.plant p where p.id = v.id) limit 1;
  if v_missing is not null then
    raise exception '檢視廠區 % 不在廠區主檔裡', v_missing using errcode = '23503';
  end if;
  return new;
end
$$;
comment on function public.normalize_viewer_plants() is
  '檢視廠區只給一般使用者（Q153）：其他角色清空；檢視者角色已取消，不能再設；廠區要在廠區主檔裡。';

-- 2. 既有的檢視者 → 一般使用者，檢視廠區不動。employee_ref_log_access 會替在放行名單上的人各記一筆「角色」。
update public.employee_ref set audit_role = 'signer' where audit_role = 'viewer';

-- 3. 規則寫成 check：trigger 被繞過（例如直接改資料）時也擋得住。
alter table public.employee_ref
  add constraint employee_ref_viewer_plants_only_for_signers
    check (audit_role = 'signer' or viewer_plant_ids = '{}'),
  add constraint employee_ref_viewer_role_retired
    check (audit_role <> 'viewer');

-- 4. 看得到整廠資料的廠區：自己的檢視廠區（只有一般使用者會有），加上自己負責的廠區。
create or replace function public.my_tracking_plant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array(
    select v.id from public.employee_ref e cross join unnest(e.viewer_plant_ids) as v(id)
     where e.emp_id = public.current_emp_id()
    union
    select pc.plant_id from public.plant_coordinator pc where pc.emp_id = public.current_emp_id()
  ), '{}')
$$;
comment on function public.my_tracking_plant_ids() is
  '進度追蹤看得到的廠區（稽核主管、系統維護員另外看全部）：呼叫者的檢視廠區（只有一般使用者會有，Q153），加上他負責的廠區（Q117 (3)）；都沒有就是空陣列。';
