// Whether someone OMS was asked about may be brought into CSA (added to 權限管理, picked as a 簽核人, 分派'd), and what
// to point out when they are (#218; Q130 (4), Q133 (4)(6)). Pure: the answer itself comes from the CSA backend
// (src/api/people.ts). The same rules as the 分派表 import's (src/domain/assignmentSheet.ts).
import type { LookedUpPerson } from '../api/people'

/** Brought in all the same, and said: OMS has not enabled CSA for them yet; they are of another 廠區. */
export type Reminder = 'no_csa' | 'other_plant'

/** Why someone is not brought in: OMS has no such 工號, they are not 在職, or CSA must be enabled first and is not. */
export type Refusal = 'not_found' | 'departed' | 'on_leave' | 'transferred' | 'no_csa'

export type BringIn = { ok: true; reminders: Reminder[] } | { ok: false; reason: Refusal }

/**
 * Only someone 在職 is brought in. OMS not having enabled CSA for them is pointed out while CSA_REQUIRE_OMS_AUTH is off
 * and refuses them once it is on; another 廠區 is only ever pointed out. Nothing known about the 工號 is 不在 OMS.
 */
export function bringIn(person: LookedUpPerson | null | undefined): BringIn {
  if (!person) return { ok: false, reason: 'not_found' }
  if (person.status !== 'active') return { ok: false, reason: person.status }
  if (!person.csa && person.csaRequired) return { ok: false, reason: 'no_csa' }
  return { ok: true, reminders: [...(person.csa ? [] : ['no_csa' as const]), ...(person.other_plant ? ['other_plant' as const] : [])] }
}
