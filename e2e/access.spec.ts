import { expect, test, type Page } from '@playwright/test'
import {
  admin, borrowFq02, exchangeAs, insertRow, makeRoute, ok, promoteToAuditAdmin, promoteToSystemMaintainer, releaseFq02, requirePostgrest,
} from '../tests/db/helpers'
import { actAs, actAsAdminAccount, type Person } from './support/mainFlow'

// 人員管理（#58、Q98、Q122；管理員帳號 #161；Q153 取消檢視者，檢視廠區改成一般使用者的選填設定）：
// 對真實的 Postgres＋PostgREST，系統維護員在畫面上加入一個沒登入過的人 → 改角色 → 移除，
// 並看異動紀錄；還排在關卡上的人要先換人才能移除（Q150）。只有系統維護員放行與設定角色（Q150）：稽核主管沒有加入人員與編輯，
// 只留廠區權限指定廠區管理員（設成稽核主管會降級前任，只在資料庫測試裡試，免得動到共用資料庫的其他稽核主管）。誰能做什麼由資料庫決定，
// 規則細節在 tests/db/access_management.rls.test.ts；這裡驗畫面走得通。
// OMS 的查人通道換成假的（只有 NEWCOMER；攔在 CSA 後端的 /oms-people，#218），CSA 這邊的身分走真實換證（同 support/mainFlow.ts）。

const RUN = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase()
const CHIEF: Person = { empId: `${RUN}A`, name: '測試甲' }
const MAINT: Person = { empId: `${RUN}S`, name: '測試維護' }
const NEWCOMER: Person = { empId: `${RUN}N`, name: '測試新人' }
const NOT_IN_OMS = `${RUN}Z`
const FACTORY = `${RUN}P`
const PLANT_NAME = `${RUN}測試廠`
let companyId = ''
let plantId = ''
let fq02 = ''
let routeId = ''
/** 流程上的台北稽核人員關卡：測試中途把新人排上去，看移除被擋（Q150）。 */
let taipeiStepId = ''

test.beforeAll(async () => {
  await requirePostgrest()
  const r = await exchangeAs(CHIEF.empId, CHIEF.name)
  if (!r.ok) throw new Error(`exchange: ${r.error}`)
  await promoteToAuditAdmin(CHIEF.empId)
  ok(await admin.from('access_allowlist').insert({ emp_id: CHIEF.empId }))
  const m = await exchangeAs(MAINT.empId, MAINT.name)
  if (!m.ok) throw new Error(`exchange: ${m.error}`)
  await promoteToSystemMaintainer(MAINT.empId)
  ok(await admin.from('access_allowlist').insert({ emp_id: MAINT.empId }))
  companyId = (await insertRow('company', { name: `${RUN}測試公司` })).id
  plantId = (await insertRow('plant', { factory_code: FACTORY, name: PLANT_NAME, company_id: companyId })).id
  // 這個廠區的一條簽核流程：新人加入後排上台北稽核人員，移除時要被擋（流程沒有狀態，每條都算，Q137 (6)；Q150）。
  // 排進關卡的人要先在放行名單上（Q150），所以流程先排稽核主管。
  // FQ-02 只適用福清（Q111），流程要掛在適用的廠區上，所以測試期間借給測試廠區，收尾時還回去。
  fq02 = await borrowFq02(FACTORY)
  routeId = await makeRoute(fq02, plantId, [
    { name: '台北稽核人員', group: 'audit_review', signer: CHIEF.empId, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: CHIEF.empId, unitId: null },
  ])
  taipeiStepId = (ok(await admin.from('route_step').select('id').eq('route_id', routeId).eq('name', '台北稽核人員').single()) as { id: string }).id
})

test.afterAll(async () => {
  // The test 稽核主管 and 系統維護員 go too, unless one is the only one on the list (the database keeps at least one).
  await admin.from('access_allowlist').delete().eq('emp_id', NEWCOMER.empId)
  await admin.from('access_allowlist').delete().eq('emp_id', CHIEF.empId)
  await admin.from('access_allowlist').delete().eq('emp_id', MAINT.empId)
  if (plantId) await admin.from('approval_route').delete().eq('plant_id', plantId)
  await releaseFq02(FACTORY)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (companyId) await admin.from('company').delete().eq('id', companyId)
})

/** 用工號查人 (#218) as the add dialog asks the CSA backend: only `known` are 在職 in OMS; anyone else is 不在 OMS. */
async function fakeOmsRoster(page: Page, known: { empId: string; name: string }[] = [NEWCOMER]) {
  await page.route('**/csa/exchange/oms-people', (route) => {
    const { emp_ids } = route.request().postDataJSON() as { emp_ids: string[] }
    const people = emp_ids.map((id) => {
      const person = known.find((k) => k.empId === id)
      return person
        ? { asked: id, emp_id: id, status: 'active', name: person.name, factory_code: FACTORY, csa: true, other_plant: false }
        : { asked: id, emp_id: id, status: 'not_found', name: null, factory_code: null, csa: false, other_plant: false }
    })
    return route.fulfill({ json: { people } })
  })
}

const memberRow = (page: Page, empId: string) => page.getByTestId(`access-member-${empId}`)

test('a 系統維護員 adds someone who never signed in, changes their role, and removes them; the log shows each step', async ({ page, browser }) => {
  await fakeOmsRoster(page)
  await actAs(page, MAINT)
  await page.getByTestId('nav-access').click()
  await expect(page).toHaveURL(/\/admin\/access$/)

  // 加入：一個 OMS 有、一個沒有、一個已在名單（自己）
  await page.getByTestId('access-add').click()
  const dialog = page.getByTestId('access-add-modal')
  // 角色剩四個，沒有檢視者（Q153）。
  await expect(dialog.getByRole('radio')).toHaveCount(4)
  await expect(dialog.getByRole('radio', { name: /檢視者/ })).toHaveCount(0)
  await dialog.getByTestId('access-emp-ids').fill(`${NEWCOMER.empId.toLowerCase()}、${NOT_IN_OMS}\n${MAINT.empId}`)
  await expect(dialog.getByTestId(`access-plan-${NEWCOMER.empId}`)).toHaveText(`${NEWCOMER.empId}${NEWCOMER.name} ${FACTORY}加入`)
  await expect(dialog.getByTestId(`access-plan-${NOT_IN_OMS}`)).toContainText('OMS 查不到這個工號，不加入')
  await expect(dialog.getByTestId(`access-plan-${MAINT.empId}`)).toContainText('已在名單，略過')
  // 一般使用者（預設）多一個選填的檢視廠區：沒有預設值（OMS 回來後也不帶他的廠區），其他角色不出現。
  const viewerPlants = dialog.getByTestId('access-viewer-plants')
  await expect(dialog.getByText('檢視廠區（選填）')).toBeVisible()
  await expect(dialog).toContainText('只給需要看整廠資料的高階主管，例如廠長。留空＝只看自己被排到的自評表。可多選。')
  await expect(viewerPlants.locator('.ant-select-selection-item')).toHaveCount(0)
  await dialog.getByRole('radio', { name: /^稽核人員/ }).check()
  await expect(viewerPlants).toHaveCount(0)
  await dialog.getByRole('radio', { name: /^一般使用者/ }).check()
  await viewerPlants.click()
  await page.keyboard.type(FACTORY)
  await page.locator('.ant-select-item-option', { hasText: `${FACTORY} ${PLANT_NAME}` }).click()
  await page.keyboard.press('Escape')
  await expect(viewerPlants).toContainText(`${FACTORY} ${PLANT_NAME}`)
  await dialog.getByTestId('access-note').fill('新任廠長')
  await dialog.getByRole('button', { name: '加入 1 人' }).click()
  await expect(dialog).toHaveCount(0)

  const row = memberRow(page, NEWCOMER.empId)
  await expect(row).toContainText(NEWCOMER.name)
  await expect(row.getByTestId('access-member-role')).toHaveText('一般使用者')
  await expect(row).toContainText('新任廠長')
  await expect(row).toContainText('尚未登入')
  // 「廠區權限」視窗裡一般使用者有上下兩區（Q153）：檢視廠區（系統維護員能改）與負責的廠區。
  await row.getByTestId('access-plant-rights').click()
  const rights = page.getByTestId('access-rights-modal')
  const viewGroup = rights.getByTestId('access-rights-group-view')
  const runGroup = rights.getByTestId('access-rights-group-run')
  await expect(viewGroup).toContainText('選填，只有系統維護員能改')
  await expect(viewGroup.getByRole('checkbox', { name: new RegExp(FACTORY) })).toBeChecked()
  await expect(viewGroup.getByRole('checkbox', { name: new RegExp(FACTORY) })).toBeEnabled()
  await expect(viewGroup.getByTestId('access-rights-view-count')).toHaveText(/^已選 1 \//)
  await expect(runGroup).toContainText('負責的廠區（廠區管理員）')
  await expect(runGroup.getByRole('checkbox', { name: new RegExp(FACTORY) })).not.toBeChecked()
  await expect(runGroup.getByTestId('access-rights-count')).toHaveText(/^已選 0 \//)
  await page.keyboard.press('Escape')
  await expect(rights).toHaveCount(0)
  // 加入者在編輯視窗的建立資訊裡（#215 拿掉人員表的「怎麼進來」）。
  await row.getByTestId('access-edit').click()
  const edit = page.getByTestId('access-edit-modal')
  await edit.getByTestId('access-created').getByText('建立資訊').click()
  await expect(edit.getByTestId('access-created')).toContainText(MAINT.name)

  // 改成稽核人員：檢視廠區清空；沒負責廠區時只能看（Q144），對方第一次登入看得到範本管理、沒有追蹤總覽
  await edit.getByRole('radio', { name: /^稽核人員/ }).check()
  await edit.getByRole('button', { name: /儲\s*存/ }).click()
  await expect(edit).toHaveCount(0)
  await expect(row.getByTestId('access-member-role')).toHaveText('稽核人員')
  // 稽核人員的廠區權限只有管理的廠區那一區，他還沒有。
  await row.getByTestId('access-plant-rights').click()
  await expect(rights.getByTestId('access-rights-mode')).toContainText('管理的廠區')
  await expect(viewGroup).toHaveCount(0)
  await expect(rights.getByTestId('access-rights-count')).toHaveText(/^已選 0 \//)
  await page.keyboard.press('Escape')
  await expect(rights).toHaveCount(0)

  const newcomerPage = await browser.newPage()
  await actAs(newcomerPage, NEWCOMER)
  await expect(newcomerPage.getByTestId('nav-home')).toBeVisible()
  await expect(newcomerPage.getByTestId('nav-templates')).toBeVisible()
  await expect(newcomerPage.getByTestId('nav-tracking')).toHaveCount(0)
  await newcomerPage.close()
  await page.reload()
  await expect(memberRow(page, NEWCOMER.empId)).not.toContainText('尚未登入')

  // 他被排上簽核流程的台北稽核人員（在名單上才排得進去，Q150；分派的畫面在分派的測試）。
  ok(await admin.from('route_step').update({ signer_emp_id: NEWCOMER.empId }).eq('id', taipeiStepId))
  // 移除（在編輯視窗左下）：確認框列出他還在的關卡，要先換人，不能移除（Q150）
  await memberRow(page, NEWCOMER.empId).getByTestId('access-edit').click()
  await page.getByTestId('access-edit-modal').getByTestId('access-remove').click()
  const remove = page.getByTestId('access-remove-modal')
  await expect(remove.getByTestId('access-impact-route')).toHaveText(`FQ-02 採購及付款循環 × ${FACTORY} ${PLANT_NAME}：第 1 關 台北稽核人員`)
  await expect(remove.getByTestId('access-impact-current')).toHaveCount(0)
  await expect(remove.getByTestId('access-impact')).toContainText('要先換人才能移除')
  await expect(remove.getByTestId('access-remove-ok')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(remove).toHaveCount(0)
  await expect(memberRow(page, NEWCOMER.empId)).toBeVisible()

  // 流程換回別人之後就能移除
  ok(await admin.from('route_step').update({ signer_emp_id: CHIEF.empId }).eq('id', taipeiStepId))
  await memberRow(page, NEWCOMER.empId).getByTestId('access-edit').click()
  await page.getByTestId('access-edit-modal').getByTestId('access-remove').click()
  await expect(remove.getByTestId('access-impact-none')).toBeVisible()
  await remove.getByTestId('access-remove-ok').click()
  await expect(remove).toHaveCount(0)
  await expect(memberRow(page, NEWCOMER.empId)).toHaveCount(0)

  // 異動紀錄（新到舊）
  await page.getByRole('tab', { name: '異動紀錄' }).click()
  const log = page.getByTestId('access-log').getByRole('row').filter({ hasText: NEWCOMER.empId })
  await expect(log.getByTestId('access-log-content')).toHaveText([
    '移除　稽核人員；備註 新任廠長',
    `檢視廠區　${FACTORY} ${PLANT_NAME} → （無）`,
    '角色　一般使用者 → 稽核人員',
    `加入　一般使用者；檢視廠區 ${FACTORY} ${PLANT_NAME}；備註 新任廠長`,
  ])
  await expect(log.first()).toContainText(`${MAINT.name}（${MAINT.empId}）`)
})

test('the 管理員帳號, on no list, manages access like a 系統維護員; its changes say 管理員帳號 (#161)', async ({ page }) => {
  await fakeOmsRoster(page)
  await actAsAdminAccount(page)
  // Its role is 系統維護員, so it gets every page (Q129).
  for (const shown of ['nav-launch', 'nav-assignment']) await expect(page.getByTestId(shown), shown).toBeVisible()
  await page.getByTestId('nav-access').click()
  await expect(page).toHaveURL(/\/admin\/access$/)
  // Not an employee: it is not among the people on the list.
  await expect(memberRow(page, MAINT.empId)).toBeVisible()
  for (const empId of ['admin', 'ADMIN']) await expect(memberRow(page, empId)).toHaveCount(0)

  await page.getByTestId('access-add').click()
  const dialog = page.getByTestId('access-add-modal')
  // Every role, 系統維護員 included, as a 系統維護員 gets: four since Q153. 一般使用者 is ticked to start with.
  await expect(dialog.getByRole('radio')).toHaveCount(4)
  await expect(dialog.getByRole('radio', { name: /^一般使用者/ })).toBeChecked()
  await dialog.getByTestId('access-emp-ids').fill(NEWCOMER.empId)
  await expect(dialog.getByTestId(`access-plan-${NEWCOMER.empId}`)).toContainText('加入')
  await dialog.getByRole('button', { name: '加入 1 人' }).click()
  await expect(dialog).toHaveCount(0)
  const row = memberRow(page, NEWCOMER.empId)
  await row.getByTestId('access-edit').click()
  const edit = page.getByTestId('access-edit-modal')
  await edit.getByTestId('access-created').getByText('建立資訊').click()
  await expect(edit.getByTestId('access-created')).toContainText('加入・管理員帳號')

  await edit.getByTestId('access-remove').click()
  await page.getByTestId('access-remove-ok').click()
  await expect(memberRow(page, NEWCOMER.empId)).toHaveCount(0)

  await page.getByRole('tab', { name: '異動紀錄' }).click()
  const log = page.getByTestId('access-log').getByRole('row').filter({ hasText: NEWCOMER.empId })
  await expect(log.first().getByTestId('access-log-content')).toContainText('移除')
  await expect(log.first()).toContainText('管理員帳號')
  await expect(log.first()).not.toContainText('（admin）')
})

test('a 系統維護員 adds one 稽核主管 at a time: two pasted 工號 are refused before anything is sent (#187)', async ({ page }) => {
  const SECOND = `${RUN}M`
  await fakeOmsRoster(page, [NEWCOMER, { empId: SECOND, name: '測試第二位' }])
  await actAs(page, MAINT)
  await page.getByTestId('nav-access').click()
  await page.getByTestId('access-add').click()
  const dialog = page.getByTestId('access-add-modal')
  await dialog.getByTestId('access-emp-ids').fill(`${NEWCOMER.empId}、${SECOND}`)
  await expect(dialog.getByRole('button', { name: '加入 2 人' })).toBeVisible()
  await dialog.getByRole('radio', { name: /^稽核主管/ }).check()
  await expect(dialog.getByTestId('access-single-admin')).toHaveText('稽核主管剛好一位，一次只能加入一位')
  await dialog.getByRole('button', { name: '加入 2 人' }).click()
  // Still open, nothing added.
  await expect(dialog.getByRole('button', { name: '加入 2 人' })).toBeVisible()
  for (const empId of [NEWCOMER.empId, SECOND]) await expect(memberRow(page, empId)).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('a 系統維護員 gets every page a 稽核主管 does, 年度發起 and 分派 included, and the 範本 buttons (Q129)', async ({ page }) => {
  await actAs(page, MAINT)
  for (const shown of ['nav-home', 'nav-templates', 'nav-flows', 'nav-launch', 'nav-assignment', 'nav-access', 'nav-records', 'nav-tracking']) {
    await expect(page.getByTestId(shown), shown).toBeVisible()
  }
  await page.goto('/admin/templates')
  await expect(page.getByTestId('nav-assessing-units')).toBeVisible()
  // 修改 on a 範本 and a 簽核流程 of the year still to launch.
  await page.goto(`/admin/templates/${fq02}`)
  await expect(page.getByTestId('template-heading')).toContainText('FQ-02')
  await expect(page.getByTestId('start-editing')).toBeVisible()
  await page.goto(`/admin/flows/${routeId}`)
  await expect(page.getByTestId('route-heading')).toContainText(PLANT_NAME)
  await expect(page.getByTestId('start-editing')).toBeVisible()
})

test('a 稽核主管 lets no one in and sets no role (Q150): no 加入人員 or 編輯, but 廠區權限 for whoever may run a plant', async ({ page }) => {
  await actAs(page, CHIEF)
  await page.getByTestId('nav-access').click()
  for (const empId of [CHIEF.empId, MAINT.empId]) {
    await expect(memberRow(page, empId).getByTestId('access-member-role')).toBeVisible()
    await expect(memberRow(page, empId).getByTestId('access-edit')).toHaveCount(0)
  }
  await expect(page.getByTestId('access-add')).toHaveCount(0)
  // 廠區權限只用來指定廠區管理員：稽核主管自己可以管廠，系統維護員不管廠（Q122 (2)）。
  await expect(memberRow(page, CHIEF.empId).getByTestId('access-plant-rights')).toBeVisible()
  await expect(memberRow(page, MAINT.empId).getByTestId('access-plant-rights')).toHaveCount(0)
})

const OWNER: Person = { empId: `${RUN}O`, name: '測試負責人' }
const STAFF: Person = { empId: `${RUN}T`, name: '測試稽核人員' }

test('a 稽核主管 makes someone the 廠區負責人 from the plant card; they get 追蹤總覽 and the log says so', async ({ page, browser }) => {
  const r = await exchangeAs(OWNER.empId, OWNER.name)
  if (!r.ok) throw new Error(`exchange: ${r.error}`)
  ok(await admin.from('access_allowlist').insert({ emp_id: OWNER.empId }))
  const st = await exchangeAs(STAFF.empId, STAFF.name)
  if (!st.ok) throw new Error(`exchange: ${st.error}`)
  ok(await admin.from('employee_ref').update({ audit_role: 'audit_staff' }).eq('emp_id', STAFF.empId))
  ok(await admin.from('access_allowlist').insert({ emp_id: STAFF.empId }))
  try {
    const before = await browser.newPage()
    await actAs(before, OWNER)
    await expect(before.getByTestId('nav-home')).toBeVisible()
    await expect(before.getByTestId('nav-tracking')).toHaveCount(0)
    await before.close()

    await actAs(page, CHIEF)
    await page.getByTestId('nav-access').click()
    const card = page.getByTestId(`access-plant-${FACTORY}`)
    await expect(card.getByTestId('access-plant-coordinator')).toHaveText('未指定')
    await card.click()
    const dialog = page.getByTestId('access-coordinator-modal')
    await dialog.getByTestId('access-coordinator-pick').click()
    // 稽核人員 and the 稽核主管 come first, under their own heading (#187, Q140).
    await expect(page.locator('.ant-select-item-group').first()).toHaveText('稽核人員、稽核主管')
    await expect(page.locator('.ant-select-item-option', { hasText: STAFF.empId })).toBeVisible()
    // A 系統維護員 is not among the choices (Q122 (2)).
    await page.keyboard.type(MAINT.empId)
    await expect(page.locator('.ant-select-item-option', { hasText: MAINT.empId })).toHaveCount(0)
    await page.keyboard.press('Control+A')
    await page.keyboard.type(OWNER.empId)
    await page.locator('.ant-select-item-option', { hasText: OWNER.empId }).click()
    // Someone from the plant is allowed, and the dialog says the Taipei 稽核人員 step will not follow (#187).
    await expect(dialog.getByTestId('access-coordinator-not-linked')).toHaveText('這一廠的台北稽核人員將不連動，需在流程裡設定')
    await dialog.getByTestId('access-coordinator-pick').click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type(STAFF.empId)
    await page.locator('.ant-select-item-option', { hasText: STAFF.empId }).click()
    await expect(dialog.getByTestId('access-coordinator-not-linked')).toHaveCount(0)
    await dialog.getByTestId('access-coordinator-pick').click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type(OWNER.empId)
    await page.locator('.ant-select-item-option', { hasText: OWNER.empId }).click()
    await dialog.getByTestId('access-coordinator-ok').click()
    await expect(dialog).toHaveCount(0)

    await expect(card.getByTestId('access-plant-coordinator')).toHaveText(OWNER.name)
    // 點姓名，右邊只留下他負責的廠區，管理員篩選跟著選到他（#215）。
    const row = memberRow(page, OWNER.empId)
    await row.getByTestId('access-member-name').click()
    await expect(page.getByTestId('access-plant-cells').getByRole('button')).toHaveCount(1)
    await expect(page.getByTestId('access-plant-owner-filter')).toContainText(`${OWNER.name}（1）`)
    await row.getByTestId('access-member-name').click()
    await expect(page.getByTestId('access-plant-owner-filter')).toContainText('全部管理員')
    // 他的廠區權限在「負責的廠區」那一區勾著這一廠，檢視廠區那一區是空的（稽核主管只能看，Q153）。
    await row.getByTestId('access-plant-rights').click()
    const rights = page.getByTestId('access-rights-modal')
    await expect(rights.getByTestId('access-rights-group-run').getByRole('checkbox', { name: new RegExp(FACTORY) })).toBeChecked()
    await expect(rights.getByTestId('access-rights-group-view').getByRole('checkbox', { name: new RegExp(FACTORY) })).not.toBeChecked()
    await page.keyboard.press('Escape')
    await expect(rights).toHaveCount(0)
    // 稽核主管不能移除他（Q150）；系統維護員移除之前，確認框先說哪些廠區會變成未指定。
    await expect(row.getByTestId('access-edit')).toHaveCount(0)
    const maint = await browser.newPage()
    await actAs(maint, MAINT)
    await maint.getByTestId('nav-access').click()
    await memberRow(maint, OWNER.empId).getByTestId('access-edit').click()
    await maint.getByTestId('access-edit-modal').getByTestId('access-remove').click()
    const removal = maint.getByTestId('access-remove-modal')
    await expect(removal.getByTestId('access-remove-plants')).toContainText(`${FACTORY} ${PLANT_NAME}`)
    await maint.keyboard.press('Escape')
    await expect(removal).toHaveCount(0)
    await maint.close()

    await page.getByRole('tab', { name: '異動紀錄' }).click()
    const log = page.getByTestId('access-log').getByRole('row').filter({ hasText: OWNER.empId })
    await expect(log.getByTestId('access-log-content')).toHaveText([`指定為廠區管理員　${FACTORY} ${PLANT_NAME}`, '加入　一般使用者'])

    await page.getByRole('tab', { name: '權限說明' }).click()
    await expect(page.getByTestId('access-guide-matrix')).toContainText('＋負責廠區')
    await expect(page.getByTestId('access-guide-matrix')).toContainText('稽核人員')
    await expect(page.getByTestId('access-guide-notes')).toContainText('看得到的廠區為原本角色與負責廠區的合計')

    const owner = await browser.newPage()
    await actAs(owner, OWNER)
    await expect(owner.getByTestId('nav-tracking')).toBeVisible()
    await owner.close()
  } finally {
    await admin.from('access_allowlist').delete().eq('emp_id', OWNER.empId)
    await admin.from('access_allowlist').delete().eq('emp_id', STAFF.empId)
  }
})

const HEAD: Person = { empId: `${RUN}H`, name: '測試廠長' }
const AUDITOR: Person = { empId: `${RUN}U`, name: '測試稽核二' }

test('廠區權限 of a 一般使用者 has two groups: a 稽核主管 sees the 檢視廠區 greyed and only names 廠區管理員, a 系統維護員 changes both (Q153)', async ({ page, browser }) => {
  const r = await exchangeAs(HEAD.empId, HEAD.name)
  if (!r.ok) throw new Error(`exchange: ${r.error}`)
  ok(await admin.from('access_allowlist').insert({ emp_id: HEAD.empId }))
  // 有檢視廠區的一般使用者（之前的檢視者）：直接寫資料表，畫面上的設定在第一個測試。
  ok(await admin.from('employee_ref').update({ viewer_plant_ids: [plantId] }).eq('emp_id', HEAD.empId))
  const a = await exchangeAs(AUDITOR.empId, AUDITOR.name)
  if (!a.ok) throw new Error(`exchange: ${a.error}`)
  ok(await admin.from('employee_ref').update({ audit_role: 'audit_staff' }).eq('emp_id', AUDITOR.empId))
  ok(await admin.from('access_allowlist').insert({ emp_id: AUDITOR.empId }))
  const plantsOf = async () => {
    const me = ok(await admin.from('employee_ref').select('audit_role,viewer_plant_ids').eq('emp_id', HEAD.empId).single()) as { audit_role: string; viewer_plant_ids: string[] }
    const runs = ok(await admin.from('plant_coordinator').select('plant_id').eq('emp_id', HEAD.empId)) as { plant_id: string }[]
    return { role: me.audit_role, views: me.viewer_plant_ids, runs: runs.map((p) => p.plant_id) }
  }
  try {
    // 他只有檢視廠區、不負責廠區：選單有進度追蹤（看的是檢視廠區，不是角色），沒有指派簽核人。
    const head = await browser.newPage()
    await actAs(head, HEAD)
    await expect(head.getByTestId('nav-tracking')).toBeVisible()
    await expect(head.getByTestId('nav-assignment')).toHaveCount(0)
    await expect(head.getByTestId('nav-access')).toHaveCount(0)
    await head.close()

    // 稽核主管：名單上是一般使用者，廠區格子的提示寫「檢視廠區：他」。
    await actAs(page, CHIEF)
    await page.getByTestId('nav-access').click()
    const row = memberRow(page, HEAD.empId)
    await expect(row.getByTestId('access-member-role')).toHaveText('一般使用者')
    await expect(page.getByTestId(`access-plant-${FACTORY}`)).toHaveAttribute('title', new RegExp(`檢視廠區：${HEAD.name}`))
    // 角色篩選沒有檢視者。
    await page.getByTestId('access-role-filter').click()
    await expect(page.locator('.ant-select-item-option')).toHaveText(['全部角色', '一般使用者', '稽核人員', '稽核主管', '系統維護員'])
    await page.keyboard.press('Escape')

    // 廠區權限：上下兩區。檢視廠區變灰、不能改，寫明只有系統維護員能改；負責的廠區照常能勾。
    await row.getByTestId('access-plant-rights').click()
    const rights = page.getByTestId('access-rights-modal')
    const viewGroup = rights.getByTestId('access-rights-group-view')
    const runGroup = rights.getByTestId('access-rights-group-run')
    await expect(viewGroup.getByTestId('access-rights-view-hint')).toContainText('只有系統維護員能改，這裡只能看')
    await expect(viewGroup.getByRole('checkbox', { name: new RegExp(FACTORY) })).toBeChecked()
    for (const box of await viewGroup.getByRole('checkbox').all()) await expect(box).toBeDisabled()
    await expect(viewGroup.getByTestId('access-rights-view-clear')).toHaveCount(0)
    await expect(runGroup.getByRole('checkbox', { name: new RegExp(FACTORY) })).toBeEnabled()
    await runGroup.getByRole('checkbox', { name: new RegExp(FACTORY) }).check()
    // 廠區端的人當廠區管理員：台北稽核人員不連動的提醒照舊。
    await expect(rights.getByTestId('access-coordinator-not-linked')).toBeVisible()
    await rights.getByRole('button', { name: /儲\s*存/ }).click()
    await expect(rights).toHaveCount(0)
    // 只送了負責的廠區：檢視廠區原樣（沒有被資料庫擋下），一個人同時有兩種。
    expect(await plantsOf()).toEqual({ role: 'signer', views: [plantId], runs: [plantId] })

    // 系統維護員：兩區都能改，一次儲存寫兩區（清掉檢視廠區、卸任廠區管理員）。
    const maint = await browser.newPage()
    await actAs(maint, MAINT)
    await maint.getByTestId('nav-access').click()
    await memberRow(maint, HEAD.empId).getByTestId('access-plant-rights').click()
    const maintRights = maint.getByTestId('access-rights-modal')
    const maintView = maintRights.getByTestId('access-rights-group-view')
    await expect(maintView.getByTestId('access-rights-view-hint')).toContainText('選填，只有系統維護員能改')
    await maintView.getByRole('checkbox', { name: new RegExp(FACTORY) }).uncheck()
    await expect(maintView.getByTestId('access-rights-view-count')).toHaveText(/^已選 0 \//)
    await maintRights.getByTestId('access-rights-group-run').getByRole('checkbox', { name: new RegExp(FACTORY) }).uncheck()
    await maintRights.getByRole('button', { name: /儲\s*存/ }).click()
    await expect(maintRights).toHaveCount(0)
    expect(await plantsOf()).toEqual({ role: 'signer', views: [], runs: [] })

    // 權限說明：四個系統角色加廠區管理員，沒有檢視者那一欄與那一張卡；一般使用者的卡寫檢視廠區。
    await maint.getByRole('tab', { name: '權限說明' }).click()
    const guide = maint.getByTestId('access-guide')
    // 廠區管理員是加在系統角色上的身分：排在最後一欄，只寫兼任後多出來的（使用者 2026-11-26，和權限申請表一致）。
    const matrix = guide.getByTestId('access-guide-matrix')
    await expect(matrix.getByRole('columnheader')).toHaveText(['功能／操作', '一般使用者', '稽核人員', '稽核主管', '系統維護員', '廠區管理員（兼任）兼任後多出的'])
    await expect(guide.getByTestId('access-guide-add-on-hint')).toContainText('空白＝和原本角色一樣')
    const cells = (name: string) => matrix.getByRole('row').filter({ hasText: name }).getByRole('cell')
    await expect(cells('作答、送出、核准、退回')).toHaveText(['作答、送出、核准、退回（輪到的關卡）', '✓', '✓', '✓', '✓', ''])
    await expect(cells('看全部自評表與答案')).toHaveText(['看全部自評表與答案', '檢視廠區', '—', '✓', '✓', '＋負責廠區'])
    await expect(cells('匯出 PDF')).toHaveText(['匯出 PDF（看得到的自評表）', '✓', '✓', '✓', '✓', ''])
    await expect(cells('發出前指派簽核人')).toHaveText(['發出前指派簽核人', '—', '—', '✓', '✓', '＋負責廠區'])
    // 發出後只有稽核主管與系統維護員能換人（Q147）：兼任廠區管理員不會多出這一項。
    await expect(cells('發出後替還沒簽的關卡換人')).toHaveText(['發出後替還沒簽的關卡換人', '—', '—', '✓', '✓', ''])
    // 稽核人員那一欄是沒兼廠區管理員時的權限（使用者 2026-11-27）。
    await expect(cells('匯出 Excel')).toHaveText(['匯出 Excel', '檢視廠區', '—', '✓', '✓', '＋負責廠區'])
    await expect(cells('題庫、自評單位')).toHaveText(['題庫、自評單位', '—', '唯讀', '✓', '✓', '＋負責廠區'])
    // 表格不寫兼任的說明：只有稽核人員兼任才有的三項，寫在表下的規則（使用者 2026-11-27）；身分卡片拿掉了。
    await expect(guide.getByTestId('access-guide-notes')).toContainText('僅限稽核人員兼任；廠區端人員兼任者無此權限')
    await expect(guide).not.toContainText('檢視者')
    await expect(guide.getByTestId('access-guide-signer')).toHaveCount(0)
    await maint.close()

    // 稽核人員照舊只有「負責的廠區」一區，稽核主管勾了就存得進去（這個視窗沒有檢視廠區可送）。
    await page.reload()
    const auditor = memberRow(page, AUDITOR.empId)
    await auditor.getByTestId('access-plant-rights').click()
    await expect(rights.getByTestId('access-rights-mode')).toContainText('管理的廠區')
    await expect(viewGroup).toHaveCount(0)
    await rights.getByRole('checkbox', { name: new RegExp(FACTORY) }).check()
    await rights.getByRole('button', { name: /儲\s*存/ }).click()
    await expect(rights).toHaveCount(0)
  } finally {
    await admin.from('plant_coordinator').delete().eq('plant_id', plantId)
    for (const p of [HEAD, AUDITOR]) await admin.from('access_allowlist').delete().eq('emp_id', p.empId)
  }
})

test('異動紀錄 still words the entries that name the retired 檢視者, the conversion’s own (no operator) included (Q153)', async ({ page }) => {
  // The dev database has none of these, so the log's answer is made up; the rest of the page is real.
  const entry = { changed_at: '2026-11-26T02:00:00+00:00', target_emp_id: 'FQ0012', target_name: '李大同' }
  await page.route('**/rest/v1/access_change_log*', (route) =>
    route.fulfill({
      json: [
        { ...entry, id: 3, actor_emp_id: null, actor_name: null, action: 'role', before: 'viewer', after: 'signer' },
        { ...entry, id: 2, actor_emp_id: MAINT.empId, actor_name: MAINT.name, action: 'viewer_plants', before: [], after: [FACTORY] },
        { ...entry, id: 1, actor_emp_id: MAINT.empId, actor_name: MAINT.name, action: 'added', before: null, after: { role: 'viewer', viewer_plants: [], note: '廠長' } },
      ],
    }),
  )
  await actAs(page, MAINT)
  await page.getByTestId('nav-access').click()
  await page.getByRole('tab', { name: '異動紀錄' }).click()
  const log = page.getByTestId('access-log').getByRole('row').filter({ hasText: 'FQ0012' })
  await expect(log.getByTestId('access-log-content')).toHaveText([
    '角色　檢視者（已取消） → 一般使用者',
    `檢視廠區　（無） → ${FACTORY} ${PLANT_NAME}`,
    '加入　檢視者（已取消）；備註 廠長',
  ])
  // The conversion has no operator: shown as the 部署指令, like every change made without someone signed in.
  await expect(log.first()).toContainText('部署指令')
  await expect(page.getByTestId('access-log')).not.toContainText('role.viewer')
  // The 動作 filter still narrows them.
  await page.getByTestId('access-log-action').click()
  await page.locator('.ant-select-item-option', { hasText: /^角色$/ }).click()
  await expect(log).toHaveCount(1)
})
