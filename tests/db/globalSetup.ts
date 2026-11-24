// 資料庫測試開始前跑一次。各測試檔並行、共用一個資料庫，各自把自己的人設成稽核主管（promoteToAuditAdmin）。稽核主管
// 剛好一位時，流程與自評表的稽核主管關卡會連動到他（#190）：共用的資料庫裡那會把別的測試檔的關卡換掉。所以先放兩位
// 假的稽核主管（不在放行名單、不登入），共用的資料庫永遠不只一位，稽核主管就不連動；要測連動的在自己的資料庫測
// （migratedDb）。
import { existsSync } from 'node:fs'
import { withSuperuser } from './helpers'

const PLACEHOLDER_CHIEFS = ['ZZCHIEF1', 'ZZCHIEF2']

export default async function setup(): Promise<void> {
  // globalSetup 不經過 db 專案的 env（那只給測試檔）：和 playwright.config 一樣自己讀 .env；CI 已設的環境變數不會被蓋掉。
  if (existsSync('.env')) process.loadEnvFile('.env')
  await withSuperuser((sql) =>
    sql.query(
      `insert into public.employee_ref (emp_id, name, audit_role) select unnest($1::text[]), '測試用稽核主管', 'audit_admin'
       on conflict (emp_id) do update set audit_role = 'audit_admin'`,
      [PLACEHOLDER_CHIEFS],
    ),
  )
}
