-- 稽核角色重整的規則 (#187、#188)。enum 值在上一個 migration 加好了。
--
-- 稽核主管（audit_admin）剛好一位：
--   * 設定新的稽核主管時，前一位自動降為一般使用者（hand_over_audit_admin），權限異動紀錄記一筆「接任稽核主管」在接手的人身上，
--     前任寫在內容裡（比照更換廠區管理員）；降級那一列不另外記「角色」。
--   * 只有系統維護員能設定稽核主管（require_may_manage 原本就是，Q122 (3)）。
--   * 不用 unique index：測試環境現在有多位稽核主管，migration 不能失敗；規則放在設定函式裡。現有多位的資料不由這裡改，
--     下一次設定新的稽核主管時一併降級，或由部署步驟另外處理。
--   * 「至少留一位」（guard_last_holder）保留：稽核主管不會變成零位；換人時新的先成為稽核主管、再降前任，所以不會被它擋。
--
-- 稽核人員（audit_staff）：稽核主管與系統維護員都能設定（require_may_manage 只擋稽核主管與系統維護員兩種，稽核人員不在內）。
-- 這個 migration 不給他任何新的讀寫權限：沒負責廠區時同一般使用者；被指定為廠區管理員時，看得到與能做的照現有廠區管理員規則。
-- 他在流程上的「台北稽核人員」關卡連動、匯出 Excel 由後面的工單做。

-- 接任稽核主管 -------------------------------------------------------------------------------------------------

-- 讓 p_new 成為唯一的稽核主管：其餘的稽核主管降為一般使用者並記一筆。p_new 必須已經是稽核主管而且在放行名單上
-- （呼叫者先寫好），否則「至少留一位」會擋下降級。沒有其他稽核主管就什麼都不做。
create or replace function public.hand_over_audit_admin(p_new text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev jsonb;
begin
  -- 兩位系統維護員同時各設一位新的稽核主管時排隊（同「至少留一位」的鎖），後到的看得到先到的並把他降級，結果仍然只有一位。
  -- 設定函式已經先拿了這把鎖（同一交易重複拿不會卡），這裡再拿一次是給之後別的呼叫者的保險。
  perform pg_advisory_xact_lock(hashtext('csa.last_audit_admin'));
  select jsonb_agg(jsonb_build_object('emp_id', emp_id, 'name', name) order by emp_id)
    into v_prev
    from public.employee_ref
   where audit_role = 'audit_admin' and emp_id <> p_new;
  if v_prev is null then
    perform set_config('csa.audit_admin_handover', '', true);
    return;
  end if;

  -- 降級那幾列不另外記「角色」異動，改記下面那一筆（異動紀錄的觸發器看這個設定）。
  perform set_config('csa.audit_admin_handover', p_new, true);
  update public.employee_ref set audit_role = 'signer' where audit_role = 'audit_admin' and emp_id <> p_new;
  perform set_config('csa.audit_admin_handover', '', true);

  -- 前任寫在內容裡：第一位放在 emp_id、name（同更換廠區管理員），測試環境若原本有多位，其餘放在 others。
  perform public.log_access_change(
    p_new, 'audit_admin_replaced',
    (v_prev -> 0) || case when jsonb_array_length(v_prev) > 1
                          then jsonb_build_object('others', v_prev - 0) else '{}'::jsonb end,
    to_jsonb('audit_admin'::text)
  );
end
$$;
comment on function public.hand_over_audit_admin(text) is
  '稽核主管剛好一位（#187）：讓 p_new 成為唯一的稽核主管，其餘降為一般使用者，記一筆「接任稽核主管」在 p_new 身上。只給設定函式用。';
revoke execute on function public.hand_over_audit_admin(text) from public, anon, authenticated;

-- 與 20261030000000 相同，只在接任稽核主管時不重複記「角色」（上面那一筆已經記了）。
create or replace function public.log_employee_access_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_role public.audit_role := case when tg_op = 'UPDATE' then old.audit_role else 'signer' end;
  v_old_plants uuid[] := case when tg_op = 'UPDATE' then old.viewer_plant_ids else '{}' end;
  v_flag text := coalesce(nullif(current_setting('csa.audit_admin_handover', true), ''), '');
  -- 接任稽核主管進行中：降級的前任，和接手的人自己的「角色」都不另記，由 hand_over_audit_admin 記一筆「接任稽核主管」。
  v_handover boolean := v_flag <> '' and (new.emp_id = v_flag or (v_old_role = 'audit_admin' and new.audit_role = 'signer'));
begin
  if not exists (select 1 from public.access_allowlist where emp_id = new.emp_id) then
    return null;
  end if;
  if new.audit_role is distinct from v_old_role and not v_handover then
    perform public.log_access_change(new.emp_id, 'role', to_jsonb(v_old_role), to_jsonb(new.audit_role));
  end if;
  if new.viewer_plant_ids is distinct from v_old_plants then
    perform public.log_access_change(new.emp_id, 'viewer_plants',
      public.viewer_plant_codes(v_old_plants), public.viewer_plant_codes(new.viewer_plant_ids));
  end if;
  return null;
end
$$;

-- 與 20261117000001 相同，只把訊息改成「稽核主管」。
create or replace function public.guard_last_holder()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.audit_role := tg_argv[0]::public.audit_role;
  v_was boolean;
begin
  if tg_table_name = 'employee_ref' then
    v_was := old.audit_role = v_role
      and exists (select 1 from public.access_allowlist where emp_id = old.emp_id);
  else
    v_was := exists (select 1 from public.employee_ref where emp_id = old.emp_id and audit_role = v_role);
  end if;
  if not v_was then
    return null;
  end if;
  -- 稽核主管沿用原本的鎖名（csa.last_audit_admin）。
  perform pg_advisory_xact_lock(hashtext('csa.last_' || v_role::text));
  if not exists (
    select 1 from public.employee_ref e join public.access_allowlist a on a.emp_id = e.emp_id
     where e.audit_role = v_role
  ) then
    raise exception '至少要留一位%', case v_role when 'audit_admin' then '稽核主管' when 'system_maintainer' then '系統維護員' end
      using errcode = '23514', hint = 'last_' || v_role::text;
  end if;
  return null;
end
$$;
comment on function public.guard_last_holder() is
  '至少留一位稽核主管、至少留一位系統維護員（Q98 (4)、Q122 (4)）。接任稽核主管時新的先成為稽核主管，所以不會被擋（hand_over_audit_admin）。';

-- 設定函式 -------------------------------------------------------------------------------------------------
-- 與 20261117000001 相同，加上接任稽核主管：成為稽核主管（原本不是）時，前任自動降級。

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
  perform public.require_access_manager();
  -- 設成稽核主管時，先拿「接任稽核主管」的鎖再寫任何一列：判斷有沒有前任、降級前任都在鎖裡，同時有人降級別的稽核主管
  -- （guard_last_holder 拿同一把鎖）也只會排隊，不會漏記或互卡（deadlock）。
  if p_role = 'audit_admin' then
    perform pg_advisory_xact_lock(hashtext('csa.last_audit_admin'));
  end if;
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
    perform public.require_may_manage(v_emp_id, p_role);
    -- 稽核主管剛好一位：同一批不能加兩位。
    if p_role = 'audit_admin' and cardinality(v_added) > 0 then
      raise exception '稽核主管剛好一位，一次只能加入一位' using errcode = '22023', hint = 'single_audit_admin';
    end if;

    insert into public.employee_ref (emp_id, name, factory_code, audit_role, viewer_plant_ids)
    values (v_emp_id, nullif(btrim(v_person ->> 'name'), ''), nullif(btrim(v_person ->> 'factory_code'), ''),
            p_role, coalesce(p_viewer_plant_ids, '{}'))
    on conflict (emp_id) do update set audit_role = excluded.audit_role, viewer_plant_ids = excluded.viewer_plant_ids;

    insert into public.access_allowlist (emp_id, note, added_by)
    values (v_emp_id, nullif(btrim(p_note), ''), public.current_emp_id());
    v_added := v_added || v_emp_id;

    -- 先加進放行名單再降前任：「至少留一位」看得到新的稽核主管。
    if p_role = 'audit_admin' then
      perform public.hand_over_audit_admin(v_emp_id);
    end if;
  end loop;

  return jsonb_build_object('added', to_jsonb(v_added), 'skipped', to_jsonb(v_skipped));
end
$$;
comment on function public.add_access_members(jsonb, public.audit_role, uuid[], text) is
  '權限管理：把 OMS 名單上找到的人加入放行名單並設角色（Q98 (3)）；已在名單的略過。稽核主管只能加一般使用者、檢視者與稽核人員，'
  '系統維護員什麼角色都能加（Q122、#187）；加入稽核主管時前任自動降級（稽核主管剛好一位）。';

create or replace function public.update_access_member(
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
  v_old_role public.audit_role;
begin
  perform public.require_access_manager();
  -- 設成稽核主管時，先拿「接任稽核主管」的鎖再寫任何一列：判斷有沒有前任、降級前任都在鎖裡，同時有人降級別的稽核主管
  -- （guard_last_holder 拿同一把鎖）也只會排隊，不會漏記或互卡（deadlock）。
  if p_role = 'audit_admin' then
    perform pg_advisory_xact_lock(hashtext('csa.last_audit_admin'));
  end if;
  if not exists (select 1 from public.access_allowlist where emp_id = v_emp_id) then
    raise exception '工號 % 不在放行名單上', v_emp_id using errcode = 'P0002';
  end if;
  perform public.require_may_manage(v_emp_id, p_role);
  select audit_role into v_old_role from public.employee_ref where emp_id = v_emp_id;
  -- 要接任稽核主管（原本不是、現在是，而且有前任）：接手的人只記「接任稽核主管」一筆，這一列的「角色」異動不另記
  -- （異動紀錄的觸發器看這個設定，hand_over_audit_admin 用完會清掉）。沒有前任就照常記「角色」。
  if p_role = 'audit_admin' and v_old_role is distinct from 'audit_admin'
     and exists (select 1 from public.employee_ref where audit_role = 'audit_admin' and emp_id <> v_emp_id) then
    perform set_config('csa.audit_admin_handover', v_emp_id, true);
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

  -- 原本不是稽核主管、現在是：前任降級。原本就是的只改備註之類，不動別人（測試環境若有多位，不藉機降級）。
  if p_role = 'audit_admin' and v_old_role is distinct from 'audit_admin' then
    perform public.hand_over_audit_admin(v_emp_id);
  end if;

  delete from public.plant_coordinator where emp_id = v_emp_id and plant_id = any(coalesce(p_coordinator_unassign, '{}'));
  foreach v_plant in array coalesce(p_coordinator_assign, '{}') loop
    perform public.assign_plant_coordinator(v_plant, v_emp_id);
  end loop;
end
$$;
comment on function public.update_access_member(text, public.audit_role, uuid[], text, uuid[], uuid[]) is
  '權限管理：改放行名單上一個人的角色、檢視廠區、備註，以及（有給時）新加與拿掉的負責廠區（Q98、Q117）。'
  '稽核主管只能改一般使用者、檢視者與稽核人員、也只能設成這三種，系統維護員都能改（Q122、#187）；'
  '設成稽核主管時前任自動降級（稽核主管剛好一位）。';

comment on function public.require_may_manage(text, public.audit_role) is
  '稽核主管只管一般使用者、檢視者與稽核人員（Q122 (3)、#187）：要設的角色和對象現在的角色都不能是稽核主管或系統維護員；系統維護員什麼都能設。';

-- 給使用者看的拒絕訊息改稱稽核主管（函式內容與 20261117000001 相同，只換訊息）。
create or replace function public.require_access_manager()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_manage_access() then
    raise exception '只有稽核主管與系統維護員能維護權限' using errcode = '42501';
  end if;
end
$$;

create or replace function public.require_may_manage(p_emp_id text, p_role public.audit_role)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_system_maintainer() then
    return;
  end if;
  perform 1 from public.employee_ref where emp_id = p_emp_id for update;
  if coalesce(p_role in ('audit_admin', 'system_maintainer'), false)
     or exists (select 1 from public.employee_ref
                 where emp_id = p_emp_id and audit_role in ('audit_admin', 'system_maintainer')) then
    raise exception '只有系統維護員能設定或變更稽核主管與系統維護員' using errcode = '42501', hint = 'maintainer_only';
  end if;
end
$$;
