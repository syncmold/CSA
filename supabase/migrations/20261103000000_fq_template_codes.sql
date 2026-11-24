-- 各廠區自己的範本之前，先把福清現有的範本換成新規則 (工單 #84 第一段)。實作決定見需求決策紀錄 Q111。
--
--   編號      每廠一份範本，編號＝「廠區代碼-該廠紙本編號」。福清現有 16 份（02 的種子 migration 與
--             supabase/drafts 的 15 份）加上「FQ-」開頭。已使用的範本也直接改：已發出的自評表存的是發出
--             當時的編號 (assessment.template_code，ADR-0004)，簽核流程綁的是範本 id，都不受影響，
--             所以不必另開新版本。只是換標籤，不更新 updated_at。這 16 個編號在此之前只有福清的範本用過；
--             FQ- 編號同版本已經有了（例如先寫了新的草稿定義檔才套 migration）就停下來，不讓 unique 錯誤擋在半路。
--   適用廠區  02 原本是「所有廠區適用」；每廠各一份之後只適用福清。只改仍是「所有廠區」的；
--             已經限定廠區的（例如測試環境套到六個試用廠區的）照舊，不動試用中的流程。
--             02 掛在福清以外廠區的簽核流程從此發不出去，逐條以 notice 列出，讓稽核管理者決定停用或改用該廠的範本。
--   自評單位  集團共用清單的「財務單位」改名「財會單位」、「環安室」改名「環安單位」（使用者決定；轉檔的
--             對應表 scripts/templates/convert.mjs 的 UNIT_MAPPING 也有這兩條）。範本與流程以 id 參照單位，
--             跟著改名；關卡名稱是自由文字（「自行檢查人員－財務單位」），裡面的舊名稱一併換掉，只是換標籤，
--             所以暫停關卡的觸發器（不更新流程的 updated_at，啟用檢查的結果也不會變）。
--             已發出的自評表存的是發出當時的單位與關卡名稱，不受影響 (ADR-0004)。
--             新名稱已經有人建了就停下來，由稽核管理者決定要合併還是改名，不默默併掉。
--   組成要素  沒指定時依編號 A–D 推定（Q101 (2)），編號加了廠區前綴（FQ-A）後要先跳過前綴，否則推不出來、列為未分類。
--             已經因此留空的要素類一併補上。

do $$
declare
  v_rename record;
begin
  for v_rename in select * from (values ('財務單位', '財會單位'), ('環安室', '環安單位')) r(old_name, new_name) loop
    if exists (select 1 from public.assessing_unit where name = v_rename.old_name)
       and exists (select 1 from public.assessing_unit where name = v_rename.new_name) then
      raise exception '自評單位清單同時有「%」與「%」：請先在自評單位清單決定要合併還是改名，再套這個 migration',
        v_rename.old_name, v_rename.new_name;
    end if;
    update public.assessing_unit set name = v_rename.new_name where name = v_rename.old_name;
  end loop;
end
$$;

alter table public.route_step disable trigger user;
update public.route_step
set name = replace(replace(name, '財務單位', '財會單位'), '環安室', '環安單位')
where name like '%財務單位%' or name like '%環安室%';
alter table public.route_step enable trigger user;

do $$
declare
  v_clash record;
  v_route record;
begin
  select t.code, t.version into v_clash
  from public.questionnaire_template t
  join public.questionnaire_template fq on fq.code = 'FQ-' || t.code and fq.version = t.version
  where t.code in ('01.1', '02', '03.1', '04', '05', '06', '07', '08', '09', '10.1', '11', '15', 'A', 'B', 'C', 'D')
  limit 1;
  if found then
    raise exception '範本 % % 要改成 FQ-%，但 FQ-% % 已經有了：請先刪掉或改掉其中一份，再套這個 migration',
      v_clash.code, v_clash.version, v_clash.code, v_clash.code, v_clash.version;
  end if;

  for v_route in
    select t.code, p.factory_code, r.status
    from public.approval_route r
    join public.questionnaire_template t on t.id = r.template_id
    join public.plant p on p.id = r.plant_id
    where t.code = '02' and t.all_plants and p.factory_code <> 'FQ' and r.status <> 'inactive'
  loop
    raise notice '簽核流程 % × %（%）：FQ-02 改成只適用福清，這條流程發不出去了', v_route.code, v_route.factory_code, v_route.status;
  end loop;
end
$$;

alter table public.questionnaire_template disable trigger questionnaire_template_touch_updated_at;

-- 同一列不能在兩個 CTE 各更新一次（只有一次生效），所以編號與適用廠區一次改完，回傳改之前是不是所有廠區。
with fq as (
  update public.questionnaire_template t
  set code = 'FQ-' || t.code, all_plants = false
  from public.questionnaire_template before
  where before.id = t.id
    and t.code in ('01.1', '02', '03.1', '04', '05', '06', '07', '08', '09', '10.1', '11', '15', 'A', 'B', 'C', 'D')
  returning t.id, before.all_plants as was_all_plants
)
insert into public.template_plant (template_id, factory_code)
select id, 'FQ' from fq where was_all_plants
on conflict do nothing;

alter table public.questionnaire_template enable trigger questionnaire_template_touch_updated_at;

-- 依編號推定要素類的組成要素：跳過廠區前綴（「FQ-」），再看開頭的 A–D（後面不能緊接英文字母，免得把 AB 之類的編號當成 A）。
create or replace function public.component_from_code(p_code text)
returns public.control_component
language sql
immutable
set search_path = public
as $$
  select case substring(upper(btrim(p_code)) from '^(?:[A-Z]+-)?([A-D])([^A-Z]|$)')
    when 'A' then 'control_environment'::public.control_component
    when 'B' then 'risk_assessment'
    when 'C' then 'information_communication'
    when 'D' then 'monitoring'
  end
$$;
comment on function public.component_from_code(text) is
  '內部用：要素類沒指定組成要素時，依編號 A–D 推定（可以有廠區前綴，如 FQ-A，Q111）；推不出來回 null。';

alter table public.questionnaire_template disable trigger questionnaire_template_touch_updated_at;
update public.questionnaire_template
set component = public.component_from_code(code)
where layout = 'element' and component is null and public.component_from_code(code) is not null;
alter table public.questionnaire_template enable trigger questionnaire_template_touch_updated_at;
