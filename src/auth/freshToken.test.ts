import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { freshCsaToken, joinRenewal, setRenewer } from './freshToken'
import { sessionStore } from './sessionStore'
import type { StoredSession } from './types'

// A request never goes out with a token that has expired: the session may have slept past its 45-minute renewal.

const MINUTE = 60 * 1000

function session(token: string, msLeft: number): StoredSession {
  return {
    oms: { accessToken: '', refreshToken: '', userId: '', email: '' },
    csa: { token, expiresAt: new Date(Date.now() + msLeft).toISOString() },
    employee: { emp_id: 'ZZ0001', name: '測試', factory_code: 'SY' },
    issuedAt: new Date().toISOString(),
  }
}

describe('freshCsaToken', () => {
  let stop: (() => void) | undefined

  beforeEach(() => {
    const stored = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
  })

  afterEach(() => {
    stop?.()
    vi.unstubAllGlobals()
  })

  it('leaves a token with time left alone', async () => {
    sessionStore.save(session('current', 30 * MINUTE))
    const renew = vi.fn(async () => {})
    stop = setRenewer(renew)
    await expect(freshCsaToken()).resolves.toBe('current')
    expect(renew).not.toHaveBeenCalled()
  })

  it('waits for the renewal when the token has expired', async () => {
    sessionStore.save(session('expired', -MINUTE))
    stop = setRenewer(async () => sessionStore.save(session('renewed', 60 * MINUTE)))
    await expect(freshCsaToken()).resolves.toBe('renewed')
  })

  it('renews once for requests that arrive together', async () => {
    sessionStore.save(session('expired', -MINUTE))
    const renew = vi.fn(async () => sessionStore.save(session('renewed', 60 * MINUTE)))
    stop = setRenewer(renew)
    await expect(Promise.all([freshCsaToken(), freshCsaToken(), joinRenewal()])).resolves.toEqual(['renewed', 'renewed', undefined])
    expect(renew).toHaveBeenCalledTimes(1)
  })

  it('renews again the next time the token runs out', async () => {
    sessionStore.save(session('expired', -MINUTE))
    const renew = vi.fn(async () => {})
    stop = setRenewer(renew)
    await freshCsaToken()
    await freshCsaToken()
    expect(renew).toHaveBeenCalledTimes(2)
  })

  it('has no token once the renewal signs the person out', async () => {
    sessionStore.save(session('expired', -MINUTE))
    stop = setRenewer(async () => sessionStore.clear())
    await expect(freshCsaToken()).resolves.toBeNull()
  })

  it('does not hold a request back while the token still works', async () => {
    sessionStore.save(session('almost', MINUTE))
    const renew = vi.fn(() => new Promise<void>(() => {}))
    stop = setRenewer(renew)
    await expect(freshCsaToken()).resolves.toBe('almost')
    expect(renew).toHaveBeenCalledTimes(1)
  })

  it('has nothing to do before anyone is signed in', async () => {
    await expect(freshCsaToken()).resolves.toBeNull()
  })
})
