// 本機換證 core: OMS access token → CSA session token.
//
// This is the replaceable seam for OPEN-2 (OMS 登入通道) and OPEN-4 (正式換證).
// It is framework-free: adapters (node.ts for the Vite dev server, web.ts for
// the demo environments' Supabase Edge Function, Q97) supply `deps` and expose
// it over HTTP. Only this file knows the admission rules; everything else just
// carries the token.
import { SignJWT } from 'jose'
import { ADMIN_EMAIL, ADMIN_EMP_ID, ADMIN_NAME } from './adminAccount.ts'
import { employmentOf, OmsChannelError, type ChannelRow, type OmsChannel } from './omsChannel.ts'

export interface OmsUser {
  id: string
  email: string
}

/**
 * The signed-in person's own row of OMS's `oms_my_access` (Q133 (2)(5)), as OMS answered it on 2026-11-24:
 * `[{ emp_id, name, factory_code, active, systems }]`. It replaced reading `synchub_profiles` (renamed by OMS).
 */
export interface OmsAccess {
  emp_id: string | number | null
  name: string | null
  /** 主檔廠區. */
  factory_code: string | null
  active: boolean | null
  /** The 系統代號 OMS's 授權頁 has ticked for them; CSA's own is CSA_SYSTEM_CODE, read while CSA_REQUIRE_OMS_AUTH is on (Q133 (4)). */
  systems: string[] | null
}

/** CSA's 系統代號 on OMS's 授權頁 (Q133 (1)): whoever has it ticked may use CSA. */
const CSA_SYSTEM_CODE = 'CSA'

/**
 * OMS has ticked CSA for them. `systems` is OMS's to shape and was only seen as a list: it is read loosely (a list or
 * one delimited text; case and spaces), and anything else is no tick rather than an error. Another system's code is
 * never CSA's.
 */
function csaEnabledIn(systems: unknown): boolean {
  const codes: unknown[] = Array.isArray(systems) ? systems : typeof systems === 'string' ? systems.split(/[\s,;]+/) : []
  return codes.some((code) => typeof code === 'string' && code.trim().toUpperCase() === CSA_SYSTEM_CODE)
}

/** A person as the screens show one: 工號, 姓名 and 主檔廠區 (once the row of OMS's old `employees_picker`). */
export interface PickerRow {
  emp_id: string
  name: string
  factory_code: string
}

/** The row CSA keeps about an employee it has seen; name/plant come from OMS. */
export interface EmployeeRef {
  emp_id: string
  name: string | null
  factory_code: string | null
}

/** 姓名 and 主檔廠區 of someone, null where unknown. */
export type NameAndPlant = Pick<EmployeeRef, 'name' | 'factory_code'>

export interface ExchangeDeps {
  oms: {
    /** Verify the token with OMS Auth; null when OMS rejects it. Read only. */
    getUser(accessToken: string): Promise<OmsUser | null>
    /** The user's own `oms_my_access` row, asked with the user's own token; null when OMS answers none, throws when OMS fails. */
    getAccess(accessToken: string): Promise<OmsAccess | null>
    /** OMS's CSA 專用查詢通道 (#218), asked with the backend's own key: only 開發期直接登入 uses it, having no OMS token. */
    channel: OmsChannel
  }
  csa: {
    /** Writes 姓名, 廠區 and 最後登入; answers the 姓名 and 廠區 CSA keeps, which are the old ones where `ref` has none. */
    recordEmployee(ref: EmployeeRef): Promise<NameAndPlant>
    /** 放行名單 (Q97): is this 工號 on CSA's own access list? Asked only when accessAll is false. */
    isAdmitted(empId: string): Promise<boolean>
  }
  config: {
    /** Q62: 開發期放行全開. Must be false on anything other than a developer PC. */
    accessAll: boolean
    jwtSecret: string
    tokenTtlSeconds: number
    /** Q82: 開發期直接登入 (devLoginAs) is served at all. Never true outside a developer PC. */
    devLogin: boolean
    /**
     * CSA_REQUIRE_OMS_AUTH (Q133 (2)(4)). On: OMS's 授權頁 decides who signs in (its CSA tick), and CSA's 放行名單 is
     * not asked any more, it only carries roles. Off: as before, the 放行名單 (or 全開) decides and the tick only
     * rides along in the answer (`csaEnabled`). The same switch as omsMatch's and omsPeople's `csaRequired`.
     */
    csaRequired: boolean
  }
  now?: () => Date
}

export type ExchangeError =
  | 'oms_token_invalid'
  /** OMS has no `oms_my_access` row (or no 工號) for them; the name is older than oms_my_access and kept for the browser. */
  | 'profile_not_found'
  | 'account_disabled'
  | 'not_authorized'
  /** CSA_REQUIRE_OMS_AUTH is on and OMS's 授權頁 has not ticked CSA for them (Q133 (2)). */
  | 'csa_not_enabled'
  | 'dev_login_disabled'
  | 'oms_unavailable'

export type ExchangeResult =
  /** `csaEnabled`: what OMS answered about the CSA tick, whether or not the switch asks for it; it lets an environment be checked before the switch is turned on. */
  | { ok: true; csaToken: string; expiresAt: string; employee: EmployeeRef; csaEnabled: boolean }
  | { ok: false; status: 401 | 403 | 404 | 502; error: ExchangeError }

export async function exchange(omsAccessToken: string, deps: ExchangeDeps): Promise<ExchangeResult> {
  const user = await deps.oms.getUser(omsAccessToken)
  if (!user) return { ok: false, status: 401, error: 'oms_token_invalid' }

  const access = await deps.oms.getAccess(omsAccessToken)
  const adminAccount = user.email.trim().toLowerCase() === ADMIN_EMAIL
  if (!access || (!adminAccount && (access.emp_id == null || access.emp_id === ''))) {
    return { ok: false, status: 403, error: 'profile_not_found' }
  }
  if (access.active === false) return { ok: false, status: 403, error: 'account_disabled' }
  const csaEnabled = csaEnabledIn(access.systems)

  if (adminAccount) {
    // Not on the 放行名單 and never asked (Q122 (5)), nor is its 系統代號 with CSA_REQUIRE_OMS_AUTH on: it is not an
    // employee OMS ticks systems for (待 OMS 確認, Q133 (2)). The session's admin_account claim is what the database trusts.
    // No employee_ref row is written: it is not an employee, and the database refuses one for its 工號.
    const employee: EmployeeRef = { emp_id: ADMIN_EMP_ID, name: ADMIN_NAME, factory_code: null }
    const session = await mintSession(employee, user.id, { source: 'oms', admin_account: true }, deps)
    return { ok: true, ...session, employee, csaEnabled }
  }

  const empId = String(access.emp_id)
  // Two keys, both needed (Q150): OMS's tick, while CSA_REQUIRE_OMS_AUTH asks for it (Q133 (2)), which 全開 does not
  // override; and the 放行名單, which only a 系統維護員 fills (being assigned no longer lets anyone in). A renewal comes
  // through here too, so someone OMS unticks or the 系統維護員 removes is out at their next renewal (Q133 (1)).
  // 全開 (CSA_ACCESS_ALL, development only, refused when deployed) skips the 放行名單 but never the OMS tick.
  if (deps.config.csaRequired && !csaEnabled) return { ok: false, status: 403, error: 'csa_not_enabled' }
  if (!deps.config.accessAll && !(await deps.csa.isAdmitted(empId))) return { ok: false, status: 403, error: 'not_authorized' }

  // 姓名 and 主檔廠區 from OMS's own answer (Q133 (5)), at every exchange: it costs none of the channel's daily 工號.
  // One OMS leaves empty keeps what CSA has (record_login).
  const kept = await deps.csa.recordEmployee({ emp_id: empId, ...nameAndPlantOf(access) })
  const employee: EmployeeRef = { emp_id: empId, ...kept }

  const session = await mintSession(employee, user.id, { source: 'oms' }, deps)
  return { ok: true, ...session, employee, csaEnabled }
}

/** 姓名 and 主檔廠區 as OMS's row writes them. */
function nameAndPlantOf(row: NameAndPlant | undefined): NameAndPlant {
  return { name: row?.name?.trim() || null, factory_code: row?.factory_code?.trim() || null }
}

/**
 * 開發期直接登入 (Q82): a CSA session for any 工號 OMS has as 在職, with no password.
 * Exists so one developer can walk a 10-關 route alone; it is refused unless
 * `config.devLogin` is on, which `depsFromEnv` only allows together with 放行全開.
 * The token is marked `source: 'dev'` so RLS or logs can tell it apart later.
 */
export async function devLoginAs(empId: string, deps: ExchangeDeps): Promise<ExchangeResult> {
  if (!deps.config.devLogin) return { ok: false, status: 404, error: 'dev_login_disabled' }
  // Asked through OMS's channel (#218), as anyone typed: it answers in OMS's 主檔 spelling, which is what is stored.
  // No answer from OMS (no OMS_CHANNEL_KEY on this PC, OMS's daily limit) is said as such, not as a missing person.
  const wanted = empId.trim().toUpperCase()
  let row: ChannelRow | undefined
  try {
    row = wanted ? (await deps.oms.channel([wanted])).get(wanted) : undefined
  } catch (error) {
    if (!(error instanceof OmsChannelError)) throw error
    console.error('[csa-dev-login] OMS channel:', error.message)
    return { ok: false, status: 502, error: 'oms_unavailable' }
  }
  if (!row || employmentOf(row) !== 'active') return { ok: false, status: 403, error: 'profile_not_found' }
  // The same switch as signing in with a password, from the channel's own answer about the tick.
  const csaEnabled = row.csa === true
  if (deps.config.csaRequired && !csaEnabled) return { ok: false, status: 403, error: 'csa_not_enabled' }

  const recorded: EmployeeRef = { emp_id: row.emp_id?.trim() || wanted, ...nameAndPlantOf(row) }
  const employee: EmployeeRef = { emp_id: recorded.emp_id, ...(await deps.csa.recordEmployee(recorded)) }
  const session = await mintSession(employee, devSubject(employee.emp_id), { source: 'dev' }, deps)
  return { ok: true, ...session, employee, csaEnabled }
}

async function mintSession(
  employee: EmployeeRef,
  subject: string,
  extra: { source: 'oms' | 'dev'; admin_account?: true },
  deps: ExchangeDeps,
): Promise<{ csaToken: string; expiresAt: string }> {
  const now = (deps.now ?? (() => new Date()))()
  const iat = Math.floor(now.getTime() / 1000)
  const exp = iat + deps.config.tokenTtlSeconds

  const csaToken = await new SignJWT({ role: 'authenticated', app_metadata: { ...employee, ...extra } })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(subject)
    .setAudience('authenticated')
    .setIssuer('csa-exchange')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(deps.config.jwtSecret))

  return { csaToken, expiresAt: new Date(exp * 1000).toISOString() }
}

/** A stable, uuid-shaped `sub` per 工號: Supabase's auth.uid() insists on a uuid. */
function devSubject(empId: string): string {
  const hex = Array.from(new TextEncoder().encode(empId), (b) => b.toString(16).padStart(2, '0')).join('')
  return `00000000-0000-4000-8000-${hex.padEnd(12, '0').slice(-12)}`
}
