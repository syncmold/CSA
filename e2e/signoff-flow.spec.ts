import { expect, test, type Page, type Route } from '@playwright/test'

// 簽核流程的分流卡片（#99）：每排盡量一樣多，單位再多、畫面再窄都不能左右捲動。瀏覽器拿到存好的 session，/rest/v1 的
// 回應都在這裡假造，所以不需要資料庫與登入；分流的狀態本身由 tests/db/parallel_branches.rls.test.ts 測。

const EMPLOYEE = { emp_id: 'ZZ0001', name: '測試稽核管理者', factory_code: 'FQ' }

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

const UNITS = ['資材單位', '品保單位', '財務單位', '生產單位', '研發單位', '資訊及數位轉型單位', '管理單位']
const ASSESSMENT_ID = '00000000-0000-0000-0000-000000000099'

const step = (position: number, name: string, branch: string | null, state: string, group = 'plant', signer: string | null = `ZZ${position}`) => ({
  id: `st${position}`, position, name, step_group: group, signer_emp_id: signer,
  editable_unit_name: name.startsWith('自行檢查人員') ? branch : null, branch_unit_name: branch, state,
})

/** 前 `count` 個單位：資材已送出在等主管，其他還在填；財務的分流多一關課長，順序和紙本一樣自行檢查人員都排前面。 */
function assessment(count: number) {
  const units = UNITS.slice(0, count)
  const branchSteps = [
    ...units.map((u, i) => step(i + 1, `自行檢查人員－${u}`, u, i === 0 ? 'done' : 'current')),
    ...units.flatMap((u) => [...(u === '財務單位' ? ['課長'] : []), `部門主管－${u}`].map((name) => ({ name, u }))).map(({ name, u }, i) =>
      step(units.length + i + 1, name, u, u === '資材單位' ? 'current' : 'pending'),
    ),
  ]
  return {
    id: ASSESSMENT_ID,
    template_code: '02',
    template_name: '採購及付款循環',
    template_layout: 'control_activity',
    status: 'in_progress',
    current_step_position: 2,
    my_current_steps: [],
    can_approve: false,
    plant: { factory_code: 'FQ', name: '福清富群' },
    annual_cycle: { year: 2026, due_date: '2026-12-31' },
    pdf_company: { company: { name: '福清富群電子有限公司', logo_path: null } },
    assessment_section: [],
    assessment_step: [
      ...branchSteps,
      step(branchSteps.length + 1, '廠區經理人', null, 'pending'),
      step(branchSteps.length + 2, '子公司擔當稽核', null, 'pending', 'audit_review'),
      step(branchSteps.length + 3, '台北稽核人員', null, 'pending', 'audit_review'),
      step(branchSteps.length + 4, '稽核主管', null, 'pending', 'audit_review'),
    ],
    assessment_conclusion: [],
  }
}

async function open(page: Page, count: number, width = 1440, row = assessment(count)) {
  await page.setViewportSize({ width, height: 900 })
  await signIn(page)
  await page.route('**/rest/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    const single = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object')
    if (path.endsWith('/assessment')) return route.fulfill({ json: single ? row : [row] })
    return route.fulfill({ json: single ? null : [] })
  })
  await page.goto(`/assessments/${ASSESSMENT_ID}`)
  await expect(page.getByTestId('route-branch')).toHaveCount(count)
}

/** The 分流 cards row by row, top to bottom; once a resize has settled, every row has found its place. */
async function rowsOfCards(page: Page) {
  const boxes = await Promise.all((await page.getByTestId('route-branch').all()).map(async (c) => (await c.boundingBox())!))
  const rows = new Map<number, typeof boxes>()
  for (const b of boxes) rows.set(Math.round(b.y), [...(rows.get(Math.round(b.y)) ?? []), b])
  return [...rows.keys()].sort((x, y) => x - y).map((y) => rows.get(y)!)
}

async function expectNoSidewaysScroll(page: Page) {
  const flow = page.getByTestId('signoff-route')
  const overflow = await flow.evaluate((el) => [el, ...el.querySelectorAll('*')].filter((n) => n.scrollWidth > n.clientWidth + 1 && n.clientWidth > 0).length)
  expect(overflow).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  const area = (await flow.boundingBox())!
  for (const row of await rowsOfCards(page)) for (const b of row) expect(b.x + b.width).toBeLessThanOrEqual(area.x + area.width)
}

const sizes = async (page: Page) => (await rowsOfCards(page)).map((row) => row.length)

// 1440 puts the 簽核流程 beside the 簽核歷程; 1280 stacks them, so all seven fit one row; 375 is a phone.
for (const [width, rows] of [[1440, [3, 3, 1]], [1280, [7]], [375, [2, 2, 2, 1]]] as const) {
  test(`seven units take rows of ${rows.join('＋')} and nothing scrolls sideways at ${width}px`, async ({ page }) => {
    await open(page, 7, width)
    await expect.poll(() => sizes(page)).toEqual(rows)
    await expectNoSidewaysScroll(page)

    // 「自行檢查人員」 fits a card on one line, as a two-character 關卡 does.
    const finance = page.getByTestId('route-branch').and(page.locator('[data-unit="財務單位"]'))
    const [self, chief] = await finance.getByTestId('route-step').all()
    expect(Math.round((await self!.boundingBox())!.height)).toBe(Math.round((await chief!.boundingBox())!.height))
  })
}

for (const [width, room] of [[1440, 'three'], [1000, 'five']] as const) {
  test(`six units are 3＋3 with room for ${room}, the rows lined up and each row one height`, async ({ page }) => {
    await open(page, 6, width)
    await expect.poll(() => sizes(page)).toEqual([3, 3])
    await expectNoSidewaysScroll(page)
    const [first, second] = await rowsOfCards(page)
    for (const [i, b] of first!.entries()) {
      expect(Math.abs(b.x - second![i]!.x)).toBeLessThan(1)
      expect(Math.abs(b.width - second![i]!.width)).toBeLessThan(1)
    }
    // 財務 has one 關卡 more; the cards beside it are as tall.
    expect(new Set(first!.map((b) => Math.round(b.height))).size).toBe(1)
  })
}

test('a shorter last row is centred, at the same card width', async ({ page }) => {
  await open(page, 7)
  await expect.poll(() => sizes(page)).toEqual([3, 3, 1])
  const rows = await rowsOfCards(page)
  const [left, , right] = rows[0]!
  const last = rows[2]![0]!
  expect(Math.abs(last.width - left!.width)).toBeLessThan(1)
  expect(Math.abs(last.x + last.width / 2 - (left!.x + right!.x + right!.width) / 2)).toBeLessThan(1)
})

test('a 關卡 without a 簽核人 says 待分派, and the one waiting for a colleague keeps its name', async ({ page }) => {
  const row = assessment(2)
  const pending = (name: string) => row.assessment_step.find((s) => s.name === name)!
  Object.assign(pending('自行檢查人員－品保單位'), { state: 'pending' })
  Object.assign(pending('部門主管－品保單位'), { signer_emp_id: null })
  Object.assign(pending('廠區經理人'), { signer_emp_id: null })
  await open(page, 2, 1440, row)

  const branch = page.getByTestId('route-branch').filter({ hasText: '品保單位' }).getByTestId('route-step')
  await expect(branch.nth(0)).toHaveAttribute('data-state', 'todo')
  await expect(branch.nth(0)).toContainText('ZZ')
  await expect(branch.nth(1)).toHaveAttribute('data-state', 'unassigned')
  await expect(branch.nth(1)).toContainText('待分派')
  await expect(page.locator('[data-testid="route-step"][data-state="unassigned"]').last()).toContainText('廠區經理人待分派')
})

test('a page narrower than two cards stands them in one column, without scrolling sideways', async ({ page }) => {
  await open(page, 4, 250)
  await expect.poll(() => sizes(page)).toEqual([1, 1, 1, 1])
  await expectNoSidewaysScroll(page)
})

test('the rows even out again when the page is resized', async ({ page }) => {
  await open(page, 6, 1280)
  await expect.poll(() => sizes(page)).toEqual([6])
  await page.setViewportSize({ width: 1000, height: 900 })
  await expect.poll(() => sizes(page)).toEqual([3, 3])
  await expectNoSidewaysScroll(page)
})

test('a 關卡 shows its name and 簽核人 only; the outline and the tooltip tell the rest, and the 匯流 is its count alone', async ({ page }) => {
  await open(page, 7)
  const material = page.getByTestId('route-branch').and(page.locator('[data-unit="資材單位"]'))
  await expect(material.getByTestId('route-step')).toHaveText(['自行檢查人員ZZ1', `部門主管ZZ${UNITS.length + 1}`])
  await expect(material.getByTestId('route-step').first()).toHaveAttribute('data-state', 'done')
  await expect(material.getByTestId('route-step').last()).toHaveAttribute('data-state', 'current')
  await expect(material.getByTestId('route-step').first()).toHaveAttribute('title', '資材單位・自行檢查人員\nZZ1')
  await expect(page.getByTestId('route-merge')).toHaveText(`0/${UNITS.length}`)
})
