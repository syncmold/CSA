// 呈現用純函式 for 分派 (#101, Q116 (5)(7); Q147). Which 關卡 may change hands, and when a 分流 starts, are decided by
// the database (assign_route_signer, assign_step_signer, refresh_assessment_steps; ADR-0001); these only shape its rows
// for the page.
import type { TFunction } from 'i18next'
import type { AssignableStep, AssignmentForm } from '../api/assignment'
import { errorText } from './errors'

/**
 * 待分派: somebody is missing. On an issued 自評表, 已開始: everyone is there; 已核准: its last 關卡 is done, so it waits at
 * the 匯流. On a 簽核流程 (下次發出, Q147), 已分派: everyone is there for the next launch.
 */
export type BranchStatus = 'unassigned' | 'assigned' | 'started' | 'approved'

export interface AssignmentBranch<S extends AssignableStep = AssignableStep> {
  unit: string
  steps: S[]
  status: BranchStatus
}

function branchStatus(steps: readonly AssignableStep[]): BranchStatus {
  if (steps.some((s) => s.signer_emp_id === null)) return 'unassigned'
  // A route's 關卡 have no state: nobody signs a route.
  if (steps.some((s) => s.state === undefined)) return 'assigned'
  return steps.every((s) => s.state === 'done') ? 'approved' : 'started'
}

/**
 * What is assigned on one 簽核流程 or 自評表: each 分流, then the 關卡 after the 匯流 — the 廠區端 ones and the 稽核室's
 * ordinary ones such as 子公司擔當稽核 (Q143); never the 連動 台北稽核人員／稽核主管, which 權限管理 decides.
 */
export function assignmentLayout<S extends AssignableStep>(stepsIn: readonly S[]): { branches: AssignmentBranch<S>[]; merged: S[] } {
  const steps = [...stepsIn].sort((a, b) => a.position - b.position)
  const byUnit = new Map<string, S[]>()
  for (const s of steps) {
    if (s.branch_unit_name !== null) byUnit.set(s.branch_unit_name, [...(byUnit.get(s.branch_unit_name) ?? []), s])
  }
  return {
    branches: [...byUnit].map(([unit, unitSteps]) => ({ unit, steps: unitSteps, status: branchStatus(unitSteps) })),
    merged: steps.filter((s) => s.branch_unit_name === null && (s.step_group === 'plant' || !s.link)),
  }
}

/** How many of these 關卡 nobody is assigned to yet. */
export const missingSteps = (steps: readonly AssignableStep[]) => steps.filter((s) => s.signer_emp_id === null).length

/** 分派填寫人's 年度 menu (Q147): 下次發出 (the 簽核流程) or a 年度 already issued. */
export type AssignmentYear = number | 'next'

/** The 年度 the forms belong to, newest first. */
export function assignmentYears(forms: readonly AssignmentForm[]): number[] {
  return [...new Set(forms.map((f) => f.annual_cycle.year))].sort((a, b) => b - a)
}

/**
 * What the page shows: `chosen` when it is there (下次發出 needs a route to show, a 年度 its forms); otherwise 下次發出
 * when the plant has routes a launch would issue (Q147: 分派 comes before the launch), else the newest 年度; null with
 * neither.
 */
export function pickAssignmentYear(forms: readonly AssignmentForm[], chosen: AssignmentYear | null, hasRoutes: boolean): AssignmentYear | null {
  const years = assignmentYears(forms)
  if (chosen === 'next' ? hasRoutes : chosen !== null && years.includes(chosen)) return chosen
  return hasRoutes ? 'next' : (years[0] ?? null)
}

/** The URL's `year`: 「next」 or a 年度; anything else is no choice. */
export function parseAssignmentYear(param: string | null): AssignmentYear | null {
  if (param === 'next') return 'next'
  const year = Number(param)
  return param && Number.isInteger(year) ? year : null
}

/** 分派填寫人 on one plant and 年度: where 首頁, 年度發起 and the 流程編輯器 send whoever is to 分派 there (Q147). */
export const assignmentPath = (factoryCode: string, year: AssignmentYear) =>
  `/admin/assignment?plant=${encodeURIComponent(factoryCode)}&year=${year}`

/**
 * What to say when assign_route_signer (`issued` false) or assign_step_signer refuses; `t` is the `assignment` namespace.
 */
export function assignmentWriteError(t: TFunction, error: unknown, issued = true): string {
  const { code, hint } = error as { code?: string; hint?: string }
  if (hint === 'step_signed') return t('errors.stepSigned')
  if (hint === 'linked_step') return t('errors.linkedStep')
  if (hint === 'signer_required') return t('errors.signerRequired')
  if (hint === 'assessment_closed') return t('errors.closed')
  if (code === '42501') return t(issued ? 'errors.deniedIssued' : 'errors.denied')
  return errorText(error)
}
