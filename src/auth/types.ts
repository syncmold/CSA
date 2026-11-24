import type { EmployeeRef } from '../../exchange/core'

export type { EmployeeRef }

/** What the browser keeps between reloads (sessionStorage, like OMS). */
export interface StoredSession {
  oms: {
    accessToken: string
    refreshToken: string
    userId: string
    email: string
  }
  csa: {
    token: string
    expiresAt: string
  }
  employee: EmployeeRef
  issuedAt: string
  /** Q82 開發期直接登入: there are no OMS tokens; renewal goes back to dev login instead of OMS refresh. */
  devLogin?: true
}

export type LoginOutcome =
  | { kind: 'ok'; session: StoredSession }
  | { kind: 'mustChange' }
  | { kind: 'error'; messageKey: string }

/**
 * Result of a 45-minute renewal.
 * - renewed: fresh OMS token re-exchanged for a fresh CSA session.
 * - rejected: OMS or the exchange said no (disabled, demoted, refresh token revoked) → sign out now.
 * - unavailable: could not reach OMS/exchange → keep the current session until it expires.
 */
export type RenewOutcome =
  | { kind: 'renewed'; session: StoredSession }
  | { kind: 'rejected' }
  | { kind: 'unavailable' }

/**
 * 身分提供者 (identity provider) seam. The dev-period implementation is
 * "OMS Auth + 本機換證"; the production one (OPEN-2) replaces how a session is
 * obtained and renewed, nothing above this interface changes.
 */
export interface IdentityProvider {
  login(account: string, password: string): Promise<LoginOutcome>
  /** 開發期直接登入 (Q82): by 工號 alone. Optional: the production provider (OPEN-2) has no such thing. */
  loginAs?(empId: string): Promise<LoginOutcome>
  renew(session: StoredSession): Promise<RenewOutcome>
}
