// OMS's CSA 專用查詢通道 (`csa-channel`, opened 2026-11-23, Q133 (6)(10)): CSA's backend sends up to 200 工號 at a time
// with its own key and OMS answers per person. It cannot search or list, and it counts 5,000 工號 a day. The key and what
// OMS says about people stay on the backend (Vite middleware / Edge Function); what each caller passes on to the browser
// is its own decision (omsMatch.ts: a status; omsPeople.ts: the name of someone a manager looked up by 工號).

/**
 * What a 工號 can be looked up with: letters, digits and . _ - , at most 40 (OMS refuses a whole batch with a longer
 * one); anything else is no 工號 and is 不在 OMS unasked.
 */
export const LOOKABLE = /^[A-Za-z0-9._-]{1,40}$/

/** OMS's limit per call (its reply of 2026-11-23); a bigger batch is refused whole. */
export const CHANNEL_BATCH = 200

/** One row of OMS's answer, as documented by OMS on 2026-11-23 (the fields CSA uses). */
export interface ChannelRow {
  asked: string
  found: boolean
  /** The 工號 as OMS's 主檔 writes it. */
  emp_id: string | null
  status: string | null
  factory_code: string | null
  posting_factory: string | null
  concurrent_factories: string[] | null
  name: string | null
  has_account: boolean | null
  account_active: boolean | null
  csa: boolean | null
}

/** Why OMS gave no answer: no key on this backend, a key OMS refuses, OMS's daily limit, or anything else. */
export class OmsChannelError extends Error {
  // A plain field, not a constructor parameter property: Node's type stripping refuses those, and scripts/demo imports
  // this file without a build step.
  readonly code: 'oms_not_configured' | 'oms_key_rejected' | 'oms_rate_limited' | 'oms_match_failed'
  constructor(code: OmsChannelError['code'], detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

/** OMS's rows for the 工號 asked, keyed by the 工號 in upper case; one that is no 工號 at all is not asked and not in it. */
export type OmsChannel = (empIds: readonly string[]) => Promise<Map<string, ChannelRow>>

/** OMS's channel at `url`, called with `key`; fails whole (OmsChannelError) rather than answering for some. */
export function omsChannel(url: string, key: string, fetchImpl: typeof fetch = fetch): OmsChannel {
  return async (empIds) => {
    if (!url || !key) throw new OmsChannelError('oms_not_configured')
    const ids = [...new Set(empIds.map((id) => id.trim().toUpperCase()))].filter((id) => LOOKABLE.test(id))
    const known = new Map<string, ChannelRow>()
    for (let i = 0; i < ids.length; i += CHANNEL_BATCH) {
      const batch = ids.slice(i, i + CHANNEL_BATCH)
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'x-channel-code': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emp_ids: batch }),
      })
      const body = (await response.json().catch(() => null)) as { ok?: boolean; rows?: ChannelRow[]; error?: string } | null
      if (response.status === 429) throw new OmsChannelError('oms_rate_limited')
      if (response.status === 401) throw new OmsChannelError('oms_key_rejected')
      // Never says why in a way that carries anyone's data: OMS sends none with an error.
      if (!response.ok || body?.ok !== true || body.rows?.length !== batch.length) {
        throw new OmsChannelError('oms_match_failed', `HTTP ${response.status} ${body?.error ?? ''}`.trim())
      }
      // Rows come back in the order asked, one per 工號 (OMS's reply of 2026-11-23); a row for someone else fails all.
      const rows = body.rows
      if (batch.some((id, n) => rows[n]!.asked?.trim().toUpperCase() !== id)) throw new OmsChannelError('oms_match_failed', 'rows out of order')
      batch.forEach((id, n) => known.set(id, rows[n]!))
    }
    return known
  }
}

/** The channel of the OMS project in the settings; without a key it answers oms_not_configured. */
export const omsChannelFromEnv = (env: { OMS_URL: string; OMS_CHANNEL_KEY: string }, fetchImpl: typeof fetch = fetch): OmsChannel =>
  omsChannel(env.OMS_URL ? `${env.OMS_URL.replace(/\/$/, '')}/functions/v1/csa-channel` : '', env.OMS_CHANNEL_KEY, fetchImpl)

/** 在職 / 不在 OMS / 已離職 / 留停 / 轉調 (an old 工號). */
export type Employment = 'active' | 'not_found' | 'departed' | 'on_leave' | 'transferred'

/** OMS's employment statuses, as it spells them. */
const EMPLOYMENT: Record<string, Employment> = { 在職: 'active', 離職: 'departed', 留停: 'on_leave', 轉調: 'transferred' }

/** A status OMS adds later counts as 已離職 until it is given a name here: only 在職 is ever acted on. */
export function employmentOf(row: ChannelRow | undefined): Employment {
  if (!row?.found) return 'not_found'
  return EMPLOYMENT[(row.status ?? '').trim()] ?? 'departed'
}

/**
 * CSA's own 廠區 that OMS does not have (其他廠區, Q139): nobody belongs to it, so anyone 在職 counts as of it. Same code as
 * OTHER_PLANT in src/domain/plantChoice.ts and the 20261208000000 migration (the exchange does not import the app's
 * code): rename all three together.
 */
export const ANY_PLANT_CODES: ReadonlySet<string> = new Set(['OTHER'])

/** Q130 (4): someone is of a 廠區 when it is their 主檔, 派駐 or 兼管 廠區, or the 廠區 is 其他廠區. */
export function isOfPlant(row: ChannelRow, factoryCode: string): boolean {
  const plant = factoryCode.trim().toUpperCase()
  const plants = [row.factory_code, row.posting_factory, ...(row.concurrent_factories ?? [])].map((c) => (c ?? '').toUpperCase())
  return ANY_PLANT_CODES.has(plant) || plants.includes(plant)
}

/** Whether OMS lets them use CSA: 授權頁 has CSA ticked, and their SyncHub account exists and is active. */
export const mayUseCsa = (row: ChannelRow): boolean => row.csa === true && row.has_account === true && row.account_active === true

/** Someone's name to keep in CSA's 員工參照, under the 工號 as OMS's 主檔 writes it. */
export interface PersonName {
  emp_id: string
  name: string
}

/** The names of those OMS has as 在職 among these rows: what CSA keeps a copy of (Q133 (6)). */
export function namesToKeep(rows: Iterable<ChannelRow>): PersonName[] {
  return [...rows].flatMap((row) => {
    const empId = row.emp_id?.trim()
    const name = row.name?.trim()
    return employmentOf(row) === 'active' && empId && name ? [{ emp_id: empId, name }] : []
  })
}

/** Keeps names in CSA; never fails what it is part of (OMS has answered and counted the 工號 by then), only logs. */
export async function keepNames(record: (people: PersonName[]) => Promise<void>, rows: Iterable<ChannelRow>): Promise<void> {
  const people = namesToKeep(rows)
  if (!people.length) return
  await record(people).catch((error: unknown) => console.error('[csa-record-people]', error instanceof Error ? error.message : error))
}

/** The bearer token of an Authorization header, '' without one. */
export const bearer = (header: string | null | undefined) => /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() ?? ''
