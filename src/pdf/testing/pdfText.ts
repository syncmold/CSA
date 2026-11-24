// Test support for the PDF seam: reads a generated PDF back as text with pdf.js, the way a reader would
// see it, so tests check what is printed rather than how the document definition is built.
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

export interface PdfTextItem {
  str: string
  /** Left edge in PDF points from the page's left side. */
  x: number
  /** Baseline in PDF points from the page's top. */
  y: number
  width: number
}

export interface PdfPage {
  width: number
  height: number
  items: PdfTextItem[]
  /** The page's text, one string per printed line (items within 2pt of the same baseline, left to right). */
  lines: string[]
  /** How many raster images the page draws (the logos). */
  images: number
  /** The text printed in each fill color (#rrggbb), in drawing order, spaces left out. */
  textByColor: Map<string, string>
  /** Every color the page sets for filling shapes and text, and for stroking lines (#rrggbb). */
  fillColors: Set<string>
  strokeColors: Set<string>
  /** The horizontal lines the page strokes (table rules), in PDF points from the page's left side and top. */
  rules: HorizontalRule[]
}

export interface HorizontalRule {
  y: number
  x1: number
  x2: number
}

interface GlyphLike {
  unicode?: string
}

/** Walks the operator list for colors: pdf.js hands every color as #rrggbb, and q/Q save and restore it. */
function colorsOf(ops: { fnArray: number[]; argsArray: unknown[][] }): Pick<PdfPage, 'textByColor' | 'fillColors' | 'strokeColors'> {
  const textByColor = new Map<string, string>()
  const fillColors = new Set<string>()
  const strokeColors = new Set<string>()
  let state = { fill: '#000000', stroke: '#000000' }
  const saved: (typeof state)[] = []
  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i]!
    if (fn === OPS.save) saved.push({ ...state })
    else if (fn === OPS.restore) state = saved.pop() ?? state
    else if (fn === OPS.setFillRGBColor) fillColors.add((state.fill = args[0] as string))
    else if (fn === OPS.setStrokeRGBColor) strokeColors.add((state.stroke = args[0] as string))
    else if (fn === OPS.showText) {
      const str = (args[0] as (GlyphLike | number | null)[]).map((g) => (g && typeof g === 'object' ? (g.unicode ?? '') : '')).join('')
      textByColor.set(state.fill, (textByColor.get(state.fill) ?? '') + str.replace(/\s/g, ''))
    }
  })
  return { textByColor, fillColors, strokeColors }
}

/**
 * The horizontal segments of every stroked path. pdf.js hands a path as [op, [moveTo 0 | lineTo 1 …, x, y …]]; pdfmake
 * draws in a user space already flipped to measure from the page's top (its pages start with `1 0 0 -1 0 h cm`).
 */
function rulesOf(ops: { fnArray: number[]; argsArray: unknown[][] }): HorizontalRule[] {
  const rules: HorizontalRule[] = []
  ops.fnArray.forEach((fn, i) => {
    if (fn !== OPS.constructPath) return
    const [paint, [path]] = ops.argsArray[i] as [number, (ArrayLike<number> | null)[]]
    if (paint !== OPS.stroke || !path) return
    let from: [number, number] | null = null
    for (let k = 0; k < path.length; ) {
      const [op, x, y] = [path[k]!, path[k + 1]!, path[k + 2]!]
      if (op !== 0 && op !== 1) return // curves: not a table rule
      if (op === 1 && from && Math.abs(from[1] - y) < 0.01) rules.push({ y, x1: Math.min(from[0], x), x2: Math.max(from[0], x) })
      from = [x, y]
      k += 3
    }
  })
  return rules
}

export async function readPdf(bytes: Uint8Array): Promise<PdfPage[]> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false })
  const doc = await task.promise
  const pages: PdfPage[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const { width, height } = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items = content.items
      .flatMap((i) => ('str' in i && i.str.trim() !== '' ? [{ str: i.str, x: i.transform[4] as number, y: height - (i.transform[5] as number), width: i.width }] : []))
      .sort((a, b) => a.y - b.y || a.x - b.x)
    const rows: PdfTextItem[][] = []
    for (const item of items) {
      const row = rows.at(-1)
      if (row && Math.abs(row[0]!.y - item.y) <= 2) row.push(item)
      else rows.push([item])
    }
    const lines = rows.map((row) => row.sort((a, b) => a.x - b.x).map((i) => i.str).join(' '))
    const ops = await page.getOperatorList()
    const images = ops.fnArray.filter((fn) => fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject).length
    pages.push({ width, height, items, lines, images, ...colorsOf(ops), rules: rulesOf(ops) })
  }
  await task.destroy()
  return pages
}

/** Every page's lines joined, for "is this printed anywhere" checks. */
export const allText = (pages: PdfPage[]) => pages.flatMap((p) => p.lines).join('\n')

const center = (i: PdfTextItem) => i.x + i.width / 2

/**
 * The column headers above the ✓ marks of one control-point row of the table. Header cells are found as the
 * text of the second header row (between the group headers and the first section row), grouped by horizontal
 * center so a wrapped header such as 有內控／規範 becomes one label; the row runs from its first text to the
 * next row's first text in that column.
 */
export function checkedColumns(page: PdfPage, rowStart: string): string[] {
  const row = page.items.find((i) => i.str.startsWith(rowStart))
  if (!row) throw new Error(`no row starting with ${rowStart}`)
  // The first section row: the text in the control-point column just above the first numbered control point.
  const firstPoint = page.items.find((i) => /^\d+\. /.test(i.str))!
  const firstSection = Math.max(...page.items.filter((i) => Math.abs(i.x - firstPoint.x) < 2 && i.y < firstPoint.y).map((i) => i.y))
  const title = page.items.find((i) => i.str.includes('年度內部控制制度自行評估問卷表'))!.y
  const headerBand = page.items.filter((i) => i.y > title + 4 && i.y < firstSection - 4)
  // Below the first header row, which holds the group headers (內部控制制度設計 …) spanning several columns.
  const groupRow = Math.min(...headerBand.map((i) => i.y))
  const headers: PdfTextItem[][] = []
  for (const item of headerBand.filter((i) => i.y > groupRow + 3)) {
    const column = headers.find((h) => Math.abs(center(h[0]!) - center(item)) < 4)
    if (column) column.push(item)
    else headers.push([item])
  }
  // The next row starts with a numbered control point or section in the control-point column, or with the next
  // 自評單位 of a multi-unit control point (#46) in the 自評單位 column.
  // The row's own 自評單位 is centered vertically, so it can sit below the first line of a long control point.
  const unitHeader = page.items.find((i) => i.str === '自評單位' && i.y < firstSection)
  const inUnitColumn = (i: PdfTextItem) => !!unitHeader && i !== unitHeader && Math.abs(center(i) - center(unitHeader)) < 6
  const ownUnit = Math.min(...page.items.filter((i) => inUnitColumn(i) && i.y > row.y - 8).map((i) => i.y), page.height)
  const startsRow = (i: PdfTextItem) =>
    (i.y > row.y + 2 && Math.abs(i.x - firstPoint.x) < 2 && /^(\d+\. |◆|（)/.test(i.str)) || (inUnitColumn(i) && i.y > ownUnit + 2)
  const nextRow = Math.min(...page.items.filter(startsRow).map((i) => i.y), page.height)
  return page.items
    .filter((i) => i.str === '✓' && i.y > row.y - 8 && i.y < nextRow - 8)
    .sort((a, b) => a.x - b.x)
    .map((check) => {
      const column = headers.reduce((best, h) =>
        Math.abs(center(h[0]!) - center(check)) < Math.abs(center(best[0]!) - center(check)) ? h : best,
      )
      return [...column].sort((a, b) => a.y - b.y).map((i) => i.str).join('')
    })
}
