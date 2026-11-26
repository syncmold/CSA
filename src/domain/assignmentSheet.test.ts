import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AssignableStep, AssignmentForm, AssignmentRoute, AssignmentStep } from '../api/assignment'
import { assignmentWorkbook, readWorkbook } from '../excel/assignmentWorkbook'
import {
  assignmentSheet,
  checkSheet,
  formSheetEntry,
  importPlan,
  OTHER_PLANT_WARNING_SHARE,
  routeSheetEntry,
  OLD_MAIN_SHEET_NAME,
  SHEET_NAMES,
  sheetLayout,
  unlisted,
  type OmsAnswer,
  type OmsStatus,
  type RawSheet,
  type SheetCell,
  type SheetEntry,
} from './assignmentSheet'

// 分派表 (#180, Q130; Q147 (6): 下次發出 on the 簽核流程, an issued 年度 on its 自評表), format csa-assignment-v1.
// Every 工號 here is made up.

const PLANT = { factoryCode: 'SY', plantName: '台北總公司', year: 2026 }
const NOW = new Date(2026, 10, 17, 10, 32)

let nextId = 0
const step = (position: number, name: string, unit: string | null, signer: string | null, state: AssignmentStep['state'] = 'pending', group = 'plant', link: string | null = null): AssignmentStep => ({
  id: `s${++nextId}`, position, name, step_group: group, link, signer_emp_id: signer, editable_unit_name: name.startsWith('自行檢查人員') ? unit : null,
  branch_unit_name: unit, state, vacated_emp_id: null, vacated_name: null,
} as AssignmentStep)

const form = (code: string, name: string, steps: AssignmentStep[], layout: AssignmentForm['template_layout'] = 'control_activity'): SheetEntry =>
  formSheetEntry({
    id: `f-${code}`, template_code: code, template_name: name, template_layout: layout, status: 'in_progress',
    annual_cycle: { year: 2026, due_date: '2026-12-31' }, assessment_step: steps,
  })

const branch = (start: number, unit: string, self: string | null, chief: string | null, selfState: AssignmentStep['state'] = 'pending') => [
  step(start, `自行檢查人員－${unit}`, unit, self, selfState),
  step(start + 1, `部門主管－${unit}`, unit, chief),
]

// SY-A answers as 要素類 whatever unit its 分流 has (here 管理單位, which SY-02 also has).
const forms = () => [
  form('SY-A', '控制環境', [...branch(1, '管理單位', null, null), step(3, '廠區經理人', null, 'SY0140')], 'element'),
  form('SY-01', '銷售及收款循環', [
    ...branch(1, '業務單位', 'SY2100', 'SY1300', 'done'),
    ...branch(3, '財會單位', null, null),
    step(5, '廠區經理人', null, 'SY0140'),
    step(6, '稽核主管', null, 'A001', 'pending', 'audit_review', 'audit_chief'),
  ]),
  form('SY-02', '採購及付款循環', [...branch(1, '管理單位', 'SY2101', 'SY1301'), step(3, '廠區經理人', null, null)]),
]

/** The sheets a downloaded file reads back as, through the real writer and reader. */
async function downloaded(rows = forms()): Promise<RawSheet[]> {
  return readWorkbook(await assignmentWorkbook(assignmentSheet(PLANT, PLANT.year, rows, NOW)))
}
// The fixture sent to the plants before Q151 still names its sheet 分派表.
const main = (sheets: RawSheet[]) => sheets.find((s) => s.sheet === SHEET_NAMES.main || s.sheet === OLD_MAIN_SHEET_NAME)!.data
const system = (sheets: RawSheet[]) => sheets.find((s) => s.sheet === SHEET_NAMES.system)!.data
const rowOf = (sheets: RawSheet[], code: string) => main(sheets).find((r) => r[0] === code)!
/** The column of a unit's 關卡 by the header rows (row 2 units, merged; row 3 關卡); unit null for 廠區經理人. */
const colOf = (sheets: RawSheet[], unit: string | null, stepName: string) => {
  const [units, steps] = [main(sheets)[1]!, main(sheets)[2]!]
  let current: string | null = null
  for (let i = 2; i < Math.max(units.length, steps.length); i++) {
    if (units[i]) current = steps[i] ? String(units[i]) : null
    const name = steps[i] ? String(steps[i]) : units[i] ? String(units[i]) : null
    if (name === stepName && current === unit) return i
  }
  throw new Error(`no column ${unit}／${stepName}`)
}
const put = (sheets: RawSheet[], code: string, unit: string | null, stepName: string, value: string | null) => {
  rowOf(sheets, code)[colOf(sheets, unit, stepName)] = value
}

describe('sheetLayout and assignmentSheet', () => {
  it('has two columns per unit, 要素類 last, then 廠區經理人; rows 控制活動類 first; greys out what a form does not have', () => {
    const sheet = assignmentSheet(PLANT, PLANT.year, forms(), NOW)
    expect(sheet.layout.columns.map((c) => `${c.unit ?? ''}/${c.step}`)).toEqual([
      '業務單位/自行檢查人員', '業務單位/部門主管', '財會單位/自行檢查人員', '財會單位/部門主管',
      '管理單位/自行檢查人員', '管理單位/部門主管', '要素類/自行檢查人員', '要素類/部門主管', '/廠區經理人',
    ])
    expect(sheet.layout.forms).toEqual([
      { code: 'SY-01', units: ['業務單位', '財會單位'] },
      { code: 'SY-02', units: ['管理單位'] },
      { code: 'SY-A', units: ['要素類'] },
    ])
    // Brings the people already assigned; '' to fill, null for a 灰色格; 稽核室 is not in it.
    expect(sheet.rows[0]).toEqual({ code: 'SY-01', name: '銷售及收款循環', cells: ['SY2100', 'SY1300', '', '', null, null, null, null, 'SY0140'] })
    expect(sheet.rows[2]!.cells).toEqual([null, null, null, null, null, null, '', '', 'SY0140'])
    expect(sheet.generatedAt).toBe('2026-11-17 10:32')
  })

  it('keeps an extra 關卡 of a 分流 in that unit', () => {
    const extra = forms()
    extra[2]!.steps.splice(2, 0, step(9, '課長－管理單位', '管理單位', null))
    const columns = sheetLayout(extra).columns.map((c) => `${c.unit ?? ''}/${c.step}`)
    expect(columns.slice(4, 7)).toEqual(['管理單位/自行檢查人員', '管理單位/部門主管', '管理單位/課長'])
  })
})

describe('checkSheet', () => {
  it('passes a file as downloaded: every filled cell is the person already there', async () => {
    const check = checkSheet(await downloaded(), PLANT, forms())
    expect(check.stop).toBeNull()
    if (check.stop !== null) return
    expect(check.rows).toBe(3)
    expect(check.cells.every((c) => c.kind === 'same')).toBe(true)
    expect(check.people).toEqual(['SY2100', 'SY1300', 'SY0140', 'SY2101', 'SY1301'])
  })

  it('still takes a file from before Q151: the sheet named 分派表 and row 1 ending in 分派表 (csa-assignment-v1 unchanged)', async () => {
    const old = (await downloaded()).map((s) => (s.sheet === SHEET_NAMES.main ? { ...s, sheet: OLD_MAIN_SHEET_NAME } : s))
    expect(SHEET_NAMES.main).toBe('指派表')
    expect(old.map((s) => s.sheet)).toEqual(['分派表', '填寫說明', '系統資料'])
    main(old)[0]![0] = 'SY 台北總公司｜2026 年度 分派表　　產生時間 2026-11-17 10:32　　第 1～3 列與 A、B 欄是系統讀取的依據，請勿修改'
    put(old, 'SY-01', '財會單位', '自行檢查人員', 'SY2155')
    const check = checkSheet(old, PLANT, forms())
    if (check.stop !== null) throw new Error(`stopped at ${check.stop}: ${JSON.stringify(check)}`)
    expect(check.rows).toBe(3)
    expect(check.cells.filter((c) => c.kind === 'change').map((c) => [c.formCode, c.step?.name, c.empId])).toEqual([
      ['SY-01', '自行檢查人員－財會單位', 'SY2155'],
    ])

    // A sheet under neither name is still not one of ours.
    const renamed = old.map((s) => (s.sheet === OLD_MAIN_SHEET_NAME ? { ...s, sheet: '工作表1' } : s))
    expect(checkSheet(renamed, PLANT, forms()).stop).toBe(1)
  })

  it('puts a 要素類 cell on the form’s own 分流, whatever its unit', async () => {
    const sheets = await downloaded()
    put(sheets, 'SY-A', '要素類', '自行檢查人員', 'SY2300')
    const check = checkSheet(sheets, PLANT, forms())
    if (check.stop !== null) throw new Error('should pass')
    const cell = check.cells.find((c) => c.formCode === 'SY-A' && c.kind === 'change')!
    expect(cell.step).toMatchObject({ name: '自行檢查人員－管理單位', branch_unit_name: '管理單位' })
  })

  describe('1 檔案是哪一廠', () => {
    it("stops another plant's file, whatever its name", async () => {
      const check = checkSheet(await downloaded(), { ...PLANT, factoryCode: 'FQ', plantName: '福清' }, forms())
      expect(check).toEqual({ stop: 1, claim: { title: { factoryCode: 'SY', year: 2026 }, system: { factoryCode: 'SY', year: 2026 } } })
    })

    it("stops another 年度's file", async () => {
      expect(checkSheet(await downloaded(), { ...PLANT, year: 2027 }, forms()).stop).toBe(1)
    })

    it('stops when row 1 and 系統資料 disagree, or the 系統資料 is gone', async () => {
      const edited = await downloaded()
      main(edited)[0]![0] = 'FQ 福清｜2026 年度 指派表'
      expect(checkSheet(edited, PLANT, forms())).toMatchObject({ stop: 1, claim: { title: { factoryCode: 'FQ' }, system: { factoryCode: 'SY' } } })

      const noSystem = (await downloaded()).filter((s) => s.sheet !== SHEET_NAMES.system)
      expect(checkSheet(noSystem, PLANT, forms())).toEqual({ stop: 1, claim: { title: { factoryCode: 'SY', year: 2026 }, system: null } })
    })
  })

  describe('2 格式', () => {
    it('finds columns and rows by their text, so reordering them passes', async () => {
      const sheets = await downloaded()
      const data = main(sheets)
      // Swap the 業務單位 and 財會單位 pairs (header cells and all), and the first two rows.
      for (const row of data) if (row.length > 5) [row[2], row[3], row[4], row[5]] = [row[4], row[5], row[2], row[3]]
      ;[data[3], data[4]] = [data[4]!, data[3]!]
      put(sheets, 'SY-01', '財會單位', '自行檢查人員', 'SY2102')
      const check = checkSheet(sheets, PLANT, forms())
      expect(check.stop).toBeNull()
      if (check.stop !== null) return
      expect(check.cells.find((c) => c.kind === 'change')).toMatchObject({ formCode: 'SY-01', column: { unit: '財會單位', step: '自行檢查人員' }, empId: 'SY2102' })
    })

    it('stops a missing column and an unknown one', async () => {
      const sheets = await downloaded()
      const chief = colOf(sheets, '管理單位', '部門主管')
      for (const row of main(sheets)) row.splice(chief, 1)
      main(sheets)[1]!.push('備註')
      expect(checkSheet(sheets, PLANT, forms())).toEqual({ stop: 2, missing: ['管理單位／部門主管'], unknown: ['備註'], unnamed: [], expired: null })
    })

    it('stops a file whose 自評單位 are not the form’s any more, however recently it was made', async () => {
      const changed = forms()
      changed[2]!.steps.push(...branch(7, '品保單位', null, null))
      expect(checkSheet(await downloaded(), PLANT, changed)).toEqual({
        stop: 2, missing: [], unknown: [], unnamed: [], expired: { generatedAt: '2026-11-17 10:32', codes: ['SY-02'] },
      })
    })
  })

  it('stops a missing 自評表名稱 column, and 工號 typed under a column with no heading', async () => {
    const sheets = await downloaded()
    const data = main(sheets)
    for (const row of data) row.splice(1, 1)
    data[3]![data[1]!.length + 1] = 'SY2999'
    expect(checkSheet(sheets, PLANT, forms())).toMatchObject({ stop: 2, missing: ['自評表名稱'], unknown: [], unnamed: ['L'] })
  })

  it('3 自評表: names a row with 工號 but no 編號, and a form listed twice', async () => {
    const sheets = await downloaded()
    const twice = [...rowOf(sheets, 'SY-02')]
    const noCode = [null, '採購及付款循環', 'SY2400']
    main(sheets).push(twice, noCode)
    expect(checkSheet(sheets, PLANT, forms())).toEqual({
      stop: 3, rows: [{ row: 7, label: 'SY-02 採購及付款循環', duplicateOf: 5 }, { row: 8, label: '採購及付款循環' }],
    })
  })

  it('3 自評表: leaves a row the file was made with but whose 自評表 is not issued yet for later, and reads the rest', async () => {
    const sheets = await downloaded()
    put(sheets, 'SY-02', '管理單位', '部門主管', 'SY2500')
    put(sheets, 'SY-01', '財會單位', '自行檢查人員', 'SY2501')
    const issued = forms().filter((f) => f.template_code !== 'SY-02')
    const check = checkSheet(sheets, PLANT, issued)
    if (check.stop !== null) throw new Error(`stopped at ${check.stop}`)
    expect(check.notIssued).toEqual([{ row: 5, label: 'SY-02 採購及付款循環' }])
    expect(check.rows).toBe(2)
    expect(check.people).toContain('SY2501')
    expect(check.people).not.toContain('SY2500') // 沒發出的表，這次不比對也不寫
  })

  it('3 自評表: stops rows that are not this plant’s 自評表 of this 年度', async () => {
    const sheets = await downloaded()
    main(sheets).push(['FQ-03.1', '生產循環'], ['SY-23'])
    expect(checkSheet(sheets, PLANT, forms())).toEqual({ stop: 3, rows: [{ row: 7, label: 'FQ-03.1 生產循環' }, { row: 8, label: 'SY-23' }] })
  })

  it('leaves blank cells alone, marks 灰色格 and signed 關卡, and reads 工號 trimmed in upper case', async () => {
    const sheets = await downloaded()
    put(sheets, 'SY-01', '業務單位', '自行檢查人員', 'SY2188') // 已簽
    put(sheets, 'SY-01', '業務單位', '部門主管', null) // 空白＝不動
    put(sheets, 'SY-01', '財會單位', '部門主管', ' sy1366 ')
    rowOf(sheets, 'SY-02')[colOf(sheets, '要素類', '自行檢查人員')] = 'SY2142' // 灰色格
    const check = checkSheet(sheets, PLANT, forms())
    if (check.stop !== null) throw new Error('should pass')
    const kinds = Object.fromEntries(check.cells.map((c) => [`${c.formCode}|${c.column.unit}|${c.column.step}`, `${c.kind} ${c.empId}`]))
    expect(kinds['SY-01|業務單位|自行檢查人員']).toBe('signed SY2188')
    expect(kinds['SY-01|業務單位|部門主管']).toBeUndefined()
    expect(kinds['SY-01|財會單位|部門主管']).toBe('change SY1366')
    expect(kinds['SY-02|要素類|自行檢查人員']).toBe('grey SY2142')
    expect(check.people).not.toContain('SY2142')
  })
})

describe('the forms sent to the plants before this shipped (csa-assignment-v1, built from the template drafts)', () => {
  // FQ's as sent on 2026-11-17: its 系統資料 lists each form's units, which is what the 年度 launched from.
  const sent = () => readWorkbook(new Blob([readFileSync(new URL('../excel/fixtures/FQ_分派表_2026.xlsx', import.meta.url))]))
  const fq = { factoryCode: 'FQ', plantName: '福清富群', year: 2026 }

  /** The 自評表 a launch from those drafts issues: a 分流 per unit, then 廠區經理人; A–D with one unit of their own. */
  async function launched(): Promise<SheetEntry[]> {
    const rows = (await sent()).find((s) => s.sheet === SHEET_NAMES.system)!.data
    const start = rows.findIndex((r) => r[0] === '列')
    return rows.slice(start + 1).filter((r) => r[1]).map((r) => {
      const code = String(r[1])
      const units = String(r[2]).split('、')
      const element = units[0] === '要素類'
      const steps = (element ? ['品保單位'] : units).flatMap((u, i) => branch(i * 2 + 1, u, null, null))
      return form(code, code, [...steps, step(99, '廠區經理人', null, null)], element ? 'element' : 'control_activity')
    })
  }

  it('reads one filled in, 要素類 included, and passes all three checks', async () => {
    const sheets = await sent()
    put(sheets, 'FQ-01.1', '品保單位', '部門主管', 'FQ1008')
    put(sheets, 'FQ-B', '要素類', '自行檢查人員', 'FQ4007')
    put(sheets, 'FQ-B', null, '廠區經理人', 'FQ0001')
    const check = checkSheet(sheets, fq, await launched())
    if (check.stop !== null) throw new Error(`stopped at ${check.stop}: ${JSON.stringify(check)}`)
    expect(check.rows).toBe(15)
    expect(check.cells.map((c) => [c.formCode, c.step?.name, c.empId, c.kind])).toEqual([
      ['FQ-01.1', '部門主管－品保單位', 'FQ1008', 'change'],
      ['FQ-B', '自行檢查人員－品保單位', 'FQ4007', 'change'],
      ['FQ-B', '廠區經理人', 'FQ0001', 'change'],
    ])
  })

  it('leaves a form of the file that was not launched for later instead of stopping', async () => {
    const sheets = await sent()
    put(sheets, 'FQ-15', '待指定單位', '自行檢查人員', 'FQ1500')
    const check = checkSheet(sheets, fq, (await launched()).filter((f) => f.template_code !== 'FQ-15'))
    if (check.stop !== null) throw new Error(`stopped at ${check.stop}`)
    expect(check.notIssued).toEqual([{ row: 14, label: 'FQ-15 取得或處分資產處理辦法' }])
    expect(check.rows).toBe(14)
    expect(check.cells).toEqual([])
  })

  it('stops it as 過期 when a form was launched with other units than it was made for', async () => {
    const changed = await launched()
    changed[0]!.steps.push(...branch(50, '工程單位', null, null))
    expect(checkSheet(await sent(), fq, changed)).toMatchObject({ stop: 2, expired: { codes: ['FQ-01.1'] } })
    expect(system(await sent())[0]).toEqual(['格式版本', 'csa-assignment-v1', null])
  })
})

describe('下次發出: the 簽核流程 (Q147 (6))', () => {
  /** A route's 關卡: no state, nobody signs a route. */
  const routeStep = (position: number, name: string, unit: string | null, signer: string | null, group = 'plant', link: string | null = null): AssignableStep =>
    ({ id: `r${++nextId}`, position, name, step_group: group, link, signer_emp_id: signer, branch_unit_name: unit }) as AssignableStep
  const route = (code: string, name: string, steps: AssignableStep[], layout: AssignmentRoute['template_layout'] = 'control_activity'): SheetEntry =>
    routeSheetEntry({ id: `route-${code}`, template_code: code, template_name: name, template_layout: layout, route_step: steps })
  const routes = () => [
    route('SY-01', '銷售及收款循環', [
      routeStep(1, '自行檢查人員－業務單位', '業務單位', 'SY2100'),
      routeStep(2, '部門主管－業務單位', '業務單位', null),
      routeStep(3, '廠區經理人', null, 'SY0140'),
      routeStep(4, '子公司擔當稽核', null, 'SY5000', 'audit_review'),
      routeStep(5, '稽核主管', null, 'A001', 'audit_review', 'audit_chief'),
    ]),
    route('SY-A', '控制環境', [routeStep(1, '自行檢查人員－管理單位', '管理單位', null), routeStep(2, '部門主管－管理單位', '管理單位', null), routeStep(3, '廠區經理人', null, null)], 'element'),
  ]
  const NEXT = { ...PLANT, next: true }
  const downloadedNext = async (rows = routes()) => readWorkbook(await assignmentWorkbook(assignmentSheet(NEXT, NEXT.year, rows, NOW, true)))

  it('is the same csa-assignment-v1: a row per route with the people on it, the 稽核室 ordinary 關卡 and never the 連動 ones', async () => {
    const sheet = assignmentSheet(NEXT, NEXT.year, routes(), NOW, true)
    expect(sheet.next).toBe(true)
    expect(sheet.layout.columns.map((c) => `${c.unit ?? ''}/${c.step}`)).toEqual([
      '業務單位/自行檢查人員', '業務單位/部門主管', '要素類/自行檢查人員', '要素類/部門主管', '/廠區經理人', '/子公司擔當稽核',
    ])
    expect(sheet.rows).toEqual([
      { code: 'SY-01', name: '銷售及收款循環', cells: ['SY2100', '', null, null, 'SY0140', 'SY5000'] },
      { code: 'SY-A', name: '控制環境', cells: [null, null, '', '', '', null] },
    ])
    const sheets = await downloadedNext()
    expect(main(sheets)[0]![0]).toBe('SY 台北總公司｜2026 年度 指派表（下次發出）　　產生時間 2026-11-17 10:32　　第 1～3 列與 A、B 欄是系統讀取的依據，請勿修改')
    expect(system(sheets).slice(0, 5).map((r) => r.slice(0, 2))).toEqual([
      ['格式版本', 'csa-assignment-v1'], ['廠區代碼', 'SY'], ['年度', '2026'], ['產生時間', '2026-11-17 10:32'], ['來源', 'CSA 指派簽核人頁・下次發出'],
    ])
  })

  it('reads a file back onto the routes: a changed cell is a change (nothing is signed on a route), the same person is left alone', async () => {
    const sheets = await downloadedNext()
    put(sheets, 'SY-01', '業務單位', '自行檢查人員', 'SY2188')
    put(sheets, 'SY-01', '業務單位', '部門主管', 'sy1300')
    put(sheets, 'SY-A', '要素類', '自行檢查人員', 'SY2300')
    const check = checkSheet(sheets, NEXT, routes())
    if (check.stop !== null) throw new Error(`stopped at ${check.stop}`)
    const kinds = check.cells.map((c) => [c.formCode, c.step?.name, c.empId, c.kind])
    expect(kinds).toEqual([
      ['SY-01', '自行檢查人員－業務單位', 'SY2188', 'change'],
      ['SY-01', '部門主管－業務單位', 'SY1300', 'change'],
      ['SY-01', '廠區經理人', 'SY0140', 'same'],
      ['SY-01', '子公司擔當稽核', 'SY5000', 'same'],
      ['SY-A', '自行檢查人員－管理單位', 'SY2300', 'change'],
    ])
    expect(check.cells.find((c) => c.empId === 'SY2188')!.step!.id).toMatch(/^r/)
  })

  it('leaves out a row whose 範本 the next launch does not issue to the plant, and stops another 年度', async () => {
    const sheets = await downloadedNext()
    put(sheets, 'SY-A', '要素類', '自行檢查人員', 'SY2300')
    const check = checkSheet(sheets, NEXT, routes().filter((r) => r.template_code !== 'SY-A'))
    if (check.stop !== null) throw new Error(`stopped at ${check.stop}`)
    expect(check.notIssued).toEqual([{ row: 5, label: 'SY-A 控制環境' }])
    expect(check.people).not.toContain('SY2300')
    expect(checkSheet(sheets, { ...NEXT, year: 2027 }, routes()).stop).toBe(1)
  })

  it('takes the forms sent to the plants before the launch (FQ, 2026) onto the routes', async () => {
    const sent = await readWorkbook(new Blob([readFileSync(new URL('../excel/fixtures/FQ_分派表_2026.xlsx', import.meta.url))]))
    const list = sent.find((s) => s.sheet === SHEET_NAMES.system)!.data
    const start = list.findIndex((r) => r[0] === '列')
    const fqRoutes = list.slice(start + 1).filter((r) => r[1]).map((r) => {
      const code = String(r[1])
      const units = String(r[2]).split('、')
      const element = units[0] === '要素類'
      const steps = (element ? ['品保單位'] : units).flatMap((u, i) => [
        routeStep(i * 2 + 1, `自行檢查人員－${u}`, u, null), routeStep(i * 2 + 2, `部門主管－${u}`, u, null),
      ])
      return route(code, code, [...steps, routeStep(99, '廠區經理人', null, null)], element ? 'element' : 'control_activity')
    })
    put(sent, 'FQ-01.1', '品保單位', '部門主管', 'FQ1008')
    const check = checkSheet(sent, { factoryCode: 'FQ', plantName: '福清富群', year: 2026, next: true }, fqRoutes)
    if (check.stop !== null) throw new Error(`stopped at ${check.stop}`)
    expect(check.cells.map((c) => [c.formCode, c.step?.name, c.kind])).toEqual([['FQ-01.1', '部門主管－品保單位', 'change']])
  })
})

describe('importPlan', () => {
  const cell = (empId: string, kind: SheetCell['kind'] = 'change', id = empId): SheetCell => ({
    formCode: 'SY-01', column: { unit: '業務單位', step: '自行檢查人員' }, empId, kind, step: kind === 'grey' ? null : ({ id: `step-${id}` } as AssignmentStep),
  })
  const oms = (entries: [string, OmsStatus][], noCsa: string[] = []) =>
    new Map(entries.map(([id, status]) => [id, { status, csa: !noCsa.includes(id) }]))

  it('writes 對得上 and 廠區不同, not 不在 OMS, 已離職, 留停 or 轉調, and only cells that change', () => {
    const plan = importPlan(
      [cell('SY2211'), cell('FQ0031'), cell('SY13650'), cell('SY1352'), cell('SY0140', 'same'), cell('SY2188', 'signed'), cell('SY2142', 'grey'), cell('SY2211', 'change', 'b'), cell('SY3001'), cell('SY3002')],
      oms([['SY2211', 'matched'], ['FQ0031', 'other_plant'], ['SY13650', 'not_found'], ['SY1352', 'departed'], ['SY0140', 'matched'], ['SY2188', 'matched'], ['SY3001', 'on_leave'], ['SY3002', 'transferred']]),
      false,
    )
    expect(plan.writes).toEqual([{ step_id: 'step-SY2211', emp_id: 'SY2211' }, { step_id: 'step-FQ0031', emp_id: 'FQ0031' }, { step_id: 'step-b', emp_id: 'SY2211' }])
    expect(plan.counts).toEqual({ matched: 3, not_found: 1, other_plant: 1, departed: 1, on_leave: 1, transferred: 1 })
    expect(plan.people.find((p) => p.empId === 'SY2211')).toEqual({ empId: 'SY2211', status: 'matched', csa: true, cells: 2 })
    expect(plan.noCsa).toBe(0)
    expect(plan.people.map((p) => p.empId)).not.toContain('SY2142') // 灰色格的人不比對
    expect(plan.bulkWarning).toBe(false)
  })

  it('asks for a tick only when more than the share of people are 廠區不同', () => {
    expect(OTHER_PLANT_WARNING_SHARE).toBe(0.5)
    const half = importPlan([cell('FQ1'), cell('FQ2'), cell('SY1'), cell('SY2')], oms([['FQ1', 'other_plant'], ['FQ2', 'other_plant'], ['SY1', 'matched'], ['SY2', 'matched']]), false)
    expect(half.bulkWarning).toBe(false)
    const most = importPlan([cell('FQ1'), cell('FQ2'), cell('SY1')], oms([['FQ1', 'other_plant'], ['FQ2', 'other_plant'], ['SY1', 'matched']]), false)
    expect(most.bulkWarning).toBe(true)
    expect(most.writes).toHaveLength(3) // 勾選後照常寫入
  })

  it('never writes someone not on the 放行名單, whatever OMS says, and counts them apart (Q150)', () => {
    const cells = [cell('SY2211'), cell('FQ0031'), cell('SY0140'), cell('SY1352')]
    const answers = new Map<string, OmsAnswer>([
      ['SY2211', { status: 'matched', csa: true, listed: true }],
      ['FQ0031', { status: 'other_plant', csa: true, listed: false }],
      ['SY0140', { status: 'matched', csa: false, listed: false }],
      ['SY1352', { status: 'departed', csa: false, listed: false }],
    ])
    const plan = importPlan(cells, answers, false)
    expect(plan.writes.map((w) => w.emp_id)).toEqual(['SY2211'])
    expect(plan.notListed).toBe(2) // 已離職 is not counted: it is not written anyway
    expect(plan.noCsa).toBe(1)
    expect([...answers.values()].map(unlisted)).toEqual([false, true, true, false])
  })

  it('only points out people OMS has not enabled for CSA until CSA_REQUIRE_OMS_AUTH is on, then leaves them out (Q133 (4))', () => {
    const cells = [cell('SY2211'), cell('FQ0031'), cell('SY0140'), cell('SY1352')]
    const answers = oms([['SY2211', 'matched'], ['FQ0031', 'other_plant'], ['SY0140', 'matched'], ['SY1352', 'departed']], ['FQ0031', 'SY0140', 'SY1352'])
    const warned = importPlan(cells, answers, false)
    expect(warned.noCsa).toBe(2) // 已離職 is not counted: it is not written anyway
    expect(warned.writes.map((w) => w.emp_id)).toEqual(['SY2211', 'FQ0031', 'SY0140'])
    const required = importPlan(cells, answers, true)
    expect(required).toMatchObject({ noCsa: 2, csaRequired: true })
    expect(required.writes.map((w) => w.emp_id)).toEqual(['SY2211'])
  })
})
