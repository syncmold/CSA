-- 發起帶入台北稽核人員／稽核主管，換人同步已發出的自評表（工單 #190，規格 #187；稽核角色重整第二波）。用語依 GLOSSARY.md。
--
-- 連動只有一個來源：權限管理（#187 定案第 2 點）。兩種連動關卡（#189 的 link）的簽核人：
--   台北稽核人員 (taipei_auditor)  ＝那一廠的廠區管理員，僅限他的角色是稽核人員（audit_staff）。廠區管理員是廠區端的人，
--                                  或那一廠沒有廠區管理員時不連動：用流程（自評表）上原本存的人（定案第 1 點）。
--   稽核主管 (audit_chief)         ＝現任稽核主管（audit_admin）。剛好一位才算；測試環境現在有多位，在 #192 整理成一位之前
--                                  不連動，照流程上存的人。
--   兩者都由 linked_signer() 一處決定。
--
-- 選人   不連動時在流程編輯器裡選簽核人（定案第 1 點）：linked_now 計算欄位告訴畫面現在有沒有連動，route_step_keep_linked
--        在不連動時放行只改簽核人的修改（#189 原本一律拒絕）。
-- 發起   launch_step_signer 對連動關卡帶入 linked_signer()，不連動時照流程存的人；其餘同 20261129000000。
-- 同步   下面兩件事一發生，就把「還沒簽的」連動關卡換成新的人（sync_linked_steps）：
--          * 某廠指定或更換廠區管理員（plant_coordinator 的觸發器）→ 那一廠的台北稽核人員；
--          * 角色改變（employee_ref 的觸發器）：成為稽核人員 → 他負責的廠區的台北稽核人員；
--            稽核主管換人（成為或不再是稽核主管）→ 全部廠區的稽核主管。
--        用觸發器而不是放在各個設定函式裡：權限管理頁、匯入、部署指令與 db:set-role 都會改這兩張表（同 maintainer_runs_no_plant）。
--        範圍是簽核中的自評表上還沒簽（state 不是 done，正在輪到的也算）的關卡，以及啟用中與草稿的簽核流程；已簽的、已結案的、
--        停用的流程不動。每一關換人在新的人身上記一筆「換人」（step_reassigned，前一位寫在 before，同 assign_step_signer），
--        權限異動紀錄的畫面不必改。流程上的連動關卡跟著換不算修改流程：不記紀錄、不改流程的最後修改時間。
--        沒有新的人（移除廠區管理員、改成廠區端的人、稽核人員的角色被改掉或移出名單、稽核主管不是剛好一位）就什麼都不動：
--        關卡保留原本的人，之後回到在流程裡逐份設定（定案第 3、4 點）；改回稽核人員時再蓋成新的人。
--        送出、核准、退回依自評表那一列排隊（lock_my_current_step），這裡換人前也先鎖自評表，不會在核准途中換掉簽核人。

-- 連動關卡的簽核人 -----------------------------------------------------------------------------

create function public.audit_chief_emp_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when count(*) = 1 then min(emp_id) end
  from public.employee_ref
  where audit_role = 'audit_admin'
$$;
comment on function public.audit_chief_emp_id() is
  '內部用：現任稽核主管的工號；不是剛好一位（測試環境整理前）就是空值（#187、#190）。';
revoke execute on function public.audit_chief_emp_id() from public, anon, authenticated;

create function public.linked_signer(p_link text, p_plant_id uuid)
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
      where c.plant_id = p_plant_id and e.audit_role = 'audit_staff'
    )
    when 'audit_chief' then public.audit_chief_emp_id()
  end
$$;
comment on function public.linked_signer(text, uuid) is
  '內部用：連動關卡現在該由誰簽（#187、#190）：台北稽核人員＝這一廠是稽核人員的廠區管理員，稽核主管＝現任稽核主管；'
  '不連動（一般關卡、廠區管理員是廠區端的人或從缺、稽核主管不是剛好一位）回空值。';
revoke execute on function public.linked_signer(text, uuid) from public, anon, authenticated;

-- 不連動時在流程裡選人（#187 定案第 1 點）--------------------------------------------------------
-- 連動關卡現在有沒有連動：流程編輯器據此顯示「＝廠區管理員（自動）」或「不連動」並讓人選簽核人；route_step_keep_linked
-- 也看它。只回是或否，不透露是誰，所以開給 authenticated（也是 PostgREST 計算欄位）。

create function public.linked_now(s public.route_step)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select s.link is not null
     and public.linked_signer(s.link, (select ar.plant_id from public.approval_route ar where ar.id = s.route_id)) is not null
$$;
comment on function public.linked_now(public.route_step) is
  '連動關卡現在是否跟著權限管理（#190）：台北稽核人員要那一廠的廠區管理員是稽核人員，稽核主管要剛好一位；'
  '否就照流程上存的人、在流程編輯器裡選。一般關卡是否。PostgREST 計算欄位。';
revoke execute on function public.linked_now(public.route_step) from public, anon;
grant execute on function public.linked_now(public.route_step) to authenticated;

-- 同 20261204000000，只多一種例外：不連動時可以透過 API 改簽核人（只改簽核人；改名、刪除照舊拒絕）。連動時簽核人由
-- 權限管理決定，照舊拒絕。
create or replace function public.route_step_keep_linked()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.link is not null and current_user = 'authenticated' then
    if tg_op = 'UPDATE' and not public.linked_now(old)
       and (to_jsonb(new) - 'signer_emp_id') = (to_jsonb(old) - 'signer_emp_id') then
      return new;
    end if;
    raise exception '「%」是連動關卡，簽核人由權限管理決定，不能修改或刪除', old.name
      using errcode = '23514', hint = 'step_linked';
  end if;
  return case tg_op when 'DELETE' then old else new end;
end
$$;
comment on function public.route_step_keep_linked() is
  '有連動標記的關卡不能透過 API 修改或刪除（#189）；不連動時只能改簽核人（#190）。資料庫函式不受限。';

-- 發起 ----------------------------------------------------------------------------------------
-- 同 20261129000000，只多連動關卡：有連動的人就用他，否則照流程存的人。

create or replace function public.launch_step_signer(
  p_step           public.route_step,
  p_branch_unit    text,
  p_template_id    uuid,
  p_template_code  text,
  p_plant_id       uuid,
  p_year           integer,
  p_departed       text[],
  p_carry          boolean
)
returns table (signer_emp_id text, vacated_emp_id text, vacated_name text)
language sql
stable
security definer
set search_path = public
as $$
  with last_year as (
    select s.signer_emp_id as emp_id
    from public.annual_cycle c
    join public.assessment a on a.cycle_id = c.id
    join public.assessment_step s on s.assessment_id = a.id
    where p_carry
      and p_step.step_group = 'plant'
      and c.year = p_year - 1
      and a.plant_id = p_plant_id
      and (a.template_id = p_template_id or a.template_code = p_template_code)
      and s.step_group = 'plant'
      and s.name = p_step.name
      and s.branch_unit_name is not distinct from p_branch_unit
    order by a.created_at desc, s.position
    limit 1
  ),
  chosen as (
    select coalesce(public.linked_signer(p_step.link, p_plant_id), p_step.signer_emp_id, l.emp_id) as emp_id,
           coalesce(upper(l.emp_id) = any (p_departed), false) as departed
    from (select 1) as one
    left join last_year l on true
  )
  select case when c.departed then null else c.emp_id end,
         case when c.departed then c.emp_id end,
         case when c.departed then (select e.name from public.employee_ref e where e.emp_id = c.emp_id) end
  from chosen c
$$;
comment on function public.launch_step_signer(public.route_step, text, uuid, text, uuid, integer, text[], boolean) is
  '內部用：發起時這一關的簽核人。連動關卡帶入權限管理決定的人（linked_signer，#190），不連動時與其他稽核室關卡照流程；'
  '廠區端 p_carry 時帶入去年同一範本 × 廠區同一關，離職的人從缺，去年沒有的或不帶入時待分派。';

-- 同步還沒簽的連動關卡 ----------------------------------------------------------------------------
-- p_plant_id：台北稽核人員是哪一廠；稽核主管不看（全部廠區）。沒有連動的人就不動。

create function public.sync_linked_steps(p_link text, p_plant_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_to  text := public.linked_signer(p_link, p_plant_id);
  s     record;
begin
  if v_to is null then
    return;
  end if;

  -- 流程：連動關卡的簽核人跟著權限管理走，不算修改流程，所以不改流程的最後修改時間，也不鎖流程那一列（換稽核主管一次動到
  -- 全部流程，鎖了會和同時啟用流程的人互卡）。做法是先替這個交易記下修改前的啟用檢查（route_step_before_write 看到已經
  -- 記過就不再改流程那一列；keep_active_route_ready 照樣在交易結束時比對，換簽核人不會多出問題）。
  perform set_config(public.route_txn_key('before', ar.id),
                     case when ar.status = 'active' then public.activation_check(ar)::text else '{}' end, true)
  from public.approval_route ar
  where ar.status <> 'inactive'
    and (p_link = 'audit_chief' or ar.plant_id = p_plant_id)
    and coalesce(current_setting(public.route_txn_key('before', ar.id), true), '') = ''
    and exists (select 1 from public.route_step rs
                where rs.route_id = ar.id and rs.link = p_link and rs.signer_emp_id is distinct from v_to);
  -- （記下的值整個交易有效：同一交易之後若再改這幾條流程，也不會改最後修改時間；同步由權限管理觸發，不會和改流程同一個交易。）

  -- 關卡依 id 上鎖，兩個同步同時跑時不會互卡。
  perform 1
  from public.route_step rs
  join public.approval_route ar on ar.id = rs.route_id
  where rs.link = p_link
    and ar.status <> 'inactive'
    and (p_link = 'audit_chief' or ar.plant_id = p_plant_id)
    and rs.signer_emp_id is distinct from v_to
  order by rs.id
  for update of rs;

  update public.route_step rs
  set signer_emp_id = v_to
  from public.approval_route ar
  where ar.id = rs.route_id
    and rs.link = p_link
    and ar.status <> 'inactive'
    and (p_link = 'audit_chief' or ar.plant_id = p_plant_id)
    and rs.signer_emp_id is distinct from v_to;

  for s in
    select st.id, st.signer_emp_id as prev, st.name, st.branch_unit_name, a.template_code, c.year, p.factory_code
    from public.assessment a
    join public.assessment_step st on st.assessment_id = a.id
    join public.annual_cycle c on c.id = a.cycle_id
    join public.plant p on p.id = a.plant_id
    where a.status = 'in_progress'
      and (p_link = 'audit_chief' or a.plant_id = p_plant_id)
      and st.link = p_link
      and st.state <> 'done'
      and st.signer_emp_id is distinct from v_to
    order by a.id
    for update of a, st
  loop
    update public.assessment_step set signer_emp_id = v_to where id = s.id;
    perform public.log_access_change(
      v_to, 'step_reassigned',
      jsonb_build_object('emp_id', s.prev, 'name', (select e.name from public.employee_ref e where e.emp_id = s.prev)),
      jsonb_build_object('year', s.year, 'plant', s.factory_code, 'template', s.template_code, 'step', s.name, 'branch', s.branch_unit_name)
    );
  end loop;
end
$$;
comment on function public.sync_linked_steps(text, uuid) is
  '內部用：把簽核中自評表上還沒簽的連動關卡，與啟用中、草稿流程的連動關卡，換成 linked_signer 的人，每一關記一筆換人（#190）；'
  '沒有連動的人就不動。由 plant_coordinator 與 employee_ref 的觸發器呼叫。';
revoke execute on function public.sync_linked_steps(text, uuid) from public, anon, authenticated;

-- 指定或更換廠區管理員 → 那一廠的台北稽核人員。移除不必處理：沒有新的人，關卡保留原本的人。
-- 觸發器依名稱排序執行，plant_coordinator_log（指定／接任那一筆）先記，再記各關卡的換人。
create function public.sync_links_on_coordinator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_linked_steps('taipei_auditor', new.plant_id);
  return null;
end
$$;
revoke execute on function public.sync_links_on_coordinator() from public, anon, authenticated;
create trigger plant_coordinator_sync_links
  after insert or update of emp_id on public.plant_coordinator
  for each row execute function public.sync_links_on_coordinator();

-- 角色改變：成為稽核人員 → 他負責的廠區；稽核主管換人 → 全部廠區。接任稽核主管時新的人先成為稽核主管、再降前任
-- （hand_over_audit_admin），前一步有兩位所以不連動，降完剩一位時才同步。不再是稽核人員不必處理（同移除廠區管理員）。
create function public.sync_links_on_role()
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
  if new.audit_role = 'audit_staff' then
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
revoke execute on function public.sync_links_on_role() from public, anon, authenticated;
create trigger employee_ref_sync_links
  after insert or update of audit_role on public.employee_ref
  for each row execute function public.sync_links_on_role();
