// 分派表 (#180, Q130; Q147 (6)): one plant's 簽核流程 (下次發出) or its 自評表 of one 年度 as a sheet of 工號 to download,
// and the four checks an uploaded one goes through before anything is written. Pure: the .xlsx itself is
// src/excel/assignmentWorkbook.ts, the OMS answer comes from the CSA backend (exchange/omsMatch.ts), and who may write
// what is still assign_route_signer's (下次發出) and assign_step_signer's (an issued 年度).
//
// The layout is csa-assignment-v1, the same as the 分派表 the 稽核人員 sent the plants before this shipped (built from
// the template drafts, 2026-11-17), so those come back in through the same import: A 自評表編號, B 自評表名稱, then
// two columns per 自評單位 (自行檢查人員, 部門主管), 廠區經理人 last; A–D (要素類) answer as one 「要素類」 unit.
//
// The rules on what is written (Q130 (4)) live here and not in the database, unlike ADR-0001's usual split: they rest on
// OMS's answer, which only the CSA backend can ask for. That includes CSA_REQUIRE_OMS_AUTH, which the backend reports and
// this file applies: like the rest of Q130 (4) it decides what the import offers to write, not what assign_step_signer
// accepts (a 廠區管理員 can still pick anyone one cell at a time). What the database decides is who may write which 關卡.
import dayjs from 'dayjs'
import type { OmsMatchAnswer, OmsMatchStatus } from '../../exchange/omsMatch'
import type { AssignableStep, AssignmentForm, AssignmentRoute } from '../api/assignment'
import { nameInBranch } from './signoff'

/**
 * Q130 (4) 暫定門檻: when more than this share of the people in a file are 廠區不同, the whole file is probably another
 * plant's list, and importing needs a tick first. The one place to change it.
 */
export const OTHER_PLANT_WARNING_SHARE = 0.5

/** What OMS says about one 工號 for the plant the file is for. */
export type OmsStatus = OmsMatchStatus
/** The status, and whether OMS lets them use CSA (勾了 CSA, with an active account). */
export type OmsAnswer = OmsMatchAnswer

/** Every status OMS's answer can have (the preview chooses its own order). */
export const OMS_STATUSES: readonly OmsStatus[] = ['matched', 'other_plant', 'not_found', 'departed', 'on_leave', 'transferred']
/** Q130 (4): the statuses whose cells are written; the others (不在 OMS, 已離職, 留停, 轉調) are not. */
const WRITTEN: ReadonlySet<OmsStatus> = new Set(['matched', 'other_plant'])

/** The format the 系統資料 sheet names; a file without it is not one of ours. */
export const FORMAT_VERSION = 'csa-assignment-v1'
/** A–D have no 自評單位 on paper: whichever unit a 要素類 form's 分流 has, the sheet calls it this. */
export const ELEMENT_GROUP = '要素類'
export const CODE_HEADER = '自評表編號'
export const NAME_HEADER = '自評表名稱'

/** A column of the sheet: a 關卡 of a 分流 (unit) or, with no unit, one after the 匯流 (廠區經理人). */
export interface SheetColumn {
  unit: string | null
  step: string
}

/** Which columns there are and which units each 自評表 has; written to the hidden 系統資料 sheet as generated. */
export interface SheetLayout {
  columns: SheetColumn[]
  forms: { code: string; units: string[] }[]
}

export const columnKey = (column: SheetColumn) => JSON.stringify([column.unit, column.step])
export const columnLabel = (column: SheetColumn) => (column.unit ? `${column.unit}／${column.step}` : column.step)

/**
 * What a row of the sheet is made from: a 簽核流程 on 下次發出 (Q147: 分派 before the launch, written to the route) or an
 * issued 自評表 (a 年度). `closed`: a 自評表 that has closed, none of whose 關卡 change hands; never a route.
 */
export interface SheetEntry {
  template_code: string
  template_name: string
  template_layout: 'element' | 'control_activity'
  steps: AssignableStep[]
  closed: boolean
}

export const formSheetEntry = (form: AssignmentForm): SheetEntry => ({
  template_code: form.template_code,
  template_name: form.template_name,
  template_layout: form.template_layout,
  steps: form.assessment_step,
  closed: form.status === 'closed',
})

export const routeSheetEntry = (route: AssignmentRoute): SheetEntry => ({
  template_code: route.template_code,
  template_name: route.template_name,
  template_layout: route.template_layout,
  steps: route.route_step,
  closed: false,
})

const isElement = (entry: Pick<SheetEntry, 'template_layout'>) => entry.template_layout === 'element'

/**
 * The 關卡 a 廠區 assigns, in order: each 分流's, then the ones after the 匯流, including the 稽核室's ordinary ones such
 * as 子公司擔當稽核 (Q143); never the 連動 台北稽核人員／稽核主管.
 */
const plantSteps = (entry: Pick<SheetEntry, 'steps'>) =>
  entry.steps.filter((s) => s.step_group === 'plant' || !s.link).sort((a, b) => a.position - b.position)

function stepColumn(entry: SheetEntry, step: AssignableStep): SheetColumn {
  const unit = step.branch_unit_name === null ? null : isElement(entry) ? ELEMENT_GROUP : step.branch_unit_name
  return { unit, step: nameInBranch(step) }
}

/** An entry's 關卡 by column key; the first one wins should two share a name. */
function stepsByColumn(entry: SheetEntry): Map<string, AssignableStep> {
  const steps = new Map<string, AssignableStep>()
  for (const step of plantSteps(entry)) {
    const key = columnKey(stepColumn(entry, step))
    if (!steps.has(key)) steps.set(key, step)
  }
  return steps
}

/** The units an entry has, as the sheet names them. */
const unitsOf = (entry: SheetEntry) => [...new Set(plantSteps(entry).flatMap((s) => stepColumn(entry, s).unit ?? []))]

/** 控制活動類 first, 要素類 (A–D) last, each by 編號: the order of the rows. */
export function sheetOrder<F extends Pick<SheetEntry, 'template_code' | 'template_layout'>>(forms: readonly F[]): F[] {
  return [...forms].sort((a, b) => Number(isElement(a)) - Number(isElement(b)) || a.template_code.localeCompare(b.template_code))
}

/** Units in the order they first appear down the rows (要素類 last), each unit's 關卡 together; the 匯流 ones last. */
export function sheetLayout(forms: readonly SheetEntry[]): SheetLayout {
  const units = new Map<string, string[]>()
  const merged: string[] = []
  const ordered = sheetOrder(forms)
  for (const form of ordered) {
    for (const step of plantSteps(form)) {
      const { unit, step: name } = stepColumn(form, step)
      const list = unit === null ? merged : (units.get(unit) ?? units.set(unit, []).get(unit)!)
      if (!list.includes(name)) list.push(name)
    }
  }
  const unitOrder = [...units.keys()].sort((a, b) => Number(a === ELEMENT_GROUP) - Number(b === ELEMENT_GROUP))
  const columns: SheetColumn[] = [
    ...unitOrder.flatMap((unit) => units.get(unit)!.map((step) => ({ unit, step }))),
    ...merged.map((step) => ({ unit: null, step })),
  ]
  return { columns, forms: ordered.map((f) => ({ code: f.template_code, units: unitsOf(f) })) }
}

/**
 * The sheet to download: a row per 簽核流程 or 自評表, its current 簽核人 in each cell; null where it has no such 關卡
 * (灰色格). `next`: the routes of 下次發出, `year` then being the 年度 the next launch is expected to be (Q147).
 */
export interface AssignmentSheet {
  factoryCode: string
  plantName: string
  year: number
  next: boolean
  /** Local time, `2026-11-17 10:38`, as in row 1 and the 系統資料. */
  generatedAt: string
  layout: SheetLayout
  rows: { code: string; name: string; cells: (string | null)[] }[]
}

export const localTime = (d: Date) => dayjs(d).format('YYYY-MM-DD HH:mm')

export function assignmentSheet(
  plant: { factoryCode: string; plantName: string },
  year: number,
  forms: readonly SheetEntry[],
  now: Date,
  next = false,
): AssignmentSheet {
  const layout = sheetLayout(forms)
  const rows = sheetOrder(forms).map((form) => {
    const steps = stepsByColumn(form)
    const cells = layout.columns.map((column) => {
      const step = steps.get(columnKey(column))
      return step ? (step.signer_emp_id ?? '') : null
    })
    return { code: form.template_code, name: form.template_name, cells }
  })
  return { ...plant, year, next, generatedAt: localTime(now), layout, rows }
}

// 讀回來的檔案 ---------------------------------------------------------------------------------------------------

export type RawCell = string | number | boolean | Date | null | undefined
export interface RawSheet {
  sheet: string
  data: RawCell[][]
}

/** The sheets of the workbook. Fixed 繁中 like the PDF: the file goes to the plants, whatever language the page is in. */
export const SHEET_NAMES = { main: '分派表', guide: '填寫說明', system: '系統資料' } as const
/** What a 灰色格 shows; read back as empty. */
export const NOT_HERE = '—'
/** Rows above the 自評表: the title (row 1), the units (row 2), the 關卡 (row 3). */
export const HEADER_ROWS = 3

/** Row 1: `SY 台北總公司｜2026 年度 分派表`, then the time it was made. */
export const sheetTitle = (sheet: Pick<AssignmentSheet, 'factoryCode' | 'plantName' | 'year'>) =>
  `${sheet.factoryCode} ${sheet.plantName}｜${sheet.year} 年度 分派表`

export function parseTitle(text: string): { factoryCode: string; year: number } | null {
  const match = /^(\S+) .*｜(\d{4}) 年度/.exec(text)
  return match ? { factoryCode: match[1]!, year: Number(match[2]) } : null
}

const columnLetter = (index: number): string => (index < 26 ? '' : columnLetter(Math.floor(index / 26) - 1)) + String.fromCharCode(65 + (index % 26))

/** 系統資料: key/value rows, then 欄｜自評單位｜關卡 (a 匯流 column names itself twice), then 列｜自評表編號｜自評單位. */
export function systemRows(sheet: AssignmentSheet): (string | number | null)[][] {
  return [
    ['格式版本', FORMAT_VERSION],
    ['廠區代碼', sheet.factoryCode],
    ['年度', String(sheet.year)],
    ['產生時間', sheet.generatedAt],
    ['來源', sheet.next ? 'CSA 分派填寫人頁・下次發出' : 'CSA 分派填寫人頁'],
    [null],
    ['欄', '自評單位', '關卡'],
    ...sheet.layout.columns.map((c, i) => [columnLetter(i + 2), c.unit ?? c.step, c.step]),
    [null],
    ['列', CODE_HEADER, '自評單位（、分隔）'],
    ...sheet.layout.forms.map((f, i) => [i + HEADER_ROWS + 1, f.code, f.units.join('、')]),
  ]
}

interface SystemData {
  factoryCode: string
  year: number
  generatedAt: string
  layout: SheetLayout
}

function readSystem(sheet: RawSheet | undefined): SystemData | null {
  if (!sheet) return null
  const rows = sheet.data
  const value = (key: string) => text(rows.find((row) => text(row[0]) === key)?.[1])
  if (value('格式版本') !== FORMAT_VERSION) return null
  /** The rows under a table's heading row, up to the first one with nothing in column B. */
  const table = (heading: string) => {
    const start = rows.findIndex((row) => text(row[0]) === heading)
    if (start < 0) return []
    const end = rows.findIndex((row, i) => i > start && !text(row[1]))
    return rows.slice(start + 1, end < 0 ? undefined : end)
  }
  const columns = table('欄').map((row): SheetColumn => {
    const [unit, step] = [text(row[1]), text(row[2])]
    return { unit: unit === step ? null : unit, step }
  })
  const forms = table('列').map((row) => ({ code: text(row[1]), units: text(row[2]).split('、').filter(Boolean) }))
  return { factoryCode: value('廠區代碼'), year: Number(value('年度')), generatedAt: value('產生時間'), layout: { columns, forms } }
}

const text = (cell: RawCell) => (cell === null || cell === undefined ? '' : String(cell).trim())

/** A 工號 as typed: trimmed and upper case, as OMS keeps them; '' for an empty cell or a 灰色格's 「—」. */
export const empIdOf = (cell: RawCell) => {
  const value = text(cell)
  return value === NOT_HERE ? '' : value.toUpperCase()
}

/**
 * The columns the header rows name, by index: row 2 holds a unit over its 關卡 (merged, so only its first cell has it)
 * and row 3 the 關卡; a column after the 匯流 has its name in row 2 and nothing under it. The 自評表編號 and 名稱 columns
 * and columns with no header are left out.
 */
function headerColumns(data: RawCell[][], skip: ReadonlySet<number>): { columns: Map<number, SheetColumn>; unnamed: number[] } {
  const [units = [], steps = []] = [data[1], data[2]]
  const width = Math.max(...data.map((row) => row.length))
  const columns = new Map<number, SheetColumn>()
  const unnamed: number[] = []
  let unit: string | null = null
  for (let i = 0; i < width; i++) {
    if (skip.has(i)) continue
    const [top, below] = [text(units[i]), text(steps[i])]
    if (top) unit = below ? top : null
    if (below) columns.set(i, { unit, step: below })
    else if (top) columns.set(i, { unit: null, step: top })
    // Something typed below a column with no heading would otherwise vanish without a word.
    else if (data.slice(HEADER_ROWS).some((row) => empIdOf(row[i]))) unnamed.push(i)
  }
  return { columns, unnamed }
}

// 四項檢查 -------------------------------------------------------------------------------------------------------

/**
 * The plant and 年度 the page imports to. `next`: 下次發出 (Q147), the 簽核流程, `year` being the 年度 the next launch is
 * expected to be: a file made for that 年度 (as the ones sent to the plants before a launch) imports to the routes.
 */
export interface PagePlant {
  factoryCode: string
  plantName: string
  year: number
  next?: boolean
}

/** What a stop at 第 1 項 says about the file: what its row 1 and its 系統資料 claim. */
export interface FileClaim {
  title: { factoryCode: string; year: number } | null
  system: { factoryCode: string; year: number } | null
}

export type SheetCheck =
  | { stop: 1; claim: FileClaim }
  | { stop: 2; missing: string[]; unknown: string[]; unnamed: string[]; expired: { generatedAt: string; codes: string[] } | null }
  | { stop: 3; rows: StrangeRow[] }
  | { stop: null; rows: number; notIssued: { row: number; label: string }[]; cells: SheetCell[]; people: string[] }

/**
 * A non-empty cell of a form the page has: `grey` where the form has no such 關卡, `signed` where its 關卡 is done (or
 * the form closed) and the 工號 is someone else, `same` when the 工號 is already the 簽核人, else `change`.
 */
export interface SheetCell {
  formCode: string
  column: SheetColumn
  empId: string
  step: AssignableStep | null
  kind: 'grey' | 'signed' | 'same' | 'change'
}

/** A row check 3 stops at: its label (編號 and 名稱, '' with neither), and the row it repeats when it does. */
export interface StrangeRow {
  row: number
  label: string
  duplicateOf?: number
}

const sameUnits = (a: readonly string[], b: readonly string[]) => [...a].sort().join('\n') === [...b].sort().join('\n')

/**
 * 第 1～3 項 (Q130 (3)), each only once the one before passed: whose file it is, whether its columns are still the ones
 * generated, whether every row is one of the page's 簽核流程 or 自評表. When all pass, the cells to weigh and the people
 * to ask OMS about (每人只查一次), from every non-empty cell that is not a 灰色格, and the rows left out (`notIssued`): on
 * an issued 年度 the 自評表 not issued yet; on 下次發出 the 範本 the next launch does not issue to this plant (停用, or no
 * longer for it), which have no route here to write to.
 */
export function checkSheet(sheets: readonly RawSheet[], page: PagePlant, forms: readonly SheetEntry[]): SheetCheck {
  const main = sheets.find((s) => s.sheet === SHEET_NAMES.main)
  const system = readSystem(sheets.find((s) => s.sheet === SHEET_NAMES.system))
  const title = parseTitle(text(main?.data[0]?.[0]))

  // 1 檔案是哪一廠: row 1 and 系統資料 both name the page's plant and 年度; never the file name.
  const same = (claim: { factoryCode: string; year: number } | null) => claim?.factoryCode === page.factoryCode && claim.year === page.year
  if (!main || !system || !same(title) || !same(system)) {
    return { stop: 1, claim: { title, system: system && { factoryCode: system.factoryCode, year: system.year } } }
  }

  // 2 格式: columns found by their header text, so their order does not matter.
  const headings = main.data[1] ?? []
  const codeAt = headings.findIndex((c) => text(c) === CODE_HEADER)
  const nameAt = headings.findIndex((c) => text(c) === NAME_HEADER)
  const { columns: header, unnamed } = headerColumns(main.data, new Set([codeAt, nameAt]))
  const expected = new Map(system.layout.columns.map((c) => [columnKey(c), c]))
  const seen = new Set<string>()
  const unknown: string[] = []
  for (const column of header.values()) {
    const key = columnKey(column)
    if (!expected.has(key) || seen.has(key)) unknown.push(columnLabel(column))
    seen.add(key)
  }
  const missing = [
    ...[CODE_HEADER, NAME_HEADER].filter((_, i) => [codeAt, nameAt][i]! < 0),
    ...[...expected].filter(([key]) => !seen.has(key)).map(([, c]) => columnLabel(c)),
  ]
  // 過期: a 自評表 whose 自評單位 are not the ones the file was made for. The units, not the time: the forms the
  // plants filled before this shipped were all made before the 年度 was launched.
  const now = new Map(sheetLayout(forms).forms.map((f) => [f.code, f.units]))
  const changed = system.layout.forms.filter((f) => now.has(f.code) && !sameUnits(now.get(f.code)!, f.units)).map((f) => f.code)
  const expired = changed.length ? { generatedAt: system.generatedAt, codes: changed } : null
  const unnamedColumns = unnamed.map(columnLetter)
  if (missing.length || unknown.length || unnamedColumns.length || expired) {
    return { stop: 2, missing, unknown, unnamed: unnamedColumns, expired }
  }

  // 3 自評表: every row is one of this plant's 自評表 of this 年度 (the page only has those), once. A row with 工號 but
  // no 編號 is named too rather than dropped. A row the file was made with whose 自評表 has not been issued yet (the
  // forms sent before the 年度 was launched list every template of the plant) is left for later, not a stop (Q130
  // 修訂 2026-11-17): once it is issued, importing the same file again writes it.
  const byCode = new Map(forms.map((f) => [f.template_code, f]))
  const madeWith = new Set(system.layout.forms.map((f) => f.code))
  const notIssued: { row: number; label: string }[] = []
  const rows = main.data
    .slice(HEADER_ROWS)
    .map((cells, i) => ({ row: i + HEADER_ROWS + 1, code: text(cells[codeAt]), label: [text(cells[codeAt]), text(cells[nameAt])].filter(Boolean).join(' '), cells }))
    .filter((r) => r.code || [...header.keys()].some((i) => empIdOf(r.cells[i])))
  const first = new Map<string, number>()
  const strangers = rows.flatMap(({ row, code, label }): StrangeRow[] => {
    if (!code) return [{ row, label }]
    if (first.has(code)) return [{ row, label, duplicateOf: first.get(code)! }]
    first.set(code, row)
    if (!byCode.has(code)) {
      if (!madeWith.has(code)) return [{ row, label }]
      notIssued.push({ row, label })
    }
    return []
  })
  if (strangers.length) return { stop: 3, rows: strangers }
  const issued = rows.filter((r) => byCode.has(r.code))

  const cells: SheetCell[] = []
  for (const { code, cells: values } of issued) {
    const form = byCode.get(code)!
    const steps = stepsByColumn(form)
    for (const [i, column] of header) {
      const empId = empIdOf(values[i])
      if (!empId) continue // 空白格：不動
      const step = steps.get(columnKey(column)) ?? null
      cells.push({ formCode: form.template_code, column, empId, step, kind: cellKind(form, step, empId) })
    }
  }
  const people = [...new Set(cells.filter((c) => c.kind !== 'grey').map((c) => c.empId))]
  return { stop: null, rows: issued.length, notIssued, cells, people }
}

function cellKind(entry: SheetEntry, step: AssignableStep | null, empId: string): SheetCell['kind'] {
  if (!step) return 'grey'
  if ((step.signer_emp_id ?? '').toUpperCase() === empId) return 'same'
  // A route's 關卡 have no state: nobody signs a route.
  return step.state === 'done' || entry.closed ? 'signed' : 'change'
}

// 第 4 項之後 ----------------------------------------------------------------------------------------------------

export interface ImportPlan {
  /** Each 工號 once, with what OMS said and how many cells use it; in the order the file first uses them. */
  people: ({ empId: string; cells: number } & OmsAnswer)[]
  counts: Record<OmsStatus, number>
  /** People whose status would be written but whom OMS has not let use CSA yet (沒勾 CSA, or no active account). */
  noCsa: number
  /** CSA_REQUIRE_OMS_AUTH on: those people are not written. Off (until OMS has ticked everyone): only pointed out. */
  csaRequired: boolean
  /** More than OTHER_PLANT_WARNING_SHARE of the people are 廠區不同: ask for a tick before importing. */
  bulkWarning: boolean
  /** What 確認匯入 writes: changed cells whose person may be written (see writable). */
  writes: { step_id: string; emp_id: string }[]
}

const UNKNOWN: OmsAnswer = { status: 'not_found', csa: false }

/** Whether this answer's cells are written: 對得上 or 廠區不同, and allowed into CSA unless that is not required yet. */
export const writable = (answer: OmsAnswer, csaRequired: boolean) => WRITTEN.has(answer.status) && (answer.csa || !csaRequired)

/** Whether OMS has not let this person use CSA, among those who would otherwise be written. */
export const lacksCsa = (answer: OmsAnswer) => WRITTEN.has(answer.status) && !answer.csa

/**
 * Q130 (4): 不在 OMS, 已離職, 留停 and 轉調 are not written; 廠區不同 is only pointed out, unless it is most of the file;
 * 沒勾 CSA is pointed out, and not written once CSA_REQUIRE_OMS_AUTH is on (Q133 (4)).
 */
export function importPlan(cells: readonly SheetCell[], oms: ReadonlyMap<string, OmsAnswer>, csaRequired: boolean): ImportPlan {
  const used = new Map<string, number>()
  for (const cell of cells) if (cell.kind !== 'grey') used.set(cell.empId, (used.get(cell.empId) ?? 0) + 1)
  const people = [...used].map(([empId, count]) => ({ empId, cells: count, ...(oms.get(empId) ?? UNKNOWN) }))
  const counts = Object.fromEntries(OMS_STATUSES.map((s) => [s, 0])) as Record<OmsStatus, number>
  for (const p of people) counts[p.status]++
  const noCsa = people.filter(lacksCsa).length
  const writes = cells
    .filter((c) => c.kind === 'change' && writable(oms.get(c.empId) ?? UNKNOWN, csaRequired))
    .map((c) => ({ step_id: c.step!.id, emp_id: c.empId }))
  const bulkWarning = people.length > 0 && counts.other_plant / people.length > OTHER_PLANT_WARNING_SHARE
  return { people, counts, noCsa, csaRequired, bulkWarning, writes }
}
