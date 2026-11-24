import { describe, expect, it } from 'vitest'
import { cardNumber, cardTitle, headsSubsections, moveWithSubsections, numberColumnWidth, outline, outlineRows, pointNumbers } from './outline'

const section = (name: string, level = 1, code: string | null = null, points: { id: string; code: string | null }[] = []) => ({
  name,
  level,
  code,
  points,
})
const point = (id: string, code: string | null = null) => ({ id, code })

describe('outline', () => {
  it('a single-level template is one card per section, numbered as before', () => {
    const cards = outline([section('供應商管理作業'), section('採購作業')])
    expect(cards.map(cardTitle)).toEqual(['1. 供應商管理作業', '2. 採購作業'])
    expect(cards.map((c) => c.parts.length)).toEqual([1, 1])
  })

  it('groups 分段列 under their 第一層 card and shows the paper’s 題號 (SY-A)', () => {
    const cards = outline([
      section('董事會與高階管理階層應重視誠信與道德價值。', 1, '1'),
      section('公司是否建立內部行為準則？', 2, '1.1'),
      section('組織成員往來是否符合誠信？', 2, '1.2'),
      section('董事會及審計委員會應善盡治理監督責任。', 1, '2'),
      section('董事會是否瞭解利害關係人？', 2, '2.1'),
    ])
    expect(cards.map(cardTitle)).toEqual(['1 董事會與高階管理階層應重視誠信與道德價值。', '2 董事會及審計委員會應善盡治理監督責任。'])
    expect(cards.map(cardNumber)).toEqual(['1', '2'])
    expect(cards[0]!.parts.map((p) => [p.level, p.section.code])).toEqual([
      [1, '1'],
      [2, '1.1'],
      [2, '1.2'],
    ])
  })

  it('never shows a section more than one level deeper than the one before, and starts with a card', () => {
    const cards = outline([section('甲', 2), section('乙', 3), section('丙', 3), section('丁', 1), section('戊', 3)])
    expect(cards.map((c) => c.parts.map((p) => [p.section.name, p.level]))).toEqual([
      [
        ['甲', 1],
        ['乙', 2],
        ['丙', 3],
      ],
      [
        ['丁', 1],
        ['戊', 2],
      ],
    ])
  })
})

describe('pointNumbers', () => {
  it('numbers a card’s control points 1–n across its 分段 (10.1 研發循環 on paper)', () => {
    const [card] = outline([
      section('新產品導入管制作業', 1, null, []),
      section('估價階段', 2, null, [point('a')]),
      section('DVT(設計驗證測試階段)', 2, null, []),
      section('開模通知', 3, null, [point('b'), point('c')]),
    ])
    expect([...pointNumbers(card!, (s) => s.points)]).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ])
  })

  it('shows the paper’s 題號 where there is one; the others keep their place, so 1–9 then 10. stays in order (SY-08)', () => {
    const [card] = outline([section('衍生性商品交易作業', 1, null, [point('a'), point('b'), point('c', '3.'), point('d')])])
    expect([...pointNumbers(card!, (s) => s.points).values()]).toEqual(['1', '2', '3.', '4'])
  })

  it('starts again at 1 in each card', () => {
    const cards = outline([section('甲', 1, null, [point('a')]), section('乙', 1, null, [point('b')])])
    expect(cards.map((c) => [...pointNumbers(c, (s) => s.points).values()])).toEqual([['1'], ['1']])
  })
})

describe('numberColumnWidth', () => {
  it('keeps the narrow column for 1–99 and widens it for a longer 題號', () => {
    expect(numberColumnWidth(['1', '12', null], 50)).toBe(50)
    expect(numberColumnWidth(['1.1', '1.1.1-10'], 50)).toBe(98)
  })
})

describe('outlineRows', () => {
  const sections = [
    {
      id: 'a',
      name: '新產品導入管制作業',
      level: 1,
      code: null,
      rows: [] as string[],
    },
    { id: 'b', name: '估價階段', level: 2, code: null, rows: ['b1'] },
    { id: 'c', name: 'DVT', level: 2, code: null, rows: [] },
    { id: 'd', name: '開模通知', level: 3, code: null, rows: [] },
    { id: 'e', name: '料號申請', level: 3, code: null, rows: ['e1', 'e2'] },
    { id: 'f', name: 'PVT', level: 2, code: null, rows: [] },
  ]
  const shown = (rows: (string | { key: string })[]) => rows.map((r) => (typeof r === 'string' ? r : r.key))

  it('puts each 分段列 before its rows, a heading-only one included', () => {
    const [card] = outline(sections)
    expect(shown(outlineRows(card!, (s) => s.rows))).toEqual([
      'subheading:b',
      'b1',
      'subheading:c',
      'subheading:d',
      'subheading:e',
      'e1',
      'e2',
      'subheading:f',
    ])
  })

  it('with hideEmpty leaves out a 分段列 with nothing under it, but keeps the upper one of a deeper 分段 that has rows', () => {
    const [card] = outline(sections)
    expect(shown(outlineRows(card!, (s) => s.rows, { hideEmpty: true }))).toEqual(['subheading:b', 'b1', 'subheading:c', 'subheading:e', 'e1', 'e2'])
  })
})

describe('headsSubsections', () => {
  it('is true for a part followed by a deeper one', () => {
    const [card] = outline([section('甲'), section('乙', 2), section('丙', 2)])
    expect(card!.parts.map((_, i) => headsSubsections(card!, i))).toEqual([true, false, false])
  })
})

describe('moveWithSubsections (拖曳章節)', () => {
  // 甲 [乙 丙(丁)] 戊 己
  const sections = [
    { id: '甲', level: 1 },
    { id: '乙', level: 2 },
    { id: '丙', level: 2 },
    { id: '丁', level: 3 },
    { id: '戊', level: 1 },
    { id: '己', level: 1 },
  ]
  const drag = (moved: string, target: string) => {
    const ids = sections.map((s) => s.id).filter((id) => id !== moved)
    ids.splice(sections.findIndex((s) => s.id === target), 0, moved)
    return moveWithSubsections(sections, ids)
  }

  it('takes a 第一層’s 分段 along, after the target’s own 分段 when dropped further down', () => {
    expect(drag('甲', '戊')).toEqual(['戊', '甲', '乙', '丙', '丁', '己'])
  })

  it('puts the section and its 分段 before an earlier target', () => {
    expect(drag('戊', '甲')).toEqual(['戊', '甲', '乙', '丙', '丁', '己'])
    expect(drag('丙', '乙')).toEqual(['甲', '丙', '丁', '乙', '戊', '己'])
  })

  it('moves a section without 分段 as before, and does nothing when dropped into its own 分段', () => {
    expect(drag('己', '戊')).toEqual(['甲', '乙', '丙', '丁', '己', '戊'])
    expect(drag('丙', '丁')).toEqual(['甲', '乙', '丙', '丁', '戊', '己'])
  })
})
