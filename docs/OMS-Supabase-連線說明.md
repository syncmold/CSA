# OMS／SyncHub Supabase 連線說明（供稽核系統登入介面參照）

> 來源：SyncHub V304-3 的 index.html（DTO 維護），2026-10-14 整理。
> 用途：稽核系統要「比照 OMS 的方式」做使用者登入，本文記錄連線路徑、登入流程、資料表與 RLS 實測結果。
> 關聯待決事項：需求決策紀錄 OPEN-2（OMS 登入通道）、OPEN-3（Supabase 費用）。

---

## 1. 連線資訊

| 項目 | 值 |
|---|---|
| Supabase 專案 URL | `https://drfqoraijhzvvllncbei.supabase.co` |
| anon key（publishable，可放前端） | `sb_publishable_PG_IHNnOMAe3oTMV6yV25w_-U-FjDwq` |
| REST 端點 | `{URL}/rest/v1/<table>?<PostgREST 查詢>` |
| Auth 登入 | `POST {URL}/auth/v1/token?grant_type=password` |
| Auth 換證 | `POST {URL}/auth/v1/token?grant_type=refresh_token` |
| Auth 改密碼 | `PUT {URL}/auth/v1/user` |
| 管理用 Edge Function | `POST {URL}/functions/v1/synchub-admin-users`（僅 admin，動作 list／create／update／delete／resetPassword） |

每個請求固定帶三個標頭：

```
apikey: <anon key>
Authorization: Bearer <未登入=anon key；登入後=使用者 access_token>
Content-Type: application/json
```

## 2. 登入流程（OMS 的做法）

1. **帳號轉 email**：使用者輸入工號或 Email。含 `@` 直接用；否則合成 `工號小寫 + @id.syncmold.com.tw`（管理員為 `admin@id.syncmold.com.tw`）。
2. **呼叫 Auth**：
   ```
   POST /auth/v1/token?grant_type=password
   headers: apikey, Content-Type
   body: { "email": "...", "password": "..." }
   ```
   成功回 `access_token`（JWT）、`refresh_token`、`user`。400／401 一律顯示「帳號或密碼錯誤」。
3. **讀權威角色**：帶 JWT 查 `synchub_profiles?id=eq.<user.id>`，取得 `username`、`name`、`role`、`factories`、`bu`、`emp_id`、`active`。
   - `active === false` → 清掉 session、顯示「此帳號已停用，請洽 DTO」。
   - 查不到 profile → 「找不到帳號設定檔，請洽 DTO」。
4. **強制改密**：`user.user_metadata.must_change === true`（初始密碼 `oms12345` 或被重設）→ 先跳改密視窗，規則：至少 8 碼、含英文與數字、不可等於 `oms12345`。改密走 `PUT /auth/v1/user`，body `{ "password": ..., "data": { "must_change": false } }`。
5. **角色分流**：OMS 的角色有 `admin / hq_manager / group_hr / bu_manager / hr / viewer / no_oms`。`no_oms`＝只能進 SyncHub 大廳。稽核系統要自己決定哪些角色可進，或改以 `system_access.systems` 是否含稽核系統代碼來判斷（見 §5）。
6. **Session 保存**：OMS 把 `{access_token, refresh_token, user}` 存 `sessionStorage`（分頁關掉即失效），並每 45 分鐘用 refresh_token 換新 token。
7. **每次進主畫面前再查一次 profile**（v298-2 守門）：不信任瀏覽器裡的舊角色，被降權或停用的人即時擋下。

## 3. JWT 說明

JWT（JSON Web Token）＝Supabase 簽過章的身分證，內含使用者 ID、角色、過期時間（約 1 小時）。資料庫的 Row Level Security 依 JWT 裡的使用者 ID 決定每一列能不能讀寫。anon key 本身也是 JWT，但代表「匿名訪客」，所以受保護的表只會回空陣列而非錯誤。

## 4. 資料表與 anon key 實測（2026-10-14；2026-11-20 依 OMS 的通知更新各表現況，詳見需求決策紀錄 Q133）

| 表／view | 內容 | anon key 讀取結果 |
|---|---|---|
| `employees_picker` | 在職員工精簡 view：`factory_code, emp_id, name, eng_name` | ❌ 2026-11-12 起不給匿名讀（401），**2026-11-20 已刪除（404）**；之後只走 OMS 給 CSA 的專用逐人查詢（Q133 (6)） |
| `oms_roster` | `synchub_profiles` 精簡 view（id, username, emp_id, role, factories, bu, systems, active…） | ⛔ 2026-11-19 收回，不登入讀回 401 |
| `system_access` | 各員工可用系統授權矩陣（factory_code, emp_id, name, eng_name, dept, title, email, systems[]） | ⛔ 2026-11-17 收回（Q133 (1)） |
| `employees` | 完整員工主檔（蛇形欄位：emp_id, factory_code, department, join_date, birth…） | ⛔ 200 但空陣列（RLS 擋，需 JWT） |
| `synchub_profiles` | 帳號正本 | ⛔ 空陣列（需 JWT）；登入後讀自己那筆（換證用）。OMS 之後會改名 `oms_profiles`，日期未定、拆換前先通知（Q133 (9)） |
| `change_log` | 人員異動紀錄 | 需 JWT |
| `functions/v1/csa-channel` | **CSA 專用逐人查詢通道**（Edge Function，2026-11-23 開通）：送工號，逐人回在職狀態、主檔／派駐／兼管廠區、姓名、帳號、有沒有勾 CSA | 不用 anon key：只認 `x-channel-code` 金鑰，只能從伺服器呼叫；CSA 的分派表匯入在用（需求決策紀錄 Q133 (10)、Q130 (6)） |
| `factories` | 廠區清單（廠區代碼、名稱、事業單位、國家、地址、排序） | ✅ 2026-11-20 OMS 確認仍開放不登入讀，沒排收回時間；`db:sync-plants` 用它（Q107 (2)） |
| `oms_users` | 舊表，已淘汰 | 不要用 |

查詢注意：PostgREST 單次最多回 1000 筆，一定要帶 `order=` 再用 `limit/offset` 分頁，否則會漏。

## 5. 稽核系統可參照的設計選項（對應 OPEN-2）

> **目前決定（2026-10-14，Q60）**：開發期先以**唯讀**方式直接接本專案，anon key 讀 `employees_picker`／`oms_roster`／`system_access`，登入驗證打 OMS Auth；**不寫入、不在 OMS 專案建稽核表**。稽核系統自己的資料暫放開發用 Supabase 專案。
> **Q61**：帳號與權限單一來源＝OMS，稽核系統不建自己的帳號表、不同步帳號；日後使用者維護全部在 OMS 的「系統資料授權」頁操作（勾稽核系統代碼即開通）。因此方案 A／B 都以 OMS Auth 為唯一登入，差別只在稽核資料放哪與 JWT 怎麼過 RLS。開發完成後再向 DTO 請示寫入、系統代碼與換證等權限，屆時再從下表二擇一定案。

| 方案 | 做法 | 影響 |
|---|---|---|
| A. 共用同一個 Supabase 專案 | 稽核表直接建在 OMS 專案；登入、profile、RLS 全部沿用 | 綁 OPEN-3 費用與 DTO 權限管理；要請 DTO 在 `SYNCHUB_SYSTEMS` 加稽核系統代碼（例如 `CSA`）並在 `system_access` 勾選 |
| B. 獨立 Supabase 專案，只借 OMS 的 Auth | 登入時打 OMS 的 `/auth/v1/token` 驗身分，取 `user.id` 與工號，再對 `employees_picker` 補名字／廠區；稽核資料與角色存自己的專案 | 需處理「OMS 的 JWT 不能直接通過自己專案的 RLS」：要有換證機制（原決策紀錄提到的 synchub-exchange）或由後端用 service role 代寫 |

兩案都需向 DTO 確認：是否允許第二個系統連入、是否新增系統代碼、稽核角色放哪裡。

## 6. 待開發功能（登入介面）

- [x] 登入頁：工號／Email＋密碼單步登入，Enter 送出，錯誤訊息比照 OMS 文案（#2）
- [x] ~~工號即時回饋：輸入工號時查 `employees_picker` 顯示姓名與廠區（#2）~~ 2026-11-23 拿掉（Q133 (5)、#218：OMS 已刪 `employees_picker`）
- [x] 首次登入強制改密：CSA 不做改密視窗，`must_change` 使用者顯示說明並導去 SyncHub（Q69，#2）
- [x] token 自動續期（45 分鐘）與 sessionStorage 保存（#2；續期時重新打 OMS refresh 並重新換證）
- [~] 進系統前即時查 profile：每次換證（登入、每 45 分鐘續期、token 將到期時）都重查 `synchub_profiles`；重新整理頁面時沿用 sessionStorage 內未到期的 session，不另查（#2）
- [~] 「回 SyncHub 入口」連結已做（`VITE_SYNCHUB_URL`，#2）；SyncHub 大廳卡片待黃裕程（OPEN-2）
- [x] 權限判斷（#2，換證端 `exchange/core.ts`）：**開發期全開（Q62）**，OMS Auth 通過＋帳號未停用即放行，以設定值 `CSA_ACCESS_ALL=true` 控制；DTO 加上系統代碼後改讀 `system_access.systems`。正式上線前必須關閉全開
