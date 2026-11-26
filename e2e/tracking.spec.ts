import { expect, test, type Page, type Route } from '@playwright/test'
import readXlsxFile from 'read-excel-file/node'
import { expectLanguageButtonsOnOneLine } from './support/languageSwitcher'

// 追蹤總覽 (#14): the matrix, its filters and the Excel export against made-up /rest/v1 answers (no database or
// sign-in needed). Which 自評表 a 稽核管理者 gets and how long each has stayed is the database's job and is tested
// in tests/db/tracking.rls.test.ts; here the page must show those rows faithfully and export what it shows.

const EMPLOYEE = { emp_id: 'ZZ0001', name: '測試稽核管理者', factory_code: 'SY' }

async function signIn(page: Page) {
  const session = {
    oms: { accessToken: '', refreshToken: '', userId: '', email: '' },
    csa: { token: 'not-checked-by-the-mocked-api', expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    employee: EMPLOYEE,
    issuedAt: new Date().toISOString(),
    devLogin: true,
  }
  await page.addInitScript((s) => sessionStorage.setItem('csa.session', s), JSON.stringify(session))
}

const NAMES: Record<string, string> = {
  '02': '採購及付款循環', A: '控制環境', '10.3': '研發循環（沖壓）', '10.4': '研發循環（塑膠）', '13': '董事會議事運作之管理',
}

function row(company: string, plant: string, template: string, over: Record<string, unknown> = {}) {
  return {
    assessment_id: `00000000-0000-4000-8000-${Buffer.from(`${plant}${template}`).toString('hex').padStart(12, '0').slice(-12)}`,
    year: 2027, due_date: '2027-03-31',
    company_id: `c-${company}`, company_name: company, plant_id: `p-${plant}`, factory_code: plant, plant_name: `${plant}廠`,
    template_id: `t-${template}`, template_code: template, template_name: NAMES[template],
    status: 'in_progress', current_step_position: 3, step_count: 10, current_step_name: '部門主管－資材',
    current_signer_emp_id: 'SS140', current_signer_name: '王小明',
    entered_step_at: '2027-01-10T01:30:00+00:00', days_at_step: 5, closed_at: null, stage: 'signing',
    // Past the 匯流 unless a row says otherwise (#99).
    branch_count: 2, branches_done: 2, current_step_branch_unit: null,
    ...over,
  }
}

const closedOn = (at: string) => ({
  status: 'closed', stage: 'closed', current_step_position: 10, current_step_name: '稽核主管', days_at_step: null, entered_step_at: at, closed_at: at,
})

const ROWS_2027 = [
  row('富群', 'FQ', '02'),
  row('富群', 'FQ', 'A', { current_step_position: 1, current_step_name: '自行檢查人員－生管', current_signer_emp_id: 'SSA77', current_signer_name: null, days_at_step: 0, stage: 'filling' }),
  row('富群', 'SY', '02', closedOn('2027-02-17T20:00:00+00:00')),
  // Before the 匯流: 1 of 2 units approved, held up at 資材單位's 部門主管 (#99).
  row('兆利', 'SZ', 'A', { days_at_step: 12, current_step_name: '部門主管－資材單位', current_step_branch_unit: '資材單位', branches_done: 1 }),
  // SZ has two 研發 範本 (like KS 沖壓／塑膠): one cell in the 研發循環 column.
  row('兆利', 'SZ', '10.3', { days_at_step: 3 }),
  row('兆利', 'SZ', '10.4', closedOn('2027-02-20T02:00:00+00:00')),
]
const ROWS_2026 = [row('富群', 'FQ', '02', { year: 2026, ...closedOn('2026-03-01T02:00:00+00:00') })]

/** The 啟用 範本 and the 廠區 each applies to (tracking_template, #86): SY has A and 13 but has not launched them. */
const COMPONENTS: Record<string, string> = { A: 'control_environment' }
const TEMPLATES = Object.entries({ '02': ['FQ', 'SY'], A: ['FQ', 'SY', 'SZ'], '10.3': ['SZ'], '10.4': ['SZ'], '13': ['SY'] }).map(([code, plants]) => ({
  template_id: `t-${code}`, template_code: code, template_name: NAMES[code],
  template_component: COMPONENTS[code] ?? 'control_activities', applies_to: plants.map((p) => `p-${p}`),
}))

type As = 'audit_admin' | 'viewer' | 'coordinator' | 'viewer_coordinator' | 'audit_staff' | 'audit_staff_no_plant' | 'signer'

/**
 * Who I am to the mocked database: `runs` the plants I run as 廠區管理員, `plants` the factory codes it gives me rows
 * for (null: every plant).
 */
const ME: Record<As, { audit_role: string; viewer_plant_ids: string[]; runs: string[]; plants: string[] | null }> = {
  audit_admin: { audit_role: 'audit_admin', viewer_plant_ids: [], runs: [], plants: null },
  viewer: { audit_role: 'viewer', viewer_plant_ids: ['p-FQ'], runs: [], plants: ['FQ'] },
  coordinator: { audit_role: 'signer', viewer_plant_ids: [], runs: ['p-FQ'], plants: ['FQ'] },
  viewer_coordinator: { audit_role: 'viewer', viewer_plant_ids: ['p-SY'], runs: ['p-FQ'], plants: ['FQ', 'SY'] },
  audit_staff: { audit_role: 'audit_staff', viewer_plant_ids: [], runs: ['p-FQ', 'p-SZ'], plants: ['FQ', 'SZ'] },
  audit_staff_no_plant: { audit_role: 'audit_staff', viewer_plant_ids: [], runs: [], plants: [] },
  signer: { audit_role: 'signer', viewer_plant_ids: [], runs: [], plants: [] },
}

/**
 * Answers /rest/v1 like PostgREST would, as a 稽核管理者, as a 檢視者 of FQ (whose rows the database has already
 * narrowed to their 檢視廠區, #58), as a 廠區負責人 (a 一般使用者 who runs FQ, so the same rows as that 檢視者, Q117 (3)),
 * as a 檢視者 of SY who also runs FQ (both plants' rows), as a 稽核人員 who runs FQ and SZ (#187), or as anyone else
 * (who gets no tracking rows).
 */
async function mockApi(page: Page, as: As) {
  const me = ME[as]
  const mine = (plantIds: string[]) => me.plants === null || plantIds.some((id) => me.plants!.includes(id.slice(2)))
  await page.route('**/rest/v1/**', async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/employee_ref')) return route.fulfill({ json: [{ audit_role: me.audit_role, viewer_plant_ids: me.viewer_plant_ids }] })
    // The menu asks with a HEAD count whether I run any plant; 匯出 Excel asks a 稽核人員 which.
    if (url.pathname.endsWith('/plant_coordinator')) {
      if (route.request().method() === 'HEAD') {
        return route.fulfill({ status: 200, headers: { 'content-range': me.runs.length ? `0-0/${me.runs.length}` : '*/0' }, body: '' })
      }
      // Like the policy for a 稽核主管 would, the table also holds someone else's SY: only the emp_id filter keeps it out.
      const rows = [...me.runs.map((plant_id) => ({ emp_id: EMPLOYEE.emp_id, plant_id })), { emp_id: 'ZZ0002', plant_id: 'p-SY' }]
      return route.fulfill({ json: rows.filter((r) => url.searchParams.get('emp_id') === `eq.${r.emp_id}`).map(({ plant_id }) => ({ plant_id })) })
    }
    if (url.pathname.endsWith('/annual_cycle')) return route.fulfill({ json: [{ year: 2027, due_date: '2027-03-31', assessment: [{ count: 6 }] }, { year: 2026, due_date: '2026-03-31', assessment: [{ count: 1 }] }] })
    if (url.pathname.endsWith('/rpc/tracking_template')) {
      return route.fulfill({ json: TEMPLATES.filter((t) => mine(t.applies_to)).map((t) => ({ ...t, applies_to: t.applies_to.filter((id) => mine([id])) })) })
    }
    if (url.pathname.endsWith('/tracking_assessment')) {
      const rows = url.searchParams.get('year') === 'eq.2026' ? ROWS_2026 : ROWS_2027
      return route.fulfill({ json: rows.filter((r) => mine([r.plant_id])) })
    }
    return route.fulfill({ json: [] })
  })
}

/** Pick an option the way a keyboard user would: type into the searchable select, take the match with Enter. */
async function choose(page: Page, select: string, text: string) {
  await page.getByTestId(select).getByRole('combobox').fill(text)
  await page.keyboard.press('Enter')
}

/** A cell by 廠區 and column: a 組成要素 (control_environment, control_activities for 控制作業's total) or a form's name. */
const cell = (page: Page, plant: string, column: string) => page.getByTestId(`tracking-cell-${plant}-${column}`)
const CE = 'control_environment'
const CONTROLS = 'control_activities'
const PURCHASE = '採購及付款循環'
const RND = '研發循環'

/** A 熱度矩陣 cell shows only the 停留天數 (or 已結案／張數); its title carries the full text, one line per line (Q105). */
const fullText = (...lines: string[]) => lines.join('\n')

const expand = (page: Page) => page.getByTestId('tracking-expand-controls').click()

/**
 * The 狀態 filter is a dropdown (方向 A, #128): open it and take the option. antd's options carry no role, only their
 * title; the list opens at the end of the page, after the box that shows the current choice.
 */
async function chooseStatus(page: Page, status: string) {
  await page.getByTestId('tracking-status').click()
  await page.getByTitle(status, { exact: true }).last().click()
}

/** One of the counts above: its label, then its number (方向 A, #128). */
async function expectCount(page: Page, testId: string, label: string, value: number) {
  await expect(page.getByTestId(testId).getByRole('term')).toHaveText(label)
  await expect(page.getByTestId(testId).getByRole('definition')).toHaveText(String(value))
}

/**
 * The matrix as the Excel 總覽 should have it, read from the screen with 控制作業 expanded: the headers' titles, then
 * per 廠區 the row header's title and each cell's title (the full text the cell stands for; empty when the 狀態
 * filter blanks it).
 */
async function matrixOnScreen(page: Page): Promise<string[][]> {
  const grid = page.getByTestId('tracking-matrix')
  const header = await grid
    .locator('[data-testid="tracking-corner"], [data-testid^="tracking-col-"]')
    .evaluateAll((ths) => ths.map((th) => th.getAttribute('title') ?? ''))
  const rows = await grid.locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => [
      tr.querySelector('th')?.getAttribute('title') ?? '',
      ...[...tr.querySelectorAll('[data-testid^="tracking-cell-"]')].map((c) => c.getAttribute('title') ?? ''),
    ]),
  )
  return [header, ...rows]
}

test('a 稽核管理者 opens 追蹤總覽 from the menu and sees where each 自評表 stands, by 組成要素', async ({ page }) => {
  await signIn(page)
  await mockApi(page, 'audit_admin')
  await page.goto('/')
  await page.getByTestId('nav-tracking').click()
  await expect(page).toHaveURL(/\/admin\/tracking$/)

  // Folded: the 組成要素 present, 控制作業 one column of 已結案／張數.
  await expect(page.getByTestId(/^tracking-col-/)).toHaveText(['控制環境', '控制作業'])
  await expect(page.getByTestId(`tracking-col-${CE}`)).toHaveAttribute('title', '一、控制環境')
  await expect(cell(page, 'FQ', CE)).toHaveText('0')
  await expect(cell(page, 'FQ', CE)).toHaveAttribute('title', fullText('A', '填寫中・第 1／10 關 自行檢查人員－生管', 'SSA77', '停留 0 天'))
  await expect(cell(page, 'FQ', CE)).toHaveAttribute('href', `/assessments/${ROWS_2027[1]!.assessment_id}`)
  await expect(cell(page, 'SY', CE)).toHaveAttribute('title', fullText('未發起', 'A'))
  // Before the 匯流 a cell counts the approved units; which 關卡 holds it up is on the 自評表 page (user 2026-11-04).
  await expect(cell(page, 'SZ', CE)).toHaveAttribute('title', fullText('A', '簽核中・已核准 1／2 單位', '王小明（SS140）', '停留 12 天'))
  await expect(cell(page, 'FQ', CONTROLS)).toHaveText('0／1')
  await expect(cell(page, 'FQ', CONTROLS)).toHaveAttribute('title', fullText('已結案 0／1', '02：簽核中・第 3／10 關 部門主管－資材 停留 5 天'))
  await expect(cell(page, 'SY', CONTROLS)).toHaveAttribute('title', fullText('已結案 1／1', '13：未發起'))
  await expect(cell(page, 'SZ', CONTROLS)).toHaveText('1／2')
  await expect(cell(page, 'FQ', PURCHASE)).toHaveCount(0)

  await expectCount(page, 'tracking-kpi-total', '自評表（3 廠區 × 4 題庫） · 未發起 2 份', 6)
  await expectCount(page, 'tracking-kpi-in-progress', '進行中', 4)
  await expectCount(page, 'tracking-kpi-closed', '已結案（33%）', 2)
  // SZ/A has stayed 12 days: past the first threshold (7), not the second (14)
  await expectCount(page, 'tracking-kpi-long', '停留 ≥ 7 天（其中 ≥ 14 天 0）', 1)

  // Expanded: a column per form, kept in the address. 控制作業 heads a group over 合計 and its forms, the other
  // 組成要素 spanning both header rows (#128).
  await expand(page)
  await expect(page).toHaveURL(/\?controls=open$/)
  await expect(page.getByTestId('tracking-expand-controls')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId(/^tracking-col-/)).toHaveText(['控制環境', '控制作業', '採購', '研發', '董事會'])
  await expect(page.getByTestId(`tracking-col-${CONTROLS}`)).toHaveAttribute('colspan', '4')
  await expect(page.getByTestId(`tracking-col-${CE}`)).toHaveAttribute('rowspan', '2')
  await expect(page.getByRole('columnheader', { name: '合計' })).toBeVisible()
  await expect(page.getByTestId(`tracking-col-${PURCHASE}`)).toHaveAttribute('title', PURCHASE)
  await expect(cell(page, 'FQ', PURCHASE)).toHaveText('5')
  await expect(cell(page, 'FQ', PURCHASE)).toHaveAttribute('title', fullText('02', '簽核中・第 3／10 關 部門主管－資材', '王小明（SS140）', '停留 5 天'))
  await expect(cell(page, 'FQ', PURCHASE)).toHaveAccessibleName(fullText('02', '簽核中・第 3／10 關 部門主管－資材', '王小明（SS140）', '停留 5 天'))
  await expect(cell(page, 'SY', PURCHASE)).toHaveAttribute('title', fullText('02', '已結案', '2027-02-18'))
  // 不適用 (SZ has no 02) is a dash and not counted; 未發起 (SY has 13 but has not launched it) is.
  await expect(cell(page, 'SZ', PURCHASE)).toHaveAttribute('title', '不適用')
  await expect(cell(page, 'SZ', PURCHASE)).toHaveText('—')
  await expect(cell(page, 'SY', '董事會議事運作之管理')).toHaveAttribute('title', fullText('未發起', '13'))
  // SZ's two 研發 範本 share one cell (a form's narrow column writes the share with a half-width slash); choosing one
  // opens it.
  await expect(cell(page, 'SZ', RND)).toHaveText('1/2')
  await expect(cell(page, 'SZ', RND)).toHaveAttribute('title', fullText('已結案 1／2', '10.3：簽核中・第 3／10 關 部門主管－資材 停留 3 天', '10.4：已結案 2027-02-20'))
  await cell(page, 'SZ', RND).click()
  await page.getByTestId('tracking-pick-10.4').click()
  await expect(page).toHaveURL(`/assessments/${ROWS_2027[5]!.assessment_id}`)
  await page.goBack()
  await expect(cell(page, 'SZ', RND)).toBeVisible()

  await expand(page)
  await expect(page).toHaveURL(/\/admin\/tracking$/)
  await expect(cell(page, 'SZ', RND)).toHaveCount(0)
})

test('the filters narrow the matrix, and the 年度 switches to that year\'s 自評表', async ({ page }) => {
  await signIn(page)
  await mockApi(page, 'audit_admin')
  await page.goto('/admin/tracking?controls=open')
  await expect(cell(page, 'SZ', CE)).toBeVisible()

  // Each filter is named by its label (方向 A lays them out inline, #128).
  await expect(page.getByRole('combobox', { name: '狀態' })).toBeVisible()
  await chooseStatus(page, '已結案')
  await expect(cell(page, 'SY', PURCHASE)).toHaveAttribute('title', fullText('02', '已結案', '2027-02-18'))
  await expect(cell(page, 'FQ', PURCHASE)).toHaveCount(0)
  // No 已結案 控制環境 left, so no column; SZ's 研發 cell keeps only its 結案 one, and SY has no 研發 at all.
  await expect(cell(page, 'SZ', CE)).toHaveCount(0)
  await expect(cell(page, 'SZ', RND)).toHaveAttribute('title', fullText('10.4', '已結案', '2027-02-20'))
  await expect(cell(page, 'SY', RND)).toHaveAttribute('title', '不適用')

  await chooseStatus(page, '全部')
  // 公司 options read like the 廠區 ones (「SZ SZ廠」), not the 公司's full name (725ad45).
  await choose(page, 'tracking-company', 'SZ SZ廠')
  await expect(cell(page, 'SZ', CE)).toBeVisible()
  await expect(cell(page, 'FQ', PURCHASE)).toHaveCount(0)

  await page.reload()
  await choose(page, 'tracking-plant', 'SY SY廠')
  await page.keyboard.press('Escape')
  await expect(cell(page, 'SY', PURCHASE)).toBeVisible()
  await expect(cell(page, 'FQ', PURCHASE)).toHaveCount(0)

  await choose(page, 'tracking-year', '2026')
  await expect(cell(page, 'FQ', PURCHASE)).toHaveAttribute('title', fullText('02', '已結案', '2026-03-01'))
})

test('匯出 Excel writes the matrix expanded, filters applied, plus one 明細 row per 自評表 shown', async ({ page }) => {
  await signIn(page)
  await mockApi(page, 'audit_admin')
  await page.goto('/admin/tracking')
  await chooseStatus(page, '進行中')
  await expect(cell(page, 'SY', CONTROLS)).toHaveCount(0)

  // Exported while folded: the 總覽 still has every form (Q105 (4) compares it with the screen expanded).
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tracking-export').click()])
  expect(download.suggestedFilename()).toBe('進度追蹤_2027.xlsx')
  const sheets = await readXlsxFile(await download.path())
  expect(sheets.map((s) => s.sheet)).toEqual(['總覽', '明細'])
  const overview = sheets[0]!.data.map((r) => r.map((c) => (c === null ? '' : String(c))))
  await expand(page)
  await expect(cell(page, 'FQ', PURCHASE)).toBeVisible()
  expect(overview).toEqual(await matrixOnScreen(page))
  expect(overview[0]).toEqual(['公司／廠區', '一、控制環境', '三、控制作業', PURCHASE, RND])
  // 明細 has no 範本版本 column (one template per 編號, Q137 (4)).
  expect(sheets[1]!.data[0]).toEqual([
    '年度', '公司', '廠區', '廠區代碼', '題庫編號', '題庫名稱', '狀態', '目前關卡', '總關數', '關卡名稱', '簽核人工號', '簽核人姓名',
    '進入目前關卡（台北時間）', '停留天數', '結案日期', '截止日',
  ])
  expect(sheets[1]!.data.slice(1).map((r) => `${r[3]}/${r[4]}/${r[13] ?? ''}`)).toEqual(['FQ/A/0', 'FQ/02/5', 'SZ/A/12', 'SZ/10.3/3'])
})

test('待處理優先 groups by 廠區, each 廠區 longest 停留 first, with the same filters and Excel', async ({ page }) => {
  await signIn(page)
  await mockApi(page, 'audit_admin')
  await page.goto('/admin/tracking')
  await page.getByTestId('tracking-view').getByText('待處理優先').click()
  await expect(page).toHaveURL(/\?view=queue$/)
  await expect(page.getByTestId('tracking-matrix')).toHaveCount(0)

  // 廠區 in the matrix order, all folded, each heading with all three counts; SZ/A has stayed 12 days.
  const plant = (code: string) => page.getByTestId(`tracking-plant-${code}`)
  await expect(page.getByTestId(/^tracking-plant-[A-Z]+$/)).toHaveCount(3)
  await expect(page.getByTestId(/^tracking-plant-[A-Z]+$/).first()).toContainText('FQ　FQ廠')
  await expect(plant('SZ')).toContainText('進行中 2· ≥ 7 天 1（≥ 14 天 0）· 已結案 1／3')
  await expect(page.getByTestId('tracking-queue').getByRole('row')).toHaveCount(0)
  await plant('SZ').getByRole('button', { name: /SZ廠/ }).click()
  await expect(plant('SZ').getByTestId('tracking-queue-SZ-A')).toHaveAttribute('href', `/assessments/${ROWS_2027[3]!.assessment_id}`)
  await expect(plant('SZ').getByRole('row').nth(1)).toContainText('12')
  // 目前關卡 is the 關卡's name alone (user 2026-11-04, #99): before the 匯流 with its unit, after it as it is.
  await expect(plant('SZ').getByRole('row').nth(1)).toContainText('資材單位・部門主管')
  await expect(plant('SZ').getByRole('row').nth(2)).toContainText('部門主管－資材')
  await expect(plant('SZ')).not.toContainText('第 3／10 關')
  await expect(plant('FQ')).toContainText('進行中 2· ≥ 7 天 0（≥ 14 天 0）· 已結案 0／2')
  await plant('FQ').getByRole('button', { name: /FQ廠/ }).click()
  await expect(plant('FQ').getByTestId(/^tracking-queue-/)).toHaveText(['02 採購及付款循環', 'A 控制環境'])

  await plant('SY').getByRole('button', { name: /SY廠/ }).click()
  await expect(plant('SY').getByTestId('tracking-plant-SY-closed')).toContainText('已結案 1 張')
  await plant('SY').getByTestId('tracking-plant-SY-closed').getByRole('button').click()
  await expect(plant('SY').getByTestId('tracking-queue-SY-02')).toBeVisible()
  await expect(plant('SY')).toContainText('2027-02-18')

  await choose(page, 'tracking-company', 'SZ SZ廠')
  await expect(page.getByTestId(/^tracking-plant-[A-Z]+$/)).toHaveCount(1)
  // A new filter folds the 廠區 again.
  await expect(page.getByTestId(/^tracking-queue-/)).toHaveCount(0)
  await plant('SZ').getByRole('button', { name: /SZ廠/ }).click()
  await expect(page.getByTestId(/^tracking-queue-/)).toHaveCount(2)
  await expectCount(page, 'tracking-kpi-total', '自評表（1 廠區 × 2 題庫）', 3)

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tracking-export').click()])
  const sheets = await readXlsxFile(await download.path())
  expect(sheets[1]!.data.slice(1).map((r) => `${r[3]}/${r[4]}`)).toEqual(['SZ/A', 'SZ/10.3', 'SZ/10.4'])
})

test('the side menu folds to its icons, every page and reload keeps it folded, and its links still work', async ({ page }) => {
  await signIn(page)
  await mockApi(page, 'audit_admin')
  await page.goto('/admin/tracking')
  // No top bar on a wide screen (Q114): who is signed in sits at the menu's foot, in the window; clicking it opens
  // the language, 回 SyncHub and 登出 (Q114 (7)).
  await expect(page.getByTestId('top-bar')).toHaveCount(0)
  const sider = page.getByTestId('side-nav')
  await expect(sider.getByTestId('signed-in-as')).toContainText('測試稽核管理者（ZZ0001）')
  await expect(sider.getByTestId('account-menu')).toBeInViewport({ ratio: 1 })
  await expect(page.getByTestId('logout')).toHaveCount(0)
  await sider.getByTestId('account-menu').click()
  for (const id of ['language-switcher', 'back-to-synchub', 'logout']) await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
  // In English the two language buttons stay on one line and the longer role name keeps the row's height (#117).
  const rowHeight = (await sider.getByTestId('signed-in-as').boundingBox())!.height
  await page.getByTestId('language-switcher').getByText('English').click()
  await expect(sider.getByTestId('signed-in-as')).toContainText('Audit administrator')
  await expectLanguageButtonsOnOneLine(page)
  expect((await sider.getByTestId('signed-in-as').boundingBox())!.height).toBeCloseTo(rowHeight, 0)
  await page.getByTestId('language-switcher').getByText('繁中').click()
  await page.getByTestId('toggle-sider').click()
  await expect(page.getByTestId('toggle-sider')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('signed-in-as')).toHaveCount(0)
  // Folded, the foot is the avatar alone, opening the same menu; the language still switches.
  await expect(sider.getByTestId('account-menu')).toHaveAccessibleName('帳號選單：測試稽核管理者（ZZ0001）')
  await sider.getByTestId('account-menu').click()
  await expect(page.getByTestId('logout')).toBeVisible()
  await page.getByTestId('language-switcher').getByText('English').click()
  await expect(page.getByTestId('toggle-sider')).toHaveAccessibleName('Expand menu')
  await expectLanguageButtonsOnOneLine(page)
  await page.getByTestId('language-switcher').getByText('繁中').click()
  await expect(page.getByTestId('toggle-sider')).toHaveAccessibleName('展開選單')
  await page.reload()
  await expect(page.getByTestId('toggle-sider')).toHaveAttribute('aria-expanded', 'false')
  // Folded or not, the button is a small circle on the menu's right edge, level with 「CSA」 (使用者 2026-11-09, #119).
  const mark = (await sider.getByRole('link', { name: /^CSA/ }).boundingBox())!
  const button = (await page.getByTestId('toggle-sider').boundingBox())!
  const menu = (await sider.boundingBox())!
  expect(Math.abs(button.x + button.width / 2 - (menu.x + menu.width))).toBeLessThanOrEqual(2)
  expect(Math.abs(button.y + button.height / 2 - (mark.y + mark.height / 2))).toBeLessThanOrEqual(2)
  // Folded, the item shows only its icon; clicking it still follows the link (and its name is still the label).
  await page.getByRole('menuitem', { name: /人員管理/ }).click()
  await expect(page).toHaveURL(/\/admin\/access$/)
  // The URL changes at once, but react-router renders the new page as a transition, so 追蹤總覽 can stay on screen a
  // moment longer (about 400ms on CI). Each page has its own AppShell: wait for 權限管理 itself, or the clicks below
  // reach the old menu, which then leaves the page under them.
  await expect(page.getByRole('heading', { name: '人員管理' })).toBeVisible()
  await expect(page.getByTestId('toggle-sider')).toHaveAttribute('aria-expanded', 'false')
  await page.getByTestId('toggle-sider').click()
  await expect(page.getByTestId('signed-in-as')).toBeVisible()
  // Unfolded, the menu widens and the button stays on its edge (not measurable yet: try again).
  await expect.poll(async () => {
    const edge = await sider.boundingBox()
    const circle = await page.getByTestId('toggle-sider').boundingBox()
    return edge && circle ? Math.abs(circle.x + circle.width / 2 - (edge.x + edge.width)) : Infinity
  }).toBeLessThanOrEqual(2)
})

test('on a phone a slim bar opens the menu, whose foot opens the language, 回 SyncHub and 登出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  await mockApi(page, 'audit_admin')
  await page.goto('/admin/tracking')
  await expect(page.getByTestId('top-bar')).toBeVisible()
  await expect(page.getByTestId('logout')).toHaveCount(0)
  await page.getByTestId('open-menu').click()
  const drawer = page.getByTestId('side-nav')
  await expect(drawer.getByTestId('signed-in-as')).toBeVisible()
  // In the window, not below it: the menu's padding once pushed the foot past the drawer's bottom.
  await expect(drawer.getByTestId('account-menu')).toBeInViewport({ ratio: 1 })
  await drawer.getByTestId('account-menu').click()
  for (const id of ['language-switcher', 'back-to-synchub', 'logout']) await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
  await expect(drawer.getByTestId('toggle-sider')).toHaveCount(0)
})

test('anyone who is not a 稽核管理者 has no 追蹤總覽: no menu link, and the page has nothing to show', async ({ page }) => {
  await signIn(page)
  await mockApi(page, 'signer')
  await page.goto('/')
  await expect(page.getByTestId('greeting')).toBeVisible()
  await expect(page.getByTestId('nav-tracking')).toHaveCount(0)

  await page.goto('/admin/tracking')
  await expect(page.getByText('沒有符合條件的自評表')).toBeVisible()
  await expect(page.getByTestId('tracking-matrix')).toHaveCount(0)
  await expect(page.getByTestId('tracking-export')).toHaveCount(0)
})

test('a 檢視者 (#58) opens 追蹤總覽 from the menu and sees the 檢視廠區 the database gives them, but no admin pages', async ({ page }) => {
  await signIn(page)
  await mockApi(page, 'viewer')
  await page.goto('/')
  await expect(page.getByTestId('nav-templates')).toHaveCount(0)
  await expect(page.getByTestId('nav-access')).toHaveCount(0)
  await page.getByTestId('nav-tracking').click()
  await expect(cell(page, 'FQ', CE)).toBeVisible()
  await expect(cell(page, 'SY', CE)).toHaveCount(0)
  await expect(page.getByTestId('tracking-export')).toBeVisible()
})

test('a 廠區負責人 (Q117 (3)) opens 追蹤總覽 for the plant they run, but cannot export it to Excel', async ({ page }) => {
  await signIn(page)
  await mockApi(page, 'coordinator')
  await page.goto('/')
  await expect(page.getByTestId('nav-access')).toHaveCount(0)
  await page.getByTestId('nav-tracking').click()
  await expect(cell(page, 'FQ', CE)).toBeVisible()
  await expect(cell(page, 'SY', CE)).toHaveCount(0)
  await expect(page.getByTestId('tracking-export')).toHaveCount(0)
})

test('a 稽核人員 who runs plants (#187) opens 追蹤總覽 for them and exports them to Excel, under the filters', async ({ page }) => {
  await signIn(page)
  await mockApi(page, 'audit_staff')
  await page.goto('/')
  await expect(page.getByTestId('nav-access')).toHaveCount(0)
  await page.getByTestId('nav-tracking').click()
  await expect(cell(page, 'FQ', CE)).toBeVisible()
  await expect(cell(page, 'SZ', CE)).toBeVisible()
  await expect(cell(page, 'SY', CE)).toHaveCount(0)

  const exportSheets = async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tracking-export').click()])
    return readXlsxFile(await download.path())
  }
  let sheets = await exportSheets()
  expect(sheets[0]!.data.slice(1).map((r) => r[0])).toEqual(['富群 FQ廠（FQ）', '兆利 SZ廠（SZ）'])
  expect(new Set(sheets[1]!.data.slice(1).map((r) => r[3]))).toEqual(new Set(['FQ', 'SZ']))

  await choose(page, 'tracking-plant', 'SZ')
  await page.keyboard.press('Escape')
  await expect(cell(page, 'FQ', CE)).toHaveCount(0)
  sheets = await exportSheets()
  expect(sheets[0]!.data.slice(1).map((r) => r[0])).toEqual(['兆利 SZ廠（SZ）'])
})

test('a 稽核人員 who runs no plant is a 一般使用者 here (#187): no 追蹤總覽, nothing to export', async ({ page }) => {
  await signIn(page)
  await mockApi(page, 'audit_staff_no_plant')
  await page.goto('/')
  await expect(page.getByTestId('greeting')).toBeVisible()
  await expect(page.getByTestId('nav-tracking')).toHaveCount(0)
  await page.goto('/admin/tracking')
  await expect(page.getByText('沒有符合條件的自評表')).toBeVisible()
  await expect(page.getByTestId('tracking-export')).toHaveCount(0)
})

test('a 檢視者 who also runs a plant sees both on screen, but 匯出 Excel holds only the 檢視廠區 (user 2026-11-03)', async ({ page }) => {
  await signIn(page)
  await mockApi(page, 'viewer_coordinator')
  await page.goto('/admin/tracking')
  await expect(cell(page, 'FQ', CE)).toBeVisible()
  await expect(cell(page, 'SY', CE)).toBeVisible()

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tracking-export').click()])
  const sheets = await readXlsxFile(await download.path())
  expect(sheets[0]!.data.slice(1).map((r) => r[0])).toEqual(['富群 SY廠（SY）'])
  expect(sheets[1]!.data.slice(1).map((r) => r[3])).toEqual(['SY'])

  // Narrowed to the plant they only run, there is nothing to export.
  await choose(page, 'tracking-plant', 'FQ')
  await page.keyboard.press('Escape')
  await expect(cell(page, 'SY', CE)).toHaveCount(0)
  await expect(page.getByTestId('tracking-export')).toHaveCount(0)
})
