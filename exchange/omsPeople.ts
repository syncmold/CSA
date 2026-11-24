// 用工號查人 (#218, Q133 (6)): someone who manages people in CSA types a complete 工號 and the CSA backend asks OMS's
// channel who that is. There is no search by name and no list: OMS's channel has neither, and CSA's own copy of names
// is not to be browsed (使用者 2026-11-23). Who may ask, and how many 工號 at once, is the database's rule
// (people_lookup_limit): 稽核主管 and 系統維護員 a pasted batch, 稽核人員 and 廠區管理員 a few.
//
// The browser gets, per 工號: the employment status, whether OMS lets them use CSA, and, only for someone 在職, the
// name and 主檔廠區 (what the 權限管理 and 簽核流程 screens show before a person is added or picked). The names of
// those found 在職 are kept in CSA's 員工參照, which is what the screens read afterwards (visible_people).
import { bearer, employmentOf, isOfPlant, keepNames, mayUseCsa, OmsChannelError, type Employment, type OmsChannel, type PersonName } from './omsChannel.ts'

/** One 工號 as asked, and what OMS says. `name` and `factory_code` are null unless `status` is active. */
export interface OmsPerson {
  /** The 工號 asked, trimmed and in upper case: what to find this answer by. */
  asked: string
  /** The 工號 as OMS's 主檔 writes it, which is what CSA stores (as login does); `asked` when OMS does not know it. */
  emp_id: string
  status: Employment
  name: string | null
  factory_code: string | null
  /** OMS lets them use CSA (勾了 CSA, with an active SyncHub account); false for anyone not 在職. */
  csa: boolean
  /**
   * Asked for a 廠區 (分派): they are 在職 but it is neither their 主檔, 派駐 nor 兼管 廠區 (Q130 (4): pointed out, never
   * refused). False when no 廠區 was asked about.
   */
  other_plant: boolean
}

export interface OmsPeopleDeps {
  /**
   * How many 工號 the caller, by the CSA session token they sent, may ask about at once; 0 when they may not look
   * people up. Null when the token is not a valid session.
   */
  lookupLimit(csaToken: string): Promise<number | null>
  channel: OmsChannel
  /** Keeps the names in CSA's 員工參照 (service role). */
  recordPeople(people: PersonName[]): Promise<void>
  /**
   * CSA_REQUIRE_OMS_AUTH (Q133 (4)): on, someone OMS has not let use CSA cannot be brought in; off (until OMS has ticked
   * everyone), they are only pointed out. The browser is told which, as the import's preview is.
   */
  csaRequired: boolean
}

/** The most anyone may ask about in one request: one call to OMS. */
export const MAX_LOOKUP = 200

export type OmsPeopleResult =
  | { ok: true; people: OmsPerson[]; csaRequired: boolean }
  | { ok: false; status: 400 | 401 | 403; error: 'invalid_request' | 'too_many' | 'not_signed_in' | 'not_allowed' }

/**
 * POST body { emp_ids, factory_code? }, with the caller's CSA token; each distinct 工號 is asked once. `factory_code`
 * is the 廠區 someone is being assigned in, for `other_plant`.
 */
export async function omsPeople(csaToken: string, body: unknown, deps: OmsPeopleDeps): Promise<OmsPeopleResult> {
  const { emp_ids: empIds, factory_code: factoryCode } = (body ?? {}) as { emp_ids?: unknown; factory_code?: unknown }
  if (!Array.isArray(empIds) || !empIds.every((id) => typeof id === 'string')) return { ok: false, status: 400, error: 'invalid_request' }
  if (factoryCode !== undefined && typeof factoryCode !== 'string') return { ok: false, status: 400, error: 'invalid_request' }
  const plant = factoryCode?.trim() ?? ''
  const ids = [...new Set((empIds as string[]).map((id) => id.trim().toUpperCase()).filter(Boolean))]
  if (ids.length > MAX_LOOKUP) return { ok: false, status: 400, error: 'invalid_request' }
  if (!csaToken) return { ok: false, status: 401, error: 'not_signed_in' }

  const limit = await deps.lookupLimit(csaToken)
  if (limit === null) return { ok: false, status: 401, error: 'not_signed_in' }
  if (limit <= 0) return { ok: false, status: 403, error: 'not_allowed' }
  if (ids.length > limit) return { ok: false, status: 400, error: 'too_many' }

  const rows = await deps.channel(ids)
  const people = ids.map((id): OmsPerson => {
    const row = rows.get(id)
    const status = employmentOf(row)
    if (!row || status !== 'active') return { asked: id, emp_id: id, status, name: null, factory_code: null, csa: false, other_plant: false }
    return {
      asked: id, emp_id: row.emp_id?.trim() || id, status, name: row.name, factory_code: row.factory_code, csa: mayUseCsa(row),
      other_plant: plant !== '' && !isOfPlant(row, plant),
    }
  })
  await keepNames(deps.recordPeople, rows.values())
  return { ok: true, people, csaRequired: deps.csaRequired }
}

/** The HTTP answer to POST …/oms-people, shared by the Vite middleware (node.ts) and the Edge Function (web.ts). */
export async function omsPeopleResponse(
  authorization: string | null | undefined,
  readBody: () => Promise<unknown>,
  deps: OmsPeopleDeps,
): Promise<{ status: number; body: unknown }> {
  let body: unknown
  try {
    body = await readBody()
  } catch {
    return { status: 400, body: { error: 'invalid json' } }
  }
  try {
    const result = await omsPeople(bearer(authorization), body, deps)
    return result.ok
      ? { status: 200, body: { people: result.people, csa_required: result.csaRequired } }
      : { status: result.status, body: { error: result.error } }
  } catch (error) {
    // Never the people's data: only what failed.
    console.error('[csa-oms-people]', error instanceof Error ? error.message : error)
    // Anything else failed on CSA's side (its database, say), not OMS's.
    return { status: 502, body: { error: error instanceof OmsChannelError ? error.code : 'lookup_failed' } }
  }
}
