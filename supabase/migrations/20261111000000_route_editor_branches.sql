-- 簽核流程編輯器的分流與多一關（工單 #98；Q116 (2)(4)，暫定 OPEN-6；ADR 0007）。用語依 GLOSSARY.md。
--
--   分流     範本用到的每個單位一條分流：第一關是自行檢查人員，之後固定有部門主管，可以多加一關（名稱自訂，
--            insert_route_step 帶 p_branch_unit_id）。新的分流以 add_route_branch 一次建好兩關。每廠一份範本（Q111），
--            範本有哪些單位，這個廠區就有哪些分流。
--   啟用檢查 （Q86 改寫）每個範本用到的單位都有分流（missing_units）、每條分流的第一關是自行檢查人員
--            （branch_first_step_not_editable）、有匯流後的關卡（no_merge_steps：匯流後的關卡一定唯讀，所以最後一關
--            是唯讀核准關卡）；no_steps、unused_units 照舊。取代原本的 last_step_editable：各分流並行之後，「整條
--            流程最後一個位置」不再代表什麼。年度發起照舊經 launch_candidates 重跑（Q89）。
--   畫面     編輯頁讀計算欄位 branch_units：要顯示哪些分流卡片（範本的單位依紙本順序，加上流程裡多出來的）。

-- 範本用到的自評單位，依紙本上第一次出現的位置（章節、控制要點、單位在控制要點內的順序）--------------------------

create or replace function public.template_unit_order(p_template_id uuid)
returns table (assessing_unit_id uuid, first_seen integer[])
language sql
stable
set search_path = public
as $$
  select cpu.assessing_unit_id, min(array[s.position, cp.position, cpu.position])
  from public.template_section s
  join public.control_point cp on cp.section_id = s.id
  join public.control_point_unit cpu on cpu.control_point_id = cp.id
  where s.template_id = p_template_id
  group by cpu.assessing_unit_id
$$;
comment on function public.template_unit_order(uuid) is
  '內部用：範本的控制要點用到的自評單位與它在紙本上第一次出現的位置（排序用）。';
revoke execute on function public.template_unit_order(uuid) from public, anon;
grant execute on function public.template_unit_order(uuid) to authenticated;

-- 啟用檢查 -------------------------------------------------------------------------------------
-- 單位清單都是 [{id,name}]，範本的單位依紙本順序，其餘依關卡位置。

create or replace function public.activation_check(r public.approval_route)
returns jsonb
language sql
stable
set search_path = public
as $$
  with steps as (
    select rs.position, rs.editable_unit_id, rs.branch_unit_id
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
      not exists (select 1 from public.route_step where route_id = r.id) as no_steps,
      exists (select 1 from public.route_step where route_id = r.id)
        and not exists (select 1 from steps where branch_unit_id is null) as no_merge_steps,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by first_seen) from missing), '[]'::jsonb) as missing_units,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by first_step) from unused), '[]'::jsonb) as unused_units,
      coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by position) from misordered), '[]'::jsonb) as branch_first_step_not_editable
  )
  select jsonb_build_object(
    'ready', not no_steps and not no_merge_steps
             and jsonb_array_length(missing_units) = 0 and jsonb_array_length(unused_units) = 0
             and jsonb_array_length(branch_first_step_not_editable) = 0,
    'no_steps', no_steps,
    'no_merge_steps', no_merge_steps,
    'missing_units', missing_units,
    'unused_units', unused_units,
    'branch_first_step_not_editable', branch_first_step_not_editable
  )
  from facts
$$;
comment on function public.activation_check(public.approval_route) is
  '簽核流程的啟用檢查：{ready, no_steps, no_merge_steps, missing_units, unused_units, branch_first_step_not_editable}'
  '（單位為 [{id,name}]）；也是 PostgREST 計算欄位。';

-- 修改後才出現的問題：after 有、before 沒有的那些，形狀與啟用檢查相同；沒有新問題回 null。
create or replace function public.activation_regressions(p_before jsonb, p_after jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  with flags as (
    select k, coalesce((p_after ->> k)::boolean, false) and not coalesce((p_before ->> k)::boolean, false) as v
    from unnest(array['no_steps', 'no_merge_steps']) k
  ),
  lists as (
    select k, coalesce((
      select jsonb_agg(u) from jsonb_array_elements(coalesce(p_after -> k, '[]'::jsonb)) u
      where not coalesce(p_before -> k, '[]'::jsonb) @> jsonb_build_array(u)
    ), '[]'::jsonb) as v
    from unnest(array['missing_units', 'unused_units', 'branch_first_step_not_editable']) k
  )
  select case
    when exists (select 1 from flags where v) or exists (select 1 from lists where jsonb_array_length(v) > 0)
    then jsonb_build_object('ready', false)
         || (select jsonb_object_agg(k, v) from flags)
         || (select jsonb_object_agg(k, v) from lists)
  end
$$;

-- 編輯頁的分流卡片 -------------------------------------------------------------------------------
-- 範本用到的單位依紙本順序，接著是流程裡有分流關卡、但範本沒用到的單位（依關卡位置；範本改過時讓稽核管理者
-- 看得到並刪掉）。security invoker：只有稽核管理者讀得到流程。
create or replace function public.branch_units(r public.approval_route)
returns jsonb
language sql
stable
set search_path = public
as $$
  with used as (
    select assessing_unit_id as unit_id, first_seen from public.template_unit_order(r.template_id)
  ),
  extra as (
    select branch_unit_id as unit_id, min(position) as pos
    from public.route_step
    where route_id = r.id and branch_unit_id is not null
      and branch_unit_id not in (select unit_id from used)
    group by branch_unit_id
  ),
  listed as (
    select unit_id, true as in_template, 0 as grp, first_seen, null::integer as pos from used
    union all
    select unit_id, false, 1, null, pos from extra
  )
  select coalesce(jsonb_agg(
    jsonb_build_object('id', u.id, 'name', u.name, 'in_template', l.in_template)
    order by l.grp, l.first_seen, l.pos nulls last, u.name), '[]'::jsonb)
  from listed l
  join public.assessing_unit u on u.id = l.unit_id
$$;
comment on function public.branch_units(public.approval_route) is
  '流程編輯頁的分流卡片：[{id,name,in_template}]，範本的單位依紙本順序在前；PostgREST 計算欄位。';
revoke execute on function public.branch_units(public.approval_route) from public, anon;
grant execute on function public.branch_units(public.approval_route) to authenticated;

-- 新的分流：一次建「自行檢查人員－單位 → 部門主管－單位」兩關，排在第一個匯流後關卡之前（沒有匯流後關卡就排最後）。
-- 錯誤：不是稽核管理者 42501；流程或單位不存在 P0002；這個單位已有自行檢查人員關卡 23505（hint branch_exists）；簽核人空白 23514。
create or replace function public.add_route_branch(
  p_route_id            uuid,
  p_unit_id             uuid,
  p_self_check_emp_id   text,
  p_manager_emp_id      text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit    text;
  v_before  integer;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can add branches' using errcode = '42501';
  end if;
  perform 1 from public.approval_route where id = p_route_id for update;
  if not found then
    raise exception 'route % not found', p_route_id using errcode = 'P0002';
  end if;
  select name into v_unit from public.assessing_unit where id = p_unit_id;
  if v_unit is null then
    raise exception 'assessing unit % not found', p_unit_id using errcode = 'P0002';
  end if;
  if exists (select 1 from public.route_step where route_id = p_route_id and editable_unit_id = p_unit_id) then
    raise exception '「%」已經有分流', v_unit using errcode = '23505', hint = 'branch_exists';
  end if;
  select min(position) into v_before from public.route_step where route_id = p_route_id and branch_unit_id is null;
  perform public.insert_route_step(p_route_id, '自行檢查人員－' || v_unit, 'plant', p_self_check_emp_id, p_unit_id, v_before, p_unit_id);
  perform public.insert_route_step(p_route_id, '部門主管－' || v_unit, 'plant', p_manager_emp_id, null, v_before + 1, p_unit_id);
end
$$;
comment on function public.add_route_branch(uuid, uuid, text, text) is
  '稽核管理者替一個自評單位建分流：自行檢查人員與部門主管兩關，排在匯流後的關卡之前。';
revoke execute on function public.add_route_branch(uuid, uuid, text, text) from public, anon;
grant execute on function public.add_route_branch(uuid, uuid, text, text) to authenticated;
