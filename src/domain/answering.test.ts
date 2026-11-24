import i18next from 'i18next'
import { describe, expect, it } from 'vitest'
import { DESIGN_OPTIONS, EMPTY_ANSWER, EXECUTION_OPTIONS, SATISFACTION_OPTIONS, type Answer, type Violation } from '../api/answerModel'
import enAnswering from '../locales/en/answering.json'
import zhTWAnswering from '../locales/zh-TW/answering.json'
import {
  answerKey,
  answerProgress,
  answerRows,
  assessingUnits,
  buildPayload,
  choiceFields,
  clearViolations,
  indexViolations,
  isAnswered,
  matrixHeader,
  nextUnanswered,
  showsUnitColumn,
  splitAnswerKey,
  unitOnlyRows,
} from './answering'

const VIOLATIONS: Violation[] = [
  { kind: 'control_point', control_point_id: 'p1', section_position: 1, position: 1, rule: 'unanswered' },
  { kind: 'control_point', control_point_id: 'p1', section_position: 1, position: 1, rule: 'improvement_required' },
  { kind: 'control_point', control_point_id: 'p4', section_position: 2, position: 2, rule: 'unanswered' },
  { kind: 'conclusion', assessing_unit_name: '資材單位', rule: 'explanation_required' },
]

describe('choiceFields', () => {
  it('gives 控制活動類 the 內控設計 column and the 無此情形 option, and 要素類 neither', () => {
    const summary = (layout: 'control_activity' | 'element') => choiceFields(layout).map((f) => [f.field, f.options.length])
    expect(summary('control_activity')).toEqual([['design', 2], ['execution', 4], ['satisfaction', 5]])
    expect(summary('element')).toEqual([['execution', 3], ['satisfaction', 5]])
  })
})

/** A snapshot control point with these 自評單位 in order (#46). */
const point = (id: string, position: number, units: string[]) => ({
  id,
  position,
  code: null,
  text: `第 ${position} 題`,
  assessment_control_point_unit: units.map((assessing_unit_name, i) => ({ position: i + 1, assessing_unit_name, assessment_answer: null })),
})
const section = (position: number, points: ReturnType<typeof point>[]) => ({
  id: `s${position}`,
  position,
  level: 1,
  code: null,
  name: '',
  assessment_control_point: points,
})

describe('assessingUnits', () => {
  it('lists each 自評單位 once, in paper order, skipping control points without one', () => {
    const sections = [
      section(1, [point('p1', 1, ['資材單位', '品保單位']), point('p2', 2, ['資材單位'])]),
      section(2, [point('p3', 1, []), point('p4', 2, ['生產單位', '財務單位'])]),
    ]
    expect(assessingUnits({ assessment_section: sections })).toEqual(['資材單位', '品保單位', '生產單位', '財務單位'])
  })
})

describe('answerRows', () => {
  // 04 存貨循環「物料標示與追溯性管理作業」的前三題：紙本上 1、2 題是合併格，各單位一列。
  const points = [point('p1', 1, ['資材單位', '品保單位']), point('p2', 2, ['品保單位', '生產單位', '資材單位']), point('p3', 3, ['品保單位'])]

  it('gives each 自評單位 its own row and spans the control point over its rows, numbered by control point', () => {
    expect(answerRows(points).map((r) => [r.point.position, r.unit, r.span])).toEqual([
      [1, '資材單位', 2],
      [1, '品保單位', 0],
      [2, '品保單位', 3],
      [2, '生產單位', 0],
      [2, '資材單位', 0],
      [3, '品保單位', 1],
    ])
  })

  it('keeps a control point without 自評單位 as one read-only row', () => {
    expect(answerRows([point('e1', 1, [])]).map((r) => [r.point.position, r.unit, r.span])).toEqual([[1, null, 1]])
  })

  it('keys each row by control point and 自評單位', () => {
    expect(new Set(answerRows(points).map((r) => r.key)).size).toBe(6)
    expect(answerRows(points)[1]!.key).toBe(answerKey('p1', '品保單位'))
  })
})

describe('showsUnitColumn', () => {
  it('always shows the 自評單位 column on 控制活動類', () => {
    expect(showsUnitColumn('control_activity', { assessment_section: [section(1, [point('p1', 1, ['資材單位'])])] })).toBe(true)
  })

  it('shows it on 要素類 only when more than one 自評單位 answers, so a one-unit 要素類 looks like the paper', () => {
    const one = { assessment_section: [section(1, [point('e1', 1, ['管理單位']), point('e2', 2, ['管理單位'])])] }
    const two = { assessment_section: [section(1, [point('e1', 1, ['管理單位', '財務單位'])])] }
    expect(showsUnitColumn('element', one)).toBe(false)
    expect(showsUnitColumn('element', two)).toBe(true)
  })
})

describe('indexViolations', () => {
  it('groups the database’s violations by control point and by 整體結論', () => {
    const index = indexViolations(VIOLATIONS)
    expect(Object.fromEntries(index.points)).toEqual({ p1: ['unanswered', 'improvement_required'], p4: ['unanswered'] })
    expect(Object.fromEntries(index.conclusions)).toEqual({ 資材單位: ['explanation_required'] })
  })

  it('is empty when there is nothing to highlight', () => {
    const index = indexViolations([])
    expect(index.points.size + index.conclusions.size).toBe(0)
  })
})

describe('clearViolations', () => {
  it('drops every highlight of the edited control point or 整體結論 and keeps the rest', () => {
    expect(clearViolations(VIOLATIONS, { controlPointId: 'p1' }).map((v) => v.rule)).toEqual(['unanswered', 'explanation_required'])
    expect(clearViolations(VIOLATIONS, { assessingUnitName: '資材單位' })).toHaveLength(3)
  })

  it('returns the same list when nothing matches, so React can skip the re-render', () => {
    expect(clearViolations(VIOLATIONS, { controlPointId: 'p9' })).toBe(VIOLATIONS)
  })
})

describe('buildPayload', () => {
  const answers: Record<string, Answer> = {
    [answerKey('p1', '品保單位')]: { ...EMPTY_ANSWER, execution: 'yes' },
    [answerKey('p2', '品保單位')]: { ...EMPTY_ANSWER, execution: 'no', improvement: '加強' },
    [answerKey('p2', '生產單位')]: EMPTY_ANSWER,
  }

  it('sends only the edited rows, each with its control point and 自評單位, and the 整體結論 only when it was edited', () => {
    const payload = buildPayload(answers, new Set([answerKey('p2', '品保單位')]), { unit: '品保單位', value: undefined, edited: false })
    expect(payload).toEqual({
      answers: [{ control_point_id: 'p2', assessing_unit_name: '品保單位', design: null, execution: 'no', satisfaction: null, improvement: '加強' }],
      conclusions: [],
    })
  })

  it('sends an edited 整體結論, empty when it was never chosen', () => {
    const payload = buildPayload(answers, new Set(), { unit: '資材單位', value: undefined, edited: true })
    expect(payload.conclusions).toEqual([{ assessing_unit_name: '資材單位', conclusion: null, exceptions: null }])
  })

  it('sends nothing for a read-only sheet', () => {
    expect(buildPayload(answers, new Set(), null)).toEqual({ answers: [], conclusions: [] })
  })
})

describe('matrixHeader', () => {
  /** The real 答題 translations, with 繁中 as the fallback language as in src/i18n/index.ts. */
  async function translations(lng: string) {
    const i18n = i18next.createInstance()
    await i18n.init({
      lng,
      fallbackLng: 'zh-TW',
      ns: ['answering'],
      defaultNS: 'answering',
      resources: { 'zh-TW': { answering: zhTWAnswering }, en: { answering: enAnswering } },
    })
    return i18n
  }

  it('breaks 繁中 headers between words like the paper (內部控制／制度設計, 需要／加強)', async () => {
    const i18n = await translations('zh-TW')
    const header = (key: string, label: string) => matrixHeader(i18n.t, i18n.resolvedLanguage!, key, label)
    expect(header('groups.design', '內部控制制度設計')).toBe('內部控制\n制度設計')
    expect(header('options.needs_improvement', '需要加強')).toBe('需要\n加強')
    expect(header('options.adequate', '剛好')).toBe('剛好')
  })

  it('shows a language without its own breaks in that language, not the 繁中 fallback', async () => {
    const i18n = await translations('en')
    const header = (key: string, label: string) => matrixHeader(i18n.t, i18n.resolvedLanguage!, key, label)
    expect(header('groups.design', 'Control design')).toBe('Control design')
    expect(header('options.needs_improvement', 'Needs improvement')).toBe('Needs improvement')
  })

  it('has a break for every option the 繁中 headers name, so a renamed option cannot silently lose it', () => {
    const options = [...DESIGN_OPTIONS, ...EXECUTION_OPTIONS, ...SATISFACTION_OPTIONS] as string[]
    expect(Object.keys(zhTWAnswering.headers.options).filter((o) => !options.includes(o))).toEqual([])
    expect(Object.keys(zhTWAnswering.headers.groups).filter((g) => !['design', 'execution', 'satisfaction'].includes(g))).toEqual([])
  })
})

describe('splitAnswerKey', () => {
  it('gives back the control point and 自評單位 of a key, including a unit name with a colon', () => {
    expect(splitAnswerKey(answerKey('p1', '品保:一課'))).toEqual({ control_point_id: 'p1', assessing_unit_name: '品保:一課' })
  })

  it('keeps the whole control point id for the key of a row without 自評單位', () => {
    const [row] = answerRows([point('e1', 1, [])])
    expect(splitAnswerKey(row!.key)).toEqual({ control_point_id: 'e1', assessing_unit_name: null })
  })
})

describe('unitOnlyRows (只看我的題目, #134)', () => {
  const points = [point('p1', 1, ['資材單位', '品保單位']), point('p2', 2, ['生產單位']), point('p3', 3, ['品保單位']), point('e1', 4, [])]

  it("keeps only the unit's rows, each its own control point's only row, and counts the other units' rows left out", () => {
    const { rows, otherUnits } = unitOnlyRows(points, '品保單位')
    expect(rows.map((r) => [r.point.position, r.unit, r.span])).toEqual([
      [1, '品保單位', 1],
      [3, '品保單位', 1],
    ])
    expect(rows.map((r) => r.key)).toEqual([answerKey('p1', '品保單位'), answerKey('p3', '品保單位')])
    // p1 資材單位 and p2 生產單位; e1, which nobody answers, is left out but is no other unit's question.
    expect(otherUnits).toBe(2)
  })

  it('hides a whole section without the unit', () => {
    expect(unitOnlyRows(points.slice(1, 2), '品保單位')).toEqual({ rows: [], otherUnits: 1 })
  })
})

describe('isAnswered', () => {
  const answer = (patch: Partial<Answer>): Answer => ({ ...EMPTY_ANSWER, ...patch })

  it('needs 內控設計, 執行情形 and 滿意度 on 控制活動類', () => {
    expect(isAnswered('control_activity', answer({ design: 'has_rule', execution: 'yes', satisfaction: 'satisfied' }))).toBe(true)
    expect(isAnswered('control_activity', answer({ execution: 'yes', satisfaction: 'satisfied' }))).toBe(false)
    expect(isAnswered('control_activity', answer({ design: 'has_rule', satisfaction: 'satisfied' }))).toBe(false)
    expect(isAnswered('control_activity', answer({ design: 'has_rule', execution: 'yes' }))).toBe(false)
  })

  it('needs only 執行情形 and 滿意度 on 要素類, which has no 內控設計', () => {
    expect(isAnswered('element', answer({ execution: 'no', satisfaction: 'adequate' }))).toBe(true)
    expect(isAnswered('element', answer({ execution: 'no' }))).toBe(false)
  })

  it('does not ask for 改善措施 (送出 checks it) and counts a row without an answer as unanswered', () => {
    expect(isAnswered('control_activity', answer({ design: 'no_rule', execution: 'no', satisfaction: 'dissatisfied', improvement: null }))).toBe(true)
    expect(isAnswered('control_activity', undefined)).toBe(false)
  })
})

describe('answerProgress', () => {
  const done: Answer = { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }

  it('counts the given rows answered and lists the rest in paper order', () => {
    const answers = { a: done, b: { ...done, satisfaction: null }, d: done }
    expect(answerProgress('control_activity', ['a', 'b', 'c', 'd'], answers)).toEqual({ answered: 2, total: 4, unanswered: ['b', 'c'] })
  })

  it('ignores rows outside the given ones, such as other units', () => {
    expect(answerProgress('control_activity', ['a'], { a: done, other: EMPTY_ANSWER })).toEqual({ answered: 1, total: 1, unanswered: [] })
  })
})

describe('nextUnanswered (下一題未填, #134)', () => {
  const rows = ['r1', 'r2', 'r3', 'r4', 'r5']

  it('starts at the first unanswered row', () => {
    expect(nextUnanswered(rows, ['r2', 'r4'], null)).toBe('r2')
  })

  it('goes on to the next unanswered row after the current one', () => {
    expect(nextUnanswered(rows, ['r2', 'r4'], 'r2')).toBe('r4')
    // The current row may have been answered meanwhile, or be answered already.
    expect(nextUnanswered(rows, ['r4'], 'r2')).toBe('r4')
    expect(nextUnanswered(rows, ['r2', 'r4'], 'r3')).toBe('r4')
  })

  it('goes back to the first unanswered row past the last one', () => {
    expect(nextUnanswered(rows, ['r2', 'r4'], 'r4')).toBe('r2')
    expect(nextUnanswered(rows, ['r2'], 'r2')).toBe('r2')
  })

  it('gives null when every row is answered (the button goes to 整體結論)', () => {
    expect(nextUnanswered(rows, [], 'r3')).toBeNull()
  })
})
