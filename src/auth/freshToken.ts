import { sessionStore } from './sessionStore'
import type { StoredSession } from './types'

/** Renew this long before the CSA token runs out, so a slow request or a clock slightly off never meets an expired one. */
const EXPIRY_GRACE_MS = 5 * 60 * 1000

export function isExpired(session: StoredSession): boolean {
  return new Date(session.csa.expiresAt).getTime() <= Date.now()
}

export function expiresSoon(session: StoredSession): boolean {
  return new Date(session.csa.expiresAt).getTime() - Date.now() < EXPIRY_GRACE_MS
}

let renewer: (() => Promise<void>) | null = null
let renewalInFlight: Promise<void> | null = null

/** AuthProvider says how to renew; the returned function takes that back. */
export function setRenewer(renew: () => Promise<void>): () => void {
  renewer = renew
  return () => {
    renewer = null
  }
}

/** Starts a renewal, or joins the one on its way: an OMS refresh token works once, so a second use would sign the person out. */
export function joinRenewal(): Promise<void> {
  if (!renewer) return Promise.resolve()
  renewalInFlight ??= renewer().finally(() => {
    renewalInFlight = null
  })
  return renewalInFlight
}

/**
 * The CSA token for the next request. The 45-minute timer stands still while the computer sleeps, so a request can be
 * the first to find the token has run out: it waits for the renewal instead of going out to be refused. A token with
 * a little time left still works, so that request goes ahead and the renewal runs beside it.
 */
export async function freshCsaToken(): Promise<string | null> {
  const session = sessionStore.load()
  if (session && isExpired(session)) await joinRenewal()
  else if (session && expiresSoon(session)) void joinRenewal()
  return sessionStore.load()?.csa.token ?? null
}
