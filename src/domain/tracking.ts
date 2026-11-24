// 呈現用純函式 for 追蹤總覽 (#14, Q95, Q105). Where each 自評表 stands, who signs it now and how long it has stayed
// there come from the database (view tracking_assessment); these filter those rows, lay them out as the
// 廠區 × 問卷範本 matrix and word each cell — once, so the screen and the Excel export cannot drift apart.
import type { TFunction } from 'i18next'
import type { TemplateComponent } from '../api/templates'
import type { TrackingRow, TrackingTemplate } from '../api/trackingQuery'
import { formatSigner, stepLabel } from './signoff'
import { COMPONENTS, componentKey } from './templates'

export type StatusFilter = 'all' | 'in_progress' | 'closed'

export interface TrackingFilter {
  /** null＝全部公司 */
  companyId: string | null
  /** empty＝全部廠區 */
  plantIds: string[]
  status: StatusFilter
}

export const NO_FILTER: TrackingFilter = { companyId: null, plantIds: [], status: 'all' }

export function filterTracking(rows: TrackingRow[], filter: TrackingFilter): TrackingRow[] {
  return rows.filter(
    (r) =>
      (filter.companyId === null || r.company_id === filter.companyId) &&
      (filter.plantIds.length === 0 || filter.plantIds.includes(r.plant_id)) &&
      (filter.status === 'all' || r.status === filter.status),
  )
}

/** Only the rows of these plants (every row for 'all'): what 匯出 Excel is built from (access exportablePlants). */
export function onlyPlants(data: TrackingData, plantIds: 'all' | string[]): TrackingData {
  return plantIds === 'all' ? data : { ...data, rows: data.rows.filter((r) => plantIds.includes(r.plant_id)) }
}

export interface CompanyOption {
  id: string
  name: string
  /** The 廠區 of this 公司 among the rows, in the database's order (a 公司 can have more than one). */
  plants: PlantOption[]
}

export interface PlantOption {
  id: string
  factory_code: string
  name: string
}

/** Where a row is: what the 公司 and 廠區 filters offer (追蹤總覽, and 自評表紀錄's rows have the same columns). */
type RowPlace = Pick<TrackingRow, 'company_id' | 'company_name' | 'plant_id' | 'factory_code' | 'plant_name'>

/** Each 公司 once, in the database's order. */
export function companyOptions(rows: RowPlace[]): CompanyOption[] {
  return uniqueBy(rows, (r) => r.company_id).map((r) => ({
    id: r.company_id,
    name: r.company_name,
    plants: plantOptions(rows, r.company_id),
  }))
}

/**
 * A 公司 filter option, worded like the 廠區 options (「FQ 福清富群」) so one 公司 reads the same on every page, not by its
 * full legal name; a 公司 with several 廠區 lists them all (「TC 敬得(太倉)・GT 敬得(觀音)」).
 */
export const companyOptionLabel = (c: CompanyOption) => c.plants.map(plantOptionLabel).join('・')

/** 「代碼 名稱」, a 廠區 filter option. */
export const plantOptionLabel = (p: PlantOption) => `${p.factory_code} ${p.name}`

/** The 廠區 of the chosen 公司 (all of them for null), in the database's order. */
export function plantOptions(rows: RowPlace[], companyId: string | null): PlantOption[] {
  return uniqueBy(rows.filter((r) => companyId === null || r.company_id === companyId), (r) => r.plant_id).map((r) => ({
    id: r.plant_id, factory_code: r.factory_code, name: r.plant_name,
  }))
}

/** One 年度's 自評表 and the 範本 they sit among, as the page fetches them (api/tracking). */
export interface TrackingData {
  rows: TrackingRow[]
  templates: TrackingTemplate[]
}

/**
 * The 控制作業 forms in column order (#86): 福清's paper order 01–15 first, then the forms only some 廠區 have, in
 * 台北總公司's order 12–22 (paper numbers differ between 廠區, so they cannot order the columns). `short` is the
 * header on screen. A form not listed here still gets its own column, after these.
 */
export const CONTROL_FORMS: readonly { name: string; short: string }[] = [
  { name: '銷售及收款循環', short: '銷售' },
  { name: '採購及付款循環', short: '採購' },
  { name: '生產循環', short: '生產' },
  { name: '存貨循環', short: '存貨' },
  { name: '固定資產循環', short: '固資' },
  { name: '融資循環', short: '融資' },
  { name: '投資循環', short: '投資' },
  { name: '薪工循環', short: '薪工' },
  { name: '內部管理控制制度', short: '內管' },
  { name: '研發循環', short: '研發' },
  { name: '預算管理制度', short: '預算' },
  { name: '取得或處分資產處理辦法', short: '取處' },
  { name: '電腦化資訊系統處理循環', short: '電腦化' },
  { name: '董事會議事運作之管理', short: '董事會' },
  { name: '公司與關係人交易作業辦法', short: '關係人' },
  { name: '內部重大資訊暨防範內線交易管理辦法', short: '內線' },
  { name: '薪資報酬委員會運作管理辦法', short: '薪酬會' },
  { name: '財務報表編制流程管理作業', short: '財報' },
  { name: '個人資料保護管理辦法', short: '個資' },
  { name: '審計委員會議事運作之管理', short: '審計會' },
  { name: '公司誠信經營守則', short: '誠信' },
  { name: '永續資訊管理作業', short: '永續' },
]

/**
 * The 控制作業 form a 範本 name belongs to: the name without the 廠區's own distinction in brackets at the end, so
 * 「研發循環（沖壓）」 and 「研發循環（模具）」 share the 研發循環 column (Q111 (5) names them so). NFC first: names
 * converted from Word may carry CJK compatibility ideographs (SY-15's 易 and 理 are U+F9E0 and U+F9E4) that look the
 * same but would not match.
 */
export function controlForm(templateName: string): string {
  return templateName.normalize('NFC').replace(/\s*[（(][^（）()]*[）)]\s*$/, '').trim()
}

/**
 * A matrix column (#86). `component`: a 組成要素 other than 控制作業 (key: its ComponentKey); `controls`: 控制作業 as
 * a whole, one cell per 廠區 over all its forms (key: control_activities); `form`: one 控制作業 form, shown when
 * 控制作業 is expanded (key: the form's name). The columns run 一、二、三 (the total, then its forms)、四、五, and
 * 未分類 last when a 自評表 or 範本 has no 組成要素.
 */
export interface TrackingColumn {
  kind: 'component' | 'controls' | 'form'
  /** Unique per column and stable; also in the test ids. */
  key: string
}

/**
 * A matrix cell. `assessments`: the 自評表 shown here (one, or several when a 廠區 has more than one 範本 for the
 * form, like KS 研發) plus the applicable 範本 not launched this 年度 (`missing`); `total` marks the 控制作業 total.
 * `not_launched`: applicable 範本, none launched. `filtered_out`: launched, but the 狀態 filter leaves them out
 * (blank, so it is not mistaken for 未發起). `not_applicable`: the 廠區 has no such 範本 (a dash, never counted).
 */
export type TrackingCell =
  | { kind: 'assessments'; rows: TrackingRow[]; missing: TrackingTemplate[]; total?: true }
  | { kind: 'not_launched'; missing: TrackingTemplate[] }
  | { kind: 'filtered_out' }
  | { kind: 'not_applicable' }

/** The 自評表 a cell shows. */
export const cellRows = (cell: TrackingCell): TrackingRow[] => (cell.kind === 'assessments' ? cell.rows : [])

/** The 自評表 when a cell is that one on its own: its 停留天數 (or a tick) in the cell, a link to it. */
export function singleAssessment(cell: TrackingCell): TrackingRow | null {
  return cell.kind === 'assessments' && !cell.total && cell.rows.length === 1 && cell.missing.length === 0 ? cell.rows[0]! : null
}

export interface PlantRow {
  id: string
  company_name: string
  factory_code: string
  plant_name: string
  /** One per column of `columns`. */
  cells: TrackingCell[]
  /** Its 自評表 shown, each once, in column order. */
  rows: TrackingRow[]
}

export interface TrackingMatrix {
  /** Every column, 控制作業's forms included; the screen hides the forms while 控制作業 is folded. */
  columns: TrackingColumn[]
  plants: PlantRow[]
}

/**
 * 範本 codes as the paper numbers them: 控制活動類 01–15 by number, including sub-numbers like 01.1 and 10.1
 * (01.1 before 02, 10.1 after 09, 5.1 like 05.1), then 要素類 A–D. Codes are 「廠區代碼-紙本編號」 (Q111): grouped by
 * plant, then by paper number; a suffix after the number (LH-05.2-沖壓) orders after the bare number. Anything else
 * falls back to plain text order.
 */
export function compareTemplateCode(a: string, b: string): number {
  const pa = splitCode(a)
  const pb = splitCode(b)
  if (pa.plant !== pb.plant) return textOrder(pa.plant, pb.plant)
  const na = pa.numbers
  const nb = pb.numbers
  if (na && nb) {
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
      // A code without a sub-number comes before its own sub-numbers: 01 before 01.1.
      const diff = (na[i] ?? -1) - (nb[i] ?? -1)
      if (diff) return diff
    }
    return textOrder(pa.rest, pb.rest)
  }
  if (na) return -1
  if (nb) return 1
  return textOrder(pa.rest, pb.rest)
}

function textOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 「LH-05.2-沖壓」→ plant LH, numbers [5, 2], rest 「-沖壓」; codes before Q111 (「02」) have no plant. Plant codes have
 * at least two letters, so a single letter before the dash (「C-1」, an 要素類 code) is not a plant.
 */
function splitCode(code: string): { plant: string; numbers: number[] | null; rest: string } {
  const prefixed = /^([A-Z]{2,})-(.+)$/.exec(code)
  const plant = prefixed?.[1] ?? ''
  const paper = prefixed?.[2] ?? code
  const number = /^\d+(\.\d+)*/.exec(paper)?.[0]
  return number ? { plant, numbers: number.split('.').map(Number), rest: paper.slice(number.length) } : { plant, numbers: null, rest: paper }
}

/** Where a 自評表 or 範本 goes: its 組成要素's column, or for 控制作業 its form's column. */
function columnFor(component: TemplateComponent | null, name: string): TrackingColumn {
  return component === 'control_activities' ? { kind: 'form', key: controlForm(name) } : { kind: 'component', key: componentKey(component) }
}

/** Columns in order: the 組成要素 by 處理準則 (未分類 last), 控制作業's total before its forms, forms by CONTROL_FORMS. */
function columnOrder(c: TrackingColumn): [number, number, string] {
  if (c.kind === 'form') {
    const i = CONTROL_FORMS.findIndex((f) => f.name === c.key)
    return [COMPONENTS.indexOf('control_activities'), i < 0 ? CONTROL_FORMS.length + 1 : i + 1, c.key]
  }
  const i = COMPONENTS.indexOf(c.key as TemplateComponent)
  return [i < 0 ? COMPONENTS.length : i, 0, '']
}

function compareColumns(a: TrackingColumn, b: TrackingColumn): number {
  const [ga, fa, na] = columnOrder(a)
  const [gb, fb, nb] = columnOrder(b)
  return ga - gb || fa - fb || textOrder(na, nb)
}

type Coded = Pick<TrackingRow, 'template_code'>
const byCode = (a: Coded, b: Coded) => compareTemplateCode(a.template_code, b.template_code)

function cellOf(shown: TrackingRow[], launched: number, missing: TrackingTemplate[]): TrackingCell {
  if (shown.length) return { kind: 'assessments', rows: shown.sort(byCode), missing: missing.sort(byCode) }
  if (launched) return { kind: 'filtered_out' }
  return missing.length ? { kind: 'not_launched', missing: missing.sort(byCode) } : { kind: 'not_applicable' }
}

/**
 * The 熱度矩陣 (#86): 廠區 rows in the order the rows came (公司 → 廠區 from the database); columns by 組成要素, 控制作業
 * also by form, the forms merged by 範本 name across 廠區 (each 廠區 has its own 範本, Q111). A cell holds that 廠區's
 * 自評表 of the column and the applicable 範本 it has not launched; a 廠區 with neither is 不適用. The 公司 and 廠區
 * filters choose the rows; the 狀態 filter keeps only the rows and columns with a matching 自評表 and blanks the
 * other 自評表 among them.
 */
export function trackingMatrix(data: TrackingData, filter: TrackingFilter = NO_FILTER): TrackingMatrix {
  const scope = filterTracking(data.rows, { ...filter, status: 'all' })
  const shown = new Set(filterTracking(scope, filter))
  const components = new Map(data.templates.map((t) => [t.template_id, t.template_component]))
  // Worked out once per 自評表 and 範本: the cells below ask for each many times.
  const rowColumn = memo((r: TrackingRow) => columnFor(components.get(r.template_id) ?? null, r.template_name))
  const templateColumn = memo((t: TrackingTemplate) => columnFor(t.template_component, t.template_name))
  const plantRows = uniqueBy([...shown], (r) => r.plant_id)

  const own = new Map(plantRows.map((p) => {
    const launched = scope.filter((r) => r.plant_id === p.plant_id)
    // Launched by id or by code: a 範本 deleted and made again under the same 編號 is not 未發起 if this 廠區 has it this 年度.
    const launchedIds = new Set(launched.map((r) => r.template_id))
    const launchedCodes = new Set(launched.map((r) => r.template_code))
    const missing = data.templates.filter(
      (t) => t.applies_to.includes(p.plant_id) && !launchedIds.has(t.template_id) && !launchedCodes.has(t.template_code),
    )
    return [p.plant_id, { launched, missing }]
  }))

  // With the 狀態 filter only the columns with a matching 自評表; without it also those with a 未發起 cell.
  const found = new Map<string, TrackingColumn>()
  const add = (c: TrackingColumn) => found.set(c.key, c)
  if (filter.status === 'all') {
    for (const { launched, missing } of own.values()) {
      launched.forEach((r) => add(rowColumn(r)))
      missing.forEach((t) => add(templateColumn(t)))
    }
  } else {
    shown.forEach((r) => add(rowColumn(r)))
  }
  if ([...found.values()].some((c) => c.kind === 'form')) add({ kind: 'controls', key: 'control_activities' })
  const columns = [...found.values()].sort(compareColumns)

  const plants = plantRows.map((p): PlantRow => {
    const { launched, missing } = own.get(p.plant_id)!
    // The 控制作業 total covers all of the 廠區's forms, shown as columns or not.
    const inColumn = (c: TrackingColumn) => (x: TrackingColumn) => (c.kind === 'controls' ? x.kind === 'form' : x.key === c.key)
    const cells = columns.map((c): TrackingCell => {
      const here = launched.filter((r) => inColumn(c)(rowColumn(r)))
      const cell = cellOf(here.filter((r) => shown.has(r)), here.length, missing.filter((t) => inColumn(c)(templateColumn(t))))
      return c.kind === 'controls' && cell.kind === 'assessments' ? { ...cell, total: true } : cell
    })
    return {
      id: p.plant_id,
      company_name: p.company_name,
      factory_code: p.factory_code,
      plant_name: p.plant_name,
      cells,
      rows: cells.flatMap((cell, i) => (columns[i]!.kind === 'controls' ? [] : cellRows(cell))),
    }
  })
  return { columns, plants }
}

/** A column's header in full, the Excel's and the title on screen: 「三、控制作業」, or the form's name. */
export function columnLabel(c: TrackingColumn, t: TFunction): string {
  return c.kind === 'form' ? c.key : t(`common:templates.componentHeadings.${c.key}`)
}

/**
 * A column's header on screen, short so 27 columns fit: a form's short name (研發), a 組成要素 without its numbering
 * (控制環境); the title and the Excel keep columnLabel.
 */
export function columnHeader(c: TrackingColumn, t: TFunction): string {
  return c.kind === 'form' ? (CONTROL_FORMS.find((f) => f.name === c.key)?.short ?? c.key) : t(`common:templates.components.${c.key}`)
}

export interface DwellThresholds {
  /** From this many days at one 關卡 a 簽核中 自評表 has stayed long. */
  long: number
  /** From this many days it has stayed very long. */
  veryLong: number
}

/**
 * 停留天數門檻 (Q105): 7／14 天 is a stand-in until Q95 (6) is decided; the 追蹤總覽 colours, the 停留 counts
 * and the legend all read it from here, so settling it is this one change.
 */
export const DWELL_THRESHOLDS: DwellThresholds = { long: 7, veryLong: 14 }

export type DwellLevel = 'short' | 'long' | 'veryLong'

/** A 自評表's 停留天數; a 簽核中 one always has it from the database, so a missing one counts as day 0. */
export const daysAtStep = (r: TrackingRow) => r.days_at_step ?? 0

/** Where a 簽核中 自評表's 停留天數 falls against the thresholds. */
export function dwellLevel(days: number, thresholds: DwellThresholds = DWELL_THRESHOLDS): DwellLevel {
  return days >= thresholds.veryLong ? 'veryLong' : days >= thresholds.long ? 'long' : 'short'
}

/** 「停留 14 天以上」「停留 7–13 天」「未滿 7 天」, the 熱度矩陣 legend; `t` is the `tracking` namespace. */
export function dwellLabel(level: DwellLevel, t: TFunction, thresholds: DwellThresholds = DWELL_THRESHOLDS): string {
  return t(`dwell.${level}`, { long: thresholds.long, veryLong: thresholds.veryLong, last: thresholds.veryLong - 1 })
}

export interface DwellCounts {
  /** At their 關卡 for at least `long` days. */
  long: number
  /** Of those, at least `veryLong` days. */
  veryLong: number
}

/** How many of these have stayed long and very long; other levels (結案, empty cells) do not count. */
export function dwellCounts(levels: readonly HeatLevel[]): DwellCounts {
  return { long: levels.filter((l) => l === 'long' || l === 'veryLong').length, veryLong: levels.filter((l) => l === 'veryLong').length }
}

/** A 熱度矩陣 cell's shade: 結案, 簽核中 by its 停留天數, or a cell with no 自評表 shown. */
export type HeatLevel = 'closed' | DwellLevel | 'not_launched' | 'filtered_out' | 'not_applicable'

/** A 自評表's shade: 結案, or 簽核中 by its 停留天數. */
export function rowLevel(r: TrackingRow, thresholds: DwellThresholds = DWELL_THRESHOLDS): HeatLevel {
  return r.status === 'closed' ? 'closed' : dwellLevel(daysAtStep(r), thresholds)
}

/**
 * A cell with several 自評表 is shaded by the one not yet 結案 that has stayed longest; 結案 once all are and none of
 * its applicable 範本 is still to be launched (until then it reads as 簽核中, so it does not look finished).
 */
export function heatLevel(cell: TrackingCell, thresholds: DwellThresholds = DWELL_THRESHOLDS): HeatLevel {
  if (cell.kind !== 'assessments') return cell.kind
  const open = cell.rows.filter((r) => r.status !== 'closed')
  if (open.length) return dwellLevel(Math.max(...open.map(daysAtStep)), thresholds)
  return cell.missing.length ? 'short' : 'closed'
}

/** `long`／`veryLong`: the 簽核中 ones shown that have stayed long and very long. */
export interface TrackingSummary extends DwellCounts {
  /** 自評表 shown (簽核中 + 已結案) */
  total: number
  inProgress: number
  closed: number
  /** 已結案 out of `total`, rounded to a whole percent; 0 with nothing shown. */
  closedPercent: number
  /** Applicable 範本 not launched, in the 廠區 shown (also those beside a launched one in a cell); 不適用 never count. */
  notLaunched: number
  /** Rows of the matrix shown, and its columns expanded (each 控制作業 form, not the total). */
  plants: number
  templates: number
}

export function trackingSummary(matrix: TrackingMatrix, thresholds: DwellThresholds = DWELL_THRESHOLDS): TrackingSummary {
  const rows = matrix.plants.flatMap((p) => p.rows)
  const leaves = matrix.columns.flatMap((c, i) => (c.kind === 'controls' ? [] : [i]))
  const { closed, total } = closedCount(rows)
  return {
    total,
    inProgress: total - closed,
    closed,
    closedPercent: total ? Math.round((closed / total) * 100) : 0,
    notLaunched: matrix.plants.flatMap((p) => leaves.map((i) => p.cells[i]!)).reduce((n, c) => n + ('missing' in c ? c.missing.length : 0), 0),
    plants: matrix.plants.length,
    templates: leaves.length,
    ...dwellCounts(rows.map((r) => rowLevel(r, thresholds))),
  }
}

export interface ClosedCount {
  closed: number
  /** 自評表 shown (未發起, 不適用 and filtered-out ones do not count). */
  total: number
}

/** 已結案 n／m of a 廠區 row (`plant.rows`), a column (`matrix.plants.flatMap((p) => cellRows(p.cells[i]))`) or a cell. */
export function closedCount(rows: readonly TrackingRow[]): ClosedCount {
  return { closed: rows.filter((r) => r.status === 'closed').length, total: rows.length }
}

/** 「代碼 名稱」 of a 自評表's 範本, as it was launched. */
export const templateLabel = (r: TrackingRow) => `${r.template_code} ${r.template_name}`

/** A 自評表 in the 待處理優先 list, with the matrix row it sits in. */
export interface QueueItem {
  row: TrackingRow
  plant: PlantRow
}

/** One 廠區 of 待處理優先; `long`／`veryLong` count its 簽核中 ones. */
export interface PlantQueue extends DwellCounts {
  plant: PlantRow
  /** Its 簽核中 ones, the longest 停留 first; equal 停留天數 keep the 範本 column order. */
  inProgress: QueueItem[]
  /** Its 已結案 ones, in 範本 column order. */
  closed: QueueItem[]
}

export interface TrackingQueue {
  /** One per 廠區 of the matrix, in the matrix order (公司 → 廠區). */
  plants: PlantQueue[]
}

/**
 * 待處理優先 (Q105): the 自評表 of the matrix (the same filters applied) grouped by 廠區 first, and within a 廠區 the
 * 簽核中 ones that have stayed longest first.
 */
export function trackingQueue(matrix: TrackingMatrix, thresholds: DwellThresholds = DWELL_THRESHOLDS): TrackingQueue {
  const days = (item: QueueItem) => daysAtStep(item.row)
  const plants = matrix.plants.map((plant): PlantQueue => {
    const items = plant.rows.map((row): QueueItem => ({ row, plant }))
    const inProgress = items.filter((item) => item.row.status === 'in_progress').sort((a, b) => days(b) - days(a))
    return {
      plant,
      inProgress,
      closed: items.filter((item) => item.row.status === 'closed'),
      ...dwellCounts(inProgress.map((item) => dwellLevel(days(item), thresholds))),
    }
  })
  return { plants }
}

const TAIPEI_DATE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
const TAIPEI_MINUTE = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

/** YYYY-MM-DD in Taipei, the calendar the database counts 停留天數 in. */
export const taipeiDate = (at: string) => TAIPEI_DATE.format(new Date(at))
/** YYYY-MM-DD HH:mm in Taipei. */
export const taipeiMinute = (at: string) => TAIPEI_MINUTE.format(new Date(at))

/** The 簽核人 by 姓名（工號）, or 待分派; `t` is the `tracking` namespace. */
export const signerLabel = (r: TrackingRow, t: TFunction) =>
  r.current_signer_emp_id ? formatSigner(r.current_signer_name, r.current_signer_emp_id) : t('unassigned')

/** The 範本編號, which of a 廠區's 範本 a line is about. */
const templateRef = (r: Coded) => r.template_code

/**
 * A cell's text, line by line; `t` is the `tracking` namespace. One 自評表: its 範本 and where it stands. Several (or
 * some not launched): 已結案 n／m, then one line per 範本 (the 控制作業 total lists only those not yet 結案, the
 * longest 停留 first, so a 廠區's twelve-odd forms stay readable).
 */
export function cellLines(cell: TrackingCell, t: TFunction): string[] {
  if (cell.kind === 'filtered_out') return []
  if (cell.kind === 'not_applicable') return [t('cell.notApplicable')]
  if (cell.kind === 'not_launched') return [t('cell.notLaunched'), ...cell.missing.map(templateRef)]
  const only = singleAssessment(cell)
  if (only) return [templateRef(only), ...assessmentLines(only, t)]
  const listed = cell.total
    ? cell.rows.filter((r) => r.status !== 'closed').sort((a, b) => daysAtStep(b) - daysAtStep(a))
    : cell.rows
  return [
    t('cell.closedShare', { ...closedCount(cell.rows) }),
    ...listed.map((r) => `${templateRef(r)}：${briefLine(r, t)}`),
    ...cell.missing.map((m) => `${templateRef(m)}：${t('cell.notLaunched')}`),
  ]
}

/** Where one 自評表 stands on one line, without the signer: 「已結案 2027-02-18」「填寫中・已核准 3／4 單位 停留 5 天」. */
function briefLine(r: TrackingRow, t: TFunction): string {
  if (r.status === 'closed') return assessmentLines(r, t).filter(Boolean).join(' ')
  return `${stageLine(r, t)} ${t('cell.days', { count: r.days_at_step ?? 0 })}`
}

/**
 * Where one 自評表 stands: 已結案 and the date; or 填寫中／簽核中 and how far it got, the signer and the 停留天數.
 * Which 關卡 holds a 分流 up is left to the 自評表 page (user decision 2026-11-04, #99).
 */
export function assessmentLines(r: TrackingRow, t: TFunction): string[] {
  if (r.status === 'closed') return [t('cell.closed'), r.closed_at ? taipeiDate(r.closed_at) : '']
  return [
    stageLine(r, t),
    signerLabel(r, t),
    t('cell.days', { count: r.days_at_step ?? 0 }),
  ]
}

/** Before the 匯流 (#99, Q116): some 分流 still has a 關卡 to go. */
export const beforeMerge = (r: TrackingRow) => r.status === 'in_progress' && r.branches_done < r.branch_count

/** How far a 自評表 got: 「已核准 3／4 單位」 before the 匯流 (#99), 「第 10／12 關 廠區經理人」 after it. */
export function progressLine(r: TrackingRow, t: TFunction): string {
  return beforeMerge(r)
    ? t('cell.branches', { done: r.branches_done, total: r.branch_count })
    : t('cell.step', { position: r.current_step_position, count: r.step_count, name: r.current_step_name })
}

/** 「簽核中・已核准 3／4 單位」: the stage, then how far it got (progressLine). */
const stageLine = (r: TrackingRow, t: TFunction) => t('cell.stageProgress', { stage: t(`stage.${r.stage}`), progress: progressLine(r, t) })

/**
 * The 關卡 the 停留天數 counts from, by name alone (#99): before the 匯流 that of the 分流 longest without a move,
 * 「資材單位・自行檢查人員」; after it the one current 關卡.
 */
export const currentStepLabel = (r: TrackingRow) => stepLabel({ name: r.current_step_name, branch_unit_name: r.current_step_branch_unit })

export type SheetCell = string | number

export interface TrackingSheets {
  /** 總覽: the matrix as on screen, header row first. */
  overview: string[][]
  /** 明細: one row per 自評表 in the matrix, header row first. */
  detail: SheetCell[][]
}

const DETAIL_COLUMNS = [
  'year', 'company', 'plant', 'factoryCode', 'templateCode', 'templateName', 'status', 'stepPosition', 'stepCount',
  'stepName', 'signerEmpId', 'signerName', 'enteredAt', 'days', 'closedAt', 'dueDate',
] as const

/** What the Excel export writes, built from the same matrix the screen shows; 總覽 has every column, expanded. */
export function trackingSheets(matrix: TrackingMatrix, t: TFunction): TrackingSheets {
  const overview = [
    [t('plantHeader'), ...matrix.columns.map((c) => columnLabel(c, t))],
    ...matrix.plants.map((p) => [plantLabel(p), ...p.cells.map((c) => cellLines(c, t).join('\n'))]),
  ]
  const detail: SheetCell[][] = [
    DETAIL_COLUMNS.map((k) => t(`excel.${k}`)),
    ...matrix.plants.flatMap((p) => p.rows).map((r) => [
      r.year, r.company_name, r.plant_name, r.factory_code, r.template_code, r.template_name,
      // 狀態 is 填寫中／簽核中／已結案; before the 匯流 目前關卡／總關數 are 已核准單位數／適用單位數 and the name its unit's 關卡 (#99).
      t(`stage.${r.stage}`), ...(beforeMerge(r) ? [r.branches_done, r.branch_count] : [r.current_step_position, r.step_count]),
      currentStepLabel(r), r.current_signer_emp_id ?? '',
      r.current_signer_name ?? '',
      // A 結案 one has no current 關卡 to have entered; its time is the 結案 date.
      r.status === 'closed' ? '' : taipeiMinute(r.entered_step_at), r.days_at_step ?? '',
      r.closed_at ? taipeiDate(r.closed_at) : '', r.due_date,
    ]),
  ]
  return { overview, detail }
}

/** 「公司 廠區（代碼）」, the matrix's row header. */
export const plantLabel = (p: Pick<PlantRow, 'company_name' | 'plant_name' | 'factory_code'>) =>
  `${p.company_name} ${p.plant_name}（${p.factory_code}）`

function memo<K extends object, V>(compute: (key: K) => V): (key: K) => V {
  const seen = new WeakMap<K, V>()
  return (key) => {
    if (!seen.has(key)) seen.set(key, compute(key))
    return seen.get(key)!
  }
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
