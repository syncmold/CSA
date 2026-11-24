import { expect, test, type Page, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 稽核人員維護負責廠區的範本與流程 (Q144): sees every plant's 範本, 簽核流程 and 自評單位; the controls to change
// them appear only on what is his plants' (FQ here), a 自評單位 can only be added, and a new 範本 can only apply to his
// plants. The database decides (tests/db/audit_staff_edit.rls.test.ts); every /rest/v1 answer is made up here.

const FQ = { id: 'pl-FQ', factory_code: 'FQ', name: '福清' }
const SZ = { id: 'pl-SZ', factory_code: 'SZ', name: '兆利' }
const MINE = '00000000-0000-0000-0000-0000000000a1'
const THEIRS = '00000000-0000-0000-0000-0000000000b2'
const ROUTE_MINE = '00000000-0000-0000-0000-0000000000c1'
const ROUTE_THEIRS = '00000000-0000-0000-0000-0000000000c2'

const template = (id: string, code: string, plant: string) => ({
  id, code, name: `${code} 範本`, layout: 'control_activity', component: 'control_activities', status: 'active', all_plants: false,
  in_use: false, template_plant: [{ factory_code: plant }],
  template_section: [{ id: `s-${code}`, position: 1, level: 1, code: null, name: '一章', control_point: [] }],
})
const TEMPLATES = [template(MINE, 'FQ-02', 'FQ'), template(THEIRS, 'SZ-02', 'SZ')]
const route = (id: string, t: (typeof TEMPLATES)[number], plant: typeof FQ) => ({
  id, updated_at: '2026-11-19T05:00:00+00:00', step_count: 1,
  launch_check: { ready: true, no_steps: false, no_merge_steps: false, missing_units: [], unused_units: [], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [] },
  template: { id: t.id, code: t.code, name: t.name, component: 'control_activities' },
  plant, route_step: [], branch_units: [],
})
const ROUTES = [route(ROUTE_MINE, TEMPLATES[0]!, FQ), route(ROUTE_THEIRS, TEMPLATES[1]!, SZ)]

async function mockApi(page: Page, runs: string[]) {
  await page.route('**/rest/v1/**', async (r: Route) => {
    const url = new URL(r.request().url())
    const path = url.pathname
    const wantsTree = (url.searchParams.get('select') ?? '').includes('template_section')
    const eq = url.searchParams.get('id')?.replace('eq.', '')
    if (path.endsWith('/employee_ref')) return r.fulfill({ json: [{ audit_role: 'audit_staff', viewer_plant_ids: [] }] })
    if (path.endsWith('/plant_coordinator')) {
      if (r.request().method() === 'HEAD') return r.fulfill({ status: 200, headers: { 'content-range': runs.length ? `0-0/${runs.length}` : '*/0' }, body: '' })
      return r.fulfill({ json: runs.map((plant_id) => ({ plant_id })) })
    }
    if (path.endsWith('/plant')) return r.fulfill({ json: [FQ, SZ] })
    if (path.endsWith('/questionnaire_template')) {
      const rows = eq ? TEMPLATES.filter((t) => t.id === eq) : TEMPLATES
      return r.fulfill({ json: wantsTree && eq ? rows[0] ?? null : rows })
    }
    if (path.endsWith('/approval_route')) {
      const rows = eq ? ROUTES.filter((x) => x.id === eq) : ROUTES
      return r.fulfill({ json: eq ? rows[0] ?? null : rows })
    }
    if (path.endsWith('/assessing_unit')) return r.fulfill({ json: [{ id: 'u1', name: '業務單位' }] })
    return r.fulfill({ json: [] })
  })
}

test.beforeEach(async ({ page }) => {
  await signInAsAuditAdmin(page)
})

test('a 稽核人員 who runs FQ sees both plants’ 範本, edits only FQ’s, and may add one for FQ only', async ({ page }) => {
  await mockApi(page, [FQ.id])
  await page.goto('/')
  await expect(page.getByTestId('nav-templates')).toBeVisible()
  await expect(page.getByTestId('nav-flows')).toBeVisible()
  await expect(page.getByTestId('nav-launch')).toHaveCount(0)

  await page.goto('/admin/templates')
  await expect(page.getByTestId('create-template')).toBeVisible()
  await page.goto(`/admin/templates/${MINE}`)
  await expect(page.getByTestId('start-editing')).toBeVisible()
  await page.goto(`/admin/templates/${THEIRS}`)
  await expect(page.getByText('SZ-02 範本').first()).toBeVisible()
  await expect(page.getByTestId('start-editing')).toHaveCount(0)
  await page.goto(`/admin/templates/${THEIRS}/edit`)
  await expect(page.getByTestId('editing-badge')).toHaveCount(0)

  await page.goto(`/admin/flows/${ROUTE_MINE}`)
  await expect(page.getByTestId('start-editing')).toBeVisible()
  await page.goto(`/admin/flows/${ROUTE_THEIRS}`)
  await expect(page.getByTestId('route-heading')).toBeVisible()
  await expect(page.getByTestId('start-editing')).toHaveCount(0)
})

test('the new-範本 dialog offers a 稽核人員 only his plants and no 全部廠區 switch', async ({ page }) => {
  await mockApi(page, [FQ.id])
  await page.goto('/admin/templates')
  await page.getByTestId('create-template').click()
  const dialog = page.getByTestId('template-header-modal')
  await expect(dialog.getByTestId('template-limited-plants')).toBeVisible()
  await expect(dialog.getByRole('switch')).toHaveCount(0)
  // His only plant is already chosen; the dropdown lists no other.
  await expect(dialog.getByTestId('template-limited-plants').getByTitle('FQ　福清')).toBeVisible()
  await dialog.getByTestId('template-limited-plants').click()
  await expect(page.locator('.ant-select-item-option')).toHaveCount(1)
  await expect(page.getByTitle('SZ　兆利')).toHaveCount(0)
})

test('a 稽核人員 may only add to 自評單位: no 修改 or 刪除', async ({ page }) => {
  await mockApi(page, [FQ.id])
  await page.goto('/admin/assessing-units')
  await expect(page.getByTestId('unit-table').getByText('業務單位')).toBeVisible()
  await expect(page.getByTestId('add-unit')).toBeVisible()
  await expect(page.getByRole('button', { name: '修改' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /刪\s*除/ })).toHaveCount(0)
})

test('a 稽核人員 who runs no plant only looks: nothing to add, nothing to edit', async ({ page }) => {
  await mockApi(page, [])
  await page.goto('/admin/templates')
  await expect(page.getByTestId('template-table')).toBeVisible()
  await expect(page.getByTestId('create-template')).toHaveCount(0)
  await page.goto(`/admin/templates/${MINE}`)
  await expect(page.getByTestId('start-editing')).toHaveCount(0)
  await page.goto('/admin/flows')
  await expect(page.getByTestId('create-route')).toHaveCount(0)
  await page.goto('/admin/assessing-units')
  await expect(page.getByTestId('add-unit')).toHaveCount(0)
})
