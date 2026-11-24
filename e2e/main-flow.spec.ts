import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { allText, readPdf } from '../src/pdf/testing/pdfText'
import {
  actAs,
  PEOPLE,
  PLANT_NAME,
  setUpMainFlow,
  signoffsOf,
  STEPS,
  tearDownMainFlow,
  UNITS,
  YEAR,
  type MainFlow,
} from './support/mainFlow'

// 里程碑 1 主線驗收（#8，分流版 Q116）：對真實的 Postgres＋PostgREST，三個自評單位各一條分流（自行檢查人員 → 部門主管），
// 同一位自行檢查人員一個單位接一個送出 → 同一位部門主管一個單位接一個核准 → 匯流到廠區經理人，退回資材自行檢查人員
// （只有資材分流重來）→ 重新簽到稽核主管結案 → 匯出 PDF 檢查簽核欄。順便涵蓋 #6、#37 交給端對端驗收的畫面行為：
// 簽核列只在主管／稽核關卡出現、退回的必填檢查、簽核歷程與頁尾的簽核流程、暫存後重新進入、首頁「我的自評表」（Q115）。
// 資料與身分見 support/mainFlow.ts；選擇器只用角色、標籤與 data-testid，答題頁加欄位（#9）不影響。

// Filled in as setup goes, so afterAll removes whatever was built even when setup fails halfway.
const flow: Partial<MainFlow> = {}

test.beforeAll(async () => {
  await setUpMainFlow(flow)
})

test.afterAll(async () => {
  await tearDownMainFlow(flow)
})

const HEADING = `${YEAR} 年度　${PLANT_NAME}　FQ-02 採購及付款循環`
/** How 首頁's 我的自評表 names this run's 自評表. */
const CARD_HEADING = `${YEAR}　${PLANT_NAME}　FQ-02 採購及付款循環`
/** A 關卡 as the 核准／退回 panel and the 簽核歷程 name it (#99): 「資材單位・自行檢查人員」 in a 分流, the name after the 匯流. */
const stepLabel = (position: number) => {
  const step = STEPS[position - 1]!
  return step.branch ? `${step.branch}・${step.name.replace(`－${step.branch}`, '')}` : step.name
}
const RETURN_REASON = '請資材單位重新確認請購核准紀錄'

const currentStep = (page: Page) => page.getByTestId('current-step')
/** The 目前關卡 of the 自評表 page after the 匯流, which also says how many 關卡 there are. */
const expectCurrentStep = (page: Page, position: number) =>
  expect(currentStep(page)).toHaveText(`第 ${position} 關／共 ${STEPS.length} 關：${STEPS[position - 1]!.name}`)
/** The 目前關卡 while the 分流 run: how many of the three units are done. */
const expectUnitsDone = (page: Page, done: number) => expect(currentStep(page)).toHaveText(`${UNITS.length} 個單位已完成 ${done} 個`)
/** Each 關卡's state in the 簽核流程 at the foot of the page, by position. */
const routeStates = (page: Page) =>
  page
    .getByTestId('route-step')
    .evaluateAll((nodes) =>
      nodes
        .map((n) => [Number(n.getAttribute('data-position')), n.getAttribute('data-state')] as const)
        .sort((x, y) => x[0] - y[0])
        .map(([, state]) => state),
    )
const states = (done: number[], current: number[]) =>
  STEPS.map((_, i) => (done.includes(i + 1) ? 'done' : current.includes(i + 1) ? 'current' : 'todo'))
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** This run's row in 我的自評表's 待處理 tab, where the home page opens when something waits. */
const myTodoRow = (page: Page) => page.getByTestId('my-todo').getByRole('row').filter({ hasText: CARD_HEADING })

/** From the home page into the 自評表 through 待處理, the way a 自行檢查人員 or signer gets there. */
async function openFromMyTasks(page: Page) {
  await myTodoRow(page).getByTestId('my-action').click()
  await expect(page.getByTestId('assessment-heading')).toHaveText(HEADING)
}

/** Nothing waits for this person: 待處理 counts 0. */
const expectNothingToDo = (page: Page) => expect(page.getByTestId('my-tab-todo-count')).toHaveText('0')

/** Back to the home page by the breadcrumb: a client-side navigation, so the lists must refresh themselves. */
async function backToHome(page: Page) {
  await page.getByRole('navigation').getByRole('link', { name: '首頁' }).click()
  await expect(page.getByTestId('greeting')).toBeVisible()
}

/** The 我參與的 row of this run's 自評表, opening that tab first. */
async function myAssessmentRow(page: Page) {
  await page.getByTestId('my-tab-all').click()
  return page.getByTestId('my-all').getByRole('row').filter({ hasText: CARD_HEADING })
}

/** Every radio of `unit` for one field and option, by its label 「第 n 章第 m 題 單位 欄位：選項」. */
const radiosOf = (page: Page, unit: string, choice: string) =>
  page.getByRole('radio', { name: new RegExp(`^第 \\d+ 章第 \\d+ 題 ${unit} ${choice}$`) })
const YES = '內部控制制度執行情形：是'

/** Ticks 有內控規範／是／滿意 on every row of `unit` and 尚屬滿意 for its 整體結論. */
async function answerAll(page: Page, unit: string) {
  for (const choice of ['內部控制制度設計：有內控規範', YES, '設計、執行有效控制滿意度：滿意']) {
    const radios = radiosOf(page, unit, choice)
    const count = await radios.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) await radios.nth(i).check()
  }
  await page.getByTestId('conclusions').getByRole('radio', { name: '尚屬滿意', exact: true }).check()
}

/** 送出 and confirm the popup (antd spaces two-character labels: 確 定). */
async function clickSubmit(page: Page) {
  await page.getByTestId('submit-answers').click()
  await page.getByRole('tooltip').getByRole('button', { name: /確\s*定|OK/ }).click()
}

/** 送出 that goes through: the unit's 分流 moves on to its 部門主管. */
async function submit(page: Page, nextPosition: number) {
  await clickSubmit(page)
  await expect(page.getByText(`已送出，本單位接著到第 ${nextPosition} 關`)).toBeVisible()
}

/** 核准 the 關卡 at `position`, which the panel must be showing. */
async function approve(page: Page, position: number, comment: string) {
  await expect(page.getByTestId('signoff-panel')).toContainText(stepLabel(position))
  await page.getByTestId('open-approve').click()
  await page.getByTestId('approve-comment').fill(comment)
  await page.getByTestId('confirm-approve').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

const editingNote = (page: Page, unit: string) => page.getByTestId('editing-note').filter({ hasText: `「${unit}」` })

test('主線：答題送出 → 主管核准 → 廠區經理人退回 → 重新簽到稽核主管結案 → 匯出 PDF', async ({ page }) => {
  test.setTimeout(300_000)
  const consoleErrors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  let returnCalls = 0
  page.on('request', (r) => {
    if (r.url().includes('/rpc/return_assessment')) returnCalls++
  })

  await test.step('不在流程上的人：兩個清單都是空的，網址打開也讀不到', async () => {
    await actAs(page, PEOPLE.outsider)
    await expect(page.getByTestId('my-todo-empty')).toHaveText('目前沒有等你填寫或簽核的自評表')
    await page.getByTestId('my-tab-all').click()
    await expect(page.getByTestId('my-all-empty')).toHaveText('目前沒有你在流程上的當期自評表')
    await page.goto(`/assessments/${flow.assessmentId}`)
    await expect(page.getByTestId('assessment-not-found')).toBeVisible()
  })

  await test.step('稽核管理者（稽核室三關）：還沒輪到也列在我參與的，打開沒有核准／退回', async () => {
    await actAs(page, PEOPLE.auditAdmin)
    await expectNothingToDo(page)
    const row = await myAssessmentRow(page)
    await expect(row).toContainText('尚未輪到我')
    await row.getByTestId('my-assessment').click()
    await expectUnitsDone(page, 0)
    await expect(page.getByTestId('current-signer')).toContainText(`品保單位：${PEOPLE.selfChecker.name}`)
    await expect(page.getByTestId('read-only-note')).toBeVisible()
    await expect(page.getByTestId('signoff-panel')).toHaveCount(0)
  })

  await test.step('自行檢查人員：三個單位同時輪到他，一次答一個；資材單位送出後同一頁接著換品保單位', async () => {
    await actAs(page, PEOPLE.selfChecker)
    // 輪到他答題：開始填寫，進度只數資材單位的題目，還沒答。
    await expect(myTodoRow(page).getByTestId('my-action')).toHaveText('開始填寫')
    await expect(myTodoRow(page).getByTestId('my-progress')).toContainText('尚未開始')
    await openFromMyTasks(page)
    await expectUnitsDone(page, 0)
    expect(await routeStates(page)).toEqual(states([], [1, 2, 3]))
    // 自行檢查人員的關卡以送出簽核，沒有核准／退回列。
    await expect(page.getByTestId('signoff-panel')).toHaveCount(0)
    await expect(editingNote(page, '資材單位')).toBeVisible()
    await answerAll(page, '資材單位')
    await submit(page, 4)
    await expect(editingNote(page, '品保單位')).toBeVisible()
    // 資材的部門主管已經可以簽，品保、財會還在填。
    expect(await routeStates(page)).toEqual(states([1], [2, 3, 4]))
  })

  await test.step('品保單位：暫存 → 回首頁 → 再進來，剛暫存的答案還在；送出', async () => {
    await answerAll(page, '品保單位')
    await page.getByTestId('save-answers').click()
    await expect(page.getByText('已暫存', { exact: true })).toBeVisible()
    await backToHome(page)
    // 暫存過：繼續填寫。進度數他現在輪到的品保、財會兩個單位的題目，財會還沒答。
    await expect(myTodoRow(page).getByTestId('my-action')).toHaveText('繼續填寫')
    await expect(myTodoRow(page).getByTestId('my-progress')).toContainText(/已答 [1-9]\d*／\d+ 題/)
    await openFromMyTasks(page)
    await expect(radiosOf(page, '品保單位', YES).first()).toBeChecked()
    await expect(page.getByTestId('conclusions').getByRole('radio', { name: '尚屬滿意', exact: true })).toBeChecked()
    await submit(page, 5)
  })

  await test.step('財會單位：沒答完送出會列出缺什麼、不推進；答完再送出', async () => {
    await expect(editingNote(page, '財會單位')).toBeVisible()
    await clickSubmit(page)
    await expect(page.getByTestId('violations')).toContainText('自評表尚未送出')
    await expect(editingNote(page, '財會單位')).toBeVisible()
    await answerAll(page, '財會單位')
    await submit(page, 6)
    // 輪到部門主管：自行檢查人員只剩唯讀。
    await expect(page.getByTestId('read-only-note')).toBeVisible()
    await backToHome(page)
    await expectNothingToDo(page)
    await expect(await myAssessmentRow(page)).toContainText('我的部分已完成')
  })

  await test.step('部門主管 × 3 一個單位接一個核准，全部核准才匯流；簽核流程與簽核歷程跟著走', async () => {
    await actAs(page, PEOPLE.manager)
    await expect(myTodoRow(page).getByTestId('my-action')).toHaveText('前往簽核')
    await openFromMyTasks(page)
    expect(await routeStates(page)).toEqual(states([1, 2, 3], [4, 5, 6]))
    await approve(page, 4, `${STEPS[3]!.name} 已檢視`)
    await expect(page.getByText('已核准；等其他單位都完成後，自評表才往下簽核')).toBeVisible()
    await expectUnitsDone(page, 1)
    await expect(page.getByTestId('route-merge')).toHaveText('1/3')
    for (const position of [5, 6]) await approve(page, position, `${STEPS[position - 1]!.name} 已檢視`)
    await expect(page.getByText(`已核准，自評表移到「${stepLabel(7)}」`)).toBeVisible()
    await expectCurrentStep(page, 7)
    expect(await routeStates(page)).toEqual(states(range(1, 6), [7]))
    const rows = page.getByTestId('signoff-row')
    await expect(rows).toHaveCount(6)
    await expect(rows.and(page.locator('[data-action="submit"]'))).toHaveCount(3)
    await expect(rows.and(page.locator('[data-action="approve"]'))).toHaveCount(3)
    await expect(page.getByTestId('signoff-history')).toContainText('部門主管－財會單位 已檢視')
  })

  await test.step('廠區經理人退回：沒選關卡、或原因空白都不送出', async () => {
    const errorsBefore = consoleErrors.length
    await page.getByTestId('open-return').click()
    await page.getByTestId('confirm-return').click()
    await expect(page.getByText('請選擇要退回的關卡')).toBeVisible()
    await expect(page.getByText('請填寫退回原因')).toBeVisible()

    await page.getByTestId('return-target').click()
    // antd draws the visible option apart from its role="option" twin, which stays hidden; the visible one has the title.
    // (The 簽核流程 nodes carry the same title, so look inside the dropdown.)
    await page.locator('.ant-select-dropdown').getByTitle(stepLabel(1), { exact: true }).click()
    await expect(page.getByText('請選擇要退回的關卡')).toHaveCount(0)
    await page.getByTestId('return-reason').fill('   ')
    await page.getByTestId('confirm-return').click()
    await expect(page.getByText('請填寫退回原因')).toBeVisible()
    expect(consoleErrors.slice(errorsBefore)).toEqual([])
    await expectCurrentStep(page, 7)
  })

  await test.step('廠區經理人退回到資材單位：只有資材分流的簽核作廢，品保、財會維持已核准', async () => {
    await page.getByTestId('return-reason').fill(RETURN_REASON)
    await page.getByTestId('confirm-return').click()
    await expect(page.getByText(`已退回「${stepLabel(1)}」，作廢 2 筆簽核`)).toBeVisible()
    // Only this one reached the database: the refused tries above sent nothing.
    expect(returnCalls).toBe(1)
    await expectUnitsDone(page, 2)
    await expect(page.getByTestId('signoff-panel')).toHaveCount(0)
    expect(await routeStates(page)).toEqual(states([2, 3, 5, 6], [1]))
    await expect(page.getByTestId('route-branch').filter({ hasText: '資材單位' })).toContainText('退回 ×1')
    const rows = page.getByTestId('signoff-row')
    await expect(rows).toHaveCount(7)
    // 依時間：三個送出、三個核准、退回。
    expect(await rows.evaluateAll((rs) => rs.map((r) => r.getAttribute('data-action')))).toEqual([
      'submit', 'submit', 'submit', 'approve', 'approve', 'approve', 'return',
    ])
    await expect(rows.and(page.locator('[data-voided="true"]'))).toHaveCount(2)
    await expect(rows.and(page.locator('[data-action="return"]'))).toContainText(RETURN_REASON)
    await expect(rows.and(page.locator('[data-action="return"]'))).toContainText(`至 ${stepLabel(1)}`)
    await expect(rows.and(page.locator('[data-voided="true"]')).first()).toContainText('作廢')
    await backToHome(page)
    // 他還有資材的部門主管（第 4 關）與廠區經理人，要等資材重新送出才再輪到。
    await expectNothingToDo(page)
    await expect(await myAssessmentRow(page)).toContainText('尚未輪到我')
  })

  await test.step('自行檢查人員只重新送出資材單位（答案保留）', async () => {
    await actAs(page, PEOPLE.selfChecker)
    await openFromMyTasks(page)
    await expect(editingNote(page, '資材單位')).toBeVisible()
    await expect(radiosOf(page, '資材單位', YES).first()).toBeChecked()
    await submit(page, 4)
    await expect(page.getByTestId('read-only-note')).toBeVisible()
  })

  await test.step('資材部門主管與廠區經理人再核准', async () => {
    await actAs(page, PEOPLE.manager)
    await openFromMyTasks(page)
    for (const position of [4, 7]) await approve(page, position, `${STEPS[position - 1]!.name} 重新檢視`)
    await expect(page.getByText(`已核准，自評表移到「${stepLabel(8)}」`)).toBeVisible()
    await backToHome(page)
    await expectNothingToDo(page)
    await expect(await myAssessmentRow(page)).toContainText('我的部分已完成')
  })

  await test.step('稽核室三關核准，最後一關提醒結案；結案後簽核列消失', async () => {
    await actAs(page, PEOPLE.auditAdmin)
    await openFromMyTasks(page)
    await expectCurrentStep(page, 8)
    for (const position of [8, 9]) await approve(page, position, '')
    await expectCurrentStep(page, 10)
    await page.getByTestId('open-approve').click()
    await expect(page.getByTestId('approve-last-note')).toBeVisible()
    await page.getByTestId('confirm-approve').click()
    await expect(page.getByText('已核准，自評表已結案')).toBeVisible()
    await expect(page.getByTestId('assessment-info').getByText('結案', { exact: true })).toBeVisible()
    await expect(page.getByTestId('signoff-panel')).toHaveCount(0)
    await expect(page.getByTestId('read-only-note')).toBeVisible()
    expect(await routeStates(page)).toEqual(states(range(1, STEPS.length), []))
  })

  await test.step('簽核流程的每一關寫出簽核人姓名，滑過看工號與完成時間', async () => {
    const last = page.locator('[data-testid="route-step"][data-position="10"]')
    await expect(last).toContainText('稽核主管')
    await expect(last).toContainText(PEOPLE.auditAdmin.name)
    await expect(last).not.toContainText('已核准')
    await expect(last).toHaveAttribute('title', new RegExp(`（${PEOPLE.auditAdmin.empId}）\\n\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`))
    await expect(page.getByTestId('route-merge')).toHaveText('3/3')
  })

  await test.step('寬螢幕：簽核歷程精簡成五欄放在簽核流程左邊，一樣高、不左右捲動；框內捲動時表頭固定', async () => {
    const viewport = page.viewportSize()!
    await page.setViewportSize({ width: 1440, height: 900 })
    const history = page.getByTestId('signoff-history')
    const flow = page.getByTestId('signoff-route')
    const [h, f] = [(await history.boundingBox())!, (await flow.boundingBox())!]
    expect([h.y, h.x < f.x, Math.round(h.height)]).toEqual([f.y, true, Math.round(f.height)])
    await expect(history.getByRole('columnheader')).toHaveText(['編號', '時間', '關卡／簽核人', '動作／狀態', '意見／原因'])
    // The 狀態 sits under the 動作; the 簽核人 under the 關卡.
    const voided = history.getByTestId('signoff-row').and(page.locator('[data-voided="true"]')).first()
    await expect(voided.getByTestId('signoff-action-state')).toContainText('作廢')
    await expect(voided.getByTestId('signoff-step-signer')).toContainText(`（${PEOPLE.selfChecker.empId}）`)
    // The box never scrolls sideways. The main flow's records are fixed and outgrow the 簽核流程's height, so it scrolls
    // up and down, and the header row stays at the box's top.
    const box = history.getByTestId('signoff-history-scroll')
    const sizes = await box.evaluate((el) => ({ sideways: el.scrollWidth - el.clientWidth, tall: el.scrollHeight > el.clientHeight }))
    expect(sizes).toEqual({ sideways: 0, tall: true })
    await box.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    const header = (await history.getByRole('columnheader').first().boundingBox())!
    expect(Math.round(header.y)).toBe(Math.round((await box.boundingBox())!.y))
    await page.setViewportSize(viewport)
    // Narrower, the two stack and the history is the full seven columns again.
    await expect(history.getByRole('columnheader')).toHaveCount(7)
  })

  await test.step('首頁「我參與的」：已結案，截止日不再標逾期或快到', async () => {
    await backToHome(page)
    await expectNothingToDo(page)
    const row = await myAssessmentRow(page)
    await expect(row).toContainText('已結案')
    await expect(row.getByTestId('due-overdue').or(row.getByTestId('due-soon'))).toHaveCount(0)
  })

  await test.step('匯出 PDF：簽核欄是十關有效的簽核，作廢的只在簽核歷程頁', async () => {
    await (await myAssessmentRow(page)).getByTestId('my-assessment').click()
    const downloading = page.waitForEvent('download')
    await page.getByTestId('export-pdf').click()
    await page.getByTestId('export-pdf-with-signed-at').click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe(`${YEAR}_${PLANT_NAME}_FQ-02_採購及付款循環.pdf`)
    const pages = await readPdf(new Uint8Array(await readFile(await download.path())))

    const signoffs = await signoffsOf(flow.assessmentId!)
    const valid = signoffs.filter((s) => s.action !== 'return' && !s.voided_at)
    const voided = signoffs.filter((s) => s.voided_at)
    expect(valid.map((s) => s.step_position).sort((a, b) => a - b)).toEqual(STEPS.map((_, i) => i + 1))
    expect(voided).toHaveLength(2)

    // 簽核欄在整體結論那一頁；之後是簽核歷程。
    const at = pages.findIndex((p) => p.lines.some((l) => l.includes('稽核室覆核')))
    expect(at).toBeGreaterThan(0)
    const signaturePage = pages[at]!.lines.join('\n')
    const serial = (n: number) => new RegExp(`No\\. ${n}(?!\\d)`)
    for (const s of valid) expect(signaturePage).toMatch(serial(s.serial_no))
    for (const s of voided) expect(signaturePage).not.toMatch(serial(s.serial_no))
    expect(signaturePage.match(new RegExp(PEOPLE.selfChecker.name, 'g'))).toHaveLength(3)
    expect(signaturePage.match(new RegExp(PEOPLE.manager.name, 'g'))).toHaveLength(4)
    expect(signaturePage.match(new RegExp(PEOPLE.auditAdmin.name, 'g'))).toHaveLength(3)

    const history = allText(pages.slice(at + 1))
    expect(history).toContain('簽核歷程')
    expect(history.match(/ 作廢$/gm)).toHaveLength(2)
    // No 「第 N 關」 (#99): where the 退回 went, by unit and name, on the line below it.
    expect(history).toMatch(new RegExp(` 退回 ${RETURN_REASON}\\n.*至 ${stepLabel(1)}$`, 'm'))
  })

  await test.step('匯出不含簽核時間的 PDF：簽核欄只印姓名，沒有簽核歷程頁（Q109）', async () => {
    const downloading = page.waitForEvent('download')
    await page.getByTestId('export-pdf').click()
    await page.getByTestId('export-pdf-without-signed-at').click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe(`${YEAR}_${PLANT_NAME}_FQ-02_採購及付款循環_不含簽核時間.pdf`)
    const pages = await readPdf(new Uint8Array(await readFile(await download.path())))

    const signaturePage = pages.at(-1)!.lines.join('\n')
    expect(signaturePage).toContain('稽核室覆核')
    expect(signaturePage.match(new RegExp(PEOPLE.manager.name, 'g'))).toHaveLength(4)
    expect(signaturePage).not.toMatch(/No\. \d|\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    expect(allText(pages)).not.toContain('簽核歷程')
  })

  expect(consoleErrors).toEqual([])
})
