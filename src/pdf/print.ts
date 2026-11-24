// Page geometry and small print helpers shared by every part of the PDF.
import type { TableLayout } from 'pdfmake/interfaces'

export const PAGE_MARGIN = 28
/** The paper's Word files set the whole questionnaire table, headers included, in 10pt (新細明體). */
export const TABLE_FONT_SIZE = 10
/** …and the 版頭 (company and title) in 12pt. */
export const HEADER_FONT_SIZE = 12
/** Width between the side margins of an A4 landscape page (842pt wide), which every full-width table spans. */
export const CONTENT_WIDTH = 842 - 2 * PAGE_MARGIN

/** The paper's thin table rules, in points. */
export const RULE_WIDTH = 0.5
export const THIN_RULES: TableLayout = { hLineWidth: () => RULE_WIDTH, vLineWidth: () => RULE_WIDTH }

/**
 * The control-point table's cells: narrow at the sides so a 10pt control point fits on as few lines as on paper, and
 * 3pt above and below the font's own line height, so the text never touches the rules (a tighter line height clipped
 * the headers and crowded the rows, 2026-10-19 使用者驗收).
 */
export const POINT_CELL_PADDING = { left: 3, right: 3, top: 3, bottom: 3 }
export const POINT_TABLE_RULES: TableLayout = {
  ...THIN_RULES,
  paddingLeft: () => POINT_CELL_PADDING.left,
  paddingRight: () => POINT_CELL_PADDING.right,
  paddingTop: () => POINT_CELL_PADDING.top,
  paddingBottom: () => POINT_CELL_PADDING.bottom,
}

/** One line of 10pt Noto Sans TC (the embedded font, engine.ts) as pdfmake lays it out: the font's ascent plus descent. */
export const TABLE_LINE_HEIGHT = 14.48

/**
 * How many lines pdfmake will need for `text` in a column `width` points wide at the table's font size. Chinese and
 * full-width characters are one em and break anywhere; a run of Latin letters or digits is a word that does not break
 * (unless it alone is wider than the column) and is counted at 0.6 em a character, a little more than Noto Sans TC's
 * actual widths, so the estimate errs towards one line too many rather than too few. A line break in the text (a
 * control point's note or list, Q126) starts a new line.
 */
export function estimateLines(text: string, width: number): number {
  return text.split('\n').reduce((lines, line) => lines + linesOf(line, width), 0)
}

function linesOf(text: string, width: number): number {
  const em = TABLE_FONT_SIZE
  const charWidth = (c: string) => (/[⺀-鿿豈-﫿＀-￯　-〿]/.test(c) ? em : 0.6 * em)
  let lines = 1
  let used = 0
  for (const token of text.match(/[A-Za-z0-9]+|[\s\S]/g) ?? []) {
    const tokenWidth = [...token].reduce((w, c) => w + charWidth(c), 0)
    if (used + tokenWidth <= width) {
      used += tokenWidth
      continue
    }
    if (tokenWidth <= width) {
      lines++
      used = tokenWidth
      continue
    }
    // A word wider than the column breaks by character.
    for (const c of token) {
      if (used + charWidth(c) > width) {
        lines++
        used = 0
      }
      used += charWidth(c)
    }
  }
  return lines
}

/**
 * Splits free text someone typed into pieces that each fit one table row on one page in a column `width` points
 * wide. The control-point table keeps every row on one page (paper: 長題目換行不拆列), and pdfmake drops whatever
 * of such a row does not fit, so a longer text goes on in continuation rows instead. Counts every character as a
 * full-width one at the table's font size, so a piece never runs longer than estimated.
 */
export function splitForRows(text: string, width: number, linesPerRow = 26): string[] {
  const perLine = Math.max(1, Math.floor(width / TABLE_FONT_SIZE))
  const pieces: string[] = []
  let piece = ''
  let lines = 0
  for (const paragraph of text.split('\n')) {
    const rest = [...paragraph]
    let started = false
    while (!started || rest.length > 0) {
      if (lines >= linesPerRow) {
        pieces.push(piece)
        piece = ''
        lines = 0
      }
      const take = rest.splice(0, (linesPerRow - lines) * perLine)
      piece += (lines > 0 ? '\n' : '') + take.join('')
      lines += Math.max(1, Math.ceil(take.length / perLine))
      started = true
    }
  }
  pieces.push(piece)
  return pieces
}

export const byPosition = <T extends { position: number }>(rows: T[]) => [...rows].sort((x, y) => x.position - y.position)

/** "2026-10-16 09:01" in `timeZone`. */
export function formatSignedAt(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}
