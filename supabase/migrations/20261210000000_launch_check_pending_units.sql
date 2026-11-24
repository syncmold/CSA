-- 發起檢查擋下還有「待指定單位」題目的範本（Q142，2026-11-19 使用者提出）。
--
-- 「待指定單位」是轉檔時原檔沒有單位欄或格子空白留下的暫定單位（Q90 (5)、#207），不是真的部門：沒有人能被分派成它的
-- 自行檢查人員，發出去也沒人能答。原本它和一般單位一樣，有分流就通過發起檢查，年度發起會把這些範本列在「可發起」。
-- 改成：範本只要還有任何控制要點掛著「待指定單位」，這條流程的發起檢查就不通過，年度發起歸在「流程有問題」、不能勾，
-- 流程清單與編輯器顯示原因（到範本管理把那些題目改成實際的單位）。
--   pending_unit_points   範本裡掛著「待指定單位」的控制要點數；不是 0 就不通過。單位名稱只寫在這裡（同轉檔的
--                         UNIT_TO_BE_ASSIGNED，scripts/templates/sources.mjs）。
-- 其餘同 20261204000000（Q137 (9) 改名 launch_check）。年度發起（launch_candidates／launch_annual_cycle）照舊讀
-- launch_check 的 ready，不用改。

create or replace function public.launch_check(r public.approval_route)
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
        as audit_chief_not_last,
      (select count(distinct cp.id)::int
       from public.template_section s
       join public.control_point cp on cp.section_id = s.id
       join public.control_point_unit cpu on cpu.control_point_id = cp.id
       join public.assessing_unit u on u.id = cpu.assessing_unit_id
       where s.template_id = r.template_id and u.name = '待指定單位') as pending_unit_points
  )
  select jsonb_build_object(
    'ready', not no_steps and not no_merge_steps and not audit_chief_not_last
             and jsonb_array_length(missing_units) = 0 and jsonb_array_length(unused_units) = 0
             and jsonb_array_length(branch_first_step_not_editable) = 0
             and jsonb_array_length(missing_links) = 0
             and pending_unit_points = 0,
    'no_steps', no_steps,
    'no_merge_steps', no_merge_steps,
    'missing_units', missing_units,
    'unused_units', unused_units,
    'branch_first_step_not_editable', branch_first_step_not_editable,
    'missing_links', missing_links,
    'audit_chief_not_last', audit_chief_not_last,
    'pending_unit_points', pending_unit_points
  )
  from facts
$$;
comment on function public.launch_check(public.approval_route) is
  '簽核流程的發起檢查（原啟用檢查，Q137 (6)）：{ready, no_steps, no_merge_steps, missing_units, unused_units, branch_first_step_not_editable, '
  'missing_links, audit_chief_not_last, pending_unit_points}（單位為 [{id,name}]，missing_links 是缺的標記，pending_unit_points 是範本'
  '還掛著「待指定單位」的控制要點數，Q142）；也是 PostgREST 計算欄位。不通過的組合年度發起不能勾。';
