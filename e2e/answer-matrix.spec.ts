import { expect, test, type Page, type Route } from '@playwright/test'

// 答題頁的矩陣版面（#46）：選項在表頭、每個自評單位一列、控制要點合併成一格。鍵盤能操作單選圈、螢幕閱讀器讀得出
// 每格是哪一題、哪個選項。瀏覽器拿到存好的 session，/rest/v1 的回應都在這裡假造，所以不需要資料庫與登入。

const EMPLOYEE = { emp_id: 'ZZ0002', name: '測試品保', factory_code: 'FQ' }
const QUESTION = '製程階段之物料標示是否依既定之作業程序確實遵循？'

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

const unit = (position: number, name: string) => ({ position, assessing_unit_name: name, assessment_answer: null })

/** 04 存貨循環「物料標示與追溯性管理作業」的前兩題，三個單位的分流同時在答題，登入的是品保單位的自行檢查人員。 */
const ASSESSMENT = {
  id: '00000000-0000-0000-0000-000000000046',
  template_code: '04',
  template_name: '存貨循環',
  template_layout: 'control_activity',
  status: 'in_progress',
  current_step_position: 1,
  my_current_steps: [
    { position: 2, name: '自行檢查人員－品保單位', branch_unit_name: '品保單位', editable_unit_name: '品保單位', return_targets: [], closes: false },
  ],
  can_approve: false,
  plant: { factory_code: 'FQ', name: '福清富群' },
  annual_cycle: { year: 2026, due_date: '2026-12-31' },
  pdf_company: { company: { name: '福清富群電子有限公司', logo_path: null } },
  assessment_section: [
    {
      id: 's1',
      position: 1,
      level: 1,
      code: null,
      name: '物料標示與追溯性管理作業',
      assessment_control_point: [
        { id: 'p1', position: 1, code: null, text: '進料階段之物料標示是否依既定之作業程序確實遵循？', assessment_control_point_unit: [unit(1, '資材單位'), unit(2, '品保單位')] },
        { id: 'p2', position: 2, code: null, text: QUESTION, assessment_control_point_unit: [unit(1, '品保單位'), unit(2, '生產單位'), unit(3, '資材單位')] },
      ],
    },
  ],
  assessment_step: [
    { id: 'st1', position: 1, name: '自行檢查人員－資材單位', step_group: 'plant', signer_emp_id: 'ZZ0001', editable_unit_name: '資材單位', branch_unit_name: '資材單位', state: 'current' },
    { id: 'st2', position: 2, name: '自行檢查人員－品保單位', step_group: 'plant', signer_emp_id: EMPLOYEE.emp_id, editable_unit_name: '品保單位', branch_unit_name: '品保單位', state: 'current' },
    { id: 'st3', position: 3, name: '自行檢查人員－生產單位', step_group: 'plant', signer_emp_id: 'ZZ0003', editable_unit_name: '生產單位', branch_unit_name: '生產單位', state: 'current' },
    { id: 'st4', position: 4, name: '稽核主管', step_group: 'audit_review', signer_emp_id: 'ZZ0004', editable_unit_name: null, branch_unit_name: null, state: 'pending' },
  ],
  assessment_conclusion: [],
}

async function mockApi(page: Page) {
  await page.route('**/rest/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    const single = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object')
    if (path.endsWith('/assessment')) return route.fulfill({ json: single ? ASSESSMENT : [ASSESSMENT] })
    return route.fulfill({ json: single ? null : [] })
  })
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
  await mockApi(page)
  await page.goto(`/assessments/${ASSESSMENT.id}`)
})

test('merges a control point over one row per 自評單位, numbered once', async ({ page }) => {
  const rows = page.getByTestId('control-point-row')
  await expect(rows).toHaveCount(5)
  await expect(page.getByRole('cell', { name: QUESTION, exact: true })).toHaveCount(1)
  await expect(rows.and(page.locator('[data-editable="true"]'))).toHaveCount(2)
})

test('names every radio by section, control point, 自評單位, field and option, and disables the other units', async ({ page }) => {
  const yes = page.getByRole('radio', { name: '第 1 章第 2 題 品保單位 內部控制制度執行情形：是', exact: true })
  await expect(yes).toBeEnabled()
  await expect(page.getByRole('radio', { name: '第 1 章第 2 題 生產單位 內部控制制度執行情形：是', exact: true })).toBeDisabled()
  // 控制活動類每一列 2 + 4 + 5 個選項。
  await expect(page.getByRole('radio', { name: /^第 1 章第 2 題 品保單位 / })).toHaveCount(11)
})

test('a click anywhere in an answerable option cell picks it; a read-only cell does nothing (#133)', async ({ page }) => {
  const radio = (unit: string, option: string) =>
    page.getByRole('radio', { name: `第 1 章第 2 題 ${unit} 內部控制制度執行情形：${option}`, exact: true })
  const cellOf = (unit: string, option: string) => radio(unit, option).locator('xpath=ancestor::td[1]')
  const corner = async (unit: string, option: string, at: 'top' | 'bottom') => {
    const box = (await cellOf(unit, option).boundingBox())!
    // Just inside the cell's border, well away from the 16px circle in its middle.
    await cellOf(unit, option).click({ position: { x: 3, y: at === 'top' ? 3 : box.height - 3 } })
  }

  await corner('品保單位', '否', 'top')
  await expect(radio('品保單位', '否')).toBeChecked()
  await corner('品保單位', '是', 'bottom')
  await expect(radio('品保單位', '是')).toBeChecked()
  await expect(radio('品保單位', '否')).not.toBeChecked()

  await expect(radio('生產單位', '是')).toBeDisabled()
  await cellOf('生產單位', '是').click({ position: { x: 3, y: 3 } })
  await expect(radio('生產單位', '是')).not.toBeChecked()
  await expect(cellOf('生產單位', '是').locator('label')).toHaveCount(0)
})

test('a line opens 自評單位 and each block of options and one closes the last, header to last row (#140)', async ({ page }) => {
  const edged = (cells: string) =>
    page.locator(cells).evaluateAll((all) =>
      all
        .filter((cell) => getComputedStyle(cell).borderInlineStartWidth !== '0px')
        .map((cell) => cell.querySelector('input, textarea')?.getAttribute('aria-label') ?? cell.textContent?.trim()),
    )
  const row = '[data-testid="control-point-row"][data-unit="品保單位"][data-editable="true"]'
  expect(await edged(`${row} >> nth=1 >> td`)).toEqual([
    '品保單位',
    '第 1 章第 2 題 品保單位 內部控制制度設計：有內控規範',
    '第 1 章第 2 題 品保單位 內部控制制度執行情形：是',
    '第 1 章第 2 題 品保單位 設計、執行有效控制滿意度：非常滿意',
    '第 1 章第 2 題 品保單位 所需採行之改善措施／其他考量',
  ])
  expect(await edged('thead th')).toEqual([
    '自評單位',
    '內部控制\n制度設計',
    '內部控制制度執行情形',
    '設計、執行有效控制滿意度',
    '所需採行之改善措施／其他考量',
    '有內控\n規範',
    '是',
    '非常\n滿意',
  ])
})

test('moves the tick with the arrow keys inside a block and goes to the next block with Tab', async ({ page }) => {
  const label = (field: string, option: string) => `第 1 章第 2 題 品保單位 ${field}：${option}`
  const radio = (field: string, option: string) => page.getByRole('radio', { name: label(field, option), exact: true })

  await radio('內部控制制度執行情形', '是').focus()
  await page.keyboard.press('Space')
  await expect(radio('內部控制制度執行情形', '是')).toBeChecked()

  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(radio('內部控制制度執行情形', '不適用')).toBeChecked()
  await expect(radio('內部控制制度執行情形', '不適用')).toBeFocused()
  await expect(radio('內部控制制度執行情形', '是')).not.toBeChecked()

  await page.keyboard.press('Tab')
  await expect(radio('設計、執行有效控制滿意度', '非常滿意')).toBeFocused()
  await expect(page.getByText('有尚未暫存的修改')).toBeVisible()
})
