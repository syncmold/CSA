import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 自評表作答時跳到未填與只看我的題目（#134）。登入的人是品保單位的自行檢查人員：第 1 章前 8 題、第 2 章整章是資材
// 單位的，自己的 4 題散在第 1、3 章，第 1 題已答。/rest/v1 的回應都在這裡假造，不需要資料庫與登入。

const MINE = '品保單位'
type Units = string[]
type Saved = Record<string, { design: string | null; execution: string | null; satisfaction: string | null }>

const DONE = { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }
/** Row 1 answered; row 3-3 has only 內控設計, so it is still unanswered. */
const PARTLY_DONE: Saved = { 'p1:品保單位': DONE, 'r3:品保單位': { design: 'no_rule', execution: null, satisfaction: null } }
const point = (id: string, position: number, units: Units, saved: Saved) => ({
  id,
  position,
  code: null,
  text: `控制要點 ${id}：是否依既定之作業程序確實遵循並留存紀錄？`,
  assessment_control_point_unit: units.map((name, i) => ({
    position: i + 1,
    assessing_unit_name: name,
    assessment_answer: saved[`${id}:${name}`] ? { ...saved[`${id}:${name}`], improvement: null } : null,
  })),
})
const filler = (prefix: string, count: number, saved: Saved) =>
  Array.from({ length: count }, (_, i) => point(`${prefix}${i + 1}`, i + 1, ['資材單位'], saved))

/**
 * The 自評表 with `saved` answers, and 品保單位's 整體結論 chosen when `concluded`; `steps` are the signed-in employee's
 * current 關卡 (none: they only read it).
 */
function assessment({
  saved = PARTLY_DONE,
  concluded = false,
  steps = 'answer',
  status = 'in_progress',
}: { saved?: Saved; concluded?: boolean; steps?: 'answer' | 'sign' | 'none'; status?: string } = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000134',
    template_code: '04',
    template_name: '存貨循環',
    template_layout: 'control_activity',
    status,
    current_step_position: 1,
    my_current_steps:
      steps === 'answer'
        ? [{ position: 2, name: `自行檢查人員－${MINE}`, branch_unit_name: MINE, editable_unit_name: MINE, return_targets: [], closes: false }]
        : steps === 'sign'
          ? [{ position: 4, name: '稽核主管', branch_unit_name: null, editable_unit_name: null, return_targets: [1, 2], closes: true }]
          : [],
    can_approve: steps === 'sign',
    plant: { factory_code: 'FQ', name: '福清富群' },
    annual_cycle: { year: 2026, due_date: '2026-12-31' },
    pdf_company: { company: { name: '福清富群電子有限公司', logo_path: null } },
    assessment_section: [
      {
        id: 's1',
        position: 1,
        level: 1,
        code: null,
        name: '物料標示作業',
        assessment_control_point: [...filler('a', 8, saved), point('p1', 9, ['資材單位', MINE], saved), point('p2', 10, [MINE, '生產單位'], saved)],
      },
      { id: 's2', position: 2, level: 1, code: null, name: '倉儲管理作業', assessment_control_point: filler('b', 8, saved) },
      {
        id: 's3',
        position: 3,
        level: 1,
        code: null,
        name: '出貨作業',
        assessment_control_point: [point('r1', 1, [MINE], saved), point('r2', 2, ['生產單位'], saved), point('r3', 3, [MINE, '資材單位'], saved)],
      },
    ],
    assessment_step: [
      { id: 'st1', position: 1, name: '自行檢查人員－資材單位', step_group: 'plant', signer_emp_id: 'ZZ0009', editable_unit_name: '資材單位', branch_unit_name: '資材單位', state: 'current' },
      { id: 'st2', position: 2, name: `自行檢查人員－${MINE}`, step_group: 'plant', signer_emp_id: 'ZZ0001', editable_unit_name: MINE, branch_unit_name: MINE, state: 'current' },
      { id: 'st3', position: 3, name: '自行檢查人員－生產單位', step_group: 'plant', signer_emp_id: 'ZZ0008', editable_unit_name: '生產單位', branch_unit_name: '生產單位', state: 'current' },
      { id: 'st4', position: 4, name: '稽核主管', step_group: 'audit_review', signer_emp_id: 'ZZ0001', editable_unit_name: null, branch_unit_name: null, state: 'pending' },
    ],
    assessment_conclusion: concluded ? [{ assessing_unit_name: MINE, conclusion: 'satisfied', exceptions: null }] : [],
  }
}

const ALL_DONE: Saved = { 'p1:品保單位': DONE, 'p2:品保單位': DONE, 'r1:品保單位': DONE, 'r3:品保單位': DONE }

async function open(page: Page, a: ReturnType<typeof assessment>, onSubmit?: (route: Route) => Promise<void>) {
  await signInAsAuditAdmin(page)
  await page.route('**/rest/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    const single = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object')
    if (path.endsWith('/assessment')) return route.fulfill({ json: single ? a : [a] })
    if (path.endsWith('/rpc/submit_assessment_step') && onSubmit) return onSubmit(route)
    if (path.includes('/rpc/')) return route.fulfill({ status: 204 })
    return route.fulfill({ json: single ? null : [] })
  })
  await page.goto(`/assessments/${a.id}`)
  await expect(page.getByTestId('assessment-section')).toHaveCount(3)
}

const row = (page: Page, key: string) => page.locator(`tr[data-row-key="${key}"]`)
const myConclusion = (page: Page) => page.locator(`[data-testid="conclusion"][data-unit="${MINE}"]`)
/** A row by its control point id, or 'conclusion' for 品保單位's 整體結論. */
const stop = (page: Page, key: string) => (key === 'conclusion' ? myConclusion(page) : row(page, `${key}:${MINE}`))
const bar = (page: Page) => page.getByTestId('answer-bar')
const progress = (page: Page) => page.getByTestId('answer-progress')
const radio = (page: Page, section: number, number: number, field: string, option: string) =>
  page.getByRole('radio', { name: `第 ${section} 章第 ${number} 題 ${MINE} ${field}：${option}`, exact: true })

/**
 * The row is fully on screen from top to bottom, between the top of the window (or the phone's top bar) and the bottom
 * bar. Only the height counts: the table is wider than the window and scrolls sideways.
 */
async function expectClear(page: Page, target: Locator) {
  await expect
    .poll(async () => {
      const box = (await target.boundingBox())!
      const barBox = (await bar(page).boundingBox())!
      const topBar = (await page.getByTestId('top-bar').count()) > 0 ? await page.getByTestId('top-bar').boundingBox() : null
      return box.y >= (topBar ? topBar.y + topBar.height : 0) && box.y + box.height <= barBox.y
    })
    .toBe(true)
}

test('opens at the first unanswered row of my unit, clear of the bottom bar', async ({ page }) => {
  await open(page, assessment())
  await expectClear(page, row(page, `p2:${MINE}`))
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await expect(progress(page)).toHaveText('已答 1／4 題')
  await expect(page.getByTestId('next-unanswered')).toHaveText('下一題未填 ↓')
})

test('opens at the top when every row and the 整體結論 are answered, and the button goes to 整體結論', async ({ page }) => {
  await open(page, assessment({ saved: ALL_DONE, concluded: true }))
  await expect(progress(page)).toHaveText('✓ 已答 4／4 題')
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await expect(page.getByTestId('next-unanswered')).toHaveText('到整體結論 ↓')
  await page.getByTestId('next-unanswered').click()
  await expect(page.getByTestId('conclusions')).toBeInViewport()
})

test('opens at the 整體結論 when only it is left, and ticks ✓ once 尚屬滿意 or 除下列事項外 is chosen', async ({ page }) => {
  await open(page, assessment({ saved: ALL_DONE }))
  await expectClear(page, myConclusion(page))
  // 已答 counts the questions only, as 首頁 does.
  await expect(progress(page)).toHaveText('已答 4／4 題')
  await expect(page.getByTestId('next-unanswered')).toHaveText('到整體結論 ↓')
  await myConclusion(page).getByRole('radio', { name: '尚屬滿意', exact: true }).check()
  await expect(progress(page)).toHaveText('✓ 已答 4／4 題')
})

test('counts a row as answered once 設計, 執行 and 滿意度 are all picked, before 暫存', async ({ page }) => {
  await open(page, assessment())
  await radio(page, 1, 10, '內部控制制度設計', '有內控規範').click()
  await radio(page, 1, 10, '內部控制制度執行情形', '否').click()
  await expect(progress(page)).toHaveText('已答 1／4 題')
  await radio(page, 1, 10, '設計、執行有效控制滿意度', '需要加強').click()
  await expect(progress(page)).toHaveText('已答 2／4 題')
  await expect(page.getByText('有尚未暫存的修改')).toBeVisible()
  // Picking does not move on by itself.
  await expect(radio(page, 1, 10, '設計、執行有效控制滿意度', '需要加強')).toBeInViewport()
})

test('下一題未填 goes through my unit’s unanswered rows in order, then the 整體結論, then back to the first', async ({ page }) => {
  await open(page, assessment())
  await expectClear(page, row(page, `p2:${MINE}`))
  for (const key of ['r1', 'r3', 'conclusion', 'p2']) {
    await page.getByTestId('next-unanswered').click()
    await expectClear(page, stop(page, key))
    // After a click the keyboard stays on the button: Space or the arrow keys then scroll, they do not tick an option.
    await expect(page.getByTestId('next-unanswered')).toBeFocused()
  }
})

test('a row answered meanwhile is skipped, and the rows left are visited from the one last jumped to', async ({ page }) => {
  await open(page, assessment())
  await page.getByTestId('next-unanswered').click()
  await expectClear(page, row(page, `r1:${MINE}`))
  for (const [field, option] of [['內部控制制度設計', '無內控規範'], ['內部控制制度執行情形', '是'], ['設計、執行有效控制滿意度', '滿意']]) {
    await radio(page, 3, 1, field!, option!).click()
  }
  await expect(progress(page)).toHaveText('已答 2／4 題')
  await page.getByTestId('next-unanswered').click()
  await expectClear(page, row(page, `r3:${MINE}`))
  await page.getByTestId('next-unanswered').click()
  await expectClear(page, myConclusion(page))
  await page.getByTestId('next-unanswered').click()
  await expectClear(page, row(page, `p2:${MINE}`))
})

test('只看我的題目 folds the other units’ rows and chapters away, and changes nothing else', async ({ page }) => {
  await open(page, assessment())
  const sections = page.getByTestId('assessment-section')
  await expect(page.getByTestId('control-point-row')).toHaveCount(24)

  await page.getByTestId('only-mine').check()
  await expect(page.getByTestId('control-point-row')).toHaveCount(4)
  await expect(page.locator(`[data-testid="control-point-row"]:not([data-unit="${MINE}"])`)).toHaveCount(0)
  await expect(sections.nth(0).getByTestId('hidden-rows')).toHaveText('已隱藏其他單位 10 題')
  await expect(sections.nth(1).getByTestId('section-folded')).toHaveText('沒有你的題目（8 題，已收起）')
  await expect(sections.nth(1).locator('table')).toHaveCount(0)
  await expect(sections.nth(2).getByTestId('hidden-rows')).toHaveText('已隱藏其他單位 2 題')
  // The paper's numbers stay.
  await expect(row(page, `p2:${MINE}`).locator('td').first()).toHaveText('10')
  await expect(progress(page)).toHaveText('已答 1／4 題')

  await page.getByTestId('next-unanswered').click()
  await expectClear(page, row(page, `r1:${MINE}`))

  await page.getByTestId('only-mine').uncheck()
  await expect(page.getByTestId('control-point-row')).toHaveCount(24)
  await expect(page.getByTestId('section-folded')).toHaveCount(0)
  await expect(page.getByTestId('hidden-rows')).toHaveCount(0)
})

test('只看我的題目 starts off on every visit', async ({ page }) => {
  await open(page, assessment())
  await page.getByTestId('only-mine').check()
  await page.reload()
  await expect(page.getByTestId('only-mine')).not.toBeChecked()
  await expect(page.getByTestId('control-point-row')).toHaveCount(24)
})

test('送出 with 只看我的題目 on is checked the same way and shows what is missing', async ({ page }) => {
  let submitted = 0
  await open(page, assessment(), async (route) => {
    submitted += 1
    await route.fulfill({
      json: {
        ok: false,
        error: 'incomplete',
        violations: [{ kind: 'control_point', control_point_id: 'r1', section_position: 3, position: 1, rule: 'unanswered' }],
      },
    })
  })
  await page.getByTestId('only-mine').check()
  await page.getByTestId('submit-answers').click()
  await page.getByRole('button', { name: /確\s*定/ }).click()
  await expect(page.getByTestId('violations')).toContainText('第 3 章第 1 個控制要點')
  await expect(row(page, `r1:${MINE}`)).toHaveAttribute('data-violation', 'true')
  expect(submitted).toBe(1)
})

for (const [name, a] of [
  ['a signer', assessment({ steps: 'sign' })],
  ['a read-only viewer', assessment({ steps: 'none' })],
  ['a closed 自評表', assessment({ steps: 'none', status: 'closed' })],
] as const) {
  test(`${name} gets no progress, jump or 只看我的題目, and stays at the top`, async ({ page }) => {
    await open(page, a)
    await expect(page.getByTestId('read-only-note')).toBeVisible()
    await expect(page.getByTestId('only-mine')).toHaveCount(0)
    await expect(page.getByTestId('answer-progress')).toHaveCount(0)
    await expect(page.getByTestId('next-unanswered')).toHaveCount(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })
}

test('works on a phone: the bar wraps, the page does not scroll sideways, the row is clear of both bars', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await open(page, assessment())
  await expectClear(page, row(page, `p2:${MINE}`))
  await expect(page.getByTestId('only-mine')).toBeInViewport()
  await expect(page.getByTestId('submit-answers')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  await page.getByTestId('next-unanswered').click()
  await expectClear(page, row(page, `r1:${MINE}`))
})

test('on a phone, 到整體結論 brings 整體結論 up below the top bar', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await open(page, assessment({ saved: ALL_DONE, concluded: true }))
  await page.getByTestId('next-unanswered').click()
  const title = page.getByTestId('conclusions').getByText('整體結論', { exact: true })
  await expect(title).toBeInViewport()
  await expect
    .poll(async () => {
      const topBar = (await page.getByTestId('top-bar').boundingBox())!
      return (await title.boundingBox())!.y >= topBar.y + topBar.height
    })
    .toBe(true)
})

test('works from the keyboard: Space ticks 只看我的題目, Enter on 下一題未填 jumps and the arrows answer', async ({ page }) => {
  await open(page, assessment())
  await page.getByTestId('only-mine').focus()
  await page.keyboard.press('Space')
  await expect(page.getByTestId('only-mine')).toBeChecked()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('next-unanswered')).toBeFocused()
  await page.keyboard.press('Enter')
  await expectClear(page, row(page, `r1:${MINE}`))
  await expect(radio(page, 3, 1, '內部控制制度設計', '有內控規範')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(radio(page, 3, 1, '內部控制制度設計', '無內控規範')).toBeChecked()

  // Row 3-3 has its 內控設計 already: the keyboard lands on 執行情形, so the arrows cannot change the answer given.
  await page.getByTestId('next-unanswered').focus()
  await page.keyboard.press('Enter')
  await expectClear(page, row(page, `r3:${MINE}`))
  await expect(radio(page, 3, 3, '內部控制制度執行情形', '是')).toBeFocused()
  await expect(radio(page, 3, 3, '內部控制制度設計', '無內控規範')).toBeChecked()

  await page.getByTestId('next-unanswered').focus()
  await page.keyboard.press('Enter')
  await expectClear(page, myConclusion(page))
  await expect(myConclusion(page).getByRole('radio', { name: '尚屬滿意', exact: true })).toBeFocused()
})
