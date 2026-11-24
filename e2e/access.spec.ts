import { expect, test, type Page } from '@playwright/test'
import {
  admin, borrowFq02, exchangeAs, insertRow, makeRoute, ok, promoteToAuditAdmin, promoteToSystemMaintainer, releaseFq02, requirePostgrest,
} from '../tests/db/helpers'
import { actAs, actAsAdminAccount, type Person } from './support/mainFlow'

// 權限管理（#58、Q98、Q122；管理員帳號 #161）：對真實的 Postgres＋PostgREST，系統維護員在畫面上加入一個沒登入過的人 → 改角色 → 移除，
// 並看異動紀錄；稽核主管只看得到一般使用者、檢視者與稽核人員的選項（設成稽核主管會降級前任，只在資料庫測試裡試，免得動到共用資料庫的其他稽核主管）。誰能做什麼由資料庫決定，規則細節在
// tests/db/access_management.rls.test.ts；這裡驗畫面走得通。
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
  // 新人在這個廠區一條簽核流程上，移除時要被提醒（流程沒有狀態，每條都算，Q137 (6)）。
  // FQ-02 只適用福清（Q111），流程要掛在適用的廠區上，所以測試期間借給測試廠區，收尾時還回去。
  fq02 = await borrowFq02(FACTORY)
  routeId = await makeRoute(fq02, plantId, [
    { name: '台北稽核人員', group: 'audit_review', signer: NEWCOMER.empId, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: CHIEF.empId, unitId: null },
  ])
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
  // 先選檢視者再貼工號：OMS 回來後檢視廠區照樣預設帶他的 OMS 廠區
  await dialog.getByRole('radio', { name: /^檢視者/ }).check()
  await dialog.getByTestId('access-emp-ids').fill(`${NEWCOMER.empId.toLowerCase()}、${NOT_IN_OMS}\n${MAINT.empId}`)
  await expect(dialog.getByTestId(`access-plan-${NEWCOMER.empId}`)).toHaveText(`${NEWCOMER.empId}${NEWCOMER.name} ${FACTORY}加入`)
  await expect(dialog.getByTestId(`access-plan-${NOT_IN_OMS}`)).toContainText('OMS 查不到這個工號，不加入')
  await expect(dialog.getByTestId(`access-plan-${MAINT.empId}`)).toContainText('已在名單，略過')
  // 檢視廠區預設帶他的 OMS 廠區
  await expect(dialog.getByTestId('access-viewer-plants')).toContainText(`${FACTORY} ${PLANT_NAME}`)
  await dialog.getByTestId('access-note').fill('新任廠長')
  await dialog.getByRole('button', { name: '加入 1 人' }).click()
  await expect(dialog).toHaveCount(0)

  const row = memberRow(page, NEWCOMER.empId)
  await expect(row).toContainText(NEWCOMER.name)
  await expect(row.getByTestId('access-member-role')).toHaveText('檢視者')
  await expect(row).toContainText('新任廠長')
  await expect(row).toContainText('尚未登入')
  // 檢視廠區在「廠區權限」視窗裡：檢視者勾的是檢視廠區，預設帶他的 OMS 廠區（#215）。
  await row.getByTestId('access-plant-rights').click()
  const rights = page.getByTestId('access-rights-modal')
  await expect(rights.getByTestId('access-rights-mode')).toContainText('檢視廠區')
  await expect(rights.getByRole('checkbox', { name: new RegExp(FACTORY) })).toBeChecked()
  await expect(rights.getByTestId('access-rights-count')).toHaveText(/^已選 1 \//)
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
  // 稽核人員的廠區權限勾的是管理的廠區，他還沒有。
  await row.getByTestId('access-plant-rights').click()
  await expect(rights.getByTestId('access-rights-mode')).toContainText('管理的廠區')
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

  // 移除（在編輯視窗左下）：確認框提醒他還在簽核流程的關卡上，但不擋
  await memberRow(page, NEWCOMER.empId).getByTestId('access-edit').click()
  await page.getByTestId('access-edit-modal').getByTestId('access-remove').click()
  const remove = page.getByTestId('access-remove-modal')
  await expect(remove.getByTestId('access-impact-route')).toHaveText(`FQ-02 採購及付款循環 × ${FACTORY} ${PLANT_NAME}：第 1 關 台北稽核人員`)
  await expect(remove.getByTestId('access-impact-current')).toHaveCount(0)
  await remove.getByTestId('access-remove-ok').click()
  await expect(remove).toHaveCount(0)
  await expect(memberRow(page, NEWCOMER.empId)).toHaveCount(0)

  // 異動紀錄（新到舊）
  await page.getByRole('tab', { name: '異動紀錄' }).click()
  const log = page.getByTestId('access-log').getByRole('row').filter({ hasText: NEWCOMER.empId })
  await expect(log.getByTestId('access-log-content')).toHaveText([
    '移除　稽核人員；備註 新任廠長',
    `檢視廠區　${FACTORY} ${PLANT_NAME} → （無）`,
    '角色　檢視者 → 稽核人員',
    `加入　檢視者；檢視廠區 ${FACTORY} ${PLANT_NAME}；備註 新任廠長`,
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
  // Every role, 系統維護員 included, as a 系統維護員 gets.
  await expect(dialog.getByRole('radio')).toHaveCount(5)
  await dialog.getByRole('radio', { name: /^檢視者/ }).check()
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

test('a 稽核主管 is offered 一般使用者, 檢視者 and 稽核人員 only, and cannot edit or remove a 稽核主管 or 系統維護員', async ({ page }) => {
  await actAs(page, CHIEF)
  await page.getByTestId('nav-access').click()
  for (const empId of [CHIEF.empId, MAINT.empId]) {
    await expect(memberRow(page, empId).getByTestId('access-member-role')).toBeVisible()
    await expect(memberRow(page, empId).getByTestId('access-edit')).toHaveCount(0)
    await expect(memberRow(page, empId).getByTestId('access-plant-rights')).toHaveCount(0)
  }
  await page.getByTestId('access-add').click()
  const dialog = page.getByTestId('access-add-modal')
  await expect(dialog.getByRole('radio')).toHaveCount(3)
  await expect(dialog.getByTestId('access-role-signer')).toBeVisible()
  await expect(dialog.getByTestId('access-role-viewer')).toBeVisible()
  await expect(dialog.getByTestId('access-role-audit_staff')).toBeVisible()
  await page.keyboard.press('Escape')
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
    // 他的廠區權限勾著這一廠。
    await row.getByTestId('access-plant-rights').click()
    const rights = page.getByTestId('access-rights-modal')
    await expect(rights.getByRole('checkbox', { name: new RegExp(FACTORY) })).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(rights).toHaveCount(0)
    // 移除他之前，確認框先說哪些廠區會變成未指定。
    await row.getByTestId('access-edit').click()
    await page.getByTestId('access-edit-modal').getByTestId('access-remove').click()
    const removal = page.getByTestId('access-remove-modal')
    await expect(removal.getByTestId('access-remove-plants')).toContainText(`${FACTORY} ${PLANT_NAME}`)
    await page.keyboard.press('Escape')
    await expect(removal).toHaveCount(0)

    await page.getByRole('tab', { name: '異動紀錄' }).click()
    const log = page.getByTestId('access-log').getByRole('row').filter({ hasText: OWNER.empId })
    await expect(log.getByTestId('access-log-content')).toHaveText([`指定為廠區管理員　${FACTORY} ${PLANT_NAME}`, '加入　一般使用者'])

    await page.getByRole('tab', { name: '權限說明' }).click()
    await expect(page.getByTestId('access-guide-matrix')).toContainText('負責的廠區')
    await expect(page.getByTestId('access-guide-matrix')).toContainText('稽核人員')
    await expect(page.getByTestId('access-guide-audit_staff')).toContainText('台北稽核人員')
    await expect(page.getByTestId('access-guide-audit_admin')).toContainText('剛好一位')
    await expect(page.getByTestId('access-guide-coordinator-rule')).toContainText('一廠一位')

    const owner = await browser.newPage()
    await actAs(owner, OWNER)
    await expect(owner.getByTestId('nav-tracking')).toBeVisible()
    await owner.close()
  } finally {
    await admin.from('access_allowlist').delete().eq('emp_id', OWNER.empId)
    await admin.from('access_allowlist').delete().eq('emp_id', STAFF.empId)
  }
})
