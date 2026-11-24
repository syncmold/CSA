# CSA（Control Self-Assessment）— 年度內部控制制度自行評估問卷 線上簽核及追蹤系統

稽核部用的線上系統：問卷範本管理、依廠區指派、分流並行簽核、追蹤簽核進度、隨時匯出當前狀態的 PDF。

- 用語：[GLOSSARY.md](GLOSSARY.md)；架構決策：[docs/adr/](docs/adr/)
- 前端技術選型：[docs/前端技術選型說明.md](docs/前端技術選型說明.md)
- OMS 連線與登入流程：[docs/OMS-Supabase-連線說明.md](docs/OMS-Supabase-連線說明.md)
- 範本與簽核流程的批次寫入：[docs/對話寫入草稿操作說明.md](docs/對話寫入草稿操作說明.md)
- **部署與切換環境：[docs/部署與切換手冊.md](docs/部署與切換手冊.md)**

## 架構

React 單頁前端 → PostgREST（HTTP API）→ Postgres。所有業務規則在資料庫的 RLS 與函式（ADR-0001）。

身分來自 OMS：前端用 OMS 帳號密碼登入，拿到 OMS 的 JWT 後，向換證服務換成 CSA 自己的 session token。換證服務是 `exchange/` 的核心，部署時是 Supabase Edge Function（`supabase/functions/csa-exchange`），本機開發時掛在 Vite 開發伺服器上。誰能進 CSA、稽核角色由 CSA 自己的資料庫管（放行名單、員工參照），CSA 不建帳號表。

```
src/         前端（React、Ant Design）
supabase/    migration（資料庫結構與規則）、換證 Edge Function、範本定義檔（drafts/templates）
exchange/    換證與 OMS 查詢的核心程式（與框架無關）
scripts/     資料庫初始化與 migration、範本轉換、部署指令（scripts/deploy）
tests/db/    對真實 Postgres＋PostgREST 的 RLS 測試
e2e/         Playwright 端對端測試
```

## 本機開發

需要：Node.js 24、Postgres、PostgREST（單一執行檔）。第一次在專案根目錄執行精靈，它會帶你裝好並產生 `.env`：

```bash
npm install
bash scripts/setup-local-db.sh
```

之後每天：

```bash
npm run dev:all      # 套用新 migration → 啟動 PostgREST → 啟動 Vite
```

瀏覽器開 <http://127.0.0.1:5173>，以 OMS 的工號或 Email 加密碼登入。本機開發預設放行全開（`CSA_ACCESS_ALL=true`），**任何部署出去的環境一定要是 `false`**，部署指令會檢查。

### 常用指令

| 指令 | 用途 |
|---|---|
| `npm run dev` | 只啟動 Vite（PostgREST 已在跑時用） |
| `npm run db:init` | 建立本機資料庫、PostgREST 用的 `authenticator` 角色與 `csa_drafter` 角色（可重跑） |
| `npm run db:migrate` | 依檔名順序套用 `supabase/migrations/*.sql`，每支只跑一次 |
| `npm run db:start` | 只啟動 PostgREST |
| `npm run db:keys` | 依 `CSA_JWT_SECRET` 產生前端用的 anon key |
| `npm run db:set-role -- <工號> <角色> [廠區代碼...]` | 把工號放進放行名單並設角色（新資料庫設第一位稽核主管或系統維護員時用） |
| `npm run drafts:write -- <檔案或資料夾>` | 批次寫入範本與簽核流程（寫成停用，由稽核主管檢查後啟用） |
| `npm run db:sync-plants` | 從 OMS 的 `factories` 同步廠區主檔 |
| `npm run env:clone -- <來源 .env> <N>` | 同時開第二份工作目錄時，產生各自獨立的 `.env`（資料庫與埠號） |

### 測試

| 指令 | 用途 |
|---|---|
| `npm run typecheck` | TypeScript 型別檢查 |
| `npm test` | 單元測試（純函式與換證核心，不需資料庫） |
| `npm run test:db` | RLS 測試，對本機 PostgREST |
| `npm run test:e2e` | Playwright 端對端測試（會自行啟動 Vite；部分案例需要 PostgREST） |

CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）在 PR 上跑兩條：Postgres＋PostgREST（型別、單元、RLS、e2e），以及 Supabase 本機堆疊（只跑 RLS，確保同一組 migration 在 Supabase 上相容）。只改文件的 PR 不跑。

## 環境與部署

有兩個環境：`test` 與 `prod`，程式碼同一份，差別只在設定。設定與金鑰**不放在 repo**，放在 GitHub 的 Environments（或部署者本機的 `csa-deploy/` 資料夾）。

```bash
npm run deploy -- <test|prod> update    # 合併後更新：migration → 新範本 → 換證服務 → 前端
```

建議用 Actions → Deploy 手動觸發，`prod` 要經過核准。完整說明（設定清單、第一次建環境、從測試資料庫切換到正式資料庫、備份）見 [docs/部署與切換手冊.md](docs/部署與切換手冊.md)。

## 範本與內控文件

問卷範本的定義檔在 `supabase/drafts/templates/<廠區>/`，範本最初由各廠的 Word 自評表轉出（`npm run templates:convert`，需要本機有 Microsoft Word）。公司原始 Word／PDF 不進版控。

## 授權與保密

本 repo 為公司內部專案，請勿公開。`.env`、金鑰與公司原始文件不得提交（見 `.gitignore`）。
