-- 權限管理 (#58, Q98)：稽核管理者在畫面上維護放行名單、稽核角色與檢視者的廠區。
--
-- 規則全在這裡（ADR-0001）。access_allowlist 與 employee_ref 仍沒有 API 寫入授權：畫面只能經下面幾個
-- security definer 函式寫，而函式只給稽核管理者。

-- 加入者：畫面加入時是操作者的工號；部署指令與 db:set-role 沒有工號，留空。
alter table public.access_allowlist add column added_by text;
comment on column public.access_allowlist.added_by is '加入者工號；部署指令或 db:set-role 加入的是空值。';

-- 檢視者看得到的廠區（Q98 (6)），只能是 plant 主檔裡的；角色不是檢視者就是空的。
alter table public.employee_ref add column viewer_plant_ids uuid[] not null default '{}';
comment on column public.employee_ref.viewer_plant_ids is '檢視者看得到哪些廠區的全部自評表（plant.id）；角色不是檢視者時一律為空。';
-- 最後登入（Q98 (8)）：換證成功時更新；不是登入紀錄。分頁開著時每 45 分鐘續期也是換證，所以畫面上叫「最後使用」（Q99）。
alter table public.employee_ref add column last_login_at timestamptz;
comment on column public.employee_ref.last_login_at is '最後一次換證成功（登入或續期）的時間，畫面稱「最後使用」；空值＝尚未登入過。';

-- 檢視廠區的整理：角色不是檢視者就清空（Q98 (6)），去掉重複；每一個都要在 plant 主檔裡（陣列沒有外鍵，這裡檢查）。
-- 對所有身分都成立，部署指令與 db:set-role 也一樣。
create or replace function public.normalize_viewer_plants()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_missing uuid;
begin
  if new.audit_role <> 'viewer' then
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
create trigger employee_ref_normalize_viewer_plants
  before insert or update of audit_role, viewer_plant_ids on public.employee_ref
  for each row execute function public.normalize_viewer_plants();
alter table public.employee_ref add constraint employee_ref_viewer_plants_only_for_viewers
  check (audit_role = 'viewer' or viewer_plant_ids = '{}');

-- 至少剩一位稽核管理者（Q98 (4)）：「稽核管理者」是角色為 audit_admin、而且在放行名單上（換得到 session）的人。
-- 讓一位這樣的人不再是（降級、移出名單、刪掉 employee_ref）之後，若一位都不剩就拒絕（23514）。觸發器對所有身分都擋，
-- 含 service_role、部署指令與 db:set-role；兩個交易同時各降一位時，以 advisory lock 排隊，後到的看得到先到的結果。
-- 只檢查「讓一位稽核管理者消失」的變更，所以還沒有任何稽核管理者的新環境照樣能建第一位。
create or replace function public.guard_last_audit_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was_admin boolean;
begin
  if tg_table_name = 'employee_ref' then
    v_was_admin := old.audit_role = 'audit_admin'
      and exists (select 1 from public.access_allowlist where emp_id = old.emp_id);
  else
    v_was_admin := exists (select 1 from public.employee_ref where emp_id = old.emp_id and audit_role = 'audit_admin');
  end if;
  if not v_was_admin then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtext('csa.last_audit_admin'));
  if not exists (
    select 1 from public.employee_ref e join public.access_allowlist a on a.emp_id = e.emp_id
     where e.audit_role = 'audit_admin'
  ) then
    raise exception '至少要留一位稽核管理者' using errcode = '23514';
  end if;
  return null;
end
$$;
create trigger employee_ref_keep_an_audit_admin
  after update of audit_role or delete on public.employee_ref
  for each row when (old.audit_role = 'audit_admin')
  execute function public.guard_last_audit_admin();
create trigger access_allowlist_keep_an_audit_admin
  after delete on public.access_allowlist
  for each row execute function public.guard_last_audit_admin();

-- 上面的守門與權限異動紀錄都是逐列觸發器：truncate 會跳過它們，改工號會讓紀錄對不上人。兩者都不允許，
-- 要清掉名單用 delete（部署指令的 reset 是整個 schema 重建，不受影響）。
create or replace function public.forbid_bulk_or_rekey()
returns trigger
language plpgsql
as $$
begin
  raise exception '% 不能 truncate 或修改工號；請逐筆刪除或新增', tg_table_name using errcode = '42501';
end
$$;
create trigger access_allowlist_no_truncate
  before truncate on public.access_allowlist
  for each statement execute function public.forbid_bulk_or_rekey();
create trigger access_allowlist_no_rekey
  before update of emp_id on public.access_allowlist
  for each row when (new.emp_id is distinct from old.emp_id) execute function public.forbid_bulk_or_rekey();
create trigger employee_ref_no_truncate
  before truncate on public.employee_ref
  for each statement execute function public.forbid_bulk_or_rekey();
create trigger employee_ref_no_rekey
  before update of emp_id on public.employee_ref
  for each row when (new.emp_id is distinct from old.emp_id) execute function public.forbid_bulk_or_rekey();

-- 只有稽核管理者能維護；呼叫者不是就 42501。
create or replace function public.require_audit_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_audit_admin() then
    raise exception '只有稽核管理者能維護權限' using errcode = '42501';
  end if;
end
$$;
revoke execute on function public.require_audit_admin() from public, anon, authenticated;

-- 加入（Q98 (3)）：p_people 是畫面在 OMS employees_picker 找到的人 [{emp_id, name, factory_code}]（CSA 的資料庫
-- 連不到 OMS，名單上沒有的工號由畫面擋下，不會送來）。已在放行名單的略過；沒登入過的人先建 employee_ref
-- 那一列並寫入角色，姓名與廠區先存 OMS 的值，第一次登入由換證更新。已有那一列的人，角色與檢視廠區改成這一批的。
create or replace function public.add_access_members(
  p_people jsonb,
  p_role public.audit_role,
  p_viewer_plant_ids uuid[],
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_person jsonb;
  v_emp_id text;
  v_added text[] := '{}';
  v_skipped text[] := '{}';
begin
  perform public.require_audit_admin();
  if jsonb_typeof(p_people) is distinct from 'array' then
    raise exception 'p_people 要是陣列' using errcode = '22023';
  end if;

  for v_person in select * from jsonb_array_elements(p_people)
  loop
    v_emp_id := upper(btrim(coalesce(v_person ->> 'emp_id', '')));
    if v_emp_id = '' then
      raise exception '工號不能空白' using errcode = '22023';
    end if;
    -- 同一批貼了兩次的工號只算一次。
    continue when v_emp_id = any(v_added) or v_emp_id = any(v_skipped);
    if exists (select 1 from public.access_allowlist where emp_id = v_emp_id) then
      v_skipped := v_skipped || v_emp_id;
      continue;
    end if;

    insert into public.employee_ref (emp_id, name, factory_code, audit_role, viewer_plant_ids)
    values (v_emp_id, nullif(btrim(v_person ->> 'name'), ''), nullif(btrim(v_person ->> 'factory_code'), ''),
            p_role, coalesce(p_viewer_plant_ids, '{}'))
    on conflict (emp_id) do update set audit_role = excluded.audit_role, viewer_plant_ids = excluded.viewer_plant_ids;

    insert into public.access_allowlist (emp_id, note, added_by)
    values (v_emp_id, nullif(btrim(p_note), ''), public.current_emp_id());
    v_added := v_added || v_emp_id;
  end loop;

  return jsonb_build_object('added', to_jsonb(v_added), 'skipped', to_jsonb(v_skipped));
end
$$;
comment on function public.add_access_members(jsonb, public.audit_role, uuid[], text) is
  '權限管理：把 OMS 名單上找到的人加入放行名單並設角色（Q98 (3)）；已在名單的略過。只給稽核管理者。';
revoke execute on function public.add_access_members(jsonb, public.audit_role, uuid[], text) from public, anon;
grant execute on function public.add_access_members(jsonb, public.audit_role, uuid[], text) to authenticated;

-- 修改（Q98 (2)(6)）：角色、檢視廠區、備註一次改。只改得到放行名單上的人。
create or replace function public.update_access_member(
  p_emp_id text,
  p_role public.audit_role,
  p_viewer_plant_ids uuid[],
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp_id text := upper(btrim(coalesce(p_emp_id, '')));
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
end
$$;
comment on function public.update_access_member(text, public.audit_role, uuid[], text) is
  '權限管理：改放行名單上一個人的角色、檢視廠區與備註（Q98）。只給稽核管理者。';
revoke execute on function public.update_access_member(text, public.audit_role, uuid[], text) from public, anon;
grant execute on function public.update_access_member(text, public.audit_role, uuid[], text) to authenticated;

-- 移除（Q98 (5)）＝移出放行名單，角色改回簽核人、清空檢視廠區；employee_ref 保留（簽核歷程與追蹤總覽要姓名）。
-- 先移出名單、再改角色，權限異動紀錄只記一筆「移除」（改前帶著角色與檢視廠區）。
create or replace function public.remove_access_member(p_emp_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp_id text := upper(btrim(coalesce(p_emp_id, '')));
begin
  perform public.require_audit_admin();
  delete from public.access_allowlist where emp_id = v_emp_id;
  if not found then
    raise exception '工號 % 不在放行名單上', v_emp_id using errcode = 'P0002';
  end if;
  update public.employee_ref set audit_role = 'signer', viewer_plant_ids = '{}' where emp_id = v_emp_id;
end
$$;
comment on function public.remove_access_member(text) is
  '權限管理：移出放行名單，角色改回簽核人、清空檢視廠區（Q98 (5)）。只給稽核管理者。';
revoke execute on function public.remove_access_member(text) from public, anon;
grant execute on function public.remove_access_member(text) to authenticated;

-- 移除前的提醒（Q98 (5)）：簽核中的自評表上目前輪到他（current）、之後輪到他（later）的關卡，以及啟用中的
-- 簽核流程用到他的關卡（route）。只提醒、不擋；換人是 #13。
create or replace function public.access_removal_impact(p_emp_id text)
returns table (
  kind            text,
  assessment_id   uuid,
  route_id        uuid,
  year            integer,
  template_code   text,
  template_name   text,
  factory_code    text,
  plant_name      text,
  step_position   integer,
  step_name       text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_audit_admin();
  return query
    select case when s.position = a.current_step_position then 'current' else 'later' end,
           a.id, null::uuid, c.year, a.template_code, a.template_name, p.factory_code, p.name, s.position, s.name
      from public.assessment_step s
      join public.assessment a on a.id = s.assessment_id
      join public.annual_cycle c on c.id = a.cycle_id
      join public.plant p on p.id = a.plant_id
     where s.signer_emp_id = upper(btrim(p_emp_id))
       and a.status = 'in_progress'
       and s.position >= a.current_step_position
    union all
    select 'route', null::uuid, r.id, null::integer, t.code, t.name, p.factory_code, p.name, rs.position, rs.name
      from public.route_step rs
      join public.approval_route r on r.id = rs.route_id
      join public.questionnaire_template t on t.id = r.template_id
      join public.plant p on p.id = r.plant_id
     where rs.signer_emp_id = upper(btrim(p_emp_id))
       and r.status = 'active'
    order by 1, 4, 7, 5, 9;
end
$$;
comment on function public.access_removal_impact(text) is
  '移除確認框的提醒：簽核中自評表上目前／之後輪到這個人的關卡，與啟用中流程用到他的關卡（Q98 (5)）。只給稽核管理者。';
revoke execute on function public.access_removal_impact(text) from public, anon;
grant execute on function public.access_removal_impact(text) to authenticated;

-- 人員清單（Q98 (1)）：一個工號一列。security_invoker：放行名單的 RLS 只給稽核管理者，其他人拿到空清單。
create view public.access_member
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
  e.last_login_at
from public.access_allowlist a
left join public.employee_ref e on e.emp_id = a.emp_id
left join public.employee_ref b on b.emp_id = a.added_by;
comment on view public.access_member is '權限管理的人員清單（稽核管理者限定）：放行名單上的人與他們的角色、檢視廠區、最後使用時間。';
grant select on public.access_member to authenticated;
revoke all on public.access_member from anon;

-- 權限異動紀錄（Q98 (7)）------------------------------------------------------------------------------------
-- 放行名單的加入與移除、角色、檢視廠區、備註，每次變更一筆。由觸發器寫入，所以畫面、部署指令、db:set-role
-- 都留紀錄；指令沒有工號，操作者是空值（畫面顯示「部署指令」）。換證更新姓名與廠區不算異動。
-- 角色與檢視廠區只記放行名單上的人：加入那一筆帶著加入時的角色與檢視廠區，移除那一筆帶著移除前的，
-- 所以畫面加入、移除各只有一筆。檢視廠區記廠區代碼（快照，之後廠區改名不影響）。

create type public.access_change_action as enum ('added', 'removed', 'role', 'viewer_plants', 'note');
comment on type public.access_change_action is '加入放行名單、移出放行名單、角色、檢視廠區、備註。';

create table public.access_change_log (
  id              bigint generated always as identity primary key,
  changed_at      timestamptz not null default now(),
  actor_emp_id    text,
  actor_name      text,
  target_emp_id   text not null,
  target_name     text,
  action          public.access_change_action not null,
  before          jsonb,
  after           jsonb
);
create index access_change_log_changed_at_idx on public.access_change_log (changed_at desc);
comment on table public.access_change_log is
  '權限異動紀錄（Q98 (7)）：只新增，任何身分都不能改或刪；只有稽核管理者讀得到。操作者空值＝部署指令或 db:set-role。';

alter table public.access_change_log enable row level security;
create policy access_change_log_audit_admin_read on public.access_change_log
  for select to authenticated using (public.is_audit_admin());
-- Supabase 預設把新表的所有權限給 anon、authenticated、service_role；只留稽核管理者讀，寫入只經觸發器。
revoke all on public.access_change_log from anon;
revoke insert, update, delete, truncate on public.access_change_log from authenticated, service_role;
grant select on public.access_change_log to authenticated;

create or replace function public.forbid_access_change_log_edit()
returns trigger
language plpgsql
as $$
begin
  raise exception '權限異動紀錄只能新增，不能修改或刪除' using errcode = '42501';
end
$$;
create trigger access_change_log_append_only
  before update or delete on public.access_change_log
  for each row execute function public.forbid_access_change_log_edit();
create trigger access_change_log_no_truncate
  before truncate on public.access_change_log
  for each statement execute function public.forbid_access_change_log_edit();

-- 檢視廠區的快照：廠區代碼，依代碼排序。
create or replace function public.viewer_plant_codes(p_plant_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(p.factory_code order by p.factory_code), '[]'::jsonb)
    from public.plant p where p.id = any(coalesce(p_plant_ids, '{}'))
$$;
revoke execute on function public.viewer_plant_codes(uuid[]) from public, anon, authenticated;

create or replace function public.log_access_change(
  p_target text,
  p_action public.access_change_action,
  p_before jsonb,
  p_after jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.access_change_log (actor_emp_id, actor_name, target_emp_id, target_name, action, before, after)
  select public.current_emp_id(),
         (select name from public.employee_ref where emp_id = public.current_emp_id()),
         p_target,
         (select name from public.employee_ref where emp_id = p_target),
         p_action, p_before, p_after
$$;
revoke execute on function public.log_access_change(text, public.access_change_action, jsonb, jsonb) from public, anon, authenticated;

-- 一個人在放行名單上的權限快照：角色、檢視廠區、備註。還沒有 employee_ref 的人是簽核人。
create or replace function public.access_snapshot(p_emp_id text, p_note text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'role', coalesce((select audit_role::text from public.employee_ref where emp_id = p_emp_id), 'signer'),
    'viewer_plants', public.viewer_plant_codes((select viewer_plant_ids from public.employee_ref where emp_id = p_emp_id)),
    'note', p_note
  )
$$;
-- 只給觸發器用：它繞過 employee_ref 的 RLS，不能讓簽核人經 /rpc 讀別人的角色。
revoke execute on function public.access_snapshot(text, text) from public, anon, authenticated;

create or replace function public.log_allowlist_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_access_change(new.emp_id, 'added', null, public.access_snapshot(new.emp_id, new.note));
  elsif tg_op = 'DELETE' then
    perform public.log_access_change(old.emp_id, 'removed', public.access_snapshot(old.emp_id, old.note), null);
  elsif new.note is distinct from old.note then
    perform public.log_access_change(new.emp_id, 'note', to_jsonb(old.note), to_jsonb(new.note));
  end if;
  return null;
end
$$;
create trigger access_allowlist_log
  after insert or delete or update of note on public.access_allowlist
  for each row execute function public.log_allowlist_change();

create or replace function public.log_employee_access_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_role public.audit_role := case when tg_op = 'UPDATE' then old.audit_role else 'signer' end;
  v_old_plants uuid[] := case when tg_op = 'UPDATE' then old.viewer_plant_ids else '{}' end;
begin
  if not exists (select 1 from public.access_allowlist where emp_id = new.emp_id) then
    return null;
  end if;
  if new.audit_role is distinct from v_old_role then
    perform public.log_access_change(new.emp_id, 'role', to_jsonb(v_old_role), to_jsonb(new.audit_role));
  end if;
  if new.viewer_plant_ids is distinct from v_old_plants then
    perform public.log_access_change(new.emp_id, 'viewer_plants',
      public.viewer_plant_codes(v_old_plants), public.viewer_plant_codes(new.viewer_plant_ids));
  end if;
  return null;
end
$$;
create trigger employee_ref_log_access
  after insert or update of audit_role, viewer_plant_ids on public.employee_ref
  for each row execute function public.log_employee_access_change();

-- 換證成功（Q98 (8)）：建立或更新員工參照的姓名與廠區，記下最後登入時間；角色與檢視廠區不動。
-- 只給換證服務（service_role）。
create or replace function public.record_login(p_emp_id text, p_name text, p_factory_code text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.employee_ref (emp_id, name, factory_code, last_login_at)
  values (p_emp_id, p_name, p_factory_code, now())
  on conflict (emp_id) do update
    set name = excluded.name, factory_code = excluded.factory_code, last_login_at = excluded.last_login_at
$$;
comment on function public.record_login(text, text, text) is
  '換證成功：更新員工參照的姓名、廠區與最後登入時間（Q98 (8)）。只給換證服務（service_role）呼叫。';
revoke execute on function public.record_login(text, text, text) from public, anon, authenticated;
grant execute on function public.record_login(text, text, text) to service_role;

-- 檢視者（Q98 (6)）----------------------------------------------------------------------------------------
-- 看得到檢視廠區的全部自評表：can_view_assessment 多一條，其餘可見性（自評表頁、PDF、子表）都跟著它走，
-- 不另寫規則。作答、送出、核准、退回各自檢查「目前關卡的簽核人」，不看 can_view_assessment，所以檢視者
-- 只讀不寫；他若也在某條流程上，照簽核人的規則簽自己那一關。角色或檢視廠區一改，下一個請求就生效。

create or replace function public.my_viewer_plant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select viewer_plant_ids from public.employee_ref
      where emp_id = public.current_emp_id() and audit_role = 'viewer'),
    '{}')
$$;
comment on function public.my_viewer_plant_ids() is '呼叫者是檢視者時，他的檢視廠區；否則是空陣列。';
-- 追蹤總覽（security_invoker）以呼叫者身分執行它，所以留給 authenticated；它只回呼叫者自己的檢視廠區。
revoke execute on function public.my_viewer_plant_ids() from public, anon;

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
$$;
comment on function public.can_view_assessment(uuid) is
  '稽核管理者、目前關卡與之前關卡的簽核人、簽過而且仍在流程上的人，以及檢視廠區包含這張自評表廠區的檢視者，才讀得到這張自評表。';

-- 追蹤總覽：稽核管理者看全部，檢視者只看檢視廠區（他以簽核人身分看得到的其他廠區不列進來）。
-- 列仍先經自評表的 RLS（security_invoker）。呼叫者的角色與檢視廠區在 view 裡只查一次（materialized CTE），不逐列查。
-- 目前簽核人的姓名原本直接 join employee_ref，但檢視者只讀得到自己那一列，所以改由下面這個函式一次給齊：
-- 只回給稽核管理者與檢視者（姓名本來就在 OMS 的 employees_picker 公開）。
create or replace function public.tracking_signer_names()
returns table (emp_id text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select e.emp_id, e.name from public.employee_ref e
   where public.is_audit_admin() or public.current_audit_role() = 'viewer'
$$;
comment on function public.tracking_signer_names() is '追蹤總覽的簽核人姓名；只回給稽核管理者與檢視者。';
revoke execute on function public.tracking_signer_names() from public, anon;

create or replace view public.tracking_assessment
with (security_invoker = true) as
with me as materialized (
  select public.is_audit_admin() as all_plants, public.my_viewer_plant_ids() as plant_ids
)
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
  n.name                      as current_signer_name,
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
left join public.tracking_signer_names() n on n.emp_id = s.signer_emp_id
cross join me
cross join lateral (
  select coalesce(
    (select max(g.signed_at) from public.assessment_signoff g where g.assessment_id = a.id),
    a.created_at
  ) as entered_step_at
) m
where me.all_plants or a.plant_id = any(me.plant_ids);
comment on view public.tracking_assessment is
  '追蹤總覽（稽核管理者看全部、檢視者看檢視廠區）：每張自評表的目前關卡、簽核人與停留天數；停留天數從最後一筆簽核紀錄或發起時間起算（Q95）。';
