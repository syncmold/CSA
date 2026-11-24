// 簽核紀錄 (#6) data shapes, without a client so src/domain and tests/db can import them.
// 🔴 OPEN-1: a 簽核紀錄 is the interim 方案A system record (signature_method = system_record).

export type SignoffAction = 'submit' | 'approve' | 'return'

/** One row of the 簽核歷程: a 送出, 核准 or 退回, with the 關卡 and signer as they were at that moment. */
export interface Signoff {
  /** 簽核記錄編號 (方案A prints it on the PDF). */
  serial_no: number
  /** The 關卡 it signed; stays right when 加簽 (#13) renumbers the 關卡. */
  step_id: string
  step_position: number
  step_name: string
  action: SignoffAction
  signer_emp_id: string
  signer_name: string | null
  /** 核准的意見 or 退回的原因. */
  comment: string | null
  return_to_position: number | null
  signature_method: 'system_record'
  signed_at: string
  /** Set when a later 退回 voided this sign-off; it stays in the history. */
  voided_at: string | null
}

/**
 * `current_step_position` is the 關卡 the 核准 moved on to: the next one of the same 分流, the first after the 匯流,
 * or null while other 分流 are still running (Q116).
 */
export type ApproveResult = { ok: true; closed: boolean; current_step_position: number | null } | { ok: false; error: 'self_check_step' }

export type ReturnResult =
  | { ok: true; current_step_position: number; voided: number }
  | { ok: false; error: 'self_check_step' | 'reason_required' | 'invalid_target' }
