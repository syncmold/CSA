// The few outcomes the pages show when the database refuses a write or a sign-off (ADR-0001: the rules live
// there; pages never see a SQLSTATE). Shared by 答題 (#5) and 核准／退回 (#6).

/**
 * forbidden = outside the editable scope, no longer this person's turn, or closed (RLS / 42501);
 * invalid = a value the layout does not have (check_answer_layout / enum cast);
 * stale = the page was built for an older version of the 自評表 or of the app, e.g. an answer without its 自評單位
 *         from a tab opened before #46, or a control point × 自評單位 that is not there (23502 / 23503): reload;
 * other = anything else (network, server), shown with its message.
 */
export class WriteError extends Error {
  constructor(
    readonly reason: 'forbidden' | 'invalid' | 'stale' | 'other',
    message: string,
  ) {
    super(message)
  }
}

export function toWriteError(error: { code?: string; message: string }): WriteError {
  if (error.code === '42501') return new WriteError('forbidden', error.message)
  if (error.code === '23514' || error.code === '22P02') return new WriteError('invalid', error.message)
  if (error.code === '23502' || error.code === '23503') return new WriteError('stale', error.message)
  return new WriteError('other', error.message)
}
