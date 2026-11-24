import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { expiresSoon, isExpired, joinRenewal, setRenewer } from './freshToken'
import { omsIdentityProvider } from './omsIdentityProvider'
import { startRenewal } from './renewal'
import { sessionStore } from './sessionStore'
import type { IdentityProvider, LoginOutcome, RenewOutcome, StoredSession } from './types'

interface AuthContextValue {
  session: StoredSession | null
  login(account: string, password: string): Promise<LoginOutcome>
  /** 開發期直接登入 (Q82). */
  loginAs(empId: string): Promise<LoginOutcome>
  logout(): void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({
  children,
  provider = omsIdentityProvider,
}: {
  children: ReactNode
  provider?: IdentityProvider
}) {
  const [session, setSession] = useState<StoredSession | null>(() => sessionStore.load())

  /** Persist and publish the session in one step; null signs out. */
  const commitSession = useCallback((next: StoredSession | null) => {
    if (next) sessionStore.save(next)
    else sessionStore.clear()
    setSession(next)
  }, [])

  const login = useCallback(
    async (account: string, password: string) => {
      const outcome = await provider.login(account, password)
      if (outcome.kind === 'ok') commitSession(outcome.session)
      return outcome
    },
    [provider, commitSession],
  )

  const loginAs = useCallback(
    async (empId: string): Promise<LoginOutcome> => {
      if (!provider.loginAs) return { kind: 'error', messageKey: 'login.error.dev_login_disabled' }
      const outcome = await provider.loginAs(empId)
      if (outcome.kind === 'ok') commitSession(outcome.session)
      return outcome
    },
    [provider, commitSession],
  )

  const logout = useCallback(() => commitSession(null), [commitSession])

  // A layout effect runs before the pages' queries start, so the first request of a page load finds the renewer.
  useLayoutEffect(
    () =>
      setRenewer(async () => {
        const current = sessionStore.load()
        if (!current) return
        const outcome = await provider.renew(current).catch((error: unknown): RenewOutcome => {
          console.error('[csa] session renewal failed', error)
          return { kind: 'unavailable' }
        })
        if (!sessionStore.load()) return // signed out while this was on its way
        if (outcome.kind === 'renewed') commitSession(outcome.session)
        else if (outcome.kind === 'rejected') commitSession(null)
        // 'unavailable': OMS or the exchange is unreachable. Keep the session while
        // its token is still valid; drop it once the token has actually expired.
        else if (isExpired(current)) commitSession(null)
      }),
    [provider, commitSession],
  )

  useEffect(() => {
    if (!session) return
    // Renew right away when the stored CSA token is about to expire: on opening the page, and on coming back to it
    // after a long sleep, when the timer below has stood still.
    const renewIfDue = () => {
      if (expiresSoon(session)) void joinRenewal()
    }
    renewIfDue()
    document.addEventListener('visibilitychange', renewIfDue)
    window.addEventListener('focus', renewIfDue)
    const stopTimer = startRenewal(joinRenewal)
    return () => {
      stopTimer()
      document.removeEventListener('visibilitychange', renewIfDue)
      window.removeEventListener('focus', renewIfDue)
    }
  }, [session])

  const value = useMemo(() => ({ session, login, loginAs, logout }), [session, login, loginAs, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
