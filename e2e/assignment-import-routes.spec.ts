import { expect, test, type Page, type Route } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import readXlsxFile from 'read-excel-file/node'
import writeXlsxFile from 'write-excel-file/node'
import { admin, insertRow, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest } from '../tests/db/helpers'
import { actAs, type Person } from './support/mainFlow'

// 分派表匯入到簽核流程（Q147 (6)，#224），對真實的 Postgres＋PostgREST：廠區管理員在分派填寫人的「下次發出」下載本廠流程的
// 分派表，填好工號再匯入 → 流程上的人寫好、每一關一筆異動紀錄、發起檢查通過；稽核主管在下次發出也能匯入。只有 OMS 比對
// （/csa/exchange/oms-match）在瀏覽器裡換成假的：每個工號都對得上。沒有發起年度，所以不用年度區間。

const RUN = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase()
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
  for (const p of EVERYONE) await loginAs(p.empId, p.name)
  await promoteToAuditAdmin(PEOPLE.chief.empId)
  ok(await admin.from('access_allowlist').insert([{ emp_id: PEOPLE.chief.empId }, { emp_id: PEOPLE.coordinator.empId }]))
  chief = await loginAs(PEOPLE.chief.empId, PEOPLE.chief.name)

  ID.company = (await insertRow('company', { name: `${RUN}公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
  ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant, p_emp_id: PEOPLE.coordinator.empId }))
  ID.template = await makeTemplate(`${RUN}T`, 'control_activity', FACTORY, [['第一章', [['要點一', ID.unit]]]])
  ID.route = await makeRoute(ID.template, ID.plant, [
    { name: `自行檢查人員－${UNIT}`, group: 'plant', signer: '', unitId: ID.unit },
    { name: `部門主管－${UNIT}`, group: 'plant', signer: '', unitId: null, branchUnitId: ID.unit },
    { name: '廠區經理人', group: 'plant', signer: '', unitId: null },
    { name: '台北稽核人員', group: 'audit_review', signer: PEOPLE.chief.empId, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: PEOPLE.chief.empId, unitId: null },
  ])
})

test.afterAll(async () => {
  if (ID.plant) await admin.from('approval_route').delete().eq('plant_id', ID.plant)
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
  if (ID.plant) await admin.from('plant_coordinator').delete().eq('plant_id', ID.plant)
  for (const p of EVERYONE) await admin.from('access_allowlist').delete().eq('emp_id', p.empId)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
})

/** OMS's channel as the CSA backend would answer the 分派表's 比對: everyone is 在職 at this plant, with CSA enabled. */
async function fakeOmsMatch(page: Page) {
  await page.route('**/csa/exchange/oms-match', (r: Route) => {
    const { emp_ids } = r.request().postDataJSON() as { emp_ids: string[] }
    return r.fulfill({ json: { results: emp_ids.map((id) => ({ emp_id: id, status: 'matched', csa: true })), csa_required: false } })
  })
}

const routeSigners = async () =>
  Object.fromEntries(
    (ok(await admin.from('route_step').select('name,signer_emp_id').eq('route_id', ID.route!)) as { name: string; signer_emp_id: string | null }[]).map((s) => [
      s.name,
      s.signer_emp_id,
    ]),
  )

/** Downloads 下次發出's 分派表, writes the 工號 into row 4 (the one 範本), and uploads it. */
async function importSheet(page: Page, people: { self?: string; chief?: string; manager?: string }) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('assignment-download').click()])
  const sheets = await readXlsxFile(readFileSync(await file.path()))
  const main = sheets[0]!.data
  // A 編號, B 名稱, C/D the unit's 自行檢查人員／部門主管, E 廠區經理人.
  expect(main[1]).toEqual(['自評表編號', '自評表名稱', UNIT, null, '廠區經理人'])
  const row = main[3]!
  if (people.self) row[2] = people.self
  if (people.chief) row[3] = people.chief
  if (people.manager) row[4] = people.manager
  const blob = await writeXlsxFile(
    sheets.map((s) => ({ sheet: s.sheet, data: s.data.map((r) => r.map((value) => (value === null ? null : { value: value as string | number | boolean }))) })),
  ).toBuffer()
  await page.getByTestId('assignment-import-file').setInputFiles({ name: file.suggestedFilename(), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: blob })
  await expect(page.getByTestId('import-check-4')).toHaveAttribute('data-mark', 'ok')
  await page.getByTestId('import-confirm').click()
  await expect(page.getByTestId('assignment-imported')).toBeVisible()
}

test('廠區管理員下載下次發出的分派表、填好匯入：寫到流程，每一關一筆異動紀錄，發起檢查通過；稽核主管也能匯入換人', async ({ page }) => {
  await fakeOmsMatch(page)

  await actAs(page, PEOPLE.coordinator)
  await page.goto(`/admin/assignment?plant=${FACTORY}&year=next`)
  await expect(page.getByTestId('assignment-year')).toHaveText('下次發出')
  await expect(page.getByTestId(`assignment-form-${RUN}T`)).toContainText('差 3 關')
  await importSheet(page, { self: PEOPLE.checker.empId, chief: PEOPLE.manager.empId, manager: PEOPLE.plantManager.empId.toLowerCase() })
  await expect(page.getByTestId('assignment-imported')).toContainText('寫入 3 格')

  expect(await routeSigners()).toMatchObject({
    [`自行檢查人員－${UNIT}`]: PEOPLE.checker.empId, [`部門主管－${UNIT}`]: PEOPLE.manager.empId, 廠區經理人: PEOPLE.plantManager.empId,
  })
  // 畫面跟著重新整理：這條流程分派好了。
  await expect(page.getByTestId(`assignment-form-${RUN}T`)).toContainText('已分派')
  const log = ok(await chief.from('access_change_log').select('actor_emp_id,target_emp_id,action')
    .in('target_emp_id', [PEOPLE.checker.empId, PEOPLE.manager.empId, PEOPLE.plantManager.empId]).order('id')) as { actor_emp_id: string; action: string }[]
  expect(log.map((l) => [l.actor_emp_id, l.action])).toEqual(Array(3).fill([PEOPLE.coordinator.empId, 'route_step_assigned']))
  const route = ok(await chief.from('approval_route').select('launch_check').eq('id', ID.route!).single()) as { launch_check: { ready: boolean } }
  expect(route.launch_check.ready).toBe(true)

  // 稽核主管在下次發出也能匯入：換掉部門主管。
  await actAs(page, PEOPLE.chief)
  await page.goto(`/admin/assignment?plant=${FACTORY}&year=next`)
  await importSheet(page, { chief: PEOPLE.newcomer.empId })
  await expect(page.getByTestId('assignment-imported')).toContainText('寫入 1 格')
  expect((await routeSigners())[`部門主管－${UNIT}`]).toBe(PEOPLE.newcomer.empId)
})
