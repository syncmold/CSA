import { describe, expect, it } from 'vitest'
import type { AssessmentRecord } from '../api/recordsQuery'
import { allGroupKeys, defaultOpenKeys, filterRecords, NO_RECORD_FILTER, recordGroups, recordReach, recordYears, statusCounts, withStatus } from './records'

let n = 0
function record(over: Partial<AssessmentRecord>): AssessmentRecord {
  n += 1
  return {
    assessment_id: `a${n}`, year: 2026, company_id: 'c1', company_name: '福清富群', plant_id: 'p1', factory_code: 'FQ', plant_name: '福清富群',
    template_code: 'FQ-02', template_name: '採購及付款循環', status: 'closed', closed_at: '2026-10-28T02:00:00+00:00', ...over,
  }
}

const rows = [
  record({ year: 2026, template_code: 'FQ-02', status: 'closed' }),
  record({ year: 2026, template_code: 'FQ-06', template_name: '融資循環', status: 'in_progress', closed_at: null }),
  record({ year: 2026, template_code: 'SY-02', plant_id: 'p2', factory_code: 'SY', company_id: 'c2', status: 'in_progress', closed_at: null }),
  record({ year: 2025, template_code: 'FQ-02' }),
  record({ year: 2025, template_code: 'FQ-06', template_name: '融資循環' }),
]

describe('filterRecords', () => {
  it('keeps everything with no filter', () => {
    expect(filterRecords(rows, NO_RECORD_FILTER)).toEqual(rows)
  })

  it('filters by 年度, 公司 and 廠區 together', () => {
    expect(filterRecords(rows, { ...NO_RECORD_FILTER, year: 2025 }).map((r) => r.year)).toEqual([2025, 2025])
    expect(filterRecords(rows, { ...NO_RECORD_FILTER, companyId: 'c2' }).map((r) => r.template_code)).toEqual(['SY-02'])
    expect(filterRecords(rows, { ...NO_RECORD_FILTER, year: 2026, plantIds: ['p1'] }).map((r) => r.template_code)).toEqual(['FQ-02', 'FQ-06'])
  })

  it('matches typed 範本 words against the 編號 or the 名稱, any case', () => {
    expect(filterRecords(rows, { ...NO_RECORD_FILTER, template: ' fq-06 ' }).map((r) => r.year)).toEqual([2026, 2025])
    expect(filterRecords(rows, { ...NO_RECORD_FILTER, template: '融資' }).map((r) => r.template_code)).toEqual(['FQ-06', 'FQ-06'])
  })
})

describe('狀態 tabs', () => {
  it('counts each tab and keeps its rows', () => {
    expect(statusCounts(rows)).toEqual({ all: 5, in_progress: 2, closed: 3 })
    expect(withStatus(rows, 'in_progress').map((r) => r.template_code)).toEqual(['FQ-06', 'SY-02'])
    expect(withStatus(rows, 'all')).toBe(rows)
  })
})

describe('recordGroups', () => {
  it('groups by 年度, newest first, then by 廠區 code, each with its counts', () => {
    expect(recordYears(rows)).toEqual([2026, 2025])
    const groups = recordGroups(rows)
    expect(groups.map((y) => [y.key, y.count, y.inProgress, y.closed])).toEqual([['2026', 3, 2, 1], ['2025', 2, 0, 2]])
    expect(groups[0]!.plants.map((p) => [p.key, p.factoryCode, p.plantName, p.count, p.closed])).toEqual([
      ['2026/p1', 'FQ', '福清富群', 2, 1],
      ['2026/p2', 'SY', '福清富群', 1, 0],
    ])
    expect(groups[0]!.plants[0]!.records.map((r) => r.template_code)).toEqual(['FQ-02', 'FQ-06'])
    expect(recordGroups([])).toEqual([])
  })

  it('opens the newest 年度 alone, its 廠區 folded, unless the list is narrowed to some 廠區 or 範本', () => {
    const groups = recordGroups(rows)
    expect([...defaultOpenKeys(groups, NO_RECORD_FILTER)]).toEqual(['2026'])
    expect([...defaultOpenKeys(groups, { ...NO_RECORD_FILTER, year: 2025 })]).toEqual(['2026'])
    const all = ['2026', '2026/p1', '2026/p2', '2025', '2025/p1']
    expect(allGroupKeys(groups)).toEqual(all)
    expect([...defaultOpenKeys(groups, { ...NO_RECORD_FILTER, template: '融資' })]).toEqual(all)
    expect([...defaultOpenKeys(groups, { ...NO_RECORD_FILTER, plantIds: ['p1'] })]).toEqual(all)
  })
})

describe('recordReach', () => {
  const plants = [
    { id: 'p1', factory_code: 'FQ', name: '福清富群' },
    { id: 'p2', factory_code: 'SY', name: '順義' },
  ]

  it('is every plant for whoever reads all', () => {
    expect(recordReach({ all_plants: true, plant_ids: [] }, plants, rows)).toEqual({ kind: 'all' })
  })

  it('names the plants viewed or run, and says when the list holds other plants of their own', () => {
    expect(recordReach({ all_plants: false, plant_ids: ['p1'] }, plants, rows.filter((r) => r.plant_id === 'p1')))
      .toEqual({ kind: 'plants', plants: [plants[0]], alsoOwn: false })
    expect(recordReach({ all_plants: false, plant_ids: ['p1'] }, plants, rows)).toEqual({ kind: 'plants', plants: [plants[0]], alsoOwn: true })
  })

  it('is their own for anyone else', () => {
    expect(recordReach({ all_plants: false, plant_ids: [] }, plants, rows)).toEqual({ kind: 'own' })
  })
})
