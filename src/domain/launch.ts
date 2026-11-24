// 呈現用純函式 for 年度發起 (#12；廠區篩選與補發 #115、Q119). Whether a combination can be launched, and in which
// years it already was, comes from the database (`launch_candidates`, Q89); these only keep track of what is shown and
// checked and put the answers into words.
import type { TFunction } from 'i18next'
import type { Combo, DepartedSigner, LaunchCandidate, LaunchResult } from '../api/launch'
import { assignmentPath } from './assignment'
import { stepLabel } from './signoff'

/** Whether this 範本 × 廠區 has already been launched in `year` (once a year, Q119). */
export function isLaunched(c: Pick<LaunchCandidate, 'launched_years'>, year: number | null): boolean {
  return year !== null && c.launched_years.includes(year)
}

/** Whether every combination has been launched in `year`: nothing is left to top up. */
export function isYearFull(candidates: readonly LaunchCandidate[], year: number | null): boolean {
  return candidates.length > 0 && candidates.every((c) => isLaunched(c, year))
}

/** Identifies a 範本 × 廠區 in the page's unchecked set. */
export function candidateKey(c: Pick<LaunchCandidate, 'template_id' | 'plant_id'>): string {
  return `${c.template_id}|${c.plant_id}`
}

export interface PlantOption {
  plant_id: string
  factory_code: string
  plant_name: string
}

/** 「FQ 福清富群」: how the page names a 廠區. */
export function plantLabel(p: Pick<PlantOption, 'factory_code' | 'plant_name'>): string {
  return `${p.factory_code} ${p.plant_name}`
}

/**
 * The 廠區 that have combinations, for the 廠區 filter: in `order` (the 廠區主檔's ids as `fetchPlants` lists them, SyncHub's
 * order like every other page's 廠區 list), 廠區 it does not list after them by 廠區代碼.
 */
export function plantOptions(candidates: readonly LaunchCandidate[], order: readonly string[] = []): PlantOption[] {
  const plants = new Map(candidates.map((c) => [c.plant_id, { plant_id: c.plant_id, factory_code: c.factory_code, plant_name: c.plant_name }]))
  const rank = new Map(order.map((id, i) => [id, i]))
  const at = (p: PlantOption) => rank.get(p.plant_id) ?? order.length
  return [...plants.values()].sort((a, b) => at(a) - at(b) || a.factory_code.localeCompare(b.factory_code))
}

/**
 * The combinations in the 廠區 filter's order (`order` as in plantOptions), each 廠區's in the order they came (the
 * database lists them by 範本編號), so the table reads like the 廠區 menu.
 */
export function byPlantOrder<T extends Pick<LaunchCandidate, 'plant_id' | 'factory_code'>>(candidates: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  const at = (c: T) => rank.get(c.plant_id) ?? order.length
  return candidates.map((c, i) => ({ c, i }))
    .sort((a, b) => at(a.c) - at(b.c) || (at(a.c) === order.length ? a.c.factory_code.localeCompare(b.c.factory_code) : 0) || a.i - b.i)
    .map(({ c }) => c)
}

/**
 * Why a combination cannot be launched, as the page shows it: the database's `problem`, except that a route whose only
 * fault is 關卡 nobody is 分派 to yet reads `unassigned` (Q147), fixed on 分派填寫人 rather than in the 流程編輯器.
 */
export type CandidateProblem = 'no_route' | 'not_ready' | 'unassigned' | 'no_coordinator'

export function candidateProblem(c: Pick<LaunchCandidate, 'problem' | 'launch_check'>): CandidateProblem | null {
  const check = c.launch_check
  if (c.problem !== 'not_ready' || !check || !check.unassigned_steps.length) return c.problem
  const otherFaults =
    check.no_steps || check.no_merge_steps || check.audit_chief_not_last || check.pending_unit_points > 0 ||
    [check.missing_units, check.unused_units, check.branch_first_step_not_editable, check.missing_links].some((list) => list.length > 0)
  return otherFaults ? 'not_ready' : 'unassigned'
}

/** Where a combination stands in a year, as the 狀態 filter sorts them (#125). */
export type LaunchStatus = 'ready' | 'problem' | 'launched'
/** The 狀態 filter's choices, in the order it lists them. */
export const STATUS_FILTERS = ['all', 'ready', 'problem', 'launched'] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]

/** Launched in `year` already; else whether its route can be launched (可發起) or not (流程有問題). */
export function launchStatus(c: Pick<LaunchCandidate, 'launched_years' | 'problem'>, year: number | null): LaunchStatus {
  if (isLaunched(c, year)) return 'launched'
  return c.problem === null ? 'ready' : 'problem'
}

export interface LaunchSelection {
  /** The rows shown: the chosen 廠區' combinations (all of them when none is chosen) in the chosen 狀態. */
  visible: LaunchCandidate[]
  /** Shown and not yet launched this year: what the check boxes, 全選 and the counts are about. */
  selectable: LaunchCandidate[]
  /** Selectable and not unchecked: what 發起 sends. Filtered-out combinations are never sent. */
  picked: LaunchCandidate[]
  /** Picked combinations whose route cannot be launched: while there are any, the launch is refused. */
  blocked: LaunchCandidate[]
  /** How many of the chosen 廠區' combinations each 狀態 has, for the 狀態 filter's choices. */
  counts: Record<StatusFilter, number>
}

/**
 * What the screen shows and what 發起 would send. The page keeps the combinations the 稽核管理者 unchecked rather
 * than the checked ones, so a combination that appears later (a 範本 turned 啟用 or a route fixed meanwhile) starts out checked.
 */
export function launchSelection(
  candidates: readonly LaunchCandidate[],
  {
    plants,
    status = 'all',
    unchecked,
    year,
  }: { plants: readonly string[]; status?: StatusFilter; unchecked: ReadonlySet<string>; year: number | null },
): LaunchSelection {
  const inPlants = plants.length ? candidates.filter((c) => plants.includes(c.plant_id)) : [...candidates]
  const counts: Record<StatusFilter, number> = { all: inPlants.length, ready: 0, problem: 0, launched: 0 }
  for (const c of inPlants) counts[launchStatus(c, year)] += 1
  const visible = status === 'all' ? inPlants : inPlants.filter((c) => launchStatus(c, year) === status)
  const selectable = visible.filter((c) => !isLaunched(c, year))
  const picked = selectable.filter((c) => !unchecked.has(candidateKey(c)))
  return { visible, selectable, picked, blocked: picked.filter((c) => c.problem !== null), counts }
}

/**
 * The unchecked set after the table reports `checkedKeys` as checked among `selectable`. Rows that are filtered out or
 * already launched keep what they had.
 */
export function uncheckAfter(unchecked: ReadonlySet<string>, selectable: readonly LaunchCandidate[], checkedKeys: readonly unknown[]): Set<string> {
  const next = new Set(unchecked)
  for (const key of selectable.map(candidateKey)) {
    if (checkedKeys.includes(key)) next.delete(key)
    else next.add(key)
  }
  return next
}

/** What `launch_annual_cycle` takes for the picked combinations. */
export function toCombos(picked: readonly LaunchCandidate[]): Combo[] {
  return picked.map((c) => ({ template_id: c.template_id, plant_id: c.plant_id }))
}

/** The filters in words: the chosen 廠區 (「全部廠區」 when none is chosen), then the chosen 狀態 unless it is 全部. */
export function filterScope(
  t: TFunction,
  candidates: readonly LaunchCandidate[],
  plants: readonly string[],
  status: StatusFilter = 'all',
  order: readonly string[] = [],
): string {
  const scope = plants.length
    ? plantOptions(candidates, order).filter((p) => plants.includes(p.plant_id)).map(plantLabel).join(t('launch:listSeparator'))
    : t('launch:allPlants')
  return status === 'all' ? scope : t('launch:scopeStatus', { scope, status: t(`launch:status.${status}`) })
}

/** 「FQ 福清富群 3 張、GT 敬得(觀音) 1 張」: which 廠區 this launch issues to and how many to each, in the 廠區 filter's order. */
export function launchScope(t: TFunction, picked: readonly LaunchCandidate[], order: readonly string[] = []): string {
  const counts = new Map<string, { plant: PlantOption; count: number }>()
  for (const p of plantOptions(picked, order)) counts.set(p.plant_id, { plant: p, count: 0 })
  for (const c of picked) counts.get(c.plant_id)!.count += 1
  return [...counts.values()]
    .map(({ plant, count }) => t('launch:scopeItem', { plant: plantLabel(plant), count }))
    .join(t('launch:listSeparator'))
}

const comboLabel = (c: LaunchCandidate) => `${c.template_code} ${c.template_name} × ${plantLabel(c)}`

/**
 * 「FQ-02 × FQ 福清富群 財務部・部門主管：許文彬（FQ1021）」: who on which route has left (Q147 (4)); the page puts where to
 * replace them after it (departedFix).
 */
export function departedLabel(t: TFunction, d: DepartedSigner): string {
  return t(d.link ? 'launch:departedLinkedItem' : 'launch:departedItem', {
    template: d.template_code,
    plant: plantLabel(d),
    step: stepLabel({ name: d.step, branch_unit_name: d.branch_unit_name }),
    person: d.name ? `${d.name}（${d.emp_id}）` : d.emp_id,
  })
}

/**
 * Where to replace someone who has left (Q147 (4)): a 連動關卡 follows 權限管理; any other is 分派 on the plant's route,
 * on 分派填寫人's 下次發出.
 */
export function departedFix(d: Pick<DepartedSigner, 'link' | 'factory_code'>): { to: string; label: 'toAccessReplace' | 'toAssignReplace' } {
  return d.link ? { to: '/admin/access', label: 'toAccessReplace' } : { to: assignmentPath(d.factory_code, 'next'), label: 'toAssignReplace' }
}

/**
 * What to tell the 稽核管理者 when `launch_annual_cycle` refuses (nothing was created). For `departed_signers` this is
 * the heading: the page lists who under it, each with where to replace them.
 */
export function launchRefusal(t: TFunction, year: number, result: Exclude<LaunchResult, { ok: true }>): string {
  switch (result.error) {
    case 'already_launched':
      // Someone else launched them since the page loaded; the list has been refreshed.
      return t('launch:refused.alreadyLaunched', { year, combos: result.launched.map(comboLabel).join(t('launch:listSeparator')) })
    case 'no_combos':
      return t('launch:refused.noCombos')
    case 'invalid_combo':
      // The page only sends combinations it was shown, so the list changed since it loaded.
      return t('launch:refused.stale')
    case 'missing_route':
      return t('launch:refused.missingRoute', { combos: result.missing.map(comboLabel).join(t('launch:listSeparator')) })
    case 'departed_signers':
      return t('launch:refused.departedSigners', { count: result.departed.length })
  }
}
