// 呈現用純函式 for 簽核流程 (#11). The rules themselves live in the database (launch_check, Q86);
// these only turn its answers into words for the 流程編輯器.
import type { TFunction } from 'i18next'
import type { PickerRow } from '../../exchange/core'
import type { BranchUnit, LaunchCheck, RouteLink, RouteStepRow, RouteSummary } from '../api/approvalRoutes'
import { stepLabel } from './signoff'
import { writeErrorMessage } from './templates'
import { compareTemplateCode } from './tracking'

/** What stops a route from passing the 發起檢查, one sentence per problem; empty when it passes. */
export function launchProblems(t: TFunction, check: Omit<LaunchCheck, 'ready'>): string[] {
  const names = (units: { name: string }[]) => units.map((u) => u.name).join('、')
  const problems: string[] = []
  if (check.no_steps) problems.push(t('flows:problems.noSteps'))
  if (check.missing_units.length) problems.push(t('flows:problems.missingUnits', { units: names(check.missing_units) }))
  if (check.branch_first_step_not_editable.length) problems.push(t('flows:problems.branchFirstStep', { units: names(check.branch_first_step_not_editable) }))
  if (check.unused_units.length) problems.push(t('flows:problems.unusedUnits', { units: names(check.unused_units) }))
  if (check.no_merge_steps) problems.push(t('flows:problems.noMergeSteps'))
  if (check.audit_chief_not_last) problems.push(t('flows:problems.auditChiefNotLast'))
  if (check.pending_unit_points) problems.push(t('flows:problems.pendingUnits', { count: check.pending_unit_points }))
  if (check.missing_links.length) problems.push(t('flows:problems.missingLinks', { steps: check.missing_links.map((l) => t(`flows:links.${l}.name`)).join('、') }))
  if (check.unassigned_steps.length) {
    problems.push(t('flows:problems.unassignedSteps', { steps: check.unassigned_steps.map(stepLabel).join('、') }))
  }
  return problems
}

/**
 * The 簽核人 column of a step with a 連動標記: whose 簽核人 it follows while 權限管理 sets it (#187, #189), or why it does not
 * right now and is chosen here instead (#190, #187 decision 1).
 */
export function linkedSignerText(t: TFunction, link: RouteLink, linkedNow: boolean): string {
  return t(linkedNow ? `flows:links.${link}.signer` : `flows:links.${link}.unlinked`)
}

/** One 分流 card: the unit and its steps in order. */
export interface Branch {
  unit: BranchUnit
  steps: RouteStepRow[]
}

/**
 * The 流程編輯器's two parts (Q116): a 分流 per unit in the order the database lists them (the template's
 * units in paper order first), and the 匯流後 steps. Which 分流 a step is in is its `branch_unit_id`.
 */
export function routeLayout(units: readonly BranchUnit[], steps: readonly RouteStepRow[]): { branches: Branch[]; merged: RouteStepRow[] } {
  const sorted = [...steps].sort((a, b) => a.position - b.position)
  return {
    branches: units.map((unit) => ({ unit, steps: sorted.filter((s) => s.branch_unit_id === unit.id) })),
    merged: sorted.filter((s) => !s.branch_unit_id),
  }
}

/** What a 分流 card shows: a unit the template no longer uses (to delete); a unit with no steps yet (to set up); or its steps. */
export function branchState(branch: Branch): 'unused' | 'missing' | 'set' {
  if (!branch.unit.in_template) return 'unused'
  return branch.steps.length ? 'set' : 'missing'
}

/** The units the 匯流 waits for: every one the template uses. */
export function mergeWaitsFor(branches: readonly Branch[]): string[] {
  return branches.filter((b) => b.unit.in_template).map((b) => b.unit.name)
}

/**
 * Where an added 關卡 can go in a 分流: after any step but the last, so the 分流 stays 自行檢查人員 first and
 * 部門主管 last (Q116 (2)). A 分流 with only its 自行檢查人員 gets the step after it. `before` is the route position
 * to insert before, null＝at the end of the route.
 */
export function branchInsertOptions(branch: readonly RouteStepRow[], stepCount: number): { after: RouteStepRow; before: number | null }[] {
  const afters = branch.length > 1 ? branch.slice(0, -1) : branch
  return afters.map((step, i) => {
    const before = branch[i + 1]?.position ?? step.position + 1
    return { after: step, before: before > stepCount ? null : before }
  })
}

/** Only an added step can be deleted: the 自行檢查人員 (first) and the 部門主管 (last) stay. */
export function canDeleteBranchStep(branch: readonly RouteStepRow[], step: RouteStepRow): boolean {
  const i = branch.indexOf(step)
  return i > 0 && i < branch.length - 1
}

/** The whole route's order after the 匯流後 steps were dragged into `mergedIds`: the 分流 steps keep theirs, first. */
export function reorderMerged(steps: readonly RouteStepRow[], mergedIds: readonly string[]): string[] {
  const branchSteps = [...steps].filter((s) => s.branch_unit_id).sort((a, b) => a.position - b.position)
  return [...branchSteps.map((s) => s.id), ...mergedIds]
}

/** What to tell the 稽核管理者 when a 流程編輯器 write fails. */
export function routeWriteError(t: TFunction, error: unknown): string {
  const hint = typeof error === 'object' && error && 'hint' in error ? String(error.hint) : ''
  if (hint === 'plant_not_applicable') return t('flows:errors.plantNotApplicable')
  if (hint === 'branch_exists') return t('flows:errors.branchExists')
  if (hint === 'link_exists') return t('flows:errors.linkExists')
  if (hint === 'step_linked') return t('flows:errors.stepLinked')
  if (hint === 'signer_not_listed') return t('flows:errors.notListed')
  return writeErrorMessage(t, error, {
    '23514': 'flows:errors.stepRule',
    '23505': 'flows:errors.duplicateRoute',
    '42501': 'flows:errors.forbidden',
    // The route (or step) is gone, e.g. deleted in another window: the page is out of date.
    P0002: 'common:templates.errors.stale',
  })
}

/** A 簽核人 as the 流程編輯器 shows them: 姓名（工號，廠區）; without the 廠區 when CSA does not know it. */
export function signerLabel(row: Pick<PickerRow, 'emp_id' | 'name'> & { factory_code: string | null }): string {
  return `${row.name}（${[row.emp_id, row.factory_code].filter(Boolean).join('，')}）`
}

/** The list: by 範本 in paper order (01.1 before 02, 10.1 after 09), then 廠區 (one route each, Q137 (6)). */
export function sortRoutes(routes: readonly RouteSummary[]): RouteSummary[] {
  return [...routes].sort(
    (a, b) =>
      compareTemplateCode(a.template.code, b.template.code) ||
      a.plant.factory_code.localeCompare(b.plant.factory_code),
  )
}

/** 選中廠區要列的流程 (#85): a route belongs to exactly one 廠區. */
export function routesOfPlant<T extends Pick<RouteSummary, 'plant'>>(routes: readonly T[], plant: string): T[] {
  return routes.filter((route) => route.plant.factory_code === plant)
}

/** The 簽核流程 of a 範本 × 廠區 (#174), which has at most one (Q137 (6)); the template page links to it. undefined when none. */
export function routeFor(routes: readonly RouteSummary[], templateId: string, plantId: string): RouteSummary | undefined {
  return routes.find((r) => r.template.id === templateId && r.plant.id === plantId)
}
