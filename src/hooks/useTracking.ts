import { useQuery } from '@tanstack/react-query'
import { fetchTracking, fetchTrackingTemplates, type TrackingRow } from '../api/tracking'
import type { TrackingData } from '../domain/tracking'
import { useLaunchedCycles } from './useLaunch'

/**
 * One 年度's 追蹤總覽: its 自評表 and the 範本 they sit among. 停留天數 is counted by the database, so both are fetched
 * again when the page is revisited; the 範本 do not depend on the 年度, so switching 年度 does not fetch them again.
 */
export function useTracking(year: number | null) {
  const rows = useTrackingRows(year)
  const templates = useQuery({ queryKey: ['tracking-templates'], queryFn: fetchTrackingTemplates })
  const data: TrackingData | undefined = rows.data && templates.data ? { rows: rows.data, templates: templates.data } : undefined
  return { data, isPending: rows.isPending || templates.isPending, error: rows.error ?? templates.error }
}

function useTrackingRows(year: number | null) {
  return useQuery({
    queryKey: ['tracking', year],
    queryFn: () => fetchTracking(year!),
    enabled: year !== null,
  })
}

/**
 * The newest launched 年度's 追蹤總覽 rows, for 首頁's 各廠填單進度 (Q115): shares its queries with 追蹤總覽, which opens on
 * the same 年度. `year` is null while the 年度 load or when none has been launched.
 */
export function useLatestTracking(): { year: number | null; rows: TrackingRow[]; isPending: boolean; error: Error | null } {
  const cycles = useLaunchedCycles()
  const year = cycles.data?.[0]?.year ?? null
  const rows = useTrackingRows(year)
  return {
    year,
    rows: rows.data ?? [],
    isPending: cycles.isPending || (year !== null && rows.isPending),
    error: cycles.error ?? rows.error,
  }
}
