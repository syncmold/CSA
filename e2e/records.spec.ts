import { expect, test, type Page, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 自評表紀錄 and 首頁's cut to the current 年度 (#164, Q124) against made-up /rest/v1 answers (no database or sign-in
// needed). Which 自評表 each role gets, and which stay on 首頁, is the database's job and is tested in
// tests/db/records.rls.test.ts; here the pages must show those rows faithfully, and the menu its three parts.

type As = 'audit_admin' | 'plant_viewer' | 'coordinator' | 'signer' | 'system_maintainer'

/**
 * Who I am to the mocked database: my role, my 檢視廠區, whether I run a plant, and what 自評表紀錄's label is built
 * from. A plant_viewer is a 一般使用者 with 檢視廠區 (Q153; the 檢視者 role before it).
 */
const ME: Record<As, { audit_role: string; views: string[]; runs: boolean; scope: { all_plants: boolean; plant_ids: string[] } }> = {
  audit_admin: { audit_role: 'audit_admin', views: [], runs: false, scope: { all_plants: true, plant_ids: [] } },
  plant_viewer: { audit_role: 'signer', views: ['p-FQ'], runs: false, scope: { all_plants: false, plant_ids: ['p-FQ'] } },
  coordinator: { audit_role: 'signer', views: [], runs: true, scope: { all_plants: false, plant_ids: ['p-FQ'] } },
  signer: { audit_role: 'signer', views: [], runs: false, scope: { all_plants: false, plant_ids: [] } },
  system_maintainer: { audit_role: 'system_maintainer', views: [], runs: false, scope: { all_plants: true, plant_ids: [] } },
}

const PLANTS = [
  { id: 'p-FQ', factory_code: 'FQ', name: '福清富群' },
  { id: 'p-SY', factory_code: 'SY', name: '台北總公司' },
]

function record(n: number, year: number, plant: 'FQ' | 'SY', closedAt: string | null) {
  const code = `${plant}-${String(n).padStart(2, '0')}`
  return {
    assessment_id: `00000000-0000-4000-8000-${String(year).padStart(4, '0')}${plant === 'FQ' ? '01' : '02'}${String(n).padStart(6, '0')}`,
    year, company_id: plant === 'FQ' ? 'c-FQ' : 'c-SY', company_name: plant === 'FQ' ? '福清富群' : '信錦企業',
    plant_id: `p-${plant}`, factory_code: plant, plant_name: plant === 'FQ' ? '福清富群' : '台北總公司',
    template_code: code, template_name: n === 6 ? '融資循環' : `循環 ${n}`,
    status: closedAt ? 'closed' : 'in_progress', closed_at: closedAt,
  }
}

/** 2026: 40 FQ (every fourth 結案) and 15 SY 簽核中; 2025: 10 FQ, all 結案. 65 in all: two pages of 50. */
const RECORDS = [
  ...Array.from({ length: 40 }, (_, i) => record(i + 1, 2026, 'FQ', i % 4 === 0 ? '2026-10-27T17:00:00+00:00' : null)),
  ...Array.from({ length: 15 }, (_, i) => record(i + 1, 2026, 'SY', null)),
  ...Array.from({ length: 10 }, (_, i) => record(i + 1, 2025, 'FQ', '2025-11-20T02:00:00+00:00')),
]

/** Answers /rest/v1 like PostgREST would; `pastClosed` is how many 往年已結案 首頁 no longer lists. */
async function mockApi(page: Page, as: As, pastClosed = 0) {
  const me = ME[as]
  await page.route('**/rest/v1/**', async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/employee_ref')) return route.fulfill({ json: [{ audit_role: me.audit_role, viewer_plant_ids: me.views }] })
    if (url.pathname.endsWith('/plant_coordinator')) {
      return route.fulfill({ status: 200, headers: { 'content-range': me.runs ? '0-0/1' : '*/0' }, body: '' })
    }
    if (url.pathname.endsWith('/rpc/my_past_closed_count')) return route.fulfill({ json: pastClosed })
    if (url.pathname.endsWith('/plant')) return route.fulfill({ json: PLANTS })
    if (url.pathname.endsWith('/rpc/my_record_scope')) return route.fulfill({ json: me.scope })
    if (url.pathname.endsWith('/assessment_record')) {
      return route.fulfill({ json: as === 'signer' ? RECORDS.slice(0, 3) : as === 'audit_admin' || as === 'system_maintainer' ? RECORDS : RECORDS.filter((r) => r.factory_code === 'FQ') })
    }
    return route.fulfill({ json: [] })
  })
}

async function signIn(page: Page, as: As, pastClosed = 0) {
  await signInAsAuditAdmin(page)
  await mockApi(page, as, pastClosed)
}

/** The menu as its parts: each entry by its test id, a rule between parts as 「|」. */
async function menuOf(page: Page): Promise<string> {
  const menu = page.getByTestId('side-nav').getByRole('menu')
  // The role is fetched after the first paint; wait until the menu has what that role gives.
  await expect(menu.getByTestId('nav-records')).toBeAttached()
  return (
    await menu.locator(':scope > li').evaluateAll((items) => {
      // Entries by their links' test ids, rules by role, the 發出表單 group by its heading's test id (no antd classes).
      const name = (a: Element) => (a.getAttribute('data-testid') ?? '?').slice(4)
      const entry = (li: Element) => name(li.querySelector('a[data-testid^="nav-"]') ?? li)
      const group = (li: Element) => `steps(${[...li.querySelectorAll('a[data-testid^="nav-"]')].map(name).join(' ')})`
      return items.map((li) => (li.getAttribute('role') === 'separator' ? '|' : li.querySelector('[data-testid="nav-steps-title"]') ? group(li) : entry(li)))
    })
  ).join(' ')
}

test('the menu: 首頁, the 發出表單 steps (headed only with two or more), the other settings, then the pages that show data (Q124 (3), Q147)', async ({ page }) => {
  const expected: Record<As, string> = {
    audit_admin: 'home | steps(templates flows assignment launch) | access | records tracking',
    // 進度追蹤 comes with the 檢視廠區, not with a role (Q153): the plain 一般使用者 below has none.
    plant_viewer: 'home | records tracking',
    coordinator: 'home | assignment | records tracking',
    signer: 'home | records',
    // Every page a 稽核主管 has (Q129).
    system_maintainer: 'home | steps(templates flows assignment launch) | access | records tracking',
  }
  for (const [as, menu] of Object.entries(expected) as [As, string][]) {
    await page.unrouteAll()
    await signIn(page, as)
    await page.goto('/records')
    await expect.poll(() => menuOf(page), as).toBe(menu)
    await expect(page.getByTestId('side-nav').getByText('我的工作')).toHaveCount(0)
    await expect(page.getByTestId('side-nav').getByText('管理', { exact: true })).toHaveCount(0)
  }
  // Folded, the rules stay between the icons; the heading goes, the steps' numbers stay as their icons.
  await page.getByTestId('toggle-sider').click()
  await expect(page.getByTestId('toggle-sider')).toHaveAttribute('aria-expanded', 'false')
  expect(await menuOf(page)).toBe('home | templates flows assignment launch | access | records tracking')
})

test('首頁 points from 我參與的 to 自評表紀錄 for the 往年已結案, and says nothing when there are none', async ({ page }) => {
  const asked: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/my_assessment?') && r.method() === 'GET') asked.push(new URL(r.url()).searchParams.get('on_home') ?? '')
  })
  await signIn(page, 'signer', 105)
  await page.goto('/')
  await page.getByTestId('my-tab-all').click()
  // The list itself is cut by the database (on_home), not here.
  expect(asked).toContain('eq.true')
  await expect(page.getByTestId('my-past-closed')).toHaveText('往年已結案的 105 張在「歷年自評表」→')
  await page.getByTestId('my-past-closed').click()
  await expect(page).toHaveURL(/\/records$/)
  await expect(page.getByRole('heading', { name: /歷年自評表/ })).toBeVisible()

  await page.unrouteAll()
  await signIn(page, 'signer', 0)
  await page.goto('/')
  await page.getByTestId('my-tab-all').click()
  await expect(page.getByTestId('my-all-empty')).toBeVisible()
  await expect(page.getByTestId('my-past-closed')).toHaveCount(0)
})

/** The 年度 or 廠區 headings' names, top to bottom. */
const headings = (page: Page, testId: 'record-year' | 'record-plant') => page.getByTestId(testId).getByTestId('record-group-name')

test('自評表紀錄 folds by 年度 and 廠區, filters, and counts each 狀態', async ({ page }) => {
  await signIn(page, 'audit_admin')
  await page.goto('/')
  await page.getByTestId('nav-records').click()
  await expect(page).toHaveURL(/\/records$/)
  await expect(page.getByTestId('records-scope')).toHaveText('全部廠區・全部年度')
  await expect(page.getByText('結案後內容鎖定，可以打開或匯出 PDF。')).toBeVisible()

  for (const [tab, text] of [['all', '全部65'], ['in_progress', '簽核中45'], ['closed', '已結案20']] as const) {
    await expect(page.getByTestId(`records-tab-${tab}`)).toHaveText(text)
  }
  // At first only the newest 年度 is open, down to its 廠區, which are folded (使用者 2026-11-11, option 乙).
  await expect(headings(page, 'record-year')).toHaveText(['2026 年度　55 張', '2025 年度　10 張'])
  await expect(page.getByTestId('record-year').first()).toContainText('簽核中 45・已結案 10')
  await expect(page.getByTestId('record-year').first()).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('record-year').nth(1)).toHaveAttribute('aria-expanded', 'false')
  await expect(headings(page, 'record-plant')).toHaveText(['FQ 福清富群　40 張', 'SY 台北總公司　15 張'])
  await expect(page.getByTestId('record-plant').first()).toContainText('已結案 10')
  await expect(page.getByTestId('record-assessment')).toHaveCount(0)

  await page.getByTestId('record-plant').first().click()
  await expect(page.getByTestId('record-plant').first()).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('record-assessment')).toHaveCount(40)
  const first = page.getByTestId('records-table').getByRole('row').filter({ hasText: 'FQ-01 循環 1' })
  await expect(first).toContainText('已結案')
  // 結案日 in Taipei time: 17:00 UTC is the next morning there.
  await expect(first.getByTestId('record-closed-at')).toHaveText('2026-10-28')
  await expect(first.getByTestId('export-pdf')).toBeVisible()
  await expect(page.getByTestId('records-table').getByRole('row').filter({ hasText: 'FQ-02 循環 2' }).getByTestId('record-closed-at')).toHaveText('—')
  // Folding the 年度 hides its 廠區 too.
  await page.getByTestId('record-year').first().click()
  await expect(page.getByTestId('record-plant')).toHaveCount(0)
  await page.getByTestId('records-expand-all').click()
  await expect(page.getByTestId('record-assessment')).toHaveCount(65)
  await page.getByTestId('records-collapse-all').click()
  await expect(page.getByTestId('record-plant')).toHaveCount(0)
  await expect(page.getByTestId('record-assessment')).toHaveCount(0)

  // A list narrowed to a 範本 opens in full; the tabs count what the filters keep.
  await page.getByTestId('records-template').fill('融資')
  await expect(page.getByTestId('records-tab-all')).toHaveText('全部3')
  await expect(headings(page, 'record-year')).toHaveText(['2026 年度　2 張', '2025 年度　1 張'])
  await expect(page.getByTestId('record-assessment')).toHaveCount(3)
  await page.getByTestId('records-template').fill('')
  await page.getByTestId('records-year').click()
  await page.getByTitle('2025', { exact: true }).last().click()
  await expect(page.getByTestId('records-tab-all')).toHaveText('全部10')
  await page.getByTestId('records-status').getByRole('tab', { name: /簽核中/ }).click()
  await expect(page.getByTestId('records-empty')).toHaveText('沒有符合條件的自評表')

  await page.getByTestId('records-status').getByRole('tab', { name: /全部/ }).click()
  await page.getByTestId('record-plant').first().click()
  await page.getByTestId('record-assessment').first().click()
  await expect(page).toHaveURL(/\/assessments\/00000000-0000-4000-8000-202501000001$/)
})

test('the label beside the title says what one sees, in words', async ({ page }) => {
  const labels: [As, string][] = [
    ['plant_viewer', 'FQ 福清富群・全部年度'],
    ['coordinator', 'FQ 福清富群・全部年度'],
    ['signer', '我參與過的・全部年度'],
    ['system_maintainer', '全部廠區・全部年度'],
  ]
  for (const [as, label] of labels) {
    await page.unrouteAll()
    await signIn(page, as)
    await page.goto('/records')
    await expect(page.getByTestId('records-scope'), as).toHaveText(label)
  }
})

test('on a phone 自評表紀錄 is a list of cards under two rows of filters, nothing wider than the screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await signIn(page, 'audit_admin')
  await page.goto('/records')
  await expect(page.getByTestId('record-plant')).toHaveCount(2)
  await expect(page.getByTestId('record-card')).toHaveCount(0)
  await page.getByTestId('records-expand-all').click()
  await expect(page.getByTestId('record-card')).toHaveCount(65)
  await expect(page.getByTestId('records-table')).toHaveCount(0)
  // 年度、公司 on the first row, 廠區、範本 on the second.
  const [year, company, plant, template] = await Promise.all(
    ['records-year', 'records-company', 'records-plant', 'records-template'].map(async (id) => (await page.getByTestId(id).boundingBox())!),
  )
  const middle = (box: { y: number; height: number }) => box.y + box.height / 2
  expect(Math.abs(middle(year!) - middle(company!))).toBeLessThanOrEqual(1)
  expect(Math.abs(middle(plant!) - middle(template!))).toBeLessThanOrEqual(1)
  expect(plant!.y).toBeGreaterThan(year!.y + year!.height)
  await expect(page.getByTestId('record-card').first()).toContainText('結案 2026-10-28')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
})
