// 呈現用純函式 for 核准／退回與簽核流程 (#6, 分流 since Q116). Where the 自評表 stands, who may sign and where a 退回
// may go are decided by the database (assessment_step.state, my_current_steps, can_approve, return_assessment;
// ADR-0001); these only shape that for the page: the 分流 diagram, the signer labels and the panel's choices.
import type { AssessmentStep, AssessmentView, MyCurrentStep } from '../api/assessments'
import type { Signoff } from '../api/signoffModel'

/** What these functions need from a 自評表 page. */
export type SignoffSource = Pick<AssessmentView, 'assessment_step' | 'status' | 'signerNames'>

/** "姓名（工號）" when the name is known, otherwise the 工號. */
export function formatSigner(name: string | null | undefined, empId: string): string {
  return name ? `${name}（${empId}）` : empId
}

/**
 * Labels the route's 簽核人. The current name in CSA's own copy (visible_people, #218) comes first;
 * otherwise the latest name a 簽核紀錄 kept, so someone who has signed before is named for everyone who sees it.
 */
export function signerLabeler(a: Pick<SignoffSource, 'signerNames'>, signoffs: Signoff[]): (empId: string) => string {
  const names = knownNames(a, signoffs)
  return (empId) => formatSigner(names.get(empId), empId)
}

function knownNames(a: Pick<SignoffSource, 'signerNames'>, signoffs: Signoff[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const s of signoffs) if (s.signer_name) names.set(s.signer_emp_id, s.signer_name) // later ones win
  for (const [empId, name] of a.signerNames) names.set(empId, name)
  return names
}

/** The 簽核歷程 order: by time, then 簽核記錄編號 for records written in the same instant. */
export function inSignedOrder(signoffs: Signoff[]): Signoff[] {
  return [...signoffs].sort((x, y) => x.signed_at.localeCompare(y.signed_at) || x.serial_no - y.serial_no)
}

/** Whether a record signs its 關卡 (送出 or 核准), as opposed to a 退回 or a kind added later (加簽、換人, #13). */
export const isSignOff = (s: Signoff) => s.action === 'submit' || s.action === 'approve'

/**
 * The valid 送出 or 核准 that completed each 關卡, by 關卡 id: voided ones (a later 退回 cancelled them) and every
 * other kind of record do not count, and of several valid ones the latest wins. Also what the PDF's 簽核欄 prints (#7).
 */
export function completingSignoffs(signoffs: Signoff[]): Map<string, Signoff> {
  const completed = new Map<string, Signoff>()
  for (const s of inSignedOrder(signoffs)) {
    if (s.voided_at === null && isSignOff(s)) completed.set(s.step_id, s) // later ones win
  }
  return completed
}

/** `unassigned`: 待分派, no 簽核人 yet; a 關卡 with one that has not started is `todo`. */
export type RouteStepState = 'done' | 'current' | 'todo' | 'unassigned'

export interface RouteStep {
  step: AssessmentStep
  state: RouteStepState
  /** The valid 送出 or 核准 that completed this 關卡; null when not done (or done before records existed). */
  signoff: Signoff | null
  /** 姓名（工號）, or the 工號 when no name is known (signerLabeler); null while 待分派. */
  signer: string | null
  /** Just the name, for the compact 簽核流程; the 工號 when no name is known, null while 待分派. */
  signerName: string | null
}

/**
 * One entry per 關卡 in route order, as the database left it: a 退回 makes later 關卡 todo again even though their
 * voided sign-offs remain. Sign-offs are matched by 關卡 id, so they stay with their 關卡 when 加簽 (#13) renumbers it.
 */
export function routeSteps(a: SignoffSource, signoffs: Signoff[]): RouteStep[] {
  const names = knownNames(a, signoffs)
  const completed = completingSignoffs(signoffs)

  return a.assessment_step.map((step) => {
    const state: RouteStepState =
      a.status === 'closed' || step.state === 'done'
        ? 'done'
        : step.state === 'current'
          ? 'current'
          : step.signer_emp_id === null
            ? 'unassigned'
            : 'todo'
    if (step.signer_emp_id === null) return { step, state, signoff: null, signer: null, signerName: null }
    const name = names.get(step.signer_emp_id)
    return {
      step,
      state,
      signoff: state === 'done' ? (completed.get(step.id) ?? null) : null,
      signer: formatSigner(name, step.signer_emp_id),
      signerName: name ?? step.signer_emp_id,
    }
  })
}

/** One 自評單位's 分流 (Q116 (1)): its 關卡 in order, and how often a 退回 sent the 自評表 back into it. */
export interface RouteBranch {
  unit: string
  steps: RouteStep[]
  /** Every 關卡 of the 分流 is done, so it waits at the 匯流. */
  done: boolean
  returns: number
}

/** The 簽核流程 as the page draws it: the 分流 side by side, then the 匯流後 廠區 關卡, then 稽核室覆核 in order. */
export interface RouteLayout {
  branches: RouteBranch[]
  merged: RouteStep[]
  audit: RouteStep[]
}

/** Each 分流 by its 自評單位, in the order they are drawn (by their first 關卡): whether every 關卡 of it is done. */
function branchesDone(steps: AssessmentStep[]): Map<string, boolean> {
  const done = new Map<string, boolean>()
  for (const s of steps) {
    if (s.branch_unit_name !== null) done.set(s.branch_unit_name, (done.get(s.branch_unit_name) ?? true) && s.state === 'done')
  }
  return done
}

export function routeLayout(a: SignoffSource, signoffs: Signoff[]): RouteLayout {
  const route = routeSteps(a, signoffs)
  const byPosition = new Map(route.map((r) => [r.step.position, r.step.branch_unit_name]))
  const branches = new Map<string, RouteBranch>(
    [...branchesDone(a.assessment_step)].map(([unit, done]) => [unit, { unit, steps: [], done: done || a.status === 'closed', returns: 0 }]),
  )
  for (const r of route) if (r.step.branch_unit_name !== null) branches.get(r.step.branch_unit_name)!.steps.push(r)
  for (const s of signoffs) {
    const unit = s.action === 'return' && s.return_to_position !== null ? byPosition.get(s.return_to_position) : null
    if (unit) branches.get(unit)!.returns++
  }
  const afterMerge = route.filter((r) => r.step.branch_unit_name === null)
  return {
    branches: [...branches.values()],
    merged: afterMerge.filter((r) => r.step.step_group !== 'audit_review'),
    audit: afterMerge.filter((r) => r.step.step_group === 'audit_review'),
  }
}

/** How many 分流 cards of `minWidth`, `gap` apart, fit across `width`; always at least one. */
export function maxBranchColumns(width: number, minWidth: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)))
}

/**
 * Cards a row for `count` 分流 at most `maxColumns` wide, as even as the rows can be: as few rows as fit, then the
 * cards shared out over them. Six at five wide are 3＋3, not 5＋1.
 */
export function branchColumns(count: number, maxColumns: number): number {
  return Math.ceil(count / Math.max(1, Math.ceil(count / maxColumns)))
}

const DASHES = '－‐‑‒–—―-'

/** A 分流 關卡's name without its unit (「部門主管－資材單位」→「部門主管」): the diagram already heads the column with it. */
export function nameInBranch(step: Pick<AssessmentStep, 'name' | 'branch_unit_name'>): string {
  const unit = step.branch_unit_name
  if (!unit) return step.name
  const trimmed = step.name.trimEnd()
  if (!trimmed.endsWith(unit)) return step.name
  const rest = trimmed.slice(0, -unit.length).trimEnd()
  return rest.length > 1 && DASHES.includes(rest.at(-1)!) ? rest.slice(0, -1).trimEnd() : step.name
}

/**
 * A 關卡 as the 簽核歷程, the 退回 choices and the 追蹤總覽 name it (#99): 「資材單位・部門主管」 in a 分流, the name
 * alone after the 匯流. No 「第 N 關」: the 分流 run side by side, so the numbers are not the order they sign in.
 */
export function stepLabel(step: Pick<AssessmentStep, 'name' | 'branch_unit_name'>): string {
  return step.branch_unit_name ? `${step.branch_unit_name}・${nameInBranch(step)}` : step.name
}

/** The 關卡 at `position` by stepLabel, e.g. where a 退回 went; null when the 自評表 has none there. */
export function stepLabelAt(steps: readonly AssessmentStep[], position: number | null): string | null {
  const step = steps.find((s) => s.position === position)
  return step ? stepLabel(step) : null
}

/**
 * A 簽核紀錄's 關卡 by stepLabel: the name it was signed under, in the 分流 of the 關卡 at that position (the 自評表's
 * 關卡 never change once launched).
 */
export function signedStepLabel(steps: readonly Pick<AssessmentStep, 'position' | 'branch_unit_name'>[], position: number, name: string): string {
  return stepLabel({ name, branch_unit_name: steps.find((s) => s.position === position)?.branch_unit_name ?? null })
}

/**
 * Where the 自評表 stands for the page header: one 關卡 once the 分流 have merged (or the last one once closed),
 * otherwise how many 分流 are done and the 關卡 each unfinished one is at.
 */
export type RouteProgress =
  | { kind: 'step'; step: AssessmentStep }
  | { kind: 'branches'; done: number; total: number; current: AssessmentStep[] }
  | { kind: 'none' }

export function routeProgress(a: Pick<AssessmentView, 'assessment_step' | 'currentStep'>): RouteProgress {
  if (a.currentStep) return { kind: 'step', step: a.currentStep }
  const units = branchesDone(a.assessment_step)
  // In the order the 分流 are drawn (by their first 關卡), not by the 關卡 each one has reached.
  const order = [...units.keys()]
  const current = a.assessment_step
    .filter((s) => s.state === 'current' && s.branch_unit_name !== null)
    .sort((x, y) => order.indexOf(x.branch_unit_name!) - order.indexOf(y.branch_unit_name!))
  if (units.size === 0) return { kind: 'none' }
  return { kind: 'branches', done: [...units.values()].filter(Boolean).length, total: units.size, current }
}

/**
 * The 關卡 the 核准／退回 panel signs now: the signed-in employee's first 主管 or 稽核 關卡. Someone at two 分流 at once
 * (one 主管 over two units) signs them one after the other, the way one 關卡 was signed before the 分流 (Q116).
 */
export function mySignStep(a: Pick<AssessmentView, 'my_current_steps'>): MyCurrentStep | null {
  return a.my_current_steps.find((s) => s.editable_unit_name === null) ?? null
}

/** The 自行檢查人員 關卡 the answer sheet works on now; like mySignStep, one unit at a time. */
export function myAnswerStep(a: Pick<AssessmentView, 'my_current_steps'>): MyCurrentStep | null {
  return a.my_current_steps.find((s) => s.editable_unit_name !== null) ?? null
}

/** The 關卡 a 退回 from `step` may target (Q116 (10)), from the database; it checks them again. */
export function returnTargets(a: Pick<AssessmentView, 'assessment_step'>, step: MyCurrentStep): AssessmentStep[] {
  return a.assessment_step.filter((s) => step.return_targets.includes(s.position))
}

/**
 * What a 送出 or 核准 that moved to `position` did, for its message: the 分流 went on to its next 關卡, the whole
 * 自評表 moved (after the 匯流), or the 分流 is done and waits for the others (no position).
 */
export function advancedTo(a: Pick<AssessmentView, 'assessment_step'>, position: number | null): 'branch' | 'route' | 'waiting' {
  if (position === null) return 'waiting'
  return a.assessment_step.find((s) => s.position === position)?.branch_unit_name ? 'branch' : 'route'
}

const ADVANCE_SUFFIX = { branch: 'Branch', route: '', waiting: 'Waiting' } as const

/**
 * The message key after a 送出 (`submitted…`, answering namespace) or 核准 (`approved…`, signoff namespace) that moved
 * to `position`: `submitted` / `submittedBranch` / `submittedWaiting`, and the same for `approved` (advancedTo).
 */
export function advanceMessageKey<V extends 'submitted' | 'approved'>(
  verb: V,
  a: Pick<AssessmentView, 'assessment_step'>,
  position: number | null,
): `${V}${(typeof ADVANCE_SUFFIX)[keyof typeof ADVANCE_SUFFIX]}` {
  return `${verb}${ADVANCE_SUFFIX[advancedTo(a, position)]}`
}
