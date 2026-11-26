import { describe, expect, it } from 'vitest'
import type { MyAssessment, MyPart } from '../api/myAssessmentsQuery'
import type { TrackingRow } from '../api/trackingQuery'
import { DUE_SOON_DAYS, dueLevel, firstTab, myStatus, myTabs, plantsProgress, showsFillProgress, todoAction } from './home'

function mine(id: string, my_part: MyPart, over: Partial<MyAssessment> = {}): MyAssessment {
  return {
    assessment_id: id, year: 2026, due_date: '2026-11-30', template_code: `FQ-${id}`, template_name: '採購及付款循環',
    factory_code: 'FQ', plant_name: '福清', status: 'in_progress', current_step_position: 1, current_step_name: '自行檢查人員－資材',
    stage: 'filling', due_in_days: 30, my_part, my_answered: null, my_question_count: null, my_started: null,
    can_open: true, ...over,
  }
}

describe('myTabs', () => {
  it('puts what I fill in and what I sign under 待處理, in the database’s order, and every row under 我參與的', () => {
    const rows = [mine('a', 'fill'), mine('b', 'sign'), mine('c', 'done'), mine('d', 'fill'), mine('e', 'upcoming')]
    const tabs = myTabs(rows)
    expect(tabs.todo.map((r) => r.assessment_id)).toEqual(['a', 'b', 'd'])
    expect(tabs.all.map((r) => r.assessment_id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('firstTab', () => {
  it('opens on 待處理 when something waits for me', () => {
    expect(firstTab(myTabs([mine('a', 'done'), mine('b', 'sign')]))).toBe('todo')
  })

  it('moves on to 我參與的 when nothing waits', () => {
    expect(firstTab(myTabs([mine('a', 'done')]))).toBe('all')
  })

  it('stays on 待處理 when both tabs are empty', () => {
    expect(firstTab(myTabs([]))).toBe('todo')
  })
})

describe('dueLevel', () => {
  it('is overdue once the 截止日 has passed, close within DUE_SOON_DAYS, else nothing', () => {
    expect(dueLevel(-1)).toBe('overdue')
    expect(dueLevel(0)).toBe('soon')
    expect(dueLevel(DUE_SOON_DAYS)).toBe('soon')
    expect(dueLevel(DUE_SOON_DAYS + 1)).toBeNull()
  })
})

describe('todoAction', () => {
  it('starts until their part is touched, continues once it is, even with no question fully answered yet', () => {
    expect(todoAction(mine('a', 'fill', { my_started: false, my_answered: 0 }))).toBe('start')
    expect(todoAction(mine('a', 'fill', { my_started: true, my_answered: 0 }))).toBe('continue')
    expect(todoAction(mine('a', 'fill', { my_started: true, my_answered: 3 }))).toBe('continue')
  })

  it('signs a row whose 關卡 only signs', () => {
    expect(todoAction(mine('a', 'sign'))).toBe('sign')
  })
})

describe('showsFillProgress', () => {
  it('gives 我的填寫進度 a column when anything is to be filled in, not when everything is to sign', () => {
    expect(showsFillProgress([mine('a', 'sign'), mine('b', 'fill')])).toBe(true)
    expect(showsFillProgress([mine('a', 'sign'), mine('b', 'sign')])).toBe(false)
    expect(showsFillProgress([])).toBe(false)
  })
})

describe('myStatus', () => {
  it('words 我參與的 by my part, telling 結案 from a 自評表 still being signed', () => {
    expect(myStatus(mine('a', 'fill'))).toBe('my_turn')
    expect(myStatus(mine('a', 'sign'))).toBe('my_turn')
    expect(myStatus(mine('a', 'upcoming'))).toBe('upcoming')
    expect(myStatus(mine('a', 'done'))).toBe('done')
    expect(myStatus(mine('a', 'done', { status: 'closed' }))).toBe('closed')
  })
})

function tracked(plant: string, code: string, over: Partial<TrackingRow> = {}): TrackingRow {
  return {
    assessment_id: `${plant}/${code}`, year: 2026, due_date: '2026-10-28',
    company_id: 'c', company_name: '公司', plant_id: `p-${plant}`, factory_code: plant, plant_name: `${plant}廠`,
    template_id: `t-${code}`, template_code: `${plant}-${code}`, template_name: '表',
    status: 'in_progress', current_step_position: 1, step_count: 5, current_step_name: '自行檢查人員',
    current_signer_emp_id: 'SSA77', current_signer_name: null, entered_step_at: '2026-10-01T00:00:00+00:00',
    days_at_step: 3, closed_at: null, stage: 'filling', due_in_days: 5,
    branch_count: 1, branches_done: 0, current_step_branch_unit: null,
    ...over,
  }
}

describe('plantsProgress', () => {
  it('counts 填寫中, 簽核中 and 結案 in all and per 廠區, in the rows’ order', () => {
    const progress = plantsProgress([
      tracked('FQ', '01'),
      tracked('FQ', '02', { stage: 'signing' }),
      tracked('FQ', '03', { status: 'closed', stage: 'closed' }),
      tracked('SY', '01', { status: 'closed', stage: 'closed' }),
    ])
    expect(progress.total).toEqual({ filling: 1, signing: 1, closed: 2, total: 4 })
    expect(progress.plants).toEqual([
      { id: 'p-FQ', factory_code: 'FQ', name: 'FQ廠', filling: 1, signing: 1, closed: 1, total: 3 },
      { id: 'p-SY', factory_code: 'SY', name: 'SY廠', filling: 0, signing: 0, closed: 1, total: 1 },
    ])
  })

  it('lists the 填寫中 past their 截止日, the most overdue first; signing or not yet due ones do not count', () => {
    const progress = plantsProgress([
      tracked('FQ', '01', { due_in_days: -1 }),
      tracked('FQ', '02', { due_in_days: -4 }),
      tracked('FQ', '03', { due_in_days: 0 }),
      tracked('SY', '01', { stage: 'signing', due_in_days: -9 }),
    ])
    expect(progress.overdueFilling.map((r) => r.template_code)).toEqual(['FQ-02', 'FQ-01'])
  })
})
