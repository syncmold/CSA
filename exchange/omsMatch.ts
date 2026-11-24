// OMS 比對 (#180, Q130 (3)④(6)): what OMS says about each 工號 of a 分派表, for this 廠區, asked through OMS's CSA
// 專用查詢通道 (omsChannel.ts). The browser only gets a status and one yes/no per 工號.
import { bearer, employmentOf, isOfPlant, keepNames, mayUseCsa, OmsChannelError, type ChannelRow, type OmsChannel, type PersonName } from './omsChannel.ts'

export { ANY_PLANT_CODES, bearer, CHANNEL_BATCH, LOOKABLE, OmsChannelError, type ChannelRow } from './omsChannel.ts'

/**
 * 對得上 / 廠區不同 (not this plant's, nor posted or 兼管 here) / 不在 OMS / 已離職 / 留停 / 轉調 (an old 工號).
 * Same list as src/domain/assignmentSheet.ts.
 */
export type OmsMatchStatus = 'matched' | 'other_plant' | 'not_found' | 'departed' | 'on_leave' | 'transferred'

/** One person's answer: the status, and whether OMS lets them use CSA (勾了 CSA, with an active SyncHub account). */
export interface OmsMatchAnswer {
  status: OmsMatchStatus
  csa: boolean
}

export interface OmsMatcher {
  /** One answer per 工號 asked, all for the one 廠區. */
  match(factoryCode: string, empIds: readonly string[]): Promise<Map<string, OmsMatchAnswer>>
}

const NOT_FOUND: OmsMatchAnswer = { status: 'not_found', csa: false }

/**
 * Q130 (4): someone 在職 is 對得上 when this 廠區 is their 主檔, 派駐 or 兼管 廠區 (or it is 其他廠區), else 廠區不同.
 * Any other OMS status than 在職 is not written.
 */
export function answerOf(row: ChannelRow, factoryCode: string): OmsMatchAnswer {
  const employment = employmentOf(row)
  if (employment !== 'active') return { status: employment, csa: false }
  return { status: isOfPlant(row, factoryCode) ? 'matched' : 'other_plant', csa: mayUseCsa(row) }
}

/**
 * The matcher over OMS's channel: each 工號 asked once, answered as asked; one that is no 工號 is 不在 OMS. The names of
 * those 在職 go to `recordPeople` (CSA's 員工參照, #218), so whoever a 分派表 brings in has a name on screen before they
 * first log in; the names themselves are not part of the answer.
 */
export function channelMatcher(channel: OmsChannel, recordPeople?: (people: PersonName[]) => Promise<void>): OmsMatcher {
  return {
    async match(factoryCode, empIds) {
      const rows = await channel(empIds)
      if (recordPeople) await keepNames(recordPeople, rows.values())
      return new Map(empIds.map((id) => {
        const row = rows.get(id.trim().toUpperCase())
        return [id, row ? answerOf(row, factoryCode) : NOT_FOUND]
      }))
    },
  }
}

export interface OmsMatchDeps {
  /**
   * May the caller, by the CSA session token they sent, assign this 廠區 (廠區管理員 of it, 稽核管理者, 系統維護員)?
   * Asked of the CSA database with the caller's own token, so the rule is the database's (can_assign_plant). Null when
   * the token is not a valid CSA session.
   */
  canAssignPlant(csaToken: string, factoryCode: string): Promise<boolean | null>
  matcher: OmsMatcher
  /**
   * CSA_REQUIRE_OMS_AUTH (Q133 (4)): on, someone OMS has not let use CSA is not written; off (until OMS has ticked
   * everyone), they are only pointed out. The browser is told which, so the preview says what will happen.
   */
  csaRequired: boolean
}

/** More than a plant's whole 分派表 ever has; a bigger batch is refused rather than sent on. */
export const MAX_PEOPLE = 2000

export type OmsMatchResult =
  | { ok: true; results: ({ emp_id: string } & OmsMatchAnswer)[]; csaRequired: boolean }
  | { ok: false; status: 400 | 401 | 403; error: 'invalid_request' | 'not_signed_in' | 'not_allowed' }

/** POST body { factory_code, emp_ids }, with the caller's CSA token; each distinct 工號 is asked once. */
export async function omsMatch(csaToken: string, body: unknown, deps: OmsMatchDeps): Promise<OmsMatchResult> {
  const { factory_code: factoryCode, emp_ids: empIds } = (body ?? {}) as { factory_code?: unknown; emp_ids?: unknown }
  if (typeof factoryCode !== 'string' || !factoryCode.trim() || !Array.isArray(empIds) || !empIds.every((id) => typeof id === 'string')) {
    return { ok: false, status: 400, error: 'invalid_request' }
  }
  const ids = [...new Set((empIds as string[]).map((id) => id.trim()).filter(Boolean))]
  if (ids.length > MAX_PEOPLE) return { ok: false, status: 400, error: 'invalid_request' }
  if (!csaToken) return { ok: false, status: 401, error: 'not_signed_in' }

  const allowed = await deps.canAssignPlant(csaToken, factoryCode.trim())
  if (allowed === null) return { ok: false, status: 401, error: 'not_signed_in' }
  if (!allowed) return { ok: false, status: 403, error: 'not_allowed' }

  const answers = await deps.matcher.match(factoryCode.trim(), ids)
  const results = ids.map((id) => ({ emp_id: id, ...(answers.get(id) ?? NOT_FOUND) }))
  return { ok: true, results, csaRequired: deps.csaRequired }
}

/** The HTTP answer to POST …/oms-match, shared by the Vite middleware (node.ts) and the Edge Function (web.ts). */
export async function omsMatchResponse(
  authorization: string | null | undefined,
  readBody: () => Promise<unknown>,
  deps: OmsMatchDeps,
): Promise<{ status: number; body: unknown }> {
  let body: unknown
  try {
    body = await readBody()
  } catch {
    return { status: 400, body: { error: 'invalid json' } }
  }
  try {
    const result = await omsMatch(bearer(authorization), body, deps)
    return result.ok
      ? { status: 200, body: { results: result.results, csa_required: result.csaRequired } }
      : { status: result.status, body: { error: result.error } }
  } catch (error) {
    console.error('[csa-oms-match]', error)
    return { status: 502, body: { error: error instanceof OmsChannelError ? error.code : 'oms_match_failed' } }
  }
}
