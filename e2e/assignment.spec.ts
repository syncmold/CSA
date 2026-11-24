import { expect, test, type Page, type Request, type Route } from '@playwright/test'
import { signInAsAuditAdmin } from './support/mockSession'

// 分派填寫人 on issued 自評表 (#101, #102, Q116 (5)(6)(7); Q147): once the forms are out only a 稽核主管 assigns and
// replaces (the reminder of forms issued before Q147 that still wait, the page, a pick, a 換人 and a 從缺); a 廠區管理員
// sees who is on them and is reminded of the routes still to 分派 before the launch. Every /rest/v1 answer is made up
// here, so no database or sign-in is needed; who may do what is the database's (tests/db/assignment.rls.test.ts). The
// specs check what the page shows and what it sends. 分派 on the routes before the launch (下次發出, #223) is the last
// spec here and, against the real database, e2e/assign-before-launch.spec.ts.

const PLANT = { id: 'p1', factory_code: 'FQ', name: '福清富群' }
const ROSTER = [
  { emp_id: 'FQ1021', name: '林怡君', factory_code: 'FQ' },
  { emp_id: 'FQ1008', name: '陳建宏', factory_code: 'FQ' },
  { emp_id: 'FQ4007', name: '蔡宛儒', factory_code: 'FQ' },
]

type Step = {
  id: string; position: number; name: string; step_group: string; link: string | null; signer_emp_id: string | null; editable_unit_name: string | null; branch_unit_name: string | null; state: string
  vacated_emp_id: string | null; vacated_name: string | null
}

  // The 連動 稽核室 steps carry their mark, as the database gives them (#189); only they are never assigned (Q143).
const LINKS: Record<string, string> = { 台北稽核人員: 'taipei_auditor', 稽核主管: 'audit_chief' }
const step = (position: number, name: string, unit: string | null, signer: string | null, state = 'pending', group = 'plant'): Step => ({
  id: `s${position}`, position, name, step_group: group, signer_emp_id: signer, link: LINKS[name] ?? null,
  editable_unit_name: name.startsWith('自行檢查人員') ? unit : null, branch_unit_name: unit, state, vacated_emp_id: null, vacated_name: null,
})

/** A 關卡 whose 簽核人 last year has left. */
const vacant = (position: number, name: string, unit: string | null, person: string): Step => ({ ...step(position, name, unit, null), vacated_emp_id: 'FQ9001', vacated_name: person })

const assignedForms = () => [
  {
    id: 'f1', template_code: 'FQ-01.1', template_name: '銷售及收款循環', status: 'in_progress', annual_cycle: { year: 2026, due_date: '2026-12-31' },
    assessment_step: [
      step(1, '自行檢查人員－業務單位', '業務單位', 'FQ1021', 'done'),
      step(2, '部門主管－業務單位', '業務單位', 'FQ1008', 'current'),
      step(3, '自行檢查人員－品保單位', '品保單位', null),
      step(4, '部門主管－品保單位', '品保單位', null),
      step(5, '廠區經理人', null, null),
      step(6, '稽核主管', null, 'A001', 'pending', 'audit_review'),
    ],
  },
  {
    id: 'f2', template_code: 'FQ-02', template_name: '採購及付款循環', status: 'in_progress', annual_cycle: { year: 2026, due_date: '2026-12-31' },
    assessment_step: [step(1, '自行檢查人員－資材單位', '資材單位', 'FQ1021', 'current'), step(2, '部門主管－資材單位', '資材單位', 'FQ1008')],
  },
]

/** Someone not on FQ's forms: another plant's colleague, found by their complete 工號 only. */
const OUTSIDER = { emp_id: 'SY3001', name: '別廠同仁', factory_code: 'SY' }
/** A 工號 OMS has as 離職. */
const DEPARTED = 'FQ9001'

/**
 * Answers as if the signed-in employee is a 稽核主管 (or, with `role: 'signer'`, runs FQ as 廠區管理員); a write updates
 * the rows, the way the database would. The picker lists the people already on FQ's forms (ROSTER) and asks OMS, through
 * the CSA backend, about whoever is chosen or typed (#218); with `omsDown` that answer is an error.
 */
async function mockApi(
  page: Page,
  writes: Request[] = [],
  pickerReads: string[] = [],
  rows = assignedForms(),
  { omsDown = false, role = 'audit_admin', routes = [] }: { omsDown?: boolean; role?: 'audit_admin' | 'signer'; routes?: object[] } = {},
) {
  await page.route('**/rest/v1/**', async (r: Route) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/employee_ref')) return r.fulfill({ json: [{ audit_role: role }] })
    if (path.endsWith('/plant')) return r.fulfill({ json: [PLANT] })
    // Names of the people already assigned: CSA's own copy (#218), not OMS.
    if (path.endsWith('/rpc/visible_people')) return r.fulfill({ json: ROSTER })
    if (path.endsWith('/rpc/plant_form_people')) {
      pickerReads.push(request.postData() ?? '')
      return r.fulfill({ json: ROSTER.map(({ emp_id, name }) => ({ emp_id, name })) })
    }
    if (path.endsWith('/plant_coordinator')) return r.fulfill({ status: 200, headers: { 'content-range': '0-0/1' }, json: [{ plant: PLANT }] })
    if (path.endsWith('/my_assignment_todo')) {
      const where = { plant_id: PLANT.id, factory_code: PLANT.factory_code, plant_name: PLANT.name }
      // A 廠區管理員 is reminded of the routes still to 分派 before the launch (Q147).
      if (role === 'signer') return r.fulfill({ json: [{ kind: 'route', ...where, year: null, due_date: null, forms: 2, steps: 3, pending: [] }] })
      const waiting = rows.filter((f) => f.assessment_step.some((s) => s.signer_emp_id === null))
      const pending = waiting.flatMap((f) => f.assessment_step.filter((s) => s.signer_emp_id === null).map((s) => ({ ...s, template_code: f.template_code })))
      return r.fulfill({
        json: waiting.length ? [{ kind: 'assessment', ...where, year: 2026, due_date: '2026-12-31', forms: waiting.length, steps: pending.length, pending }] : [],
      })
    }
    if (path.endsWith('/assessment')) return r.fulfill({ json: rows })
    // 下次發出 (Q147): the plant's routes of 啟用 templates.
    if (path.endsWith('/approval_route')) return r.fulfill({ json: routes })
    if (path.endsWith('/rpc/assign_route_signer')) {
      writes.push(request)
      return r.fulfill({ status: 204 })
    }
    if (path.endsWith('/rpc/assign_step_signer')) {
      writes.push(request)
      const { p_step_id, p_emp_id } = request.postDataJSON() as { p_step_id: string; p_emp_id: string }
      for (const f of rows) for (const s of f.assessment_step) if (f.id === 'f1' && s.id === p_step_id) Object.assign(s, { signer_emp_id: p_emp_id, vacated_emp_id: null, vacated_name: null })
      return r.fulfill({ status: 204 })
    }
    return r.fulfill({ json: [] })
  })
  await page.route('**/csa/exchange/oms-people', (r: Route) => {
    if (omsDown) return r.fulfill({ status: 502, json: { error: 'oms_match_failed' } })
    const { emp_ids, factory_code } = r.request().postDataJSON() as { emp_ids: string[]; factory_code?: string }
    pickerReads.push(`oms:${emp_ids.join(',')}@${factory_code}`)
    const nobody = { name: null, factory_code: null, csa: false }
    const people = emp_ids.map((id) => {
      const person = [...ROSTER, OUTSIDER].find((p) => p.emp_id === id)
      if (person) return { asked: id, ...person, status: 'active', csa: true, other_plant: person.factory_code !== 'FQ' }
      return { asked: id, emp_id: id, status: id === DEPARTED ? 'departed' : 'not_found', ...nobody, other_plant: false }
    })
    return r.fulfill({ json: { people } })
  })
}

async function pick(page: Page, name: string) {
  await page.locator('.ant-select-dropdown').last().locator('.ant-select-item-option', { hasText: name }).click()
}

test('a 稽核主管 goes from the home reminder to 分派 and assigns the missing people of a form issued before Q147', async ({ page }) => {
  const writes: Request[] = []
  const pickerReads: string[] = []
  await signInAsAuditAdmin(page)
  await mockApi(page, writes, pickerReads)
  await page.goto('/')

  await expect(page.getByTestId('assignment-reminder')).toContainText('FQ 福清富群 2026 年度還有 1 張自評表待分派')
  // A numbered step of 發出表單, with no count (使用者 2026-11-24).
  await expect(page.getByRole('menuitem').filter({ has: page.getByTestId('nav-assignment') })).toHaveText('3分派填寫人')
  await page.getByTestId('assignment-reminder-link').click()

  await expect(page.getByRole('heading', { name: '分派填寫人' })).toBeVisible()
  // One 年度 and one 廠區: nothing to choose, but the bar under the title still names both, with the 截止日.
  await expect(page.getByTestId('assignment-year')).toHaveText('2026')
  await expect(page.getByTestId('assignment-plant')).toHaveText('FQ 福清富群')
  await expect(page.getByTestId('assignment-choice-note')).toHaveText('截止日 2026-12-31')
  await expect(page.getByTestId('assignment-tab-todo')).toHaveText('待分派 1')
  await expect(page.getByTestId('assignment-forms').getByRole('button')).toHaveCount(1)
  await expect(page.getByTestId('assignment-form-FQ-01.1')).toContainText('差 3 關')

  const quality = page.getByTestId('assign-branch-品保單位')
  await expect(quality).toContainText('待分派')
  await quality.getByTestId('plant-employee-select').first().click()
  await pick(page, '蔡宛儒')
  expect(JSON.parse(pickerReads[0]!)).toEqual({ p_factory_code: 'FQ' }) // 名單是這一廠表上排過的人
  expect(pickerReads).toContain('oms:FQ4007@FQ') // 選定時向 OMS 確認在職，一次一位，帶這一廠
  // Choosing asks OMS first (#218), so the write follows a moment later.
  await expect.poll(() => writes[0]?.postDataJSON()).toEqual({ p_step_id: 's3', p_emp_id: 'FQ4007', p_emp_name: '蔡宛儒' })
  await expect(quality.getByTestId('assign-step').first()).toContainText('自行檢查人員')
  await expect(page.getByTestId('assignment-form-FQ-01.1')).toContainText('差 2 關')

  // 廠區經理人在分流下面；稽核室的關卡不在這一頁
  await expect(page.getByTestId('assign-merged')).toContainText('廠區經理人')
  await expect(page.getByTestId('assignment-detail')).not.toContainText('A001')
})

test('someone not on the plant’s forms is found by their complete 工號 only; one OMS has as 離職 is refused (#218)', async ({ page }) => {
  const writes: Request[] = []
  const pickerReads: string[] = []
  await signInAsAuditAdmin(page)
  await mockApi(page, writes, pickerReads)
  await page.goto('/admin/assignment')

  const quality = page.getByTestId('assign-branch-品保單位')
  const select = quality.getByTestId('plant-employee-select').first()
  const dropdown = page.locator('.ant-select-dropdown').last()
  await select.click()
  // 姓名只在名單（這一廠表上排過的人）裡找，不向 OMS 搜尋
  await page.keyboard.type('別廠')
  await expect(dropdown).toContainText('名單裡沒有符合的人。要找其他人請輸入完整工號')
  expect(pickerReads.filter((r) => r.startsWith('oms:'))).toEqual([])

  // 名單上有 FQ4007；FQ400 是它的一部分，仍然當成另一個完整工號向 OMS 查
  await select.locator('input').fill('FQ400')
  await expect(dropdown.locator('.ant-select-item-option')).toHaveText('蔡宛儒（FQ4007）')
  await expect.poll(() => pickerReads).toContain('oms:FQ400@FQ')
  await select.locator('input').fill(DEPARTED)
  await expect(dropdown).toContainText(`OMS 記錄 ${DEPARTED} 已離職，不能分派`)
  await select.locator('input').fill(OUTSIDER.emp_id.toLowerCase())
  await expect(dropdown.locator('.ant-select-item-option')).toHaveText('別廠同仁（SY3001）　（主檔廠區 SY，不是本廠）')
  await pick(page, '別廠同仁')
  // Choosing asks OMS first (#218), so the write follows a moment later.
  await expect.poll(() => writes[0]?.postDataJSON()).toEqual({ p_step_id: 's3', p_emp_id: 'SY3001', p_emp_name: '別廠同仁' })
  // 廠區不同只提醒，照常分派
  await expect(page.locator('.ant-message')).toContainText('別廠同仁（SY3001） 已分派。提醒：OMS 記錄他不是 FQ 的人（主檔廠區 SY）')
})

test('with OMS down someone already on the plant’s forms is assigned all the same; anyone else has to wait (#218)', async ({ page }) => {
  const writes: Request[] = []
  await signInAsAuditAdmin(page)
  await mockApi(page, writes, [], assignedForms(), { omsDown: true })
  await page.goto('/admin/assignment')

  const quality = page.getByTestId('assign-branch-品保單位')
  const select = quality.getByTestId('plant-employee-select').first()
  await select.click()
  await select.locator('input').fill(OUTSIDER.emp_id)
  await expect(page.locator('.ant-select-dropdown').last()).toContainText('OMS 沒有回應，名單以外的人請稍後再試')
  await select.locator('input').fill('蔡')
  await pick(page, '蔡宛儒')
  // Choosing asks OMS first (#218), so the write follows a moment later.
  await expect.poll(() => writes[0]?.postDataJSON()).toEqual({ p_step_id: 's3', p_emp_id: 'FQ4007', p_emp_name: '蔡宛儒' })
  await expect(page.locator('.ant-message')).toContainText('蔡宛儒（FQ4007） 已分派，但 OMS 沒有回應，這次沒有確認他是否在職')
})

test('a 從缺 shows on the home reminder and the page, and goes once someone is picked', async ({ page }) => {
  const rows = assignedForms()
  rows[0]!.assessment_step[3] = vacant(4, '部門主管－品保單位', '品保單位', '許文彬')
  await signInAsAuditAdmin(page)
  await mockApi(page, [], [], rows)
  await page.goto('/')

  await expect(page.getByTestId('assignment-vacancies')).toContainText('FQ-01.1 品保單位・部門主管從缺（原為 許文彬，已離職）')
  await page.getByTestId('assignment-reminder-link').click()

  const quality = page.getByTestId('assign-branch-品保單位')
  await expect(quality.getByTestId('step-vacant')).toContainText('原為 許文彬，已離職')
  await quality.getByTestId('assign-step').nth(1).getByTestId('plant-employee-select').click()
  await pick(page, '蔡宛儒')
  await expect(quality.getByTestId('step-vacant')).toHaveCount(0)
  await expect(quality).toContainText('蔡宛儒')
})

test('the home reminder lists five 從缺 and counts the rest', async ({ page }) => {
  const rows = assignedForms()
  rows[0]!.assessment_step = [1, 2, 3, 4, 5, 6, 7].map((n) => vacant(n, `部門主管－單位${n}`, `單位${n}`, '許文彬'))
  await signInAsAuditAdmin(page)
  await mockApi(page, [], [], rows)
  await page.goto('/')

  const list = page.getByTestId('assignment-vacancies').getByRole('listitem')
  await expect(list).toHaveCount(6)
  await expect(list.last()).toHaveText('還有 2 關從缺')
})

test('a signed 關卡 offers no 換人, one not signed yet does, including the one whose turn it is', async ({ page }) => {
  const writes: Request[] = []
  await signInAsAuditAdmin(page)
  await mockApi(page, writes)
  await page.goto('/admin/assignment')

  const sales = page.getByTestId('assign-branch-業務單位')
  await expect(sales).toContainText('已開始')
  const [signed, turn] = [sales.getByTestId('assign-step').nth(0), sales.getByTestId('assign-step').nth(1)]
  await expect(signed.getByTestId('step-signed')).toHaveText('已簽')
  await expect(signed.getByTestId('reassign')).toHaveCount(0)

  await turn.getByTestId('reassign').click()
  await pick(page, '林怡君')
  // Choosing asks OMS first (#218), so the write follows a moment later.
  await expect.poll(() => writes[0]?.postDataJSON()).toEqual({ p_step_id: 's2', p_emp_id: 'FQ1021', p_emp_name: '林怡君' })
})

test('全部 lists the forms already assigned too', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page)
  await page.goto('/admin/assignment')

  await page.getByTestId('assignment-tab-all').click()
  await expect(page.getByTestId('assignment-forms').getByRole('button')).toHaveCount(2)
  await page.getByTestId('assignment-form-FQ-02').click()
  await expect(page.getByTestId('assignment-detail')).toContainText('FQ-02 採購及付款循環')
  await expect(page.getByTestId('assign-branch-資材單位')).toContainText('已開始')
})

test('with more than one 年度, the 年度 menu in the bar under the title switches the list', async ({ page }) => {
  const lastYear = {
    id: 'f0', template_code: 'FQ-02', template_name: '採購及付款循環', status: 'in_progress', annual_cycle: { year: 2025, due_date: '2025-12-31' },
    assessment_step: [step(11, '自行檢查人員－資材單位', '資材單位', 'FQ1021', 'current')],
  }
  await signInAsAuditAdmin(page)
  await mockApi(page, [], [], [...assignedForms(), lastYear])
  await page.goto('/admin/assignment')

  // Under the title, not at the right of it (使用者 2026-11-13); the 截止日 moves into the bar.
  const bar = page.getByTestId('assignment-choice')
  await expect(bar).toBeVisible()
  const title = await page.getByRole('heading', { name: '分派填寫人' }).boundingBox()
  const box = await bar.boundingBox()
  expect(box!.y).toBeGreaterThan(title!.y + title!.height)
  await expect(page.getByTestId('assignment-choice-note')).toHaveText('截止日 2026-12-31。換年度，左邊的自評表清單跟著換。')
  // The one 廠區 is named as text, not hidden.
  await expect(page.getByTestId('assignment-plant')).toHaveText('FQ 福清富群')

  await page.getByTestId('assignment-year').click()
  await pick(page, '2025')
  await expect(page.getByTestId('assignment-choice-note')).toContainText('截止日 2025-12-31')
  await expect(page.getByTestId('assignment-forms').getByRole('button')).toHaveCount(1)
})

test('a 廠區管理員 sees who is on the issued forms but gets no 換人, picker or 匯入; the reminder is about the routes (Q147)', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page, [], [], assignedForms(), { role: 'signer' })
  await page.goto('/')

  await expect(page.getByTestId('assignment-reminder')).toContainText('FQ 福清富群 還有 2 條簽核流程沒分派好簽核人，分派好才能發出表單。')
  await expect(page.getByTestId('assignment-reminder-link')).toHaveAttribute('href', '/admin/assignment?plant=FQ&year=next')
  await page.goto('/admin/assignment')

  const sales = page.getByTestId('assign-branch-業務單位')
  await expect(sales.getByTestId('assign-step').nth(1)).toContainText('陳建宏')
  await expect(page.getByTestId('reassign')).toHaveCount(0)
  await expect(page.getByTestId('assign-branch-品保單位').getByTestId('plant-employee-select')).toHaveCount(0)
  await expect(page.getByTestId('assign-branch-品保單位').getByTestId('step-unassigned').first()).toHaveText('待分派')
  await expect(page.getByTestId('assignment-hint')).toHaveText('發出後只有稽核主管能換人。')
  await expect(page.getByTestId('assignment-download')).toBeVisible()
  await expect(page.getByTestId('assignment-import')).toHaveCount(0)
})

/** A route as the page reads it for 下次發出 (Q147). */
const routeRow = (id: string, code: string, plants: string[], steps: object[]) => ({
  id, template: { code, name: `${code} 範本`, layout: 'control_activity', all_plants: false, template_plant: plants.map((factory_code) => ({ factory_code })) },
  route_step: steps,
})
const routeStep = (position: number, name: string, branch: string | null, signer: string | null, link: string | null = null) => ({
  id: `r${position}`, position, name, step_group: link ? 'audit_review' : 'plant', link, signer_emp_id: signer, branch: branch ? { name: branch } : null,
})
/** FQ-02 applies to FQ; FQ-09 only to another plant, so a launch to FQ would not issue it and it is left out. */
const ROUTES = [
  routeRow('route-2', 'FQ-02', ['FQ'], [
    routeStep(1, '自行檢查人員－資材單位', '資材單位', 'FQ1021'),
    routeStep(2, '部門主管－資材單位', '資材單位', null),
    routeStep(3, '廠區經理人', null, null),
    routeStep(4, '稽核主管', null, 'A001', 'audit_chief'),
  ]),
  routeRow('route-9', 'FQ-09', ['GT'], [routeStep(1, '自行檢查人員－資材單位', '資材單位', null)]),
]

test('下次發出 is the default while the plant has routes: 分派 writes the route, the 分派表 is the routes’ (Q147)', async ({ page }) => {
  const writes: Request[] = []
  await signInAsAuditAdmin(page)
  await mockApi(page, writes, [], assignedForms(), { routes: ROUTES })
  await page.goto('/admin/assignment')

  await expect(page.getByTestId('assignment-year')).toContainText('下次發出')
  await expect(page.getByTestId('assignment-choice-note')).toHaveText('下次發出（年度發起或補發）照這裡的人發出；每一關都分派好，那條流程才能發出。')
  // Only the routes a launch would issue to FQ; 下載／匯入分派表 work on them too (#224, e2e/assignment-import.spec.ts).
  await expect(page.getByTestId('assignment-forms').getByRole('button')).toHaveCount(1)
  await expect(page.getByTestId('assignment-form-FQ-02')).toContainText('差 2 關')
  await expect(page.getByTestId('assignment-download')).toBeVisible()
  await expect(page.getByTestId('assignment-import')).toBeVisible()
  await expect(page.getByTestId('assignment-open')).toHaveAttribute('href', '/admin/flows/route-2')

  const material = page.getByTestId('assign-branch-資材單位')
  await expect(material.getByTestId('assign-step').first()).toContainText('林怡君')
  await material.getByTestId('assign-step').nth(1).getByTestId('plant-employee-select').click()
  await pick(page, '陳建宏')
  await expect.poll(() => writes[0]?.url()).toContain('/rpc/assign_route_signer')
  expect(writes[0]!.postDataJSON()).toEqual({ p_route_step_id: 'r2', p_emp_id: 'FQ1008', p_emp_name: '陳建宏' })
  // The 連動 稽核主管 is not here.
  await expect(page.getByTestId('assignment-detail')).not.toContainText('A001')

  // The issued 年度 is in the same menu, with its 分派表.
  await page.getByTestId('assignment-year').click()
  await pick(page, '2026')
  await expect(page.getByTestId('assignment-choice-note')).toContainText('截止日 2026-12-31')
  await expect(page.getByTestId('assignment-download')).toBeVisible()
})
