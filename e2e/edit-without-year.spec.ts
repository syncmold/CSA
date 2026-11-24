import { expect, test, type Page, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 範本管理與簽核流程不分年度 (Q137 (2), #200): no 年度 menu and nothing locked; both pages always edit the template or
// route itself, and a line under the title says the edits go to the next launch and top-ups, with past years in
// 自評表紀錄. Every /rest/v1 answer is made up here: 2025 and 2026 were launched, which once locked those years.

const TEMPLATE = '00000000-0000-0000-0000-000000000001'
const ROUTE_ID = '00000000-0000-0000-0000-0000000000a1'
const PLANT = '00000000-0000-0000-0000-0000000000b1'

const SUMMARY = {
  id: TEMPLATE, code: 'FQ-02', name: '採購及付款循環', layout: 'control_activity', component: 'control_activities',
  status: 'active', all_plants: false, in_use: true, control_point_count: 1, content_fingerprint: 'a', template_plant: [{ factory_code: 'FQ' }],
}
const TREE = {
  ...SUMMARY,
  template_section: [
    { id: 's1', position: 1, level: 1, code: null, name: '請購作業', control_point: [{ id: 'p1', position: 1, code: null, text: '請購是否經權責主管核准？', control_point_unit: [] }] },
  ],
}
const CHECK = { ready: true, no_steps: false, no_merge_steps: false, missing_units: [], unused_units: [], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [] }
const HEAD = {
  id: ROUTE_ID, updated_at: '2026-11-01T05:00:00+00:00', launch_check: CHECK,
  template: { id: TEMPLATE, code: 'FQ-02', name: '採購及付款循環', component: 'control_activities' },
  plant: { id: PLANT, factory_code: 'FQ', name: '福清富群' },
}
const ROUTE_TREE = {
  ...HEAD,
  branch_units: [{ id: 'u1', name: '資材單位', used: true }],
  route_step: [
    { id: 'r1', position: 1, name: '自行檢查人員－資材', step_group: 'plant', signer_emp_id: null, editable_unit_id: 'u1', branch_unit_id: 'u1', assessing_unit: { name: '資材單位' } },
    { id: 'r2', position: 2, name: '稽核主管', step_group: 'audit_review', signer_emp_id: 'ZZ0001', editable_unit_id: null, branch_unit_id: null, assessing_unit: null },
  ],
}

async function mockApi(page: Page) {
  await page.route('**/rest/v1/**', async (route: Route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const single = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object')
    const select = url.searchParams.get('select') ?? ''
    if (path.endsWith('/employee_ref')) return route.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/questionnaire_template')) return route.fulfill({ json: select.includes('template_section') ? [TREE] : [SUMMARY] })
    if (path.endsWith('/plant')) return route.fulfill({ json: [{ id: PLANT, factory_code: 'FQ', name: '福清富群' }] })
    if (path.endsWith('/approval_route')) {
      if (select.includes('branch_units')) return route.fulfill({ json: single ? ROUTE_TREE : [ROUTE_TREE] })
      return route.fulfill({ json: [{ ...HEAD, route_step: [{ count: 2 }] }] })
    }
    if (path.endsWith('/annual_cycle')) return route.fulfill({ json: [{ year: 2026 }, { year: 2025 }] })
    return route.fulfill({ json: single ? null : [] })
  })
}

const NOTE_TEMPLATES = '這裡改的題目會用在下一次發起與補發；已發出的自評表不受影響，往年內容請到自評表紀錄打開當年那張。'
const NOTE_ROUTES = '這裡改的簽核流程會用在下一次發起與補發；已發出的自評表不受影響，往年內容請到自評表紀錄打開當年那張。'

test('範本管理 has no 年度: the list and the template are edited directly, and the note links to 自評表紀錄', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/templates')

  await expect(page.getByTestId('next-launch-note')).toHaveText(NOTE_TEMPLATES)
  await expect(page.getByTestId('year-select')).toHaveCount(0)
  await expect(page.getByTestId('create-template')).toBeVisible()
  await expect(page.getByTestId('template-table').getByRole('link')).toHaveText(['採購及付款循環'])

  // A year in the URL, as the old links carried, changes nothing: the template itself, editable.
  await page.goto(`/admin/templates/${TEMPLATE}?year=2025`)
  await expect(page.getByTestId('template-heading')).toHaveText('FQ-02 採購及付款循環')
  await expect(page.getByTestId('next-launch-note')).toHaveText(NOTE_TEMPLATES)
  await expect(page.getByTestId('year-select')).toHaveCount(0)
  await expect(page.getByText('請購是否經權責主管核准？')).toBeVisible()
  await expect(page.getByTestId('start-editing')).toBeVisible()
  await expect(page.getByTestId('to-route')).toHaveText('看簽核流程 →')
  await expect(page.getByTestId('to-route')).toHaveAttribute('href', `/admin/flows/${ROUTE_ID}`)

  await page.getByTestId('to-records').click()
  await expect(page).toHaveURL(/\/records$/)
})

test('簽核流程 has no 年度: the list and the route are edited directly, with the same note', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/flows')

  await expect(page.getByTestId('next-launch-note')).toHaveText(NOTE_ROUTES)
  await expect(page.getByTestId('year-select')).toHaveCount(0)
  await expect(page.getByTestId('create-route')).toBeVisible()

  await page.getByTestId('route-table').getByRole('link', { name: '採購及付款循環' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/flows/${ROUTE_ID}$`))
  await expect(page.getByTestId('next-launch-note')).toHaveText(NOTE_ROUTES)
  await expect(page.getByTestId('year-select')).toHaveCount(0)
  await expect(page.getByTestId('start-editing')).toBeVisible()
  await expect(page.getByTestId('to-questions')).toHaveText('看題目 →')
  await expect(page.getByTestId('to-questions')).toHaveAttribute('href', `/admin/templates/${TEMPLATE}`)
  await expect(page.getByTestId('next-launch-note').getByRole('link', { name: '自評表紀錄' })).toHaveAttribute('href', '/records')
})
