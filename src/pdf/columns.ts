// The control-point table's columns per 版型 (ADR-0005), in paper order. A column is a header (optionally under a
// group header such as 內部控制制度設計), a width and what one control point prints in it, so a later column is one
// more entry here rather than a change to the table code.
import type { Content } from 'pdfmake/interfaces'
import type { Answer, DesignStatus, ExecutionStatus, SatisfactionLevel } from '../api/answerModel'
import type { AssessmentControlPoint } from '../api/assessments'
import type { TemplateLayout } from '../api/templates'

/**
 * One printed row: a control point × one of its 自評單位 (#46). A multi-unit control point prints its number and text
 * on its first row only; the rows below leave that cell blank and the table draws no rule between them (the paper's
 * merged cell).
 */
export interface PdfRow {
  point: AssessmentControlPoint
  /** null for a control point without 自評單位 (要素類, Q83(3)). */
  unit: string | null
  answer: Answer | null
  /**
   * What the paper prints before the text: 「3.」 when the system numbers it (its place in the card, Q125), or the
   * 原檔題號 as written (「1.1.1-1」「10.」).
   */
  number: string
  first: boolean
  last: boolean
}

export interface PdfColumn {
  /** Group header spanning adjacent columns with the same group; columns without one span both header rows. */
  group?: string
  header: string
  /** Content width in points (pdfmake adds 4pt padding each side), or '*' for the remaining width. */
  width: number | '*'
  cell(row: PdfRow): Content
  /**
   * Free text someone typed (改善措施、補充說明), which can be longer than a page; the table prints it itself and goes
   * on in continuation rows when it does not fit one. Needs a numeric `width`.
   */
  longText?(row: PdfRow): string
}

/** The paper's tick boxes are about the height of its 10pt text. */
const BOX = 9

/** A paper checkbox centered in a cell `width` points wide: a drawn box, with ✓ printed over it when ticked. */
export function checkbox(ticked: boolean, width: number): Content {
  const box: Content = { canvas: [{ type: 'rect', x: (width - BOX) / 2, y: 2, w: BOX, h: BOX, lineWidth: 0.5 }] }
  const check: Content[] = ticked ? [{ text: '✓', alignment: 'center', fontSize: 12, relativePosition: { x: 1, y: -14 } }] : []
  return { stack: [box, ...check], verticalAlignment: 'middle' } as Content
}

const choice =
  <K extends keyof Answer>(field: K, group: string, width: number) =>
  ([value, header]: [Answer[K], string]): PdfColumn => ({
    group,
    header,
    width,
    cell: (r) => checkbox(r.answer?.[field] === value, width),
  })

const DESIGN = '內部控制制度設計'
const EXECUTION = '內部控制制度執行情形'
const SATISFACTION = '設計、執行有效控制滿意度'
const REMARK = '備註說明'
// Headers carry the paper's own line breaks (有內控／規範, 所需採行之改善措施/／其他考量) instead of wrapping mid-word.
const IMPROVEMENT_HEADER = '所需採行之改善措施/\n其他考量'

const improvement = (r: PdfRow) => r.answer?.improvement ?? ''

const pointText: PdfColumn = {
  header: '控制要點',
  width: '*',
  // pdfmake's cell border is [left, top, right, bottom]: no rule between the rows of one control point.
  cell: (r) => ({ text: r.first ? `${r.number} ${r.point.text}` : '', border: [true, r.first, true, r.last] }),
}

export const unitColumn: PdfColumn = {
  header: '自評單位',
  // Room for a four-character unit name (資材單位) at 10pt on one line, as on paper.
  width: 52,
  cell: (r) => ({ text: r.unit ?? '', alignment: 'center', verticalAlignment: 'middle' }),
}

const SATISFACTION_COLUMNS: [SatisfactionLevel, string][] = [
  ['very_satisfied', '非常\n滿意'],
  ['satisfied', '滿意'],
  ['adequate', '剛好'],
  ['needs_improvement', '需要\n加強'],
  ['dissatisfied', '不\n滿意'],
]

// Widths follow the paper's Word columns on the full-width A4 landscape table (print.ts CONTENT_WIDTH), at 10pt; the
// 滿意度 group is a little wider than paper so its header stays on one line.
const satisfaction = SATISFACTION_COLUMNS.map(choice('satisfaction', SATISFACTION, 20))

const CONTROL_ACTIVITY: PdfColumn[] = [
  pointText,
  unitColumn,
  ...([['has_rule', '有內控\n規範'], ['no_rule', '無內控\n規範']] as [DesignStatus, string][]).map(choice('design', DESIGN, 41)),
  ...([['yes', '是'], ['no', '否'], ['not_applicable', '不\n適用'], ['no_case', '無此\n情形']] as [ExecutionStatus, string][]).map(
    choice('execution', EXECUTION, 26),
  ),
  ...satisfaction,
  { group: REMARK, header: IMPROVEMENT_HEADER, width: 100, cell: () => ({ text: '' }), longText: improvement },
]

/**
 * 要素類 (A–D): 評估結果 是／否／不適用 with 補充說明 (where the page stores 補充說明, Q84(4)). The paper has no 自評單位
 * column; it gets one, taken from the 備註說明 width, only when more than one 自評單位 answers (Q92).
 */
const element = (withUnits: boolean): PdfColumn[] => [
  pointText,
  ...(withUnits ? [unitColumn] : []),
  ...([['yes', '是'], ['no', '否'], ['not_applicable', '不\n適用']] as [ExecutionStatus, string][]).map(choice('execution', '評估結果', 26)),
  { group: '評估結果', header: '補充說明', width: 120, cell: () => ({ text: '' }), longText: improvement },
  ...satisfaction,
  { group: REMARK, header: IMPROVEMENT_HEADER, width: withUnits ? 60 : 120, cell: () => ({ text: '' }) },
]

/** The columns of a 版型; `withUnits` is showsUnitColumn (src/domain/answering.ts), always true on 控制活動類. */
export function columnsFor(layout: TemplateLayout, withUnits: boolean): PdfColumn[] {
  return layout === 'element' ? element(withUnits) : CONTROL_ACTIVITY
}

/**
 * A section row's text: the 原檔題號 if any, then the name (「1.1 公司是否…」, Q125). 控制活動類 paper marks each
 * 第一層 with ◆, which the converted names leave out (「供應商管理作業」); its 分段 are set in instead (`level`).
 */
export function sectionTitle(layout: TemplateLayout, section: { level: number; code: string | null; name: string }): string {
  const text = section.code ? `${section.code} ${section.name}` : section.name
  return layout === 'control_activity' && section.level === 1 && !text.startsWith('◆') ? `◆ ${text}` : text
}
