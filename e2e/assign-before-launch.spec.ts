import { expect, test, type Page, type Route } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { admin, insertRow, listPeople, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest } from '../tests/db/helpers'
import { actAs, type Person } from './support/mainFlow'

// Q147 的完整流程（#223），對真實的 Postgres＋PostgREST：廠區管理員從首頁待辦進分派填寫人的「下次發出」，在簽核流程上
// 分派每一關 → 稽核主管發起（發起檢查通過，照抄流程上的人）→ 已發出的年度廠區管理員只看得到、不能換人；稽核主管換人，
// 同時寫回流程，下次發出跟著換。OMS 通道（/csa/exchange/oms-people）在瀏覽器裡換成假的：每個工號都在職。
// 發起走資料庫函式（年度發起頁會列出全庫的組合，畫面另有 launch-*.spec.ts）。

const RUN = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase()
/** tests/db/helpers.ts 檔尾的年度區間表：30000 是這支。 */
const YEAR = 30000 + Math.floor(Math.random() * 900)
const FACTORY = `${RUN}P`
const UNIT = `${RUN}資材`

const PEOPLE = {
  chief: { empId: `${RUN}A`, name: '測試稽核主管' },
  coordinator: { empId: `${RUN}C`, name: '測試廠區管理員' },
  checker: { empId: `${RUN}W1`, name: '測試自檢' },
  manager: { empId: `${RUN}W2`, name: '測試主管' },
  plantManager: { empId: `${RUN}W3`, name: '測試經理人' },
  newcomer: { empId: `${RUN}W4`, name: '測試接手' },
} satisfies Record<string, Person>
const EVERYONE: Person[] = Object.values(PEOPLE)

const ID: Record<string, string> = {}
let chief: SupabaseClient

test.beforeAll(async () => {
  await requirePostgrest()
  // Each person's employee_ref (and name, which the page shows) comes from logging in once.
  for (const p of EVERYONE) await loginAs(p.empId, p.name)
  await promoteToAuditAdmin(PEOPLE.chief.empId)
  // 要排進關卡的人都先在放行名單上，像系統維護員開通過（Q150：被分派不再放行，名單以外的人排不進關卡）。
  await listPeople(...EVERYONE.map((p) => p.empId))
  chief = await loginAs(PEOPLE.chief.empId, PEOPLE.chief.name)

  ID.company = (await insertRow('company', { name: `${RUN}公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
  ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant, p_emp_id: PEOPLE.coordinator.empId }))
  ID.template = await makeTemplate(`${RUN}T`, 'control_activity', FACTORY, [['第一章', [['要點一', ID.unit]]]])
  // 流程建好時廠區端都還沒有人（Q147：發出前分派）；連動關卡跟著稽核主管。
  ID.route = await makeRoute(ID.template, ID.plant, [
    { name: `自行檢查人員－${UNIT}`, group: 'plant', signer: '', unitId: ID.unit },
    { name: `部門主管－${UNIT}`, group: 'plant', signer: '', unitId: null, branchUnitId: ID.unit },
    { name: '廠區經理人', group: 'plant', signer: '', unitId: null },
    { name: '台北稽核人員', group: 'audit_review', signer: PEOPLE.chief.empId, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: PEOPLE.chief.empId, unitId: null },
  ])
})

test.afterAll(async () => {
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  if (ID.plant) await admin.from('approval_route').delete().eq('plant_id', ID.plant)
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
  if (ID.plant) await admin.from('plant_coordinator').delete().eq('plant_id', ID.plant)
  for (const p of EVERYONE) await admin.from('access_allowlist').delete().eq('emp_id', p.empId)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
})

/** OMS's channel, as the CSA backend would answer: everyone here is 在職 at this plant. */
async function fakeOms(page: Page) {
  await page.route('**/csa/exchange/oms-people', (r: Route) => {
    const { emp_ids } = r.request().postDataJSON() as { emp_ids: string[] }
    const people = emp_ids.map((asked) => {
      const p = EVERYONE.find((e) => e.empId === asked.toUpperCase())
      return p
        ? { asked, emp_id: p.empId, name: p.name, factory_code: FACTORY, status: 'active', csa: true, other_plant: false }
        : { asked, emp_id: asked, name: null, factory_code: null, status: 'not_found', csa: false, other_plant: false }
    })
    return r.fulfill({ json: { people } })
  })
}

/** Picks `p` in a 關卡's picker by their complete 工號, asked of OMS (nobody is on this plant's forms yet). */
async function pickByEmpId(page: Page, scope: ReturnType<Page['getByTestId']>, p: Person) {
  const select = scope.getByTestId('plant-employee-select')
  await select.click()
  await select.locator('input').fill(p.empId)
  await page.locator('.ant-select-dropdown').last().locator('.ant-select-item-option', { hasText: p.name }).click()
  await expect(scope).toContainText(p.name)
}

const routeSigners = async () =>
  Object.fromEntries(
    (ok(await admin.from('route_step').select('name,signer_emp_id').eq('route_id', ID.route!)) as { name: string; signer_emp_id: string | null }[]).map((s) => [
      s.name,
      s.signer_emp_id,
    ]),
  )

test('發出前分派 → 發起 → 廠區管理員不能換、稽核主管能換（Q147）', async ({ page }) => {
  await fakeOms(page)

  // 1. 廠區管理員：首頁提醒本廠還有流程沒分派，進「下次發出」把每一關都分派好。
  await actAs(page, PEOPLE.coordinator)
  // Their one step of 發出表單 is a plain entry: no heading, no number, no count (使用者 2026-11-24).
  await expect(page.getByRole('menuitem').filter({ has: page.getByTestId('nav-assignment') })).toHaveText('指派簽核人')
  await expect(page.getByTestId('nav-steps-title')).toHaveCount(0)
  await expect(page.getByTestId(/^nav-step-/)).toHaveCount(0)
  const reminder = page.getByTestId('assignment-reminder').filter({ hasText: FACTORY })
  await expect(reminder).toContainText('還有 1 條簽核流程沒指派好簽核人')
  await reminder.getByTestId('assignment-reminder-link').click()
  await expect(page).toHaveURL(/year=next/)
  await expect(page.getByTestId('assignment-year')).toHaveText('下次發出')
  await expect(page.getByTestId('assignment-choice-note')).toContainText('下次發出（發起或補發）照這裡的人發出')
  await expect(page.getByTestId('assignment-form-' + `${RUN}T`)).toContainText('差 3 關')
  // 分派表對流程：廠區管理員發出前也能下載、匯入（#224；匯入寫到流程見 assignment-import-routes.spec.ts）。
  await expect(page.getByTestId('assignment-download')).toBeVisible()
  await expect(page.getByTestId('assignment-import')).toBeVisible()

  const branch = page.getByTestId(`assign-branch-${UNIT}`)
  await expect(branch).toContainText('待指派')
  await pickByEmpId(page, branch.getByTestId('assign-step').nth(0), PEOPLE.checker)
  await pickByEmpId(page, branch.getByTestId('assign-step').nth(1), PEOPLE.manager)
  await expect(branch).toContainText('已指派')
  await pickByEmpId(page, page.getByTestId('assign-merged'), PEOPLE.plantManager)
  await expect(page.getByTestId('assignment-form-' + `${RUN}T`)).toContainText('已指派')
  // 存在流程上：發起檢查通過
  expect(await routeSigners()).toMatchObject({
    [`自行檢查人員－${UNIT}`]: PEOPLE.checker.empId, [`部門主管－${UNIT}`]: PEOPLE.manager.empId, 廠區經理人: PEOPLE.plantManager.empId,
  })
  const route = ok(await chief.from('approval_route').select('launch_check').eq('id', ID.route!).single()) as { launch_check: { ready: boolean } }
  expect(route.launch_check.ready).toBe(true)

  // 2. 稽核主管發起：照抄流程上的人。
  const launched = ok(await chief.rpc('launch_annual_cycle', {
    p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: ID.template, plant_id: ID.plant }], p_departed: [], p_checked: true,
  })) as { ok: boolean }
  expect(launched.ok).toBe(true)

  // 3. 廠區管理員看已發出的年度：只看得到人，不能換。
  await page.goto(`/admin/assignment?plant=${FACTORY}&year=${YEAR}`)
  await expect(page.getByTestId('assignment-year')).toBeVisible()
  await expect(page.getByTestId('assignment-hint')).toHaveText('發出後只有稽核主管能換人。')
  const issued = page.getByTestId(`assign-branch-${UNIT}`)
  await expect(issued.getByTestId('assign-step').nth(1)).toContainText(PEOPLE.manager.name)
  await expect(page.getByTestId('reassign')).toHaveCount(0)
  await expect(page.getByTestId('plant-employee-select')).toHaveCount(0)
  // 分派表只剩下載（#224）。
  await expect(page.getByTestId('assignment-download')).toBeVisible()
  await expect(page.getByTestId('assignment-import')).toHaveCount(0)

  // 4. 稽核主管換掉還沒簽的部門主管：自評表與流程一起換，下次發出就是新的人。
  await actAs(page, PEOPLE.chief)
  await page.goto(`/admin/assignment?plant=${FACTORY}&year=${YEAR}`)
  // The 稽核主管 has all four steps: under 發出表單, numbered in the order of use.
  await expect(page.getByTestId('nav-steps-title')).toHaveText('發出自評表')
  for (const [n, id] of ['nav-templates', 'nav-flows', 'nav-assignment', 'nav-launch'].entries()) {
    await expect(page.getByRole('menuitem').filter({ has: page.getByTestId(id) }).getByTestId(`nav-step-${n + 1}`)).toHaveText(String(n + 1))
  }
  const manager = page.getByTestId(`assign-branch-${UNIT}`).getByTestId('assign-step').nth(1)
  await manager.getByTestId('reassign').click()
  const select = manager.getByTestId('plant-employee-select')
  await select.locator('input').fill(PEOPLE.newcomer.empId)
  await page.locator('.ant-select-dropdown').last().locator('.ant-select-item-option', { hasText: PEOPLE.newcomer.name }).click()
  await expect(manager).toContainText(PEOPLE.newcomer.name)
  await expect.poll(async () => (await routeSigners())[`部門主管－${UNIT}`]).toBe(PEOPLE.newcomer.empId)

  await page.goto(`/admin/assignment?plant=${FACTORY}&year=next`)
  await expect(page.getByTestId(`assign-branch-${UNIT}`).getByTestId('assign-step').nth(1)).toContainText(PEOPLE.newcomer.name)
})
