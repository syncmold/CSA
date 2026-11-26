import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { AssignmentForm, AssignmentRoute, AssignmentStep } from '../api/assignment'
import { assignmentSheet, formSheetEntry, routeSheetEntry, SHEET_NAMES } from '../domain/assignmentSheet'
import { assignmentWorkbook, readWorkbook, workbookName } from './assignmentWorkbook'

// 分派表的 .xlsx (#180, Q130 (2)). Made-up 工號.

const step = (id: string, position: number, name: string, unit: string | null, signer: string | null) =>
  ({ id, position, name, step_group: 'plant', signer_emp_id: signer, branch_unit_name: unit, state: 'pending' }) as AssignmentStep
const FORMS: AssignmentForm[] = [
  {
    id: 'f1', template_code: 'SY-01', template_name: '銷售及收款循環', template_layout: 'control_activity', status: 'in_progress', annual_cycle: { year: 2026, due_date: '2026-12-31' },
    assessment_step: [step('a', 1, '自行檢查人員－業務單位', '業務單位', '00123'), step('b', 2, '部門主管－業務單位', '業務單位', null), step('c', 3, '廠區經理人', null, 'SY0140')],
  },
  {
    id: 'f2', template_code: 'SY-02', template_name: '採購及付款循環', template_layout: 'control_activity', status: 'in_progress', annual_cycle: { year: 2026, due_date: '2026-12-31' },
    assessment_step: [step('d', 1, '自行檢查人員－採購單位', '採購單位', 'SY2101'), step('e', 2, '廠區經理人', null, null)],
  },
]
const SHEET = assignmentSheet({ factoryCode: 'SY', plantName: '台北總公司' }, 2026, FORMS.map(formSheetEntry), new Date(2026, 10, 17, 10, 32))
/** The same plant's 簽核流程 on 下次發出 (Q147 (6)): a route's 關卡 have no state. */
const ROUTES: AssignmentRoute[] = FORMS.map((f) => ({
  id: `route-${f.id}`, template_code: f.template_code, template_name: f.template_name, template_layout: f.template_layout,
  route_step: f.assessment_step.map(({ state: _, ...s }) => s),
}))
const NEXT = assignmentSheet({ factoryCode: 'SY', plantName: '台北總公司' }, 2026, ROUTES.map(routeSheetEntry), new Date(2026, 10, 17, 10, 32), true)

async function unzipped() {
  const files = unzipSync(new Uint8Array(await (await assignmentWorkbook(SHEET)).arrayBuffer()))
  return (path: string) => strFromU8(files[path]!)
}

describe('assignmentWorkbook', () => {
  it('writes 分派表, 填寫說明 and 系統資料: row 1 names the plant, 年度 and time; cells hold the 工號 as text', async () => {
    const sheets = await readWorkbook(await assignmentWorkbook(SHEET))
    expect(sheets.map((s) => s.sheet)).toEqual([SHEET_NAMES.main, SHEET_NAMES.guide, SHEET_NAMES.system])
    const [main, , system] = sheets.map((s) => s.data)
    expect(main![0]![0]).toBe('SY 台北總公司｜2026 年度 指派表　　產生時間 2026-11-17 10:32　　第 1～3 列與 A、B 欄是系統讀取的依據，請勿修改')
    // csa-assignment-v1: A 編號 and B 名稱 span rows 2-3; row 2 the units (merged over their 關卡), row 3 the 關卡;
    // 廠區經理人 spans both rows.
    expect(main![1]).toEqual(['自評表編號', '自評表名稱', '業務單位', null, '採購單位', '廠區經理人'])
    expect(main![2]).toEqual([null, null, '自行檢查人員', '部門主管', '自行檢查人員', null])
    expect(main![3]).toEqual(['SY-01', '銷售及收款循環', '00123', null, '—', 'SY0140'])
    expect(main![4]).toEqual(['SY-02', '採購及付款循環', '—', '—', 'SY2101', null])
    expect(system!.map((row) => row.slice(0, 3))).toEqual([
      ['格式版本', 'csa-assignment-v1', null], ['廠區代碼', 'SY', null], ['年度', '2026', null], ['產生時間', '2026-11-17 10:32', null],
      ['來源', 'CSA 指派簽核人頁', null], [null, null, null],
      ['欄', '自評單位', '關卡'], ['C', '業務單位', '自行檢查人員'], ['D', '業務單位', '部門主管'], ['E', '採購單位', '自行檢查人員'], ['F', '廠區經理人', '廠區經理人'],
      [null, null, null],
      ['列', '自評表編號', '自評單位（、分隔）'], [4, 'SY-01', '業務單位'], [5, 'SY-02', '採購單位'],
    ])
    expect(workbookName(SHEET)).toBe('SY_指派表_2026.xlsx')
  })

  it('says 下次發出 after the title and in 填寫說明 for the routes, with the same cells and 系統資料 columns', async () => {
    const [issued, next] = await Promise.all([readWorkbook(await assignmentWorkbook(SHEET)), readWorkbook(await assignmentWorkbook(NEXT))])
    const [main, guide, system] = next.map((s) => s.data)
    expect(String(main![0]![0])).toMatch(/^SY 台北總公司｜2026 年度 指派表（下次發出）　　產生時間 2026-11-17 10:32/)
    expect(main!.slice(1)).toEqual(issued[0]!.data.slice(1))
    expect(guide![0]![0]).toBe('SY 台北總公司｜2026 年度 指派表（下次發出）：填寫說明')
    expect(guide!.map((r) => r[0]).join('\n')).toContain('8. 填好後由廠區管理員或稽核主管在 CSA「指派簽核人」頁的「下次發出」匯入。')
    expect(issued[1]!.data.map((r) => r[0]).join('\n')).toContain('8. 自評表已發出，只有稽核主管能換人')
    expect(system!.find((r) => r[0] === '來源')![1]).toBe('CSA 指派簽核人頁・下次發出')
    expect(system!.slice(6)).toEqual(issued[2]!.data.slice(6))
    expect(workbookName(NEXT)).toBe('SY_指派表_2026.xlsx')
  })

  it('hides 系統資料 (veryHidden) and protects the sheets, leaving only the 工號 cells unlocked', async () => {
    const read = await unzipped()
    expect(read('xl/workbook.xml')).toMatch(/<sheet [^>]*name="系統資料"[^>]*state="veryHidden"/)
    expect(read('xl/workbook.xml')).not.toMatch(/name="指派表"[^>]*state="hidden"/)
    const sheet = read('xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<sheetProtection sheet="1"')

    // Which cell styles are unlocked (and in text format), and which cells use them.
    const styles = read('xl/styles.xml')
    const textFormat = /<numFmt numFmtId="(\d+)" formatCode="@"\/>/.exec(styles)![1]
    const xfs = [...styles.match(/<cellXfs[^>]*>(.*)<\/cellXfs>/)![1]!.matchAll(/<xf [^>]*>.*?<\/xf>/g)].map((m) => m[0])
    const unlocked = new Set(xfs.flatMap((xf, i) => (xf.includes('<protection locked="0"/>') ? [String(i)] : [])))
    for (const i of unlocked) expect(xfs[Number(i)]).toContain(`numFmtId="${textFormat}"`)
    const cells = [...sheet.matchAll(/<c r="([A-Z]+)(\d+)"(?: s="(\d+)")?/g)].map(([, col, row, s]) => ({ ref: `${col}${row}`, row: Number(row), open: unlocked.has(s ?? '0') }))
    // The 工號 cells, filled or not: C4 D4 F4 (E4 is grey), E5 F5 (C5 D5 grey).
    expect(cells.filter((c) => c.open).map((c) => c.ref).sort()).toEqual(['C4', 'D4', 'E5', 'F4', 'F5'])
    expect(cells.filter((c) => c.row <= 3 || /^[AB]\d/.test(c.ref)).every((c) => !c.open)).toBe(true)
  })

  it('boxes every cell of the header and the rows, the ones under a merged header too', async () => {
    const read = await unzipped()
    const styles = read('xl/styles.xml')
    const borders = [...styles.match(/<borders[^>]*>(.*)<\/borders>/)![1]!.matchAll(/<border>.*?<\/border>/g)].map((m) => m[0])
    const xfs = [...styles.match(/<cellXfs[^>]*>(.*)<\/cellXfs>/)![1]!.matchAll(/<xf [^>]*>/g)].map((m) => m[0])
    const boxed = (s: string) => {
      const border = borders[Number(/borderId="(\d+)"/.exec(xfs[Number(s)]!)?.[1] ?? 0)]!
      return ['left', 'right', 'top', 'bottom'].every((side) => border.includes(`<${side} style="thin">`))
    }
    const sheet = read('xl/worksheets/sheet1.xml')
    const cells = [...sheet.matchAll(/<c r="([A-Z]+)(\d+)"(?: s="(\d+)")?/g)].map(([, col, row, s]) => ({ ref: `${col}${row}`, row: Number(row), s: s ?? '0' }))
    // Rows 2-3 (the header, A3, B3 and F3 under merges) and the rows of 工號, A to F.
    const below = cells.filter((c) => c.row >= 2)
    expect(below.map((c) => c.ref)).toEqual(expect.arrayContaining(['A3', 'B3', 'D2', 'F3']))
    expect(below.filter((c) => !boxed(c.s)).map((c) => c.ref)).toEqual([])
  })

  it('widens a column so its 關卡, and its 自評單位 over all its columns, show on one line', async () => {
    const form: AssignmentForm = {
      ...FORMS[0]!,
      assessment_step: [
        step('a', 1, '自行檢查人員－業務單位', '業務單位', null), step('b', 2, '部門主管－業務單位', '業務單位', null),
        step('c', 3, '自行檢查人員－中央消防暨工業安全處', '中央消防暨工業安全處', null),
        step('d', 4, '廠區經理人', null, null), step('e', 5, '子公司擔當稽核', null, null),
      ],
    }
    const sheet = assignmentSheet({ factoryCode: 'SY', plantName: '台北總公司' }, 2026, [formSheetEntry(form)], new Date(2026, 10, 25))
    const files = unzipSync(new Uint8Array(await (await assignmentWorkbook(sheet)).arrayBuffer()))
    const cols = strFromU8(files['xl/worksheets/sheet1.xml']!).match(/<cols>(.*)<\/cols>/)![1]!
    const widths = [...cols.matchAll(/<col min="(\d+)"[^>]*width="(\d+)"/g)].map(([, , w]) => Number(w)).slice(2)
    // 自行檢查人員 15 (6 CJK characters), 部門主管 keeps 13; 中央消防暨工業安全處 (10) is wider than its one column's
    // 15, so that column takes 23; 廠區經理人 keeps 13; 子公司擔當稽核 (7) 17.
    expect(widths).toEqual([15, 13, 23, 13, 17])
  })
})
