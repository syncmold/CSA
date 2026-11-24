// 呈現用純函式 for 答題 (#5). The rules themselves live in the database (ADR-0001): which 自評單位 the
// signed-in employee may answer comes from my_current_steps, completeness from submit_assessment_step.
// These only decide what the page shows and which edited rows a 暫存 sends.
import {
  DESIGN_OPTIONS,
  ELEMENT_EXECUTION_OPTIONS,
  EMPTY_CONCLUSION,
  EXECUTION_OPTIONS,
  SATISFACTION_OPTIONS,
  type Answer,
  type AnswerPayload,
  type Conclusion,
  type Violation,
  type ViolationRule,
} from '../api/answerModel'
import type { TFunction } from 'i18next'
import type { AssessmentControlPoint, AssessmentView } from '../api/assessments'
import type { TemplateLayout } from '../api/templates'

/** A tick-box column of the paper form: which answer field, its options, and its i18n group in `answering`. */
export interface ChoiceField {
  field: 'design' | 'execution' | 'satisfaction'
  /** i18n key of the column title */
  title: string
  /** i18n group holding one label per option */
  group: string
  options: readonly string[]
}

/** The tick-box columns of each layout, in paper order (ADR-0005). */
export function choiceFields(layout: TemplateLayout): ChoiceField[] {
  const execution = layout === 'control_activity' ? EXECUTION_OPTIONS : ELEMENT_EXECUTION_OPTIONS
  return [
    ...(layout === 'control_activity' ? [{ field: 'design' as const, title: 'design', group: 'designs', options: DESIGN_OPTIONS }] : []),
    { field: 'execution', title: 'execution', group: 'executions', options: execution },
    { field: 'satisfaction', title: 'satisfaction', group: 'satisfactions', options: SATISFACTION_OPTIONS },
  ]
}

/**
 * A column header of the answer matrix: `key` is `groups.<field>` or `options.<option>` under `headers` in answering.json.
 * A language may break a header between words the way the paper does (繁中: 內部控制／制度設計, 需要／加強); any other
 * shows its plain `label` and wraps freely. Only `language` itself is looked up: falling back to 繁中, as other texts
 * do, would put Chinese headers on an English page.
 */
export function matrixHeader(t: TFunction, language: string, key: string, label: string): string {
  return t(`headers.${key}`, { lngs: [language], defaultValue: label })
}

/** The 自評單位 that answer this 自評表, in the order they first appear on paper (one 整體結論 each). */
export function assessingUnits(assessment: Pick<AssessmentView, 'assessment_section'>): string[] {
  const units = assessment.assessment_section.flatMap((s) =>
    s.assessment_control_point.flatMap((p) => p.assessment_control_point_unit.map((u) => u.assessing_unit_name)),
  )
  return [...new Set(units)]
}

/** Identifies one answer: a control point × one of its 自評單位 (a control point id never contains ':'). */
export function answerKey(controlPointId: string, unit: string): string {
  return `${controlPointId}:${unit}`
}

/** The control point and 自評單位 a row key names; a row without 自評單位 is keyed by its control point alone. */
export function splitAnswerKey(key: string): { control_point_id: string; assessing_unit_name: string | null } {
  const at = key.indexOf(':')
  if (at < 0) return { control_point_id: key, assessing_unit_name: null }
  return { control_point_id: key.slice(0, at), assessing_unit_name: key.slice(at + 1) }
}

/** One row of a merged-cell table (answer sheet, 範本管理): a control point × one 自評單位, as on paper (#46). */
export interface UnitRow<P> {
  key: string
  point: P
  /** null for a control point without 自評單位 (要素類, Q83(3)): one row of its own. */
  unit: string | null
  /** How many rows the control point's number and text span from this row (paper's merged cell); 0 on the rows below. */
  span: number
}

/** Each control point once per 自評單位 (in `unitsOf` order), its number and text merged over those rows. */
export function unitRows<P extends { id: string }>(points: readonly P[], unitsOf: (point: P) => string[]): UnitRow<P>[] {
  return points.flatMap((point): UnitRow<P>[] => {
    const units = unitsOf(point)
    if (units.length === 0) return [{ key: point.id, point, unit: null, span: 1 }]
    return units.map((unit, i) => ({
      key: answerKey(point.id, unit),
      point,
      unit,
      span: i === 0 ? units.length : 0,
    }))
  })
}

export type AnswerRow = UnitRow<AssessmentControlPoint>

/** The rows of one section of the answer sheet. */
export function answerRows(points: readonly AssessmentControlPoint[]): AnswerRow[] {
  return unitRows(points, (p) => p.assessment_control_point_unit.map((u) => u.assessing_unit_name))
}

/**
 * 只看我的題目 (#134): the rows of `unit` alone, each control point on a row of its own (nothing left to merge over).
 * `otherUnits` is how many rows of other 自評單位 are left out; rows nobody answers are left out without being counted.
 */
export function unitOnlyRows(points: readonly AssessmentControlPoint[], unit: string): { rows: AnswerRow[]; otherUnits: number } {
  const mine = points.filter((p) => p.assessment_control_point_unit.some((u) => u.assessing_unit_name === unit))
  const otherUnits = points.flatMap((p) => p.assessment_control_point_unit).filter((u) => u.assessing_unit_name !== unit).length
  return { rows: unitRows(mine, () => [unit]), otherUnits }
}

/**
 * Whether one row (control point × 自評單位) counts as 已答: 執行情形 and 滿意度 chosen, and 內控設計 too on
 * 控制活動類. 改善措施 and other conditionally required text do not count; 送出 checks those. The same rule as the
 * database's answer_is_complete, which 首頁's 已答 a／b 題 and 送出's 未作答 use (tests/db/answer_progress.test.ts
 * checks that they agree).
 */
export function isAnswered(layout: TemplateLayout, answer: Answer | undefined): boolean {
  if (!answer) return false
  return answer.execution !== null && answer.satisfaction !== null && (layout !== 'control_activity' || answer.design !== null)
}

export interface AnswerProgress {
  answered: number
  total: number
  /** The rows still to answer, in paper order. */
  unanswered: string[]
}

/** 已答 a／b 題 over `rowKeys` (one 自評單位's rows in paper order) and what is left, from the answers on screen. */
export function answerProgress(layout: TemplateLayout, rowKeys: readonly string[], answers: Readonly<Record<string, Answer>>): AnswerProgress {
  const unanswered = rowKeys.filter((key) => !isAnswered(layout, answers[key]))
  return { answered: rowKeys.length - unanswered.length, total: rowKeys.length, unanswered }
}

/**
 * 下一題未填 (#134): the first row still to answer after `current` in paper order, back to the first one past the
 * last; null when every row is answered.
 */
export function nextUnanswered(rowKeys: readonly string[], unanswered: readonly string[], current: string | null): string | null {
  if (unanswered.length === 0) return null
  const from = current === null ? -1 : rowKeys.indexOf(current)
  const remaining = new Set(unanswered)
  return rowKeys.slice(from + 1).find((key) => remaining.has(key)) ?? unanswered[0]!
}

/**
 * 控制活動類 always has the 自評單位 column. The paper's 要素類 has none, because one unit answers the whole form;
 * it gets the column only when more than one 自評單位 answers it (Q92).
 */
export function showsUnitColumn(layout: TemplateLayout, assessment: Pick<AssessmentView, 'assessment_section'>): boolean {
  return layout === 'control_activity' || assessingUnits(assessment).length > 1
}

export interface ViolationIndex {
  /** control point id → broken rules, in the order the database listed them */
  points: Map<string, ViolationRule[]>
  /** 自評單位 name → broken rules of its 整體結論 */
  conclusions: Map<string, ViolationRule[]>
}

/** Groups the database's violation list by what the page highlights: a control point row or a 整體結論. */
export function indexViolations(violations: Violation[]): ViolationIndex {
  const index: ViolationIndex = { points: new Map(), conclusions: new Map() }
  for (const v of violations) {
    const [map, key] = v.kind === 'control_point' ? [index.points, v.control_point_id] : [index.conclusions, v.assessing_unit_name]
    map.set(key, [...(map.get(key) ?? []), v.rule])
  }
  return index
}

/** Drops the highlights of a row the user has just edited: the database re-checks it on the next 送出. */
export function clearViolations(
  violations: Violation[],
  edited: { controlPointId: string } | { assessingUnitName: string },
): Violation[] {
  const next = violations.filter((v) =>
    'controlPointId' in edited
      ? !(v.kind === 'control_point' && v.control_point_id === edited.controlPointId)
      : !(v.kind === 'conclusion' && v.assessing_unit_name === edited.assessingUnitName),
  )
  return next.length === violations.length ? violations : next
}

/**
 * What a 暫存 sends: only the rows (control point × 自評單位, keyed by answerKey) edited since the last 暫存, and the
 * 整體結論 if it was edited. Sending untouched rows would overwrite answers saved meanwhile from another tab with stale ones.
 */
export function buildPayload(
  answers: Readonly<Record<string, Answer>>,
  editedRows: ReadonlySet<string>,
  conclusion: { unit: string; value: Conclusion | undefined; edited: boolean } | null,
): AnswerPayload {
  return {
    answers: [...editedRows].flatMap((key) => {
      const answer = answers[key]
      const { control_point_id, assessing_unit_name } = splitAnswerKey(key)
      // A row without 自評單位 has no answer to send (nobody answers it, Q83(3)).
      return answer && assessing_unit_name !== null ? [{ control_point_id, assessing_unit_name, ...answer }] : []
    }),
    conclusions: conclusion?.edited ? [{ assessing_unit_name: conclusion.unit, ...(conclusion.value ?? EMPTY_CONCLUSION) }] : [],
  }
}
