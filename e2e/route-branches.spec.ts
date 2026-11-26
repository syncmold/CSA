import { expect, test, type Page, type Request, type Route } from '@playwright/test'
import { listedEmpIds, signInAsAuditAdmin } from './support/mockSession'

// 簽核流程編輯器的分流 (#98, Q116 (2)): a card per 自評單位 the template uses, 多加一關, a unit the template added
// later, and the 匯流後 steps. Every /rest/v1 answer is made up here, so no database or sign-in is
// needed; the rules themselves are the database's (tests/db/route_branches.rls.test.ts). The specs check what the page
// shows and what it sends.

const ROUTE_ID = '00000000-0000-0000-0000-0000000000r1'
const U = { sales: 'u-sales', material: 'u-material', quality: 'u-quality', finance: 'u-finance', works: 'u-works' }
const UNIT_NAMES: Record<string, string> = { [U.sales]: '業務', [U.material]: '資材', [U.quality]: '品保', [U.finance]: '財務', [U.works]: '工務' }
const SIGNER = { emp_id: 'ZZ0002', name: '測試主管', factory_code: 'SY' }

const step = (position: number, name: string, branch: string | null, editable = false, group = 'plant') => ({
  id: `s${position}`, position, name, step_group: group, signer_emp_id: group === 'plant' ? null : SIGNER.emp_id,
  editable_unit_id: editable ? branch : null, branch_unit_id: branch, assessing_unit: editable && branch ? { name: UNIT_NAMES[branch] } : null,
})

const STEPS = [
  ...[U.sales, U.material, U.quality, U.finance].flatMap((u, i) => [
    step(i * 2 + 1, `自行檢查人員－${UNIT_NAMES[u]}`, u, true),
    step(i * 2 + 2, `部門主管－${UNIT_NAMES[u]}`, u),
  ]),
  step(9, '廠區經理人', null),
  step(10, '子公司擔當稽核', null, false, 'audit_review'),
  step(11, '台北稽核人員', null, false, 'audit_review'),
  step(12, '稽核主管', null, false, 'audit_review'),
]

/** The same route, but 台北稽核人員 and 稽核主管 carry their 連動標記 (#189), as the database backfills them. */
const LINKED_STEPS = STEPS.map((s) =>
  s.name === '台北稽核人員' ? { ...s, link: 'taipei_auditor', linked_now: true } : s.name === '稽核主管' ? { ...s, link: 'audit_chief', linked_now: true } : s,
)

/** An option of the open 連動 select (antd draws the whole list in the popup, but only the first ones in its a11y list). */
const linkOption = (page: Page, text: string) => page.locator('.ant-select-item-option', { hasText: text })

const unit = (id: string, over: object = {}) => ({ id, name: UNIT_NAMES[id], in_template: true, ...over })
const READY = { ready: true, no_steps: false, no_merge_steps: false, missing_units: [], unused_units: [], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [] }

function routeWith(units: object[], check: object) {
  return {
    id: ROUTE_ID, updated_at: '2026-11-03T02:00:00+00:00', launch_check: check,
    template: { id: 't1', code: 'SY-01', name: '銷售及收款循環', component: 'control_activities' },
    plant: { id: 'p1', factory_code: 'SY', name: '測試廠' },
    branch_units: units,
    route_step: STEPS,
  }
}

/** Answers the page's reads with `route` and records every write. */
async function mockApi(page: Page, route: object, writes: Request[] = []) {
  await page.route('**/rest/v1/**', async (r: Route) => {
    const path = new URL(r.request().url()).pathname
    // 誰在放行名單上（Q150）：查到的人都在；這是讀，不算寫入。
    if (path.endsWith('/rpc/listed_emp_ids')) return r.fulfill({ json: listedEmpIds(r.request().postDataJSON()) })
    if (r.request().method() !== 'GET') writes.push(r.request())
    if (path.endsWith('/employee_ref')) return r.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/rpc/visible_people')) return r.fulfill({ json: [SIGNER] })
    if (path.endsWith('/approval_route')) return r.fulfill({ json: [route] })
    if (r.request().method() !== 'GET') return r.fulfill({ status: 204 })
    return r.fulfill({ json: [] })
  })
  // 用工號查人 (#218): the CSA backend's answer from OMS; only SIGNER's complete 工號 is someone.
  await page.route('**/csa/exchange/oms-people', (r: Route) => {
    const { emp_ids } = r.request().postDataJSON() as { emp_ids: string[] }
    const people = emp_ids.map((id) =>
      id === SIGNER.emp_id
        ? { asked: id, ...SIGNER, status: 'active', csa: true, other_plant: false }
        : { asked: id, emp_id: id, status: 'not_found', name: null, factory_code: null, csa: false, other_plant: false },
    )
    return r.fulfill({ json: { people } })
  })
}

test('four units show four 分流, a 課長 goes into 財務 before its 部門主管', async ({ page }) => {
  const writes: Request[] = []
  await signInAsAuditAdmin(page)
  await mockApi(page, routeWith([unit(U.sales), unit(U.material), unit(U.quality), unit(U.finance)], READY), writes)
  await page.goto(`/admin/flows/${ROUTE_ID}/edit`)

  const branches = page.getByTestId('route-branches')
  await expect(branches.locator(':scope > *')).toHaveCount(4)
  await expect(page.getByTestId('branch-財務').getByTestId('branch-step')).toHaveText([/自行檢查人員－財務/, /部門主管－財務/])
  await expect(page.getByTestId('merge-band')).toHaveText('業務、資材、品保、財務 4 個單位都核准後匯流')
  // 匯流後: numbered among themselves
  await expect(page.getByTestId('route-steps').locator('tbody tr.ant-table-row')).toHaveCount(4)
  await expect(page.getByTestId('route-steps').locator('tbody tr.ant-table-row').first()).toContainText('1廠區經理人')
  // 廠區端還沒分派（Q147）：說還沒分派、到分派填寫人去分派，這裡不選人；稽核室照舊
  await expect(branches).not.toContainText(SIGNER.name)
  await expect(page.getByTestId('branch-財務').getByTestId('branch-step-signer').first()).toHaveText(/還沒指派/)
  const manager = page.getByTestId('route-steps').locator('tbody tr.ant-table-row').first()
  await expect(manager.getByTestId('step-unassigned')).toContainText('還沒指派')
  await expect(manager.getByTestId('to-assignment')).toHaveAttribute('href', '/admin/assignment?plant=SY&year=next')
  await expect(page.getByTestId('route-steps').locator('tbody tr.ant-table-row').last()).toContainText(SIGNER.name)

  await page.getByTestId('branch-財務').getByTestId('add-branch-step').click()
  const modal = page.getByTestId('branch-step-modal')
  await expect(modal.getByTestId('step-after')).toContainText('「自行檢查人員－財務」之後')
  await modal.getByTestId('step-name').fill('課長')
  await expect(modal.getByTestId('signer-select')).toHaveCount(0)
  await modal.getByRole('button', { name: /儲\s*存/ }).click()
  await expect(page.getByRole('dialog', { name: '財務分流：多加一關' })).toBeHidden()
  const insert = writes.find((w) => w.url().endsWith('/rpc/insert_route_step'))!
  expect(insert.postDataJSON()).toMatchObject({ p_name: '課長', p_branch_unit_id: U.finance, p_before_position: 8, p_editable_unit_id: null, p_step_group: 'plant', p_signer_emp_id: null })
})

test('a 廠區端 step 分派 on 分派填寫人 shows who it is, and renaming it keeps them (Q147)', async ({ page }) => {
  const writes: Request[] = []
  await signInAsAuditAdmin(page)
  const route = routeWith([unit(U.sales), unit(U.material), unit(U.quality), unit(U.finance)], READY)
  route.route_step = STEPS.map((s) => (s.name === '部門主管－財務' || s.name === '廠區經理人' ? { ...s, signer_emp_id: SIGNER.emp_id } : s))
  await mockApi(page, route, writes)
  await page.goto(`/admin/flows/${ROUTE_ID}/edit`)

  const finance = page.getByTestId('branch-財務').getByTestId('branch-step')
  await expect(finance.nth(1).getByTestId('branch-step-signer')).toHaveText('測試主管（ZZ0002，SY）')
  await expect(page.getByTestId('route-steps').locator('tbody tr.ant-table-row').first()).toContainText('測試主管（ZZ0002，SY）')

  await finance.nth(1).getByRole('button', { name: '修改' }).click()
  const modal = page.getByTestId('branch-step-modal')
  await modal.getByTestId('step-name').fill('部門經理－財務')
  await modal.getByRole('button', { name: /儲\s*存/ }).click()
  await expect.poll(() => writes.find((w) => w.method() === 'PATCH')?.postDataJSON()).toMatchObject({ name: '部門經理－財務', signer_emp_id: SIGNER.emp_id })
})

test('a unit the template added later: what the cards say, and the 發起檢查 names the unit', async ({ page }) => {
  const writes: Request[] = []
  await signInAsAuditAdmin(page)
  const check = { ...READY, ready: false, missing_units: [{ id: U.works, name: '工務' }] }
  await mockApi(page, routeWith([unit(U.sales), unit(U.material), unit(U.quality), unit(U.finance), unit(U.works)], check), writes)
  await page.goto(`/admin/flows/${ROUTE_ID}/edit`)

  await expect(page.getByTestId('branch-工務')).toContainText('還沒設定')
  await expect(page.getByTestId('merge-band')).toHaveText('業務、資材、品保、財務、工務 5 個單位都核准後匯流')
  // No 啟用 to press (Q137 (6)): the 發起檢查 box itself says the 年度發起 cannot tick this combination, and why.
  const checkBox = page.getByTestId('route-check')
  await expect(checkBox).toContainText('發起檢查尚未通過：在「自評表發起」不能勾選這個組合')
  await expect(checkBox).toContainText('下列自評單位還沒有分流：工務')
  await expect(page.getByTestId('activate-route')).toHaveCount(0)

  // 建立工務的分流：不用選人，自行檢查人員與部門主管一次寫入
  await page.getByTestId('branch-工務').getByTestId('set-up-branch').click()
  await expect.poll(() => writes.find((w) => w.url().endsWith('/rpc/add_route_branch'))?.postDataJSON()).toEqual({ p_route_id: ROUTE_ID, p_unit_id: U.works })
})

test('連動關卡 (#189): read-only with its 簽核人 shown as automatic, and both are taken in the add dialog', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const route = { ...routeWith([unit(U.sales), unit(U.material), unit(U.quality), unit(U.finance)], READY), route_step: LINKED_STEPS }
  await mockApi(page, route)
  await page.goto(`/admin/flows/${ROUTE_ID}/edit`)

  const rows = page.getByTestId('route-steps').locator('tbody tr.ant-table-row')
  const taipei = rows.filter({ hasText: '台北稽核人員' })
  const chief = rows.filter({ hasText: '稽核主管' })
  // 現在的簽核人，接著是它跟著誰（#189 使用者驗收：要看得到是誰）
  await expect(taipei.getByTestId('step-linked-signer')).toHaveText(`${SIGNER.name}（${SIGNER.emp_id}，${SIGNER.factory_code}）＝廠區管理員（自動）`)
  await expect(chief.getByTestId('step-linked-signer')).toHaveText(`${SIGNER.name}（${SIGNER.emp_id}，${SIGNER.factory_code}）＝稽核主管（自動）`)
  // No 修改／刪除 on a 連動關卡; the 子公司擔當稽核 beside them is still editable
  await expect(taipei.getByRole('button', { name: '修改關卡' })).toHaveCount(0)
  await expect(taipei.getByRole('button', { name: '刪除' })).toHaveCount(0)
  await expect(chief.getByRole('button', { name: '修改關卡' })).toHaveCount(0)
  await expect(rows.filter({ hasText: '子公司擔當稽核' }).getByRole('button', { name: '修改關卡' })).toHaveCount(1)

  // A route has one of each, so the add dialog offers neither
  await page.getByTestId('add-step').click()
  const modal = page.getByTestId('route-step-modal')
  await modal.getByText('稽核室覆核', { exact: true }).click()
  await modal.getByTestId('step-link').click()
  await expect(linkOption(page, '台北稽核人員')).toHaveClass(/ant-select-item-option-disabled/)
  await expect(linkOption(page, '簽核人＝稽核主管')).toHaveClass(/ant-select-item-option-disabled/)
})

test('連動關卡 (#189): a route lacking one says so, and choosing 連動 names the new step and sends the mark', async ({ page }) => {
  const writes: Request[] = []
  await signInAsAuditAdmin(page)
  const check = { ...READY, ready: false, missing_links: ['taipei_auditor'] }
  const route = {
    ...routeWith([unit(U.sales), unit(U.material), unit(U.quality), unit(U.finance)], check),
    route_step: LINKED_STEPS.filter((s) => s.name !== '台北稽核人員'),
  }
  await mockApi(page, route, writes)
  await page.goto(`/admin/flows/${ROUTE_ID}/edit`)
  await expect(page.getByTestId('route-check')).toContainText('稽核室覆核還缺連動關卡：台北稽核人員')

  await page.getByTestId('add-step').click()
  const modal = page.getByTestId('route-step-modal')
  await modal.getByText('稽核室覆核', { exact: true }).click()
  await modal.getByTestId('step-link').click()
  await expect(linkOption(page, '簽核人＝稽核主管')).toHaveClass(/ant-select-item-option-disabled/)
  // 一般的稽核室關卡預設插在稽核主管之前（稽核主管要是最後一關）
  await expect(modal.getByTestId('step-position')).toContainText('「稽核主管」之前')
  await linkOption(page, '台北稽核人員').click()
  await expect(modal.getByTestId('step-name')).toHaveValue('台北稽核人員')
  await expect(modal.getByTestId('step-name')).toBeDisabled()
  // 改回不連動：連動關卡的名稱一起拿掉
  await modal.getByTestId('step-link').click()
  await linkOption(page, '不連動').click()
  await expect(modal.getByTestId('step-name')).toHaveValue('')
  await expect(modal.getByTestId('step-name')).toBeEnabled()
  await modal.getByTestId('step-link').click()
  await linkOption(page, '台北稽核人員').click()

  await modal.getByRole('combobox', { name: '簽核人' }).fill('ZZ0002')
  await page.locator('.ant-select-item-option', { hasText: SIGNER.name }).click()
  await modal.getByRole('button', { name: /儲\s*存/ }).click()
  const insert = writes.find((w) => w.url().endsWith('/rpc/insert_route_step'))!
  expect(insert.postDataJSON()).toMatchObject({ p_name: '台北稽核人員', p_step_group: 'audit_review', p_signer_emp_id: SIGNER.emp_id, p_link: 'taipei_auditor', p_before_position: 12 })
})

test('連動關卡不連動時 (#190)：說明原因、只能修改簽核人，不能改名、改群組或刪除', async ({ page }) => {
  const writes: Request[] = []
  await signInAsAuditAdmin(page)
  // 這一廠的廠區管理員不是稽核人員或稽核主管：台北稽核人員不連動；稽核主管照舊連動
  const steps = LINKED_STEPS.map((s) => (s.name === '台北稽核人員' ? { ...s, linked_now: false } : s))
  const route = { ...routeWith([unit(U.sales), unit(U.material), unit(U.quality), unit(U.finance)], READY), route_step: steps }
  await mockApi(page, route, writes)
  await page.goto(`/admin/flows/${ROUTE_ID}/edit`)

  const rows = page.getByTestId('route-steps').locator('tbody tr.ant-table-row')
  const taipei = rows.filter({ hasText: '台北稽核人員' })
  await expect(taipei.getByTestId('step-linked-signer')).toHaveText(`${SIGNER.name}（${SIGNER.emp_id}，${SIGNER.factory_code}）（不連動：廠區管理員不是稽核人員或稽核主管）`)
  await expect(taipei.getByRole('button', { name: '修改關卡' })).toHaveCount(1)
  await expect(taipei.getByRole('button', { name: '刪除' })).toHaveCount(0)
  await expect(rows.filter({ hasText: '稽核主管' }).getByTestId('step-linked-action')).toHaveText('自動')

  await taipei.getByRole('button', { name: '修改關卡' }).click()
  const modal = page.getByTestId('route-step-modal')
  await expect(modal.getByTestId('step-name')).toBeDisabled()
  await expect(modal.getByRole('radio', { name: '廠區端' })).toBeDisabled()
  await expect(modal).toContainText('改由稽核人員或稽核主管擔任廠區管理員後，會自動換成他')
  await modal.getByRole('combobox', { name: '簽核人' }).fill('ZZ0002')
  await page.locator('.ant-select-item-option', { hasText: SIGNER.name }).click()
  await modal.getByRole('button', { name: /儲\s*存/ }).click()
  await expect.poll(() => writes.find((w) => w.method() === 'PATCH')?.postDataJSON()).toEqual({
    name: '台北稽核人員', step_group: 'audit_review', signer_emp_id: SIGNER.emp_id, editable_unit_id: null,
  })
})
