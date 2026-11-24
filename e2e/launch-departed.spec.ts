import { expect, test, type Page, type Request, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 發出前的離職檢查 (Q147 (4), #222): on launch the page asks OMS's channel (the CSA backend's /oms-people) about the people
// the chosen routes would put on the 自評表, once, and sends who is not 在職; with no answer from OMS it launches all the
// same, unchecked, and says so. Every /rest/v1 answer is made up here; what the database does with the list is in
// tests/db/launch_departed.rls.test.ts.

const CANDIDATE = {
  template_id: 't1', template_code: 'FQ-01.1', template_name: '銷售及收款循環',
  plant_id: 'p1', factory_code: 'FQ', plant_name: '福清富群', route_id: 'r1', step_count: 8, problem: null,
  launch_check: { ready: true, no_steps: false, no_merge_steps: false, missing_units: [], unused_units: [], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [] },
  launched_years: [],
}

const DEPARTED = {
  template_id: 't1', template_code: 'FQ-01.1', template_name: '銷售及收款循環', plant_id: 'p1', factory_code: 'FQ', plant_name: '福清富群',
  step_id: 's1', step: '部門主管', branch_unit_name: '財務部', link: null, emp_id: 'FQ9001', name: '許文彬',
}

interface Calls {
  launches: Request[]
  asked: string[][]
}

const LINKED_DEPARTED = { ...DEPARTED, step_id: 's8', step: '台北稽核人員', branch_unit_name: null, link: 'taipei_auditor', emp_id: 'SS0001', name: '王小明' }

async function mockApi(page: Page, { omsDown = false, refuse = false, candidates = [CANDIDATE] as object[] } = {}): Promise<Calls> {
  const calls: Calls = { launches: [], asked: [] }
  await page.route('**/rest/v1/**', async (r: Route) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/employee_ref')) return r.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/rpc/launch_candidates')) return r.fulfill({ json: candidates })
    if (path.endsWith('/rpc/launch_signers')) return r.fulfill({ json: ['FQ1021', 'FQ9001', 'FQ9002'] })
    if (path.endsWith('/rpc/launch_annual_cycle')) {
      calls.launches.push(request)
      if (refuse) return r.fulfill({ json: { ok: false, error: 'departed_signers', departed: [DEPARTED, LINKED_DEPARTED] } })
      return r.fulfill({ json: { ok: true, cycle_id: 'c1', top_up: false, due_date: '2099-12-31', assessments: 1, checked: !omsDown } })
    }
    return r.fulfill({ json: [] })
  })
  await page.route('**/csa/exchange/oms-people', (r: Route) => {
    if (omsDown) return r.fulfill({ status: 502, json: { error: 'oms_rate_limited' } })
    const { emp_ids } = r.request().postDataJSON() as { emp_ids: string[] }
    calls.asked.push(emp_ids)
    const status = (id: string) => (id === 'FQ1021' ? 'active' : id === 'FQ9001' ? 'departed' : 'on_leave')
    return r.fulfill({
      json: { people: emp_ids.map((id) => ({ asked: id, emp_id: id, status: status(id), name: null, factory_code: null, csa: false, other_plant: false })) },
    })
  })
  return calls
}

async function launch(page: Page) {
  await page.goto('/admin/launch')
  await page.locator('[data-testid="launch-due"] input, input[data-testid="launch-due"]').fill('2099-12-31')
  await page.keyboard.press('Enter')
  await page.getByTestId('launch-submit').click()
  await page.getByRole('dialog').getByRole('button', { name: '發起', exact: true }).click()
}

test('launching asks OMS about the people on the routes once and tells the database who is not 在職', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const calls = await mockApi(page)
  await launch(page)

  const outcome = page.getByTestId('launch-outcome')
  await expect(outcome).toContainText('簽核人照簽核流程上分派的人')
  await expect(outcome).toHaveClass(/ant-alert-success/)
  expect(calls.asked).toEqual([['FQ1021', 'FQ9001', 'FQ9002']])
  expect(calls.launches).toHaveLength(1)
  expect(calls.launches[0]!.postDataJSON()).toMatchObject({ p_due_date: '2099-12-31', p_departed: ['FQ9001', 'FQ9002'], p_checked: true })
})

test('a refusal names who on which route has left, and where to replace them', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page, { refuse: true })
  await launch(page)

  await expect(page.getByTestId('launch-outcome')).toContainText('簽核流程上有 2 位已不在職，沒有發起。請先換人再發出：')
  const [onRoute, linked] = [page.getByTestId('launch-departed').getByRole('listitem').nth(0), page.getByTestId('launch-departed').getByRole('listitem').nth(1)]
  await expect(onRoute).toContainText('FQ-01.1 × FQ 福清富群 財務部・部門主管：許文彬（FQ9001）')
  await expect(onRoute.getByRole('link', { name: '到分派填寫人換人 →' })).toHaveAttribute('href', '/admin/assignment?plant=FQ&year=next')
  await expect(linked).toContainText('FQ-01.1 × FQ 福清富群 台北稽核人員：王小明（SS0001）（連動關卡）')
  await expect(linked.getByRole('link', { name: '到權限管理換人 →' })).toHaveAttribute('href', '/admin/access')
})

test('a route still waiting for 分派 cannot be ticked and leads to that plant’s 下次發出 (Q147)', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const waiting = {
    ...CANDIDATE, template_id: 't2', template_code: 'FQ-02', template_name: '採購及付款循環', problem: 'not_ready',
    launch_check: { ...CANDIDATE.launch_check, ready: false, unassigned_steps: [{ id: 's9', name: '部門主管', branch_unit_id: 'u', branch_unit_name: '品保單位' }] },
  }
  await mockApi(page, { candidates: [CANDIDATE, waiting] })
  await page.goto('/admin/launch')

  const row = page.getByTestId('launch-table').locator('tr', { hasText: 'FQ-02' })
  const cell = row.getByTestId('candidate-unassigned')
  await expect(cell).toContainText('還沒分派')
  await expect(cell).not.toContainText('品保單位・部門主管') // the tag and the link say it; no list of 關卡
  await expect(cell.getByRole('link', { name: '到分派填寫人 →' })).toHaveAttribute('href', '/admin/assignment?plant=FQ&year=next')
  await expect(page.getByTestId('launch-blocked')).toContainText('還不能發起（沒有簽核流程、流程沒通過發起檢查或還沒分派好）')
})

test('with OMS down it launches all the same, unchecked, and says so as a warning', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const calls = await mockApi(page, { omsDown: true })
  await launch(page)

  const outcome = page.getByTestId('launch-outcome')
  await expect(outcome).toContainText('連不上 OMS，沒有檢查流程上的人是否已離職')
  await expect(outcome).toHaveClass(/ant-alert-warning/)
  expect(calls.launches).toHaveLength(1)
  expect(calls.launches[0]!.postDataJSON()).toMatchObject({ p_due_date: '2099-12-31', p_departed: [], p_checked: false })
})
