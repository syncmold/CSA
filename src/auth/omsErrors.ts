export interface OmsAuthFailure {
  /** HTTP status; 0 when the request never got a response. */
  status: number
  /** OMS/GoTrue `error_code`, when present. */
  code?: string
}

/** i18n key for a failed OMS Auth login, using the same wording as OMS. */
export function loginFailureKey(failure: OmsAuthFailure): string {
  if (failure.status === 400 || failure.status === 401) {
    return 'login.error.invalidCredentials'
  }
  return 'login.error.network'
}
