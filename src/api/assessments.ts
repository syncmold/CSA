// 自評表 (#4, answers since #5). Who may read one is decided by RLS (ADR-0001); this file only shapes queries.
import type { Answer, UnitConclusion } from './answerModel'
import { ASSESSMENT_TREE } from './assessmentQuery'
import { fetchPeopleNames } from './people'
import { supabase } from './supabase'
import type { TemplateLayout } from './templates'

export type AssessmentStatus = 'in_progress' | 'closed'
/** Where a 自評表 stands (view columns `stage`): the database's one definition of 填寫中 (Q115). */
export type AssessmentStage = 'filling' | 'signing' | 'closed'
export type StepGroup = 'plant' | 'audit_review'
/** Where one 關卡 stands (database step_state, Q116): only the database derives it from the valid 送出／核准. */
export type StepState = 'pending' | 'current' | 'done'

/** One 自評單位 of a control point (#46): its own row on the sheet, with its own answer. */
export interface AssessmentPointUnit {
  position: number
  assessing_unit_name: string
  /** Saved answer (暫存 or submitted); null until the unit answers it. */
  assessment_answer: Answer | null
}

export interface AssessmentControlPoint {
  id: string
  /** The control point's place in its section; a multi-unit control point has one place (#46). */
  position: number
  /** 原檔題號, frozen at launch; null: numbered by the page (domain/outline, Q125). */
  code: string | null
  text: string
  /** In answering order; empty for a 要素類 control point nobody answers (Q83(3)). */
  assessment_control_point_unit: AssessmentPointUnit[]
}

export interface AssessmentSection {
  id: string
  position: number
  /** 層級 and 原檔題號, frozen at launch (Q125): 1 starts a card, 2 and 3 are 分段列 in it. */
  level: number
  code: string | null
  name: string
  assessment_control_point: AssessmentControlPoint[]
}

export interface AssessmentStep {
  id: string
  position: number
  name: string
  step_group: StepGroup
  /** null: 待分派 (#101). */
  signer_emp_id: string | null
  editable_unit_name: string | null
  /** The 自評單位 whose 分流 the 關卡 belongs to (Q116); null = after the 匯流 (廠區經理人, 稽核室覆核). */
  branch_unit_name: string | null
  state: StepState
}

/** A 關卡 that is the signed-in employee's turn now (database function my_current_steps). */
export interface MyCurrentStep {
  position: number
  name: string
  branch_unit_name: string | null
  /** Set for a 自行檢查人員 關卡 (送出); null for a 主管 or 稽核 關卡 (核准／退回). */
  editable_unit_name: string | null
  /** The 關卡 a 退回 from here may target (Q116 (10)); the database checks it again. */
  return_targets: number[]
  /** Whether 核准 here closes the 自評表 (every other 關卡 is done). */
  closes: boolean
}

export interface Assessment {
  id: string
  template_code: string
  template_name: string
  template_layout: TemplateLayout
  status: AssessmentStatus
  /** The first 關卡 whose turn it is (the last one once closed); several 分流 can be at a 關卡 at once (Q116). */
  current_step_position: number | null
  /** The 關卡 that are the signed-in employee's turn now, in route order; empty = nothing to do here. */
  my_current_steps: MyCurrentStep[]
  /** Whether the signed-in employee may 核准 or 退回 now (database function can_approve, #6). */
  can_approve: boolean
  plant: { factory_code: string; name: string }
  annual_cycle: { year: number; due_date: string }
  assessment_section: AssessmentSection[]
  assessment_step: AssessmentStep[]
  assessment_conclusion: UnitConclusion[]
}

export interface AssessmentView extends Assessment {
  /** The 關卡 the 自評表 is at after the 匯流 (or the last one once closed); null while the 分流 run. */
  currentStep: AssessmentStep | null
  /** Names of the route's 簽核人, from CSA's own copy (visible_people, #218): those who have logged in or been looked up by 工號. */
  signerNames: ReadonlyMap<string, string>
}

/** One 自評表 with sections and control points in paper order; null when RLS hides it or it does not exist. */
export async function fetchAssessment(id: string): Promise<AssessmentView | null> {
  const { data, error } = await supabase.from('assessment').select(ASSESSMENT_TREE).eq('id', id).maybeSingle<Assessment>()
  if (error) throw error
  if (!data) return null
  const byPosition = <T extends { position: number }>(rows: T[]) => [...rows].sort((a, b) => a.position - b.position)
  const steps = byPosition(data.assessment_step)
  const current = steps.find((s) => s.position === data.current_step_position)
  const currentStep = current && (data.status === 'closed' || current.branch_unit_name === null) ? current : null

  // Names are a nicety: CSA's own copy only holds people who have logged in or been looked up by 工號, read through
  // visible_people (whoever sees this 自評表 sees its 簽核人's names, #218). The page adds the names the 簽核紀錄 kept
  // (src/domain/signoff.ts). Any failure here just leaves the 工號.
  const refs = await fetchPeopleNames(steps.flatMap((s) => s.signer_emp_id ?? [])).catch(() => [])
  const signerNames = new Map(refs.map((r) => [r.emp_id, r.name] as const))

  return {
    ...data,
    assessment_section: byPosition(data.assessment_section).map((s) => ({
      ...s,
      assessment_control_point: byPosition(s.assessment_control_point).map((p) => ({
        ...p,
        assessment_control_point_unit: byPosition(p.assessment_control_point_unit),
      })),
    })),
    assessment_step: steps,
    currentStep,
    signerNames,
  }
}
