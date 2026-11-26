import { expect, test, type Page, type Request, type Route } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import readXlsxFile from 'read-excel-file/node'
import writeXlsxFile from 'write-excel-file/node'
import { listedEmpIds, signInAsAuditAdmin } from './support/mockSession'

// 下載分派表／匯入分派表 (#180, Q130; Q147 (6), #224: 下次發出 on the 簽核流程, an issued 年度 on its 自評表). Every
// /rest/v1 answer and the CSA backend's OMS 比對 are made up here, so no database, OMS or sign-in is needed; who may
// write is the database's (tests/db/assignment_import.rls.test.ts) and the OMS 比對's own refusals are
// exchange/omsMatch.test.ts. Every 工號 is made up.

const PLANT = { id: 'p1', factory_code: 'FQ', name: '福清富群' }

type Step = { id: string; position: number; name: string; step_group: string; link: string | null; signer_emp_id: string | null; branch_unit_name: string | null; state: string }
  // The 連動 稽核室 steps carry their mark, as the database gives them (#189); only they are never assigned (Q143).
const LINKS: Record<string, string> = { 台北稽核人員: 'taipei_auditor', 稽核主管: 'audit_chief' }
const step = (id: string, position: number, name: string, unit: string | null, signer: string | null, state = 'pending', group = 'plant'): Step => ({
  id, position, name, step_group: group, link: LINKS[name] ?? null, signer_emp_id: signer, branch_unit_name: unit, state,
})
const form = (id: string, code: string, name: string, steps: Step[]) => ({
  id, template_code: code, template_name: name, status: 'in_progress', annual_cycle: { year: 2026, due_date: '2026-12-31' },
  assessment_step: steps.map((s) => ({ ...s, editable_unit_name: s.name.startsWith('自行檢查人員') ? s.branch_unit_name : null, vacated_emp_id: null, vacated_name: null })),
})

const FORMS = () => [
  form('f1', 'FQ-01.1', '銷售及收款循環', [
    step('s1', 1, '自行檢查人員－業務單位', '業務單位', 'FQ2100', 'done'),
    step('s2', 2, '部門主管－業務單位', '業務單位', 'FQ1300', 'current'),
    step('s3', 3, '自行檢查人員－品保單位', '品保單位', null),
    step('s4', 4, '部門主管－品保單位', '品保單位', null),
    step('s5', 5, '廠區經理人', null, 'FQ0140'),
    step('s6', 6, '稽核主管', null, 'A001', 'pending', 'audit_review'),
  ]),
  form('f2', 'FQ-02', '採購及付款循環', [
    step('t1', 1, '自行檢查人員－資材單位', '資材單位', 'FQ2101'),
    step('t2', 2, '部門主管－資材單位', '資材單位', null),
    step('t3', 3, '廠區經理人', null, null),
  ]),
]

/** A route's 關卡 as the database gives them to 下次發出 (Q147): no state, the 分流 unit by name. */
const routeStep = (id: string, position: number, name: string, unit: string | null, signer: string | null, group = 'plant') => ({
  id, position, name, step_group: group, link: LINKS[name] ?? null, signer_emp_id: signer, branch: unit ? { name: unit } : null,
})
const route = (id: string, code: string, name: string, steps: ReturnType<typeof routeStep>[]) => ({
  id, template: { code, name, layout: 'control_activity', all_plants: false, template_plant: [{ factory_code: 'FQ' }] }, route_step: steps,
})
/** FQ's 簽核流程 for the next launch: the same two 範本 as FORMS, with the people the routes have now. */
const ROUTES = () => [
  route('route-1', 'FQ-01.1', '銷售及收款循環', [
    routeStep('r1', 1, '自行檢查人員－業務單位', '業務單位', 'FQ2100'),
    routeStep('r2', 2, '部門主管－業務單位', '業務單位', 'FQ1300'),
    routeStep('r3', 3, '自行檢查人員－品保單位', '品保單位', null),
    routeStep('r4', 4, '部門主管－品保單位', '品保單位', null),
    routeStep('r5', 5, '廠區經理人', null, 'FQ0140'),
    routeStep('r6', 6, '稽核主管', null, 'A001', 'audit_review'),
  ]),
  route('route-2', 'FQ-02', '採購及付款循環', [
    routeStep('r7', 1, '自行檢查人員－資材單位', '資材單位', 'FQ2101'),
    routeStep('r8', 2, '部門主管－資材單位', '資材單位', null),
    routeStep('r9', 3, '廠區經理人', null, null),
  ]),
]

interface Mock {
  /** Hold the OMS answer until this resolves. */
  omsGate?: Promise<void>
  /** 稽核主管 (the default), or `signer`: runs FQ as its 廠區管理員. */
  role?: 'audit_admin' | 'signer'
  /** The plant's 簽核流程 (下次發出, Q147); none by default, so the page opens on the issued 年度. */
  routes?: ReturnType<typeof ROUTES>
  routeWrites?: Request[]
  /** plant_coordinator's rows: the plants the signed-in employee runs. */
  plants?: (typeof PLANT)[]
  oms?: Record<string, string>
  /** 工號 OMS has not enabled for CSA (沒勾 CSA); everyone else is. */
  noCsa?: string[]
  /** CSA_REQUIRE_OMS_AUTH on the backend. */
  csaRequired?: boolean
  /** 工號 not on CSA's 放行名單 (Q150); everyone else is. */
  unlisted?: string[]
  writes?: Request[]
  omsCalls?: Request[]
}

async function mockApi(page: Page, mock: Mock = {}) {
  const forms = FORMS()
  await page.route('**/rest/v1/**', async (r: Route) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    // Once the forms are out only a 稽核主管 imports; before the launch (下次發出) the plant's 廠區管理員 too (Q147).
    if (path.endsWith('/employee_ref')) return r.fulfill({ json: [{ audit_role: mock.role ?? 'audit_admin' }] })
    if (path.endsWith('/plant')) return r.fulfill({ json: mock.plants ?? [PLANT] })
    if (path.endsWith('/plant_coordinator')) return r.fulfill({ json: (mock.plants ?? [PLANT]).map((plant) => ({ plant })) })
    if (path.endsWith('/assessment')) return r.fulfill({ json: forms })
    if (path.endsWith('/approval_route')) return r.fulfill({ json: mock.routes ?? [] })
    if (path.endsWith('/rpc/listed_emp_ids')) return r.fulfill({ json: listedEmpIds(request.postDataJSON(), mock.unlisted) })
    if (path.endsWith('/rpc/import_route_assignment')) {
      mock.routeWrites?.push(request)
      const cells = (request.postDataJSON() as { p_cells: unknown[] }).p_cells
      return r.fulfill({ json: { written: cells.length } })
    }
    if (path.endsWith('/rpc/import_assignment')) {
      mock.writes?.push(request)
      const cells = (request.postDataJSON() as { p_cells: unknown[] }).p_cells
      return r.fulfill({ json: { written: cells.length, skipped: 0 } })
    }
    return r.fulfill({ json: [] })
  })
  await page.route('**/csa/exchange/oms-match', async (r: Route) => {
    mock.omsCalls?.push(r.request())
    await mock.omsGate
    const { emp_ids } = r.request().postDataJSON() as { emp_ids: string[] }
    const results = emp_ids.map((id) => ({ emp_id: id, status: mock.oms?.[id] ?? 'matched', csa: !mock.noCsa?.includes(id) }))
    return r.fulfill({ json: { results, csa_required: mock.csaRequired ?? false } })
  })
}

async function open(page: Page, mock: Mock = {}, url = '/admin/assignment') {
  await signInAsAuditAdmin(page)
  await mockApi(page, mock)
  await page.goto(url)
  await expect(page.getByTestId('assignment-forms')).toBeVisible()
}

/** Press 下載分派表 and return the file. */
async function download(page: Page): Promise<{ name: string; buffer: Buffer }> {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('assignment-download').click()])
  const path = await file.path()
  const { readFileSync } = await import('node:fs')
  return { name: file.suggestedFilename(), buffer: readFileSync(path) }
}

type Sheets = Awaited<ReturnType<typeof readXlsxFile>>

/** The downloaded file, edited as a 稽核人員 would, written back and uploaded. */
async function upload(page: Page, original: Buffer, edit: (sheets: Sheets) => void, name = 'FQ_分派表_2026.xlsx') {
  const sheets = await readXlsxFile(original)
  edit(sheets)
  const blob = await writeXlsxFile(sheets.map((s) => ({ sheet: s.sheet, data: s.data.map((row) => row.map((value) => (value === null ? null : { value: value as string | number | boolean }))) }))).toBuffer()
  await page.getByTestId('assignment-import-file').setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: blob })
  await expect(page.getByTestId('import-checks')).toBeVisible()
}

const main = (sheets: Sheets) => sheets[0]!.data
const system = (sheets: Sheets) => sheets.find((s) => s.sheet === '系統資料')!.data
/** Columns as downloaded: A 編號, B 名稱, C/D 業務單位, E/F 品保單位, G/H 資材單位, I 廠區經理人; rows 4 (FQ-01.1) and 5 (FQ-02). */
const COL = { salesSelf: 2, salesChief: 3, qualitySelf: 4, qualityChief: 5, materialSelf: 6, materialChief: 7, manager: 8 }
const set = (sheets: Sheets, row: number, col: number, value: string | null) => {
  main(sheets)[row - 1]![col] = value
}

test('下載的分派表：一廠一年度，帶入已分派的人，第 1 列與隱藏的系統資料寫明廠區與年度，工作表保護', async ({ page }) => {
  await open(page)
  const { name, buffer } = await download(page)
  expect(name).toBe('FQ_分派表_2026.xlsx')

  const sheets = await readXlsxFile(buffer)
  expect(sheets.map((s) => s.sheet)).toEqual(['分派表', '填寫說明', '系統資料'])
  const data = main(sheets)
  expect(String(data[0]![0])).toMatch(/^FQ 福清富群｜2026 年度 分派表　　產生時間 \d{4}-\d\d-\d\d \d\d:\d\d　　第 1～3 列與 A、B 欄是系統讀取的依據，請勿修改$/)
  // csa-assignment-v1, the same as the forms sent to the plants before this shipped.
  expect(data[1]).toEqual(['自評表編號', '自評表名稱', '業務單位', null, '品保單位', null, '資材單位', null, '廠區經理人'])
  expect(data[2]).toEqual([null, null, '自行檢查人員', '部門主管', '自行檢查人員', '部門主管', '自行檢查人員', '部門主管', null])
  expect(data[3]).toEqual(['FQ-01.1', '銷售及收款循環', 'FQ2100', 'FQ1300', null, null, '—', '—', 'FQ0140'])
  expect(data[4]).toEqual(['FQ-02', '採購及付款循環', '—', '—', '—', '—', 'FQ2101', null, null])
  expect(system(sheets).slice(0, 3).map((r) => r.slice(0, 2))).toEqual([['格式版本', 'csa-assignment-v1'], ['廠區代碼', 'FQ'], ['年度', '2026']])

  // 系統資料 is hidden and the sheet protected; which cells stay open is src/excel/assignmentWorkbook.test.ts.
  const files = unzipSync(new Uint8Array(buffer))
  expect(strFromU8(files['xl/workbook.xml']!)).toMatch(/name="系統資料"[^>]*state="veryHidden"/)
  expect(strFromU8(files['xl/worksheets/sheet1.xml']!)).toContain('<sheetProtection sheet="1"')
})

test('匯入：OMS 四種結果照規則處理，空白格、已簽關卡、灰色格不寫入，預覽後確認才寫入', async ({ page }) => {
  const writes: Request[] = []
  const omsCalls: Request[] = []
  await open(page, { writes, omsCalls, oms: { FQ0031: 'other_plant', FQ9999: 'not_found', FQ1352: 'departed' } })
  const { buffer } = await download(page)
  await upload(page, buffer, (sheets) => {
    set(sheets, 4, COL.salesSelf, 'FQ2188') // 已簽：跳過
    set(sheets, 4, COL.salesChief, null) // 空白：不動
    set(sheets, 4, COL.qualitySelf, 'fq2211 ') // 新分派，小寫照樣認
    set(sheets, 4, COL.qualityChief, 'FQ0031') // 廠區不同：照常寫入
    set(sheets, 4, COL.materialSelf, 'FQ2142') // 灰色格：不寫入，也不比對
    set(sheets, 5, COL.materialChief, 'FQ9999') // 不在 OMS
    set(sheets, 5, COL.manager, 'FQ1352') // 已離職
  })
  expect(writes).toHaveLength(0)

  const checks = page.getByTestId('import-checks')
  await expect(page.getByTestId('import-check-1')).toHaveAttribute('data-mark', 'ok')
  await expect(page.getByTestId('import-check-1')).toContainText('FQ｜2026 年度（第 1 列和隱藏的系統資料），和這一頁相同')
  await expect(page.getByTestId('import-check-2')).toHaveAttribute('data-mark', 'ok')
  await expect(page.getByTestId('import-check-3')).toContainText('2 列都是 FQ 2026 已發出的自評表')
  await expect(page.getByTestId('import-check-4')).toHaveAttribute('data-mark', 'warn')
  await expect(checks).toContainText('4 位對得上，3 位要看下面')

  // 每人只比一次，帶這一廠；灰色格的人不比對；token 給後端，OMS 金鑰不在前端。
  expect(omsCalls).toHaveLength(1)
  const asked = omsCalls[0]!.postDataJSON() as { factory_code: string; emp_ids: string[] }
  expect(asked.factory_code).toBe('FQ')
  expect([...asked.emp_ids].sort()).toEqual(['FQ0031', 'FQ0140', 'FQ1352', 'FQ2101', 'FQ2188', 'FQ2211', 'FQ9999'])
  expect(omsCalls[0]!.headers().authorization).toBe('Bearer not-checked-by-the-mocked-api')

  const people = page.getByTestId('import-people')
  await expect(people).toContainText('FQ0031')
  await expect(people).toContainText('工號在 OMS，在職，但不是 FQ 的員工（也不是派駐或兼管 FQ）')
  await expect(people).toContainText('OMS 查不到這個工號')
  await expect(people).toContainText('OMS 記錄已離職')
  await expect(people).toContainText('其餘 4 人')
  await expect(page.getByTestId('import-chip-not_found')).toContainText('1')
  await page.getByTestId('import-chip-other_plant').click()
  await expect(people.getByTestId('import-person')).toHaveCount(1)
  await expect(page.getByTestId('import-bulk')).toHaveCount(0)

  await page.getByTestId('import-confirm').click()
  await expect(page.getByTestId('import-checks')).toHaveCount(0)
  expect(writes).toHaveLength(1)
  expect((writes[0]!.postDataJSON() as { p_cells: unknown[] }).p_cells).toEqual([
    { step_id: 's3', emp_id: 'FQ2211' },
    { step_id: 's4', emp_id: 'FQ0031' },
  ])
  await expect(page.getByTestId('assignment-imported')).toContainText(
    '已匯入 FQ_分派表_2026.xlsx，寫入 2 格。1 位不在 OMS、1 位已離職，他們的格子沒有匯入。1 位不是 FQ 的員工，已照常分派，請確認是跨廠支援。',
  )
})

test('匯入：OMS 還沒回答就關掉預覽，晚到的答案不會再打開它', async ({ page }) => {
  let answer = () => {}
  const omsCalls: Request[] = []
  await open(page, { omsCalls, omsGate: new Promise<void>((resolve) => (answer = resolve)) })
  const { buffer } = await download(page)
  await upload(page, buffer, (sheets) => set(sheets, 4, COL.qualitySelf, 'FQ2211'))
  await expect(page.getByTestId('import-check-4')).toHaveAttribute('data-mark', 'pending')
  await page.getByTestId('import-close').click()
  await expect(page.getByTestId('import-checks')).toHaveCount(0)
  await expect.poll(() => omsCalls.length).toBe(1)
  answer()
  await page.waitForTimeout(500)
  await expect(page.getByTestId('import-checks')).toHaveCount(0)
})

test('匯入：還沒發出的自評表那幾列略過，其他照常匯入，完成後提醒發起後再匯入一次', async ({ page }) => {
  const writes: Request[] = []
  const omsCalls: Request[] = []
  await open(page, { writes, omsCalls })
  const { buffer } = await download(page)
  await upload(page, buffer, (sheets) => {
    // As the forms sent before the 年度 was launched: the file lists FQ-05, this page has not issued it.
    const rows = system(sheets)
    rows.push([6, 'FQ-05', '財會單位'])
    main(sheets).push(['FQ-05', '融資循環', null, null, null, null, null, null, 'FQ7777'])
    set(sheets, 4, COL.qualitySelf, 'FQ2211')
  })

  await expect(page.getByTestId('import-check-3')).toHaveAttribute('data-mark', 'warn')
  await expect(page.getByTestId('import-check-3')).toContainText('2 列是 FQ 2026 已發出的自評表；1 張還沒發出，這次略過')
  await expect(page.getByTestId('import-not-issued')).toContainText('第 6 列：FQ-05 融資循環')
  await expect(page.getByTestId('import-check-4')).not.toHaveAttribute('data-mark', 'pending')
  expect((omsCalls[0]!.postDataJSON() as { emp_ids: string[] }).emp_ids).not.toContain('FQ7777')

  await page.getByTestId('import-confirm').click()
  expect((writes[0]!.postDataJSON() as { p_cells: unknown[] }).p_cells).toEqual([{ step_id: 's3', emp_id: 'FQ2211' }])
  await expect(page.getByTestId('assignment-imported')).toContainText('1 張還沒發出的自評表這次略過，發起後再匯入一次。')
})

for (const csaRequired of [false, true]) {
  test(`匯入：OMS 還沒開通 CSA 的人${csaRequired ? '，開關打開後不匯入' : '只提醒、照常匯入'}（Q133 (4)）`, async ({ page }) => {
    const writes: Request[] = []
    await open(page, { writes, noCsa: ['FQ2211', 'FQ0031'], oms: { FQ0031: 'other_plant', FQ3001: 'on_leave' }, csaRequired })
    const { buffer } = await download(page)
    await upload(page, buffer, (sheets) => {
      set(sheets, 4, COL.qualitySelf, 'FQ2211')
      set(sheets, 4, COL.qualityChief, 'FQ0031')
      set(sheets, 5, COL.manager, 'FQ3001')
    })

    const people = page.getByTestId('import-people')
    await expect(page.getByTestId('import-chip-no_csa')).toContainText('2')
    await expect(page.getByTestId('import-chip-on_leave')).toContainText('1')
    await expect(page.getByTestId('import-chip-transferred')).toHaveCount(0) // only offered when someone has it
    await expect(people).toContainText('OMS 還沒開通 CSA（授權頁沒勾 CSA，或沒有啟用的帳號）')
    await expect(people).toContainText('OMS 記錄留職停薪')
    await expect(people).toContainText(csaRequired ? '這些格子不匯入。請 OMS 管理員在授權頁勾 CSA 後再匯入一次' : '照常分派（OMS 全面開通前只提醒）')
    await page.getByTestId('import-chip-no_csa').click()
    await expect(people.getByTestId('import-person')).toHaveCount(2)

    await page.getByTestId('import-confirm').click()
    const written = (writes[0]?.postDataJSON() as { p_cells: { emp_id: string }[] } | undefined)?.p_cells.map((c) => c.emp_id) ?? []
    expect(written).toEqual(csaRequired ? [] : ['FQ2211', 'FQ0031'])
    await expect(page.getByTestId('assignment-imported')).toContainText(
      csaRequired ? '2 位在 OMS 還沒開通 CSA，他們的格子沒有匯入。' : '2 位在 OMS 還沒開通 CSA，已照常分派，請 OMS 管理員勾 CSA。',
    )
    await expect(page.getByTestId('assignment-imported')).toContainText('1 位留停，他們的格子沒有匯入。')
  })
}

test('匯入：還不在放行名單上的人標「未放行」，他們的格子不寫入（Q150）', async ({ page }) => {
  const writes: Request[] = []
  await open(page, { writes, unlisted: ['FQ2211'] })
  const { buffer } = await download(page)
  await upload(page, buffer, (sheets) => {
    set(sheets, 4, COL.qualitySelf, 'fq2211') // 小寫照樣認出是同一個人
    set(sheets, 4, COL.qualityChief, 'FQ0031')
  })

  const people = page.getByTestId('import-people')
  await expect(page.getByTestId('import-chip-not_listed')).toContainText('1')
  await page.getByTestId('import-chip-not_listed').click()
  await expect(people.getByTestId('import-person')).toHaveCount(1)
  await expect(people.getByTestId('import-person')).toContainText('FQ2211')
  await expect(people.getByTestId('import-person')).toContainText('未放行')
  await expect(people).toContainText('還不在 CSA 放行名單上（沒申請 CSA 權限）')
  await expect(people).toContainText('這些格子不匯入。請他填權限申請表，系統維護員開通後再匯入一次')

  await page.getByTestId('import-confirm').click()
  expect(writes).toHaveLength(1)
  expect((writes[0]!.postDataJSON() as { p_cells: unknown[] }).p_cells).toEqual([{ step_id: 's4', emp_id: 'FQ0031' }])
  await expect(page.getByTestId('assignment-imported')).toContainText('1 位還不在 CSA 放行名單上，他們的格子沒有匯入，請系統維護員開通後再匯入。')
})

test('匯入：超過一半的人廠區不同，要勾選確認才能匯入', async ({ page }) => {
  const writes: Request[] = []
  await open(page, { writes, oms: { FQ2100: 'other_plant', FQ1300: 'other_plant', FQ0140: 'other_plant', FQ2211: 'other_plant' } })
  const { buffer } = await download(page)
  await upload(page, buffer, (sheets) => set(sheets, 4, COL.qualitySelf, 'FQ2211'))

  await expect(page.getByTestId('import-check-4')).toContainText('4 / 5 位不是 FQ 的員工，超過 50%，要確認')
  await expect(page.getByTestId('import-bulk')).toContainText('這份表多數人不是 FQ 的員工，可能貼錯廠區的名單')
  const confirm = page.getByTestId('import-confirm')
  await expect(confirm).toBeDisabled()
  await page.getByTestId('import-bulk-confirm').click()
  await confirm.click()
  expect((writes[0]!.postDataJSON() as { p_cells: unknown[] }).p_cells).toEqual([{ step_id: 's3', emp_id: 'FQ2211' }])
  await expect(page.getByTestId('assignment-imported')).toContainText('4 位不是 FQ 的員工，已照常分派（已勾選確認）。')
})

const STOPS: { title: string; edit: (sheets: Sheets) => void; check: number; says: string[]; redownload: boolean }[] = [
  {
    title: '錯廠區',
    edit: (s) => {
      main(s)[0]![0] = 'SY 台北總公司｜2026 年度 分派表'
      system(s)[1]![1] = 'SY'
    },
    check: 1, says: ['這是 SY 的分派表，不是 FQ 的', '檔案第 1 列和系統資料：SY｜2026 年度', '你現在匯入到：FQ 福清富群｜2026 年度'], redownload: false,
  },
  {
    title: '錯年度',
    edit: (s) => {
      main(s)[0]![0] = 'FQ 福清富群｜2025 年度 分派表'
      system(s)[2]![1] = '2025'
    },
    check: 1, says: ['這是 2025 年度的分派表，不是 2026 年度的'], redownload: false,
  },
  {
    title: '格式被改',
    edit: (s) => {
      for (const row of main(s)) row.splice(COL.qualityChief, 1)
      main(s)[1]!.push('備註')
    },
    check: 2, says: ['這份檔案的格式和系統產生時不同', '少了一欄：品保單位／部門主管', '多了不認得的欄：「備註」'], redownload: true,
  },
  {
    title: '過期',
    edit: (s) => {
      // As if FQ-02 had had 品保單位, not 資材單位, when the file was made.
      system(s).find((row) => row[1] === 'FQ-02')![2] = '品保單位'
    },
    check: 2, says: ['FQ-02 的自評單位和這份檔案產生時', '這份已過期'], redownload: true,
  },
  {
    title: '混入別廠或不存在的自評表',
    edit: (s) => main(s).push(['SY-03', '生產循環'], ['FQ-99', '不存在']),
    check: 3, says: ['有 2 列不是 FQ 2026 已發出的自評表', '第 6 列：SY-03 生產循環', '第 7 列：FQ-99 不存在'], redownload: true,
  },
]

for (const stop of STOPS) {
  test(`匯入：${stop.title}就整份擋下，說明原因，不比對也不寫入`, async ({ page }) => {
    const writes: Request[] = []
    const omsCalls: Request[] = []
    await open(page, { writes, omsCalls })
    const { buffer } = await download(page)
    await upload(page, buffer, stop.edit)

    await expect(page.getByTestId(`import-check-${stop.check}`)).toHaveAttribute('data-mark', 'bad')
    for (let later = stop.check + 1; later <= 4; later++) {
      await expect(page.getByTestId(`import-check-${later}`)).toContainText('前面沒通過，沒有檢查')
    }
    for (const text of stop.says) await expect(page.getByTestId('import-stop')).toContainText(text)
    await expect(page.getByTestId('import-foot')).toHaveText('整份不匯入，FQ 現在的分派沒有任何改變。')
    await expect(page.getByTestId('import-confirm')).toHaveCount(0)
    await expect(page.getByTestId('import-redownload')).toHaveCount(stop.redownload ? 1 : 0)
    expect(omsCalls).toHaveLength(0)
    await page.getByTestId('import-close').click()
    expect(writes).toHaveLength(0)
  })
}

test('不是系統產生的檔案也整份擋下', async ({ page }) => {
  await open(page)
  await page.getByTestId('assignment-import-file').setInputFiles({ name: 'names.xlsx', mimeType: 'text/plain', buffer: Buffer.from('工號\nFQ2211') })
  await expect(page.getByTestId('import-stop')).toContainText('這不是系統產生的分派表')
})

// 下次發出 (Q147 (6), #224): the same file, on the 簽核流程, before the launch -------------------------------------

for (const role of ['signer', 'audit_admin'] as const) {
  test(`下次發出：${role === 'signer' ? '廠區管理員' : '稽核主管'}下載流程上的人，匯入寫回流程（import_route_assignment），不動自評表`, async ({ page }) => {
    const routeWrites: Request[] = []
    const writes: Request[] = []
    const omsCalls: Request[] = []
    await open(page, { role, routes: ROUTES(), routeWrites, writes, omsCalls, oms: { FQ9999: 'not_found' } })
    await expect(page.getByTestId('assignment-year')).toContainText('下次發出')

    // The next launch's 年度: FQ's newest issued one is 2026.
    const { name, buffer } = await download(page)
    expect(name).toBe('FQ_分派表_2027.xlsx')
    const sheets = await readXlsxFile(buffer)
    expect(String(main(sheets)[0]![0])).toMatch(/^FQ 福清富群｜2027 年度 分派表（下次發出）　　產生時間 /)
    expect(main(sheets)[1]).toEqual(['自評表編號', '自評表名稱', '業務單位', null, '品保單位', null, '資材單位', null, '廠區經理人'])
    // The routes' people; the 連動 稽核主管 is not in it.
    expect(main(sheets)[3]).toEqual(['FQ-01.1', '銷售及收款循環', 'FQ2100', 'FQ1300', null, null, '—', '—', 'FQ0140'])
    expect(main(sheets)[4]).toEqual(['FQ-02', '採購及付款循環', '—', '—', '—', '—', 'FQ2101', null, null])
    expect(system(sheets).slice(0, 5).map((r) => r.slice(0, 2))).toEqual([
      ['格式版本', 'csa-assignment-v1'], ['廠區代碼', 'FQ'], ['年度', '2027'], ['產生時間', expect.any(String)], ['來源', 'CSA 分派填寫人頁・下次發出'],
    ])

    await upload(page, buffer, (sheets) => {
      set(sheets, 4, COL.salesSelf, 'FQ2188') // 流程上沒有人簽過：照樣換
      set(sheets, 4, COL.qualitySelf, 'fq2211') // 新分派
      set(sheets, 5, COL.manager, 'FQ9999') // 不在 OMS
    }, 'FQ_分派表_2027.xlsx')
    await expect(page.getByTestId('import-review')).toContainText('匯入到 FQ 福清富群・下次發出（2027 年度）')
    await expect(page.getByTestId('import-check-1')).toContainText('FQ｜2027 年度（第 1 列和隱藏的系統資料），是 FQ 下次發出的年度')
    await expect(page.getByTestId('import-check-3')).toContainText('簽核流程')
    await expect(page.getByTestId('import-check-3')).toContainText('2 列都是 FQ 下次發出的簽核流程')
    await expect(page.getByTestId('import-check-4')).toHaveAttribute('data-mark', 'warn')
    expect((omsCalls[0]!.postDataJSON() as { factory_code: string }).factory_code).toBe('FQ')
    await expect(page.getByTestId('import-foot')).toContainText('寫進簽核流程，發出時照抄進自評表')

    await page.getByTestId('import-confirm').click()
    await expect(page.getByTestId('import-checks')).toHaveCount(0)
    expect(writes).toHaveLength(0)
    expect(routeWrites).toHaveLength(1)
    expect((routeWrites[0]!.postDataJSON() as { p_cells: unknown[] }).p_cells).toEqual([
      { route_step_id: 'r1', emp_id: 'FQ2188' },
      { route_step_id: 'r3', emp_id: 'FQ2211' },
    ])
    await expect(page.getByTestId('assignment-imported')).toContainText('已匯入 FQ_分派表_2027.xlsx，寫入 2 格。1 位不在 OMS、0 位已離職，他們的格子沒有匯入。')
  })
}

test('下次發出：發出前寄出的檔案（2027）列了這次不會發給本廠的範本就略過；已發出年度（2026）的檔案擋下', async ({ page }) => {
  const routeWrites: Request[] = []
  await open(page, { role: 'signer', routes: ROUTES(), routeWrites })
  const { buffer } = await download(page)
  await upload(page, buffer, (sheets) => {
    system(sheets).push([6, 'FQ-05', '財會單位'])
    main(sheets).push(['FQ-05', '融資循環', null, null, null, null, null, null, 'FQ7777'])
    set(sheets, 4, COL.qualitySelf, 'FQ2211')
  })
  await expect(page.getByTestId('import-check-3')).toContainText('2 列是 FQ 下次發出的簽核流程；1 張下次不會發給 FQ，這次略過')
  await expect(page.getByTestId('import-not-issued')).toContainText('這 1 張自評表下次不會發給 FQ，這次略過')
  await expect(page.getByTestId('import-not-issued')).toContainText('第 6 列：FQ-05 融資循環')
  await expect(page.getByTestId('import-check-4')).not.toHaveAttribute('data-mark', 'pending')
  await page.getByTestId('import-confirm').click()
  expect((routeWrites[0]!.postDataJSON() as { p_cells: unknown[] }).p_cells).toEqual([{ route_step_id: 'r3', emp_id: 'FQ2211' }])
  await expect(page.getByTestId('assignment-imported')).toContainText('1 張下次不會發給 FQ 的自評表這次略過。')

  await upload(page, buffer, (sheets) => {
    main(sheets)[0]![0] = 'FQ 福清富群｜2026 年度 分派表'
    system(sheets)[2]![1] = '2026'
  })
  await expect(page.getByTestId('import-check-1')).toContainText('FQ｜2026 年度，和下次發出（FQ｜2027）不同')
  await expect(page.getByTestId('import-stop')).toContainText('這是 2026 年度的分派表，下次發出是 2027 年度')
  await expect(page.getByTestId('import-stop')).toContainText('你現在匯入到：FQ 福清富群｜下次發出（2027 年度）')
  await expect(page.getByTestId('import-confirm')).toHaveCount(0)
})

test('已發出的年度：廠區管理員只能下載，沒有匯入（Q147：發出後只有稽核主管換人）', async ({ page }) => {
  await open(page, { role: 'signer', routes: ROUTES() }, '/admin/assignment?plant=FQ&year=2026')
  await expect(page.getByTestId('assignment-year')).toContainText('2026')
  await expect(page.getByTestId('assignment-download')).toBeVisible()
  await expect(page.getByTestId('assignment-import')).toHaveCount(0)
  const { name } = await download(page)
  expect(name).toBe('FQ_分派表_2026.xlsx')

  // On 下次發出 the same 廠區管理員 imports.
  await page.getByTestId('assignment-year').click()
  await page.locator('.ant-select-item-option', { hasText: '下次發出' }).click()
  await expect(page.getByTestId('assignment-import')).toBeVisible()
})

test('已發出的年度：稽核主管照樣匯入，寫的是自評表（import_assignment）', async ({ page }) => {
  const writes: Request[] = []
  const routeWrites: Request[] = []
  await open(page, { routes: ROUTES(), writes, routeWrites }, '/admin/assignment?plant=FQ&year=2026')
  const { buffer } = await download(page)
  await upload(page, buffer, (sheets) => set(sheets, 4, COL.qualitySelf, 'FQ2211'))
  await expect(page.getByTestId('import-check-3')).toContainText('2 列都是 FQ 2026 已發出的自評表')
  await page.getByTestId('import-confirm').click()
  await expect(page.getByTestId('import-checks')).toHaveCount(0)
  expect(routeWrites).toHaveLength(0)
  expect((writes[0]!.postDataJSON() as { p_cells: unknown[] }).p_cells).toEqual([{ step_id: 's3', emp_id: 'FQ2211' }])
})

test('一般簽核人（不是廠區管理員、稽核主管）看不到下載與匯入', async ({ page }) => {
  await signInAsAuditAdmin(page)
  await mockApi(page, { plants: [] })
  await page.goto('/admin/assignment')
  await expect(page.getByTestId('assignment-empty')).toBeVisible()
  await expect(page.getByTestId('assignment-download')).toHaveCount(0)
  await expect(page.getByTestId('assignment-import')).toHaveCount(0)
})
