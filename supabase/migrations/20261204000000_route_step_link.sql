-- 簽核流程關卡標記（工單 #189，規格 #187；稽核角色重整第一波）。用語依 GLOSSARY.md。
--
-- 「台北稽核人員」「稽核主管」兩個稽核室關卡日後要由權限管理連動簽核人（第二波），所以要有明確標記，不靠名稱比對：
--   route_step.link／assessment_step.link   空值＝一般關卡；taipei_auditor＝台北稽核人員；audit_chief＝稽核主管。
--   兩種標記與它們的關卡名稱只寫在 route_links() 一處。只有稽核室覆核關卡能有標記，名稱就是它連動的那一關；
--   每條流程（自評表）每種標記最多一個。標記不能直接寫：新增時由 insert_route_step 的 p_link 或草稿定義的 link 帶入。
--   唯讀   有標記的關卡不能透過 API 改或刪（觸發器回 23514、hint = 'step_linked'）；資料庫函式以擁有者身分執行不受限
--          （排序照常、第二波的連動與換人同步走函式），刪整條流程的連帶刪除也不受限。
--   本工單只做標記與唯讀，不自動帶入簽核人：簽核人欄位仍是原本存的值（第二波接手）。
--   回填   依現有名稱：稽核室覆核裡叫「台北稽核人員」「稽核主管」的標上；同名有好幾個時只標位置最前面的一個。
--   啟用檢查   多兩項：missing_links（稽核室覆核要有兩種標記關卡各一個，缺的列出）、audit_chief_not_last（稽核主管
--             要是匯流後的最後一關，也就是整條流程最後一關，#187）。年度發起照舊經啟用檢查重跑（Q89），所以不通過的流程發不出去。
--   發起   launch_annual_cycle 複製關卡時帶標記，簽名與其他邏輯不變。

-- 兩種標記 ------------------------------------------------------------------------------------

create function public.route_links()
returns table (link text, name text, ord integer)
language sql
immutable
set search_path = public
as $$
  values ('taipei_auditor', '台北稽核人員', 1), ('audit_chief', '稽核主管', 2)
$$;
comment on function public.route_links() is '連動標記與它連動的關卡名稱（#187、#189）；標記的唯一來源。';

create function public.route_link_name(p_link text)
returns text
language sql
immutable
set search_path = public
as $$
  select name from public.route_links() where link = p_link
$$;
comment on function public.route_link_name(text) is '連動標記對應的關卡名稱；不是兩種標記之一回空值。';
revoke execute on function public.route_links() from public, anon;
revoke execute on function public.route_link_name(text) from public, anon;
grant execute on function public.route_links() to authenticated;
grant execute on function public.route_link_name(text) to authenticated;

alter table public.route_step add column link text;
alter table public.assessment_step add column link text;
comment on column public.route_step.link is '連動標記（route_links()）：空值＝一般關卡；稽核室覆核限定、名稱就是它連動的那一關、每條流程各最多一個。';
comment on column public.assessment_step.link is '發起時從簽核流程關卡複製的連動標記；每張自評表各最多一個。';

-- 有標記的關卡只能是稽核室覆核，名稱就是它連動的那一關（資料庫保證，不只靠畫面）；不認得的標記比不到名稱，也不通過。
alter table public.route_step
  add constraint route_step_link_valid
  check (link is null or (step_group = 'audit_review' and coalesce(name = public.route_link_name(link), false)));
alter table public.assessment_step
  add constraint assessment_step_link_valid
  check (link is null or (step_group = 'audit_review' and coalesce(name = public.route_link_name(link), false)));
create unique index route_step_link_idx on public.route_step (route_id, link) where link is not null;
create unique index assessment_step_link_idx on public.assessment_step (assessment_id, link) where link is not null;

-- 回填 --------------------------------------------------------------------------------------
-- 暫時關掉會動到別處的觸發器：route_step_before_write 會更新流程的最後修改時間，assessment_step_guard 會擋結案的自評表。
alter table public.route_step disable trigger route_step_before_write;
alter table public.assessment_step disable trigger assessment_step_guard;

update public.route_step rs
set link = x.link
from (
  select s.id, l.link, row_number() over (partition by s.route_id, s.name order by s.position) as nth
  from public.route_step s
  join public.route_links() l on l.name = s.name
  where s.step_group = 'audit_review'
) x
where rs.id = x.id and x.nth = 1;

update public.assessment_step a
set link = x.link
from (
  select s.id, l.link, row_number() over (partition by s.assessment_id, s.name order by s.position) as nth
  from public.assessment_step s
  join public.route_links() l on l.name = s.name
  where s.step_group = 'audit_review'
) x
where a.id = x.id and x.nth = 1;

-- 更新排進去的延後觸發（啟用中流程的檢查）先跑完，否則下面改資料表會因「還有等著執行的觸發」失敗。
set constraints all immediate;
alter table public.route_step enable trigger route_step_before_write;
alter table public.assessment_step enable trigger assessment_step_guard;

-- 有標記的關卡不能透過 API 改或刪 -------------------------------------------------------------
-- 直接寫表（PostgREST，current_user 是 authenticated）時拒絕並說明原因，而不是讓 RLS 悄悄濾掉、回成功卻沒改。
-- 資料庫函式（security definer，以擁有者身分執行）與刪整條流程的連帶刪除不受限。

create function public.route_step_keep_linked()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.link is not null and current_user = 'authenticated' then
    raise exception '「%」是連動關卡，簽核人由權限管理決定，不能修改或刪除', old.name
      using errcode = '23514', hint = 'step_linked';
  end if;
  return case tg_op when 'DELETE' then old else new end;
end
$$;
comment on function public.route_step_keep_linked() is '有連動標記的關卡不能透過 API 修改或刪除（#189）；資料庫函式不受限。';
revoke execute on function public.route_step_keep_linked() from public, anon, authenticated;

create trigger route_step_keep_linked
  before update or delete on public.route_step
  for each row execute function public.route_step_keep_linked();

-- 啟用檢查 ----------------------------------------------------------------------------------
create or replace function public.activation_check(r public.approval_route)
returns jsonb
language sql
stable
set search_path = public
as $$
  with steps as (
    select rs.position, rs.editable_unit_id, rs.branch_unit_id, rs.link
    from public.route_step rs
    where rs.route_id = r.id
  ),
  used as (
    select o.assessing_unit_id as unit_id, o.first_seen
    from public.template_unit_order(r.template_id) o
  ),
  missing as (
    select u.id, u.name, used.first_seen
    from used
    join public.assessing_unit u on u.id = used.unit_id
    where not exists (select 1 from steps where steps.editable_unit_id = used.unit_id)
  ),
  unused as (
    select u.id, u.name, min(steps.position) as first_step
    from steps
    join public.assessing_unit u on u.id = steps.editable_unit_id
    where not exists (select 1 from used where used.unit_id = steps.editable_unit_id)
    group by u.id, u.name
  ),
  -- 每條分流位置最前面的關卡；已列在 missing 的單位不重複列。
  branch_first as (
    select distinct on (branch_unit_id) branch_unit_id, editable_unit_id, position
    from steps
    where branch_unit_id is not null
    order by branch_unit_id, position
  ),
  misordered as (
    select u.id, u.name, f.position
    from branch_first f
    join public.assessing_unit u on u.id = f.branch_unit_id
    where f.editable_unit_id is null
      and not exists (select 1 from missing where missing.id = f.branch_unit_id)
  ),
  facts as (
    select
      not exists (select 1 from steps) as no_steps,
      exists (select 1 from steps) and not exists (select 1 from steps where branch_unit_id is null) as no_merge_steps,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by first_seen) from missing), '[]'::jsonb) as missing_units,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by first_step) from unused), '[]'::jsonb) as unused_units,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by position) from misordered), '[]'::jsonb) as branch_first_step_not_editable,
      coalesce((select jsonb_agg(l.link order by l.ord) from public.route_links() l
                where not exists (select 1 from steps where steps.link = l.link)), '[]'::jsonb) as missing_links,
      -- 有稽核主管、但匯流後還有關卡排在它後面（#187：每條流程最後一關是稽核主管）。分流的關卡與匯流後各自排順序，
      -- 位置數字在它後面不算。
      exists (select 1 from steps c where c.link = 'audit_chief'
                and exists (select 1 from steps s where s.branch_unit_id is null and s.position > c.position))
        as audit_chief_not_last
  )
  select jsonb_build_object(
    'ready', not no_steps and not no_merge_steps and not audit_chief_not_last
             and jsonb_array_length(missing_units) = 0 and jsonb_array_length(unused_units) = 0
             and jsonb_array_length(branch_first_step_not_editable) = 0
             and jsonb_array_length(missing_links) = 0,
    'no_steps', no_steps,
    'no_merge_steps', no_merge_steps,
    'missing_units', missing_units,
    'unused_units', unused_units,
    'branch_first_step_not_editable', branch_first_step_not_editable,
    'missing_links', missing_links,
    'audit_chief_not_last', audit_chief_not_last
  )
  from facts
$$;
comment on function public.activation_check(public.approval_route) is
  '簽核流程的啟用檢查：{ready, no_steps, no_merge_steps, missing_units, unused_units, branch_first_step_not_editable, missing_links, '
  'audit_chief_not_last}（單位為 [{id,name}]，missing_links 是缺的標記）；也是 PostgREST 計算欄位。';

-- 修改後才出現的新問題；同 20261111000000，多 audit_chief_not_last 與 missing_links。
create or replace function public.activation_regressions(p_before jsonb, p_after jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  with flags as (
    select k, coalesce((p_after ->> k)::boolean, false) and not coalesce((p_before ->> k)::boolean, false) as v
    from unnest(array['no_steps', 'no_merge_steps', 'audit_chief_not_last']) k
  ),
  lists as (
    select k, coalesce((
      select jsonb_agg(u) from jsonb_array_elements(coalesce(p_after -> k, '[]'::jsonb)) u
      where not coalesce(p_before -> k, '[]'::jsonb) @> jsonb_build_array(u)
    ), '[]'::jsonb) as v
    from unnest(array['missing_units', 'unused_units', 'branch_first_step_not_editable', 'missing_links']) k
  )
  select case
    when exists (select 1 from flags where v) or exists (select 1 from lists where jsonb_array_length(v) > 0)
    then jsonb_build_object('ready', false)
         || (select jsonb_object_agg(k, v) from flags)
         || (select jsonb_object_agg(k, v) from lists)
  end
$$;

-- 新增關卡 ----------------------------------------------------------------------------------
-- 同 20261113000000，多一個 p_link：新增有標記的稽核室覆核關卡（唯一能設標記的地方）。同一條流程已有同標記的關卡
-- 回 23505、hint = 'link_exists'；標記不是 route_links() 之一、不在稽核室覆核、或名稱不是它連動的那一關回 23514（資料表的檢查約束）。
drop function public.insert_route_step(uuid, text, public.step_group, text, uuid, integer, uuid);
create function public.insert_route_step(
  p_route_id          uuid,
  p_name              text,
  p_step_group        public.step_group,
  p_signer_emp_id     text,
  p_editable_unit_id  uuid default null,
  p_before_position   integer default null,
  p_branch_unit_id    uuid default null,
  p_link              text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count  integer;
  v_id     uuid;
  v_link   text := nullif(btrim(p_link), '');
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can add steps' using errcode = '42501';
  end if;
  perform 1 from public.approval_route where id = p_route_id for update;
  if not found then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
  if v_link is not null and exists (select 1 from public.route_step where route_id = p_route_id and link = v_link) then
    raise exception '這條流程已經有這個連動關卡' using errcode = '23505', hint = 'link_exists';
  end if;
  select count(*) into v_count from public.route_step where route_id = p_route_id;
  if p_before_position is not null and (p_before_position < 1 or p_before_position > v_count) then
    raise exception 'p_before_position must be between 1 and %', v_count using errcode = '22023';
  end if;
  if p_before_position is not null then
    update public.route_step set position = position + 1
    where route_id = p_route_id and position >= p_before_position;
  end if;
  insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id, branch_unit_id, link)
  values (p_route_id, p_before_position, btrim(p_name), p_step_group, nullif(btrim(p_signer_emp_id), ''), p_editable_unit_id, p_branch_unit_id, v_link)
  returning id into v_id;
  return v_id;
end
$$;
comment on function public.insert_route_step(uuid, text, public.step_group, text, uuid, integer, uuid, text) is
  '稽核管理者新增關卡：排最後，或插在第 p_before_position 關之前；p_branch_unit_id 指定分流；p_link 設連動標記（稽核室覆核限定）；回傳關卡 id。';
revoke execute on function public.insert_route_step(uuid, text, public.step_group, text, uuid, integer, uuid, text) from public, anon;
grant execute on function public.insert_route_step(uuid, text, public.step_group, text, uuid, integer, uuid, text) to authenticated;

-- 草稿途徑：每一關可帶 link。其餘同 20261113000000。 ---------------------------------------
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
  -- 廠區端不設人名，定義檔寫了 signer 也不看。
  insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id, branch_unit_id, link)
  select v_route, t.ord, btrim(t.st ->> 'name'), (t.st ->> 'group')::public.step_group,
         case when t.st ->> 'group' = 'plant' then null else btrim(t.st ->> 'signer') end, u.id, b.id,
         nullif(btrim(t.st ->> 'link'), '')
  from jsonb_array_elements(p_def -> 'steps') with ordinality as t(st, ord)
  left join public.assessing_unit u on u.name = btrim(t.st ->> 'editableUnit')
  left join public.assessing_unit b on b.name = btrim(t.st ->> 'branchUnit');
  get diagnostics v_steps = row_count;

  return jsonb_build_object('ok', true, 'route_id', v_route, 'steps', v_steps);
end
$$;

comment on function public.draft_route(jsonb) is
  '草稿途徑：把一條簽核流程定義寫成新的草稿流程（每一關可帶 branchUnit 指定分流、link 指定連動標記）；只給 csa_drafter (Q90)。';

-- 發起 ----------------------------------------------------------------------------------------
-- 同 20261129000000，只在複製關卡時多帶 link。
create or replace function public.launch_annual_cycle(
  p_year      integer,
  p_due_date  date,
  p_combos    jsonb default null,
  p_departed  text[] default '{}',
  p_carry     boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_selected jsonb;
  v_invalid  jsonb;
  v_launched jsonb;
  v_missing  jsonb;
  v_cycle    uuid;
  v_due      date;
  v_top_up   boolean;
  v_new      uuid;
  v_ids      uuid[] := '{}';
  v_departed text[];
  v_counts   record;
  r          record;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can launch an annual cycle' using errcode = '42501';
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

  -- 同一年度的發起排隊：後到的在先到的提交之後才讀已發起的組合（之後每一句都看得到它的結果）。
  perform pg_advisory_xact_lock(hashtext('csa.launch_annual_cycle'), p_year);

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

  -- 不給組合＝該年度還沒發過的全部；給了就照給的，已發過的留著下面拒絕。
  select coalesce(jsonb_agg(to_jsonb(c) order by c.template_code, c.factory_code), '[]'::jsonb)
  into v_selected
  from public.launch_candidates() c
  where (p_combos is null and not p_year = any (c.launched_years))
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
  into v_launched
  from jsonb_array_elements(v_selected) with ordinality as x(c, ord)
  where c -> 'launched_years' @> to_jsonb(p_year);
  if v_launched is not null then
    return jsonb_build_object('ok', false, 'error', 'already_launched', 'launched', v_launched);
  end if;

  select jsonb_agg(c order by ord)
  into v_missing
  from jsonb_array_elements(v_selected) with ordinality as x(c, ord)
  where c ->> 'problem' is not null;
  if v_missing is not null then
    return jsonb_build_object('ok', false, 'error', 'missing_route', 'missing', v_missing);
  end if;

  v_departed := array(select upper(btrim(d)) from unnest(p_departed) d);

  select id, due_date into v_cycle, v_due from public.annual_cycle where year = p_year;
  v_top_up := v_cycle is not null;
  if not v_top_up then
    insert into public.annual_cycle (year, due_date)
    values (p_year, p_due_date)
    returning id, due_date into v_cycle, v_due;
  end if;

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
    v_ids := v_ids || v_new;

    insert into public.assessment_section (assessment_id, position, name, level, code)
    select v_new, s.position, s.name, s.level, s.code
    from public.template_section s
    where s.template_id = r.template_id;

    insert into public.assessment_control_point (assessment_id, section_id, position, text, code)
    select v_new, snap.id, cp.position, cp.text, cp.code
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
      assessment_id, position, name, step_group, signer_emp_id, editable_unit_name, branch_unit_name, vacated_emp_id, vacated_name, link
    )
    select v_new, rs.position, rs.name, rs.step_group, who.signer_emp_id, u.name, bu.name, who.vacated_emp_id, who.vacated_name, rs.link
    from public.route_step rs
    left join public.assessing_unit u on u.id = rs.editable_unit_id
    left join public.assessing_unit bu on bu.id = rs.branch_unit_id
    cross join lateral public.launch_step_signer(rs, bu.name, r.template_id, r.code, r.plant_id, p_year, v_departed, p_carry) who
    where rs.route_id = r.route_id;
    -- 人都齊了的分流同時開始（Q116 (1)）；待分派的等分派。
    perform public.refresh_assessment_steps(v_new);
  end loop;

  perform public.log_access_change(
    s.vacated_emp_id, 'step_vacated', null,
    jsonb_build_object('year', p_year, 'plant', p.factory_code, 'template', a.template_code, 'step', s.name, 'branch', s.branch_unit_name),
    s.vacated_name
  )
  from public.assessment a
  join public.plant p on p.id = a.plant_id
  join public.assessment_step s on s.assessment_id = a.id
  where a.id = any (v_ids) and s.vacated_emp_id is not null;

  perform public.log_access_change(x.signer_emp_id, 'step_carried', null,
    jsonb_build_object('year', p_year, 'plant', x.factory_code, 'steps', x.steps))
  from (
    select s.signer_emp_id, p.factory_code, count(*)::int as steps
    from public.assessment a
    join public.plant p on p.id = a.plant_id
    join public.assessment_step s on s.assessment_id = a.id
    where a.id = any (v_ids) and s.step_group = 'plant' and s.signer_emp_id is not null
    group by s.signer_emp_id, p.factory_code
  ) x;

  select count(*) filter (where s.signer_emp_id is not null)::int as carried,
         count(*) filter (where s.vacated_emp_id is not null)::int as vacated,
         count(*) filter (where s.signer_emp_id is null and s.vacated_emp_id is null)::int as unassigned
  into v_counts
  from public.assessment_step s
  where s.assessment_id = any (v_ids) and s.step_group = 'plant';

  return jsonb_build_object(
    'ok', true, 'cycle_id', v_cycle, 'top_up', v_top_up, 'due_date', v_due, 'assessments', cardinality(v_ids),
    'carried', v_counts.carried, 'vacated', v_counts.vacated, 'unassigned', v_counts.unassigned, 'carry', p_carry
  );
end
$$;
comment on function public.launch_annual_cycle(integer, date, jsonb, text[], boolean) is
  '依啟用範本與適用廠區發起年度作業；年度已存在就補發，沿用它的截止日，只發還沒發過的組合（Q119）。組合資格與候選清單同一來源（launch_candidates）。p_departed 是 OMS 查到離職的工號（Q116 (6)）；p_carry = false 是 OMS 連不上，廠區端不帶入去年、全部待分派（Q131）。';
