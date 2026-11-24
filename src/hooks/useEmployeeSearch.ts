import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AssessmentView } from '../api/assessments'
import { plantFormPeople } from '../api/assignment'
import { useAuth } from '../auth/AuthContext'
import { fetchPeopleNames, lookUpPeople, type LookedUpPerson } from '../api/people'
import { useDebounced } from './useDebounced'

const FIVE_MINUTES = 5 * 60 * 1000

/** Long enough to be a complete 工號, and nothing a 工號 cannot have (the backend's LOOKABLE); anything else is not asked. */
export const COMPLETE_EMP_ID = /^[A-Za-z0-9._-]{3,40}$/
/** The most 工號 one request may hold (exchange/omsPeople.ts MAX_LOOKUP); more are asked in turn. */
const LOOKUP_BATCH = 200

/**
 * What OMS says about complete 工號, asked through the CSA backend (#218). Each 工號 OMS is asked about counts against
 * its daily limit, so an answer is kept per person, per signed-in user and per 廠區 asked about: correcting one 工號 in a
 * pasted list asks about that one only. A 工號 that cannot be complete is not asked and is missing from the answer.
 * `factoryCode` is the 廠區 someone is being assigned in (for `other_plant`); none when there is no 廠區 to compare.
 */
export function useLookUpPeople(factoryCode = '') {
  const client = useQueryClient()
  const { session } = useAuth()
  const me = session?.employee.emp_id
  return async (empIds: readonly string[]): Promise<LookedUpPerson[]> => {
    const ids = [...new Set(empIds.map((id) => id.trim().toUpperCase()))].filter((id) => COMPLETE_EMP_ID.test(id))
    const key = (id: string) => ['people', 'person', me, factoryCode, id]
    const fresh = (id: string) => (client.getQueryState(key(id))?.dataUpdatedAt ?? 0) > Date.now() - FIVE_MINUTES
    const missing = ids.filter((id) => !fresh(id))
    for (let i = 0; i < missing.length; i += LOOKUP_BATCH) {
      for (const person of await lookUpPeople(missing.slice(i, i + LOOKUP_BATCH), factoryCode || undefined)) client.setQueryData(key(person.asked), person)
    }
    return ids.flatMap((id) => client.getQueryData<LookedUpPerson>(key(id)) ?? [])
  }
}

/**
 * A picker's look-up (#218): the one person a complete 工號 belongs to, asked of OMS through the CSA backend. No search
 * by name or by part of a 工號: OMS's channel has none, and each 工號 asked counts against its daily limit, so the wait
 * before asking is long enough to finish typing. `person` only ever belongs to the text typed right now.
 */
export function usePersonLookup(term: string, factoryCode = ''): { person: LookedUpPerson | null; searching: boolean; error: string | null } {
  const typed = term.trim().toUpperCase()
  const candidate = useDebounced(typed, 800)
  const complete = COMPLETE_EMP_ID.test(candidate)
  const query = usePeopleLookup(complete ? [candidate] : [], factoryCode)
  const current = typed === candidate && complete && query.data !== undefined && !query.isFetching
  return {
    person: current ? (query.data![0] ?? null) : null,
    searching: COMPLETE_EMP_ID.test(typed) && !current && !query.isError,
    error: typed === candidate && query.isError ? (query.error instanceof Error ? query.error.message : String(query.error)) : null,
  }
}

/** 權限管理's 加入 (#218): what OMS says about each complete 工號 pasted; a 工號 that cannot be one is not in the answer. */
export function usePeopleLookup(empIds: readonly string[], factoryCode = '') {
  const { session } = useAuth()
  const lookUp = useLookUpPeople(factoryCode)
  const ids = [...new Set(empIds.map((id) => id.trim().toUpperCase()))].sort()
  return useQuery({
    // Who may look people up is the database's rule: keyed by who is signed in.
    queryKey: ['people', 'lookup', session?.employee.emp_id, factoryCode, ids],
    queryFn: () => lookUp(ids),
    enabled: ids.length > 0,
    // The per-person answers above are what is kept; this only puts them together for the list asked now.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
}

/** The key of every plant's picker list: 分派 refreshes them when someone is assigned (useAssignStep). */
export const PLANT_PEOPLE = ['plant-people'] as const

/** 分派's picker (#218): the people already on this plant's 自評表, as far as the signed-in person may assign it. */
export function usePlantPeople(factoryCode: string) {
  const { session } = useAuth()
  return useQuery({
    // Who may list a plant's people is the database's rule: keyed by who is signed in.
    queryKey: [...PLANT_PEOPLE, session?.employee.emp_id, factoryCode],
    queryFn: () => plantFormPeople(factoryCode),
    // Whoever was just assigned belongs on the list the next time it opens.
    staleTime: 0,
  })
}

/**
 * The 自評表's 簽核人 names, as fetchAssessment read them from CSA's own copy (#218): whoever sees the 自評表 sees them.
 * Someone who has neither logged in nor been looked up by 工號 has no name yet and shows as the 工號.
 */
export function useSignerNames(a: Pick<AssessmentView, 'signerNames'> | null | undefined): Map<string, string> {
  return new Map(a?.signerNames ?? [])
}

/**
 * 姓名 (and the 廠區 CSA knows) of the given 工號, keyed by 工號, from CSA's own copy (#218): a 工號 nobody has looked up
 * or logged in with, or one the signed-in person may not see, is simply missing from the map.
 */
export function useEmployees(empIds: readonly string[]) {
  const { session } = useAuth()
  const ids = [...new Set(empIds)].sort()
  return useQuery({
    // Who may see whom is the database's rule: keyed by who is signed in, like the other permission-bound reads.
    queryKey: ['people', 'names', session?.employee.emp_id, ids],
    queryFn: async () => new Map((await fetchPeopleNames(ids)).map((row) => [row.emp_id, row])),
    enabled: ids.length > 0,
    staleTime: FIVE_MINUTES,
  })
}
