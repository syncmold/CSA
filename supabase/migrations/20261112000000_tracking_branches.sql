-- #99：追蹤總覽配合分流（Q116 (11)）。
--
-- 匯流前，每張自評表顯示的是「最久沒動的那條分流」目前的關卡：停留天數從那條分流最後一筆簽核紀錄（送出、核准，
-- 或退回到它的關卡）起算，沒有就從發起；所以別的單位核准了，卡住的單位天數不會歸零。匯流後（或結案）照舊：
-- 最前面一個輪到的關卡，從整張表最後一筆簽核紀錄起算（Q95）。
--
-- 多三欄：branch_count（適用單位數＝這張表上實際有的分流；不適用的單位發起時就沒有分流）、branches_done（已核准
-- 單位數）、current_step_branch_unit（顯示的關卡所屬分流；匯流後是空值）。畫面以 branches_done < branch_count 判斷
-- 匯流前。

create or replace view public.tracking_assessment
with (security_invoker = true) as
with me as materialized (
  select public.is_audit_admin() as all_plants, public.my_tracking_plant_ids() as plant_ids
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
  s.entered_step_at,
  case when a.status = 'in_progress'
    then (now() at time zone 'Asia/Taipei')::date - (s.entered_step_at at time zone 'Asia/Taipei')::date
  end                         as days_at_step,
  case when a.status = 'closed' then s.entered_step_at end as closed_at,
  public.assessment_stage(a)  as stage,
  public.taipei_days_until(c.due_date) as due_in_days,
  b.branch_count,
  b.branches_done,
  s.branch_unit_name          as current_step_branch_unit
from public.assessment a
join public.annual_cycle c on c.id = a.cycle_id
join public.plant p on p.id = a.plant_id
join public.company co on co.id = p.company_id
cross join me
cross join lateral (
  select count(*)::int as branch_count, count(*) filter (where u.done)::int as branches_done
  from (
    select bool_and(u.state = 'done') as done
    from public.assessment_step u
    where u.assessment_id = a.id and u.branch_unit_name is not null
    group by u.branch_unit_name
  ) u
) b
cross join lateral (
  -- 匯流前：每條沒完成的分流目前的關卡，取最久沒動的那條（同樣久取關卡順序在前的）。其餘：最前面一個輪到的關卡。
  select st.position, st.name, st.signer_emp_id, st.branch_unit_name, act.at as entered_step_at
  from public.assessment_step st
  cross join lateral (
    select coalesce(max(g.signed_at), a.created_at) as at
    from public.assessment_signoff g
    where g.assessment_id = a.id
      and (
        st.branch_unit_name is null
        or exists (
          select 1 from public.assessment_step bs
          where bs.assessment_id = a.id and bs.branch_unit_name = st.branch_unit_name
            and bs.position in (g.step_position, g.return_to_position)
        )
      )
  ) act
  -- 最前面一個輪到的關卡一定在候選裡，所以每張表都有一列；匯流前它本身也是某條分流的關卡。
  where st.assessment_id = a.id
    and (
      st.position = public.current_step_position(a)
      or (a.status = 'in_progress' and b.branches_done < b.branch_count and st.state = 'current' and st.branch_unit_name is not null)
    )
  order by act.at, st.position
  limit 1
) s
left join public.tracking_signer_names() n on n.emp_id = s.signer_emp_id
where me.all_plants or a.plant_id = any(me.plant_ids);
comment on view public.tracking_assessment is
  '追蹤總覽（稽核管理者看全部、檢視者與廠區負責人看自己的廠區）：每張自評表顯示的關卡、簽核人與停留天數。匯流前顯示最久沒動的那條分流'
  '目前的關卡，停留天數從那條分流最後一筆簽核紀錄（或發起）起算；匯流後與結案是最前面一個輪到的關卡，從最後一筆簽核紀錄起算'
  '（Q95、Q116 (11)）。branch_count／branches_done＝適用單位數／已核准單位數；stage＝填寫中／簽核中／結案（Q115）。';
