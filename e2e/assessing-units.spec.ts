import { expect, test, type Page, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 自評單位清單 in 方向 A (#124): a name is still edited in place, now opened from the row's 修改 link (no pencil and
// no dialog). Every /rest/v1 answer is made up here; the test reads what the page sends.

const QA_UNIT = { id: '00000000-0000-0000-0000-000000000001', name: '品保單位' }
const UNITS = [QA_UNIT, { id: '00000000-0000-0000-0000-000000000002', name: '財會單位' }]

/** Answers /rest/v1 like PostgREST would and keeps every write to assessing_unit. */
async function mockApi(page: Page) {
  const writes: { method: string; url: string; body: unknown }[] = []
  await page.route('**/rest/v1/**', async (route: Route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/employee_ref')) return route.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/assessing_unit')) {
      if (request.method() === 'GET') return route.fulfill({ json: UNITS })
      writes.push({ method: request.method(), url: request.url(), body: request.postDataJSON() })
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({ json: [] })
  })
  return writes
}

test('修改 opens the name for editing in place; Enter saves it, Esc leaves it', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const writes = await mockApi(page)
  await page.goto('/admin/assessing-units')

  const table = page.getByTestId('unit-table')
  await expect(table.getByRole('columnheader')).toHaveText(['自評單位', '操作'])
  const row = table.getByRole('row', { name: /品保單位/ })
  const edit = row.getByRole('button', { name: '修改' })

  // Esc: nothing sent, the name as it was, back on the link.
  await edit.click()
  await row.getByRole('textbox').fill('品保部')
  await page.keyboard.press('Escape')
  await expect(row.getByRole('textbox')).toHaveCount(0)
  await expect(row).toContainText('品保單位')
  await expect(edit).toBeFocused()
  expect(writes).toEqual([])

  // Enter: the new name is sent for that unit, and the focus is back on its 修改.
  await edit.click()
  await row.getByRole('textbox').fill('品保部')
  await page.keyboard.press('Enter')
  await expect(row.getByRole('textbox')).toHaveCount(0)
  await expect.poll(() => writes).toEqual([{ method: 'PATCH', url: expect.stringContaining(`id=eq.${QA_UNIT.id}`), body: { name: '品保部' } }])
  await expect(edit).toBeFocused()
})
