import i18next, { type TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import type { TemplateComponent } from '../api/templates'
import zhTWCommon from '../locales/zh-TW/common.json'
import {
  applyOrder,
  COMPONENTS,
  confirmPhraseMatches,
  controlPointCount,
  ELEMENT_COMPONENTS,
  componentChoices,
  componentKey,
  groupByComponent,
  listPathFor,
  ALL_VIEW,
  pickView,
  rowsOfView,
  moveId,
  unitRequired,
  visibleTemplates,
  writeErrorMessage,
  type ComponentGroup,
} from './templates'

describe('unitRequired', () => {
  it('is required for 控制活動類 and optional for 要素類', () => {
    expect(unitRequired('control_activity')).toBe(true)
    expect(unitRequired('element')).toBe(false)
  })
})

describe('moveId', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('drops a row onto a later one: it lands after it', () => {
    expect(moveId(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
  })

  it('drops a row onto an earlier one: it lands before it', () => {
    expect(moveId(ids, 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('leaves the order alone when dropped on itself or on something that is not in the list', () => {
    expect(moveId(ids, 'b', 'b')).toEqual(ids)
    expect(moveId(ids, 'b', 'x')).toEqual(ids)
    expect(moveId(ids, 'x', 'b')).toEqual(ids)
  })
})

describe('applyOrder', () => {
  it('reorders rows and renumbers positions from 1', () => {
    const rows = [
      { id: 'a', position: 1, name: '甲' },
      { id: 'b', position: 2, name: '乙' },
      { id: 'c', position: 3, name: '丙' },
    ]
    expect(applyOrder(rows, ['c', 'a', 'b'])).toEqual([
      { id: 'c', position: 1, name: '丙' },
      { id: 'a', position: 2, name: '甲' },
      { id: 'b', position: 3, name: '乙' },
    ])
  })
})

describe('writeErrorMessage', () => {
  const t = ((key: string, options?: { message?: string }) => (options?.message ? `${key}:${options.message}` : key)) as unknown as TFunction

  it('maps the database refusals to a message key', () => {
    expect(writeErrorMessage(t, { code: '23503', message: 'fk' })).toBe('common:templates.errors.inUse')
    expect(writeErrorMessage(t, { code: '42501', message: 'rls' })).toBe('common:templates.errors.forbidden')
  })

  it('lets the caller say what a duplicate means on its page', () => {
    expect(writeErrorMessage(t, { code: '23505' }, { '23505': 'templates.units.duplicate' })).toBe('templates.units.duplicate')
  })

  it('falls back to the raw message', () => {
    expect(writeErrorMessage(t, { code: 'XX000', message: 'boom' })).toBe('common:templates.errors.generic:boom')
    expect(writeErrorMessage(t, new Error('network'))).toBe('common:templates.errors.generic:network')
  })

  it('finds the shared messages even through a page namespace other than common', async () => {
    const i18n = i18next.createInstance()
    await i18n.init({ lng: 'zh-TW', resources: { 'zh-TW': { common: zhTWCommon, flows: {} } }, defaultNS: 'common', interpolation: { escapeValue: false } })
    const flowsT = i18n.getFixedT(null, 'flows')
    expect(writeErrorMessage(flowsT, { code: '42501' })).toBe('只有稽核主管可以修改範本')
    expect(writeErrorMessage(flowsT, { code: 'XX000', message: 'boom' })).toBe('儲存失敗：boom')
  })
})

describe('visibleTemplates', () => {
  const rows = [
    { id: 'a', status: 'active' as const },
    { id: 'i', status: 'inactive' as const },
  ]

  it('hides 停用 templates by default', () => {
    expect(visibleTemplates(rows, false).map((r) => r.id)).toEqual(['a'])
  })

  it('shows everything when asked', () => {
    expect(visibleTemplates(rows, true).map((r) => r.id)).toEqual(['a', 'i'])
  })
})

describe('confirmPhraseMatches', () => {
  it('needs the whole phrase, not just the 編號', () => {
    expect(confirmPhraseMatches('刪除 01.1', '刪除 01.1')).toBe(true)
    expect(confirmPhraseMatches('01.1', '刪除 01.1')).toBe(false)
    expect(confirmPhraseMatches('刪除 01.2', '刪除 01.1')).toBe(false)
    expect(confirmPhraseMatches('', '刪除 01.1')).toBe(false)
  })

  it('ignores surrounding spaces and treats any run of spaces, full-width too, as one', () => {
    expect(confirmPhraseMatches(' 刪除  01.1 ', '刪除 01.1')).toBe(true)
    expect(confirmPhraseMatches('刪除　01.1', '刪除 01.1')).toBe(true)
    expect(confirmPhraseMatches('刪除01.1', '刪除 01.1')).toBe(false)
  })

  it('ignores letter case', () => {
    expect(confirmPhraseMatches('Delete A1', 'delete a1')).toBe(true)
  })
})

describe('listPathFor', () => {
  it('opens the list on the item’s 組成要素, 未分類 included', () => {
    expect(listPathFor('/admin/templates', 'monitoring')).toBe('/admin/templates?component=monitoring')
    expect(listPathFor('/admin/flows', null)).toBe('/admin/flows?component=unclassified')
    expect(listPathFor('/admin/flows', 'control_activities', 'GT')).toBe('/admin/flows?component=control_activities&plant=GT')
  })
})

describe('pickView', () => {
  const groups = groupByComponent(
    [{ c: 'control_activities' as const }, { c: 'monitoring' as const }],
    (r) => r.c,
  )

  it('keeps the one asked for, even when it has no rows', () => {
    expect(pickView(groups, 'monitoring')).toBe('monitoring')
    expect(pickView(groups, 'risk_assessment')).toBe('risk_assessment')
  })

  it('falls back to the first with rows for nothing, nonsense, or an 未分類 that is not there', () => {
    expect(pickView(groups, null)).toBe('control_activities')
    expect(pickView(groups, 'nonsense')).toBe('control_activities')
    expect(pickView(groups, 'unclassified')).toBe('control_activities')
  })

  it('offers 未分類 once some row has no component, and starts at 控制環境 when nothing has rows', () => {
    expect(pickView(groupByComponent([{ c: null }], (r) => r.c), 'unclassified')).toBe('unclassified')
    expect(pickView(groupByComponent([], () => null), null)).toBe('control_environment')
  })

  it('opens 全部 only when asked for; it is never the default', () => {
    expect(pickView(groups, 'all')).toBe(ALL_VIEW)
    expect(pickView(groups, null)).not.toBe(ALL_VIEW)
  })
})

describe('rowsOfView', () => {
  const rows = [{ code: 'D', c: 'monitoring' as const }, { code: '01', c: 'control_activities' as const }, { code: 'X', c: null }]
  const groups = groupByComponent(rows, (r) => r.c)

  it('lists one 組成要素, or for 全部 every row in the five groups’ order with 未分類 last', () => {
    expect(rowsOfView(groups, 'monitoring').map((r) => r.code)).toEqual(['D'])
    expect(rowsOfView(groups, 'risk_assessment')).toEqual([])
    expect(rowsOfView(groups, ALL_VIEW).map((r) => r.code)).toEqual(['01', 'D', 'X'])
  })
})

describe('groupByComponent', () => {
  const tpl = (code: string, component: TemplateComponent | null) => ({ code, component })
  const summary = (groups: ComponentGroup<{ code: string }>[]) => groups.map((g) => [g.component, g.rows.map((r) => r.code)])

  it('puts the rows under the five 組成要素 in the 準則 order, keeping their own order', () => {
    const rows = [tpl('01.1', 'control_activities'), tpl('A', 'control_environment'), tpl('02', 'control_activities'), tpl('D', 'monitoring')]
    expect(summary(groupByComponent(rows, (r) => r.component))).toEqual([
      ['control_environment', ['A']],
      ['risk_assessment', []],
      ['control_activities', ['01.1', '02']],
      ['information_communication', []],
      ['monitoring', ['D']],
    ])
  })

  it('adds 未分類 last, only when some row has no component', () => {
    const groups = groupByComponent([tpl('X', null), tpl('B', 'risk_assessment')], (r) => r.component)
    expect(groups.map((g) => g.component)).toEqual([...COMPONENTS, null])
    expect(groups.at(-1)?.rows.map((r) => r.code)).toEqual(['X'])
  })

  it('leaves 控制作業 out of the 要素類 choices', () => {
    expect(ELEMENT_COMPONENTS).toEqual(['control_environment', 'risk_assessment', 'information_communication', 'monitoring'])
  })

  it('offers all five for a new template, then only what shares its 版型', () => {
    expect(componentChoices()).toEqual({ choices: COMPONENTS, hint: 'componentChoiceHint' })
    expect(componentChoices('control_activity')).toEqual({ choices: ['control_activities'], hint: 'componentFixedControl' })
    expect(componentChoices('element')).toEqual({ choices: ELEMENT_COMPONENTS, hint: 'componentFixedElement' })
  })

  it('names 未分類 for a missing component', () => {
    expect(componentKey(null)).toBe('unclassified')
    expect(componentKey('monitoring')).toBe('monitoring')
  })
})

describe('controlPointCount', () => {
  it('adds up the control points of every section, and is 0 without sections', () => {
    expect(controlPointCount({ template_section: [{ control_point: [1, 2] }, { control_point: [] }, { control_point: [3] }] })).toBe(3)
    expect(controlPointCount({ template_section: [] })).toBe(0)
  })
})
