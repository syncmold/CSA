// 答題 (#5): 暫存與送出. Who may write what, and whether a submission is complete, is decided by the
// database (RLS + submit_assessment_step, ADR-0001); this file only calls it, types the answers, and turns
// database errors into the few outcomes the page shows (src/api/writeError.ts; the page never sees a SQLSTATE).
import type { AnswerPayload, SubmitResult } from './answerModel'
import { supabase } from './supabase'
import { toWriteError } from './writeError'

export * from './answerModel'

/** 暫存: writes the given answers and 整體結論 in one transaction. A write outside the editable scope fails as a whole. */
export async function saveAnswers(assessmentId: string, payload: AnswerPayload): Promise<void> {
  const { error } = await supabase.rpc('save_assessment_answers', {
    p_assessment_id: assessmentId,
    p_answers: payload.answers,
    p_conclusions: payload.conclusions,
  })
  if (error) throw toWriteError(error)
}

/** 送出 the 關卡 at `stepPosition`: the database validates its 自評單位 and, when complete, moves its 分流 on. */
export async function submitStep(assessmentId: string, stepPosition: number): Promise<SubmitResult> {
  const { data, error } = await supabase.rpc('submit_assessment_step', { p_assessment_id: assessmentId, p_step_position: stepPosition })
  if (error) throw toWriteError(error)
  return data as SubmitResult
}
