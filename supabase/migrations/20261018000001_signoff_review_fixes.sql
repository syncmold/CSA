-- #6 code review 後修訂（2026-10-16，Q85 (9)–(11)）。
--
-- (9)  可見性：在自評表上簽過的人，只有「目前仍是這張自評表某一關的簽核人」才看得到；被退回的人看得到
--      自己被作廢的簽核與退回原因，被換人 (#13) 換掉的人看不到。
-- (10) 暫存與送出的先後改由「自評表那一列」決定，不再鎖答案與整體結論兩張表：送出以 FOR UPDATE 鎖自評表，
--      每一筆答案與整體結論的寫入先以 FOR SHARE 鎖同一列，拿到鎖之後用新的快照重驗可編輯範圍。
--      這樣驗證過的內容仍是送出的內容，而且只有一個鎖的對象，不會再與其他交易以相反順序互等（死結）。
-- (11) 結案鎖定涵蓋答案、整體結論、簽核紀錄、關卡的新增、修改、刪除，對所有身分；
--      只有刪除年度作業（或自評表）時資料庫自己做的連帶刪除放行。

-- (9) 可見性 --------------------------------------------------------------------

create or replace function public.signed_and_still_on_route(p_assessment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
           select 1 from public.assessment_signoff
           where assessment_id = p_assessment_id and signer_emp_id = public.current_emp_id()
         )
     and exists (
           select 1 from public.assessment_step
           where assessment_id = p_assessment_id and signer_emp_id = public.current_emp_id()
         )
$$;
comment on function public.signed_and_still_on_route(uuid) is
  '呼叫者在這張自評表上簽過（含被作廢、含退回），而且目前仍是它某一關的簽核人。';

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
$$;
comment on function public.can_view_assessment(uuid) is
  '稽核管理者、目前關卡與之前關卡的簽核人，以及簽過而且仍在流程上的人，才讀得到這張自評表。';

drop function public.has_signoff_on(uuid);

-- (10)(11) 寫入守門 ----------------------------------------------------------------
-- 答案與整體結論的每一筆寫入：先鎖自評表那一列（等進行中的送出、核准、退回提交），再以新的快照檢查
-- 結案與可編輯範圍。RLS 的 with check 用的是語句開始時的快照，等鎖之後可能已過時，所以這裡重驗一次；
-- 規則本身仍只在 my_editable_unit（經 can_edit_unit／can_edit_control_point），不另寫一份。
-- 只有一般使用者（session 帶工號）要驗可編輯範圍；service_role 與資料庫自己的維護不帶工號。
-- 刪除只有連帶刪除會發生（一般使用者沒有刪除授權），結案後也只放行連帶刪除。

create or replace function public.guard_assessment_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_status   public.assessment_status;
  v_allowed  boolean;
begin
  -- 連帶刪除（刪年度作業或自評表時資料庫自己刪子表）由觸發器深度 > 1 辨認，一律放行。
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  r := case when tg_op = 'DELETE' then old else new end;

  select status into v_status from public.assessment where id = r.assessment_id for share;
  if v_status = 'closed' then
    raise exception '自評表已結案，不能再修改' using errcode = '42501';
  end if;

  if tg_op <> 'DELETE' and public.current_emp_id() is not null then
    -- 用 if 而不是 case：每張表的欄位不同，case 會把每個分支都解析一次。
    if tg_table_name = 'assessment_answer' then
      v_allowed := public.can_edit_control_point(r.control_point_id);
    elsif tg_table_name = 'assessment_conclusion' then
      v_allowed := public.can_edit_unit(r.assessment_id, r.assessing_unit_name);
    else
      v_allowed := true;
    end if;
    if not v_allowed then
      raise exception '這一關現在不能修改這個自評單位' using errcode = '42501';
    end if;
  end if;

  return r;
end
$$;
comment on function public.guard_assessment_write() is
  '答案、整體結論、簽核紀錄、關卡的寫入守門：與送出等依自評表那一列排隊，結案後拒絕，並以新快照重驗可編輯範圍。';

drop trigger assessment_answer_closed_lock on public.assessment_answer;
drop trigger assessment_conclusion_closed_lock on public.assessment_conclusion;
drop function public.forbid_write_when_closed();

create trigger assessment_answer_guard
  before insert or update or delete on public.assessment_answer
  for each row execute function public.guard_assessment_write();
create trigger assessment_conclusion_guard
  before insert or update or delete on public.assessment_conclusion
  for each row execute function public.guard_assessment_write();
create trigger assessment_signoff_guard
  before insert or update or delete on public.assessment_signoff
  for each row execute function public.guard_assessment_write();
create trigger assessment_step_guard
  before insert or update or delete on public.assessment_step
  for each row execute function public.guard_assessment_write();

-- 送出、核准、退回共用 ------------------------------------------------------------

-- 鎖住自評表並回傳目前關卡；自評表不存在、已結案、或呼叫者不是目前關卡的簽核人，丟 42501。
create or replace function public.lock_my_current_step(p_assessment_id uuid)
returns public.assessment_step
language plpgsql
security definer
set search_path = public
as $$
declare
  a  public.assessment;
  s  public.assessment_step;
begin
  select * into a from public.assessment where id = p_assessment_id for update;
  if not found or a.status <> 'in_progress' then
    raise exception 'this 自評表 is not open for sign-off' using errcode = '42501';
  end if;
  select * into s from public.assessment_step where assessment_id = a.id and position = a.current_step_position;
  if s.signer_emp_id is distinct from public.current_emp_id() then
    raise exception 'only the 簽核人 of the current 關卡 can sign it off' using errcode = '42501';
  end if;
  return s;
end
$$;
comment on function public.lock_my_current_step(uuid) is
  '送出／核准／退回的共同開頭：鎖住自評表，確認簽核中且呼叫者是目前關卡的簽核人，回傳該關卡。';

create or replace function public.next_step_position(p_step public.assessment_step)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select min(position) from public.assessment_step
  where assessment_id = p_step.assessment_id and position > p_step.position
$$;
comment on function public.next_step_position(public.assessment_step) is '這一關的下一關順序；已是最後一關回空值。';

revoke execute on function public.lock_my_current_step(uuid) from public, anon, authenticated;
revoke execute on function public.next_step_position(public.assessment_step) from public, anon, authenticated;

-- 送出 --------------------------------------------------------------------------
-- 行為與回傳同 #5／#6：只改成不鎖整張表（見上方 (10)），開頭改用共用函式。

create or replace function public.submit_assessment_step(p_assessment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s             public.assessment_step;
  v_layout      public.template_layout;
  v_violations  jsonb;
  v_next        integer;
begin
  s := public.lock_my_current_step(p_assessment_id);
  if s.editable_unit_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_self_check_step');
  end if;
  v_next := public.next_step_position(s);
  if v_next is null then
    return jsonb_build_object('ok', false, 'error', 'no_next_step');
  end if;
  select template_layout into v_layout from public.assessment where id = s.assessment_id;

  with points as (
    select cp.id, sec.position as section_position, cp.position,
           ans.design, ans.execution, ans.satisfaction, nullif(btrim(ans.improvement), '') as improvement
    from public.assessment_control_point cp
    join public.assessment_section sec on sec.id = cp.section_id
    left join public.assessment_answer ans on ans.control_point_id = cp.id
    where cp.assessment_id = s.assessment_id and cp.assessing_unit_name = s.editable_unit_name
  ),
  -- 排序鍵：控制要點依紙本順序（章、題、規則），整體結論排最後。
  violations as (
    select section_position, position, 1 as rule_order,
           jsonb_build_object('kind', 'control_point', 'control_point_id', id, 'section_position', section_position,
                              'position', position, 'rule', 'unanswered') as v
    from points
    where execution is null or satisfaction is null
       or (v_layout = 'control_activity' and design is null)
    union all
    select section_position, position, 2,
           jsonb_build_object('kind', 'control_point', 'control_point_id', id, 'section_position', section_position,
                              'position', position, 'rule', 'improvement_required')
    from points
    where (execution = 'no' or design = 'no_rule' or satisfaction in ('needs_improvement', 'dissatisfied'))
      and improvement is null
    union all
    select 2147483647, 0, 0,
           jsonb_build_object('kind', 'conclusion', 'assessing_unit_name', s.editable_unit_name, 'rule',
             case when c.conclusion is null then 'unanswered' else 'explanation_required' end)
    from (select 1) one
    left join public.assessment_conclusion c
      on c.assessment_id = s.assessment_id and c.assessing_unit_name = s.editable_unit_name
    where c.conclusion is null
       or (c.conclusion = 'satisfied_except' and nullif(btrim(c.exceptions), '') is null)
  )
  select jsonb_agg(v order by section_position, position, rule_order) into v_violations
  from violations;

  if v_violations is not null then
    return jsonb_build_object('ok', false, 'error', 'incomplete', 'violations', v_violations);
  end if;

  perform public.record_signoff(s, 'submit');
  update public.assessment set current_step_position = v_next where id = s.assessment_id;
  return jsonb_build_object('ok', true, 'current_step_position', v_next);
end
$$;
comment on function public.submit_assessment_step(uuid) is
  '送出（自行檢查人員）：驗證自己自評單位的答案與整體結論，通過才寫簽核紀錄並推進到下一關。';

-- 核准 --------------------------------------------------------------------------

create or replace function public.approve_assessment_step(p_assessment_id uuid, p_comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s       public.assessment_step;
  v_next  integer;
begin
  s := public.lock_my_current_step(p_assessment_id);
  if s.editable_unit_name is not null then
    return jsonb_build_object('ok', false, 'error', 'self_check_step');
  end if;

  perform public.record_signoff(s, 'approve', p_comment);

  v_next := public.next_step_position(s);
  if v_next is null then
    update public.assessment set status = 'closed' where id = s.assessment_id;
    return jsonb_build_object('ok', true, 'closed', true, 'current_step_position', s.position);
  end if;

  update public.assessment set current_step_position = v_next where id = s.assessment_id;
  return jsonb_build_object('ok', true, 'closed', false, 'current_step_position', v_next);
end
$$;

-- 退回 --------------------------------------------------------------------------

create or replace function public.return_assessment(p_assessment_id uuid, p_to_position integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s         public.assessment_step;
  v_return  public.assessment_signoff;
  v_voided  integer;
begin
  s := public.lock_my_current_step(p_assessment_id);
  if s.editable_unit_name is not null then
    return jsonb_build_object('ok', false, 'error', 'self_check_step');
  end if;
  if nullif(btrim(p_reason), '') is null then
    return jsonb_build_object('ok', false, 'error', 'reason_required');
  end if;
  if p_to_position is null or p_to_position >= s.position
     or not exists (select 1 from public.assessment_step where assessment_id = s.assessment_id and position = p_to_position) then
    return jsonb_build_object('ok', false, 'error', 'invalid_target');
  end if;

  v_return := public.record_signoff(s, 'return', p_reason, p_to_position);

  update public.assessment_signoff
  set voided_by = v_return.id, voided_at = v_return.signed_at
  where assessment_id = s.assessment_id
    and action in ('submit', 'approve')
    and voided_by is null
    and step_id in (select id from public.assessment_step where assessment_id = s.assessment_id and position >= p_to_position);
  get diagnostics v_voided = row_count;

  update public.assessment set current_step_position = p_to_position where id = s.assessment_id;
  return jsonb_build_object('ok', true, 'current_step_position', p_to_position, 'voided', v_voided);
end
$$;
