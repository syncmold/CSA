-- 廠區負責人 (#100, Q116 (5)，暫定 OPEN-6)：稽核管理者在權限管理頁按廠區指定一位，系統不設代理。他唯讀看得到
-- 本廠所有自評表（含答案）；分派填寫人與換人是 #101。
--
-- 不是 audit_role 的一種：他照樣是一般使用者（或檢視者、稽核管理者），所以不放進 employee_ref.audit_role，也不和檢視者的
-- viewer_plant_ids 共用（那一欄非檢視者一律清空）。一個廠區一位（主鍵是廠區）；同一個人可以負責幾個廠區，
-- 這是最簡單的做法，不另外擋。人要先在放行名單上（外鍵），移出名單就一併卸任。
-- 規則全在這裡（ADR-0001）：表沒有 API 寫入授權，只能經下面兩個 security definer 函式寫，函式只給稽核管理者。

create table public.plant_coordinator (
  -- 廠區主檔要刪一個還有廠區負責人的廠區時擋下（23503）：先移除負責人，卸任那一筆才記得到廠區代碼。
  plant_id      uuid primary key references public.plant (id),
  emp_id        text not null references public.access_allowlist (emp_id) on delete cascade,
  assigned_at   timestamptz not null default now(),
  -- 指定者工號；部署指令沒有工號，留空。
  assigned_by   text
);
create index plant_coordinator_emp_id_idx on public.plant_coordinator (emp_id);
comment on table public.plant_coordinator is
  '廠區負責人（Q116 (5)）：每個廠區一位，看得到本廠所有自評表與答案（唯讀）；移出放行名單就一併卸任。';

alter table public.plant_coordinator enable row level security;
-- 稽核管理者看全部；廠區負責人看自己負責的廠區（#101 的選單與分派畫面用）。
create policy plant_coordinator_admin_or_self_read on public.plant_coordinator
  for select to authenticated
  using ((select public.is_audit_admin()) or emp_id = (select public.current_emp_id()));
-- Supabase 預設把新表的所有權限給 anon、authenticated、service_role；只留讀，寫入只經下面的函式。
revoke all on public.plant_coordinator from anon;
revoke insert, update, delete, truncate on public.plant_coordinator from authenticated;
grant select on public.plant_coordinator to authenticated;

-- 下面的異動紀錄是逐列觸發器，truncate 會跳過它。表沒有 API 寫入授權，兩個維護函式只改負責人、不改廠區。
create trigger plant_coordinator_no_truncate
  before truncate on public.plant_coordinator
  for each statement execute function public.forbid_bulk_or_rekey();

-- 指定或更換：那個廠區原本有人就換成這個人（前一人自動卸任）；本來就是他則什麼都不做。下面兩個維護函式共用，
-- 呼叫前各自檢查稽核管理者。廠區不在主檔回 23503（同檢視廠區），人不在放行名單回 P0002（同其他維護函式）。
create or replace function public.assign_plant_coordinator(p_plant_id uuid, p_emp_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.plant where id = p_plant_id) then
    raise exception '廠區 % 不在廠區主檔裡', p_plant_id using errcode = '23503';
  end if;
  if not exists (select 1 from public.access_allowlist where emp_id = p_emp_id) then
    raise exception '工號 % 不在放行名單上', p_emp_id using errcode = 'P0002';
  end if;
  insert into public.plant_coordinator (plant_id, emp_id, assigned_by)
  values (p_plant_id, p_emp_id, public.current_emp_id())
  on conflict (plant_id) do update
    set emp_id = excluded.emp_id, assigned_at = now(), assigned_by = excluded.assigned_by
    where plant_coordinator.emp_id <> excluded.emp_id;
end
$$;
comment on function public.assign_plant_coordinator(uuid, text) is
  '指定或更換廠區負責人（Q116 (5)），前一人自動卸任；不檢查呼叫者，只給 set_plant_coordinator 與 update_access_member 呼叫。';
revoke execute on function public.assign_plant_coordinator(uuid, text) from public, anon, authenticated;

create or replace function public.set_plant_coordinator(p_plant_id uuid, p_emp_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_audit_admin();
  perform public.assign_plant_coordinator(p_plant_id, upper(btrim(coalesce(p_emp_id, ''))));
end
$$;
comment on function public.set_plant_coordinator(uuid, text) is
  '權限管理：指定或更換廠區負責人（Q116 (5)）；只能是放行名單上的人。只給稽核管理者。';
revoke execute on function public.set_plant_coordinator(uuid, text) from public, anon;
grant execute on function public.set_plant_coordinator(uuid, text) to authenticated;

create or replace function public.remove_plant_coordinator(p_plant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_audit_admin();
  delete from public.plant_coordinator where plant_id = p_plant_id;
  if not found then
    raise exception '廠區 % 沒有廠區負責人', p_plant_id using errcode = 'P0002';
  end if;
end
$$;
comment on function public.remove_plant_coordinator(uuid) is '權限管理：移除廠區負責人，廠區從缺（Q116 (5)）。只給稽核管理者。';
revoke execute on function public.remove_plant_coordinator(uuid) from public, anon;
grant execute on function public.remove_plant_coordinator(uuid) to authenticated;

-- 權限異動紀錄（Q98 (7)）：指定、更換、移除各一筆，對象是那一筆裡成為（或不再是）廠區負責人的人；廠區記代碼
-- （快照）。更換只記一筆在接任的人身上，前一人寫在改前。移出放行名單的卸任也記（外鍵連帶刪除一樣觸發）。
-- 分派、換人、從缺是 #101 的事，不在這裡。
alter type public.access_change_action add value 'coordinator_assigned';
alter type public.access_change_action add value 'coordinator_replaced';
alter type public.access_change_action add value 'coordinator_removed';
comment on type public.access_change_action is
  '加入放行名單、移出放行名單、角色、檢視廠區、備註；指定、更換、移除廠區負責人。';

create or replace function public.log_plant_coordinator_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plant jsonb := jsonb_build_object('plant',
    (select factory_code from public.plant where id = case when tg_op = 'DELETE' then old.plant_id else new.plant_id end));
begin
  if tg_op = 'INSERT' then
    perform public.log_access_change(new.emp_id, 'coordinator_assigned', null, v_plant);
  elsif tg_op = 'DELETE' then
    perform public.log_access_change(old.emp_id, 'coordinator_removed', v_plant, null);
  elsif new.emp_id is distinct from old.emp_id then
    perform public.log_access_change(new.emp_id, 'coordinator_replaced',
      v_plant || jsonb_build_object('emp_id', old.emp_id, 'name', (select name from public.employee_ref where emp_id = old.emp_id)),
      v_plant);
  end if;
  return null;
end
$$;
create trigger plant_coordinator_log
  after insert or delete or update of emp_id on public.plant_coordinator
  for each row execute function public.log_plant_coordinator_change();

-- 看得到自評表 ---------------------------------------------------------------------------------------------
-- 廠區負責人看得到本廠所有自評表：can_view_assessment 多一條，其餘可見性（自評表頁、PDF、子表）都跟著它走；
-- 答案另外要 can_see_all_answers 也多一條，他才不受分流「單位送出後才看得到」的限制（#97，Q116 (9)）。
-- 作答、送出、核准、退回各自檢查目前關卡的簽核人，所以他只讀不寫（同檢視者）。

create or replace function public.coordinates_assessment_plant(p_assessment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.plant_coordinator pc
      join public.assessment a on a.plant_id = pc.plant_id
     where pc.emp_id = public.current_emp_id() and a.id = p_assessment_id
  )
$$;
comment on function public.coordinates_assessment_plant(uuid) is '呼叫者是這張自評表廠區的廠區負責人嗎（Q116 (5)）？';
revoke execute on function public.coordinates_assessment_plant(uuid) from public, anon, authenticated;

-- 與 20261030000000 相同，只多最後一條。
create or replace function public.can_view_assessment(p_assessment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_audit_admin()
      or public.is_signer_up_to_current_step(p_assessment_id)
      or public.signed_and_still_on_route(p_assessment_id)
      -- 一次查完：不是檢視者的人在 employee_ref 的主鍵查詢就結束，不必再讀自評表。
      or exists (
           select 1 from public.employee_ref e
             join public.assessment a on a.plant_id = any(e.viewer_plant_ids)
            where e.emp_id = public.current_emp_id() and e.audit_role = 'viewer' and a.id = p_assessment_id
         )
      or public.coordinates_assessment_plant(p_assessment_id)
$$;
comment on function public.can_view_assessment(uuid) is
  '稽核管理者、目前關卡與之前關卡的簽核人、簽過而且仍在流程上的人、檢視廠區包含這張自評表廠區的檢視者，'
  '以及這張自評表廠區的廠區負責人，才讀得到這張自評表。';

-- 與 20261109000000 相同，只多最後一條：廠區負責人和檢視者一樣，看得到本廠自評表每個單位的答案。
create or replace function public.can_see_all_answers(p_assessment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_audit_admin()
      or exists (
           select 1 from public.employee_ref e
             join public.assessment a on a.plant_id = any(e.viewer_plant_ids)
            where e.emp_id = public.current_emp_id() and e.audit_role = 'viewer' and a.id = p_assessment_id
         )
      or exists (
           select 1 from public.assessment_step s
           where s.assessment_id = p_assessment_id
             and s.branch_unit_name is null
             and s.signer_emp_id = public.current_emp_id()
             and (s.state <> 'pending'
                  or exists (select 1 from public.assessment_signoff g
                             where g.step_id = s.id and g.signer_emp_id = public.current_emp_id()))
         )
      or public.coordinates_assessment_plant(p_assessment_id)
$$;
comment on function public.can_see_all_answers(uuid) is
  '呼叫者不受「單位送出後才看得到」限制、看得到這張自評表全部答案：稽核管理者、檢視者、匯流後關卡輪到過或簽過的簽核人'
  '（Q116 (9)），以及這張自評表廠區的廠區負責人（Q116 (5)）。';

-- 權限管理頁（Q117）------------------------------------------------------------------------------------------
-- 人員清單多一欄負責廠區（只能加在最後）；編輯對話框和角色、檢視廠區一起改。

create or replace view public.access_member
with (security_invoker = true) as
select
  a.emp_id,
  e.name,
  e.factory_code,
  coalesce(e.audit_role, 'signer') as audit_role,
  coalesce(e.viewer_plant_ids, '{}') as viewer_plant_ids,
  a.note,
  a.added_at,
  a.added_by        as added_by_emp_id,
  b.name            as added_by_name,
  e.last_login_at,
  array(select pc.plant_id from public.plant_coordinator pc join public.plant p on p.id = pc.plant_id
         where pc.emp_id = a.emp_id order by p.sort_order nulls last, p.factory_code)
                    as coordinator_plant_ids
from public.access_allowlist a
left join public.employee_ref e on e.emp_id = a.emp_id
left join public.employee_ref b on b.emp_id = a.added_by;
comment on view public.access_member is
  '權限管理的人員清單（稽核管理者限定）：放行名單上的人與他們的角色、檢視廠區、負責廠區、最後使用時間。';

-- 多兩個參數，只送對話框裡有變的廠區，不送整份清單：兩位稽核管理者同時改時，後存的不會把先存的蓋掉。
-- p_coordinator_assign 是新加的廠區（別人負責的換成他），p_coordinator_unassign 是拿掉的廠區（只卸任他自己還負責的，
-- 這之間被別人接走的不動）。不給（null）就不動；預設值讓只送四個參數的呼叫照舊。
drop function public.update_access_member(text, public.audit_role, uuid[], text);
create function public.update_access_member(
  p_emp_id text,
  p_role public.audit_role,
  p_viewer_plant_ids uuid[],
  p_note text,
  p_coordinator_assign uuid[] default null,
  p_coordinator_unassign uuid[] default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp_id text := upper(btrim(coalesce(p_emp_id, '')));
  v_plant uuid;
begin
  perform public.require_audit_admin();
  if not exists (select 1 from public.access_allowlist where emp_id = v_emp_id) then
    raise exception '工號 % 不在放行名單上', v_emp_id using errcode = 'P0002';
  end if;
  update public.employee_ref
     set audit_role = p_role, viewer_plant_ids = coalesce(p_viewer_plant_ids, '{}')
   where emp_id = v_emp_id;
  if not found then
    -- 部署指令加入、還沒登入過的人沒有 employee_ref 那一列。
    insert into public.employee_ref (emp_id, audit_role, viewer_plant_ids)
    values (v_emp_id, p_role, coalesce(p_viewer_plant_ids, '{}'));
  end if;
  update public.access_allowlist set note = nullif(btrim(p_note), '') where emp_id = v_emp_id;

  delete from public.plant_coordinator where emp_id = v_emp_id and plant_id = any(coalesce(p_coordinator_unassign, '{}'));
  foreach v_plant in array coalesce(p_coordinator_assign, '{}') loop
    perform public.assign_plant_coordinator(v_plant, v_emp_id);
  end loop;
end
$$;
comment on function public.update_access_member(text, public.audit_role, uuid[], text, uuid[], uuid[]) is
  '權限管理：改放行名單上一個人的角色、檢視廠區、備註，以及（有給時）新加與拿掉的負責廠區（Q98、Q117）。只給稽核管理者。';
revoke execute on function public.update_access_member(text, public.audit_role, uuid[], text, uuid[], uuid[]) from public, anon;
grant execute on function public.update_access_member(text, public.audit_role, uuid[], text, uuid[], uuid[]) to authenticated;

-- 追蹤總覽（Q117 (3)）：廠區負責人看負責的廠區，同檢視者看檢視廠區。原本的 my_viewer_plant_ids() 只回檢視廠區，
-- 現在也回負責的廠區，所以改名 my_tracking_plant_ids()。tracking_assessment（view）綁的是函式本身，改名後照舊；
-- tracking_template 的函式本文寫的是名稱，下面照 20261106000000 重建，只換這個名稱與說明。
alter function public.my_viewer_plant_ids() rename to my_tracking_plant_ids;
create or replace function public.my_tracking_plant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array(
    select v.id from public.employee_ref e cross join unnest(e.viewer_plant_ids) as v(id)
     where e.emp_id = public.current_emp_id() and e.audit_role = 'viewer'
    union
    select pc.plant_id from public.plant_coordinator pc where pc.emp_id = public.current_emp_id()
  ), '{}')
$$;
comment on function public.my_tracking_plant_ids() is
  '追蹤總覽看得到的廠區（稽核管理者另外看全部）：呼叫者是檢視者時的檢視廠區，加上他負責的廠區（Q117 (3)）；都沒有就是空陣列。';

create or replace function public.tracking_template()
returns table (
  template_id         uuid,
  template_code       text,
  template_name       text,
  template_version    text,
  template_component  public.control_component,
  applies_to          uuid[]
)
language sql
stable
security definer
set search_path = public
as $$
  with me as materialized (
    select public.is_audit_admin() as all_plants, public.my_tracking_plant_ids() as plant_ids
  ),
  visible as (
    select p.id, p.factory_code from public.plant p cross join me
     where me.all_plants or p.id = any(me.plant_ids)
  ),
  applies as (
    select t.id as template_id, v.id as plant_id
      from public.questionnaire_template t
      join visible v
        on t.all_plants
        or exists (select 1 from public.template_plant tp where tp.template_id = t.id and tp.factory_code = v.factory_code)
     where t.status = 'active'
  ),
  used as (
    select distinct a.template_id from public.assessment a join visible v on v.id = a.plant_id
  )
  select t.id, t.code, t.name, t.version, t.component,
         coalesce((select array_agg(ap.plant_id order by ap.plant_id) from applies ap where ap.template_id = t.id), '{}')
    from public.questionnaire_template t
   where t.id in (select template_id from applies union select template_id from used)
$$;
comment on function public.tracking_template() is
  '追蹤總覽的範本（#86）：呼叫者看得到的廠區上，啟用中適用的範本與自評表用到的範本，各帶組成要素與適用的廠區（applies_to，'
  '只算啟用中的範本、照範本現在的設定）。稽核管理者看全部廠區，檢視者與廠區負責人看檢視廠區與負責的廠區，其他人拿到空清單。';

create or replace function public.tracking_signer_names()
returns table (emp_id text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select e.emp_id, e.name from public.employee_ref e
   where public.is_audit_admin() or public.current_audit_role() = 'viewer'
      or exists (select 1 from public.plant_coordinator pc where pc.emp_id = public.current_emp_id())
$$;
comment on function public.tracking_signer_names() is '追蹤總覽的簽核人姓名；只回給稽核管理者、檢視者與廠區負責人。';
