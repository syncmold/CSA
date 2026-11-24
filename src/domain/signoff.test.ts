import { describe, expect, it } from 'vitest'
import type { AssessmentStep, MyCurrentStep, StepState } from '../api/assessments'
import type { Signoff } from '../api/signoffModel'
import {
  advanceMessageKey,
  advancedTo,
  branchColumns,
  formatSigner,
  maxBranchColumns,
  myAnswerStep,
  mySignStep,
  nameInBranch,
  returnTargets,
  routeLayout,
  routeProgress,
  routeSteps,
  signedStepLabel,
  signerLabeler,
  stepLabel,
  stepLabelAt,
  type SignoffSource,
} from './signoff'

const step = (position: number, signer: string, group: 'plant' | 'audit_review' = 'plant'): AssessmentStep => ({
  id: `step-${position}`, position, name: `關卡${position}`, step_group: group, signer_emp_id: signer, editable_unit_name: null,
  branch_unit_name: null, state: 'pending',
})
const STEPS = [step(1, 'B'), step(2, 'C'), step(3, 'C'), step(4, 'E', 'audit_review'), step(5, 'F', 'audit_review')]

/** A straight route with the database's states: before `current` done, `current` current, the rest pending. */
const source = (current: number, status: 'in_progress' | 'closed' = 'in_progress', names: [string, string][] = []): SignoffSource => ({
  assessment_step: STEPS.map((s) => ({
    ...s,
    state: (status === 'closed' || s.position < current ? 'done' : s.position === current ? 'current' : 'pending') as StepState,
  })),
  status,
  signerNames: new Map(names),
})

/**
 * Two 分流 and the 匯流 (Q116): 資材 1 → 3, 品保 2 → 4 → 5 (a 課長 added), then 廠區經理人 6 and 稽核室 7, 8.
 * `states` gives each 關卡's state in position order.
 */
const branched = (states: StepState[]): AssessmentStep[] =>
  [
    { ...step(1, 'B'), name: '自行檢查人員－資材單位', editable_unit_name: '資材單位', branch_unit_name: '資材單位' },
    { ...step(2, 'B'), name: '自行檢查人員－品保單位', editable_unit_name: '品保單位', branch_unit_name: '品保單位' },
    { ...step(3, 'C'), name: '部門主管－資材單位', branch_unit_name: '資材單位' },
    { ...step(4, 'D'), name: '課長', branch_unit_name: '品保單位' },
    { ...step(5, 'C'), name: '部門主管 - 品保單位', branch_unit_name: '品保單位' },
    { ...step(6, 'M'), name: '廠區經理人' },
    { ...step(7, 'E', 'audit_review'), name: '子公司擔當稽核' },
    { ...step(8, 'F', 'audit_review'), name: '稽核主管' },
  ].map((s, i) => ({ ...s, state: states[i]! }))

const mine = (position: number, editable: string | null, targets: number[] = [], closes = false): MyCurrentStep => ({
  position, name: `關卡${position}`, branch_unit_name: null, editable_unit_name: editable, return_targets: targets, closes,
})

let serial = 0
const signoff = (stepPosition: number, action: Signoff['action'], signer: string, name: string | null, voided = false): Signoff => ({
  serial_no: ++serial, step_id: `step-${stepPosition}`, step_position: stepPosition, step_name: `關卡${stepPosition}`, action,
  signer_emp_id: signer, signer_name: name, comment: null, return_to_position: action === 'return' ? 1 : null,
  signature_method: 'system_record', signed_at: `2026-10-16T00:00:${String(serial).padStart(2, '0')}Z`,
  voided_at: voided ? '2026-10-16T01:00:00Z' : null,
})

describe('routeSteps', () => {
  it('takes each 關卡 state from the database: done, current, and pending shown as todo', () => {
    expect(routeSteps(source(3), []).map((r) => r.state)).toEqual(['done', 'done', 'current', 'todo', 'todo'])
  })

  it('marks every 關卡 done once the 自評表 is closed', () => {
    expect(routeSteps(source(5, 'closed'), []).map((r) => r.state)).toEqual(['done', 'done', 'done', 'done', 'done'])
  })

  it('names each 簽核人 in full and by name alone, falling back to the 工號', () => {
    const route = routeSteps(source(1, 'in_progress', [['C', '丙']]), [signoff(1, 'submit', 'B', '乙')])
    expect(route.slice(0, 4).map((r) => [r.signer, r.signerName])).toEqual([
      ['乙（B）', '乙'], ['丙（C）', '丙'], ['丙（C）', '丙'], ['E', 'E'],
    ])
  })

  it('says 待分派 for a 關卡 without a 簽核人, and keeps the name of one that only waits for a colleague', () => {
    const steps = [{ ...step(1, 'B'), state: 'pending' as const }, { ...step(2, 'C'), signer_emp_id: null, state: 'pending' as const }]
    const a = { ...source(1), assessment_step: steps }
    expect(routeSteps(a, []).map((r) => [r.state, r.signerName])).toEqual([['todo', 'B'], ['unassigned', null]])
  })

  it('shows several current 關卡 when 分流 run at the same time', () => {
    const a = { ...source(1), assessment_step: branched(['done', 'current', 'current', 'pending', 'pending', 'pending', 'pending', 'pending']) }
    expect(routeSteps(a, []).map((r) => r.state)).toEqual(['done', 'current', 'current', 'todo', 'todo', 'todo', 'todo', 'todo'])
  })

  it('after a 退回 uses the re-signed sign-off, never a voided one, and leaves voided later 關卡 todo', () => {
    const signoffs = [
      signoff(1, 'submit', 'B', '乙', true),
      signoff(2, 'approve', 'C', '丙', true),
      signoff(3, 'return', 'C', '丙'),
      signoff(1, 'submit', 'B', '乙'),
    ]
    expect(routeSteps(source(2), signoffs).map((r) => [r.state, r.signoff?.serial_no ?? null])).toEqual([
      ['done', signoffs[3]!.serial_no],
      ['current', null],
      ['todo', null],
      ['todo', null],
      ['todo', null],
    ])
  })

  it('keeps a sign-off with its 關卡 by id when 加簽 has renumbered the route', () => {
    // 原第 2 關（id step-2）簽過之後，前面加簽了一關，它現在是第 3 關
    const done = (s: AssessmentStep): AssessmentStep => ({ ...s, state: 'done' })
    const renumbered: SignoffSource = {
      ...source(4),
      assessment_step: [done(step(1, 'B')), { ...step(2, 'X'), id: 'inserted' }, done({ ...step(3, 'C'), id: 'step-2' }), step(4, 'E')],
    }
    const signed = signoff(2, 'approve', 'C', '丙')
    expect(routeSteps(renumbered, [signed]).map((r) => r.signoff?.serial_no ?? null)).toEqual([null, null, signed.serial_no, null])
  })
})

describe('routeLayout', () => {
  it('puts each 自評單位 in its own 分流 in route order, then the 匯流後 廠區 關卡, then 稽核室', () => {
    const a = { ...source(1), assessment_step: branched(['done', 'done', 'done', 'current', 'pending', 'pending', 'pending', 'pending']) }
    const layout = routeLayout(a, [])
    expect(layout.branches.map((b) => [b.unit, b.steps.map((r) => r.step.position), b.done])).toEqual([
      ['資材單位', [1, 3], true],
      ['品保單位', [2, 4, 5], false],
    ])
    expect(layout.merged.map((r) => r.step.position)).toEqual([6])
    expect(layout.audit.map((r) => r.step.position)).toEqual([7, 8])
  })

  it('counts the 退回 into each 分流', () => {
    const a = { ...source(1), assessment_step: branched(['current', 'done', 'pending', 'done', 'done', 'pending', 'pending', 'pending']) }
    const back = (to: number) => ({ ...signoff(6, 'return', 'M', '經理'), return_to_position: to })
    expect(routeLayout(a, [back(1), back(4), back(1)]).branches.map((b) => [b.unit, b.returns])).toEqual([
      ['資材單位', 2],
      ['品保單位', 1],
    ])
  })

  it('is all 匯流後 for a route without 分流', () => {
    const layout = routeLayout(source(2), [])
    expect([layout.branches, layout.merged.length, layout.audit.length]).toEqual([[], 3, 2])
  })
})

describe('maxBranchColumns', () => {
  it('counts the cards that fit, their gaps included', () => {
    expect(maxBranchColumns(632, 120, 8)).toBe(5)
    expect(maxBranchColumns(631, 120, 8)).toBe(4)
    expect(maxBranchColumns(120, 120, 8)).toBe(1)
  })

  it('keeps one column however narrow, or before anything is measured', () => {
    expect(maxBranchColumns(80, 120, 8)).toBe(1)
    expect(maxBranchColumns(0, 120, 8)).toBe(1)
  })
})

describe('branchColumns', () => {
  it.each([
    [6, 5, 3], // 3＋3
    [7, 5, 4], // 4＋3
    [8, 5, 4], // 4＋4
    [5, 5, 5], // one row
    [4, 3, 2], // 2＋2
    [7, 3, 3], // 3＋3＋1
    [3, 1, 1], // one column
    [2, 7, 2], // fewer cards than room
    [1, 5, 1],
  ])('%i 分流 at most %i wide take %i a row', (count, maxColumns, columns) => {
    expect(branchColumns(count, maxColumns)).toBe(columns)
  })

  it('has nothing to lay out without a 分流', () => {
    expect(branchColumns(0, 5)).toBe(0)
  })
})

describe('nameInBranch', () => {
  it('drops the unit the column is headed with, whatever dash joins it, and keeps other names whole', () => {
    expect(branched(Array<StepState>(8).fill('pending')).map(nameInBranch)).toEqual([
      '自行檢查人員', '自行檢查人員', '部門主管', '課長', '部門主管', '廠區經理人', '子公司擔當稽核', '稽核主管',
    ])
    expect(nameInBranch({ name: '資材單位', branch_unit_name: '資材單位' })).toBe('資材單位')
  })
})

describe('stepLabel', () => {
  it('names a 分流 關卡 by its unit, then its name within the 分流, and one after the 匯流 by its name (#99)', () => {
    expect(branched(Array<StepState>(8).fill('pending')).map(stepLabel)).toEqual([
      '資材單位・自行檢查人員', '品保單位・自行檢查人員', '資材單位・部門主管', '品保單位・課長', '品保單位・部門主管', '廠區經理人', '子公司擔當稽核', '稽核主管',
    ])
  })

  it('labels a 簽核紀錄 by the name it was signed under, in the 分流 of its position', () => {
    const steps = branched(Array<StepState>(8).fill('pending'))
    expect(signedStepLabel(steps, 4, '課長')).toBe('品保單位・課長')
    expect(signedStepLabel(steps, 6, '廠區經理人')).toBe('廠區經理人')
    expect(signedStepLabel(steps, 99, '已不在流程中的關卡')).toBe('已不在流程中的關卡')
  })

  it('labels the 關卡 at a position, e.g. where a 退回 went, and nothing where there is none', () => {
    const steps = branched(Array<StepState>(8).fill('pending'))
    expect([stepLabelAt(steps, 1), stepLabelAt(steps, 7), stepLabelAt(steps, null), stepLabelAt(steps, 99)]).toEqual([
      '資材單位・自行檢查人員', '子公司擔當稽核', null, null,
    ])
  })
})

describe('routeProgress', () => {
  it('counts the finished 分流 and lists where the others are while they run', () => {
    const steps = branched(['done', 'done', 'done', 'current', 'pending', 'pending', 'pending', 'pending'])
    expect(routeProgress({ assessment_step: steps, currentStep: null })).toEqual({ kind: 'branches', done: 1, total: 2, current: [steps[3]] })
  })

  it('lists the 分流 in the order they are drawn, whichever 關卡 each one has reached', () => {
    // 資材 is at its 部門主管 (3), 品保 still at its 自行檢查人員 (2): 資材 comes first, as on the diagram.
    const steps = branched(['done', 'current', 'current', 'pending', 'pending', 'pending', 'pending', 'pending'])
    const progress = routeProgress({ assessment_step: steps, currentStep: null })
    expect(progress.kind === 'branches' && progress.current.map((s) => s.position)).toEqual([3, 2])
  })

  it('counts the 分流 even when none has started yet (all 待分派)', () => {
    const steps = branched(['pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending'])
    expect(routeProgress({ assessment_step: steps, currentStep: null })).toEqual({ kind: 'branches', done: 0, total: 2, current: [] })
  })

  it('names the one 關卡 once the 分流 have merged', () => {
    const steps = branched(['done', 'done', 'done', 'done', 'done', 'current', 'pending', 'pending'])
    expect(routeProgress({ assessment_step: steps, currentStep: steps[5]! })).toEqual({ kind: 'step', step: steps[5] })
  })
})

describe('mySignStep, myAnswerStep and returnTargets', () => {
  it('works on the first 關卡 of each kind that is the signed-in employee turn, one at a time', () => {
    const a = { my_current_steps: [mine(1, '資材單位'), mine(2, '品保單位'), mine(3, null, [1]), mine(5, null, [2, 4])] }
    expect([myAnswerStep(a)?.position, mySignStep(a)?.position]).toEqual([1, 3])
    expect([myAnswerStep({ my_current_steps: [] }), mySignStep({ my_current_steps: [mine(1, '資材單位')] })]).toEqual([null, null])
  })

  it('offers the 關卡 the database allows a 退回 from that 關卡 to target', () => {
    const a = { assessment_step: branched(Array<StepState>(8).fill('pending')) }
    expect(returnTargets(a, mine(7, null, [1, 2, 6])).map((s) => s.name)).toEqual([
      '自行檢查人員－資材單位', '自行檢查人員－品保單位', '廠區經理人',
    ])
  })
})

describe('advancedTo', () => {
  it('tells a 分流 moving on from the whole 自評表 moving, and a 分流 waiting at the 匯流', () => {
    const a = { assessment_step: branched(Array<StepState>(8).fill('pending')) }
    expect([advancedTo(a, 3), advancedTo(a, 6), advancedTo(a, null)]).toEqual(['branch', 'route', 'waiting'])
  })

  it('names the message for a 送出 or a 核准 the same way', () => {
    const a = { assessment_step: branched(Array<StepState>(8).fill('pending')) }
    expect([advanceMessageKey('submitted', a, 3), advanceMessageKey('approved', a, 6), advanceMessageKey('approved', a, null)]).toEqual([
      'submittedBranch', 'approved', 'approvedWaiting',
    ])
  })
})

describe('signerLabeler', () => {
  it('prefers the current employee_ref name, then the latest name a 簽核紀錄 kept, then the 工號', () => {
    const label = signerLabeler(source(3, 'in_progress', [['E', '丁'], ['C', '丙二']]), [
      signoff(2, 'approve', 'C', '丙'),
      signoff(1, 'submit', 'B', '乙舊'),
      signoff(1, 'submit', 'B', '乙'),
    ])
    expect(['B', 'C', 'E', 'F'].map(label)).toEqual(['乙（B）', '丙二（C）', '丁（E）', 'F'])
  })

  it('formats a known name as 姓名（工號）and an unknown one as the 工號', () => {
    expect([formatSigner('乙', 'B'), formatSigner(null, 'B')]).toEqual(['乙（B）', 'B'])
  })
})
