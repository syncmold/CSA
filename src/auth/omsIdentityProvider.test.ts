import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExchangeResponse } from '../api/exchange'
import type { OmsTokens } from '../api/omsAuth'
import type { StoredSession } from './types'

// Renewing an OMS session (#218): one exchange per renewal (an OMS refresh token works once).

const exchangeOmsToken = vi.fn<(token: string) => Promise<ExchangeResponse>>()
const omsRefresh = vi.fn()
vi.mock('../api/exchange', () => ({ exchangeOmsToken: (...args: Parameters<typeof exchangeOmsToken>) => exchangeOmsToken(...args), devLoginAs: vi.fn() }))
vi.mock('../api/omsAuth', () => ({ omsRefresh: (...args: unknown[]) => omsRefresh(...args), omsPasswordLogin: vi.fn() }))

const { omsIdentityProvider } = await import('./omsIdentityProvider')

const TOKENS = { access_token: 'new-access', refresh_token: 'new-refresh', user: { id: 'uuid-1', email: 'zz0001@id.syncmold.com.tw' } } as OmsTokens
const EMPLOYEE = { emp_id: 'ZZ0001', name: '測試', factory_code: 'SY' }
const HELD: StoredSession = {
  oms: { accessToken: 'old-access', refreshToken: 'old-refresh', userId: 'uuid-1', email: 'zz0001@id.syncmold.com.tw' },
  csa: { token: 'old-csa', expiresAt: '2026-11-23T10:00:00Z' },
  employee: EMPLOYEE,
  issuedAt: '2026-11-23T09:00:00Z',
}

beforeEach(() => {
  exchangeOmsToken.mockReset()
  omsRefresh.mockReset().mockResolvedValue({ ok: true, tokens: TOKENS })
})

describe('omsIdentityProvider.renew', () => {
  it('exchanges the refreshed OMS token once and keeps the new tokens', async () => {
    exchangeOmsToken.mockResolvedValue({ ok: true, csaToken: 'new-csa', expiresAt: '2026-11-23T11:00:00Z', employee: EMPLOYEE })
    const outcome = await omsIdentityProvider.renew(HELD)
    expect(exchangeOmsToken.mock.calls).toEqual([['new-access']])
    expect(outcome).toMatchObject({
      kind: 'renewed',
      session: { oms: { accessToken: 'new-access', refreshToken: 'new-refresh' }, csa: { token: 'new-csa' }, employee: EMPLOYEE },
    })
  })

  it('is rejected when the exchange refuses the person, and only unavailable when the exchange is down', async () => {
    exchangeOmsToken.mockResolvedValue({ ok: false, error: 'not_authorized' })
    expect(await omsIdentityProvider.renew(HELD)).toEqual({ kind: 'rejected' })
    exchangeOmsToken.mockResolvedValue({ ok: false, error: 'exchange_failed' })
    expect(await omsIdentityProvider.renew(HELD)).toEqual({ kind: 'unavailable' })
    expect(exchangeOmsToken).toHaveBeenCalledTimes(2)
  })
})
