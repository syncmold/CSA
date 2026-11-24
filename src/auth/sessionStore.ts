import type { StoredSession } from './types'

const KEY = 'csa.session'

/** Session lives in sessionStorage: closing the tab ends it (Q71, same as OMS). */
export const sessionStore = {
  load(): StoredSession | null {
    try {
      const raw = sessionStorage.getItem(KEY)
      return raw ? (JSON.parse(raw) as StoredSession) : null
    } catch {
      return null
    }
  },
  save(session: StoredSession) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(session))
    } catch {
      /* storage blocked: the user stays signed in for this page view only */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(KEY)
    } catch {
      /* nothing to clear */
    }
  },
}
