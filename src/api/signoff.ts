// 核准、退回與簽核歷程 (#6). Who may approve or return, which 關卡 a return may target, and which
// sign-offs a return voids are decided by the database (approve_assessment_step, return_assessment, RLS;
// ADR-0001); this file only calls it and turns its refusals into the few outcomes the page shows.
import { SIGNOFF_COLUMNS } from './assessmentQuery'
import type { ApproveResult, ReturnResult, Signoff } from './signoffModel'
import { supabase } from './supabase'
import { toWriteError } from './writeError'

export * from './signoffModel'

/** The whole 簽核歷程 of a 自評表 in time order, voided sign-offs included. */
export async function fetchSignoffs(assessmentId: string): Promise<Signoff[]> {
  const { data, error } = await supabase
    .from('assessment_signoff')
    .select(SIGNOFF_COLUMNS)
    .eq('assessment_id', assessmentId)
    .order('signed_at')
    .order('serial_no')
  if (error) throw error
  return data as unknown as Signoff[]
}

/** 核准 the signed-in employee's 關卡 at `stepPosition` with an optional 意見; the last 關卡's 核准 closes the 自評表. */
export async function approveStep(assessmentId: string, stepPosition: number, comment: string): Promise<ApproveResult> {
  const { data, error } = await supabase.rpc('approve_assessment_step', {
    p_assessment_id: assessmentId,
    p_comment: comment,
    p_step_position: stepPosition,
  })
  if (error) throw toWriteError(error)
  return data as ApproveResult
}

/** 退回 from the signed-in employee's 關卡 at `stepPosition` to an earlier 關卡, with a reason. */
export async function returnAssessment(assessmentId: string, stepPosition: number, toPosition: number, reason: string): Promise<ReturnResult> {
  const { data, error } = await supabase.rpc('return_assessment', {
    p_assessment_id: assessmentId,
    p_to_position: toPosition,
    p_reason: reason,
    p_step_position: stepPosition,
  })
  if (error) throw toWriteError(error)
  return data as ReturnResult
}
