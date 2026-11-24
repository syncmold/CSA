import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import type { TemplateComponent } from '../api/templates'
import type { TrackingRow, TrackingTemplate } from '../api/trackingQuery'
import {
  signerLabel,
  beforeMerge, cellLines, cellRows, closedCount, columnHeader, columnLabel, companyOptionLabel, companyOptions, controlForm, CONTROL_FORMS, currentStepLabel, dwellCounts, dwellLabel, dwellLevel,
  DWELL_THRESHOLDS, filterTracking, heatLevel, NO_FILTER, onlyPlants, plantOptionLabel, plantOptions, singleAssessment, trackingMatrix, trackingQueue,
  trackingSheets, trackingSummary, type TrackingCell, type TrackingData, type TrackingMatrix,
} from './tracking'

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${Object.values(options).join('|')})` : key) as unknown as TFunction

/** 範本 names and 組成要素 by the code's paper number (what follows 「廠區代碼-」). */
const NAMES: Record<string, [string, TemplateComponent | null]> = {
  A: ['控制環境', 'control_environment'],
  B: ['風險評估', 'risk_assessment'],
  C: ['資訊與溝通', 'information_communication'],
  D: ['監督', 'monitoring'],
  '01': ['銷售及收款循環', 'control_activities'],
  '01.1': ['銷售及收款循環', 'control_activities'],
  '02': ['採購及付款循環', 'control_activities'],
  '10.1': ['研發循環', 'control_activities'],
  '10.3': ['研發循環（沖壓）', 'control_activities'],
  '10.4': ['研發循環（塑膠）', 'control_activities'],
  '13': ['董事會議事運作之管理', 'control_activities'],
  '05.1': ['研發循環（模具）', 'control_activities'],
  '05.2-沖壓': ['研發循環（沖壓）', 'control_activities'],
  '05.2-組裝': ['研發循環（組裝）', 'control_activities'],
  '98': ['某表', null],
  '99': ['另一種表單', 'control_activities'],
}
const paper = (code: string) => code.replace(/^[A-Z]{2,}-/, '')
const nameOf = (code: string) => NAMES[paper(code)]?.[0] ?? `${code} 範本`

function row(company: string, plant: string, code: string, over: Partial<TrackingRow> = {}): TrackingRow {
  return {
    assessment_id: `${plant}/${code}`, year: 2027, due_date: '2027-03-31',
    company_id: `c-${company}`, company_name: `${company}公司`,
    plant_id: `p-${plant}`, factory_code: plant, plant_name: `${plant}廠`,
    template_id: `t-${code}`, template_code: code, template_name: nameOf(code),
    status: 'in_progress', current_step_position: 2, step_count: 6, current_step_name: '部門主管－資材',
    current_signer_emp_id: 'SS140', current_signer_name: '王小明',
    entered_step_at: '2027-01-10T01:30:00+00:00', days_at_step: 5, closed_at: null, stage: 'signing', due_in_days: 60,
    // Past the 匯流 unless a test says otherwise.
    branch_count: 1, branches_done: 1, current_step_branch_unit: null,
    ...over,
  }
}

const closed = (company: string, plant: string, code: string, over: Partial<TrackingRow> = {}) =>
  row(company, plant, code, {
    status: 'closed', stage: 'closed', current_step_position: 6, current_step_name: '稽核主管', days_at_step: null,
    // 2027-02-17 20:00 UTC is already 2027-02-18 in Taipei
    entered_step_at: '2027-02-17T20:00:00+00:00', closed_at: '2027-02-17T20:00:00+00:00',
    ...over,
  })

/** An 啟用 範本 of the given 廠區 (codes); `applies_to: []` for one that is not 啟用. */
function tpl(code: string, plants: string[], over: Partial<TrackingTemplate> = {}): TrackingTemplate {
  return {
    template_id: `t-${code}`, template_code: code, template_name: nameOf(code),
    template_component: NAMES[paper(code)]?.[1] ?? null, applies_to: plants.map((p) => `p-${p}`),
    ...over,
  }
}

/** Each 自評表's 範本, applying to its own 廠區: enough for tests about the 自評表 alone. */
const own = (rows: TrackingRow[], extra: TrackingTemplate[] = []): TrackingData => ({
  rows,
  templates: [...new Map(rows.map((r) => [r.template_id, tpl(r.template_code, [r.factory_code])])).values(), ...extra],
})

// 富群：福清 FQ、松岡 SY；兆利：蘇州 SZ. Each 廠區 has its own 範本 (Q111).
const ROWS = [
  row('富群', 'FQ', 'FQ-A'),
  row('富群', 'FQ', 'FQ-01.1'),
  closed('富群', 'SY', 'SY-A'),
  row('富群', 'SY', 'SY-01', { days_at_step: 9 }),
  row('兆利', 'SZ', 'SZ-10.3', { days_at_step: 12, current_signer_name: null }),
  closed('兆利', 'SZ', 'SZ-10.4'),
]
const TEMPLATES = [
  tpl('FQ-A', ['FQ']), tpl('FQ-01.1', ['FQ']), tpl('FQ-02', ['FQ']), tpl('FQ-10.1', ['FQ']),
  tpl('SY-A', ['SY']), tpl('SY-01', ['SY']), tpl('SY-13', ['SY']),
  tpl('SZ-A', ['SZ']), tpl('SZ-10.3', ['SZ']), tpl('SZ-10.4', ['SZ']),
]
const DATA: TrackingData = { rows: ROWS, templates: TEMPLATES }

/** A cell in short: the 自評表 ids (and +the 範本 not launched), or its kind. */
function brief(cell: TrackingCell): string {
  if (cell.kind === 'not_launched') return `未發起 ${cell.missing.map((m) => m.template_code).join(',')}`
  if (cell.kind !== 'assessments') return cell.kind
  return [...cell.rows.map((r) => r.assessment_id), ...cell.missing.map((m) => `+${m.template_code}`)].join(',') + (cell.total ? ' (total)' : '')
}
const grid = (m: TrackingMatrix) => m.plants.map((p) => [p.factory_code, p.cells.map(brief)])
const keys = (m: TrackingMatrix) => m.columns.map((c) => c.key)

describe('signerLabel', () => {
  const t = ((key: string) => key) as unknown as TFunction
  it('names the 簽核人, or says 待分派 when the 關卡 has none (#101)', () => {
    expect(signerLabel(row('兆利', 'SZ', 'SZ-10.3'), t)).toBe('王小明（SS140）')
    expect(signerLabel(row('兆利', 'SZ', 'SZ-10.3', { current_signer_emp_id: null, current_signer_name: null }), t)).toBe('unassigned')
  })
})

describe('filterTracking', () => {
  it('keeps everything with no filter', () => {
    expect(filterTracking(ROWS, NO_FILTER)).toEqual(ROWS)
  })

  it('narrows to one 公司, then to the chosen 廠區', () => {
    expect(filterTracking(ROWS, { ...NO_FILTER, companyId: 'c-富群' }).map((r) => r.factory_code)).toEqual(['FQ', 'FQ', 'SY', 'SY'])
    expect(filterTracking(ROWS, { ...NO_FILTER, plantIds: ['p-SY', 'p-SZ'] })).toHaveLength(4)
  })

  it('narrows to 簽核中 or 已結案', () => {
    expect(filterTracking(ROWS, { ...NO_FILTER, status: 'closed' }).map((r) => r.assessment_id)).toEqual(['SY/SY-A', 'SZ/SZ-10.4'])
    expect(filterTracking(ROWS, { ...NO_FILTER, status: 'in_progress' })).toHaveLength(4)
  })

  it('combines the filters', () => {
    expect(filterTracking(ROWS, { companyId: 'c-富群', plantIds: ['p-FQ', 'p-SZ'], status: 'in_progress' }).map((r) => r.assessment_id))
      .toEqual(['FQ/FQ-A', 'FQ/FQ-01.1'])
  })
})

describe('onlyPlants', () => {
  it('keeps the rows of the given plants, or all of them', () => {
    expect(onlyPlants(DATA, 'all')).toBe(DATA)
    expect(onlyPlants(DATA, ['p-SY', 'p-SZ']).rows.map((r) => r.factory_code)).toEqual(['SY', 'SY', 'SZ', 'SZ'])
    expect(trackingMatrix(onlyPlants(DATA, []), NO_FILTER).plants).toEqual([])
  })
})

describe('filter options', () => {
  it('lists each 公司 once', () => {
    expect(companyOptions(ROWS)).toEqual([
      { id: 'c-富群', name: '富群公司', plants: [{ id: 'p-FQ', factory_code: 'FQ', name: 'FQ廠' }, { id: 'p-SY', factory_code: 'SY', name: 'SY廠' }] },
      { id: 'c-兆利', name: '兆利公司', plants: [{ id: 'p-SZ', factory_code: 'SZ', name: 'SZ廠' }] },
    ])
  })

  it('labels a 公司 option like its 廠區 options, not by the legal name', () => {
    expect(companyOptions(ROWS).map(companyOptionLabel)).toEqual(['FQ FQ廠・SY SY廠', 'SZ SZ廠'])
  })

  it('labels a 廠區 option by its code and name', () => {
    expect(plantOptionLabel(plantOptions(ROWS, null)[0]!)).toBe('FQ FQ廠')
  })

  it('lists the 廠區 of the chosen 公司, or all of them', () => {
    expect(plantOptions(ROWS, 'c-富群').map((p) => p.id)).toEqual(['p-FQ', 'p-SY'])
    expect(plantOptions(ROWS, null).map((p) => p.id)).toEqual(['p-FQ', 'p-SY', 'p-SZ'])
  })
})

describe('controlForm', () => {
  it('drops a 廠區\'s own distinction in brackets at the end, so the forms merge by name', () => {
    expect(['研發循環（沖壓）', '研發循環（模具）', '生產循環（沖壓&塑膠）', '研發循環(組裝)', '研發循環'].map(controlForm))
      .toEqual(['研發循環', '研發循環', '生產循環', '研發循環', '研發循環'])
    expect(controlForm('銷售及收款循環、採購及付款循環')).toBe('銷售及收款循環、採購及付款循環')
    // SY-15 as converted from Word: 易 and 理 are CJK compatibility ideographs.
    expect(controlForm('內部重大資訊暨防範內線交易管理辦法')).toBe('內部重大資訊暨防範內線交易管理辦法')
    expect(CONTROL_FORMS.map((f) => f.name)).toContain(controlForm('內部重大資訊暨防範內線交易管理辦法'))
  })

  it('lists 22 forms: 福清\'s 12 by its paper order, then the 10 only some 廠區 have', () => {
    expect(CONTROL_FORMS).toHaveLength(22)
    expect(CONTROL_FORMS.slice(0, 12).map((f) => f.short)).toEqual(['銷售', '採購', '生產', '存貨', '固資', '融資', '投資', '薪工', '內管', '研發', '預算', '取處'])
    expect(new Set(CONTROL_FORMS.map((f) => f.name)).size).toBe(22)
  })
})

describe('trackingMatrix', () => {
  it('puts a 廠區 per row and the 組成要素 as columns, 控制作業 as a total and a column per form', () => {
    const matrix = trackingMatrix(DATA)
    expect(matrix.columns).toEqual([
      { kind: 'component', key: 'control_environment' },
      { kind: 'controls', key: 'control_activities' },
      { kind: 'form', key: '銷售及收款循環' },
      { kind: 'form', key: '採購及付款循環' },
      { kind: 'form', key: '研發循環' },
      { kind: 'form', key: '董事會議事運作之管理' },
    ])
    expect(grid(matrix)).toEqual([
      ['FQ', ['FQ/FQ-A', 'FQ/FQ-01.1,+FQ-02,+FQ-10.1 (total)', 'FQ/FQ-01.1', '未發起 FQ-02', '未發起 FQ-10.1', 'not_applicable']],
      ['SY', ['SY/SY-A', 'SY/SY-01,+SY-13 (total)', 'SY/SY-01', 'not_applicable', 'not_applicable', '未發起 SY-13']],
      ['SZ', ['未發起 SZ-A', 'SZ/SZ-10.3,SZ/SZ-10.4 (total)', 'not_applicable', 'not_applicable', 'SZ/SZ-10.3,SZ/SZ-10.4', 'not_applicable']],
    ])
    expect(matrix.plants.map((p) => [p.company_name, p.factory_code, p.rows.map((r) => r.template_code)])).toEqual([
      ['富群公司', 'FQ', ['FQ-A', 'FQ-01.1']],
      ['富群公司', 'SY', ['SY-A', 'SY-01']],
      ['兆利公司', 'SZ', ['SZ-10.3', 'SZ-10.4']],
    ])
  })

  it('merges same-named 範本 of different 廠區 into one form column', () => {
    const matrix = trackingMatrix(own([row('富群', 'FQ', 'FQ-01.1'), row('富群', 'SY', 'SY-01'), row('富群', 'GT', 'GT-01')]))
    expect(keys(matrix)).toEqual(['control_activities', '銷售及收款循環'])
    expect(matrix.plants.map((p) => brief(p.cells[1]!))).toEqual(['FQ/FQ-01.1', 'SY/SY-01', 'GT/GT-01'])
  })

  it('orders the 組成要素 as 處理準則 does and the forms by CONTROL_FORMS, unknown forms after them and 未分類 last', () => {
    const codes = ['FQ-D', 'FQ-13', 'FQ-C', 'FQ-10.1', 'FQ-99', 'FQ-B', 'FQ-02', 'FQ-A', 'FQ-01.1', 'FQ-98']
    expect(keys(trackingMatrix(own(codes.map((code) => row('富群', 'FQ', code)))))).toEqual([
      'control_environment', 'risk_assessment', 'control_activities', '銷售及收款循環', '採購及付款循環', '研發循環', '董事會議事運作之管理', '另一種表單',
      'information_communication', 'monitoring', 'unclassified',
    ])
  })

  it('puts a 自評表 whose 範本 it cannot find under 未分類 rather than dropping it', () => {
    const matrix = trackingMatrix({ rows: [row('富群', 'FQ', 'FQ-A')], templates: [] })
    expect(keys(matrix)).toEqual(['unclassified'])
    expect(grid(matrix)).toEqual([['FQ', ['FQ/FQ-A']]])
  })

  it('places a 自評表 by the name it was launched with, and its 範本\'s 組成要素 now', () => {
    const renamed = row('富群', 'FQ', 'FQ-01.1', { template_name: '銷售循環（舊名）' })
    const matrix = trackingMatrix({ rows: [renamed], templates: [tpl('FQ-01.1', ['FQ'], { template_name: '銷售及收款循環' })] })
    expect(keys(matrix)).toEqual(['control_activities', '銷售循環'])
  })

  it('tells 未發起 (an applicable 啟用 範本 not launched) from 不適用 (none), which the totals never count', () => {
    const data = own([row('富群', 'FQ', 'FQ-A'), row('富群', 'SY', 'SY-A')], [
      tpl('FQ-02', ['FQ']),
      // Not 啟用: no 廠區 to apply to, so SY's cell is 不適用, not 未發起.
      tpl('SY-02', []),
    ])
    const matrix = trackingMatrix(data)
    expect(grid(matrix)).toEqual([
      ['FQ', ['FQ/FQ-A', '未發起 FQ-02', '未發起 FQ-02']],
      ['SY', ['SY/SY-A', 'not_applicable', 'not_applicable']],
    ])
    expect(trackingSummary(matrix)).toMatchObject({ total: 2, notLaunched: 1, templates: 2 })
  })

  it('does not take a 範本 made again under a 編號 the 廠區 already launched this 年度 for 未發起', () => {
    const matrix = trackingMatrix(own([row('富群', 'FQ', 'FQ-02')], [tpl('FQ-02', ['FQ'], { template_id: 't-FQ-02-new' })]))
    expect(grid(matrix)).toEqual([['FQ', ['FQ/FQ-02 (total)', 'FQ/FQ-02']]])
  })

  it('adds no column for a 範本 of a 廠區 not shown', () => {
    const matrix = trackingMatrix(own([row('富群', 'FQ', 'FQ-A')], [tpl('SY-13', ['SY'])]))
    expect(keys(matrix)).toEqual(['control_environment'])
  })

  it('merges a 廠區\'s several 範本 of one form into one cell, in code order', () => {
    const matrix = trackingMatrix(own([row('富群', 'LH', 'LH-05.2-組裝'), row('富群', 'LH', 'LH-05.1')], [tpl('LH-05.2-沖壓', ['LH'])]))
    expect(keys(matrix)).toEqual(['control_activities', '研發循環'])
    expect(brief(matrix.plants[0]!.cells[1]!)).toBe('LH/LH-05.1,LH/LH-05.2-組裝,+LH-05.2-沖壓')
    expect(singleAssessment(matrix.plants[0]!.cells[1]!)).toBeNull()
  })

  it('keeps only the chosen 公司 and 廠區 as rows, and the columns they have', () => {
    const matrix = trackingMatrix(DATA, { ...NO_FILTER, companyId: 'c-富群', plantIds: ['p-SY'] })
    expect(matrix.plants.map((p) => p.factory_code)).toEqual(['SY'])
    expect(keys(matrix)).toEqual(['control_environment', 'control_activities', '銷售及收款循環', '董事會議事運作之管理'])
  })

  it('blanks the 自評表 a 狀態 filter leaves out instead of calling them 未發起, and drops rows and columns left empty', () => {
    const inProgress = trackingMatrix(DATA, { ...NO_FILTER, status: 'in_progress' })
    expect(keys(inProgress)).toEqual(['control_environment', 'control_activities', '銷售及收款循環', '研發循環'])
    expect(grid(inProgress)).toEqual([
      // The total covers all of a 廠區's forms, also those (採購, 董事會) with no column left.
      ['FQ', ['FQ/FQ-A', 'FQ/FQ-01.1,+FQ-02,+FQ-10.1 (total)', 'FQ/FQ-01.1', '未發起 FQ-10.1']],
      ['SY', ['filtered_out', 'SY/SY-01,+SY-13 (total)', 'SY/SY-01', 'not_applicable']],
      ['SZ', ['未發起 SZ-A', 'SZ/SZ-10.3 (total)', 'not_applicable', 'SZ/SZ-10.3']],
    ])
    const closedOnly = trackingMatrix(DATA, { ...NO_FILTER, status: 'closed' })
    expect(keys(closedOnly)).toEqual(['control_environment', 'control_activities', '研發循環'])
    expect(grid(closedOnly)).toEqual([
      ['SY', ['SY/SY-A', 'filtered_out', 'not_applicable']],
      ['SZ', ['未發起 SZ-A', 'SZ/SZ-10.4 (total)', 'SZ/SZ-10.4']],
    ])
    expect(trackingSummary(closedOnly)).toMatchObject({ total: 2, inProgress: 0, closed: 2, notLaunched: 1 })
  })
})

const days = (plant: string, code: string, n: number) => row('富群', plant, code, { days_at_step: n })
const ids = (items: { row: TrackingRow }[]) => items.map((i) => i.row.assessment_id)

describe('停留天數 levels', () => {
  it('uses the stand-in 7／14 天 thresholds', () => {
    expect(DWELL_THRESHOLDS).toEqual({ long: 7, veryLong: 14 })
  })

  it('counts a threshold day as reached', () => {
    expect([0, 6, 7, 13, 14, 40].map((n) => dwellLevel(n))).toEqual(['short', 'short', 'long', 'long', 'veryLong', 'veryLong'])
    expect([2, 3, 5].map((n) => dwellLevel(n, { long: 3, veryLong: 5 }))).toEqual(['short', 'long', 'veryLong'])
  })

  it('names the bands from the thresholds, the middle one ending the day before the second', () => {
    expect((['veryLong', 'long', 'short'] as const).map((l) => dwellLabel(l, t))).toEqual(['dwell.veryLong(7|14|13)', 'dwell.long(7|14|13)', 'dwell.short(7|14|13)'])
  })

  it('counts the long and very long ones, leaving out 結案 and empty cells', () => {
    expect(dwellCounts(['short', 'long', 'veryLong', 'veryLong', 'closed', 'not_launched', 'filtered_out', 'not_applicable'])).toEqual({ long: 3, veryLong: 2 })
  })

  it('shades a cell of one 自評表 by its 停留天數, a 結案 one as closed, and passes the empty kinds through', () => {
    const one = (r: TrackingRow): TrackingCell => ({ kind: 'assessments', rows: [r], missing: [] })
    expect(heatLevel(one(days('FQ', 'FQ-02', 9)))).toBe('long')
    // 簽核中 with no day count yet (the database always gives one; treat it as day 0)
    expect(heatLevel(one(row('富群', 'FQ', 'FQ-02', { days_at_step: null })))).toBe('short')
    expect(heatLevel(one(closed('富群', 'SY', 'SY-02')))).toBe('closed')
    expect(heatLevel({ kind: 'not_launched', missing: [] })).toBe('not_launched')
    expect(heatLevel({ kind: 'filtered_out' })).toBe('filtered_out')
    expect(heatLevel({ kind: 'not_applicable' })).toBe('not_applicable')
  })

  it('shades a cell of several by the one not yet 結案 that has stayed longest, and as closed once all are', () => {
    const cell = (...rows: TrackingRow[]): TrackingCell => ({ kind: 'assessments', rows, missing: [] })
    expect(heatLevel(cell(days('KS', 'KS-10.3', 3), days('KS', 'KS-10.4', 15), closed('富群', 'KS', 'KS-05')))).toBe('veryLong')
    expect(heatLevel(cell(closed('富群', 'KS', 'KS-10.3'), days('KS', 'KS-10.4', 2)))).toBe('short')
    expect(heatLevel(cell(closed('富群', 'KS', 'KS-10.3'), closed('富群', 'KS', 'KS-10.4')))).toBe('closed')
    // All launched ones 結案 but one still to launch: not finished.
    expect(heatLevel({ kind: 'assessments', rows: [closed('富群', 'LH', 'LH-05.1')], missing: [tpl('LH-05.2-組裝', ['LH'])] })).toBe('short')
  })
})

describe('trackingSummary', () => {
  it('counts the 自評表 shown, the applicable 範本 not launched (not again in the 控制作業 total) and the ones that stayed long', () => {
    // 未發起: FQ 採購、FQ 研發、SY 董事會、SZ 控制環境; columns: 控制環境 and the four forms.
    expect(trackingSummary(trackingMatrix(DATA))).toEqual({
      total: 6, inProgress: 4, closed: 2, closedPercent: 33, notLaunched: 4, plants: 3, templates: 5, long: 2, veryLong: 0,
    })
    const stayed = trackingMatrix(own([days('FQ', 'FQ-01.1', 6), days('FQ', 'FQ-A', 7), days('SY', 'SY-01', 14), days('SY', 'SY-A', 30), closed('富群', 'SZ', 'SZ-A')]))
    expect(trackingSummary(stayed)).toMatchObject({ total: 5, closed: 1, closedPercent: 20, long: 3, veryLong: 2 })
    expect(trackingSummary(stayed, { long: 20, veryLong: 30 })).toMatchObject({ long: 1, veryLong: 1 })
  })

  it('counts a 範本 not launched beside a launched one in the same cell', () => {
    const matrix = trackingMatrix(own([row('富群', 'LH', 'LH-05.1')], [tpl('LH-05.2-沖壓', ['LH']), tpl('LH-05.2-組裝', ['LH'])]))
    expect(trackingSummary(matrix)).toMatchObject({ total: 1, notLaunched: 2 })
  })

  it('gives 0 when nothing is shown', () => {
    expect(trackingSummary(trackingMatrix({ rows: [], templates: [] }))).toMatchObject({ total: 0, closedPercent: 0, plants: 0, templates: 0 })
  })

  it('leaves out the 自評表 a 狀態 filter hides', () => {
    const matrix = trackingMatrix(own([days('FQ', 'FQ-01.1', 20), closed('富群', 'FQ', 'FQ-A')]), { ...NO_FILTER, status: 'closed' })
    expect(trackingSummary(matrix)).toMatchObject({ total: 1, closed: 1, closedPercent: 100, long: 0, veryLong: 0 })
  })
})

describe('closedCount', () => {
  it('counts 已結案 out of the 自評表 shown in a row, a column or a cell, not the empty ones', () => {
    const matrix = trackingMatrix(DATA)
    expect(matrix.plants.map((p) => closedCount(p.rows))).toEqual([{ closed: 0, total: 2 }, { closed: 1, total: 2 }, { closed: 1, total: 2 }])
    expect(matrix.columns.map((_, i) => closedCount(matrix.plants.flatMap((p) => cellRows(p.cells[i]!))))).toEqual([
      { closed: 1, total: 2 }, { closed: 1, total: 4 }, { closed: 0, total: 2 }, { closed: 0, total: 0 }, { closed: 1, total: 2 }, { closed: 0, total: 0 },
    ])
  })

  it('agrees between the 控制作業 total and its forms', () => {
    const matrix = trackingMatrix(DATA)
    const forms = matrix.columns.flatMap((c, i) => (c.kind === 'form' ? [i] : []))
    const total = matrix.columns.findIndex((c) => c.kind === 'controls')
    for (const p of matrix.plants) {
      expect(cellRows(p.cells[total]!).map((r) => r.assessment_id).sort()).toEqual(forms.flatMap((i) => cellRows(p.cells[i]!)).map((r) => r.assessment_id).sort())
    }
  })
})

describe('trackingQueue', () => {
  it('groups by 廠區 in the matrix order, each 廠區 longest 停留 first, its 已結案 ones apart', () => {
    const matrix = trackingMatrix(own([
      days('FQ', 'FQ-01.1', 3), days('FQ', 'FQ-A', 15), closed('富群', 'SY', 'SY-01'), days('SY', 'SY-A', 7), days('SZ', 'SZ-01', 21), days('SZ', 'SZ-A', 13),
    ]))
    const queue = trackingQueue(matrix)
    expect(queue.plants.map((p) => [p.plant.factory_code, ids(p.inProgress), ids(p.closed), p.long, p.veryLong])).toEqual([
      ['FQ', ['FQ/FQ-A', 'FQ/FQ-01.1'], [], 1, 1],
      ['SY', ['SY/SY-A'], ['SY/SY-01'], 1, 0],
      ['SZ', ['SZ/SZ-01', 'SZ/SZ-A'], [], 2, 1],
    ])
  })

  it('keeps the column order for equal 停留天數', () => {
    const queue = trackingQueue(trackingMatrix(own([days('FQ', 'FQ-B', 4), days('FQ', 'FQ-02', 4), days('FQ', 'FQ-A', 4), days('FQ', 'FQ-01.1', 4)])))
    expect(ids(queue.plants[0]!.inProgress)).toEqual(['FQ/FQ-A', 'FQ/FQ-B', 'FQ/FQ-01.1', 'FQ/FQ-02'])
  })

  it('lists each 自評表 of a merged cell once', () => {
    const queue = trackingQueue(trackingMatrix(DATA))
    expect(ids(queue.plants.find((p) => p.plant.factory_code === 'SZ')!.inProgress)).toEqual(['SZ/SZ-10.3'])
    expect(ids(queue.plants.find((p) => p.plant.factory_code === 'SZ')!.closed)).toEqual(['SZ/SZ-10.4'])
  })

  it('applies the matrix filters', () => {
    const queue = trackingQueue(trackingMatrix(DATA, { ...NO_FILTER, status: 'closed' }))
    expect(queue.plants.map((p) => [p.plant.factory_code, p.inProgress.length, ids(p.closed)])).toEqual([['SY', 0, ['SY/SY-A']], ['SZ', 0, ['SZ/SZ-10.4']]])
  })

  it('counts the long ones by the thresholds given', () => {
    const queue = trackingQueue(trackingMatrix(own([days('FQ', 'FQ-01.1', 3), days('FQ', 'FQ-A', 5), days('FQ', 'FQ-B', 2)])), { long: 3, veryLong: 5 })
    expect([queue.plants[0]!.long, queue.plants[0]!.veryLong]).toEqual([2, 1])
  })
})

describe('cellLines', () => {
  const cells = trackingMatrix(DATA).plants.map((p) => p.cells)
  const [fq, sy, sz] = cells as [TrackingCell[], TrackingCell[], TrackingCell[]]

  it('shows one 自評表\'s 範本, the 關卡 of the whole route, the signer and the days there', () => {
    expect(cellLines(fq[0]!, t)).toEqual(['FQ-A', 'cell.stageProgress(stage.signing|cell.step(2|6|部門主管－資材))', '王小明（SS140）', 'cell.days(5)'])
  })

  it('falls back to the 工號 when the signer has never signed in', () => {
    expect(cellLines({ kind: 'assessments', rows: [ROWS[4]!], missing: [] }, t)[2]).toBe('SS140')
  })

  it('shows the 結案 date (Taipei) instead of a 關卡', () => {
    expect(cellLines(sy[0]!, t)).toEqual(['SY-A', 'cell.closed', '2027-02-18'])
  })

  it('lists each 範本 of a cell of several, with where it stands, and the ones not launched', () => {
    expect(cellLines(sz[4]!, t)).toEqual(['cell.closedShare(1|2)', 'SZ-10.3：cell.stageProgress(stage.signing|cell.step(2|6|部門主管－資材)) cell.days(12)', 'SZ-10.4：cell.closed 2027-02-18'])
    expect(cellLines({ kind: 'assessments', rows: [ROWS[1]!], missing: [TEMPLATES[2]!] }, t)).toEqual([
      'cell.closedShare(0|1)', 'FQ-01.1：cell.stageProgress(stage.signing|cell.step(2|6|部門主管－資材)) cell.days(5)', 'FQ-02：cell.notLaunched',
    ])
  })

  it('lists in the 控制作業 total only those not yet 結案, the longest 停留 first, and the ones not launched', () => {
    const total = trackingMatrix(own([days('KS', 'KS-01', 3), closed('富群', 'KS', 'KS-02'), days('KS', 'KS-10.1', 8)], [tpl('KS-13', ['KS'])]))
      .plants[0]!.cells[0]!
    expect(cellLines(total, t)).toEqual([
      'cell.closedShare(1|3)', 'KS-10.1：cell.stageProgress(stage.signing|cell.step(2|6|部門主管－資材)) cell.days(8)', 'KS-01：cell.stageProgress(stage.signing|cell.step(2|6|部門主管－資材)) cell.days(3)',
      'KS-13：cell.notLaunched',
    ])
  })

  it('names what was not launched, marks 不適用, and leaves a cell the filter hides blank', () => {
    expect(cellLines(fq[3]!, t)).toEqual(['cell.notLaunched', 'FQ-02'])
    expect(cellLines(fq[5]!, t)).toEqual(['cell.notApplicable'])
    expect(cellLines({ kind: 'filtered_out' }, t)).toEqual([])
  })
})

describe('分流 before the 匯流 (#99)', () => {
  // 3 of 4 units approved; the 停留天數 counts from 資材單位's 部門主管, the 分流 longest without a move.
  const split = row('富群', 'FQ', 'FQ-01.1', {
    current_step_position: 8, step_count: 12, current_step_name: '部門主管－資材單位', current_step_branch_unit: '資材單位',
    branch_count: 4, branches_done: 3, days_at_step: 32,
  })

  it('tells a 自評表 whose 分流 are not all done from one past the 匯流 or closed', () => {
    expect(beforeMerge(split)).toBe(true)
    expect(beforeMerge(row('富群', 'FQ', 'FQ-A'))).toBe(false)
    expect(beforeMerge(closed('富群', 'FQ', 'FQ-A', { branch_count: 4, branches_done: 0 }))).toBe(false)
  })

  it('counts the approved units instead of a 第 n／m 關, and names no 關卡 in the cell (user decision 2026-11-04)', () => {
    expect(cellLines({ kind: 'assessments', rows: [split], missing: [] }, t)).toEqual([
      'FQ-01.1', 'cell.stageProgress(stage.signing|cell.branches(3|4))', '王小明（SS140）', 'cell.days(32)',
    ])
    expect(cellLines({ kind: 'assessments', rows: [split, closed('富群', 'FQ', 'FQ-02')], missing: [] }, t)[1]).toBe(
      'FQ-01.1：cell.stageProgress(stage.signing|cell.branches(3|4)) cell.days(32)',
    )
  })

  it('names the 關卡 by its unit and its name within the 分流, and one past the 匯流 by its name', () => {
    expect(currentStepLabel(split)).toBe('資材單位・部門主管')
    expect(currentStepLabel(row('富群', 'FQ', 'FQ-A', { current_step_name: '台北稽核人員' }))).toBe('台北稽核人員')
  })

  it('puts the same in the 明細 sheet', () => {
    const { detail } = trackingSheets(trackingMatrix(own([split])), t)
    expect(detail[1]!.slice(6, 10)).toEqual(['stage.signing', 3, 4, '資材單位・部門主管'])
  })
})

describe('column headers', () => {
  it('names a 組成要素 by its heading and a form by its name, shortened on screen', () => {
    const [component, controls, form] = trackingMatrix(DATA).columns
    expect([component, controls, form].map((c) => columnLabel(c!, t))).toEqual([
      'common:templates.componentHeadings.control_environment', 'common:templates.componentHeadings.control_activities', '銷售及收款循環',
    ])
    expect(columnHeader(form!, t)).toBe('銷售')
    expect(columnHeader(component!, t)).toBe('common:templates.components.control_environment')
    expect(columnHeader({ kind: 'form', key: '另一種表單' }, t)).toBe('另一種表單')
  })
})

describe('trackingSheets', () => {
  it('gives the 總覽 sheet every column expanded, worded as on screen', () => {
    const matrix = trackingMatrix(DATA)
    const { overview } = trackingSheets(matrix, t)
    expect(overview[0]).toEqual(['plantHeader', ...matrix.columns.map((c) => columnLabel(c, t))])
    expect(overview.slice(1).map((r) => r[0])).toEqual(matrix.plants.map((p) => `${p.company_name} ${p.plant_name}（${p.factory_code}）`))
    expect(overview[1]!.slice(1)).toEqual(matrix.plants[0]!.cells.map((c) => cellLines(c, t).join('\n')))
    expect(overview[1]![6]).toBe('cell.notApplicable')
  })

  it('gives the 明細 sheet one row per 自評表 on screen, in the matrix order', () => {
    const matrix = trackingMatrix(DATA)
    const { detail } = trackingSheets(matrix, t)
    expect(detail[0]![0]).toBe('excel.year')
    expect(detail.slice(1).map((r) => `${r[3]}/${r[4]}`)).toEqual(['FQ/FQ-A', 'FQ/FQ-01.1', 'SY/SY-A', 'SY/SY-01', 'SZ/SZ-10.3', 'SZ/SZ-10.4'])
    expect(detail.find((r) => r[3] === 'FQ' && r[4] === 'FQ-A')).toEqual([
      2027, '富群公司', 'FQ廠', 'FQ', 'FQ-A', '控制環境', 'stage.signing', 2, 6, '部門主管－資材', 'SS140', '王小明',
      '2027-01-10 09:30', 5, '', '2027-03-31',
    ])
    // A 結案 one has no current 關卡 to have entered: only its 結案 date.
    expect(detail.find((r) => r[4] === 'SY-A')!.slice(-4)).toEqual(['', '', '2027-02-18', '2027-03-31'])
    expect(detail.find((r) => r[4] === 'SZ-10.3')![11]).toBe('')
  })
})
