// OMS roster lookup with the anon key: `employees_picker` (no email, Q70). The 年度發起's 在職 check moved to OMS's
// channel through the CSA backend (Q147 (4), api/people.ts); only the single-工號 lookup below is left here.
import { env } from '../env'
import type { PickerRow } from '../../exchange/core'

const PICKER = `${env.omsUrl}/rest/v1/employees_picker?select=emp_id,name,factory_code`

/** OMS did not answer: unreachable, or refused the read (e.g. HTTP 401 when the anon key loses its grant). */
export class OmsUnavailableError extends Error {}

/** One read of an OMS view with the anon key; anything but a 2xx answer is an {@link OmsUnavailableError}. */
async function readOms<T>(url: string, what: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { headers: { apikey: env.omsAnonKey, Authorization: `Bearer ${env.omsAnonKey}` } })
  } catch (error) {
    throw new OmsUnavailableError(`${what} lookup failed: ${String(error)}`)
  }
  if (!response.ok) throw new OmsUnavailableError(`${what} lookup failed: HTTP ${response.status}`)
  return (await response.json()) as T
}

export async function lookupEmployee(empId: string): Promise<PickerRow | null> {
  const rows = await readOms<PickerRow[]>(`${PICKER}&emp_id=ilike.${encodeURIComponent(empId)}&limit=1`, 'employees_picker')
  return rows[0] ?? null
}
