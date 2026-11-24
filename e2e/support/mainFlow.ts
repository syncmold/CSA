// 主線驗收 (#8) 的測試資料與身分：每次執行自己建一個公司與廠區、把福清的「FQ-02 採購及付款循環」暫時加上這個廠區，掛一條和
// `npm run db:seed-route` 同形狀的 10 關流程、以四個假工號發起一個測試年度。身分走真實換證（OMS 換成假的），
// 拿到的 CSA session 直接放進瀏覽器的 sessionStorage，所以不需要 OMS 帳密、工號也不進 repo（Q78、Q82）。
// 需要 PostgREST 在 CSA_REST_URL 上（`npm run dev:all`，CI 是 `npm run db:start`）。
import type { Page } from '@playwright/test'
import type { StoredSession } from '../../src/auth/types'
import {
  admin, borrowFq02, exchangeAs, exchangeAsAdminAccount, insertRow, launchAssigned, loginAs, makeRoute, ok, promoteToAuditAdmin, releaseFq02, requirePostgrest,
} from '../../tests/db/helpers'

export interface Person {
  empId: string
  name: string
}

const RUN = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase()

/** 和 demo 同樣的分工（Q78）：甲是稽核管理者兼稽核室三關，乙兼三個自評單位，丙兼三位部門主管與廠區經理人。 */
export const PEOPLE = {
  auditAdmin: { empId: `${RUN}A`, name: '測試甲' },
  selfChecker: { empId: `${RUN}B`, name: '測試乙' },
  manager: { empId: `${RUN}C`, name: '測試丙' },
  outsider: { empId: `${RUN}D`, name: '測試丁' },
} satisfies Record<string, Person>

export const UNITS = ['資材單位', '品保單位', '財會單位'] as const

/** seed-route.mjs 的關卡，簽核人換成上面的假工號。 */
export const STEPS = [
  ...UNITS.map((unit) => ({ name: `自行檢查人員－${unit}`, group: 'plant' as const, signer: PEOPLE.selfChecker, unit, branch: unit })),
  ...UNITS.map((unit) => ({ name: `部門主管－${unit}`, group: 'plant' as const, signer: PEOPLE.manager, unit: null, branch: unit })),
  { name: '廠區經理人', group: 'plant', signer: PEOPLE.manager, unit: null, branch: null },
  { name: '子公司擔當稽核', group: 'audit_review', signer: PEOPLE.auditAdmin, unit: null, branch: null },
  { name: '台北稽核人員', group: 'audit_review', signer: PEOPLE.auditAdmin, unit: null, branch: null },
  { name: '稽核主管', group: 'audit_review', signer: PEOPLE.auditAdmin, unit: null, branch: null },
] as const

/** tests/db/helpers.ts 檔尾的年度區間表：18000 是這支主線驗收。 */
export const YEAR = 18000 + Math.floor(Math.random() * 1000)
export const PLANT_NAME = `${RUN}測試廠`
const FACTORY = `${RUN}P`
const COMPANY = `${RUN}測試公司`

export interface MainFlow {
  assessmentId: string
  plantId: string
  companyId: string
}

/**
 * Builds the company, plant, route and 年度作業, as service_role except the launch, which 甲 does. Writes each id
 * into `flow` as soon as it exists, so the teardown can remove a half-built setup.
 */
export async function setUpMainFlow(flow: Partial<MainFlow>): Promise<void> {
  await requirePostgrest()
  // The exchange creates each person's employee_ref row, which promoting 甲 needs.
  for (const p of Object.values(PEOPLE)) await sessionFor(p)
  await promoteToAuditAdmin(PEOPLE.auditAdmin.empId)

  const companyId = (flow.companyId = (await insertRow('company', { name: COMPANY })).id)
  const plantId = (flow.plantId = (await insertRow('plant', { factory_code: FACTORY, name: PLANT_NAME, company_id: companyId })).id)
  // FQ-02 只適用福清（Q111）；發起只發適用的範本，所以測試期間借給測試廠區，收尾時還回去。
  const template = { id: await borrowFq02(FACTORY) }
  const units = ok(await admin.from('assessing_unit').select('id, name').in('name', [...UNITS]))
  const unitId = new Map(units.map((u) => [u.name as string, u.id as string]))

  await makeRoute(
    template.id,
    plantId,
    STEPS.map((s) => ({
      name: s.name, group: s.group, signer: s.signer.empId,
      unitId: s.unit ? unitId.get(s.unit)! : null, branchUnitId: s.branch ? unitId.get(s.branch)! : null,
    })),
  )

  const launched = await launchAssigned(await loginAs(PEOPLE.auditAdmin.empId, PEOPLE.auditAdmin.name), {
    p_year: YEAR,
    p_due_date: '2099-12-31',
    p_combos: [{ template_id: template.id, plant_id: plantId }],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  flow.assessmentId = ok(await admin.from('assessment').select('id').eq('cycle_id', launched.data.cycle_id).single()).id
}

export async function tearDownMainFlow(flow: Partial<MainFlow>): Promise<void> {
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  if (flow.plantId) await admin.from('approval_route').delete().eq('plant_id', flow.plantId)
  await releaseFq02(FACTORY)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (flow.companyId) await admin.from('company').delete().eq('id', flow.companyId)
}

/**
 * The real exchange for `p` (fake OMS), as the session the login page would have stored. The token lives 10
 * minutes and the app renews it 5 minutes before it ends (which would fail: there is no OMS behind it), so a
 * person's turn must stay under 5 minutes; actAs starts every turn with a fresh one.
 */
async function sessionFor(p: Person): Promise<StoredSession> {
  return sessionOf(await exchangeAs(p.empId, p.name), p.empId)
}

function sessionOf(result: Awaited<ReturnType<typeof exchangeAs>>, who: string): StoredSession {
  if (!result.ok) throw new Error(`exchange failed for ${who}: ${result.error}`)
  return {
    oms: { accessToken: '', refreshToken: '', userId: '', email: '' },
    csa: { token: result.csaToken, expiresAt: result.expiresAt },
    employee: result.employee,
    issuedAt: new Date().toISOString(),
    devLogin: true,
  }
}

/** Switch the tab to `p`: store a fresh session and load the home page, the way logging in would land there. */
export async function actAs(page: Page, p: Person): Promise<void> {
  await signIn(page, await sessionFor(p))
}

/** Switch the tab to the 管理員帳號 (#161), as `actAs` does for an employee. */
export async function actAsAdminAccount(page: Page): Promise<void> {
  await signIn(page, sessionOf(await exchangeAsAdminAccount(), 'the 管理員帳號'))
}

async function signIn(page: Page, session: StoredSession): Promise<void> {
  if (!page.url().startsWith('http')) await page.goto('/login')
  // Same key as src/auth/sessionStore.ts.
  await page.evaluate((s) => sessionStorage.setItem('csa.session', s), JSON.stringify(session))
  await page.goto('/')
}

export interface SignoffRow {
  serial_no: number
  action: 'submit' | 'approve' | 'return'
  voided_at: string | null
  signer_name: string | null
  step_position: number
}

/** The whole 簽核歷程 as stored, for checking the PDF against. */
export async function signoffsOf(assessmentId: string): Promise<SignoffRow[]> {
  return ok(
    await admin
      .from('assessment_signoff')
      .select('serial_no, action, voided_at, signer_name, step_position')
      .eq('assessment_id', assessmentId)
      .order('serial_no'),
  ) as SignoffRow[]
}
