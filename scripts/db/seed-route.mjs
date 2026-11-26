// npm run db:seed-route
//
// 開發期種子 (#4, Q78): 建立「FQ-02 採購及付款循環 × 福清富群」的簽核流程，並把台北稽核人員設成福清的廠區管理員
// （廠區要有廠區管理員才能發起，#101；#187 起應由稽核人員擔任，CSA_DEMO_TAIPEI_AUDITOR 沒填時才由稽核主管兼、不連動）。關卡結構依現行紙本簽核欄；廠區端不設人名，發起後在
// 「分派填寫人」分派；稽核室的台北稽核人員與稽核主管兩關帶連動標記（#189），台北稽核人員是稽核人員、稽核主管剛好一位時，發起帶入的
// 是權限管理上的人（#190），流程上存的是這裡的工號。簽核人是開發小組成員的真實 OMS 工號，不進版控，由操作者放在 .env（見 .env.example
// 的 CSA_DEMO_*）。可重跑：該範本×廠區原本的流程整條換掉（每個組合只有一條，Q137 (6)），已有廠區管理員就不換。已發出的自評表不受影響（發起時已凍結
// 關卡，ADR-0004）。不改任何人的角色：要看連動，用 db:set-role 把台北稽核人員設成 audit_staff、稽核主管設成 audit_admin。
import pg from 'pg'
import { optional, required } from './env.mjs'

const TEMPLATE_CODE = 'FQ-02'
const FACTORY_CODE = 'FQ'
const UNITS = ['資材單位', '品保單位', '財會單位']

const auditChief = required('CSA_DEMO_AUDIT_CHIEF')
const subsidiaryAuditor = optional('CSA_DEMO_SUBSIDIARY_AUDITOR', '') || auditChief
const taipeiAuditor = optional('CSA_DEMO_TAIPEI_AUDITOR', '') || auditChief

// 廠區端每個自評單位一條分流（自行檢查人員 → 部門主管，並行），匯流到廠區經理人，再到稽核室覆核（Q116）。
// unit＝可編輯的自評單位（自行檢查人員的分流由觸發器帶），branch＝部門主管所屬的分流。
const STEPS = [
  ...UNITS.map((unit) => ({ name: `自行檢查人員－${unit}`, group: 'plant', signer: null, unit, branch: null })),
  ...UNITS.map((unit) => ({ name: `部門主管－${unit}`, group: 'plant', signer: null, unit: null, branch: unit })),
  { name: '廠區經理人', group: 'plant', signer: null, unit: null, branch: null },
  { name: '子公司擔當稽核', group: 'audit_review', signer: subsidiaryAuditor, unit: null, branch: null },
  { name: '台北稽核人員', group: 'audit_review', signer: taipeiAuditor, unit: null, branch: null, link: 'taipei_auditor' },
  { name: '稽核主管', group: 'audit_review', signer: auditChief, unit: null, branch: null, link: 'audit_chief' },
]

const dbUrl = new URL(required('CSA_DB_URL'))
const adminUrl = new URL(required('CSA_DB_ADMIN_URL'))
adminUrl.pathname = dbUrl.pathname // superuser, but on the CSA database (same as migrate.mjs)

const client = new pg.Client({ connectionString: adminUrl.toString() })
await client.connect()
try {
  const template = (await client.query('select id from public.questionnaire_template where code = $1', [TEMPLATE_CODE])).rows[0]
  const plant = (await client.query('select id from public.plant where factory_code = $1', [FACTORY_CODE])).rows[0]
  if (!template || !plant) {
    console.error(`找不到範本 ${TEMPLATE_CODE} 或廠區 ${FACTORY_CODE}。請先執行 npm run db:migrate。`)
    process.exit(1)
  }
  const unitIds = new Map(
    (await client.query('select id, name from public.assessing_unit where name = any($1)', [UNITS])).rows.map((r) => [r.name, r.id]),
  )
  for (const unit of UNITS) {
    if (!unitIds.has(unit)) {
      console.error(`找不到自評單位「${unit}」。範本 02 的種子應該已建立它，請先執行 npm run db:migrate。`)
      process.exit(1)
    }
  }

  // 直接寫 plant_coordinator 會繞過 assign_plant_coordinator 的檢查：系統維護員不能當廠區管理員（Q129）。
  const maintainer = (await client.query(`select 1 from public.employee_ref where emp_id = $1 and audit_role = 'system_maintainer'`, [taipeiAuditor])).rowCount
  if (maintainer) {
    console.error(`${taipeiAuditor} 是系統維護員，不能當廠區管理員：.env 的 CSA_DEMO_TAIPEI_AUDITOR 請填一位稽核人員（沒填時用 CSA_DEMO_AUDIT_CHIEF）。`)
    process.exit(1)
  }

  await client.query('begin')
  await client.query('delete from public.approval_route where template_id = $1 and plant_id = $2', [template.id, plant.id])
  const route = (
    await client.query(
      'insert into public.approval_route (template_id, plant_id) values ($1, $2) returning id',
      [template.id, plant.id],
    )
  ).rows[0]
  for (const [i, step] of STEPS.entries()) {
    await client.query(
      `insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id, branch_unit_id, link)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        route.id, i + 1, step.name, step.group, step.signer,
        step.unit ? unitIds.get(step.unit) : null, step.branch ? unitIds.get(step.branch) : null, step.link ?? null,
      ],
    )
  }
  for (const id of new Set([auditChief, taipeiAuditor])) {
    await client.query('insert into public.access_allowlist (emp_id) values ($1) on conflict do nothing', [id])
  }
  await client.query('insert into public.plant_coordinator (plant_id, emp_id) values ($1, $2) on conflict do nothing', [plant.id, taipeiAuditor])
  await client.query('commit')

  console.log(`已建立 ${TEMPLATE_CODE} × ${FACTORY_CODE} 的簽核流程，共 ${STEPS.length} 關：`)
  for (const [i, step] of STEPS.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${step.name}（${step.signer ?? '發起後指派'}）`)
  }
  const coordinator = (await client.query(
    `select c.emp_id, e.audit_role from public.plant_coordinator c left join public.employee_ref e on e.emp_id = c.emp_id where c.plant_id = $1`,
    [plant.id],
  )).rows[0]
  const linking = coordinator.audit_role === 'audit_staff'
    ? '稽核人員，台北稽核人員關卡連動他'
    : '不是稽核人員，台北稽核人員關卡不連動，照流程上存的人'
  console.log(`${FACTORY_CODE} 的廠區管理員：${coordinator.emp_id}（${linking}）`)
} catch (error) {
  await client.query('rollback').catch(() => {})
  throw error
} finally {
  await client.end()
}
