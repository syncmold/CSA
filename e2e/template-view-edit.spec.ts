import { expect, test, type Page, type Request, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 查看／修改 (#66, Q103): a template or 簽核流程 opened from the list is read-only; 「修改」 shows /edit with the
// editing controls and 「完成修改」 shows the read-only page again. Neither adds a history entry (option 1), so
// 上一頁 always returns to the list on the item's 組成要素, also after a delete. A new template opens in edit
// mode. A 簽核流程 is deleted as a template is, by typing 「刪除 <範本編號>」 (Q137 (6)). Every /rest/v1 answer is made up
// here, so no database or sign-in is needed.

const ID = '00000000-0000-0000-0000-000000000001'
const ROUTE_ID = '00000000-0000-0000-0000-0000000000a1'

const SUMMARY = {
  id: ID, code: '02', name: '採購及付款循環', layout: 'control_activity', component: 'control_activities',
  status: 'active', all_plants: true, in_use: false, template_plant: [],
}
const TREE = {
  ...SUMMARY,
  template_section: [
    { id: 's1', position: 1, level: 1, code: null, name: '請購作業', control_point: [{ id: 'p1', position: 1, code: null, text: '請購是否經核准？', control_point_unit: [] }] },
  ],
}
const ROUTE = {
  id: ROUTE_ID, updated_at: '2026-10-21T05:00:00+00:00', step_count: 1,
  launch_check: { ready: true, no_steps: false, no_merge_steps: false, missing_units: [], unused_units: [], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [] },
  template: { id: ID, code: '02', name: '採購及付款循環', component: 'control_activities' },
  plant: { id: 'pl', factory_code: 'FQ', name: '福清富群' },
  route_step: [{ id: 'st1', position: 1, name: '稽核主管', step_group: 'audit_review', signer_emp_id: 'ZZ0001', editable_unit_id: null, assessing_unit: null }],
}

/** Answers like PostgREST would and records every write. */
async function mockApi(page: Page, writes: Request[] = []) {
  await page.route('**/rest/v1/**', async (route: Route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET') writes.push(route.request())
    const path = url.pathname
    // The detail page selects the sections too; the list does not.
    const wantsTree = (url.searchParams.get('select') ?? '').includes('template_section')
    if (path.endsWith('/employee_ref')) return route.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/questionnaire_template')) return route.fulfill({ json: [wantsTree ? TREE : SUMMARY] })
    if (path.endsWith('/approval_route')) return route.fulfill({ json: [ROUTE] })
    if (path.endsWith('/rpc/create_template')) return route.fulfill({ json: ID })
    if (path.endsWith('/rpc/delete_template')) return route.fulfill({ status: 204 })
    if (path.endsWith('/rpc/delete_route')) return route.fulfill({ status: 204 })
    return route.fulfill({ json: [] })
  })
}

const TEMPLATE_EDIT = ['edit-header', 'delete-template', 'add-section', 'add-control-point', 'section-handle', 'point-handle']
const ROUTE_EDIT = ['delete-route', 'add-step', 'step-handle']
/** A route has no 狀態 (Q137 (6)): no 啟用／停用 in either mode. */
const ROUTE_GONE = ['activate-route', 'deactivate-route']

test('a template opens read-only; 修改 shows the editing controls, 完成修改 hides them, 上一頁 goes to the list', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/templates?component=control_activities')

  await page.getByTestId('template-table').getByRole('link', { name: '採購及付款循環' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/templates/${ID}$`))
  await expect(page.getByText('請購是否經核准？')).toBeVisible()
  for (const id of TEMPLATE_EDIT) await expect(page.getByTestId(id)).toHaveCount(0)

  await page.getByTestId('start-editing').click()
  await expect(page).toHaveURL(new RegExp(`/admin/templates/${ID}/edit$`))
  await expect(page.getByTestId('editing-badge')).toBeVisible()
  for (const id of TEMPLATE_EDIT) await expect(page.getByTestId(id).first()).toBeVisible()

  // 上一頁 from the edit page skips the read-only page it replaced.
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/templates\?component=control_activities$/)

  await page.goForward()
  await page.getByTestId('finish-editing').click()
  await expect(page).toHaveURL(new RegExp(`/admin/templates/${ID}$`))
  await expect(page.getByTestId('edit-header')).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/templates\?component=control_activities$/)
})

test('deleting a template returns to its 組成要素, and 上一頁 does not reopen it', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/templates')
  await page.goto(`/admin/templates/${ID}`)

  await page.getByTestId('start-editing').click()
  await page.getByTestId('delete-template').click()
  await page.getByTestId('delete-template-code').fill('刪除 02')
  await page.getByTestId('delete-template-modal').getByRole('button', { name: /刪\s*除/ }).click()
  await expect(page).toHaveURL(/\/admin\/templates\?component=control_activities$/)

  await page.goBack()
  await expect(page).toHaveURL(/\/admin\/templates(\?.*)?$/)
})

test('a 簽核流程 opens read-only too; 刪除 and the step controls are only in edit mode, 啟用／停用 nowhere', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/flows')
  await expect(page).toHaveURL(/component=control_activities/)

  await page.getByTestId('route-table').getByRole('link', { name: /採購及付款循環/ }).click()
  await expect(page.getByTestId('route-heading')).toContainText('02 採購及付款循環')
  await expect(page.getByTestId('route-steps')).toContainText('稽核主管')
  for (const id of [...ROUTE_EDIT, ...ROUTE_GONE]) await expect(page.getByTestId(id)).toHaveCount(0)

  await page.getByTestId('start-editing').click()
  await expect(page).toHaveURL(new RegExp(`/admin/flows/${ROUTE_ID}/edit$`))
  for (const id of ROUTE_EDIT) await expect(page.getByTestId(id).first()).toBeVisible()
  for (const id of ROUTE_GONE) await expect(page.getByTestId(id)).toHaveCount(0)

  await page.getByTestId('finish-editing').click()
  await expect(page).toHaveURL(new RegExp(`/admin/flows/${ROUTE_ID}$`))
  // The breadcrumb opens the list on the route's 組成要素 and 廠區 (#85).
  await page.getByRole('main').getByRole('link', { name: '簽核流程管理' }).click()
  await expect(page).toHaveURL(/\/admin\/flows\?component=control_activities&plant=FQ$/)
})

test('deleting a 簽核流程 has to be typed: pasting is refused, and only 「刪除 <範本編號>」 sends delete_route (Q137 (6))', async ({ page }) => {
  const writes: Request[] = []
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await signInAsAuditAdmin(page)
  await mockApi(page, writes)
  await page.goto(`/admin/flows/${ROUTE_ID}/edit`)

  await page.getByTestId('delete-route').click()
  const modal = page.getByTestId('delete-route-modal')
  const input = modal.getByTestId('delete-route-code')
  const ok = modal.getByRole('button', { name: /刪\s*除/ })
  await expect(modal).toContainText('刪除簽核流程 02 × FQ')
  await expect(modal).toContainText('會一併刪除 1 個關卡。')
  // The phrase is only the placeholder, and the button waits for it.
  await expect(input).toHaveAttribute('placeholder', '刪除 02')
  await expect(ok).toBeDisabled()

  // Pasting the phrase is refused: nothing lands in the box.
  await page.evaluate(() => navigator.clipboard.writeText('刪除 02'))
  await input.focus()
  await page.keyboard.press('ControlOrMeta+V')
  await expect(input).toHaveValue('')
  await expect(ok).toBeDisabled()

  // Another 編號 is not enough.
  await input.pressSequentially('刪除 03')
  await expect(ok).toBeDisabled()
  await input.clear()
  await input.pressSequentially('刪除 02')
  await expect(ok).toBeEnabled()
  expect(writes.filter((w) => w.url().endsWith('/rpc/delete_route'))).toHaveLength(0)

  await ok.click()
  // Back on the list, on the route's 組成要素 and 廠區; the database compares the 編號 once more.
  await expect(page).toHaveURL(/\/admin\/flows\?component=control_activities&plant=FQ$/)
  const deletes = writes.filter((w) => w.url().endsWith('/rpc/delete_route'))
  expect(deletes).toHaveLength(1)
  expect(deletes[0]!.postDataJSON()).toEqual({ p_route_id: ROUTE_ID, p_code: '02' })
})

test('a new template opens in edit mode, and 完成修改 leaves it on the read-only page', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/templates')

  await page.getByTestId('create-template').click()
  const modal = page.getByTestId('template-header-modal')
  await modal.getByPlaceholder('GT-07、FQ-01.1').fill('02')
  await modal.getByLabel('名稱').fill('採購及付款循環')
  await modal.getByLabel('控制作業').check()
  await modal.getByRole('button', { name: /儲\s*存/ }).click()

  await expect(page).toHaveURL(new RegExp(`/admin/templates/${ID}/edit$`))
  await expect(page.getByTestId('add-section')).toBeVisible()
  await page.getByTestId('finish-editing').click()
  await expect(page).toHaveURL(new RegExp(`/admin/templates/${ID}$`))
  await expect(page.getByTestId('add-section')).toHaveCount(0)
})

test('a multi-level template reads as the paper: one card per 第一層, 分段列 for the levels under it, the paper’s 題號 (#166)', async ({ page }) => {
  const tree = {
    ...SUMMARY,
    code: 'SY-A',
    name: '控制環境',
    layout: 'element',
    component: 'control_environment',
    template_section: [
      { id: 'h1', position: 1, level: 1, code: '1', name: '董事會應重視誠信與道德價值。', control_point: [] },
      {
        id: 'h2', position: 2, level: 2, code: '1.1', name: '公司是否建立內部行為準則？',
        control_point: [{ id: 'q1', position: 1, code: '1.1.1-1', text: '公司是否建立董事行為準則？', control_point_unit: [] }],
      },
      {
        id: 'h3', position: 3, level: 2, code: null, name: '沒有題號的分段',
        control_point: [{ id: 'q2', position: 1, code: null, text: '沒有題號的控制要點？', control_point_unit: [] }],
      },
    ],
  }
  await signInAsAuditAdmin(page)
  await page.route('**/rest/v1/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/employee_ref')) return route.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/questionnaire_template')) return route.fulfill({ json: [tree] })
    return route.fulfill({ json: [] })
  })
  await page.goto(`/admin/templates/${ID}`)

  await expect(page.getByTestId('template-section')).toHaveCount(1)
  await expect(page.getByTestId('template-section').getByRole('heading')).toHaveText('1 董事會應重視誠信與道德價值。')
  const subheadings = page.getByTestId('template-subheading')
  await expect(subheadings).toHaveCount(2)
  await expect(subheadings.first()).toContainText('1.1')
  await expect(subheadings.first()).toContainText('公司是否建立內部行為準則？')
  const points = page.getByTestId('control-point-row')
  await expect(points.first().getByRole('cell').first()).toHaveText('1.1.1-1')
  await expect(points.first()).toContainText('公司是否建立董事行為準則？')
  // No 題號 on paper: its place in the card, counted over the 分段.
  await expect(points.nth(1).getByRole('cell').first()).toHaveText('2')
  // 章 counts the cards, as on paper.
  await expect(page.getByTestId('template-info')).toContainText('1 章、2 個控制要點')
})
