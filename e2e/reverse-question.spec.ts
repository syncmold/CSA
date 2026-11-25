import { expect, test, type Page, type Request, type Route } from '@playwright/test'
import { EMPLOYEE, signInAsAuditAdmin } from './support/mockSession'

// 反向題目 (Q148, #233): 範本管理 ticks a control point as a 反向題 from its list or its edit dialog. The 答題頁 keeps
// its layout (使用者 2026-11-25) and only tags the question 「反向題」; a refused 送出 words its missing 補充說明 by 「是」. Every /rest/v1 answer is made up here, so no
// database or sign-in is needed; the rule itself is the database's (tests/db/reverse_question.rls.test.ts).

const TEMPLATE_ID = '00000000-0000-0000-0000-000000000233'
const PLAIN = '管理階層評估風險時是否考量公司外部環境之改變？'
const REVERSE = '外部環境、商業模式的改變，是否對公司產生重大影響？'
const UNIT = '管理單位'

const point = (id: string, position: number, text: string, isReverse: boolean) => ({
  id, position, code: null, text, is_reverse: isReverse,
  control_point_unit: [{ position: 1, assessing_unit_id: 'u1', assessing_unit: { name: UNIT } }],
})
const TREE = {
  id: TEMPLATE_ID, code: 'SY-B', name: '風險評估', layout: 'element', component: 'risk_assessment',
  status: 'active', all_plants: false, in_use: false, template_plant: [{ factory_code: 'SY' }],
  template_section: [
    { id: 's1', position: 1, level: 1, code: '4.', name: '管理階層應考量公司外部環境、商業模式改變及管理階層異動之影響', control_point: [point('p1', 1, PLAIN, false), point('p2', 2, REVERSE, true)] },
  ],
}

const answerPoint = (id: string, position: number, text: string, isReverse: boolean) => ({
  id, position, code: null, text, is_reverse: isReverse,
  assessment_control_point_unit: [{ position: 1, assessing_unit_name: UNIT, assessment_answer: null }],
})
const ASSESSMENT = {
  id: '00000000-0000-0000-0000-000000000234',
  template_code: 'SY-B',
  template_name: '風險評估',
  template_layout: 'element',
  status: 'in_progress',
  current_step_position: 1,
  my_current_steps: [{ position: 1, name: `自行檢查人員－${UNIT}`, branch_unit_name: UNIT, editable_unit_name: UNIT, return_targets: [], closes: false }],
  can_approve: false,
  plant: { factory_code: 'SY', name: '台北總公司' },
  annual_cycle: { year: 2026, due_date: '2026-12-31' },
  pdf_company: { company: { name: '富群', logo_path: null } },
  assessment_section: [
    {
      id: 'as1', position: 1, level: 1, code: '4.', name: '管理階層應考量公司外部環境、商業模式改變及管理階層異動之影響',
      assessment_control_point: [answerPoint('a1', 1, PLAIN, false), answerPoint('a2', 2, REVERSE, true)],
    },
  ],
  assessment_step: [
    { id: 'st1', position: 1, name: `自行檢查人員－${UNIT}`, step_group: 'plant', signer_emp_id: EMPLOYEE.emp_id, editable_unit_name: UNIT, branch_unit_name: UNIT, state: 'current' },
    { id: 'st2', position: 2, name: '稽核主管', step_group: 'audit_review', signer_emp_id: 'ZZ0004', editable_unit_name: null, branch_unit_name: null, state: 'pending' },
  ],
  assessment_conclusion: [],
}
/** The same two questions on a 控制活動類 自評表, whose free-text column is 改善措施. */
const ACTIVITY_ASSESSMENT = { ...ASSESSMENT, id: '00000000-0000-0000-0000-000000000235', template_code: 'SY-07', template_name: '投資循環', template_layout: 'control_activity' }

/** Answers like PostgREST would and records every write. */
async function mockApi(page: Page, writes: Request[] = [], assessment: object = ASSESSMENT) {
  await page.route('**/rest/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    const single = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object')
    if (route.request().method() !== 'GET') writes.push(route.request())
    if (path.endsWith('/employee_ref')) return route.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    if (path.endsWith('/questionnaire_template')) return route.fulfill({ json: [TREE] })
    if (path.endsWith('/assessing_unit')) return route.fulfill({ json: [{ id: 'u1', name: UNIT }] })
    if (path.endsWith('/assessment')) return route.fulfill({ json: single ? assessment : [assessment] })
    if (path.endsWith('/rpc/submit_assessment_step')) {
      return route.fulfill({
        json: {
          ok: false,
          error: 'incomplete',
          violations: [
            { kind: 'control_point', control_point_id: 'a1', section_position: 1, position: 1, rule: 'improvement_required' },
            { kind: 'control_point', control_point_id: 'a2', section_position: 1, position: 2, rule: 'improvement_required' },
          ],
        },
      })
    }
    if (path.includes('/rpc/')) return route.fulfill({ status: 204 })
    return route.fulfill({ json: single ? null : [] })
  })
}

const rpcCalls = (writes: Request[], name: string) => writes.filter((w) => w.url().endsWith(`/rpc/${name}`)).map((w) => w.postDataJSON())

test.describe('範本管理', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAuditAdmin(page)
  })

  test('tags a 反向題 when read and edited, and the list’s tick box saves only that setting', async ({ page }) => {
    const writes: Request[] = []
    await mockApi(page, writes)
    await page.goto(`/admin/templates/${TEMPLATE_ID}`)
    const rows = page.getByTestId('control-point-row')
    await expect(rows.nth(1).getByTestId('reverse-tag')).toHaveText('反向題')
    await expect(rows.nth(0).getByTestId('reverse-tag')).toHaveCount(0)
    // Read-only: no tick boxes.
    await expect(page.getByTestId('reverse-checkbox')).toHaveCount(0)

    await page.goto(`/admin/templates/${TEMPLATE_ID}/edit`)
    await expect(page.getByRole('columnheader', { name: '反向題目' })).toBeVisible()
    const box = (n: number) => page.getByRole('checkbox', { name: `${TREE.template_section[0]!.name} 第 ${n} 題設為反向題目` })
    await expect(box(2)).toBeChecked()
    await expect(box(1)).not.toBeChecked()

    // The tick shows at once and the box waits for the template read back to agree: the mocked tree never does, so it
    // stays ticked and disabled, and a second click cannot send the stale value.
    await box(1).click()
    await expect(box(1)).toBeChecked()
    await expect(box(1)).toBeDisabled()
    await expect.poll(() => rpcCalls(writes, 'set_control_point_reverse')).toEqual([{ p_control_point_id: 'p1', p_is_reverse: true }])
    expect(rpcCalls(writes, 'update_control_point')).toEqual([])
  })

  test('the edit dialog shows the setting and saves it with the rest', async ({ page }) => {
    const writes: Request[] = []
    await mockApi(page, writes)
    await page.goto(`/admin/templates/${TEMPLATE_ID}/edit`)
    await page.getByTestId('control-point-row').nth(1).getByRole('button', { name: '修改控制要點' }).click()
    const dialog = page.getByTestId('control-point-modal')
    const reverse = dialog.getByRole('checkbox', { name: '反向題目' })
    await expect(reverse).toBeChecked()
    await expect(dialog).toContainText('答「否」才是好的')

    await reverse.uncheck()
    await dialog.getByRole('button', { name: /儲\s*存/ }).click()
    await expect.poll(() => rpcCalls(writes, 'update_control_point')).toEqual([
      { p_control_point_id: 'p2', p_text: REVERSE, p_unit_ids: ['u1'], p_code: null, p_is_reverse: false },
    ])
  })
})

test.describe('答題頁', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAuditAdmin(page)
    await mockApi(page)
    await page.goto(`/assessments/${ASSESSMENT.id}`)
  })

  test('tags a 反向題 after its text and adds nothing else to the row', async ({ page }) => {
    const rows = page.getByTestId('control-point-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(1).getByTestId('reverse-tag')).toHaveText('反向題')
    await expect(rows.nth(1).getByTestId('reverse-tag').locator('xpath=ancestor::td[1]')).toHaveText(`${REVERSE}反向題`)
    await expect(rows.nth(0).getByTestId('reverse-tag')).toHaveCount(0)
  })

  test('a refused 送出 words a 反向題’s missing 補充說明 by 「是」, a plain one’s by 「否」', async ({ page }) => {
    await page.getByTestId('submit-answers').click()
    await page.getByRole('button', { name: /確\s*定/ }).click()
    const list = page.getByTestId('violations')
    await expect(list).toContainText('勾選「否」「需要加強」或「不滿意」時須填補充說明')
    await expect(list).toContainText('反向題勾選「是」「需要加強」或「不滿意」時須填補充說明')
    const rows = page.getByTestId('control-point-row')
    await expect(rows.nth(1).getByTestId('answer-violation')).toHaveText('反向題勾選「是」「需要加強」或「不滿意」時須填補充說明')
    await expect(rows.nth(0).getByTestId('answer-violation')).toHaveText('勾選「否」「需要加強」或「不滿意」時須填補充說明')
  })
})

test('on a 控制活動類 自評表 a refused 送出 asks for 改善措施 on a 反向題’s 「是」', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page, [], ACTIVITY_ASSESSMENT)
  await page.goto(`/assessments/${ACTIVITY_ASSESSMENT.id}`)
  await page.getByTestId('submit-answers').click()
  await page.getByRole('button', { name: /確\s*定/ }).click()
  const rows = page.getByTestId('control-point-row')
  await expect(rows.nth(1).getByTestId('reverse-tag')).toHaveText('反向題')
  await expect(rows.nth(1).getByTestId('answer-violation')).toHaveText('反向題勾選「是」「無內控規範」「需要加強」或「不滿意」時須填改善措施')
  await expect(rows.nth(0).getByTestId('answer-violation')).toHaveText('勾選「否」「無內控規範」「需要加強」或「不滿意」時須填改善措施')
})
