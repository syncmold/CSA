// npm run drafts:write -- <定義檔或資料夾> [...]   把範本與簽核流程定義寫進 CSA 資料庫（對話寫入，ADR-0006、Q90）
//
// 以 csa_drafter 角色連線（scripts/drafts/connection.ts），它只能執行 draft_template／draft_route。暫行做法（Q137 (7) ①）：
// 只寫資料庫還沒有的範本編號（寫成停用，稽核主管在範本管理檢查後改為啟用）與還沒有流程的範本 × 廠區；已有的擋下，
// 請到範本管理／簽核流程直接修改。操作說明：docs/對話寫入草稿操作說明.md。
//
// 定義檔是 JSON，`kind` 決定交給哪一支函式；給資料夾就寫入裡面（含子資料夾）所有 .json。
// 範本先寫、流程後寫（流程要找得到範本）。每個檔案各自一個交易，失敗的列出原因、其他照寫，最後有失敗就回非零。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import pg from 'pg'
import '../db/env.mjs'
import { drafterConnectionString } from './connection.ts'

/** kind → 草稿函式與寫入順序。#39 在這裡加 control_procedure。 */
const KINDS = {
  template: { fn: 'draft_template', order: 0, describe: (d, r) => `範本 ${d.code} ${d.name}（新範本，停用）：${r.sections} 章 ${r.control_points} 題` },
  route: { fn: 'draft_route', order: 1, describe: (d, r) => `簽核流程 ${d.templateCode} × ${d.factoryCode}（新流程）：${r.steps} 關` },
}

const paths = process.argv.slice(2)
if (paths.length === 0) {
  console.error('用法：npm run drafts:write -- <定義檔.json 或資料夾> [...]')
  process.exit(2)
}

let failed = 0
const fail = (file, message) => {
  failed++
  console.error(`✗ ${basename(file)}：${message}`)
}

const files = paths.flatMap((p) => {
  if (!existsSync(p)) {
    fail(p, '找不到這個檔案或資料夾')
    return []
  }
  // 範本依廠區分資料夾（supabase/drafts/templates/<廠區>/，Q111），所以連子資料夾一起找。
  return statSync(p).isDirectory()
    ? readdirSync(p, { recursive: true }).filter((f) => f.endsWith('.json')).sort().map((f) => join(p, f))
    : [p]
})

const drafts = []
for (const file of files) {
  try {
    const def = JSON.parse(readFileSync(file, 'utf8'))
    const kind = KINDS[def.kind]
    if (kind) drafts.push({ file, def, kind })
    else fail(file, `不認得的 kind「${def.kind}」（可用：${Object.keys(KINDS).join('、')}）`)
  } catch (e) {
    fail(file, `讀不懂的 JSON：${e.message}`)
  }
}
drafts.sort((a, b) => a.kind.order - b.kind.order)

const client = new pg.Client({ connectionString: drafterConnectionString(process.env) })
await client.connect()
try {
  for (const { file, def, kind } of drafts) {
    try {
      const { rows } = await client.query(`select public.${kind.fn}($1::jsonb) as result`, [JSON.stringify(def)])
      console.log(`✓ ${basename(file)}：${kind.describe(def, rows[0].result)}`)
      // 限定廠區卻沒給廠區代碼照樣寫入（Q90），但這份範本在補上廠區前用不到，提醒稽核管理者檢查抬頭時補上。
      if (def.kind === 'template' && !def.allPlants && !(def.factoryCodes ?? []).length) {
        console.warn(`  ⚠ 沒有適用廠區：請在範本頁的「編輯抬頭」補上，否則年度發起與簽核流程都用不到這份範本`)
      }
    } catch (e) {
      fail(file, `${e.message}${e.code ? `（${e.code}）` : ''}`)
    }
  }
} finally {
  await client.end()
}
console.log(
  failed
    ? `${failed} 個檔案沒有寫入（已有的範本或流程請到範本管理／簽核流程直接修改）。`
    : '全部寫入。新範本是停用的：請稽核主管在範本管理檢查後改為啟用；流程在簽核流程頁看發起檢查。',
)
process.exit(failed ? 1 : 0)
