// 匯入分派表 (#180, Q130; Q147 (6)): the OMS 比對 on the CSA backend and the one write after 確認匯入, to the 簽核流程
// (下次發出) or to an issued 年度's 自評表.
import { freshCsaToken } from '../auth/freshToken'
import type { OmsAnswer } from '../domain/assignmentSheet'
import { env } from '../env'
import { supabase } from './supabase'

/** Served next to the exchange: the Vite middleware locally, the Edge Function on the demo environments. */
const matchUrl = () => `${env.exchangeUrl.replace(/\/$/, '')}/oms-match`

/**
 * The CSA backend's refusal; its message is not_signed_in, not_allowed, oms_not_configured, oms_rate_limited,
 * oms_match_failed, or `HTTP <status>`.
 */
export class OmsMatchError extends Error {}

/**
 * What OMS says about each 工號 for this 廠區, asked by the CSA backend (exchange/omsMatch.ts); the browser never reads
 * OMS's people for this, only a status and whether OMS lets them use CSA. Also whether CSA requires the latter yet
 * (CSA_REQUIRE_OMS_AUTH). Throws when the backend refuses or cannot answer.
 */
export async function matchWithOms(factoryCode: string, empIds: readonly string[]): Promise<{ answers: Map<string, OmsAnswer>; csaRequired: boolean }> {
  const token = await freshCsaToken()
  const response = await fetch(matchUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ factory_code: factoryCode, emp_ids: empIds }),
  })
  type Payload = { results?: ({ emp_id: string } & OmsAnswer)[]; csa_required?: boolean; error?: string }
  const payload = (await response.json().catch(() => ({}))) as Payload
  if (!response.ok || !payload.results) throw new OmsMatchError(payload.error ?? `HTTP ${response.status}`)
  return {
    answers: new Map(payload.results.map((r) => [r.emp_id, { status: r.status, csa: r.csa === true }])),
    csaRequired: payload.csa_required === true,
  }
}

/**
 * 下次發出 (Q147): each cell through assign_route_signer onto the 簽核流程, in one transaction. A route has nothing signed,
 * so nothing is skipped.
 */
export async function importRouteAssignment(cells: readonly { step_id: string; emp_id: string }[]): Promise<{ written: number; skipped: number }> {
  const { data, error } = await supabase.rpc('import_route_assignment', {
    p_cells: cells.map(({ step_id, emp_id }) => ({ route_step_id: step_id, emp_id })),
  })
  if (error) throw error
  return { written: (data as { written: number }).written, skipped: 0 }
}

/** An issued 年度: each cell through assign_step_signer in one transaction; 關卡 signed since the preview are skipped and counted. */
export async function importAssignment(cells: readonly { step_id: string; emp_id: string }[]): Promise<{ written: number; skipped: number }> {
  const { data, error } = await supabase.rpc('import_assignment', { p_cells: cells })
  if (error) throw error
  return data as { written: number; skipped: number }
}
