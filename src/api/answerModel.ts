// 答題 (#5) data shapes: the answer fields of the paper form (enum values of the migration) and what
// 暫存／送出 exchange with the database. No client here, so src/domain and tests can import it.

export type DesignStatus = 'has_rule' | 'no_rule'
export type ExecutionStatus = 'yes' | 'no' | 'not_applicable' | 'no_case'
export type SatisfactionLevel = 'very_satisfied' | 'satisfied' | 'adequate' | 'needs_improvement' | 'dissatisfied'
export type ConclusionKind = 'satisfied' | 'satisfied_except'

/** Paper column order of each enum in the migration; the page renders options in this order. */
export const DESIGN_OPTIONS: DesignStatus[] = ['has_rule', 'no_rule']
export const EXECUTION_OPTIONS: ExecutionStatus[] = ['yes', 'no', 'not_applicable', 'no_case']
/** 要素類 has no 內控設計 and no 無此情形. */
export const ELEMENT_EXECUTION_OPTIONS: ExecutionStatus[] = ['yes', 'no', 'not_applicable']
export const SATISFACTION_OPTIONS: SatisfactionLevel[] = ['very_satisfied', 'satisfied', 'adequate', 'needs_improvement', 'dissatisfied']
export const CONCLUSION_OPTIONS: ConclusionKind[] = ['satisfied', 'satisfied_except']

export interface Answer {
  design: DesignStatus | null
  execution: ExecutionStatus | null
  satisfaction: SatisfactionLevel | null
  improvement: string | null
}

export const EMPTY_ANSWER: Answer = { design: null, execution: null, satisfaction: null, improvement: null }

export interface Conclusion {
  conclusion: ConclusionKind | null
  exceptions: string | null
}

export const EMPTY_CONCLUSION: Conclusion = { conclusion: null, exceptions: null }

/** One 自評單位's answer to one control point, as written by 暫存 (#46). */
export type AnswerInput = Answer & { control_point_id: string; assessing_unit_name: string }
/** One 自評單位's 整體結論, as stored and as written by 暫存. */
export type UnitConclusion = Conclusion & { assessing_unit_name: string }

/** What one 暫存 writes: only the rows that changed. */
export interface AnswerPayload {
  answers: AnswerInput[]
  conclusions: UnitConclusion[]
}

export type ViolationRule = 'unanswered' | 'improvement_required' | 'explanation_required'

export type Violation =
  | { kind: 'control_point'; control_point_id: string; section_position: number; position: number; rule: ViolationRule }
  | { kind: 'conclusion'; assessing_unit_name: string; rule: ViolationRule }

export type SubmitResult =
  /** The 關卡 the 分流 moved on to, like ApproveResult's; null while other 分流 are still running (Q116). */
  | { ok: true; current_step_position: number | null }
  | { ok: false; error: 'incomplete'; violations: Violation[] }
  | { ok: false; error: 'not_self_check_step' | 'no_next_step' }
