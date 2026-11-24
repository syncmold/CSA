import { useQuery } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { useEffect } from 'react'
import { fetchLaunchedYears } from '../api/issued'
import { pickYear, yearOptions, type YearOption } from '../domain/years'
import { useSearchWriter } from './useUrlParam'

/** The launched years' query key: a launch (年度發起) invalidates it, so the 年度 menu gains the next year. */
export const LAUNCHED_YEARS = ['launched-years']

/**
 * Remembered per browser tab: a fresh visit starts on the next year to launch, not on a past year left from before.
 * Only a launched year is stored; choosing the next year clears it, so after a launch the page opened again moves on to
 * the new next year instead of staying on the one just launched.
 */
const STORAGE_KEY = 'csa.year'

function remembered(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function remember(year: number, launched: boolean) {
  try {
    if (launched) sessionStorage.setItem(STORAGE_KEY, String(year))
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // A browser that refuses storage just forgets the year next time.
  }
}

export interface YearChoice {
  year: number
  /** Launched already: 年度發起 tops it up (its bar grey). */
  launched: boolean
  options: YearOption[]
}

/**
 * 年度發起's 年度 (#175): `?year=` in the URL, else the year this tab chose last, else the next year to launch. Choosing
 * writes both. `choice` is null while the launched years load. 範本管理 and 簽核流程 have no 年度 (Q137 (2)).
 */
export function useYearChoice() {
  const years = useQuery({ queryKey: LAUNCHED_YEARS, queryFn: fetchLaunchedYears })
  const [params, writeParams] = useSearchWriter()
  const requested = params.get('year')
  const options = years.data ? yearOptions(years.data, dayjs().year()) : []
  const isLaunched = (y: number) => options.some((o) => o.year === y && o.launched)
  // Read on every render, not once as usePlantChoice does: the year has no rows to move under it.
  const year = pickYear(options, requested, remembered())
  const choice: YearChoice | null = year === null ? null : { year, launched: isLaunched(year), options }
  const launched = choice?.launched ?? false
  // A year the URL brings is the one shown, so the page opens on it again later in this tab.
  useEffect(() => {
    if (year !== null && requested === String(year)) remember(year, launched)
  }, [year, requested, launched])
  const choose = (next: number) => {
    remember(next, isLaunched(next))
    writeParams((p) => p.set('year', String(next)))
  }
  return { choice, choose, years }
}

