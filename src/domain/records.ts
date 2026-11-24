// 自評表紀錄 (#164, Q124 (2)): what the page works out from the rows the database gives it. Which 自評表 those are is
// the database's reading rule (view assessment_record); the filters, the 狀態 tabs and the 年度 sections only arrange them.
import type { AssessmentRecord, RecordScope } from '../api/recordsQuery'
import type { Plant } from '../api/plants'
import type { StatusFilter } from './tracking'

/** The 狀態 tabs: the same three as 追蹤總覽's 狀態 filter. */
export type RecordStatusTab = StatusFilter
export const RECORD_STATUS_TABS: readonly RecordStatusTab[] = ['all', 'in_progress', 'closed']

export interface RecordFilter {
  /** null: every 年度 (the default) */
  year: number | null
  companyId: string | null
  plantIds: string[]
  /** Typed 範本編號 or 名稱, any part of either. */
  template: string
}

export const NO_RECORD_FILTER: RecordFilter = { year: null, companyId: null, plantIds: [], template: '' }

/** The rows under the filters, every 狀態: the 狀態 tabs count these. */
export function filterRecords(rows: AssessmentRecord[], filter: RecordFilter): AssessmentRecord[] {
  const q = filter.template.trim().toLowerCase()
  return rows.filter(
    (r) =>
      (filter.year === null || r.year === filter.year) &&
      (filter.companyId === null || r.company_id === filter.companyId) &&
      (filter.plantIds.length === 0 || filter.plantIds.includes(r.plant_id)) &&
      (!q || r.template_code.toLowerCase().includes(q) || r.template_name.toLowerCase().includes(q)),
  )
}

export const withStatus = (rows: AssessmentRecord[], tab: RecordStatusTab) => (tab === 'all' ? rows : rows.filter((r) => r.status === tab))

export function statusCounts(rows: AssessmentRecord[]): Record<RecordStatusTab, number> {
  const closed = rows.filter((r) => r.status === 'closed').length
  return { all: rows.length, in_progress: rows.length - closed, closed }
}

/** The 年度 the rows have, newest first (the database sends them so). */
export const recordYears = (rows: AssessmentRecord[]) => [...new Set(rows.map((r) => r.year))]

/** How many of some 自評表 are 簽核中 and how many 已結案. */
export interface StatusTally {
  count: number
  inProgress: number
  closed: number
}

function tally(rows: AssessmentRecord[]): StatusTally {
  const { all, in_progress, closed } = statusCounts(rows)
  return { count: all, inProgress: in_progress, closed }
}

export interface PlantGroup extends StatusTally {
  key: string
  plantId: string
  factoryCode: string
  plantName: string
  records: AssessmentRecord[]
}

export interface YearGroup extends StatusTally {
  key: string
  year: number
  plants: PlantGroup[]
}

/**
 * The rows as 年度 (newest first, as the database sends them) and, within each, 廠區 by code (使用者 2026-11-11, option
 * 乙: two levels to fold, in place of pages of 50). Each 廠區 keeps the database's order of its 自評表.
 */
export function recordGroups(rows: AssessmentRecord[]): YearGroup[] {
  return recordYears(rows).map((year) => {
    const ofYear = rows.filter((r) => r.year === year)
    const plants = [...new Set(ofYear.map((r) => r.plant_id))].map((plantId): PlantGroup => {
      const records = ofYear.filter((r) => r.plant_id === plantId)
      const first = records[0]!
      return { key: `${year}/${plantId}`, plantId, factoryCode: first.factory_code, plantName: first.plant_name, records, ...tally(records) }
    })
    plants.sort((a, b) => a.factoryCode.localeCompare(b.factoryCode))
    return { key: String(year), year, plants, ...tally(ofYear) }
  })
}

/** Every 年度 and 廠區 key, for 全部展開. */
export const allGroupKeys = (groups: YearGroup[]) => groups.flatMap((y) => [y.key, ...y.plants.map((p) => p.key)])

/**
 * What is open before anyone clicks: the newest 年度, its 廠區 folded. A list narrowed to some 廠區 or 範本 opens in full,
 * since what is left is what one looked for.
 */
export function defaultOpenKeys(groups: YearGroup[], filter: RecordFilter): Set<string> {
  if (filter.plantIds.length > 0 || filter.template.trim()) return new Set(allGroupKeys(groups))
  return new Set(groups.slice(0, 1).map((y) => y.key))
}

/**
 * What the label beside the title says (Q124 (2)): every plant, or the plants they view or run, and whether the list
 * also holds 自評表 of other plants they are on the route of; neither, only their own.
 */
export type RecordReach = { kind: 'all' } | { kind: 'plants'; plants: Plant[]; alsoOwn: boolean } | { kind: 'own' }

export function recordReach(scope: RecordScope, plants: Plant[], rows: Pick<AssessmentRecord, 'plant_id'>[]): RecordReach {
  if (scope.all_plants) return { kind: 'all' }
  if (scope.plant_ids.length === 0) return { kind: 'own' }
  const ids = new Set(scope.plant_ids)
  return { kind: 'plants', plants: plants.filter((p) => ids.has(p.id)), alsoOwn: rows.some((r) => !ids.has(r.plant_id)) }
}
