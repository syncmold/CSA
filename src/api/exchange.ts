// Client side of 本機換證: hand the OMS token to the exchange, get an CSA session.
import { env } from '../env'
import type { EmployeeRef } from '../../exchange/core'

export type ExchangeResponse =
  | { ok: true; csaToken: string; expiresAt: string; employee: EmployeeRef }
  | { ok: false; error: string }

async function postForSession(url: string, body: Record<string, string | boolean>): Promise<ExchangeResponse> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, error: 'exchange_failed' }
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string
    csa_token?: string
    expires_at?: string
    employee?: EmployeeRef
  }
  if (!response.ok || !payload.csa_token || !payload.expires_at || !payload.employee) {
    return { ok: false, error: payload.error ?? 'exchange_failed' }
  }
  return { ok: true, csaToken: payload.csa_token, expiresAt: payload.expires_at, employee: payload.employee }
}

/**
 * `renewal`: the 45-minute renewal of a session already held, for which the exchange does not ask OMS's channel for
 * 姓名 and 廠區 again (#218); a sign-in leaves it off.
 */
export function exchangeOmsToken(omsToken: string, { renewal = false } = {}): Promise<ExchangeResponse> {
  return postForSession(env.exchangeUrl, renewal ? { oms_token: omsToken, renewal: true } : { oms_token: omsToken })
}

/** 開發期直接登入 (Q82): a session for a 工號 OMS has as 在職, no password. The server answers 404 unless CSA_DEV_LOGIN=true. */
export function devLoginAs(empId: string): Promise<ExchangeResponse> {
  return postForSession(env.devLoginUrl, { emp_id: empId })
}

export interface ExchangeStatus {
  /** 放行全開 (Q62) is on. */
  accessAll: boolean
  /** 開發期直接登入 (Q82) is served. */
  devLogin: boolean
}

/** GET on the exchange reports the dev-period switches so the login page can say so and offer dev login. */
export async function fetchExchangeStatus(): Promise<ExchangeStatus | null> {
  try {
    const response = await fetch(env.exchangeUrl, { method: 'GET' })
    if (!response.ok) return null
    const body = (await response.json()) as { access_all?: boolean; dev_login?: boolean }
    return { accessAll: body.access_all === true, devLogin: body.dev_login === true }
  } catch {
    return null
  }
}
