-- 簽核紀錄、核准、退回、結案 (工單 #6)。用語依 GLOSSARY.md。
--
-- 每一次簽核（自行檢查人員「送出」、其他關卡「核准」）與每一次「退回」各寫一筆簽核紀錄，記下關卡、
-- 簽核人的帳號與當下姓名、時間、意見。退回到第 T 關時，第 T 關起已完成的簽核標為作廢（不刪除），
-- 自評表回到第 T 關重新往下簽；歷程永遠列出全部紀錄，含作廢的。最後一關核准後自評表結案並鎖定。
--
-- 🔴 OPEN-1 尚未定案：簽核方式採暫行方案A（系統簽核記錄，PDF 印姓名、時間、簽核記錄編號）。
-- 接縫：每筆紀錄帶 signature_method（目前只有 system_record）與流水號 serial_no（簽核記錄編號）；
-- 所有簽核紀錄只由 record_signoff 一處寫入，日後改 B（匯出時以組織憑證簽整份 PDF，不動這張表）
-- 或 C（每關以個人憑證簽，在 record_signoff 加簽章欄位與一個 enum 值）時只改這一處。
--
-- 寫入規則全在資料庫 (ADR-0001)：簽核紀錄沒有任何一般使用者的直接寫入授權，只能經由
-- submit_assessment_step（#5，這裡補上寫紀錄）、approve_assessment_step、return_assessment 三個函式。

-- 簽核紀錄 ----------------------------------------------------------------------

create type public.signoff_action as enum ('submit', 'approve', 'return');
comment on type public.signoff_action is '簽核紀錄的動作：送出（自行檢查人員的簽核）／核准／退回。';

create type public.signature_method as enum ('system_record');
comment on type public.signature_method is
  '簽章方式：system_record＝方案A 系統簽核記錄（OPEN-1 暫行）。方案C 個人憑證定案時再加值。';

-- 讓簽核紀錄用 (assessment_id, step_id) 參照關卡，保證紀錄上的 assessment_id 與關卡一致。
alter table public.assessment_step
  add constraint assessment_step_assessment_id_id_key unique (assessment_id, id);

create table public.assessment_signoff (
  id                  uuid primary key default gen_random_uuid(),
  -- 簽核記錄編號（方案A 印在 PDF 上）；全系統遞增，不重複使用。
  serial_no           bigint generated always as identity unique,
  assessment_id       uuid not null references public.assessment (id) on delete cascade,
  step_id             uuid not null,
  -- 關卡順序與名稱的當下快照：加簽、換人 (#13) 之後歷程仍顯示簽核當時的關卡。
  step_position       integer not null check (step_position > 0),
  step_name           text not null,
  action              public.signoff_action not null,
  signer_emp_id       text not null,
  -- 簽核當下的姓名快照（employee_ref 只有本人與稽核管理者讀得到，歷程要給每個看得到自評表的人看）。
  signer_name         text,
  -- 核准的意見（選填）或退回的原因（必填）。
  comment             text,
  -- 退回到第幾關；只有退回有值。
  return_to_position  integer check (return_to_position > 0),
  signature_method    public.signature_method not null default 'system_record',
  signed_at           timestamptz not null default now(),
  -- 被哪一筆退回作廢；空值＝有效。
  voided_by           uuid references public.assessment_signoff (id),
  voided_at           timestamptz,
  foreign key (assessment_id, step_id) references public.assessment_step (assessment_id, id) on delete cascade,
  check ((action = 'return') = (return_to_position is not null)),
  check (action <> 'return' or nullif(btrim(comment), '') is not null),
  check ((voided_by is null) = (voided_at is null)),
  check (action <> 'return' or voided_by is null)
);
create index assessment_signoff_assessment_idx on public.assessment_signoff (assessment_id, signed_at);
create index assessment_signoff_signer_idx on public.assessment_signoff (signer_emp_id);
comment on table public.assessment_signoff is
  '簽核紀錄：自評表上每一次送出、核准、退回；退回後被作廢的簽核保留在歷程中。';

-- 唯一的寫入點（OPEN-1 的接縫）。不開放給一般使用者呼叫；由下面三個 security definer 函式使用。
create or replace function public.record_signoff(
  p_step                public.assessment_step,
  p_action              public.signoff_action,
  p_comment             text default null,
  p_return_to_position  integer default null
)
returns public.assessment_signoff
language sql
security definer
set search_path = public
as $$
  insert into public.assessment_signoff (
    assessment_id, step_id, step_position, step_name, action, signer_emp_id, signer_name, comment, return_to_position
  )
  values (
    p_step.assessment_id, p_step.id, p_step.position, p_step.name, p_action, public.current_emp_id(),
    (select name from public.employee_ref where emp_id = public.current_emp_id()),
    nullif(btrim(p_comment), ''), p_return_to_position
  )
  returning *
$$;
comment on function public.record_signoff(public.assessment_step, public.signoff_action, text, integer) is
  '寫一筆簽核紀錄（呼叫者＝簽核人）。簽核紀錄只從這裡寫入；簽章方式定案後在這裡加簽章。';
revoke execute on function public.record_signoff(public.assessment_step, public.signoff_action, text, integer)
  from public, anon, authenticated;

-- 可見性：簽過這張自評表的人（含被作廢、含退回者）也看得到 -----------------------------
-- #4 的規則是「關卡順序 ≤ 目前關卡的簽核人」；退回把目前關卡往前移，原本已簽過後面關卡的人會因此看不到
-- 自己被作廢的簽核與退回原因。Q81(5) 的本意是「正在簽與已簽過的」，所以加上「有簽核紀錄的人」。

create or replace function public.has_signoff_on(p_assessment_id uuid)
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
$$;
comment on function public.has_signoff_on(uuid) is '呼叫者在這張自評表上有沒有簽核紀錄（含被作廢的與退回）。';

create or replace function public.can_view_assessment(p_assessment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_audit_admin()
      or public.is_signer_up_to_current_step(p_assessment_id)
      or public.has_signoff_on(p_assessment_id)
$$;
comment on function public.can_view_assessment(uuid) is
  '稽核管理者、目前關卡與之前關卡的簽核人，以及在這張自評表上簽過的人，才讀得到這張自評表。';

alter table public.assessment_signoff enable row level security;
create policy assessment_signoff_select_visible on public.assessment_signoff
  for select to authenticated using (public.can_view_assessment(assessment_id));
grant select on public.assessment_signoff to authenticated;
revoke insert, update, delete on public.assessment_signoff from authenticated;
revoke all on public.assessment_signoff from anon;

-- 頁面要不要顯示核准／退回：與 my_editable_unit 一樣是自評表的計算欄位，前端不另寫規則。
create or replace function public.can_approve(a public.assessment)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select s.editable_unit_name is null
    from public.assessment_step s
    where s.assessment_id = a.id
      and s.position = a.current_step_position
      and a.status = 'in_progress'
      and s.signer_emp_id = public.current_emp_id()
  ), false)
$$;
comment on function public.can_approve(public.assessment) is
  '呼叫者現在能不能核准或退回這張自評表：簽核中、呼叫者是目前關卡的簽核人、該關卡沒有可編輯範圍（主管與稽核關卡）。';

-- 結案鎖定 ----------------------------------------------------------------------
-- 一般使用者已經被 my_editable_unit（只在簽核中）擋下；這裡再擋所有身分（含 service_role、日後的對話寫入，
-- ADR-0006），結案後答案與整體結論一律不能改。重新開啟（Q24）之後再做。

create or replace function public.forbid_write_when_closed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select status from public.assessment where id = new.assessment_id) = 'closed' then
    raise exception '自評表已結案，不能再修改' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger assessment_answer_closed_lock
  before insert or update on public.assessment_answer
  for each row execute function public.forbid_write_when_closed();
create trigger assessment_conclusion_closed_lock
  before insert or update on public.assessment_conclusion
  for each row execute function public.forbid_write_when_closed();

-- 送出：補寫簽核紀錄 (Q84(5)) ------------------------------------------------------
-- 與 #5 的版本相同，只在推進前多寫一筆「送出」紀錄。

create or replace function public.submit_assessment_step(p_assessment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a             public.assessment;
  s             public.assessment_step;
  v_violations  jsonb;
  v_next        integer;
begin
  lock table public.assessment_answer, public.assessment_conclusion in share row exclusive mode;

  select * into a from public.assessment where id = p_assessment_id for update;
  if not found or a.status <> 'in_progress' then
    raise exception 'this 自評表 is not open for submission' using errcode = '42501';
  end if;

  select * into s from public.assessment_step
  where assessment_id = a.id and position = a.current_step_position;
  if s.signer_emp_id is distinct from public.current_emp_id() then
    raise exception 'only the 簽核人 of the current 關卡 can submit it' using errcode = '42501';
  end if;
  if s.editable_unit_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_self_check_step');
  end if;

  select min(position) into v_next
  from public.assessment_step
  where assessment_id = a.id and position > a.current_step_position;
  if v_next is null then
    return jsonb_build_object('ok', false, 'error', 'no_next_step');
  end if;

  with points as (
    select cp.id, sec.position as section_position, cp.position,
           ans.design, ans.execution, ans.satisfaction, nullif(btrim(ans.improvement), '') as improvement
    from public.assessment_control_point cp
    join public.assessment_section sec on sec.id = cp.section_id
    left join public.assessment_answer ans on ans.control_point_id = cp.id
    where cp.assessment_id = a.id and cp.assessing_unit_name = s.editable_unit_name
  ),
  -- 排序鍵：控制要點依紙本順序（章、題、規則），整體結論排最後。
  violations as (
    select section_position, position, 1 as rule_order,
           jsonb_build_object('kind', 'control_point', 'control_point_id', id, 'section_position', section_position,
                              'position', position, 'rule', 'unanswered') as v
    from points
    where execution is null or satisfaction is null
       or (a.template_layout = 'control_activity' and design is null)
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
      on c.assessment_id = a.id and c.assessing_unit_name = s.editable_unit_name
    where c.conclusion is null
       or (c.conclusion = 'satisfied_except' and nullif(btrim(c.exceptions), '') is null)
  )
  select jsonb_agg(v order by section_position, position, rule_order) into v_violations
  from violations;

  if v_violations is not null then
    return jsonb_build_object('ok', false, 'error', 'incomplete', 'violations', v_violations);
  end if;

  perform public.record_signoff(s, 'submit');
  update public.assessment set current_step_position = v_next where id = a.id;
  return jsonb_build_object('ok', true, 'current_step_position', v_next);
end
$$;
comment on function public.submit_assessment_step(uuid) is
  '送出（自行檢查人員）：驗證自己自評單位的答案與整體結論，通過才寫簽核紀錄並推進到下一關。';

-- 核准 --------------------------------------------------------------------------
-- 主管與稽核關卡（沒有可編輯範圍）的簽核人核准目前關卡，可附意見。
-- 有下一關就推進，回傳 {ok:true, closed:false, current_step_position}；
-- 已是最後一關就結案，回傳 {ok:true, closed:true, current_step_position}。
-- 目前關卡是自行檢查人員關卡（有可編輯範圍，要用送出）回 {ok:false, error:'self_check_step'}。
-- 呼叫者不是目前關卡的簽核人、自評表不存在或已結案，丟 42501（與送出一致）。

create or replace function public.approve_assessment_step(p_assessment_id uuid, p_comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a       public.assessment;
  s       public.assessment_step;
  v_next  integer;
begin
  select * into a from public.assessment where id = p_assessment_id for update;
  if not found or a.status <> 'in_progress' then
    raise exception 'this 自評表 is not open for sign-off' using errcode = '42501';
  end if;

  select * into s from public.assessment_step
  where assessment_id = a.id and position = a.current_step_position;
  if s.signer_emp_id is distinct from public.current_emp_id() then
    raise exception 'only the 簽核人 of the current 關卡 can approve it' using errcode = '42501';
  end if;
  if s.editable_unit_name is not null then
    return jsonb_build_object('ok', false, 'error', 'self_check_step');
  end if;

  perform public.record_signoff(s, 'approve', p_comment);

  select min(position) into v_next
  from public.assessment_step
  where assessment_id = a.id and position > a.current_step_position;
  if v_next is null then
    update public.assessment set status = 'closed' where id = a.id;
    return jsonb_build_object('ok', true, 'closed', true, 'current_step_position', a.current_step_position);
  end if;

  update public.assessment set current_step_position = v_next where id = a.id;
  return jsonb_build_object('ok', true, 'closed', false, 'current_step_position', v_next);
end
$$;
comment on function public.approve_assessment_step(uuid, text) is
  '核准（主管與稽核關卡）：寫簽核紀錄，推進到下一關；最後一關核准即結案。';

-- 退回 --------------------------------------------------------------------------
-- 主管與稽核關卡的簽核人把自評表退回之前的某一關（p_to_position），原因必填。
-- 第 p_to_position 關起已完成、尚未作廢的簽核（送出與核准）全部標為作廢，指向這一筆退回紀錄；
-- 退回紀錄本身與更早的退回紀錄不作廢（它們是歷程事件，不是簽核）。自評表回到該關，答案保留，
-- 被退回的自行檢查人員關卡可以再修改自己單位的答案（my_editable_unit 隨目前關卡而定）。
-- 業務拒絕回 {ok:false, error}：
--   self_check_step  目前關卡是自行檢查人員關卡（Q13：退回是主管與稽核關卡的動作）
--   reason_required  沒填原因（只填空白視同沒填）
--   invalid_target   退回目標不是這張自評表上、目前關卡之前的關卡
-- 成功回傳 {ok:true, current_step_position, voided}（作廢筆數）。
-- 呼叫者不是目前關卡的簽核人、自評表不存在或已結案，丟 42501。

create or replace function public.return_assessment(p_assessment_id uuid, p_to_position integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a         public.assessment;
  s         public.assessment_step;
  v_return  public.assessment_signoff;
  v_voided  integer;
begin
  select * into a from public.assessment where id = p_assessment_id for update;
  if not found or a.status <> 'in_progress' then
    raise exception 'this 自評表 is not open for sign-off' using errcode = '42501';
  end if;

  select * into s from public.assessment_step
  where assessment_id = a.id and position = a.current_step_position;
  if s.signer_emp_id is distinct from public.current_emp_id() then
    raise exception 'only the 簽核人 of the current 關卡 can return it' using errcode = '42501';
  end if;
  if s.editable_unit_name is not null then
    return jsonb_build_object('ok', false, 'error', 'self_check_step');
  end if;
  if nullif(btrim(p_reason), '') is null then
    return jsonb_build_object('ok', false, 'error', 'reason_required');
  end if;
  if p_to_position is null or p_to_position >= a.current_step_position
     or not exists (select 1 from public.assessment_step where assessment_id = a.id and position = p_to_position) then
    return jsonb_build_object('ok', false, 'error', 'invalid_target');
  end if;

  v_return := public.record_signoff(s, 'return', p_reason, p_to_position);

  update public.assessment_signoff
  set voided_by = v_return.id, voided_at = v_return.signed_at
  where assessment_id = a.id
    and action in ('submit', 'approve')
    and voided_by is null
    and step_id in (select id from public.assessment_step where assessment_id = a.id and position >= p_to_position);
  get diagnostics v_voided = row_count;

  update public.assessment set current_step_position = p_to_position where id = a.id;
  return jsonb_build_object('ok', true, 'current_step_position', p_to_position, 'voided', v_voided);
end
$$;
comment on function public.return_assessment(uuid, integer, text) is
  '退回（主管與稽核關卡）：必填原因，作廢目標關卡起已完成的簽核，自評表回到目標關卡重新往下簽。';

revoke execute on function public.approve_assessment_step(uuid, text) from public, anon;
grant execute on function public.approve_assessment_step(uuid, text) to authenticated;
revoke execute on function public.return_assessment(uuid, integer, text) from public, anon;
grant execute on function public.return_assessment(uuid, integer, text) to authenticated;
