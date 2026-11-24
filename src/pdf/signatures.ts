// The last page of the PDF: 整體結論 and the two 簽核欄 rows (廠區端, 稽核室覆核), shaped like the paper.
import type { Content, TableCell } from 'pdfmake/interfaces'
import type { AssessmentStep, StepGroup } from '../api/assessments'
import type { Signoff } from '../api/signoffModel'
import { completingSignoffs, nameInBranch } from '../domain/signoff'
import type { PdfAssessment } from './assessmentPdf'
import { checkbox } from './columns'
import { byPosition, CONTENT_WIDTH, formatSignedAt, THIN_RULES } from './print'

// The paper titles only the 稽核室覆核 row; the 廠區端 row is headed by its 關卡 names alone.
const GRID_TITLE: Record<StepGroup, string | null> = { plant: null, audit_review: '稽核室覆核' }

/** The paper's 簽核欄 has room for six cells a row; a longer route narrows them all alike. */
const MIN_CELLS_PER_ROW = 6

/** Each 簽核欄 cell is this tall, as on paper. */
export const SIGNED_CELL_HEIGHT = 40
/** A signed cell's three lines (name, time, 簽核記錄編號; 方案A) in small print. */
export const SIGNED_CELL_FONT_SIZE = 8
/** The name alone (Q109) prints larger: a three-character name stays on one line up to 17 cells a row. */
export const NAME_ONLY_FONT_SIZE = 12

/** 自評單位 in the order the paper lists them: first appearance among the control points. */
function unitsInPaperOrder(a: PdfAssessment): string[] {
  const units = new Set<string>()
  for (const section of byPosition(a.assessment_section)) {
    for (const p of byPosition(section.assessment_control_point)) {
      for (const u of byPosition(p.assessment_control_point_unit)) units.add(u.assessing_unit_name)
    }
  }
  for (const c of a.assessment_conclusion) units.add(c.assessing_unit_name)
  return [...units]
}

const tick = (ticked: boolean) => ({ ...(checkbox(ticked, 14) as object), width: 14 }) as Content

export function conclusionBox(a: PdfAssessment): Content {
  const byUnit = new Map(a.assessment_conclusion.map((c) => [c.assessing_unit_name, c]))
  const units = unitsInPaperOrder(a)
  const line = (ticked: boolean, label: string, extra?: string): Content => ({
    // A unit name lines up the 【說明】 column like the paper; a whole sentence (要素類) takes what it needs.
    columns: [
      tick(ticked),
      { text: label, width: extra === undefined ? 'auto' : 90 },
      ...(extra === undefined ? [] : [{ text: `【說明】：${extra}`, width: '*' as const }]),
    ],
    margin: [36, 2, 0, 2],
  })
  // 要素類 is answered by one 自評單位 for the whole 自評表 and the paper has no unit names there (A~控制環境).
  const oneConclusion = a.template_layout === 'element' && units.length <= 1
  const theConclusion = units[0] === undefined ? undefined : byUnit.get(units[0])
  const body: Content[] = oneConclusion
    ? [
        line(theConclusion?.conclusion === 'satisfied', '尚屬滿意'),
        line(theConclusion?.conclusion === 'satisfied_except', '除下列事項外，尚屬滿意'),
        {
          text: `說明：${theConclusion?.conclusion === 'satisfied_except' ? (theConclusion.exceptions ?? '') : ''}`,
          margin: [50, 2, 0, 2],
        },
      ]
    : [
        { text: '※ 尚屬滿意', margin: [12, 4, 0, 2] },
        ...units.map((u) => line(byUnit.get(u)?.conclusion === 'satisfied', u)),
        { text: '※ 除下列事項外，尚屬滿意', margin: [12, 4, 0, 2] },
        ...units.map((u) => {
          const c = byUnit.get(u)
          return line(c?.conclusion === 'satisfied_except', u, c?.conclusion === 'satisfied_except' ? (c.exceptions ?? '') : '')
        }),
      ]
  return {
    table: { widths: ['*'], body: [[{ stack: [{ text: '整體結論／需採行之改善措施', fontSize: 10 }, ...body], margin: [4, 4, 4, 8] }]] },
    // It starts a page and can run onto the next: a long 說明 must not be cut off at the page end.
    layout: { hLineWidth: () => 0.8, vLineWidth: () => 0.8 },
  }
}

/**
 * What one signed cell prints: the name as the paper's signature would show it (工號 only when the record kept no
 * name; the 簽核歷程 page gives both), then the time and the 簽核記錄編號 (方案A, Q88 (1)) in small print; or,
 * when the export leaves the times out (Q109), the name alone, larger and centred in the cell like a signature.
 */
function signedCell(s: Signoff | undefined, timeZone: string, withSignedAt: boolean): TableCell {
  if (!s) return { text: '' }
  const name = s.signer_name ?? s.signer_emp_id
  if (!withSignedAt) return { text: name, alignment: 'center', verticalAlignment: 'middle', fontSize: NAME_ONLY_FONT_SIZE }
  return {
    stack: [{ text: name }, { text: formatSignedAt(s.signed_at, timeZone) }, { text: `No. ${s.serial_no}` }],
    alignment: 'center',
    fontSize: SIGNED_CELL_FONT_SIZE,
  }
}

/**
 * One 簽核欄 row for a group of 關卡. The paper lists them right to left (the first 關卡 signs in the rightmost
 * cell) and heads each by its name: a 分流's 關卡 by a header shared by adjacent cells (部門主管, nameInBranch) over its
 * 自評單位 (資材單位, from the 分流, #99); a 關卡 after the 匯流 (廠區經理人) spans both header rows. 加簽 (#13) just adds a cell.
 */
function signatureGrid(steps: AssessmentStep[], group: StepGroup, signed: Map<string, Signoff>, timeZone: string, withSignedAt: boolean, width: number): Content | null {
  const cells = steps
    .filter((s) => s.step_group === group)
    .sort((x, y) => y.position - x.position)
    .map((step) => ({ step, top: nameInBranch(step), bottom: step.branch_unit_name }))
  if (cells.length === 0) return null
  const header = { fillColor: '#eeeeee', alignment: 'center' as const, verticalAlignment: 'middle' as const }
  const body: TableCell[][] = []
  const title = GRID_TITLE[group]
  if (title) body.push([{ text: title, colSpan: cells.length, ...header }, ...cells.slice(1).map(() => ({ text: '' }))])
  const twoRows = cells.some((c) => c.bottom !== null)
  const top: TableCell[] = []
  const bottom: TableCell[] = []
  cells.forEach((c, i) => {
    if (c.bottom === null) {
      // pdfmake misplaces a vertically centered cell that spans rows, so this one stays top-aligned.
      top.push({ text: c.top, rowSpan: twoRows ? 2 : 1, ...header, verticalAlignment: 'top' })
      bottom.push({ text: '' })
      return
    }
    const prev = cells[i - 1]
    if (prev && prev.bottom !== null && prev.top === c.top) top.push({ text: '' })
    else {
      let span = 1
      while (cells[i + span]?.bottom !== null && cells[i + span]?.top === c.top) span++
      top.push({ text: c.top, colSpan: span, ...header })
    }
    bottom.push({ text: c.bottom, ...header })
  })
  body.push(top)
  if (twoRows) body.push(bottom)
  body.push(cells.map((c) => signedCell(signed.get(c.step.id), timeZone, withSignedAt)))
  return {
    table: { widths: cells.map(() => width), heights: (row) => (row === body.length - 1 ? SIGNED_CELL_HEIGHT : 'auto'), body },
    layout: THIN_RULES,
    unbreakable: true,
    margin: [0, 10, 0, 0],
  }
}

export function signatureSection(a: PdfAssessment, signoffs: Signoff[], timeZone: string, withSignedAt: boolean): Content[] {
  const signed = completingSignoffs(signoffs)
  const groups: StepGroup[] = ['plant', 'audit_review']
  const cellsPerRow = Math.max(MIN_CELLS_PER_ROW, ...groups.map((g) => a.assessment_step.filter((s) => s.step_group === g).length))
  const width = CONTENT_WIDTH / cellsPerRow - 8 // pdfmake adds 4pt padding each side
  return groups.flatMap((g) => signatureGrid(a.assessment_step, g, signed, timeZone, withSignedAt, width) ?? [])
}
