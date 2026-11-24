import { expect, test, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 年度發起的版面（使用者 2026-11-19）：範本列依廠區選單的順序（廠區主檔＝SyncHub 的順序，同一廠區內照範本編號），
// 發起按鈕那一列在清單很長時常駐在視窗底部，不必捲到最後。Every /rest/v1 answer is made up here.

const READY = { ready: true, no_steps: false, no_merge_steps: false, missing_units: [], unused_units: [], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [] }
/** The 廠區主檔's order, as fetchPlants returns it: not the codes' alphabetical order. */
const PLANTS = [
  { id: 'p-TC', factory_code: 'TC', name: '敬得(太倉)' },
  { id: 'p-FQ', factory_code: 'FQ', name: '福清富群' },
  { id: 'p-GT', factory_code: 'GT', name: '敬得(觀音)' },
]
const CODES = ['01.1', '02', '03.1', '04', '05', '06', '07', '08', '09', '10.1', '11', '15', 'A', 'B', 'C', 'D']

// The database lists combinations by 範本編號 (launch_candidates orders by t.code): FQ's first, then GT's, then TC's.
const CANDIDATES = [...PLANTS]
  .sort((a, b) => a.factory_code.localeCompare(b.factory_code))
  .flatMap((p) =>
    CODES.map((code) => ({
      template_id: `t-${p.factory_code}-${code}`, template_code: `${p.factory_code}-${code}`, template_name: `${code} 循環`,
      plant_id: p.id, factory_code: p.factory_code, plant_name: p.name,
      route_id: `r-${p.factory_code}-${code}`, step_count: 7, problem: null, launch_check: READY, launched_years: [],
    })),
  )

test('lists the rows in the 廠區 menu\'s order, and keeps the launch bar at the foot of the window', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await page.route('**/rest/v1/**', async (r: Route) => {
    const path = new URL(r.request().url()).pathname
    if (path.endsWith('/employee_ref')) return r.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/rpc/launch_candidates')) return r.fulfill({ json: CANDIDATES })
    if (path.endsWith('/plant')) return r.fulfill({ json: PLANTS })
    return r.fulfill({ json: [] })
  })
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/admin/launch')

  const rows = page.getByTestId('launch-table').locator('tbody tr.ant-table-row')
  await expect(rows).toHaveCount(CANDIDATES.length)
  // TC's 範本 first (the menu's first 廠區), each 廠區's in 範本編號 order; GT's last.
  await expect(rows.first()).toContainText('TC-01.1')
  await expect(rows.nth(CODES.length)).toContainText('FQ-01.1')
  await expect(rows.last()).toContainText('GT-D')

  // 48 rows do not fit in 800px, yet the launch bar is on screen without scrolling, at the window's foot.
  const bar = page.getByTestId('launch-bar')
  await expect(page.getByTestId('launch-submit')).toBeInViewport()
  const box = (await bar.boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(800)
  expect(box.y + box.height).toBeGreaterThan(800 - 4)
  // Still there halfway down the list.
  await rows.nth(24).scrollIntoViewIfNeeded()
  await expect(page.getByTestId('launch-submit')).toBeInViewport()
})
