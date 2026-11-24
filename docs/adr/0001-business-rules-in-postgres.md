---
status: accepted（規則放資料庫）；「獨立 Supabase 專案」部分已被 需求決策紀錄 Q76 修正：CSA 資料庫自架 Postgres＋PostgREST（開發期在開發者電腦，正式版在公司 Windows VM），不用 Supabase 託管；資料層仍是標準 Postgres，本 ADR 的規則與可搬遷性論點不變。細節待 OPEN-4
---

# 業務規則寫在 Postgres（RLS＋資料庫函式），使用獨立的 Supabase 專案

誰能看哪張自評表、哪個關卡能改哪些控制要點、簽核或退回後輪到誰，都由 Postgres 的 RLS 與資料庫函式判斷，前端只負責呈現；資料庫結構、RLS 與函式全部以 migration 檔進版控，不在 Supabase 後台手動修改。這樣權限擋在資料層，繞過前端直接呼叫 API 也無法越權；而且這些都是標準 Postgres 功能，日後要把資料庫從 Supabase 搬走時可以整套帶走，只需改寫前端的資料存取層。資料放在本系統自己的 Supabase 專案，不放進 OMS 所在的專案，避免與其他系統搶用量，也讓搬遷不受他人影響。

## Considered Options

- **邏輯寫在前端**：最快，但任何人都能直接呼叫 API 繞過檢查，簽核系統不能接受。
- **另架 API 伺服器**：邏輯集中、易測試，但多一個要部署、要付費、要維運的元件；demo 階段沒有預算。
