// npm run db:launch -- <年度> <截止日> <稽核主管工號>
//
// 開發期指令 (#4): 以某位稽核主管的身分呼叫資料庫函式 launch_annual_cycle，發起該年度的
// 所有還沒發過的「啟用範本 × 適用廠區」；年度已有年度作業時是補發，截止日沿用（Q119）。#12 起畫面在
// /admin/launch；這支留給腳本化的 demo 準備。
// 函式從 JWT 讀身分，所以這裡用 set_config 在同一個交易裡模擬 PostgREST 放進去的 claims，
// 規則（只有稽核主管能發起、缺流程整體拒絕）仍然全部由函式判斷，這支不繞過資料庫的檢查。
// 只有在職狀態不查：去年的人照樣帶入，離職的人從缺要從畫面發起（#102）。
import pg from 'pg'
import { required } from './env.mjs'

const [yearArg, dueDate, empId] = process.argv.slice(2)
const year = Number(yearArg)

if (!Number.isInteger(year) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate ?? '') || !empId) {
  console.error('用法：npm run db:launch -- <年度> <截止日 YYYY-MM-DD> <稽核主管工號>')
  process.exit(2)
}

const dbUrl = new URL(required('CSA_DB_URL'))
const adminUrl = new URL(required('CSA_DB_ADMIN_URL'))
adminUrl.pathname = dbUrl.pathname // superuser, but on the CSA database (same as migrate.mjs)

const client = new pg.Client({ connectionString: adminUrl.toString() })
await client.connect()
try {
  await client.query('begin')
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ role: 'authenticated', app_metadata: { emp_id: empId } }),
  ])
  const { rows } = await client.query('select public.launch_annual_cycle($1, $2::date) as result', [year, dueDate])
  const result = rows[0].result
  if (!result.ok) {
    await client.query('rollback')
    console.error(`發起被拒絕：${result.error}`)
    for (const m of result.missing ?? []) {
      const why = { not_ready: '簽核流程未通過發起檢查', no_coordinator: '廠區還沒有廠區管理員' }[m.problem] ?? '沒有簽核流程'
      console.error(`  ${why}：${m.template_code} ${m.template_name} × ${m.factory_code} ${m.plant_name}`)
    }
    if (result.error === 'no_combos') console.error(`  ${year} 年度沒有還沒發過的「啟用範本 × 適用廠區」。`)
    process.exit(1)
  }
  await client.query('commit')
  console.log(
    result.top_up
      ? `已補發 ${year} 年度：${result.assessments} 張自評表，截止日沿用 ${result.due_date}。`
      : `已發起 ${year} 年度作業（截止 ${result.due_date}），產生 ${result.assessments} 張自評表。`,
  )
} catch (error) {
  await client.query('rollback').catch(() => {})
  if (error.code === '42501') {
    console.error(`工號 ${empId} 不是稽核主管。請先 npm run db:set-role -- ${empId} audit_admin。`)
    process.exit(1)
  }
  throw error
} finally {
  await client.end()
}
