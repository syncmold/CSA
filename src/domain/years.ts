// 年度選單 (#175): 年度發起 chooses the year to launch, the next one, or a launched one to top up. 範本管理 and 簽核流程
// have no 年度 (Q137 (2)): they are always the templates and routes themselves, used by the next launch and top-up.
// Whether a year was launched is all there is to it: nothing stores a 使用年度 and nothing is copied (Q128 (3)).

/** One choice of the 年度 menu. */
export interface YearOption {
  year: number
  /** Launched already: 年度發起 tops it up. Otherwise it is the next year to launch. */
  launched: boolean
}

/**
 * The year the next launch is for: the newest launched year + 1, or this year when none was ever launched. It only
 * decides what the page shows and offers; whether a launch is accepted is the database's (ADR-0001).
 */
export function nextLaunchYear(launched: readonly number[], currentYear: number): number {
  return launched.length ? Math.max(...launched) + 1 : currentYear
}

/** The next year to launch first, then every launched year, newest first. */
export function yearOptions(launched: readonly number[], currentYear: number): YearOption[] {
  const next = nextLaunchYear(launched, currentYear)
  return [{ year: next, launched: false }, ...[...launched].sort((a, b) => b - a).map((year) => ({ year, launched: true }))]
}

/**
 * The year shown: the one in the URL, else the one this tab chose last, else the next year to launch; a year that is
 * not among the options (a mistyped URL, a year that was never launched) falls through to the next.
 */
export function pickYear(options: readonly YearOption[], requested: string | null, remembered: string | null): number | null {
  if (options.length === 0) return null
  const known = (value: string | null) => options.find((o) => String(o.year) === value)?.year
  return known(requested) ?? known(remembered) ?? options[0]!.year
}
