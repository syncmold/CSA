-- 追蹤總覽的欄改成五大組成要素，控制作業依範本名稱展開（#86）。
--
-- 各廠匯入自己的範本後（Q111），同名表單在各廠是不同的範本，所以畫面依組成要素與名稱歸併欄；
-- 廠區沒有那份範本的格子畫斜線、不計數，適用但這年度還沒發出的才是「未發起」（取代 Q95 (6) 的暫行規則）。
-- 兩件事都要讀範本：組成要素（自評表快照裡沒有，Q101 (4)），以及哪些啟用中的範本適用哪個廠區。
-- 範本表只給稽核管理者讀，檢視者也看追蹤總覽（Q98 (6)），所以和 tracking_signer_names 一樣由
-- security definer 函式給齊，範圍照 tracking_assessment：稽核管理者看全部廠區，檢視者只看檢視廠區，其他人什麼都沒有。

create or replace function public.tracking_template()
returns table (
  template_id         uuid,
  template_code       text,
  template_name       text,
  template_version    text,
  template_component  public.control_component,
  applies_to          uuid[]
)
language sql
stable
security definer
set search_path = public
as $$
  with me as materialized (
    select public.is_audit_admin() as all_plants, public.my_viewer_plant_ids() as plant_ids
  ),
  visible as (
    select p.id, p.factory_code from public.plant p cross join me
     where me.all_plants or p.id = any(me.plant_ids)
  ),
  applies as (
    select t.id as template_id, v.id as plant_id
      from public.questionnaire_template t
      join visible v
        on t.all_plants
        or exists (select 1 from public.template_plant tp where tp.template_id = t.id and tp.factory_code = v.factory_code)
     where t.status = 'active'
  ),
  used as (
    select distinct a.template_id from public.assessment a join visible v on v.id = a.plant_id
  )
  select t.id, t.code, t.name, t.version, t.component,
         coalesce((select array_agg(ap.plant_id order by ap.plant_id) from applies ap where ap.template_id = t.id), '{}')
    from public.questionnaire_template t
   where t.id in (select template_id from applies union select template_id from used)
$$;
comment on function public.tracking_template() is
  '追蹤總覽的範本（#86）：呼叫者看得到的廠區上，啟用中適用的範本與自評表用到的範本，各帶組成要素與適用的廠區（applies_to，'
  '只算啟用中的範本、照範本現在的設定）。稽核管理者看全部廠區，檢視者只看檢視廠區，其他人拿到空清單。';
revoke execute on function public.tracking_template() from public, anon;
grant execute on function public.tracking_template() to authenticated;
