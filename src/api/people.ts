// People (#218, Q133 (6)): names come from CSA's own copy, read through visible_people, which only gives the caller the
// people they may see; and someone who manages people can ask OMS about a complete 工號 through the CSA backend
// (exchange/omsPeople.ts). The browser never reads OMS's people itself, and nothing here searches by name.
import type { PickerRow } from '../../exchange/core'
import type { OmsPerson } from '../../exchange/omsPeople'
import { freshCsaToken } from '../auth/freshToken'
import { env } from '../env'
import { supabase } from './supabase'

export type { OmsPerson }

/** 姓名 (and the 廠區 CSA happens to know) of these 工號, as far as the signed-in person may see them; others are absent. */
export async function fetchPeopleNames(empIds: readonly string[]): Promise<PickerRow[]> {
  // As stored (OMS's own spelling, the way login and 分派 keep it): no case folding here.
  const ids = [...new Set(empIds)]
  if (!ids.length) return []
  const { data, error } = await supabase.rpc('visible_people').in('emp_id', ids)
  if (error) throw error
  return ((data ?? []) as { emp_id: string; name: string | null; factory_code: string | null }[]).flatMap((p) =>
    p.name ? [{ emp_id: p.emp_id, name: p.name, factory_code: p.factory_code ?? '' }] : [],
  )
}

/** Served next to the exchange: the Vite middleware locally, the Edge Function on the deployed environments. */
const lookupUrl = () => `${env.exchangeUrl.replace(/\/$/, '')}/oms-people`

/**
 * The CSA backend's refusal; its message is not_signed_in, not_allowed, too_many, oms_not_configured, oms_key_rejected,
 * oms_rate_limited, oms_match_failed, lookup_failed, or `HTTP <status>`.
 */
export class PeopleLookupError extends Error {}

/** Whether the failure is OMS itself not answering (down, over its daily limit, key trouble) rather than CSA refusing. */
export const omsCouldNotAnswer = (error: unknown): boolean => error instanceof PeopleLookupError && error.message.startsWith('oms_')

/** What OMS says about one 工號, and whether CSA requires OMS to have enabled CSA for them yet (CSA_REQUIRE_OMS_AUTH). */
export type OmsLookedUpPerson = OmsPerson & { csaRequired: boolean }

/**
 * That, and whether they are on CSA's 放行名單 right now (Q150: only they may be put on a 關卡). OMS's answer is kept a
 * while (it counts against OMS's daily limit); `listed` is asked afresh each time, so someone just let in is not
 * refused (useLookUpPeople).
 */
export type LookedUpPerson = OmsLookedUpPerson & { listed: boolean }

/**
 * Which of these 工號 are on the 放行名單, in capitals (Q150): asked before someone is put on a 關卡, so the page says so
 * rather than the database refusing the save. Only for those who may look people up; for others it is empty.
 */
export async function listedEmpIds(empIds: readonly string[]): Promise<Set<string>> {
  if (!empIds.length) return new Set()
  const { data, error } = await supabase.rpc('listed_emp_ids', { p_emp_ids: [...new Set(empIds)] })
  if (error) throw error
  return new Set((data ?? []) as string[])
}

/** Whether `empId` is among `listed` (listedEmpIds), whatever its case. */
export const isListed = (listed: ReadonlySet<string>, empId: string): boolean => listed.has(empId.trim().toUpperCase())

/**
 * What OMS says about each complete 工號, asked by the CSA backend; one row per distinct 工號, found by its `asked`.
 * `factoryCode` is the 廠區 someone is being assigned in, for `other_plant`.
 */
export async function lookUpPeople(empIds: readonly string[], factoryCode?: string): Promise<OmsLookedUpPerson[]> {
  if (!empIds.length) return []
  const token = await freshCsaToken()
  const response = await fetch(lookupUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ emp_ids: empIds, ...(factoryCode ? { factory_code: factoryCode } : {}) }),
  })
  const payload = (await response.json().catch(() => ({}))) as { people?: OmsPerson[]; csa_required?: boolean; error?: string }
  if (!response.ok || !payload.people) throw new PeopleLookupError(payload.error ?? `HTTP ${response.status}`)
  const csaRequired = payload.csa_required === true
  return payload.people.map((person) => ({ ...person, other_plant: person.other_plant === true, csaRequired }))
}
