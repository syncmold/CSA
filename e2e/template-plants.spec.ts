import { expect, test, type Page, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 範本管理先選廠區 (#84, B2, Q111): a band of 廠區 buttons at the top of the list's card (方向 A, #120);
// the tabs count and list only the chosen plant's templates; 「內容相同的廠區」 lists the other plants with the same
// questions; the plant is kept in the URL and remembered for the next visit. Every /rest/v1 answer is made up here, so
// no database or sign-in is needed.

const PLANTS = [
  { id: 'p-gt', factory_code: 'GT', name: '敬得(觀音)' },
  { id: 'p-tc', factory_code: 'TC', name: '敬得(太倉)' },
]

let n = 0
const template = (code: string, name: string, component: string, plants: string[], fingerprint: string) => ({
  id: `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`,
  code, name, component, layout: component === 'control_activities' ? 'control_activity' : 'element',
  status: 'active', all_plants: false, in_use: false,
  template_plant: plants.map((factory_code) => ({ factory_code })),
  control_point_count: 16, content_fingerprint: fingerprint,
})

const TEMPLATES = [
  template('GT-07', '融資循環', 'control_activities', ['GT'], 'finance'),
  template('GT-05', '研發循環', 'control_activities', ['GT'], 'rd-gt'),
  template('GT-A', '控制環境', 'control_environment', ['GT'], 'env-gt'),
  template('TC-07', '融資循環', 'control_activities', ['TC'], 'finance'),
  template('TC-A', '控制環境', 'control_environment', ['TC'], 'env-tc'),
  template('SAMOA-01', '銷售及收款循環、採購及付款循環', 'control_activities', [], 'samoa'),
]

async function mockApi(page: Page, templates = TEMPLATES) {
  await page.route('**/rest/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/employee_ref')) return route.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/plant')) return route.fulfill({ json: PLANTS })
    if (path.endsWith('/questionnaire_template')) return route.fulfill({ json: templates })
    return route.fulfill({ json: [] })
  })
}

test('範本管理 opens on a plant and lists only its templates, with the plants that share their content (#84)', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/templates')

  const picker = page.getByTestId('plant-picker')
  const choosePlant = (key: string) => page.getByTestId(`plant-${key}`).click()
  const table = page.getByTestId('template-table')
  const tabs = page.getByTestId('template-table-components')
  // Every plant, plus 未指定廠區 because SAMOA-01 has no plant; nothing in the URL or remembered: the first plant.
  await expect(page).toHaveURL(/plant=GT/)
  await expect(page.getByRole('group', { name: '廠區' })).toBeVisible()
  await expect(picker.getByRole('button')).toHaveText(['GT 敬得(觀音)', 'TC 敬得(太倉)', '未指定廠區'])
  await expect(picker.getByRole('button', { name: 'GT 敬得(觀音)' })).toHaveAttribute('aria-pressed', 'true')
  // The 停用 switch sits at the end of the tabs' row; no layout switch on this page (#120).
  await expect(tabs.getByRole('switch')).toBeVisible()
  await expect(page.getByTestId('component-layout')).toHaveCount(0)

  // The tabs count GT's templates only.
  await expect(tabs.getByRole('tab', { name: /三、控制作業/ })).toContainText('2')
  await tabs.getByRole('tab', { name: /三、控制作業/ }).click()
  await expect(table.getByRole('link')).toHaveText(['融資循環', '研發循環'])
  await expect(table.getByRole('row', { name: /GT-07/ }).getByTestId('same-content')).toHaveText('TC')
  await expect(table.getByRole('row', { name: /GT-05/ })).toContainText('本廠獨有')
  // Status and use are a dot and words, no tag (#120).
  await expect(table.getByRole('row', { name: /GT-07/ })).toContainText('啟用')
  await expect(table.locator('.ant-tag')).toHaveCount(0)
  // No line above the table repeats the plant and the tab's count (Q114).
  await expect(page.getByTestId('plant-summary')).toHaveCount(0)

  // Another plant keeps the tab, so plants compare side by side, and no column moves (fixed widths).
  const columnStarts = () => table.locator('thead th').evaluateAll((ths) => ths.map((th) => Math.round(th.getBoundingClientRect().left)))
  const before = await columnStarts()
  await choosePlant('TC')
  await expect(page).toHaveURL(/plant=TC/)
  await expect(page).toHaveURL(/component=control_activities/)
  await expect(table.getByRole('row', { name: /TC-07/ }).getByTestId('same-content')).toHaveText('GT')
  await expect(table.getByRole('link', { name: '研發循環' })).toHaveCount(0)
  expect(await columnStarts()).toEqual(before)

  // A plant with nothing in the tab opens on its first 組成要素 with templates (samoa has only 控制作業).
  await tabs.getByRole('tab', { name: /一、控制環境/ }).click()
  await choosePlant('none')
  await expect(page).toHaveURL(/plant=none/)
  await expect(page).toHaveURL(/component=control_activities/)
  await expect(table.getByRole('link', { name: '銷售及收款循環、採購及付款循環' })).toBeVisible()

  // The choice is remembered: opening the page afresh returns to it.
  await choosePlant('TC')
  await page.goto('/admin/templates')
  await expect(page).toHaveURL(/plant=TC/)

  // A new template starts as the chosen plant's own: its code prefix and only that plant.
  await page.getByTestId('create-template').click()
  const modal = page.getByTestId('template-header-modal')
  await expect(modal.getByLabel('編號')).toHaveValue('TC-')
  await expect(modal.getByRole('switch')).toHaveAttribute('aria-checked', 'false') // 不是所有廠區適用
  await expect(modal.locator('.ant-select-selection-item')).toContainText('敬得(太倉)')
})

test('more than four plants with the same content fold into 「…等 n 廠」, the whole list in a tooltip (#120)', async ({ page }) => {
  await signInAsAuditAdmin(page)
  // GT's 融資循環 has the same content as five other plants' (codes the 廠區主檔 does not have count too).
  const others = ['KS', 'CF', 'FQ', 'FF', 'GH']
  await mockApi(page, [...TEMPLATES, ...others.map((code) => template(`${code}-07`, '融資循環', 'control_activities', [code], 'finance'))])
  await page.goto('/admin/templates?plant=GT&component=control_activities')

  const same = page.getByTestId('template-table').getByRole('row', { name: /GT-07/ }).getByTestId('same-content')
  await expect(same).toHaveText('CF、FF、FQ、GH 等 6 廠')
  await same.hover()
  await expect(page.getByRole('tooltip')).toHaveText('CF、FF、FQ、GH、KS、TC')
})
