// npm run db:sync-plants
//
// 廠區主檔（暫行）：讀 OMS 的 factories 表（唯讀，用前端同一把 anon key，Q60），
// 以 OMS 廠區代碼為鍵新增或更新 CSA 的 plant。公司用 legal-names.json 的公司名稱（照各廠自評表頁首，#83），沒列的暫用 OMS 的事業群。
// 廠區只新增與改名、改隸屬公司，不刪（自評表會參照）；OMS 停用的廠區照樣留著，印出提醒。
// 公司則相反：沒有廠區掛著的（例如改名前的舊公司）刪掉（使用者 2026-10-27 決定，Q110 (4)）。可重跑。
// 公司沒有 Logo 的補上 FULFIL（Q110：每個廠區的 PDF 右上角都印 FULFIL）；已設了別的 Logo 不覆蓋。
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { required } from '../db/env.mjs'

const FULFIL_LOGO = 'logos/fulfil.png'
const { _comment, ...legalNames } = JSON.parse(readFileSync(new URL('./legal-names.json', import.meta.url), 'utf8'))
const factoryCode = (f) => String(f.code ?? '').trim().toUpperCase()

const omsUrl = required('VITE_OMS_URL')
const omsKey = required('VITE_OMS_ANON_KEY')
const response = await fetch(`${omsUrl}/rest/v1/factories?select=code,name,bu,country,active,sort_order&order=code`, {
  headers: { apikey: omsKey, Authorization: `Bearer ${omsKey}` },
})
if (!response.ok) {
  console.error(`讀不到 OMS 的廠區（HTTP ${response.status}）：${await response.text()}`)
  process.exit(1)
}
const factories = await response.json()
if (!Array.isArray(factories) || factories.length === 0) {
  console.error('OMS 沒有回任何廠區，不更新主檔。')
  process.exit(1)
}
const omsCodes = new Set(factories.map(factoryCode))
const notInOms = Object.keys(legalNames).filter((code) => !omsCodes.has(code))

const dbUrl = new URL(required('CSA_DB_URL'))
const adminUrl = new URL(required('CSA_DB_ADMIN_URL'))
adminUrl.pathname = dbUrl.pathname // superuser, but on the CSA database (same as migrate.mjs)

const client = new pg.Client({ connectionString: adminUrl.toString() })
await client.connect()
try {
  await client.query('begin')
  const companyIds = new Map()
  let synced = 0
  async function companyId(name) {
    if (!companyIds.has(name)) {
      const { rows } = await client.query(
        `insert into public.company (name, logo_path) values ($1, $2)
         on conflict (name) do update set logo_path = coalesce(public.company.logo_path, excluded.logo_path)
         returning id`,
        [name, FULFIL_LOGO],
      )
      companyIds.set(name, rows[0].id)
    }
    return companyIds.get(name)
  }

  for (const f of factories) {
    const code = factoryCode(f)
    const name = String(f.name ?? '').trim()
    if (!code || !name) {
      console.warn(`  ⚠ 略過沒有代碼或名稱的廠區：${JSON.stringify(f)}`)
      continue
    }
    const company = legalNames[code] ?? (String(f.bu ?? '').trim() || name)
    const { rows } = await client.query(
      `insert into public.plant (factory_code, name, company_id, sort_order) values ($1, $2, $3, $4)
       on conflict (factory_code) do update set name = excluded.name, company_id = excluded.company_id, sort_order = excluded.sort_order
       returning (xmax = 0) as inserted`,
      // 顯示順序照 SyncHub 的廠區列表（#84）。
      [code, name, await companyId(company), Number.isInteger(f.sort_order) ? f.sort_order : null],
    )
    const note = legalNames[code] ? '' : '（公司暫用事業群）'
    const inactive = f.active === false ? '　⚠ OMS 已停用，CSA 照樣保留' : ''
    synced++
    console.log(`  ${rows[0].inserted ? '新增' : '更新'} ${code} ${name} → ${company}${note}${inactive}`)
  }
  const { rows: removed } = await client.query(
    `delete from public.company co
     where not exists (select 1 from public.plant p where p.company_id = co.id)
     returning co.name`,
  )
  for (const r of removed) console.log(`  刪除沒有廠區的公司：${r.name}`)
  await client.query('commit')
  console.log(`廠區主檔同步完成：${synced} 個廠區、${companyIds.size} 家公司${removed.length ? `，刪掉 ${removed.length} 家沒有廠區的公司` : ''}。`)
} catch (error) {
  await client.query('rollback').catch(() => {})
  throw error
} finally {
  await client.end()
}
if (notInOms.length) console.warn(`  ⚠ legal-names.json 有列、OMS 沒有的廠區（沒有建立）：${notInOms.join('、')}`)
