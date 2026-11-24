import { expect, test, type Page, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 範本管理, 自評單位 and 流程編輯器 lists while their data is on the way: the spinner, never the
// 「沒有可檢視的…」 hint, until the database has answered (the empty hint used to show under the
// spinner). The browser gets a stored session and every /rest/v1 answer is made up here, so no
// database or sign-in is needed and the slow request can be held for as long as the test likes.

/** Answers /rest/v1 like PostgREST would; `table`'s answer waits until the returned function is called. */
async function mockApi(page: Page, table: string) {
  let release!: (rows: unknown[]) => void
  const held = new Promise<unknown[]>((resolve) => (release = resolve))
  await page.route('**/rest/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/employee_ref')) return route.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith(`/${table}`)) return route.fulfill({ json: await held })
    return route.fulfill({ json: [] })
  })
  return release
}

/** antd puts the table inside its spinner, so the busy element is the one around the table. */
function spinnerAround(page: Page, testId: string) {
  return page.locator('[aria-busy="true"]', { has: page.getByTestId(testId) })
}

const TEMPLATE = {
  id: '00000000-0000-0000-0000-000000000001',
  code: '01',
  name: '測試用範本',
  layout: 'element',
  component: 'control_environment',
  status: 'active',
  all_plants: true,
  in_use: false,
  template_plant: [],
}

test('範本管理 shows the spinner, not the empty hint, until the templates arrive', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const release = await mockApi(page, 'questionnaire_template')
  await page.goto('/admin/templates')

  const table = page.getByTestId('template-table')
  await expect(spinnerAround(page, 'template-table')).toBeVisible()
  await expect(page.getByText('沒有可檢視的問卷範本')).toHaveCount(0)

  release([TEMPLATE])
  await expect(table.getByRole('link', { name: '測試用範本' })).toBeVisible()
  await expect(spinnerAround(page, 'template-table')).toHaveCount(0)
  await expect(page.getByText('沒有可檢視的問卷範本')).toHaveCount(0)
})

test('範本管理 shows the empty hint once the database answers with no templates', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const release = await mockApi(page, 'questionnaire_template')
  await page.goto('/admin/templates')
  await expect(spinnerAround(page, 'template-table')).toBeVisible()

  release([])
  await expect(page.getByText('沒有可檢視的問卷範本')).toBeVisible()
})

test('流程編輯器 shows the spinner, not the empty hint, until the routes arrive', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const release = await mockApi(page, 'approval_route')
  await page.goto('/admin/flows')

  await expect(spinnerAround(page, 'route-table')).toBeVisible()
  await expect(page.getByText('沒有可檢視的簽核流程')).toHaveCount(0)

  release([])
  await expect(page.getByText('沒有可檢視的簽核流程')).toBeVisible()
  await expect(spinnerAround(page, 'route-table')).toHaveCount(0)
  // The same 組成要素 tabs as 範本管理 (Q106).
  await expect(page.getByTestId('route-table-components').getByRole('tab')).toHaveText([/^全部/, /^一、控制環境/, /^二、風險評估/, /^三、控制作業/, /^四、資訊與溝通/, /^五、監督作業/])
})

test('自評單位 shows the spinner, not the empty hint, until the units arrive', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const release = await mockApi(page, 'assessing_unit')
  await page.goto('/admin/assessing-units')

  await expect(spinnerAround(page, 'unit-table')).toBeVisible()
  await expect(page.getByText('尚無自評單位')).toHaveCount(0)

  release([])
  await expect(page.getByText('尚無自評單位')).toBeVisible()
  await expect(spinnerAround(page, 'unit-table')).toHaveCount(0)
})
