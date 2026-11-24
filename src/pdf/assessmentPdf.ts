// 匯出 PDF（方案A，#7）: one 自評表 snapshot, its answers and 簽核紀錄 in, the paper-shaped PDF out.
import type { Content, TableCell, TableLayout, TDocumentDefinitions } from 'pdfmake/interfaces'
import type { Assessment } from '../api/assessments'
import type { Signoff } from '../api/signoffModel'
import { showsUnitColumn } from '../domain/answering'
import { outline, pointNumbers } from '../domain/outline'
import { columnsFor, sectionTitle, unitColumn, type PdfColumn, type PdfRow } from './columns'
import { PDF_FONT, type PdfEngine } from './engine'
import { historyPage } from './history'
import {
  byPosition,
  CONTENT_WIDTH,
  estimateLines,
  HEADER_FONT_SIZE,
  PAGE_MARGIN,
  POINT_CELL_PADDING,
  POINT_TABLE_RULES,
  RULE_WIDTH,
  splitForRows,
  TABLE_FONT_SIZE,
  TABLE_LINE_HEIGHT,
} from './print'
import { conclusionBox, signatureSection } from './signatures'

export type PdfAssessment = Pick<
  Assessment,
  'template_name' | 'template_layout' | 'annual_cycle' | 'assessment_section' | 'assessment_step' | 'assessment_conclusion'
>

export interface AssessmentPdfInput {
  assessment: PdfAssessment
  companyName: string
  /** The whole 簽核歷程, voided sign-offs included. */
  signoffs: Signoff[]
  /** IANA zone the sign-off times are printed in. */
  timeZone: string
  /**
   * Q109: true prints each 簽核欄 cell's time and 簽核記錄編號 and ends with the 簽核歷程 page (Q88 (1)); false prints
   * the names only and leaves the 簽核歷程 page out, so the PDF carries no 方案A evidence (🔴 OPEN-1: the system
   * records stand).
   */
  withSignedAt: boolean
  /** Image data URLs for the header: the group logo (left) and the company's (right); a missing one leaves space. */
  logos?: { group?: string; company?: string }
}

/** Two header rows: grouped columns share a group cell above their own headers; the others span both rows. */
function headerRows(columns: PdfColumn[]): TableCell[][] {
  const top: TableCell[] = []
  const bottom: TableCell[] = []
  columns.forEach((c, i) => {
    if (!c.group) {
      top.push({ text: c.header, rowSpan: 2, verticalAlignment: 'middle' })
      bottom.push({ text: '' })
    } else {
      if (columns[i - 1]?.group === c.group) top.push({ text: '' })
      else top.push({ text: c.group, colSpan: columns.filter((o) => o.group === c.group).length })
      bottom.push({ text: c.header, verticalAlignment: 'middle' })
    }
  })
  return [top, bottom].map((row) => row.map((cell) => ({ alignment: 'center', fontSize: TABLE_FONT_SIZE, ...(cell as object) }) as TableCell))
}

/**
 * The printed rows of one section: each control point once per 自評單位, or once when it has none (#46). `numbers`
 * is each control point's # in its card (domain/outline): the 原檔題號 as written, or its place, printed 「3.」.
 */
function pdfRows(points: PdfAssessment['assessment_section'][number]['assessment_control_point'], numbers: ReadonlyMap<string, string>): PdfRow[] {
  return byPosition(points).flatMap((point): PdfRow[] => {
    const number = point.code ?? `${numbers.get(point.id)}.`
    const units = byPosition(point.assessment_control_point_unit)
    if (units.length === 0) return [{ point, unit: null, answer: null, number, first: true, last: true }]
    return units.map((u, i) => ({
      point,
      unit: u.assessing_unit_name,
      answer: u.assessment_answer,
      number,
      first: i === 0,
      last: i === units.length - 1,
    }))
  })
}

/** The content width pdfmake gives the control-point column ('*'): what the fixed columns, cell padding and rules leave. */
function pointTextWidth(columns: PdfColumn[]): number {
  const fixed = columns.reduce((sum, c) => sum + (typeof c.width === 'number' ? c.width : 0), 0)
  return CONTENT_WIDTH - fixed - columns.length * (POINT_CELL_PADDING.left + POINT_CELL_PADDING.right) - (columns.length + 1) * RULE_WIDTH
}

/** The Word form prints the section rows (「◆ 供應商管理作業」,「（一）…」) in red (#78). */
const SECTION_TITLE_COLOR = '#ff0000'
/** How far each 分段 level sits in from the one above it (Q125). */
const SUBSECTION_INDENT = 12

function controlPointTable(a: PdfAssessment): Content {
  const columns = columnsFor(a.template_layout, showsUnitColumn(a.template_layout, a))
  const unitAt = columns.indexOf(unitColumn)
  const textWidth = pointTextWidth(columns)
  const body: TableCell[][] = [...headerRows(columns)]
  // A section row per 章節, each 分段 set in by its level; the control points are numbered over their card (Q125).
  const parts = outline(byPosition(a.assessment_section)).flatMap((card) => {
    const numbers = pointNumbers(card, (s) => s.assessment_control_point)
    const rowsOf = card.parts.map(({ section }) => pdfRows(section.assessment_control_point, numbers))
    // A section row stays on the page of the first control point under it: its own, or for a 章節 that only heads
    // the 分段 after it, theirs (in the same card).
    return card.parts.map(({ section, level }, i) => ({
      section,
      level,
      rows: rowsOf[i]!,
      pointsAt: card.parts.find((_, k) => k >= i && rowsOf[k]!.length > 0)?.section.id,
    }))
  })
  parts.forEach(({ section, level, rows, pointsAt }) => {
    body.push([
      {
        text: sectionTitle(a.template_layout, { ...section, level }),
        color: SECTION_TITLE_COLOR,
        colSpan: columns.length,
        ...(level > 1 ? { margin: [(level - 1) * SUBSECTION_INDENT, 0, 0, 0] } : {}),
        ...(pointsAt ? { id: `${SECTION_ROW}${pointsAt}/${section.id}` } : {}),
      } as TableCell,
      ...columns.slice(1).map(() => ({ text: '' })),
    ])
    // A long 改善措施 goes on in rows marked 「n.（續）」 that repeat the 自評單位 it belongs to, each short enough to fit one page.
    const pieces = rows.map((row) => columns.map((c) => (c.longText && typeof c.width === 'number' ? splitForRows(c.longText(row), c.width) : null)))
    const lineCount = pieces.map((p) => Math.max(1, ...p.map((piece) => piece?.length ?? 0)))
    rows.forEach((row, r) => {
      const group = rows.flatMap((other, k) => (other.point === row.point ? [k] : []))
      const id = r === 0 ? { id: `${FIRST_POINT}${section.id}` } : {}
      // A multi-unit control point is one table row, so a page break never splits it: its text on the left, and its
      // 自評單位 rows as a table nested in the cells to the right, sharing the height evenly as on paper (#46).
      if (group.length > 1 && group.every((k) => lineCount[k] === 1)) {
        if (row.first) body.push(mergedRow(columns, group.map((k) => rows[k]!), textWidth, id))
        return
      }
      // With a continuation row among them the rows are not one block: the text stays in the first row and the rule
      // below it is left out (columns.ts pointText); like the paper, such a control point may run onto the next page.
      for (let line = 0; line < lineCount[r]!; line++) {
        body.push(
          columns.map((c, n) => {
            if (pieces[r]![n]) return { text: pieces[r]![n]![line] ?? '' }
            if (line > 0) return { text: n === 0 ? `${row.number}（續）` : n === unitAt ? (row.unit ?? '') : '' }
            return { ...(c.cell(row) as object), ...(n === 0 ? id : {}) } as TableCell
          }),
        )
      }
    })
  })
  return {
    table: { headerRows: 2, dontBreakRows: true, widths: columns.map((c) => c.width), body },
    layout: POINT_TABLE_RULES,
  }
}

/** The rules of a table nested in a cell: none on its outer edges, which the surrounding table already draws. */
const NESTED_RULES: TableLayout = {
  paddingLeft: () => POINT_CELL_PADDING.left,
  paddingRight: () => POINT_CELL_PADDING.right,
  paddingTop: () => POINT_CELL_PADDING.top,
  paddingBottom: () => POINT_CELL_PADDING.bottom,
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : RULE_WIDTH),
  vLineWidth: (i, node) => (i === 0 || i === (node.table.widths?.length ?? 0) ? 0 : RULE_WIDTH),
}

/**
 * One multi-unit control point as a single row: the text, centred, and one cell spanning the per-unit columns that
 * holds a nested table with a row per 自評單位. The nested table has the outer columns' widths and pulls itself over
 * the cell's padding (negative margins), so its rules line up with the header's.
 */
function mergedRow(columns: PdfColumn[], units: PdfRow[], textWidth: number, id: object): TableCell[] {
  const first = units[0]!
  const text = `${first.number} ${first.point.text}`
  const rest = columns.slice(1)
  const layout = spanLayout(text, textWidth, units.length)
  const pad = POINT_CELL_PADDING
  return [
    { text, margin: [0, layout.top, 0, 0], ...id } as TableCell,
    {
      colSpan: rest.length,
      margin: [-pad.left, -pad.top, -pad.right, -pad.bottom],
      table: {
        widths: rest.map((c) => c.width),
        heights: units.map(() => layout.rowHeight),
        // Free text (改善措施) prints from longText; here it fits one row, or the rows would not have been merged.
        body: units.map((row) => rest.map((c) => (c.longText ? { text: c.longText(row) } : (c.cell(row) as TableCell)))),
      },
      layout: NESTED_RULES,
    } as TableCell,
    ...rest.slice(1).map(() => ({ text: '' })),
  ]
}

/**
 * The height each 自評單位 row of a merged control point gets (content height, at least one line), so the rows
 * together hold the text and share it evenly; and the top margin that centres the text, as on paper. The line count is
 * estimated (estimateLines) on the safe side.
 */
function spanLayout(text: string, width: number, rows: number): { rowHeight: number; top: number } {
  const textHeight = estimateLines(text, width) * TABLE_LINE_HEIGHT
  const between = POINT_CELL_PADDING.top + POINT_CELL_PADDING.bottom + RULE_WIDTH
  const rowHeight = Math.max(TABLE_LINE_HEIGHT, Math.ceil((textHeight - (rows - 1) * between) / rows))
  const spanned = rows * rowHeight + (rows - 1) * between
  return { rowHeight, top: Math.max(0, (spanned - textHeight) / 2) }
}

// Node ids that pair a section row with its first control point, so keepSectionsWithFirstPoint can find them: a
// section row's id names the section whose first control point it waits for, then its own.
const SECTION_ROW = 'section-row:'
const FIRST_POINT = 'first-point:'

interface LaidOutNode {
  id?: string
  startPosition?: { pageNumber: number }
}

/**
 * pdfmake's pageBreakBefore hook: a section row whose first control point is not on the same page (it was the last
 * row there) moves to the next page with it, as on the paper. pdfmake lays the document out again after each break.
 * The "following nodes on page" can include a table row that unbreakable rows pushed onto the next page, so the
 * first control point counts only when it starts on the section row's page.
 */
function keepSectionsWithFirstPoint(node: LaidOutNode, nodes: { getFollowingNodesOnPage(): LaidOutNode[] }): boolean {
  if (!node.id?.startsWith(SECTION_ROW)) return false
  const first = FIRST_POINT + node.id.slice(SECTION_ROW.length).split('/')[0]
  const page = node.startPosition?.pageNumber
  return !nodes.getFollowingNodesOnPage().some((n) => n.id === first && n.startPosition?.pageNumber === page)
}

/**
 * Each logo's box in the Word form's 版頭 (#78): the group logo 66 × 45.1 pt, the company's 67.5 × 36.75 pt. Both sit
 * in columns of the same LOGO_WIDTH, so the title between them stays centred on the page.
 */
const LOGO_WIDTH = 72
const GROUP_LOGO: [number, number] = [66, 45]
const COMPANY_LOGO: [number, number] = [68, 37]
/** The Word form's red bar under the 版頭 runs 58.5% of the width, then continues as a hairline along its top. */
const HEADER_BAR = CONTENT_WIDTH * 0.585
const HEADER_BAR_COLOR = '#cc0000'

/** The Word form's 版頭 (#78): group logo, company and title, company logo, then the red bar running into a hairline. */
function header(input: AssessmentPdfInput): Content {
  const logo = (image: string | undefined, fit: [number, number], alignment: 'left' | 'right'): Content =>
    (image ? { image, fit, width: LOGO_WIDTH, alignment } : { text: '', width: LOGO_WIDTH }) as Content
  return {
    margin: [PAGE_MARGIN, 14, PAGE_MARGIN, 0],
    stack: [
      {
        columns: [
          logo(input.logos?.group, GROUP_LOGO, 'left'),
          {
            width: '*',
            margin: [0, 8, 0, 0],
            stack: [
              { text: input.companyName, alignment: 'center', fontSize: HEADER_FONT_SIZE },
              {
                text: `${input.assessment.annual_cycle.year} 年度內部控制制度自行評估問卷表~${input.assessment.template_name}`,
                alignment: 'center',
                fontSize: HEADER_FONT_SIZE,
              },
            ],
          },
          logo(input.logos?.company, COMPANY_LOGO, 'right'),
        ],
      },
      {
        canvas: [
          { type: 'rect', x: 0, y: 2, w: HEADER_BAR, h: 5, color: HEADER_BAR_COLOR },
          { type: 'line', x1: HEADER_BAR, y1: 2.25, x2: CONTENT_WIDTH, y2: 2.25, lineWidth: 0.5, lineColor: HEADER_BAR_COLOR },
        ],
      },
    ],
  }
}

export function assessmentDocument(input: AssessmentPdfInput): TDocumentDefinitions {
  const a = input.assessment
  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [PAGE_MARGIN, 74, PAGE_MARGIN, 36],
    defaultStyle: { font: PDF_FONT, fontSize: TABLE_FONT_SIZE },
    header: (): Content => header(input),
    footer: (page: number, pages: number): Content => ({ text: `${page} / ${pages}`, alignment: 'center', margin: [0, 10, 0, 0] }),
    // pdfmake 0.3 passes the node and a helper object; @types/pdfmake still describes the older argument list.
    pageBreakBefore: keepSectionsWithFirstPoint as unknown as TDocumentDefinitions['pageBreakBefore'],
    content: [
      controlPointTable(a),
      {
        // The 整體結論 may run onto the next page; the 簽核欄 rows (廠區端, 稽核室覆核) move together, never split.
        stack: [conclusionBox(a), { stack: signatureSection(a, input.signoffs, input.timeZone, input.withSignedAt), unbreakable: true }],
        pageBreak: 'before',
      },
      ...(input.withSignedAt ? [{ stack: historyPage(input.signoffs, a.assessment_step, input.timeZone), pageBreak: 'before' as const }] : []),
    ],
  }
}

/**
 * The last step on a finished PDF: a digital signature on the file. 🔴 OPEN-1 is still open: the interim 方案A has
 * none (the sign-offs are system records printed on it), so `noDigitalSignature` returns the PDF as it is. 方案B
 * would send it to a server that signs it with the organization's certificate; 方案C would also need per-sign-off
 * signatures in the records (Q85(2)).
 */
export type DigitalSignature = (pdf: Uint8Array) => Promise<Uint8Array>

export const noDigitalSignature: DigitalSignature = async (pdf) => pdf

/** The PDF of one 自評表, as it stands in `input` (mid-route exports show only the 關卡 signed so far). */
export async function renderAssessmentPdf(
  input: AssessmentPdfInput,
  engine: PdfEngine,
  applyDigitalSignature: DigitalSignature = noDigitalSignature,
): Promise<Uint8Array> {
  return applyDigitalSignature(new Uint8Array(await engine.createPdf(assessmentDocument(input)).getBuffer()))
}
