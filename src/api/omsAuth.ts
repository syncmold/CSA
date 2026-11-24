// OMS Auth, read-only use: password grant and refresh. Never writes to OMS.
import { env } from '../env'
import type { OmsAuthFailure } from '../auth/omsErrors'

export interface OmsTokens {
  access_token: string
  refresh_token: string
  user: {
    id: string
    email?: string
    user_metadata?: { must_change?: boolean }
  }
}

export type OmsLoginResult = { ok: true; tokens: OmsTokens } | { ok: false; failure: OmsAuthFailure }

async function tokenRequest(grantType: string, body: Record<string, string>): Promise<OmsLoginResult> {
  let response: Response
  try {
    response = await fetch(`${env.omsUrl}/auth/v1/token?grant_type=${grantType}`, {
      method: 'POST',
      headers: { apikey: env.omsAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, failure: { status: 0 } }
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error_code?: string }
    return { ok: false, failure: { status: response.status, code: detail.error_code } }
  }
  return { ok: true, tokens: (await response.json()) as OmsTokens }
}

export function omsPasswordLogin(email: string, password: string): Promise<OmsLoginResult> {
  return tokenRequest('password', { email, password })
}

export function omsRefresh(refreshToken: string): Promise<OmsLoginResult> {
  return tokenRequest('refresh_token', { refresh_token: refreshToken })
}
