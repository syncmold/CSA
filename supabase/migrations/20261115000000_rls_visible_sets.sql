-- 自評表與答案的讀取權限，每個查詢算一次可見集合，不再每列各算一次。看得到什麼完全不變（Q81 (5)、Q85 (6)、Q116 (9)、Q117）。
--
-- 原因：20261108000000 只把「是不是稽核管理者」改成每個查詢算一次，can_view_assessment(id) 這類以列內容為參數的
-- 判斷仍逐列執行，非稽核管理者每列要跑好幾個子查詢（2026-11-05 還原測試環境備份，209 張、7,913 筆答案：單張答案
-- 174 列 410 ms、權限函式 1,044 次；全廠檢視者的追蹤總覽 3.7 秒；不限條件讀全部答案 15–20 秒）。資料量要從 6 廠擴到
-- 18 廠、逐年累積，而 Supabase 給 authenticated 的 statement_timeout 是 8 秒。
--
-- 改法：把「我看得到哪些」寫成不帶參數的函式，policy 寫成 x in (select f())。Postgres 把它做成 hashed SubPlan：
-- 整個查詢只執行一次，之後每列只查一次雜湊表。函式是 security definer 又設了 search_path，不會被展開。
--   my_visible_assessment_ids()      看得到的自評表：can_view_assessment 的規則，自評表與它的子表都用它。
--   my_all_answers_assessment_ids()  不受「單位送出後才看得到」限制的自評表：can_see_all_answers 的規則。
--   my_visible_answer_units()        分流規則下看得到答案的單位：can_view_unit_answers 剩下的規則。
-- 原本的逐列函式沒有人用了，檔尾移除，規則只留一份。另外 my_answer_progress 的 CTE 改成 materialized：和權限無關，
-- 但它佔了首頁大半的時間，所以一起改（見檔尾）。

-- 看得到這些廠區的全部自評表：稽核管理者看全部，檢視者看檢視廠區，廠區負責人看負責的廠區（my_tracking_plant_ids
-- 就是後兩者的聯集，追蹤總覽用同一份）。這些人也看得到其中每個單位的答案（Q116 (5)(9)、Q117 (2)）。
create function public.my_plant_wide_assessment_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select a.id
  from public.assessment a
  where (select public.is_audit_admin())
     or a.plant_id = any((select public.my_tracking_plant_ids())::uuid[])
$$;
comment on function public.my_plant_wide_assessment_ids() is
  '內部用：呼叫者因為角色而看得到的自評表：稽核管理者全部，檢視者的檢視廠區，廠區負責人負責的廠區。';

-- 再加上流程上的自己：輪到或已完成的關卡的簽核人，以及簽過（含被作廢、含退回）而且仍是某一關簽核人的人。
create function public.my_visible_assessment_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
rows 100
as $$
  select public.my_plant_wide_assessment_ids()
  union
  select s.assessment_id
  from public.assessment_step s
  where s.signer_emp_id = (select public.current_emp_id())
    and (s.state in ('current', 'done')
         or exists (select 1 from public.assessment_signoff g
                    where g.assessment_id = s.assessment_id and g.signer_emp_id = s.signer_emp_id))
$$;
comment on function public.my_visible_assessment_ids() is
  '呼叫者看得到的自評表：稽核管理者、檢視廠區的檢視者、本廠的廠區負責人、輪到或已完成的關卡的簽核人、簽過而且仍在流程上的人。'
  'policy 寫成 id in (select …)，每個查詢算一次。';

-- 匯流後關卡的簽核人同 can_view_unit_answers，要先看得到自評表。現在的條件都已包含在 my_visible_assessment_ids 裡，
-- 這裡仍取交集：日後收緊可見性時，答案不會比自評表看得更多。
create function public.my_all_answers_assessment_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
rows 100
as $$
  select public.my_plant_wide_assessment_ids()
  union
  select s.assessment_id
  from public.assessment_step s
  where s.signer_emp_id = (select public.current_emp_id())
    and s.branch_unit_name is null
    and s.assessment_id in (select public.my_visible_assessment_ids())
    and (s.state <> 'pending'
         or exists (select 1 from public.assessment_signoff g
                    where g.step_id = s.id and g.signer_emp_id = s.signer_emp_id))
$$;
comment on function public.my_all_answers_assessment_ids() is
  '呼叫者不受「單位送出後才看得到」限制、看得到全部答案的自評表：稽核管理者、檢視者、匯流後關卡輪到過或簽過的簽核人（Q116 (9)），'
  '以及本廠的廠區負責人（Q116 (5)）。';

-- 分流上的人（Q116 (9)）：自己現在能答的單位，加上自己所在的某條分流的單位已送出時，所有已送出的單位。「已送出」＝那個單位的
-- 答題關已完成，被退回重填就不算。要先看得到自評表：分流多一關時，後面的人在那條分流的單位送出後仍是還沒輪到，什麼都看不到。
create function public.my_visible_answer_units()
returns table (assessment_id uuid, assessing_unit_name text)
language sql
stable
security definer
set search_path = public
rows 100
as $$
  with mine as (
    select s.assessment_id, s.branch_unit_name
    from public.assessment_step s
    where s.signer_emp_id = (select public.current_emp_id())
      and s.assessment_id in (select public.my_visible_assessment_ids())
  )
  select a.id, u.unit
  from public.assessment a
  cross join lateral unnest(public.my_editable_units(a)) as u(unit)
  where a.id in (select m.assessment_id from mine m)
    and a.status = 'in_progress'  -- my_editable_units 只有簽核中才有值，結案的不必逐張算
  union
  select submitted.assessment_id, submitted.editable_unit_name
  from mine
  join public.assessment_step own
    on own.assessment_id = mine.assessment_id
   and own.editable_unit_name = mine.branch_unit_name
   and own.state = 'done'
  join public.assessment_step submitted
    on submitted.assessment_id = mine.assessment_id
   and submitted.editable_unit_name is not null
   and submitted.state = 'done'
$$;
comment on function public.my_visible_answer_units() is
  '分流規則下呼叫者讀得到哪些自評單位的答案與整體結論（Q116 (9)）。不排除 my_all_answers_assessment_ids 裡的自評表，'
  'policy 是兩者的聯集。';

-- policy 會用到的開給登入者，內部用的不開。
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.my_visible_assessment_ids()',
    'public.my_all_answers_assessment_ids()',
    'public.my_visible_answer_units()'
  ]
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
revoke execute on function public.my_plant_wide_assessment_ids() from public, anon, authenticated;

-- policy ---------------------------------------------------------------------------------------------------

alter policy assessment_select_visible on public.assessment
  using (id in (select public.my_visible_assessment_ids()));

do $$
declare
  t text;
begin
  foreach t in array array[
    'assessment_section', 'assessment_section_document', 'assessment_control_point', 'assessment_control_point_unit',
    'assessment_control_reference', 'assessment_step', 'assessment_signoff'
  ]
  loop
    execute format(
      'alter policy %I on public.%I using (assessment_id in (select public.my_visible_assessment_ids()))',
      t || '_select_visible', t);
  end loop;

  foreach t in array array['assessment_answer', 'assessment_conclusion']
  loop
    execute format(
      'alter policy %I on public.%I using (
         assessment_id in (select public.my_all_answers_assessment_ids())
         or (assessment_id, assessing_unit_name) in (select u.assessment_id, u.assessing_unit_name from public.my_visible_answer_units() u)
       )',
      t || '_select_visible', t);
  end loop;
end
$$;

-- 我參與的自評表從這裡出發：同 20261028000000，只把逐張檢查換成可見集合。
create or replace function public.my_route_assessment_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
rows 10
as $$
  select distinct s.assessment_id
  from public.assessment_step s
  where s.signer_emp_id = (select public.current_emp_id())
    and s.assessment_id in (select public.my_visible_assessment_ids())
$$;

-- 我的填寫進度：同 20261109000000，只把 mine 寫成 materialized。只用到一次的 CTE 會被 Postgres 展開，my_editable_units
-- 在 lateral 裡每提到一次就算一次（每張自評表 5 次），佔了首頁大半的時間（904 張自評表、人在其中 893 張的流程上：0.40 秒裡 0.32 秒）。
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
  with mine as materialized (select public.my_editable_units(a) as units)
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

-- 規則只留一份 ---------------------------------------------------------------------------------------------
-- coordinates_assessment_plant 留著：assign_step_signer 用它判斷單張自評表。

drop function public.can_view_unit_answers(uuid, text);
drop function public.can_see_all_answers(uuid);
drop function public.can_view_assessment(uuid);
drop function public.is_signer_up_to_current_step(uuid);
drop function public.signed_and_still_on_route(uuid);
