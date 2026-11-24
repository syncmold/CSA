-- 其他廠區（Q139，2026-11-19 使用者決定）：OMS 沒有的單位（目前是境外子公司 samoa 的 2 份範本）掛在 CSA 自己的廠區
-- 「其他廠區」，簽核流程、年度發起、分派、追蹤總覽、自評表紀錄照一般廠區處理，就能發出。
--   代碼   OTHER（OMS 的廠區代碼不會是這個字；sync-plants 只新增與更新 OMS 有的廠區，不刪，所以不會動到它）。
--   公司   SAMOA（PDF 抬頭；原檔頁首只寫「XXX(SAMOA)」，使用者選定先印 SAMOA），Logo 同其他公司暫用 FULFIL。
--   順序   排在所有 OMS 廠區後面（sort_order 很大；OMS 的 sort_order 是個位到百位數）。
--   範本   已有的 SAMOA-01、SAMOA-02 沒有適用廠區：補上 OTHER（只補沒有任何適用廠區的，已掛廠區的不動）。新環境由
--          定義檔（factoryCodes = OTHER）寫入。
--   分派   OMS 沒有屬於 OTHER 的員工：分派名單在這個廠區不限廠區（前端 isCsaOnlyPlant，#101 的「只選本廠員工」本來就
--          只在畫面上限制，資料庫不擋，Q116 (16)）。

with c as (
  insert into public.company (name, logo_path) values ('SAMOA', 'logos/fulfil.png')
  on conflict (name) do update set name = excluded.name
  returning id
)
insert into public.plant (factory_code, name, company_id, sort_order)
select 'OTHER', '其他廠區', c.id, 100000 from c
on conflict (factory_code) do nothing;

insert into public.template_plant (template_id, factory_code)
select t.id, 'OTHER'
from public.questionnaire_template t
where t.code like 'SAMOA-%'
  and not t.all_plants
  and not exists (select 1 from public.template_plant tp where tp.template_id = t.id);
