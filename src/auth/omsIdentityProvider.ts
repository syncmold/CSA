// Dev-period 身分提供者: OMS Auth (password grant) + 本機換證, plus 開發期直接登入 (Q82).
import { devLoginAs, exchangeOmsToken, type ExchangeResponse } from '../api/exchange'
import { omsPasswordLogin, omsRefresh, type OmsTokens } from '../api/omsAuth'
import { resolveLoginEmail } from './identity'
import { loginFailureKey } from './omsErrors'
import type { IdentityProvider, LoginOutcome, RenewOutcome, StoredSession } from './types'

/** Exchange errors that mean "this person may not be here", as opposed to "the exchange is down". */
const REJECTING_EXCHANGE_ERRORS = new Set([
  'oms_token_invalid',
  'account_disabled',
  'profile_not_found',
  'not_authorized',
  'dev_login_disabled',
])

async function sessionFromOmsTokens(tokens: OmsTokens): Promise<LoginOutcome> {
  const exchanged = await exchangeOmsToken(tokens.access_token)
  if (!exchanged.ok) return { kind: 'error', messageKey: `login.error.${exchanged.error}` }
  return { kind: 'ok', session: sessionFrom(tokens, exchanged) }
}

/** The session for OMS's tokens and the exchange's answer for them. */
function sessionFrom(tokens: OmsTokens, exchanged: Extract<ExchangeResponse, { ok: true }>): StoredSession {
  return {
    oms: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      userId: tokens.user.id,
      email: tokens.user.email ?? '',
    },
    csa: { token: exchanged.csaToken, expiresAt: exchanged.expiresAt },
    employee: exchanged.employee,
    issuedAt: new Date().toISOString(),
  }
}

/** A dev-login session carries no OMS tokens at all; `devLogin` tells renew() to go back to dev login. */
function sessionFromDevLogin(result: ExchangeResponse): LoginOutcome {
  if (!result.ok) return { kind: 'error', messageKey: `login.error.${result.error}` }
  return {
    kind: 'ok',
    session: {
      oms: { accessToken: '', refreshToken: '', userId: '', email: '' },
      csa: { token: result.csaToken, expiresAt: result.expiresAt },
      employee: result.employee,
      issuedAt: new Date().toISOString(),
      devLogin: true,
    },
  }
}

export const omsIdentityProvider: IdentityProvider = {
  async login(account, password) {
    const email = resolveLoginEmail(account)
    if (!email || !password) return { kind: 'error', messageKey: 'login.error.invalidCredentials' }

    const result = await omsPasswordLogin(email, password)
    if (!result.ok) return { kind: 'error', messageKey: loginFailureKey(result.failure) }

    // Q69: CSA does not change passwords; send first-time users to SyncHub.
    if (result.tokens.user.user_metadata?.must_change === true) return { kind: 'mustChange' }

    return sessionFromOmsTokens(result.tokens)
  },

  async loginAs(empId) {
    return sessionFromDevLogin(await devLoginAs(empId))
  },

  async renew(session): Promise<RenewOutcome> {
    if (session.devLogin) {
      const result = await devLoginAs(session.employee.emp_id)
      if (result.ok) {
        const outcome = sessionFromDevLogin(result)
        return outcome.kind === 'ok' ? { kind: 'renewed', session: outcome.session } : { kind: 'unavailable' }
      }
      return REJECTING_EXCHANGE_ERRORS.has(result.error) ? { kind: 'rejected' } : { kind: 'unavailable' }
    }

    const refreshed = await omsRefresh(session.oms.refreshToken)
    if (!refreshed.ok) {
      const { status } = refreshed.failure
      return status === 400 || status === 401 || status === 403 ? { kind: 'rejected' } : { kind: 'unavailable' }
    }
    // One exchange, marked a renewal: it does not ask OMS's channel again (#218).
    const exchanged = await exchangeOmsToken(refreshed.tokens.access_token, { renewal: true })
    if (!exchanged.ok) {
      return REJECTING_EXCHANGE_ERRORS.has(exchanged.error) ? { kind: 'rejected' } : { kind: 'unavailable' }
    }
    return { kind: 'renewed', session: sessionFrom(refreshed.tokens, exchanged) }
  },
}
