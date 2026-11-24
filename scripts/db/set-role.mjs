// npm run db:set-role -- <工號> <signer|viewer|audit_staff|audit_admin|system_maintainer> [檢視廠區代碼...]
//
// 平常在「權限管理」頁維護角色（#58、Q98、Q122）；這支指令留給新環境設第一位稽核主管（audit_admin）與系統維護員，以及本機開發。
// 這支指令直接寫資料表，不做「換稽核主管」（前任降級）：稽核主管剛好一位的規則在權限管理頁的設定函式裡（#187）。
// 和部署指令一樣不必先登入過：沒有 employee_ref 那一列就先建。設成稽核主管、稽核人員或檢視者時也放進放行名單（有角色卻換不到
// session 沒有意義），系統維護員也一樣；設成簽核人只改角色，不放行，所以拿它降級別人不會順便讓人進來（Q99 (4)）。
// 檢視者的檢視廠區給廠區代碼（例：FQ SY），沒給就用他在 employee_ref 的 OMS 廠區；兩者都沒有就要求給代碼。
// 資料庫的規則照樣適用：降級最後一位稽核主管或系統維護員會被拒絕；變更記進權限異動紀錄，操作者是空值（部署指令）。
// 工號不進 repo，由操作者在命令列給。
import pg from 'pg'
import { required } from './env.mjs'

const ROLES = ['signer', 'viewer', 'audit_staff', 'audit_admin', 'system_maintainer']
const [rawEmpId, role, ...plantCodes] = process.argv.slice(2)
const empId = (rawEmpId ?? '').trim().toUpperCase()

if (!empId || !ROLES.includes(role) || (plantCodes.length > 0 && role !== 'viewer')) {
  console.error(`用法：npm run db:set-role -- <工號> <${ROLES.join('|')}> [檢視者的廠區代碼...]`)
  process.exit(2)
}

const dbUrl = new URL(required('CSA_DB_URL'))
const adminUrl = new URL(required('CSA_DB_ADMIN_URL'))
adminUrl.pathname = dbUrl.pathname // superuser, but on the CSA database (same as migrate.mjs)

const client = new pg.Client({ connectionString: adminUrl.toString() })
await client.connect()
try {
  await client.query('begin')
  let plantIds = []
  if (role === 'viewer') {
    const codes = plantCodes.length
      ? plantCodes.map((c) => c.trim().toUpperCase())
      : (await client.query('select factory_code from public.employee_ref where emp_id = $1', [empId])).rows
          .map((r) => r.factory_code)
          .filter(Boolean)
    if (!codes.length) {
      throw new Error(`不知道 ${empId} 的廠區（還沒登入過）：請在後面加上檢視廠區代碼，例如 npm run db:set-role -- ${empId} viewer FQ`)
    }
    const { rows } = await client.query('select id, factory_code from public.plant where factory_code = any($1::text[])', [codes])
    const missing = codes.filter((c) => !rows.some((r) => r.factory_code === c))
    if (missing.length) throw new Error(`廠區主檔沒有 ${missing.join('、')}`)
    plantIds = rows.map((r) => r.id)
  }
  // Role first, then the list: a new 稽核管理者 is already one when the 加入 is recorded.
  await client.query(
    `insert into public.employee_ref (emp_id, audit_role, viewer_plant_ids) values ($1, $2, $3)
     on conflict (emp_id) do update set audit_role = excluded.audit_role, viewer_plant_ids = excluded.viewer_plant_ids`,
    [empId, role, plantIds],
  )
  const listed = role === 'signer'
    ? { rowCount: 0 }
    : await client.query('insert into public.access_allowlist (emp_id) values ($1) on conflict do nothing', [empId])
  const { rows } = await client.query(
    `select e.emp_id, e.name, e.factory_code, e.audit_role, public.viewer_plant_codes(e.viewer_plant_ids) as plants
       from public.employee_ref e where e.emp_id = $1`,
    [empId],
  )
  await client.query('commit')
  const row = rows[0]
  const plants = row.plants.length ? `，檢視廠區 ${row.plants.join('、')}` : ''
  console.log(`${row.emp_id} ${row.name ?? '（尚未登入過）'}（${row.factory_code ?? '-'}）→ ${row.audit_role}${plants}`)
  if (listed.rowCount) console.log('  已加入放行名單')
} catch (e) {
  await client.query('rollback').catch(() => {})
  console.error(`✗ ${e.message}`)
  process.exitCode = 1
} finally {
  await client.end()
}
