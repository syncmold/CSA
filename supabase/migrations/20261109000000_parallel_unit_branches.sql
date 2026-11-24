-- 分流並行的簽核核心（工單 #97；Q116，暫定 OPEN-6；ADR 0007 取代 ADR 0003）。用語依 GLOSSARY.md 的分流、匯流。
--
-- 原本一張自評表只有一個目前關卡（assessment.current_step_position）。改成：廠區端每個自評單位各走一條分流，
-- 各分流同時前進；所有分流都完成才匯流到後面的關卡（廠區經理人，再到稽核室三關），之後照順序到結案。
--
--   位置     每一關都記自己屬於哪條分流：route_step.branch_unit_id／assessment_step.branch_unit_name（快照存名稱，
--            ADR-0004），空值＝匯流後。自行檢查人員關卡的分流就是它的可編輯範圍（觸發器自動帶，不能不同）；稽核室
--            覆核關卡一定在匯流後。一條分流可以有好幾關（Q116 (2) 稽核部替某單位多加一關），同一分流的關卡、
--            匯流後的關卡各自依 position 排順序；position 仍是整條流程唯一的編號，退回目標與簽核紀錄都用它。
--   狀態     assessment_step.state：pending 還沒輪到／current 輪到／done 已完成。只由 refresh_assessment_steps 依
--            「有效（沒被作廢）的送出與核准」推導並寫入，送出、核准、退回、發起寫完簽核紀錄後都呼叫它；
--            同一張自評表同時可以有好幾關 current（每條還沒完成的分流一關）。全部 done 就結案。
--   輪到誰   「輪到」「輪過」改以關卡的 state 判斷：可見性（is_signer_up_to_current_step）、可編輯範圍（my_editable_units）、
--            核准與退回（can_approve、my_current_steps）都讀它。同一個人可以同時輪到好幾關（例如一位部門主管
--            管兩個單位）：送出、核准、退回多一個參數指定哪一關，不給就取他輪到的關卡中最前面的一關。
--   退回     （Q116 (10)）分流裡的關卡只能退回本分流的前一關；匯流後的關卡可以退回匯流後的前一關，或任一單位的
--            自行檢查人員，稽核室另可直接退到廠區經理人。退到某分流時，作廢該分流從目標起的簽核與匯流後的
--            全部簽核，其他分流不動；規則只在 return_targets 一處，畫面讀 my_current_steps 裡的同一份清單。
--   答案     （Q116 (9)）其他單位的答案與整體結論，要等自己所在分流的單位送出、而且那個單位也已送出才看得到；被退回
--            重填的單位，重新送出前別人看不到。匯流後的簽核人、稽核管理者、檢視者看得到全部（can_see_all_answers，
--            #100 會在那裡加廠區負責人）。
--   相容     assessment.current_step_position 這個欄位移除，改成同名的計算欄位函式（簽核中＝最前面一個輪到的關卡，
--            結案＝最後一關），讓「a.current_step_position」與 PostgREST 的 select 照舊可用；它只是摘要，
--            規則一律讀 state。追蹤總覽的呈現與最久沒動的分流是 #99，簽核流程編輯器是 #98。
--   轉換     現有的簽核流程與自評表在檔尾轉成分流；已簽的關卡照算。對應不了的寫進 branch_conversion_issue，不默默丟掉。

-- 關卡的分流與狀態 -----------------------------------------------------------------------

create type public.step_state as enum ('pending', 'current', 'done');
comment on type public.step_state is '自評表關卡的狀態：還沒輪到／輪到（正在等這一關）／已完成（有有效的送出或核准）。';

alter table public.route_step
  add column branch_unit_id uuid references public.assessing_unit (id),
  add constraint route_step_branch_is_editable_unit check (editable_unit_id is null or branch_unit_id = editable_unit_id),
  add constraint route_step_audit_review_after_merge check (step_group = 'plant' or branch_unit_id is null);
comment on column public.route_step.branch_unit_id is
  '這一關屬於哪個自評單位的分流；空值＝匯流後（廠區經理人、稽核室覆核）。自行檢查人員關卡就是它的可編輯範圍。';

alter table public.assessment_step
  add column branch_unit_name text,
  add column state public.step_state not null default 'pending',
  add constraint assessment_step_branch_is_editable_unit check (editable_unit_name is null or branch_unit_name = editable_unit_name),
  add constraint assessment_step_audit_review_after_merge check (step_group = 'plant' or branch_unit_name is null);
comment on column public.assessment_step.branch_unit_name is '這一關屬於哪個自評單位的分流（快照存名稱）；空值＝匯流後。';
comment on column public.assessment_step.state is '這一關的狀態；只由 refresh_assessment_steps 依有效的簽核紀錄寫入。';
comment on table public.assessment_step is
  '自評表的關卡快照：各自評單位的分流與匯流後的關卡 (ADR-0007)；加簽、換人 (#13) 改的是這裡，不是簽核流程。';
comment on table public.route_step is
  '關卡：流程中的一站（名稱、群組、所屬分流、簽核人、可編輯範圍）；各分流並行，匯流後依序 (ADR-0007)。';

-- 自行檢查人員關卡的分流跟著可編輯範圍走：流程編輯器、insert_route_step、種子都不必另外指定。
create or replace function public.route_step_branch_from_editable_unit()
returns trigger
language plpgsql
as $$
begin
  if new.editable_unit_id is not null then
    new.branch_unit_id := new.editable_unit_id;
  end if;
  return new;
end
$$;

create trigger route_step_branch_from_editable_unit
  before insert or update of editable_unit_id, branch_unit_id on public.route_step
  for each row execute function public.route_step_branch_from_editable_unit();

create index assessment_step_current_idx on public.assessment_step (assessment_id) where state = 'current';

-- 狀態的唯一推導 ---------------------------------------------------------------------------
-- 每條分流（branch_unit_name 相同的關卡）與匯流後（空值）各自依 position：第一個沒有有效送出／核准的關卡是
-- current，之前的是 done，之後的是 pending；匯流後要等每條分流都完成才開始。全部 done 就結案（只會從簽核中
-- 變結案，不會反過來）。呼叫者要先鎖住自評表（送出、核准、退回經 lock_my_current_step；發起時自評表才剛建立）。

create or replace function public.refresh_assessment_steps(p_assessment_id uuid)
returns public.assessment_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status    public.assessment_status;
  v_all_done  boolean;
begin
  select status into v_status from public.assessment where id = p_assessment_id;
  if v_status is distinct from 'in_progress' then
    return v_status;
  end if;

  with steps as (
    select s.id, s.position, s.branch_unit_name, s.state,
           exists (
             select 1 from public.assessment_signoff g
             where g.step_id = s.id and g.action in ('submit', 'approve') and g.voided_by is null
           ) as signed
    from public.assessment_step s
    where s.assessment_id = p_assessment_id
  ),
  per_branch as (
    select steps.*,
           min(position) filter (where not signed) over (partition by branch_unit_name) as first_open,
           bool_and(signed) filter (where branch_unit_name is not null) over () as merged
    from steps
  ),
  derived as (
    select id, state as old_state,
           case
             when branch_unit_name is null and not coalesce(merged, true) then 'pending'
             when first_open is null or position < first_open then 'done'
             when position = first_open then 'current'
             else 'pending'
           end::public.step_state as new_state
    from per_branch
  ),
  changed as (
    update public.assessment_step s
    set state = d.new_state
    from derived d
    where s.id = d.id and d.new_state <> d.old_state
    returning s.id
  )
  select bool_and(new_state = 'done') into v_all_done from derived;

  -- 每次都寫自評表那一列：結案，或只更新 updated_at（和原本推進 current_step_position 一樣記下最後異動）。
  update public.assessment
  set status = case when v_all_done then 'closed'::public.assessment_status else status end
  where id = p_assessment_id
  returning status into v_status;
  return v_status;
end
$$;
comment on function public.refresh_assessment_steps(uuid) is
  '內部用：依有效的送出與核准重算一張自評表每一關的狀態（各分流並行、全部完成才匯流），全部完成就結案。';
revoke execute on function public.refresh_assessment_steps(uuid) from public, anon, authenticated;

-- 相容的「目前關卡」：最前面一個輪到的關卡；結案是最後一關。也是 PostgREST 的計算欄位。
create or replace function public.current_step_position(a public.assessment)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when a.status = 'closed' then (select max(s.position) from public.assessment_step s where s.assessment_id = a.id)
    else (select min(s.position) from public.assessment_step s where s.assessment_id = a.id and s.state = 'current')
  end
$$;
comment on function public.current_step_position(public.assessment) is
  '摘要：簽核中＝最前面一個輪到的關卡順序（分流並行時同時輪到好幾關，只取最前面的），結案＝最後一關。規則請讀 assessment_step.state。';

-- 退回的目標（Q116 (10)），照規格字面：
--   分流裡的關卡（部門主管、多加的那一關）＝本分流的前一關；
--   匯流後的關卡＝匯流後的前一關（廠區經理人前面沒有），加上每個單位的自行檢查人員關卡（有可編輯範圍的那一關，
--   不論它在分流裡排第幾）；
--   稽核室覆核的關卡另外可以直接退到廠區經理人（匯流後的廠區端關卡）。
create or replace function public.return_targets(p_step public.assessment_step)
returns integer[]
language sql
stable
security definer
set search_path = public
as $$
  with earlier as (
    select t.position, t.branch_unit_name, t.step_group
    from public.assessment_step t
    where t.assessment_id = p_step.assessment_id and t.position < p_step.position
  )
  select coalesce(array_agg(distinct x.position order by x.position), '{}')
  from (
    -- 同一條線（同分流，或匯流後）的前一關
    select max(e.position) as position from earlier e
    where e.branch_unit_name is not distinct from p_step.branch_unit_name
    union all
    -- 匯流後：每個單位的自行檢查人員
    select f.position from public.assessment_step f
    where p_step.branch_unit_name is null
      and f.assessment_id = p_step.assessment_id and f.editable_unit_name is not null
    union all
    -- 稽核室：廠區經理人
    select e.position from earlier e
    where p_step.step_group = 'audit_review' and e.branch_unit_name is null and e.step_group = 'plant'
  ) x
  where x.position is not null
$$;
comment on function public.return_targets(public.assessment_step) is
  '這一關可以退回到哪幾關（關卡順序，Q116 (10)）：分流內退回本分流的前一關；匯流後退回前一關或任一單位的自行檢查人員，稽核室另可退到廠區經理人。';
revoke execute on function public.return_targets(public.assessment_step) from public, anon, authenticated;

-- 輪到誰 -------------------------------------------------------------------------------

create or replace function public.is_signer_up_to_current_step(p_assessment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.assessment_step s
    where s.assessment_id = p_assessment_id
      and s.signer_emp_id = public.current_emp_id()
      and s.state in ('current', 'done')
  )
$$;
comment on function public.is_signer_up_to_current_step(uuid) is
  '呼叫者是不是這張自評表某一關「輪到或已完成」的簽核人（正在簽或已簽過）；分流並行時以各關的狀態判斷。';

-- 可編輯範圍的唯一定義（取代 my_editable_unit）：呼叫者輪到的答題關的自評單位，依關卡順序；沒有就是空陣列。
create or replace function public.my_editable_units(a public.assessment)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(s.editable_unit_name order by s.position), '{}')
  from public.assessment_step s
  where s.assessment_id = a.id
    and a.status = 'in_progress'
    and s.state = 'current'
    and s.editable_unit_name is not null
    and s.signer_emp_id = public.current_emp_id()
$$;
comment on function public.my_editable_units(public.assessment) is
  '呼叫者現在能作答的自評單位：簽核中、呼叫者是某個輪到的答題關的簽核人時，那些關卡的可編輯範圍；否則空陣列（唯讀）。';

create or replace function public.can_edit_unit(p_assessment_id uuid, p_unit_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p_unit_name = any(public.my_editable_units(a))
    from public.assessment a
    where a.id = p_assessment_id
  ), false)
$$;

create or replace function public.can_approve(a public.assessment)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.assessment_step s
    where s.assessment_id = a.id
      and a.status = 'in_progress'
      and s.state = 'current'
      and s.editable_unit_name is null
      and s.signer_emp_id = public.current_emp_id()
  )
$$;
comment on function public.can_approve(public.assessment) is
  '呼叫者現在能不能核准或退回這張自評表：簽核中、呼叫者是某個輪到的、沒有可編輯範圍的關卡（主管與稽核關卡）的簽核人。';

-- 呼叫者現在輪到的每一關（頁面依它顯示送出、核准、退回）：
--   [{position, name, branch_unit_name, editable_unit_name, return_targets:[關卡順序], closes}]
-- closes＝核准這一關就結案（其他關卡都已完成）。
create or replace function public.my_current_steps(a public.assessment)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'position', s.position,
           'name', s.name,
           'branch_unit_name', s.branch_unit_name,
           'editable_unit_name', s.editable_unit_name,
           'return_targets', to_jsonb(public.return_targets(s)),
           'closes', not exists (
             select 1 from public.assessment_step o
             where o.assessment_id = s.assessment_id and o.id <> s.id and o.state <> 'done')
         ) order by s.position), '[]'::jsonb)
  from public.assessment_step s
  where s.assessment_id = a.id
    and a.status = 'in_progress'
    and s.state = 'current'
    and s.signer_emp_id = public.current_emp_id()
$$;
comment on function public.my_current_steps(public.assessment) is
  '呼叫者現在輪到的關卡：[{position, name, branch_unit_name, editable_unit_name, return_targets, closes}]，依關卡順序。';

-- 階段（Q116 (11)）：還有任何一條分流停在答題關就是填寫中，否則簽核中；#99 只讀它。
create function public.assessment_stage(a public.assessment)
returns public.assessment_stage
language sql
stable
security definer
set search_path = public
as $$
  select case
    when a.status = 'closed' then 'closed'
    when exists (
      select 1 from public.assessment_step s
      where s.assessment_id = a.id and s.state = 'current' and s.editable_unit_name is not null
    ) then 'filling'
    else 'signing'
  end::public.assessment_stage
$$;
comment on function public.assessment_stage(public.assessment) is
  '「填寫中」的唯一定義：簽核中而且有任何一條分流輪到答題關；其餘簽核中的是簽核中，結案是結案（Q115、Q116 (11)）。';

-- 其他單位的答案（Q116 (9)） ------------------------------------------------------------------

-- 看得到全部答案的人：稽核管理者、這個廠區的檢視者、匯流後關卡（廠區經理人、稽核室）輪到過或簽過的簽核人。
-- #100 會在這裡加廠區負責人。
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
$$;
comment on function public.can_see_all_answers(uuid) is
  '呼叫者不受「單位送出後才看得到」限制、看得到這張自評表全部答案：稽核管理者、檢視者、匯流後關卡輪到過或簽過的簽核人（Q116 (9)）。';

-- 一個自評單位的答案與整體結論誰看得到：看得到自評表，而且 (看得到全部，或這是自己現在能答的單位，
-- 或這個單位已送出、而且自己所在的某條分流的單位也已送出)。「已送出」＝那個單位的答題關已完成，被退回重填就不算。
create or replace function public.can_view_unit_answers(p_assessment_id uuid, p_unit_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_view_assessment(p_assessment_id)
     and (
       public.can_see_all_answers(p_assessment_id)
       or exists (
            select 1 from public.assessment a
            where a.id = p_assessment_id and p_unit_name = any(public.my_editable_units(a))
          )
       or (
         exists (
           select 1 from public.assessment_step u
           where u.assessment_id = p_assessment_id and u.editable_unit_name = p_unit_name and u.state = 'done'
         )
         and exists (
           select 1
           from public.assessment_step mine
           join public.assessment_step answered
             on answered.assessment_id = mine.assessment_id
            and answered.editable_unit_name = mine.branch_unit_name
            and answered.state = 'done'
           where mine.assessment_id = p_assessment_id
             and mine.signer_emp_id = public.current_emp_id()
         )
       )
     )
$$;
comment on function public.can_view_unit_answers(uuid, text) is
  '呼叫者讀不讀得到這張自評表上這個自評單位的答案與整體結論（Q116 (9)）。';

alter policy assessment_answer_select_visible on public.assessment_answer
  using (public.can_view_unit_answers(assessment_id, assessing_unit_name));
alter policy assessment_conclusion_select_visible on public.assessment_conclusion
  using (public.can_view_unit_answers(assessment_id, assessing_unit_name));

-- 送出、核准、退回共用 ---------------------------------------------------------------------
-- 鎖住自評表（送出、核准、退回與答案的寫入都依這一列排隊，#6 的 Q85 (10)），回傳呼叫者要簽的那一關：
-- 給了 p_step_position 就是那一關，必須輪到而且是呼叫者的；沒給就取呼叫者輪到的關卡中最前面的一關，
-- 答題關與只核准的關卡都有時，依 p_prefer_editable 先取那一種（讓只給自評表 id 的舊呼叫方式照舊）。
-- 自評表不存在、已結案、或沒有符合的關卡，丟 42501。

drop function public.lock_my_current_step(uuid);
drop function public.next_step_position(public.assessment_step);

create function public.lock_my_current_step(p_assessment_id uuid, p_step_position integer, p_prefer_editable boolean)
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
  select * into s
  from public.assessment_step
  where assessment_id = a.id
    and state = 'current'
    and signer_emp_id = public.current_emp_id()
    and (p_step_position is null or position = p_step_position)
  order by (editable_unit_name is not null) is distinct from p_prefer_editable, position
  limit 1;
  if not found then
    raise exception 'only the 簽核人 of a current 關卡 can sign it off' using errcode = '42501';
  end if;
  return s;
end
$$;
comment on function public.lock_my_current_step(uuid, integer, boolean) is
  '送出／核准／退回的共同開頭：鎖住自評表，確認簽核中，回傳呼叫者輪到的那一關（指定的或最前面的）。';
revoke execute on function public.lock_my_current_step(uuid, integer, boolean) from public, anon, authenticated;

-- 推進後同一條線上（同分流，或匯流後）現在輪到的關卡；分流完成而其他分流還沒完成時是空值。
create or replace function public.next_current_position(p_step public.assessment_step)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select min(n.position) from public.assessment_step n
  where n.assessment_id = p_step.assessment_id
    and n.state = 'current'
    and (n.branch_unit_name is null or n.branch_unit_name = p_step.branch_unit_name)
$$;
comment on function public.next_current_position(public.assessment_step) is
  '內部用：這一關簽完後，同分流（或匯流後）輪到的關卡；還在等其他分流時是空值。';
revoke execute on function public.next_current_position(public.assessment_step) from public, anon, authenticated;

-- 送出 ------------------------------------------------------------------------------------
-- 自行檢查人員送出自己分流的答題關：驗證與回傳同 20261107000000，多了 p_step_position（同一人輪到好幾個單位時指定
-- 哪一關；不給就取最前面的答題關）。成功回傳 {ok:true, current_step_position}：本分流的下一關，分流就此完成時是
-- 匯流後的第一關（所有分流都完成）或空值（還在等其他分流）。
-- no_next_step：這一關是本分流最後一關，而且流程沒有匯流後的關卡（結案只發生在核准，流程設錯）。

drop function public.submit_assessment_step(uuid);

create function public.submit_assessment_step(p_assessment_id uuid, p_step_position integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s             public.assessment_step;
  v_layout      public.template_layout;
  v_violations  jsonb;
begin
  s := public.lock_my_current_step(p_assessment_id, p_step_position, true);
  if s.editable_unit_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_self_check_step');
  end if;
  if not exists (
    select 1 from public.assessment_step n
    where n.assessment_id = s.assessment_id
      and (n.branch_unit_name is null or (n.branch_unit_name = s.branch_unit_name and n.position > s.position))
  ) then
    return jsonb_build_object('ok', false, 'error', 'no_next_step');
  end if;
  select template_layout into v_layout from public.assessment where id = s.assessment_id;

  with points as (
    select cp.id, sec.position as section_position, cp.position,
           ans.design, ans.execution, ans.satisfaction, nullif(btrim(ans.improvement), '') as improvement
    from public.assessment_control_point_unit u
    join public.assessment_control_point cp on cp.id = u.control_point_id
    join public.assessment_section sec on sec.id = cp.section_id
    left join public.assessment_answer ans
      on ans.control_point_id = u.control_point_id and ans.assessing_unit_name = u.assessing_unit_name
    where u.assessment_id = s.assessment_id and u.assessing_unit_name = s.editable_unit_name
  ),
  -- 排序鍵：控制要點依紙本順序（章、題、規則），整體結論排最後。
  violations as (
    select section_position, position, 1 as rule_order,
           jsonb_build_object('kind', 'control_point', 'control_point_id', id, 'section_position', section_position,
                              'position', position, 'rule', 'unanswered') as v
    from points
    where not public.answer_is_complete(v_layout, design, execution, satisfaction)
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
  perform public.refresh_assessment_steps(s.assessment_id);
  return jsonb_build_object('ok', true, 'current_step_position', public.next_current_position(s));
end
$$;
comment on function public.submit_assessment_step(uuid, integer) is
  '送出（自行檢查人員）：驗證自己分流那個自評單位的答案與整體結論，通過才寫簽核紀錄，推進本分流（全部分流完成就匯流）。';

-- 核准 ------------------------------------------------------------------------------------
-- 主管與稽核關卡核准輪到自己的一關（p_step_position 同送出）。回傳 {ok:true, closed, current_step_position}：
-- 結案時是這一關，否則同送出（本分流下一關、匯流後輪到的關卡，或還在等其他分流的空值）。

drop function public.approve_assessment_step(uuid, text);

create function public.approve_assessment_step(p_assessment_id uuid, p_comment text default null, p_step_position integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s  public.assessment_step;
begin
  s := public.lock_my_current_step(p_assessment_id, p_step_position, false);
  if s.editable_unit_name is not null then
    return jsonb_build_object('ok', false, 'error', 'self_check_step');
  end if;

  perform public.record_signoff(s, 'approve', p_comment);
  if public.refresh_assessment_steps(s.assessment_id) = 'closed' then
    return jsonb_build_object('ok', true, 'closed', true, 'current_step_position', s.position);
  end if;
  return jsonb_build_object('ok', true, 'closed', false, 'current_step_position', public.next_current_position(s));
end
$$;
comment on function public.approve_assessment_step(uuid, text, integer) is
  '核准（主管與稽核關卡）：寫簽核紀錄，推進本分流或匯流後的下一關；最後一關核准即結案。';

-- 退回 ------------------------------------------------------------------------------------
-- 主管與稽核關卡把自評表退回 p_to_position（要在 return_targets 裡，Q116 (10)），原因必填；p_step_position 是退回的那一關
-- （同送出）。作廢：目標在某條分流時，該分流從目標起、以及匯流後全部的有效送出與核准；目標在匯流後時，匯流後
-- 從目標起的。退回紀錄本身不作廢。其他分流不動。錯誤與回傳同 20261018000000。

drop function public.return_assessment(uuid, integer, text);

create function public.return_assessment(
  p_assessment_id  uuid,
  p_to_position    integer,
  p_reason         text,
  p_step_position  integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s         public.assessment_step;
  t         public.assessment_step;
  v_return  public.assessment_signoff;
  v_voided  integer;
begin
  s := public.lock_my_current_step(p_assessment_id, p_step_position, false);
  if s.editable_unit_name is not null then
    return jsonb_build_object('ok', false, 'error', 'self_check_step');
  end if;
  if nullif(btrim(p_reason), '') is null then
    return jsonb_build_object('ok', false, 'error', 'reason_required');
  end if;
  if p_to_position is null or not p_to_position = any(public.return_targets(s)) then
    return jsonb_build_object('ok', false, 'error', 'invalid_target');
  end if;
  select * into t from public.assessment_step where assessment_id = s.assessment_id and position = p_to_position;

  v_return := public.record_signoff(s, 'return', p_reason, p_to_position);

  update public.assessment_signoff g
  set voided_by = v_return.id, voided_at = v_return.signed_at
  from public.assessment_step st
  where st.id = g.step_id
    and g.assessment_id = s.assessment_id
    and g.action in ('submit', 'approve')
    and g.voided_by is null
    and (
      (t.branch_unit_name is not null and st.branch_unit_name = t.branch_unit_name and st.position >= t.position)
      or (st.branch_unit_name is null and (t.branch_unit_name is not null or st.position >= t.position))
    );
  get diagnostics v_voided = row_count;

  perform public.refresh_assessment_steps(s.assessment_id);
  return jsonb_build_object('ok', true, 'current_step_position', p_to_position, 'voided', v_voided);
end
$$;
comment on function public.return_assessment(uuid, integer, text, integer) is
  '退回（主管與稽核關卡）：必填原因，作廢目標起（目標在分流時連同匯流後）的簽核，只有那條分流重新簽核。';

revoke execute on function public.submit_assessment_step(uuid, integer) from public, anon;
grant execute on function public.submit_assessment_step(uuid, integer) to authenticated;
revoke execute on function public.approve_assessment_step(uuid, text, integer) from public, anon;
grant execute on function public.approve_assessment_step(uuid, text, integer) to authenticated;
revoke execute on function public.return_assessment(uuid, integer, text, integer) from public, anon;
grant execute on function public.return_assessment(uuid, integer, text, integer) to authenticated;

-- 發起：快照多存分流，並讓每條分流的第一關同時開始；其餘與 20261026000000 相同。

-- ===== launch_annual_cycle (20261026000000_control_references.sql) =====
create or replace function public.launch_annual_cycle(
  p_year      integer,
  p_due_date  date,
  p_combos    jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_selected jsonb;
  v_invalid  jsonb;
  v_missing  jsonb;
  v_cycle    uuid;
  v_new      uuid;
  v_count    integer := 0;
  r          record;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can launch an annual cycle' using errcode = '42501';
  end if;

  if exists (select 1 from public.annual_cycle where year = p_year) then
    return jsonb_build_object('ok', false, 'error', 'cycle_exists');
  end if;

  if p_combos is not null then
    if jsonb_typeof(p_combos) <> 'array' then
      return jsonb_build_object('ok', false, 'error', 'invalid_combo', 'invalid', jsonb_build_array(p_combos));
    end if;
    select jsonb_agg(e) into v_invalid
    from jsonb_array_elements(p_combos) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'template_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(e ->> 'plant_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    if v_invalid is not null then
      return jsonb_build_object('ok', false, 'error', 'invalid_combo', 'invalid', v_invalid);
    end if;
  end if;

  perform 1
  from public.questionnaire_template t
  where t.status = 'active'
    and (p_combos is null or exists (select 1 from jsonb_array_elements(p_combos) e where (e ->> 'template_id')::uuid = t.id))
  order by t.id
  for share;

  perform 1
  from public.approval_route ar
  where ar.status = 'active'
    and (
      p_combos is null
      or exists (
        select 1 from jsonb_array_elements(p_combos) e
        where (e ->> 'template_id')::uuid = ar.template_id and (e ->> 'plant_id')::uuid = ar.plant_id
      )
    )
  order by ar.id
  for share;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.template_code, c.factory_code), '[]'::jsonb)
  into v_selected
  from public.launch_candidates() c
  where p_combos is null
     or exists (
       select 1 from jsonb_array_elements(p_combos) e
       where (e ->> 'template_id')::uuid = c.template_id and (e ->> 'plant_id')::uuid = c.plant_id
     );

  if p_combos is not null then
    select jsonb_agg(e) into v_invalid
    from jsonb_array_elements(p_combos) e
    where not exists (
      select 1 from jsonb_array_elements(v_selected) c
      where (c ->> 'template_id')::uuid = (e ->> 'template_id')::uuid
        and (c ->> 'plant_id')::uuid = (e ->> 'plant_id')::uuid
    );
    if v_invalid is not null then
      return jsonb_build_object('ok', false, 'error', 'invalid_combo', 'invalid', v_invalid);
    end if;
  end if;

  if jsonb_array_length(v_selected) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_combos');
  end if;

  select jsonb_agg(c order by ord)
  into v_missing
  from jsonb_array_elements(v_selected) with ordinality as x(c, ord)
  where c ->> 'problem' is not null;
  if v_missing is not null then
    return jsonb_build_object('ok', false, 'error', 'missing_route', 'missing', v_missing);
  end if;

  begin
    insert into public.annual_cycle (year, due_date)
    values (p_year, p_due_date)
    returning id into v_cycle;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'cycle_exists');
  end;

  for r in
    select t.id as template_id, t.code, t.name, t.layout, t.version, c.plant_id, c.route_id
    from jsonb_to_recordset(v_selected) as c(template_id uuid, plant_id uuid, route_id uuid, template_code text, factory_code text)
    join public.questionnaire_template t on t.id = c.template_id
    order by c.template_code, c.factory_code
  loop
    insert into public.assessment (
      cycle_id, plant_id, template_id, template_code, template_name, template_layout, template_version
    )
    values (
      v_cycle, r.plant_id, r.template_id, r.code, r.name, r.layout, r.version
    )
    returning id into v_new;

    insert into public.assessment_section (assessment_id, position, name)
    select v_new, s.position, s.name
    from public.template_section s
    where s.template_id = r.template_id;

    insert into public.assessment_control_point (assessment_id, section_id, position, text)
    select v_new, snap.id, cp.position, cp.text
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.control_point cp on cp.section_id = ts.id
    where ts.template_id = r.template_id;

    insert into public.assessment_control_point_unit (assessment_id, control_point_id, position, assessing_unit_name)
    select v_new, snap_cp.id, cpu.position, u.name
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.control_point cp on cp.section_id = ts.id
    join public.assessment_control_point snap_cp on snap_cp.section_id = snap.id and snap_cp.position = cp.position
    join public.control_point_unit cpu on cpu.control_point_id = cp.id
    join public.assessing_unit u on u.id = cpu.assessing_unit_id
    where ts.template_id = r.template_id;

    insert into public.assessment_section_document (
      assessment_id, section_id, position, document_number, document_code, document_name, document_version, pdf_file
    )
    select v_new, snap.id, scd.position, d.number, d.code, d.name, ver.version, ver.pdf_file
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.section_control_document scd on scd.section_id = ts.id and scd.plant_id = r.plant_id
    join public.control_document_version ver on ver.id = scd.version_id
    join public.control_document d on d.id = ver.document_id
    where ts.template_id = r.template_id;

    insert into public.assessment_control_reference (
      assessment_id, control_point_id, position, document_number, document_code, document_name, document_version, pdf_file,
      clause_number, clause_text
    )
    select v_new, snap_cp.id, cr.position, d.number, d.code, d.name, ver.version, ver.pdf_file,
           cl.number, public.clause_text_with_subclauses(cl.id)
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.control_point cp on cp.section_id = ts.id
    join public.assessment_control_point snap_cp on snap_cp.section_id = snap.id and snap_cp.position = cp.position
    join public.control_reference cr on cr.control_point_id = cp.id and cr.plant_id = r.plant_id
    join public.control_clause cl on cl.id = cr.clause_id
    join public.control_document_version ver on ver.id = cl.version_id
    join public.control_document d on d.id = ver.document_id
    where ts.template_id = r.template_id;

    insert into public.assessment_step (
      assessment_id, position, name, step_group, signer_emp_id, editable_unit_name, branch_unit_name
    )
    select v_new, rs.position, rs.name, rs.step_group, rs.signer_emp_id, u.name, bu.name
    from public.route_step rs
    left join public.assessing_unit u on u.id = rs.editable_unit_id
    left join public.assessing_unit bu on bu.id = rs.branch_unit_id
    where rs.route_id = r.route_id;
    -- 每條分流的第一關同時開始（Q116 (1)）。
    perform public.refresh_assessment_steps(v_new);

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'cycle_id', v_cycle, 'assessments', v_count);
end
$$;

-- 權限移除的影響（#58）：還沒完成的關卡；輪到的是 current，還沒輪到的是 later。其餘與 20261030000000 相同。
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
    select case when s.state = 'current' then 'current' else 'later' end,
           a.id, null::uuid, c.year, a.template_code, a.template_name, p.factory_code, p.name, s.position, s.name
      from public.assessment_step s
      join public.assessment a on a.id = s.assessment_id
      join public.annual_cycle c on c.id = a.cycle_id
      join public.plant p on p.id = a.plant_id
     where s.signer_emp_id = upper(btrim(p_emp_id))
       and a.status = 'in_progress'
       and s.state <> 'done'
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

-- 流程編輯：關卡的分流可以修改（#98 的編輯器用）；新增關卡多一個參數，其餘與 20261019000000 相同。
grant update (branch_unit_id) on public.route_step to authenticated;

drop function public.insert_route_step(uuid, text, public.step_group, text, uuid, integer);

create function public.insert_route_step(
  p_route_id          uuid,
  p_name              text,
  p_step_group        public.step_group,
  p_signer_emp_id     text,
  p_editable_unit_id  uuid default null,
  p_before_position   integer default null,
  p_branch_unit_id    uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count  integer;
  v_id     uuid;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can add steps' using errcode = '42501';
  end if;
  perform 1 from public.approval_route where id = p_route_id for update;
  if not found then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
  select count(*) into v_count from public.route_step where route_id = p_route_id;
  if p_before_position is not null and (p_before_position < 1 or p_before_position > v_count) then
    raise exception 'p_before_position must be between 1 and %', v_count using errcode = '22023';
  end if;
  if p_before_position is not null then
    update public.route_step set position = position + 1
    where route_id = p_route_id and position >= p_before_position;
  end if;
  insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id, branch_unit_id)
  values (p_route_id, p_before_position, btrim(p_name), p_step_group, btrim(p_signer_emp_id), p_editable_unit_id, p_branch_unit_id)
  returning id into v_id;
  return v_id;
end
$$;
comment on function public.insert_route_step(uuid, text, public.step_group, text, uuid, integer, uuid) is
  '稽核管理者新增關卡：排最後，或插在第 p_before_position 關之前；p_branch_unit_id 是所屬分流（自行檢查人員關卡自動帶可編輯範圍）；回傳關卡 id。';
revoke execute on function public.insert_route_step(uuid, text, public.step_group, text, uuid, integer, uuid) from public, anon;
grant execute on function public.insert_route_step(uuid, text, public.step_group, text, uuid, integer, uuid) to authenticated;

-- 草稿途徑（Q90、ADR 0006）的簽核流程也要知道每一關的分流（Q116）：關卡定義多一個 branchUnit（部門主管、多加的那
-- 一關屬於哪個自評單位的分流；自行檢查人員關卡由可編輯範圍帶，稽核室與廠區經理人不填）。打錯的單位名稱同可編輯範圍，
-- 整份拒絕（P0002）。其餘同 20261023000000。

create or replace function public.draft_route(p_def jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template  uuid;
  v_plant     uuid;
  v_route     uuid;
  v_unknown   text;
  v_steps     integer;
begin
  perform public.enter_draft_path();
  perform public.reject_non_draft_status(p_def);
  if jsonb_typeof(p_def -> 'steps') is distinct from 'array' or jsonb_array_length(p_def -> 'steps') = 0 then
    raise exception '簽核流程沒有關卡' using errcode = '23514';
  end if;

  select id into v_template from public.questionnaire_template
  where code = btrim(p_def ->> 'templateCode') and version = btrim(p_def ->> 'templateVersion');
  if v_template is null then
    raise exception '找不到範本 % 版本 %', p_def ->> 'templateCode', p_def ->> 'templateVersion' using errcode = 'P0002';
  end if;
  select id into v_plant from public.plant where factory_code = upper(btrim(p_def ->> 'factoryCode'));
  if v_plant is null then
    raise exception '找不到廠區 %', p_def ->> 'factoryCode' using errcode = 'P0002';
  end if;
  select btrim(named.unit) into v_unknown
  from jsonb_array_elements(p_def -> 'steps') st
  cross join lateral (values (st ->> 'editableUnit'), (st ->> 'branchUnit')) named (unit)
  where coalesce(btrim(named.unit), '') <> ''
    and not exists (select 1 from public.assessing_unit u where u.name = btrim(named.unit))
  limit 1;
  if v_unknown is not null then
    raise exception '自評單位清單上沒有「%」', v_unknown using errcode = 'P0002';
  end if;

  insert into public.approval_route (template_id, plant_id, status)
  values (v_template, v_plant, 'draft')
  returning id into v_route;

  -- 分流：自行檢查人員關卡由觸發器帶可編輯範圍；其他廠區端關卡（部門主管、多加的那一關）照 branchUnit。
  insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id, branch_unit_id)
  select v_route, t.ord, btrim(t.st ->> 'name'), (t.st ->> 'group')::public.step_group, btrim(t.st ->> 'signer'), u.id, b.id
  from jsonb_array_elements(p_def -> 'steps') with ordinality as t(st, ord)
  left join public.assessing_unit u on u.name = btrim(t.st ->> 'editableUnit')
  left join public.assessing_unit b on b.name = btrim(t.st ->> 'branchUnit');
  get diagnostics v_steps = row_count;

  return jsonb_build_object('ok', true, 'route_id', v_route, 'steps', v_steps);
end
$$;

comment on function public.draft_route(jsonb) is
  '草稿途徑：把一條簽核流程定義寫成新的草稿流程（每一關可帶 branchUnit 指定分流，Q116）；只給 csa_drafter (Q90)。';
revoke execute on function public.draft_route(jsonb) from public, anon, authenticated;
grant execute on function public.draft_route(jsonb) to csa_drafter;

-- 轉換現有資料 ------------------------------------------------------------------------------
-- 簽核流程與自評表的關卡：自行檢查人員關卡的分流是它的可編輯範圍；其他廠區端關卡的名稱是「職稱－單位」，而且那個
-- 單位是同一條流程裡某個自行檢查人員關卡的單位，就屬於那條分流（部門主管）；其餘在匯流後（廠區經理人）。
-- 簽核中的自評表依有效的簽核紀錄重算狀態：原本目前關卡之前的都已簽，所以每條分流停在它第一個沒簽的關卡，
-- 原本的目前關卡仍是輪到的關卡（原本排在它後面、還沒輪到的其他單位，現在同時輪到）。結案的全部已完成。
-- 對應不了的寫進 branch_conversion_issue（測試環境怎麼處理由 #103 決定）：
--   unmapped_step         廠區端唯讀關卡沒有對應到分流，而且看起來應該有：排在某個分流關卡之前、名稱帶「－」
--                         （「職稱－單位」對不上單位），或是部門主管（沒有「－單位」、替所有單位簽一次，使用者
--                         2026-11-03 決定要列出）。轉換後它在匯流後；寧可多列給人看，不默默當成匯流後的關卡
--   signed_step_reopened  （自評表）原本目前關卡之前的關卡，轉換後不是已完成（沒有有效的簽核紀錄，或被上一項移到匯流後）
--   current_step_moved    （自評表）原本的目前關卡，轉換後不是輪到的關卡

create table public.branch_conversion_issue (
  id             bigint generated always as identity primary key,
  route_id       uuid references public.approval_route (id) on delete cascade,
  assessment_id  uuid references public.assessment (id) on delete cascade,
  step_position  integer not null,
  step_name      text not null,
  issue          text not null check (issue in ('unmapped_step', 'signed_step_reopened', 'current_step_moved')),
  created_at     timestamptz not null default now(),
  check ((route_id is null) <> (assessment_id is null))
);
comment on table public.branch_conversion_issue is
  '分流轉換（#97）對應不了的關卡：簽核流程或自評表、關卡、原因；只有轉換時寫入，稽核管理者讀得到。';

alter table public.branch_conversion_issue enable row level security;
create policy branch_conversion_issue_select_audit_admin on public.branch_conversion_issue
  for select to authenticated using ((select public.is_audit_admin()));
grant select on public.branch_conversion_issue to authenticated;
revoke insert, update, delete on public.branch_conversion_issue from authenticated;
revoke all on public.branch_conversion_issue from anon;

-- 轉換只補欄位，不是人的修改：關掉流程修改時間、啟用檢查、結案鎖定與 updated_at 的觸發器。
alter table public.route_step disable trigger user;
alter table public.assessment_step disable trigger user;
alter table public.assessment disable trigger user;

update public.route_step set branch_unit_id = editable_unit_id where editable_unit_id is not null;
update public.route_step rs
set branch_unit_id = sc.editable_unit_id
from public.route_step sc
join public.assessing_unit u on u.id = sc.editable_unit_id
where sc.route_id = rs.route_id
  and rs.editable_unit_id is null
  and rs.step_group = 'plant'
  and rs.name ~ '[－‐‑‒–—―-]'
  and btrim(regexp_replace(rs.name, '^[^－‐‑‒–—―-]*[－‐‑‒–—―-]', '')) = u.name;

update public.assessment_step set branch_unit_name = editable_unit_name where editable_unit_name is not null;
update public.assessment_step s
set branch_unit_name = sc.editable_unit_name
from public.assessment_step sc
where sc.assessment_id = s.assessment_id
  and sc.editable_unit_name is not null
  and s.editable_unit_name is null
  and s.step_group = 'plant'
  and s.name ~ '[－‐‑‒–—―-]'
  and btrim(regexp_replace(s.name, '^[^－‐‑‒–—―-]*[－‐‑‒–—―-]', '')) = sc.editable_unit_name;

insert into public.branch_conversion_issue (route_id, step_position, step_name, issue)
select rs.route_id, rs.position, rs.name, 'unmapped_step'
from public.route_step rs
where rs.step_group = 'plant'
  and rs.branch_unit_id is null
  and (rs.position < (select max(b.position) from public.route_step b where b.route_id = rs.route_id and b.branch_unit_id is not null)
       or rs.name ~ '[－‐‑‒–—―-]'
       or rs.name like '%部門主管%')
order by rs.route_id, rs.position;

insert into public.branch_conversion_issue (assessment_id, step_position, step_name, issue)
select s.assessment_id, s.position, s.name, 'unmapped_step'
from public.assessment_step s
where s.step_group = 'plant'
  and s.branch_unit_name is null
  and (s.position < (select max(b.position) from public.assessment_step b
                     where b.assessment_id = s.assessment_id and b.branch_unit_name is not null)
       or s.name ~ '[－‐‑‒–—―-]'
       or s.name like '%部門主管%')
order by s.assessment_id, s.position;

update public.assessment_step s
set state = 'done'
from public.assessment a
where a.id = s.assessment_id and a.status = 'closed';

do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.assessment where status = 'in_progress' order by id
  loop
    perform public.refresh_assessment_steps(v_id);
  end loop;
end
$$;

insert into public.branch_conversion_issue (assessment_id, step_position, step_name, issue)
select s.assessment_id, s.position, s.name,
       case when s.position < a.current_step_position then 'signed_step_reopened' else 'current_step_moved' end
from public.assessment_step s
join public.assessment a on a.id = s.assessment_id
where a.status = 'in_progress'
  and ((s.position < a.current_step_position and s.state <> 'done')
       or (s.position = a.current_step_position and s.state <> 'current'))
order by s.assessment_id, s.position;

alter table public.route_step enable trigger user;
alter table public.assessment_step enable trigger user;
alter table public.assessment enable trigger user;

-- 讀「目前關卡」的 view：改讀關卡狀態，再移除 current_step_position 欄位 ----------------------------
-- 追蹤總覽：欄位不變（#99 改呈現與最久沒動的分流）；目前關卡、簽核人取最前面一個輪到的關卡。其餘同 20261030000000。

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
  s.position                  as current_step_position,
  (select count(*)::int from public.assessment_step n where n.assessment_id = a.id) as step_count,
  s.name                      as current_step_name,
  s.signer_emp_id             as current_signer_emp_id,
  n.name                      as current_signer_name,
  m.entered_step_at,
  case when a.status = 'in_progress'
    then (now() at time zone 'Asia/Taipei')::date - (m.entered_step_at at time zone 'Asia/Taipei')::date
  end                         as days_at_step,
  case when a.status = 'closed' then m.entered_step_at end as closed_at,
  public.assessment_stage(a)  as stage,
  public.taipei_days_until(c.due_date) as due_in_days
from public.assessment a
join public.annual_cycle c on c.id = a.cycle_id
join public.plant p on p.id = a.plant_id
join public.company co on co.id = p.company_id
join public.assessment_step s
  on s.assessment_id = a.id and s.position = public.current_step_position(a)
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
  '追蹤總覽（稽核管理者看全部、檢視者看檢視廠區）：每張自評表最前面一個輪到的關卡、簽核人與停留天數；停留天數從最後一筆簽核紀錄或發起時間起算（Q95）；'
  'stage＝填寫中／簽核中／結案（Q115、Q116 (11)），due_in_days＝距截止日的台北日曆天（Q115）。';

drop view public.my_pending_assessment;
drop view public.my_assessment;
drop function public.my_editable_unit(public.assessment);
drop function public.assessment_stage(public.assessment_status, text);

alter table public.assessment drop column current_step_position;

-- 我在一張自評表上的關卡：輪到我的最前面一關（順序、名稱），以及我還有沒有沒輪到的關卡。security definer：看得到
-- 自評表的人本來就看得到它的每一關，這裡只是不必逐列再做一次關卡的可見性檢查（my_assessment 的效能，#44）。
create or replace function public.my_step_summary(
  a                    public.assessment,
  out my_step_position integer,
  out my_step_name     text,
  out my_step_ahead    boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (array_agg(s.position order by s.position) filter (where s.state = 'current' and a.status = 'in_progress'))[1],
    (array_agg(s.name order by s.position) filter (where s.state = 'current' and a.status = 'in_progress'))[1],
    coalesce(bool_or(s.state = 'pending'), false)
  from public.assessment_step s
  where s.assessment_id = a.id and s.signer_emp_id = public.current_emp_id()
$$;
comment on function public.my_step_summary(public.assessment) is
  '呼叫者在這張自評表上輪到的最前面一關（簽核中才有），以及有沒有還沒輪到的關卡。';

-- 我的填寫進度（Q115）：我現在輪到的全部答題單位加總；沒有輪到答題時三個都是空值。security definer 的理由同
-- my_step_summary：只數呼叫者自己輪到的單位（my_editable_units 依呼叫者判斷），不必逐列再檢查控制要點與答案的可見性，
-- 計畫也不會因為統計值改走整表掃描而逐列檢查（my_assessment 的效能，#44）。
create or replace function public.my_answer_progress(
  a                     public.assessment,
  out my_answered       integer,
  out my_question_count integer,
  out my_started        boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (select public.my_editable_units(a) as units)
  select
    case when cardinality(mine.units) > 0 then p.answered end,
    case when cardinality(mine.units) > 0 then p.total end,
    case when cardinality(mine.units) > 0 then p.started end
  from mine
  cross join lateral (
    select
      count(*)::int as total,
      count(*) filter (where public.answer_is_complete(a.template_layout, ans.design, ans.execution, ans.satisfaction))::int as answered,
      count(*) filter (
        where ans.design is not null or ans.execution is not null or ans.satisfaction is not null
           or nullif(btrim(ans.improvement), '') is not null
      ) > 0
      or exists (
        select 1 from public.assessment_conclusion c
        where c.assessment_id = a.id and c.assessing_unit_name = any(mine.units)
      ) as started
    from public.assessment_control_point_unit u
    left join public.assessment_answer ans
      on ans.control_point_id = u.control_point_id and ans.assessing_unit_name = u.assessing_unit_name
    where u.assessment_id = a.id and u.assessing_unit_name = any(mine.units)
  ) p
$$;
comment on function public.my_answer_progress(public.assessment) is
  '呼叫者的填寫進度：現在輪到他答的全部自評單位，已答完的題數、總題數、有沒有開始填（含整體結論）；沒輪到答題時都是空值。';

-- 我的自評表（Q115）：一張表一列，分流並行時我同時輪到好幾關也是一列（Q116 首頁待處理）。
--   my_turn     我有輪到的關卡；my_step_position／my_step_name 是其中最前面一關（我的待簽顯示它）
--   my_part     fill＝我有輪到的答題關（my_editable_units 有值）；sign＝輪到我、只簽核；upcoming＝我還有沒輪到的關卡；done
--   我的填寫進度  我輪到的全部答題單位加總
-- current_step_position／current_step_name 是整張表最前面一個輪到的關卡（摘要）。出發點與 lateral 的理由見 20261028000000。
create view public.my_assessment
with (security_invoker = true) as
select
  m.assessment_id,
  m.year,
  m.due_date,
  m.template_code,
  m.template_name,
  m.factory_code,
  m.plant_name,
  m.status,
  m.current_step_position,
  m.current_step_name,
  (m.my_step_position is not null) as my_turn,
  m.stage,
  public.taipei_days_until(m.due_date) as due_in_days,
  case
    when cardinality(m.my_units) > 0 then 'fill'
    when m.my_step_position is not null then 'sign'
    when m.status = 'in_progress' and m.my_step_ahead then 'upcoming'
    else 'done'
  end::public.my_assessment_part as my_part,
  m.my_answered,
  m.my_question_count,
  m.my_started,
  m.my_step_position,
  m.my_step_name
from public.my_route_assessment_ids() mine (assessment_id)
cross join lateral (
  select
    a.id              as assessment_id,
    c.year,
    c.due_date,
    a.template_code,
    a.template_name,
    p.factory_code,
    p.name            as plant_name,
    a.status,
    cur.position      as current_step_position,
    cur.name          as current_step_name,
    public.assessment_stage(a) as stage,
    -- 答題的規則只在 my_editable_units：有值就是輪到我答這些自評單位。
    public.my_editable_units(a) as my_units,
    my.my_step_position,
    my.my_step_name,
    my.my_step_ahead,
    progress.my_answered,
    progress.my_question_count,
    progress.my_started
  from public.assessment a
  join public.annual_cycle c on c.id = a.cycle_id
  join public.plant p on p.id = a.plant_id
  -- lateral：依 (assessment_id, position) 讀那一關，RLS 只檢查這一列。
  cross join lateral (
    select s.position, s.name from public.assessment_step s
    where s.assessment_id = a.id and s.position = public.current_step_position(a)
  ) cur
  cross join lateral public.my_step_summary(a) my
  -- 只有輪到我答題的才數題目（其他列是空值，不是 0）。
  cross join lateral public.my_answer_progress(a) progress
  where a.id = mine.assessment_id
  offset 0
) m;
comment on view public.my_assessment is
  '我參與的自評表（我在流程上而且看得到的）：一張一列，含階段、我的部分與我的填寫進度（Q115）；分流並行時我輪到好幾關也是一列（Q116）。';

create view public.my_pending_assessment
with (security_invoker = true) as
select
  assessment_id,
  year,
  due_date,
  template_code,
  template_name,
  factory_code,
  plant_name,
  my_step_position as step_position,
  my_step_name     as step_name
from public.my_assessment
where my_turn;
comment on view public.my_pending_assessment is '輪到目前登入者簽核的自評表（我的待簽）：一張一列，關卡是我輪到的最前面一關。';

grant select on public.my_assessment, public.my_pending_assessment to authenticated;
revoke all on public.my_assessment, public.my_pending_assessment from anon;

-- 計算欄位與 policy 用的函式：只開給登入者 -------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.current_step_position(public.assessment)',
    'public.my_editable_units(public.assessment)',
    'public.my_current_steps(public.assessment)',
    'public.my_step_summary(public.assessment)',
    'public.my_answer_progress(public.assessment)',
    'public.assessment_stage(public.assessment)',
    'public.can_see_all_answers(uuid)',
    'public.can_view_unit_answers(uuid, text)'
  ]
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
