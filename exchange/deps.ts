// Real `deps` for the exchange core, built from settings. Only `fetch` and `jose`, no Node APIs, so the Vite dev
// middleware (node.ts) and the demo environments' Supabase Edge Function (web.ts, Deno) share it. Imports carry the
// `.ts` extension because Deno requires it.
import { SignJWT } from 'jose'
import type { EmployeeRef, ExchangeDeps, NameAndPlant, OmsProfile, OmsUser } from './core.ts'
import { omsChannelFromEnv, type PersonName } from './omsChannel.ts'
import { channelMatcher, type OmsMatchDeps } from './omsMatch.ts'
import type { OmsPeopleDeps } from './omsPeople.ts'

/** The secret shipped in .env.example; fine for a developer PC, never for a server. */
export const DEV_DEFAULT_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'

export interface ExchangeEnv {
  OMS_URL: string
  OMS_ANON_KEY: string
  /** PostgREST base URL of the CSA database, e.g. http://127.0.0.1:3000 (or https://<ref>.supabase.co/rest/v1). */
  CSA_REST_URL: string
  /** Sent as `apikey` to CSA_REST_URL. The Supabase gateway requires one; a bare PostgREST ignores it. */
  CSA_REST_APIKEY: string
  CSA_JWT_SECRET: string
  CSA_ACCESS_ALL: string
  CSA_TOKEN_TTL_SECONDS: string
  /** Q82: 'true' serves /csa/dev-login (工號 only, no password). Developer PC only. */
  CSA_DEV_LOGIN: string
  /** The key of OMS's CSA 專用查詢通道 (Q133 (6)). Server-side only: never VITE_-prefixed, never in the browser. */
  OMS_CHANNEL_KEY: string
  /** Q133 (4): 'true' once OMS has ticked CSA for everyone; until then 沒勾 CSA is only pointed out. */
  CSA_REQUIRE_OMS_AUTH: string
}

/**
 * Short-lived token for the exchange's own calls. PostgREST switches to the
 * `service_role` role (bypasses RLS) for a JWT whose role claim says so, which
 * means no separate service key has to be issued or stored.
 */
export function mintServiceToken(secret: string, ttlSeconds = 60): Promise<string> {
  return new SignJWT({ role: 'service_role' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('csa-exchange')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(new TextEncoder().encode(secret))
}

export function depsFromEnv(env: ExchangeEnv, fetchImpl: typeof fetch = fetch): ExchangeDeps {
  if (!env.CSA_JWT_SECRET || env.CSA_JWT_SECRET.length < 32) {
    // A guessable secret would let anyone mint CSA sessions. Refuse to start instead.
    throw new Error('CSA_JWT_SECRET is unset or shorter than 32 characters')
  }
  if (!env.CSA_REST_URL) throw new Error('CSA_REST_URL is unset')
  const accessAll = env.CSA_ACCESS_ALL.trim().toLowerCase() === 'true'
  if (!accessAll && env.CSA_JWT_SECRET === DEV_DEFAULT_JWT_SECRET) {
    // Once admission is enforced (i.e. anything resembling production) the
    // well-known development secret must not be able to mint RLS-bypass tokens.
    throw new Error('CSA_JWT_SECRET is still the development default; generate a new one and rerun `npm run db:keys`')
  }
  const devLogin = env.CSA_DEV_LOGIN.trim().toLowerCase() === 'true'
  if (devLogin && !accessAll) {
    // Dev login mints a session for any 工號 without a password. It only makes sense while
    // admission is wide open anyway (Q62); the moment that is enforced, this must be gone too.
    throw new Error('CSA_DEV_LOGIN=true requires CSA_ACCESS_ALL=true; dev login is a 開發期 tool only')
  }
  const restBase = env.CSA_REST_URL.replace(/\/$/, '')
  const omsHeaders = (token: string) => ({ apikey: env.OMS_ANON_KEY, Authorization: `Bearer ${token}` })

  /** PostgREST query against OMS returning the first row, or null on no row / error. */
  async function omsFirstRow<T>(pathAndQuery: string, token: string): Promise<T | null> {
    const r = await fetchImpl(`${env.OMS_URL}/rest/v1/${pathAndQuery}`, { headers: omsHeaders(token) })
    if (!r.ok) return null
    const rows = (await r.json()) as T[]
    return rows[0] ?? null
  }

  /** Headers for the exchange's own service_role calls to the CSA database. */
  async function csaHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await mintServiceToken(env.CSA_JWT_SECRET)}`,
      'Content-Type': 'application/json',
    }
    if (env.CSA_REST_APIKEY) headers.apikey = env.CSA_REST_APIKEY
    return headers
  }

  return {
    oms: {
      async getUser(accessToken): Promise<OmsUser | null> {
        const r = await fetchImpl(`${env.OMS_URL}/auth/v1/user`, { headers: omsHeaders(accessToken) })
        if (!r.ok) return null
        const u = (await r.json()) as { id?: string; email?: string }
        return u.id && u.email ? { id: u.id, email: u.email } : null
      },
      getProfile(accessToken, userId) {
        return omsFirstRow<OmsProfile>(
          `synchub_profiles?select=emp_id,name,active,role&id=eq.${encodeURIComponent(userId)}`,
          accessToken,
        )
      },
      channel: omsChannelFromEnv(env, fetchImpl),
    },
    csa: {
      async recordEmployee(ref: EmployeeRef) {
        // Refreshes name, 廠區 and 最後登入 (Q98) without touching audit_role, so a role set in CSA stays.
        const r = await fetchImpl(`${restBase}/rpc/record_login`, {
          method: 'POST',
          headers: await csaHeaders(),
          body: JSON.stringify({ p_emp_id: ref.emp_id, p_name: ref.name, p_factory_code: ref.factory_code }),
        })
        if (!r.ok) throw new Error(`record_login failed: HTTP ${r.status} ${await r.text()}`)
        const [kept] = (await r.json()) as NameAndPlant[]
        if (!kept) throw new Error('record_login answered no row')
        return kept
      },
      async isAdmitted(empId: string) {
        const r = await fetchImpl(`${restBase}/rpc/is_admitted`, {
          method: 'POST',
          headers: await csaHeaders(),
          body: JSON.stringify({ p_emp_id: empId }),
        })
        if (!r.ok) throw new Error(`is_admitted failed: HTTP ${r.status} ${await r.text()}`)
        return (await r.json()) === true
      },
    },
    config: {
      accessAll,
      jwtSecret: env.CSA_JWT_SECRET,
      tokenTtlSeconds: Number(env.CSA_TOKEN_TTL_SECONDS) || 3600,
      devLogin,
    },
  }
}

/**
 * OMS 比對 (#180): who may ask is the CSA database's call (can_assign_plant, asked with the caller's own token, which
 * PostgREST verifies); the answer is OMS's CSA 專用查詢通道, on the OMS project itself.
 */
export function omsMatchDepsFromEnv(env: ExchangeEnv, fetchImpl: typeof fetch = fetch): OmsMatchDeps {
  const restBase = env.CSA_REST_URL.replace(/\/$/, '')
  return {
    async canAssignPlant(csaToken, factoryCode) {
      const headers: Record<string, string> = { Authorization: `Bearer ${csaToken}`, 'Content-Type': 'application/json' }
      if (env.CSA_REST_APIKEY) headers.apikey = env.CSA_REST_APIKEY
      const r = await fetchImpl(`${restBase}/rpc/can_assign_plant`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_factory_code: factoryCode }),
      })
      if (r.status === 401) return null
      if (!r.ok) throw new Error(`can_assign_plant failed: HTTP ${r.status} ${await r.text()}`)
      return (await r.json()) === true
    },
    matcher: channelMatcher(omsChannelFromEnv(env, fetchImpl), recordPeopleWith(env, fetchImpl)),
    csaRequired: csaRequiredIn(env),
  }
}

/**
 * 用工號查人 (#218): who may ask, and how many at once, is the CSA database's call (people_lookup_limit, asked with the
 * caller's own token); the answer is OMS's channel; the names of those found are kept in CSA's 員工參照.
 */
export function omsPeopleDepsFromEnv(env: ExchangeEnv, fetchImpl: typeof fetch = fetch): OmsPeopleDeps {
  const restBase = env.CSA_REST_URL.replace(/\/$/, '')
  return {
    async lookupLimit(csaToken) {
      const headers: Record<string, string> = { Authorization: `Bearer ${csaToken}`, 'Content-Type': 'application/json' }
      if (env.CSA_REST_APIKEY) headers.apikey = env.CSA_REST_APIKEY
      const r = await fetchImpl(`${restBase}/rpc/people_lookup_limit`, { method: 'POST', headers, body: '{}' })
      if (r.status === 401) return null
      if (!r.ok) throw new Error(`people_lookup_limit failed: HTTP ${r.status} ${await r.text()}`)
      return Number(await r.json()) || 0
    },
    channel: omsChannelFromEnv(env, fetchImpl),
    recordPeople: recordPeopleWith(env, fetchImpl),
    csaRequired: csaRequiredIn(env),
  }
}

/** CSA_REQUIRE_OMS_AUTH (Q133 (4)): whether someone OMS has not let use CSA is refused, or only pointed out. */
const csaRequiredIn = (env: ExchangeEnv): boolean => env.CSA_REQUIRE_OMS_AUTH.trim().toLowerCase() === 'true'

/** Keeps names in CSA's 員工參照 (record_people) with a short service token; only the backend can. */
function recordPeopleWith(env: ExchangeEnv, fetchImpl: typeof fetch) {
  const restBase = env.CSA_REST_URL.replace(/\/$/, '')
  return async (people: PersonName[]): Promise<void> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${await mintServiceToken(env.CSA_JWT_SECRET)}`, 'Content-Type': 'application/json' }
    if (env.CSA_REST_APIKEY) headers.apikey = env.CSA_REST_APIKEY
    const r = await fetchImpl(`${restBase}/rpc/record_people`, { method: 'POST', headers, body: JSON.stringify({ p_people: people }) })
    // The status only: PostgREST's body could quote what was sent.
    if (!r.ok) throw new Error(`record_people failed: HTTP ${r.status}`)
  }
}

/** Settings from a .env-style source (Vite's loadEnv, process.env, Deno.env.toObject()). */
export function readExchangeEnv(source: Record<string, string | undefined>): ExchangeEnv {
  const pick = (key: string, fallback = '') => source[key] ?? fallback
  return {
    OMS_URL: pick('VITE_OMS_URL'),
    OMS_ANON_KEY: pick('VITE_OMS_ANON_KEY'),
    CSA_REST_URL: pick('CSA_REST_URL', 'http://127.0.0.1:3000'),
    CSA_REST_APIKEY: pick('CSA_REST_APIKEY'),
    CSA_JWT_SECRET: pick('CSA_JWT_SECRET'),
    CSA_ACCESS_ALL: pick('CSA_ACCESS_ALL', 'false'),
    CSA_TOKEN_TTL_SECONDS: pick('CSA_TOKEN_TTL_SECONDS', '3600'),
    CSA_DEV_LOGIN: pick('CSA_DEV_LOGIN', 'false'),
    OMS_CHANNEL_KEY: pick('OMS_CHANNEL_KEY'),
    CSA_REQUIRE_OMS_AUTH: pick('CSA_REQUIRE_OMS_AUTH', 'false'),
  }
}
