import { describe, expect, it } from 'vitest'
import { hasRowsInView, NO_PLANT, ownPlantOf, pickPlant, plantLabel, plantOptions, rowsOfPlant, sameContentIndex, viewAfterPlantChange } from './plantChoice'

const tpl = (id: string, plants: string[] | 'all', fingerprint: string | null = id, status = 'active', component = 'control_activities' as const) => ({
  id,
  all_plants: plants === 'all',
  template_plant: plants === 'all' ? [] : plants.map((factory_code) => ({ factory_code })),
  content_fingerprint: fingerprint,
  status,
  component,
})

const ROWS = [
  tpl('GT-07', ['GT'], 'finance'),
  tpl('TC-07', ['TC'], 'finance'),
  tpl('FQ-06', ['FQ', 'SY'], 'finance'),
  tpl('LH-07', ['LH'], 'finance', 'inactive'),
  tpl('GT-05', ['GT'], 'rd-gt'),
  tpl('GT-EMPTY', ['GT'], null),
  tpl('TC-EMPTY', ['TC'], null),
  tpl('SAMOA-01', []),
  tpl('ALL', 'all'),
]

describe('rowsOfPlant', () => {
  it('lists the plant’s own templates and the all-plants ones', () => {
    expect(rowsOfPlant(ROWS, 'GT').map((r) => r.id)).toEqual(['GT-07', 'GT-05', 'GT-EMPTY', 'ALL'])
    expect(rowsOfPlant(ROWS, 'SY').map((r) => r.id)).toEqual(['FQ-06', 'ALL'])
  })

  it('lists templates without any plant under 未指定廠區', () => {
    expect(rowsOfPlant(ROWS, NO_PLANT).map((r) => r.id)).toEqual(['SAMOA-01'])
  })
})

describe('plantOptions', () => {
  const plants = [
    { factory_code: 'GT', name: '敬得(觀音)' },
    { factory_code: 'TC', name: '敬得(太倉)' },
  ]

  it('offers every plant, codes only templates use, and 未指定廠區 only when some template has no plant', () => {
    expect(plantOptions(plants, ROWS, '未指定廠區').map((o) => o.key)).toEqual(['GT', 'TC', 'FQ', 'LH', 'SY', NO_PLANT])
    expect(plantOptions(plants, [tpl('GT-07', ['GT'])], '未指定廠區').map((o) => o.key)).toEqual(['GT', 'TC'])
  })

  it('labels a plant by code and name, a code outside the master by its code, 未指定廠區 by name', () => {
    expect(plantOptions(plants, ROWS, '未指定廠區').map(plantLabel)).toEqual(['GT 敬得(觀音)', 'TC 敬得(太倉)', 'FQ', 'LH', 'SY', '未指定廠區'])
  })
})

describe('pickPlant', () => {
  const options = [{ key: 'FQ', code: 'FQ', name: '' }, { key: 'GT', code: 'GT', name: '' }]

  it('takes the URL first, then the remembered choice, then the first plant', () => {
    expect(pickPlant(options, 'GT', 'FQ')).toBe('GT')
    expect(pickPlant(options, null, 'GT')).toBe('GT')
    expect(pickPlant(options, 'XX', 'YY')).toBe('FQ')
  })

  it('chooses nothing when there are no plants, so the list is not split', () => {
    expect(pickPlant([], 'GT', 'GT')).toBeNull()
  })
})

describe('sameContentIndex', () => {
  const sameContent = sameContentIndex(ROWS)

  it('lists the other plants whose current template has the same content, sorted, leaving out 停用 ones', () => {
    expect(sameContent(ROWS[0]!, 'GT')).toEqual(['FQ', 'SY', 'TC'])
  })

  it('includes the other plants the same template applies to', () => {
    expect(sameContent(ROWS[2]!, 'SY')).toEqual(['FQ', 'GT', 'TC'])
  })

  it('is empty for a template no other plant shares, and for templates with no content yet', () => {
    expect(sameContent(ROWS[4]!, 'GT')).toEqual([])
    expect(sameContent(ROWS[5]!, 'GT')).toEqual([])
  })
})

describe('switching plants keeps the tab only when the next plant has templates in it', () => {
  const samoa = [{ component: 'control_activities' as const }]

  it('hasRowsInView: the tab, 全部 or no tab yet', () => {
    expect(hasRowsInView(samoa, 'control_activities')).toBe(true)
    expect(hasRowsInView(samoa, 'all')).toBe(true)
    expect(hasRowsInView(samoa, null)).toBe(true)
    expect(hasRowsInView(samoa, 'control_environment')).toBe(false)
  })

  it('viewAfterPlantChange clears the tab the next plant has nothing (visible) in', () => {
    const after = (rows: typeof ROWS, search: string) => {
      const params = new URLSearchParams(search)
      viewAfterPlantChange(rows)(params)
      return params.toString()
    }
    expect(after(rowsOfPlant(ROWS, 'TC'), 'component=control_activities')).toBe('component=control_activities')
    expect(after(rowsOfPlant(ROWS, NO_PLANT), 'component=control_environment&plant=GT')).toBe('plant=GT')
    expect(after([], '')).toBe('')
    // LH has only a 停用 template there: kept only while the URL says 停用 ones are shown.
    const lh = rowsOfPlant(ROWS, 'LH').filter((r) => r.id !== 'ALL')
    expect(after(lh, 'component=control_activities')).toBe('')
    expect(after(lh, 'component=control_activities&inactive=1')).toBe('component=control_activities&inactive=1')
  })

  it('ownPlantOf: the one plant a template is for, 未指定廠區 for none, nothing for several or all', () => {
    expect(ownPlantOf(ROWS.find((r) => r.id === 'GT-07')!)).toBe('GT')
    expect(ownPlantOf(ROWS.find((r) => r.id === 'SAMOA-01')!)).toBe(NO_PLANT)
    expect(ownPlantOf(ROWS.find((r) => r.id === 'FQ-06')!)).toBeUndefined()
    expect(ownPlantOf(ROWS.find((r) => r.id === 'ALL')!)).toBeUndefined()
  })
})
