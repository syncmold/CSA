-- 廠區的顯示順序 (工單 #84 第三段)：範本管理的廠區按鈕照 SyncHub 廠區列表的順序排（使用者 2026-10-29 要求），
-- 也就是依事業群：信錦台北、信鋐、組裝產品事業群、自製零件事業群、敬得、陸合。實作決定見需求決策紀錄 Q111 (6)。
-- 順序取自 OMS factories.sort_order，由廠區主檔同步（npm run db:sync-plants／deploy master）一起寫入；SyncHub
-- 調整順序後同步一次就跟著變。還沒同步到的是空值，排在後面、依代碼。

alter table public.plant add column sort_order integer;
comment on column public.plant.sort_order is '顯示順序，照 OMS factories.sort_order（SyncHub 廠區列表的順序）；空值排在後面。';
