import { expect, test, type Page, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 簽核流程先選廠區 (#85, C3): the same 廠區 buttons and the same choice as 範本管理; the 組成要素 tabs count and list
// only that plant's routes; a route has no 狀態 (Q137 (6)), only its 發起檢查; 新增流程 starts on the chosen plant and
// offers only the 範本 × 廠區 without a route. Every /rest/v1 answer is made up here, so no database or sign-in is needed.

const PLANTS = [
  { id: 'p-gt', factory_code: 'GT', name: '敬得(觀音)' },
  { id: 'p-tc', factory_code: 'TC', name: '敬得(太倉)' },
]

let n = 0
const id = () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`

const template = (code: string, name: string, component: string, plant: string) => ({
  id: id(), code, name, component, layout: component === 'control_activities' ? 'control_activity' : 'element',
  status: 'active', all_plants: false, in_use: false,
  template_plant: [{ factory_code: plant }], control_point_count: 10, content_fingerprint: code,
})
const TEMPLATES = [
  template('GT-01.1', '銷售及收款循環', 'control_activities', 'GT'),
  template('GT-07', '融資循環', 'control_activities', 'GT'),
  template('GT-05', '研發循環', 'control_activities', 'GT'),
  template('GT-A', '控制環境', 'control_environment', 'GT'),
  template('TC-07', '融資循環', 'control_activities', 'TC'),
  template('TC-01.1', '銷售及收款循環', 'control_activities', 'TC'),
  { ...template('SAMOA-01', '銷售及收款循環', 'control_activities', 'TC'), template_plant: [] },
]

const ready = {
  ready: true, no_steps: false, no_merge_steps: false, missing_units: [] as { id: string; name: string }[], unused_units: [], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [],
}
const notReady = { ...ready, ready: false, missing_units: [{ id: 'u', name: '財會單位' }] }

const route = (code: string, check: typeof ready, steps: number) => {
  const tpl = TEMPLATES.find((t) => t.code === code)!
  const plant = PLANTS.find((p) => p.factory_code === tpl.template_plant[0]!.factory_code)!
  return {
    id: id(), updated_at: '2026-10-28T02:05:00+00:00', launch_check: check,
    template: { id: tpl.id, code: tpl.code, name: tpl.name, component: tpl.component }, plant,
    route_step: [{ count: steps }],
  }
}

const ROUTES = [
  route('GT-07', notReady, 6),
  route('GT-01.1', ready, 8),
  route('GT-05', ready, 6),
  route('GT-A', ready, 6),
  route('TC-07', ready, 7),
]

async function mockApi(page: Page) {
  await page.route('**/rest/v1/**', async (r: Route) => {
    const path = new URL(r.request().url()).pathname
    if (path.endsWith('/employee_ref')) return r.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/plant')) return r.fulfill({ json: PLANTS })
    if (path.endsWith('/questionnaire_template')) return r.fulfill({ json: TEMPLATES })
    if (path.endsWith('/approval_route')) return r.fulfill({ json: ROUTES })
    return r.fulfill({ json: [] })
  })
}

test('簽核流程 opens on a plant and lists only its routes by 組成要素 (#85)', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/flows')

  const picker = page.getByTestId('plant-picker')
  const table = page.getByTestId('route-table')
  const tabs = page.getByTestId('route-table-components')
  // Nothing in the URL or remembered: the first plant.
  await expect(picker.getByRole('button')).toHaveText(['GT 敬得(觀音)', 'TC 敬得(太倉)'])
  await expect(page).toHaveURL(/plant=GT/)
  await expect(picker.getByRole('button', { name: 'GT 敬得(觀音)' })).toHaveAttribute('aria-pressed', 'true')

  // Only the plant buttons and the list: who signs in what order is on each route's own page (使用者 2026-10-29).
  await expect(page.getByTestId('plant-levels')).toHaveCount(0)
  // No 狀態 column: a route is the only one of its 範本 × 廠區, and the 發起檢查 says whether it can be launched (Q137 (6)).
  await expect(page.getByTestId('route-table').locator('thead th')).toHaveText(['循環', '題庫', '關卡', '發起檢查', '最後修改'])
  // No 停用 switch for routes (there is no 停用 route), and only the tabs, no layout switch (#121, OPEN-5).
  await expect(tabs.getByRole('switch')).toHaveCount(0)
  await expect(page.getByTestId('show-inactive')).toHaveCount(0)
  await expect(page.getByTestId('component-layout')).toHaveCount(0)

  // The tabs count all of GT's routes.
  await expect(tabs.getByRole('tab', { name: /三、控制作業/ })).toContainText('3')
  await expect(tabs.getByRole('tab', { name: /一、控制環境/ })).toContainText('1')
  await tabs.getByRole('tab', { name: /三、控制作業/ }).click()
  await expect(table.getByRole('link')).toHaveText(['銷售及收款循環', '研發循環', '融資循環'])
  await expect(table.getByRole('row', { name: /GT-01\.1/ })).toContainText('8 關')
  // No tag; the check says ✓ 通過 or an orange ! 尚未通過, what is missing on hover (#121).
  await expect(table.locator('.ant-tag')).toHaveCount(0)
  await expect(table.getByRole('row', { name: /GT-01\.1/ })).toContainText(/✓\s*通過/)
  await expect(table.getByRole('row', { name: /GT-07/ })).toContainText(/!\s*尚未通過/)
  await expect(table).not.toContainText(/草稿|啟用|停用/)
  await table.getByRole('row', { name: /GT-07/ }).getByTestId('route-check-problem').hover()
  await expect(page.getByRole('tooltip')).toContainText('財會單位')
  // No line above the table repeats the plant and the tab's count (Q114).
  await expect(page.getByTestId('plant-summary')).toHaveCount(0)

  // Another plant keeps the tab.
  await picker.getByRole('button', { name: 'TC 敬得(太倉)' }).click()
  await expect(page).toHaveURL(/plant=TC/)
  await expect(page).toHaveURL(/component=control_activities/)
  await expect(table.getByRole('link')).toHaveText(['融資循環'])

  // A plant with nothing in the tab opens on its first 組成要素 with routes.
  await picker.getByRole('button', { name: 'GT 敬得(觀音)' }).click()
  await tabs.getByRole('tab', { name: /一、控制環境/ }).click()
  await picker.getByRole('button', { name: 'TC 敬得(太倉)' }).click()
  await expect(page).toHaveURL(/component=control_activities/)
  await expect(table.getByRole('link')).toHaveText(['融資循環'])

  // 新增流程 offers only the 範本 × 廠區 without a route (one each, Q137 (6)), labelled without a version, and starts on
  // the chosen plant once a 範本 for it is chosen.
  await page.getByTestId('create-route').click()
  const modal = page.getByTestId('create-route-modal')
  await modal.getByTestId('route-template').click()
  const option = (text: string) => page.locator('.ant-select-item-option', { hasText: text })
  await expect(option('TC-01.1 銷售及收款循環')).toHaveText('TC-01.1 銷售及收款循環')
  await expect(option('TC-07')).toHaveCount(0)
  await expect(option('GT-07')).toHaveCount(0)
  await page.keyboard.type('TC-01.1')
  await page.keyboard.press('Enter')
  await expect(modal.getByTestId('route-plant')).toContainText('TC 敬得(太倉)')
})

test('the plant chosen on 簽核流程 is the plant on 範本管理, and back (#85)', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/flows?plant=TC')
  await expect(page.getByTestId('plant-picker').getByRole('button', { name: 'TC 敬得(太倉)' })).toHaveAttribute('aria-pressed', 'true')

  // The same buttons on 範本管理, on the same plant.
  await page.getByTestId('nav-templates').click()
  await expect(page).toHaveURL(/\/admin\/templates\?.*plant=TC/)
  await expect(page.getByTestId('plant-picker').getByRole('button')).toHaveText(['GT 敬得(觀音)', 'TC 敬得(太倉)', '未指定廠區'])
  await page.getByTestId('plant-picker').getByRole('button', { name: 'GT 敬得(觀音)' }).click()

  await page.getByTestId('nav-flows').click()
  await expect(page).toHaveURL(/\/admin\/flows\?.*plant=GT/)
  await expect(page.getByTestId('plant-picker').getByRole('button', { name: 'GT 敬得(觀音)' })).toHaveAttribute('aria-pressed', 'true')

  // 未指定廠區 is only on 範本管理 (routes always have a plant): 簽核流程 shows its first plant without forgetting it.
  await page.getByTestId('nav-templates').click()
  await page.getByTestId('plant-picker').getByRole('button', { name: '未指定廠區' }).click()
  await page.getByTestId('nav-flows').click()
  await expect(page.getByTestId('plant-picker').getByRole('button')).toHaveText(['GT 敬得(觀音)', 'TC 敬得(太倉)'])
  await expect(page).toHaveURL(/plant=GT/)
  await page.getByTestId('nav-templates').click()
  await expect(page).toHaveURL(/plant=none/)
})
