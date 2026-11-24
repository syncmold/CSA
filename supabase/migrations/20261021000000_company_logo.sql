-- 匯出 PDF（方案A，#7）：公司主檔加 Logo (Q1、Q56)。
-- PDF 版頭左放集團 Logo（集團共用，跟著前端程式走）、右放公司 Logo（依公司帶入）。Logo 圖檔放在前端靜態檔
-- （public/logos/），這裡只存相對路徑，例如 'logos/fulfil.png'；沒有 Logo 的公司為 null，PDF 留白。
-- 改為上傳圖檔（存資料庫或檔案儲存）時只需換掉這個欄位與前端載入的那一處。
-- 讀取權限沿用 company 的 select（所有登入的人），沒有新增任何寫入授權。

alter table public.company add column logo_path text;
comment on column public.company.logo_path is
  '公司 Logo，前端靜態檔的相對路徑（如 logos/fulfil.png），印在 PDF 版頭右側；null＝沒有 Logo。';

-- 種子：福清富群的 FULFIL Logo，暫時從紙本掃描檔裁切（拿到原始圖檔後直接替換 public/logos/fulfil.png）。
update public.company set logo_path = 'logos/fulfil.png' where name = '福清富群電子有限公司';
