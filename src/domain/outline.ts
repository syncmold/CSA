// 章節分層與題號 (#166, Q125): how 範本管理, the answer sheet and the PDF lay sections out and number them. The
// sections stay one flat list in paper order; their 層級 only decides where a card starts and which rows are 分段列.

/** A section as the outline needs it, in paper order. */
export interface OutlineSection {
  /** 1 starts a card; 2 and 3 are 分段列 inside it. */
  level: number
  /** 原檔的章節題號 (「1」「1.1」); null when the paper has none. */
  code: string | null
  name: string
}

export interface OutlinePart<S> {
  section: S
  /**
   * The level the section is shown at: its own, except that it never goes more than one deeper than the section before
   * it and the first section is always 1 (a hand-edited template may jump; the paper never does).
   */
  level: number
}

/** One card: its 第一層 section, then the 分段列 under it, in paper order. */
export interface OutlineCard<S> {
  /** The system's number for a card whose section has no 題號: 1, 2, … in order. */
  number: number
  parts: OutlinePart<S>[]
}

/** The deepest 層級 a section may take after one at `previous` (0 at the very start): one deeper, at most 3. */
export function deepestLevelAfter(previous: number): number {
  return Math.min(previous + 1, 3)
}

export function outline<S extends OutlineSection>(sections: readonly S[]): OutlineCard<S>[] {
  const cards: OutlineCard<S>[] = []
  let previous = 0
  for (const section of sections) {
    const level = Math.max(1, Math.min(section.level, deepestLevelAfter(previous)))
    if (level === 1) cards.push({ number: cards.length + 1, parts: [] })
    cards.at(-1)!.parts.push({ section, level })
    previous = level
  }
  return cards
}

/** Whether the part at `index` heads 分段 after it (the next part is deeper): it cannot go without them. */
export function headsSubsections(card: OutlineCard<unknown>, index: number): boolean {
  return (card.parts[index + 1]?.level ?? 0) > card.parts[index]!.level
}

/**
 * A section dragged in 範本管理 (`reordered` is the list with only it moved, as useDragReorder gives it) takes its 分段
 * along: the sections after it that are deeper, up to the next one that is not. Dropped onto a later section it goes
 * after that section's own 分段, onto an earlier one before it; dropped into its own 分段 nothing moves.
 */
export function moveWithSubsections(sections: readonly { id: string; level: number }[], reordered: readonly string[]): string[] {
  const ids = sections.map((s) => s.id)
  const without = (list: readonly string[], id: string) => list.filter((x) => x !== id).join()
  const moved = ids.find((id) => ids.indexOf(id) !== reordered.indexOf(id) && without(ids, id) === without(reordered, id))
  if (!moved) return [...reordered]
  const from = ids.indexOf(moved)
  const target = ids[reordered.indexOf(moved)]!
  const blockEnd = (start: number, list: readonly { id: string; level: number }[]) => {
    let end = start + 1
    while (end < list.length && list[end]!.level > list[start]!.level) end++
    return end
  }
  const block = sections.slice(from, blockEnd(from, sections))
  if (block.some((s) => s.id === target)) return ids
  const rest = sections.filter((s) => !block.includes(s))
  const at = rest.findIndex((s) => s.id === target)
  const insertAt = reordered.indexOf(moved) > from ? blockEnd(at, rest) : at
  return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)].map((s) => s.id)
}

/** The card's heading: 「1 董事會…」 with the paper's 題號, 「1. 供應商管理作業」 numbered by the system as before. */
export function cardTitle(card: OutlineCard<OutlineSection>): string {
  const head = card.parts[0]!.section
  return head.code ? `${head.code} ${head.name}` : `${card.number}. ${head.name}`
}

/** The card number a message or a label names: the paper's 題號 of its 第一層, else the system's number. */
export function cardNumber(card: OutlineCard<OutlineSection>): string {
  return card.parts[0]!.section.code ?? String(card.number)
}

/**
 * The # of each control point in a card, by id: its 原檔題號, else its place in the card counted over all its 分段
 * (1–n). A single-level template has one section per card, so that is the place in the section, as before (Q125).
 */
export function pointNumbers<S, P extends { id: string; code: string | null }>(
  card: OutlineCard<S>,
  pointsOf: (section: S) => readonly P[],
): Map<string, string> {
  const numbers = new Map<string, string>()
  let place = 0
  for (const { section } of card.parts) {
    for (const point of pointsOf(section)) {
      place++
      numbers.set(point.id, point.code ?? String(place))
    }
  }
  return numbers
}

/**
 * The # column's width for a card: `narrow` (the column as it was, room for 1–99) unless a 題號 is longer, then about
 * 8px more a character (「1.1.1-10」), so a single-level template looks as before.
 */
export function numberColumnWidth(labels: Iterable<string | null>, narrow: number): number {
  const longest = Math.max(0, ...[...labels].map((label) => label?.length ?? 0))
  return narrow + Math.max(0, longest - 2) * 8
}

/** A 分段列 among a card's table rows: a 第二／三層 章節 heading the rows below it. */
export interface SubheadingRow<S> {
  key: string
  subheading: OutlinePart<S>
}

export function isSubheading<S, R extends object>(row: R | SubheadingRow<S>): row is SubheadingRow<S> {
  return 'subheading' in row
}

/**
 * A card's table rows: the 第一層's own rows, then each 分段列 followed by its rows. With `hideEmpty` (只看我的題目) a
 * 分段列 with no rows under it, its own or its deeper 分段's, is left out with them.
 */
export function outlineRows<S extends { id: string }, R>(
  card: OutlineCard<S>,
  rowsOf: (section: S) => readonly R[],
  { hideEmpty = false }: { hideEmpty?: boolean } = {},
): (R | SubheadingRow<S>)[] {
  const { parts } = card
  return parts.flatMap((part, i) => {
    const own = rowsOf(part.section)
    if (i === 0) return [...own]
    const under = [part, ...parts.slice(i + 1)]
    const end = under.findIndex((p, k) => k > 0 && p.level <= part.level)
    if (hideEmpty && (end < 0 ? under : under.slice(0, end)).every((p) => rowsOf(p.section).length === 0)) return []
    return [{ key: `subheading:${part.section.id}`, subheading: part }, ...own]
  })
}

/** A section as a read-only page shows it: a template's own, or an issued 自評表's snapshot (#173). */
export interface ShownSection extends OutlineSection {
  id: string
  points: ShownPoint[]
}

export interface ShownPoint {
  id: string
  /** 原檔題號; null: numbered by the page within its card. */
  code: string | null
  text: string
  /** 反向題目 (Q148). */
  is_reverse: boolean
  /** The 自評單位 in answering order; empty on 要素類 without any. */
  units: string[]
}
