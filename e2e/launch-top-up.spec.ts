import { expect, test, type Page, type Request, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 年度發起的廠區篩選與同年度補發 (#115, Q119): only the chosen 廠區' combinations are shown, counted and sent; a year that
// already has its 年度作業 is topped up with what is left, keeping its 截止日; a year with nothing left cannot be launched.
// Every /rest/v1 answer is made up here; what the database does is in tests/db/launch.rls.test.ts.

const THIS_YEAR = new Date().getFullYear()
const DUE = `${THIS_YEAR}-12-31`
const READY = { ready: true, no_steps: false, no_merge_steps: false, missing_units: [], unused_units: [], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [] }
const PLANTS = { FQ: '福清富群', GT: '敬得(觀音)', TC: '敬得(太倉)' } as const

function candidate(template: string, plant: keyof typeof PLANTS, launchedYears: number[] = [], problem: string | null = null) {
  return {
    template_id: `t-${template}`, template_code: `${plant}-${template}`, template_name: `${template} 循環`,
    plant_id: `p-${plant}`, factory_code: plant, plant_name: PLANTS[plant],
    route_id: problem === 'no_route' ? null : `r-${template}-${plant}`, step_count: problem === 'no_route' ? 0 : 8,
    problem, launch_check: problem === 'no_route' ? null : READY, launched_years: launchedYears,
  }
}

/** FQ went out first this year; GT and TC are still to come, and TC's 04 has no route. */
const PART_LAUNCHED = [
  candidate('01', 'FQ', [THIS_YEAR]), candidate('02', 'FQ', [THIS_YEAR]),
  candidate('01', 'GT'), candidate('02', 'GT'),
  candidate('01', 'TC'), candidate('04', 'TC', [], 'no_route'),
]

async function mockApi(page: Page, candidates: unknown[], cycles: unknown[]): Promise<Request[]> {
  const launches: Request[] = []
  await page.route('**/rest/v1/**', async (r: Route) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/employee_ref')) return r.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/rpc/launch_candidates')) return r.fulfill({ json: candidates })
    if (path.endsWith('/annual_cycle')) return r.fulfill({ json: cycles })
    if (path.endsWith('/rpc/launch_signers')) return r.fulfill({ json: [] })
    if (path.endsWith('/rpc/launch_annual_cycle')) {
      launches.push(request)
      return r.fulfill({ json: { ok: true, cycle_id: 'c1', top_up: true, due_date: DUE, assessments: 2, checked: true } })
    }
    return r.fulfill({ json: [] })
  })
  return launches
}

const rowOf = (page: Page, code: string) => page.getByTestId('launch-table').getByRole('row').filter({ hasText: code })

/** 年度發起's 年度 menu (#175, Q137 (2)): a launched year is 「（已發起）」 on it, the next one 「（下次發起）」. */
async function chooseYear(page: Page, label: string) {
  await page.getByTestId('year-select').click()
  await page.getByRole('option', { name: label }).click()
}

test('tops up this year with one 廠區 only, keeping the year\'s 截止日', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const launches = await mockApi(page, PART_LAUNCHED, [{ year: THIS_YEAR, due_date: DUE, assessment: [{ count: 2 }] }])
  await page.goto('/admin/launch')

  // The default is the next year to launch (#175); this year, launched in part, is chosen for its top-up, with its
  // 截止日 shown and not editable and a note that a top-up issues the current templates and routes.
  await expect(page.getByTestId('year-select')).toContainText(`${THIS_YEAR + 1}（下次發起）`)
  await chooseYear(page, `${THIS_YEAR}（已發起）`)
  await expect(page.getByTestId('year-note')).toHaveText(
    `${THIS_YEAR} 年度已發起：補發會用目前的題庫與簽核流程（就是下次發起要用的內容）。`,
  )
  await expect(page.getByTestId('already-launched')).toContainText(`${THIS_YEAR} 年度已發起 2 張（截止 ${DUE}）`)
  await expect(page.getByTestId('launch-due-kept')).toContainText(`${DUE}（沿用 ${THIS_YEAR} 年度，不能改）`)
  await expect(page.getByTestId('launch-due')).toHaveCount(0)

  // FQ's are 已發起 and cannot be checked; TC's 04 without a route is checked and blocks everything.
  await expect(rowOf(page, 'FQ-01').getByTestId('candidate-launched')).toHaveText('已發起')
  await expect(rowOf(page, 'FQ-01').getByRole('checkbox')).toBeDisabled()
  await expect(page.getByTestId('launch-count')).toHaveText('全部廠區　已勾選 4／4 個組合')
  await expect(page.getByTestId('launch-blocked')).toBeVisible()
  // A 範本 is its 編號 and 名稱, no version; a combination without a route says so (Q137).
  await expect(rowOf(page, 'TC-04')).toContainText('TC-04 04 循環')
  await expect(rowOf(page, 'TC-04')).toContainText('沒有簽核流程')
  await expect(page.getByTestId('launch-submit')).toBeDisabled()

  // Choosing GT shows, counts and launches GT's alone; TC's missing route no longer blocks.
  await page.getByTestId('launch-plants').getByRole('combobox').fill('GT')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('launch-table').getByRole('row')).toHaveCount(3) // header + 2
  await expect(page.getByTestId('launch-count')).toHaveText('GT 敬得(觀音)　已勾選 2／2 個組合')
  await expect(page.getByTestId('launch-blocked')).toHaveCount(0)
  await expect(page.getByTestId('launch-submit')).toHaveText(`補發 ${THIS_YEAR} 年度（2 張自評表）`)

  await page.getByTestId('launch-submit').click()
  await expect(page.getByTestId('launch-confirm')).toContainText('發起範圍：GT 敬得(觀音) 2 張')
  await expect(page.getByTestId('launch-confirm')).toContainText(`共 2 張自評表，截止日 ${DUE}（沿用 ${THIS_YEAR} 年度）`)
  await page.getByRole('dialog').getByRole('button', { name: '補發', exact: true }).click()

  await expect(page.getByTestId('launch-outcome')).toContainText(`已補發 ${THIS_YEAR} 年度：2 張自評表（GT 敬得(觀音) 2 張），截止日沿用 ${DUE}`)
  expect(launches).toHaveLength(1)
  expect(launches[0]!.postDataJSON()).toMatchObject({
    p_year: THIS_YEAR,
    p_due_date: DUE,
    p_combos: [{ template_id: 't-01', plant_id: 'p-GT' }, { template_id: 't-02', plant_id: 'p-GT' }],
  })
})

test('a year with every combination launched cannot be launched again; the default is the next year', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const all = [candidate('01', 'FQ', [THIS_YEAR]), candidate('01', 'GT', [THIS_YEAR])]
  await mockApi(page, all, [{ year: THIS_YEAR, due_date: DUE, assessment: [{ count: 2 }] }])
  await page.goto('/admin/launch')

  // The next year has no 年度作業 yet: a first launch, with a 截止日 to pick.
  await expect(page.getByTestId('year-select')).toContainText(`${THIS_YEAR + 1}（下次發起）`)
  await expect(page.getByTestId('launch-due')).toBeVisible()
  await expect(page.getByTestId('launch-submit')).toHaveText(`發起 ${THIS_YEAR + 1} 年度（2 張自評表）`)

  await chooseYear(page, `${THIS_YEAR}（已發起）`)
  await expect(page.getByTestId('year-full')).toContainText(`${THIS_YEAR} 年度的組合都已發起`)
  await expect(page.getByTestId('candidate-launched')).toHaveCount(2)
  await expect(page.getByTestId('launch-submit')).toBeDisabled()
  await expect(page.getByTestId('launch-submit')).toHaveText(`補發 ${THIS_YEAR} 年度（0 張自評表）`)

  // Nothing is 可發起 any more: the filter says so rather than that there is nothing to launch at all.
  await page.getByTestId('launch-status').getByRole('tab', { name: /^可發起/ }).click()
  await expect(page.getByTestId('launch-table')).toContainText('沒有符合篩選的組合。')
})

test('the 狀態 filter shows only the 可發起 ones and launches just those', async ({ page }) => {
  await signInAsAuditAdmin(page)
  const launches = await mockApi(page, PART_LAUNCHED, [{ year: THIS_YEAR, due_date: DUE, assessment: [{ count: 2 }] }])
  await page.goto('/admin/launch')
  await chooseYear(page, `${THIS_YEAR}（已發起）`)

  // Each tab counts the combinations of the chosen 廠區: 3 可發起, TC's 04 流程有問題, FQ's 2 已發起.
  const tabs = page.getByTestId('launch-status').getByRole('tab')
  await expect(tabs).toHaveText(['全部6', '可發起3', '流程有問題1', '已發起2'])
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('launch-status').getByRole('tab', { name: /^可發起/ }).click()

  // TC's 04 without a route is hidden, so it no longer blocks; nor is it sent.
  await expect(page.getByTestId('launch-table').getByRole('row')).toHaveCount(4) // header + 3
  await expect(page.getByTestId('candidate-ready')).toHaveCount(3)
  await expect(page.getByTestId('launch-count')).toHaveText('全部廠區・可發起　已勾選 3／3 個組合')
  await expect(page.getByTestId('launch-blocked')).toHaveCount(0)

  await page.getByTestId('launch-submit').click()
  await expect(page.getByTestId('launch-confirm')).toContainText('發起範圍：GT 敬得(觀音) 2 張、TC 敬得(太倉) 1 張')
  await page.getByRole('dialog').getByRole('button', { name: '補發', exact: true }).click()
  await expect(page.getByTestId('launch-outcome')).toBeVisible()
  expect(launches[0]!.postDataJSON().p_combos).toEqual([
    { template_id: 't-01', plant_id: 'p-GT' },
    { template_id: 't-02', plant_id: 'p-GT' },
    { template_id: 't-01', plant_id: 'p-TC' },
  ])
})

test('after a first launch the 年度 menu moves on to the next year, and 範本管理 has no 年度 (#175, Q137)', async ({ page }) => {
  await signInAsAuditAdmin(page)
  let cycles: unknown[] = []
  await page.route('**/rest/v1/**', async (r: Route) => {
    const path = new URL(r.request().url()).pathname
    if (path.endsWith('/employee_ref')) return r.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/rpc/launch_candidates')) return r.fulfill({ json: [candidate('01', 'GT', cycles.length ? [THIS_YEAR] : [])] })
    if (path.endsWith('/annual_cycle')) return r.fulfill({ json: cycles })
    if (path.endsWith('/rpc/launch_annual_cycle')) {
      cycles = [{ year: THIS_YEAR, due_date: '2099-12-31', assessment: [{ count: 1 }] }]
      return r.fulfill({ json: { ok: true, cycle_id: 'c1', top_up: false, due_date: '2099-12-31', assessments: 1, checked: true } })
    }
    return r.fulfill({ json: [] })
  })
  await page.goto('/admin/launch')

  // Nothing launched yet: this year is the next one, launched for the first time with a 截止日 to pick.
  await expect(page.getByTestId('year-select')).toContainText(`${THIS_YEAR}（下次發起）`)
  await expect(page.getByTestId('year-note')).toHaveText(
    '發起時會把題庫與簽核流程目前的內容凍結進每張自評表；之後再改題庫與流程，只影響下一次發起與補發。',
  )
  await page.locator('[data-testid="launch-due"] input, input[data-testid="launch-due"]').fill('2099-12-31')
  await page.keyboard.press('Enter')
  await page.getByTestId('launch-submit').click()
  await page.getByRole('dialog').getByRole('button', { name: '發起', exact: true }).click()

  // The page stays on the year it launched, now a top-up, with the outcome; the menu has gained the next year.
  await expect(page.getByTestId('launch-outcome')).toBeVisible()
  await expect(page.getByTestId('year-select')).toContainText(`${THIS_YEAR}（已發起）`)
  await expect(page.getByTestId('year-note')).toContainText('補發會用目前的題庫與簽核流程')
  await page.getByTestId('year-select').click()
  await expect(page.getByRole('option')).toHaveText([`${THIS_YEAR + 1}（下次發起）`, `${THIS_YEAR}（已發起）`])
  await page.keyboard.press('Escape')

  await expect(page.getByTestId('year-bar')).toHaveAttribute('data-launched', 'true')

  // 範本管理 has no 年度 (Q137 (2)): it edits the templates themselves, for the next launch and top-ups.
  await page.getByRole('link', { name: '題庫管理' }).click()
  await expect(page.getByTestId('next-launch-note')).toBeVisible()
  await expect(page.getByTestId('year-select')).toHaveCount(0)
})
