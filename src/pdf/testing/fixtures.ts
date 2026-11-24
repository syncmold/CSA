// Fixed inputs for the PDF seam tests: a small 控制活動類 自評表 shaped like the paper 02 採購及付款循環
// (two 自評單位, the paper's 簽核欄 names), plus helpers to build its 簽核紀錄.
import type { AssessmentControlPoint, AssessmentStep } from '../../api/assessments'
import type { Answer } from '../../api/answerModel'
import type { Signoff, SignoffAction } from '../../api/signoffModel'
import type { AssessmentPdfInput } from '../assessmentPdf'

const LONG_POINT =
  '原物料或託外加工品是否由兩家以上之廠商供應，以避免因單獨交易而造成獨佔供應，當異常事故發生時，而致供應斷絕之危機？'

const answer = (a: Partial<Answer>): Answer => ({ design: null, execution: null, satisfaction: null, improvement: null, ...a })

/** A snapshot control point answered by these 自評單位, in order, each with its own answer (#46). */
export function point(id: string, position: number, text: string, units: [string, Answer | null][]): AssessmentControlPoint {
  return {
    id,
    position,
    code: null,
    text,
    assessment_control_point_unit: units.map(([assessing_unit_name, assessment_answer], i) => ({ position: i + 1, assessing_unit_name, assessment_answer })),
  }
}

/** 名稱、關卡群組、可編輯的自評單位、所屬分流（Q116；空值＝匯流後）。 */
const STEP_NAMES: [string, AssessmentStep['step_group'], string | null, string | null][] = [
  ['自行檢查人員－資材單位', 'plant', '資材單位', '資材單位'],
  ['自行檢查人員－品保單位', 'plant', '品保單位', '品保單位'],
  ['部門主管－資材單位', 'plant', null, '資材單位'],
  ['部門主管－品保單位', 'plant', null, '品保單位'],
  ['廠區經理人', 'plant', null, null],
  ['子公司擔當稽核', 'audit_review', null, null],
  ['台北稽核人員', 'audit_review', null, null],
  ['稽核主管', 'audit_review', null, null],
]

export const STEPS: AssessmentStep[] = STEP_NAMES.map(([name, group, unit, branch], i) => ({
  id: `step-${i + 1}`,
  position: i + 1,
  name,
  step_group: group,
  signer_emp_id: `E${i + 1}`,
  editable_unit_name: unit,
  branch_unit_name: branch,
  state: 'done',
}))

/** One 簽核紀錄 of 關卡 `position`, signed by 簽核人「簽核人{position}」at 2026-10-16 09:{position}:00 +08:00. */
export function signoff(position: number, serial: number, extra: Partial<Signoff> = {}): Signoff {
  const step = STEPS[position - 1]!
  const action: SignoffAction = step.editable_unit_name ? 'submit' : 'approve'
  return {
    serial_no: serial,
    step_id: step.id,
    step_position: position,
    step_name: step.name,
    action,
    signer_emp_id: step.signer_emp_id!,
    signer_name: `簽核人${position}`,
    comment: null,
    return_to_position: null,
    signature_method: 'system_record',
    signed_at: `2026-10-16T01:${String(position).padStart(2, '0')}:00+00:00`,
    voided_at: null,
    ...extra,
  }
}

export function pdfInput(overrides: Partial<AssessmentPdfInput> = {}): AssessmentPdfInput {
  return {
    companyName: '福清富群電子有限公司',
    timeZone: 'Asia/Taipei',
    withSignedAt: true,
    signoffs: [],
    assessment: {
      template_name: '採購及付款循環',
      template_layout: 'control_activity',
      annual_cycle: { year: 2026, due_date: '2026-12-31' },
      assessment_step: STEPS,
      assessment_section: [
        {
          id: 's1',
          position: 1,
          level: 1,
          code: null,
          name: '供應商管理作業',
          assessment_control_point: [
            point('p1', 1, LONG_POINT, [['資材單位', answer({ design: 'has_rule', execution: 'yes', satisfaction: 'satisfied' })]]),
            point('p2', 2, '供應商之評估作業是否切實依規定辦理？', [
              ['品保單位', answer({ design: 'no_rule', execution: 'no', satisfaction: 'needs_improvement', improvement: '每季重新評估一次' })],
            ]),
          ],
        },
        {
          id: 's2',
          position: 2,
          level: 1,
          code: null,
          name: '請、採購作業',
          assessment_control_point: [
            point('p3', 1, '請購前是否先查閱公司現有的資產狀況？', [['資材單位', null]]),
          ],
        },
      ],
      assessment_conclusion: [
        { assessing_unit_name: '資材單位', conclusion: 'satisfied', exceptions: null },
        { assessing_unit_name: '品保單位', conclusion: 'satisfied_except', exceptions: '供應商評估頻率不足' },
      ],
    },
    ...overrides,
  }
}

export { LONG_POINT }
