-- 簽核流程、年度發起、自評表快照 (工單 #4)。用語依 GLOSSARY.md。
--
-- 結構: 公司 → 廠區；簽核流程（範本 × 廠區）→ 關卡；年度作業 → 自評表 → 章節／控制要點／關卡的快照。
-- 自評表發出時複製當下的範本與流程，之後都不再參照它們 (ADR-0004)，所以快照表裡的自評單位存名稱、
-- 不存 id；自評表只留 template_id 當來源記錄。內控依據的快照在 #9 加進發起函式。
--
-- 誰讀得到什麼 (ADR-0001, 2026-10-15 決定): 自評表給「關卡順序 ≤ 目前關卡的簽核人」（正在簽的與已簽過的）
-- 和稽核管理者；還沒輪到的簽核人與不在流程裡的人，透過 API 也讀不到。結案後已簽過的人仍看得到（要看歷程、匯 PDF）。
-- 這支 migration 沒有任何一般使用者的寫入授權；寫入只有「發起年度作業」函式（稽核管理者呼叫），
-- 其餘寫入規則（答題、核准、退回、流程編輯）由 #5、#6、#11 各自加入。

-- 公司、廠區 ------------------------------------------------------------------

create table public.company (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);
comment on table public.company is '公司：法人，名稱印在自評表抬頭，如「福清富群電子有限公司」。Logo 在 #7 加。';

create table public.plant (
  id            uuid primary key default gen_random_uuid(),
  -- 廠區主檔來源未定案 (Q68)：以 OMS 廠區代碼對應，名稱只供顯示。
  factory_code  text not null unique,
  name          text not null,
  company_id    uuid not null references public.company (id),
  created_at    timestamptz not null default now()
);
comment on table public.plant is '廠區：收受自評表的單位，對應一個 OMS 廠區代碼並隸屬於一家公司。';

-- 簽核流程 --------------------------------------------------------------------

create type public.route_status as enum ('draft', 'active', 'inactive');
comment on type public.route_status is '簽核流程的狀態：草稿／啟用／停用；只有啟用的流程能被年度發起使用。';

create type public.step_group as enum ('plant', 'audit_review');
comment on type public.step_group is '關卡群組：plant＝廠區端；audit_review＝稽核室覆核。';

create table public.approval_route (
  id           uuid primary key default gen_random_uuid(),
  template_id  uuid not null references public.questionnaire_template (id),
  plant_id     uuid not null references public.plant (id),
  status       public.route_status not null default 'draft',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- 同一個「範本 × 廠區」同時只能有一條啟用的流程；草稿與停用的可以有很多條。
create unique index approval_route_one_active_idx
  on public.approval_route (template_id, plant_id) where status = 'active';
comment on table public.approval_route is '簽核流程：一份問卷範本在某廠區要經過的有序關卡清單。';

create table public.route_step (
  id                uuid primary key default gen_random_uuid(),
  route_id          uuid not null references public.approval_route (id) on delete cascade,
  position          integer not null check (position > 0),
  name              text not null,
  step_group        public.step_group not null,
  -- 簽核人以 OMS 工號指定 (Q61)；CSA 不建帳號表，所以不是外鍵。
  signer_emp_id     text not null,
  -- 可編輯範圍：某一個自評單位；空值＝全部唯讀。
  editable_unit_id  uuid references public.assessing_unit (id),
  unique (route_id, position)
);
comment on table public.route_step is '關卡：流程中的一站（名稱、群組、簽核人、可編輯範圍）；順序單一直線 (ADR-0003)。';

create trigger approval_route_touch_updated_at
  before update on public.approval_route
  for each row execute function public.touch_updated_at();

-- 年度作業、自評表與快照 -------------------------------------------------------

create type public.assessment_status as enum ('in_progress', 'closed');
comment on type public.assessment_status is '自評表狀態：簽核中／結案。';

create table public.annual_cycle (
  id           uuid primary key default gen_random_uuid(),
  year         integer not null unique,  -- 一年只有一個年度作業
  due_date     date not null,
  created_at   timestamptz not null default now()
);
comment on table public.annual_cycle is '年度作業：稽核管理者每年發起一次，有年度與截止日。';

create table public.assessment (
  id                     uuid primary key default gen_random_uuid(),
  cycle_id               uuid not null references public.annual_cycle (id) on delete cascade,
  plant_id               uuid not null references public.plant (id),
  -- 來源範本只供回溯；內容一律讀下面的快照。
  template_id            uuid not null references public.questionnaire_template (id),
  template_code          text not null,
  template_name          text not null,
  template_layout        public.template_layout not null,
  template_version       text not null,
  status                 public.assessment_status not null default 'in_progress',
  current_step_position  integer not null check (current_step_position > 0),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (cycle_id, template_id, plant_id)
);
create index assessment_plant_idx on public.assessment (plant_id);
comment on table public.assessment is '自評表：年度作業中，一份問卷範本發給一個廠區的那一張；發起時凍結範本與流程。';

create table public.assessment_section (
  id             uuid primary key default gen_random_uuid(),
  assessment_id  uuid not null references public.assessment (id) on delete cascade,
  position       integer not null check (position > 0),
  name           text not null,
  unique (assessment_id, position)
);

create table public.assessment_control_point (
  id                   uuid primary key default gen_random_uuid(),
  -- assessment_id 與 section_id 重複，是為了讓 RLS 不必 join 章節。
  assessment_id        uuid not null references public.assessment (id) on delete cascade,
  section_id           uuid not null references public.assessment_section (id) on delete cascade,
  position             integer not null check (position > 0),
  text                 text not null,
  assessing_unit_name  text,
  unique (section_id, position)
);
create index assessment_control_point_assessment_idx on public.assessment_control_point (assessment_id);

create table public.assessment_step (
  id                  uuid primary key default gen_random_uuid(),
  assessment_id       uuid not null references public.assessment (id) on delete cascade,
  position            integer not null check (position > 0),
  name                text not null,
  step_group          public.step_group not null,
  signer_emp_id       text not null,
  editable_unit_name  text,
  unique (assessment_id, position)
);
create index assessment_step_signer_idx on public.assessment_step (signer_emp_id);
comment on table public.assessment_step is '自評表的關卡快照；加簽、換人 (#13) 改的是這裡，不是簽核流程。';

create trigger assessment_touch_updated_at
  before update on public.assessment
  for each row execute function public.touch_updated_at();

-- 可見性 ----------------------------------------------------------------------
-- 這兩個函式是 security definer：自評表與它的子表互相用 RLS 檢查會無限遞迴，
-- 所以判斷放在一個繞過 RLS 的函式裡，所有子表的 policy 共用它。

create or replace function public.is_signer_up_to_current_step(p_assessment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.assessment a
    join public.assessment_step s
      on s.assessment_id = a.id and s.position <= a.current_step_position
    where a.id = p_assessment_id
      and s.signer_emp_id = public.current_emp_id()
  )
$$;
comment on function public.is_signer_up_to_current_step(uuid) is
  '呼叫者是不是這張自評表「目前關卡或之前關卡」的簽核人（正在簽或已簽過）。';

create or replace function public.can_view_assessment(p_assessment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_audit_admin() or public.is_signer_up_to_current_step(p_assessment_id)
$$;
comment on function public.can_view_assessment(uuid) is '稽核管理者，或目前關卡與之前關卡的簽核人，才讀得到這張自評表。';

do $$
declare
  t text;
begin
  -- 公司、廠區、年度作業：不含敏感資料，所有登入的人都讀得到（自評表頁面要顯示廠區與截止日）。
  foreach t in array array['company', 'plant', 'annual_cycle']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select_all', t);
  end loop;

  -- 簽核流程與關卡：只有稽核管理者（簽核人看的是自評表裡的關卡快照）。
  foreach t in array array['approval_route', 'route_step']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_audit_admin())',
      t || '_select_audit_admin', t);
  end loop;

  execute 'alter table public.assessment enable row level security';
  execute 'create policy assessment_select_visible on public.assessment for select to authenticated using (public.can_view_assessment(id))';

  foreach t in array array['assessment_section', 'assessment_control_point', 'assessment_step']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.can_view_assessment(assessment_id))',
      t || '_select_visible', t);
  end loop;

  foreach t in array array[
    'company', 'plant', 'annual_cycle', 'approval_route', 'route_step',
    'assessment', 'assessment_section', 'assessment_control_point', 'assessment_step'
  ]
  loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('revoke insert, update, delete on public.%I from authenticated, anon', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end
$$;

-- 我的待簽 --------------------------------------------------------------------
-- 「輪到我的自評表」。稽核管理者看得到全部自評表，但待簽只列目前關卡是自己的，
-- 所以這個條件放在資料庫而不是前端。security_invoker：底層表的 RLS 仍然生效。

create view public.my_pending_assessment
with (security_invoker = true) as
select
  a.id              as assessment_id,
  c.year,
  c.due_date,
  a.template_code,
  a.template_name,
  p.factory_code,
  p.name            as plant_name,
  s.position        as step_position,
  s.name            as step_name
from public.assessment a
join public.annual_cycle c on c.id = a.cycle_id
join public.plant p on p.id = a.plant_id
join public.assessment_step s
  on s.assessment_id = a.id and s.position = a.current_step_position
where a.status = 'in_progress'
  and s.signer_emp_id = public.current_emp_id();
comment on view public.my_pending_assessment is '輪到目前登入者簽核的自評表（我的待簽）。';

grant select on public.my_pending_assessment to authenticated;
revoke all on public.my_pending_assessment from anon;

-- 發起年度作業 ----------------------------------------------------------------
-- p_combos 為空值＝所有「啟用的範本 × 適用廠區」；給陣列＝[{template_id, plant_id}, …]，
-- 只發這些組合（發起畫面 #12 讓稽核管理者取消勾選）。
-- 業務上的拒絕不丟例外，回傳 {ok:false, error, …} 讓前端對應到畫面：
--   cycle_exists   該年度已有年度作業
--   no_combos      沒有任何可發的組合
--   invalid_combo  給的組合格式不對（不是 {template_id, plant_id} 的 uuid），或不是「啟用範本 × 它適用的廠區」，invalid 列出哪些
--   missing_route  有組合沒有啟用的簽核流程（或流程沒有關卡），missing 列出哪些；整體拒絕、什麼都不建
-- 成功回傳 {ok:true, cycle_id, assessments}。呼叫者不是稽核管理者才丟 42501。

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
  v_combos   jsonb;
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

  -- 先驗格式，之後的 ::uuid 轉型才不會把壞輸入變成例外而不是結構化錯誤。
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

  -- 啟用的範本 × 它適用的廠區（all_plants 或列在 template_plant）
  select coalesce(jsonb_agg(jsonb_build_object('template_id', t.id, 'plant_id', p.id) order by t.code, p.factory_code), '[]'::jsonb)
  into v_combos
  from public.questionnaire_template t
  join public.plant p
    on t.all_plants
    or exists (select 1 from public.template_plant tp where tp.template_id = t.id and tp.factory_code = p.factory_code)
  where t.status = 'active'
    and (
      p_combos is null
      or exists (
        select 1 from jsonb_array_elements(p_combos) e
        where (e ->> 'template_id')::uuid = t.id and (e ->> 'plant_id')::uuid = p.id
      )
    );

  if p_combos is not null then
    select jsonb_agg(e) into v_invalid
    from jsonb_array_elements(p_combos) e
    where not exists (
      select 1 from jsonb_array_elements(v_combos) c
      where (c ->> 'template_id')::uuid = (e ->> 'template_id')::uuid
        and (c ->> 'plant_id')::uuid = (e ->> 'plant_id')::uuid
    );
    if v_invalid is not null then
      return jsonb_build_object('ok', false, 'error', 'invalid_combo', 'invalid', v_invalid);
    end if;
  end if;

  if jsonb_array_length(v_combos) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_combos');
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'template_id', t.id, 'template_code', t.code, 'template_name', t.name,
      'plant_id', p.id, 'factory_code', p.factory_code, 'plant_name', p.name
    ) order by t.code, p.factory_code)
  into v_missing
  from jsonb_array_elements(v_combos) c
  join public.questionnaire_template t on t.id = (c ->> 'template_id')::uuid
  join public.plant p on p.id = (c ->> 'plant_id')::uuid
  where not exists (
    select 1
    from public.approval_route ar
    where ar.template_id = t.id and ar.plant_id = p.id and ar.status = 'active'
      and exists (select 1 from public.route_step rs where rs.route_id = ar.id)
  );
  if v_missing is not null then
    return jsonb_build_object('ok', false, 'error', 'missing_route', 'missing', v_missing);
  end if;

  insert into public.annual_cycle (year, due_date)
  values (p_year, p_due_date)
  returning id into v_cycle;

  for r in
    select t.id as template_id, t.code, t.name, t.layout, t.version, p.id as plant_id, ar.id as route_id
    from jsonb_array_elements(v_combos) c
    join public.questionnaire_template t on t.id = (c ->> 'template_id')::uuid
    join public.plant p on p.id = (c ->> 'plant_id')::uuid
    join public.approval_route ar
      on ar.template_id = t.id and ar.plant_id = p.id and ar.status = 'active'
    order by t.code, p.factory_code
  loop
    insert into public.assessment (
      cycle_id, plant_id, template_id, template_code, template_name, template_layout, template_version,
      current_step_position
    )
    values (
      v_cycle, r.plant_id, r.template_id, r.code, r.name, r.layout, r.version,
      (select min(position) from public.route_step where route_id = r.route_id)
    )
    returning id into v_new;

    insert into public.assessment_section (assessment_id, position, name)
    select v_new, s.position, s.name
    from public.template_section s
    where s.template_id = r.template_id;

    insert into public.assessment_control_point (assessment_id, section_id, position, text, assessing_unit_name)
    select v_new, snap.id, cp.position, cp.text, u.name
    from public.template_section ts
    join public.assessment_section snap on snap.assessment_id = v_new and snap.position = ts.position
    join public.control_point cp on cp.section_id = ts.id
    left join public.assessing_unit u on u.id = cp.assessing_unit_id
    where ts.template_id = r.template_id;

    insert into public.assessment_step (assessment_id, position, name, step_group, signer_emp_id, editable_unit_name)
    select v_new, rs.position, rs.name, rs.step_group, rs.signer_emp_id, u.name
    from public.route_step rs
    left join public.assessing_unit u on u.id = rs.editable_unit_id
    where rs.route_id = r.route_id;

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'cycle_id', v_cycle, 'assessments', v_count);
end
$$;
comment on function public.launch_annual_cycle(integer, date, jsonb) is
  '發起年度作業（稽核管理者）：對每個「範本 × 廠區」建立自評表並凍結範本與簽核流程。';

-- 預設會把 execute 給 public／anon；這個函式只開給登入者（函式內仍檢查稽核管理者）。
revoke execute on function public.launch_annual_cycle(integer, date, jsonb) from public, anon;
grant execute on function public.launch_annual_cycle(integer, date, jsonb) to authenticated;

-- 種子: 福清富群 ----------------------------------------------------------------
-- 公司與廠區主檔（無人名）。FQ 是 OMS employees_picker 裡福清的廠區代碼 (2026-10-15 實測 114 人)。
-- 簽核流程的簽核人是真實 OMS 工號，不進版控：由 `npm run db:seed-route` 讀 .env 後建立。
with c as (
  insert into public.company (name) values ('福清富群電子有限公司')
  on conflict (name) do update set name = excluded.name
  returning id
)
insert into public.plant (factory_code, name, company_id)
select 'FQ', '福清富群', c.id from c
on conflict (factory_code) do nothing;
