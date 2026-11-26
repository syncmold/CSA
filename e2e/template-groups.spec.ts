import { expect, test, type Page, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 範本管理 by 組成要素 (#62, #66, Q106): tabs for 全部 and the five 組成要素 across the top (as on 簽核流程 since 方向 A,
// #120, #121; the menu down the left is gone, OPEN-5), the chosen one's templates below, the choice kept in the URL;
// and the 範本抬頭 form (#62, #64): a new template sends its 組成要素 (not a 版型), and no version or 狀態 (Q137 (4)(5):
// one template per 編號, always 啟用 when new); an edit chooses 啟用 or 停用.
// Every /rest/v1 answer is made up here, so no database or sign-in is needed.

const template = (id: string, code: string, name: string, layout: string, component: string) => ({
  id, code, name, layout, component, status: 'active', all_plants: true, in_use: false, template_plant: [],
})

const TEMPLATES = [
  template('00000000-0000-0000-0000-000000000001', '02', '採購及付款循環', 'control_activity', 'control_activities'),
  template('00000000-0000-0000-0000-000000000002', 'A', '控制環境', 'element', 'control_environment'),
]

/** Answers like PostgREST would; returns the body each create_template call was sent with (update_template's in `updated`). */
async function mockApi(page: Page, updated: Record<string, unknown>[] = []) {
  const created: Record<string, unknown>[] = []
  await page.route('**/rest/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/employee_ref')) return route.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/questionnaire_template')) {
      // The detail page asks for one template (id=eq.…) with its sections.
      const id = new URL(route.request().url()).searchParams.get('id')?.replace(/^eq\./, '')
      const rows = id ? TEMPLATES.filter((t) => t.id === id).map((t) => ({ ...t, template_section: [] })) : TEMPLATES
      return route.fulfill({ json: rows })
    }
    if (path.endsWith('/rpc/create_template')) {
      created.push(route.request().postDataJSON() as Record<string, unknown>)
      return route.fulfill({ json: '00000000-0000-0000-0000-000000000099' })
    }
    if (path.endsWith('/rpc/update_template')) {
      updated.push(route.request().postDataJSON() as Record<string, unknown>)
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({ json: [] })
  })
  return created
}

test('範本管理 shows tabs for 全部 and the five 組成要素, listing only the chosen tab’s templates (#66)', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/templates')

  const tabs = page.getByTestId('template-table-components')
  const table = page.getByTestId('template-table')
  // 全部 first, then the five in the 準則's order.
  await expect(tabs.getByRole('tab')).toHaveText([/^全部/, /^一、控制環境/, /^二、風險評估/, /^三、控制作業/, /^四、資訊與溝通/, /^五、監督作業/])
  // Nothing in the URL: the first 組成要素 that has templates, then pinned in the URL.
  await expect(table.getByRole('link', { name: '控制環境' })).toBeVisible()
  await expect(page).toHaveURL(/component=control_environment/)
  await expect(table.getByRole('link', { name: '採購及付款循環' })).toHaveCount(0)
  await expect(table.locator('thead')).not.toContainText('版型')

  await tabs.getByRole('tab', { name: /三、控制作業/ }).click()
  await expect(page).toHaveURL(/component=control_activities/)
  await expect(table.getByRole('link', { name: '採購及付款循環' })).toBeVisible()
  await expect(table.getByRole('link', { name: '控制環境' })).toHaveCount(0)

  // The 停用 switch keeps the chosen 組成要素.
  await page.getByTestId('show-inactive').click()
  await expect(page).toHaveURL(/component=control_activities/)
  await expect(page).toHaveURL(/inactive=1/)

  // A 組成要素 without templates says so.
  await tabs.getByRole('tab', { name: /二、風險評估/ }).click()
  await expect(table.getByText('這一類沒有題庫')).toBeVisible()

  // 全部 lists every 組成要素's templates.
  await tabs.getByRole('tab', { name: /全部/ }).click()
  await expect(page).toHaveURL(/component=all/)
  await expect(table.getByRole('link', { name: '控制環境' })).toBeVisible()
  await expect(table.getByRole('link', { name: '採購及付款循環' })).toBeVisible()

  // Keyboard: arrow to the next tab and choose it with Enter. Wait until the click has switched the tab (URL and
  // table re-render) before focusing it; focusing earlier raced that re-render in CI and the focus was lost.
  const second = tabs.getByRole('tab', { name: /二、風險評估/ })
  await second.click()
  await expect(page).toHaveURL(/component=risk_assessment/)
  await expect(second).toHaveAttribute('aria-selected', 'true')
  await expect(table.getByText('這一類沒有題庫')).toBeVisible()
  await expect(async () => {
    await second.focus()
    await page.keyboard.press('ArrowRight')
    await expect(tabs.getByRole('tab', { name: /三、控制作業/ })).toBeFocused({ timeout: 1000 })
  }).toPass()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/component=control_activities/)
})

test('opening a template and coming back returns to the same 組成要素', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/templates?component=control_activities')

  await page.getByTestId('template-table').getByRole('link', { name: '採購及付款循環' }).click()
  await expect(page).toHaveURL(/\/admin\/templates\/0{8}-/)
  await page.goBack()
  await expect(page).toHaveURL(/component=control_activities/)
  await expect(page.getByTestId('template-table').getByRole('link', { name: '採購及付款循環' })).toBeVisible()

  // Opened from 全部, coming back returns to 全部.
  await page.goto('/admin/templates?component=all')
  await page.getByTestId('template-table').getByRole('link', { name: '採購及付款循環' }).click()
  await page.goBack()
  await expect(page).toHaveURL(/component=all/)
  await expect(page.getByTestId('template-table-components').getByRole('tab', { name: /全部/ })).toHaveAttribute('aria-selected', 'true')

  // The breadcrumb also goes back to the template's own 組成要素.
  await page.getByTestId('template-table').getByRole('link', { name: '採購及付款循環' }).click()
  await page.getByRole('main').getByRole('link', { name: '題庫管理' }).click()
  await expect(page).toHaveURL(/\/admin\/templates\?component=control_activities$/)
})

test('on a narrow screen the tabs that do not fit fold into 「⋯」, which stays inside the card’s padding (#104, #120)', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 })
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/templates')

  const more = page.getByTestId('template-table-components').locator('.ant-tabs-nav-more')
  await expect(more).toBeVisible()
  // The tab row's line runs to the card's edges (方向 A), but the 「⋯」 keeps the card's 20px padding.
  const card = (await page.locator('.ant-card').first().boundingBox())!
  const button = (await more.boundingBox())!
  expect(Math.round(card.x + card.width - (button.x + button.width))).toBeGreaterThanOrEqual(20)
  await more.hover()
  await page.locator('.ant-tabs-dropdown-menu-item', { hasText: '五、監督作業' }).click()
  await expect(page).toHaveURL(/component=monitoring/)
})

test('a new template sends its 組成要素, never a 版型, a version or a 狀態 (Q137)', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const created = await mockApi(page)
  await page.goto('/admin/templates')

  // The list has no 版本 column either.
  await expect(page.getByTestId('template-table').locator('thead')).not.toContainText('版本')

  await page.getByTestId('create-template').click()
  const modal = page.getByTestId('template-header-modal')
  await expect(modal).not.toContainText('版型')
  // No 版本 (生效年月) picker and no 狀態: a new template is always 啟用.
  await expect(modal).not.toContainText('版本')
  await expect(modal.getByTestId('template-version')).toHaveCount(0)
  await expect(modal.getByTestId('template-status')).toHaveCount(0)
  await modal.getByPlaceholder('GT-07、FQ-01.1').fill('16')
  await modal.getByLabel('名稱').fill('新循環')
  await modal.getByLabel('控制作業').check()
  await modal.getByRole('button', { name: /儲\s*存/ }).click()

  await expect.poll(() => created.length).toBe(1)
  expect(created[0]).toEqual({ p_code: '16', p_name: '新循環', p_component: 'control_activities', p_all_plants: true, p_factory_codes: [] })
})

test('editing a template’s 抬頭 chooses 啟用 or 停用 (no 草稿) and sends it, without a version (Q137 (5))', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const updated: Record<string, unknown>[] = []
  await mockApi(page, updated)
  await page.goto('/admin/templates/00000000-0000-0000-0000-000000000001/edit')

  await page.getByTestId('edit-header').click()
  const modal = page.getByTestId('template-header-modal')
  const status = modal.getByTestId('template-status')
  await expect(status.getByRole('radio')).toHaveCount(2)
  await expect(status).toHaveText(/^啟用停用$/)
  await expect(status.getByRole('radio', { name: '啟用' })).toBeChecked()
  await status.getByText('停用').click()
  await modal.getByRole('button', { name: /儲\s*存/ }).click()

  await expect.poll(() => updated.length).toBe(1)
  expect(updated[0]).toMatchObject({ p_template_id: '00000000-0000-0000-0000-000000000001', p_code: '02', p_status: 'inactive' })
  expect(updated[0]).not.toHaveProperty('p_version')
})
