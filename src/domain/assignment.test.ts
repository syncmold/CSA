import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import type { AssignableStep, AssignmentForm, AssignmentStep } from '../api/assignment'
import {
  assignmentLayout,
  assignmentPath,
  assignmentWriteError,
  assignmentYears,
  missingSteps,
  parseAssignmentYear,
  pickAssignmentYear,
} from './assignment'

const step = (position: number, name: string, unit: string | null, signer: string | null, state: AssignmentStep['state'] = 'pending', group: AssignmentStep['step_group'] = 'plant', link: string | null = null): AssignmentStep => ({
  id: `s${position}`, position, name, step_group: group, link, signer_emp_id: signer, editable_unit_name: null, branch_unit_name: unit, state, vacated_emp_id: null, vacated_name: null,
})

/** A route's 關卡 (下次發出, Q147): no state, nobody signs a route. */
const routeStep = (position: number, name: string, unit: string | null, signer: string | null, group: AssignableStep['step_group'] = 'plant', link: string | null = null): AssignableStep => ({
  id: `r${position}`, position, name, step_group: group, link, signer_emp_id: signer, branch_unit_name: unit,
})

const form = (year: number, steps: AssignmentStep[] = []): AssignmentForm => ({
  id: `f${year}`, template_code: 'FQ-01.1', template_name: '銷售', template_layout: 'control_activity', status: 'in_progress', annual_cycle: { year, due_date: `${year}-12-31` }, assessment_step: steps,
})

const t = ((key: string) => key) as unknown as TFunction

describe('assignmentLayout', () => {
  it('groups the 分流 in route order, each with its status, and leaves the 連動 稽核室 steps out (Q143)', () => {
    const { branches, merged } = assignmentLayout([
      step(9, '稽核主管', null, 'A', 'pending', 'audit_review', 'audit_chief'),
      step(8, '台北稽核人員', null, 'A', 'pending', 'audit_review', 'taipei_auditor'),
      step(7, '子公司擔當稽核', null, null, 'pending', 'audit_review'),
      step(6, '廠區經理人', null, null),
      step(5, '部門主管－品保', '品保', null),
      step(4, '自行檢查人員－品保', '品保', 'E'),
      step(3, '部門主管－資材', '資材', 'D'),
      step(2, '自行檢查人員－資材', '資材', 'C', 'current'),
      step(0, '自行檢查人員－業務', '業務', 'A', 'done'),
      step(1, '部門主管－業務', '業務', 'B', 'done'),
    ])
    expect(branches.map((b) => [b.unit, b.status, b.steps.map((s) => s.position)])).toEqual([
      ['業務', 'approved', [0, 1]],
      ['資材', 'started', [2, 3]],
      ['品保', 'unassigned', [4, 5]],
    ])
    expect(merged.map((s) => s.name)).toEqual(['廠區經理人', '子公司擔當稽核'])
  })

  it('on a 簽核流程 a 分流 with everyone is 已分派, not 已開始 (Q147)', () => {
    const { branches, merged } = assignmentLayout([
      routeStep(1, '自行檢查人員－業務', '業務', 'A'),
      routeStep(2, '部門主管－業務', '業務', 'B'),
      routeStep(3, '自行檢查人員－品保', '品保', null),
      routeStep(4, '廠區經理人', null, null),
      routeStep(5, '稽核主管', null, 'C', 'audit_review', 'audit_chief'),
    ])
    expect(branches.map((b) => [b.unit, b.status])).toEqual([['業務', 'assigned'], ['品保', 'unassigned']])
    expect(merged.map((s) => s.name)).toEqual(['廠區經理人'])
  })
})

describe('missingSteps', () => {
  it('counts the 關卡 without a 簽核人', () => {
    expect(missingSteps([step(1, 'a', 'x', null), step(2, 'b', 'x', 'A'), step(3, 'c', null, null)])).toBe(2)
  })
})

describe('年度', () => {
  const forms = [form(2025), form(2026), form(2026)]
  it('lists each 年度 once, newest first', () => expect(assignmentYears(forms)).toEqual([2026, 2025]))
  it('keeps a 年度 that has forms, otherwise takes the newest', () => {
    expect(pickAssignmentYear(forms, 2025, false)).toBe(2025)
    expect(pickAssignmentYear(forms, 2020, false)).toBe(2026)
    expect(pickAssignmentYear(forms, null, false)).toBe(2026)
    expect(pickAssignmentYear([], null, false)).toBeNull()
  })
  it('starts on 下次發出 while the plant has routes, and keeps a 年度 chosen (Q147)', () => {
    expect(pickAssignmentYear(forms, null, true)).toBe('next')
    expect(pickAssignmentYear([], null, true)).toBe('next')
    expect(pickAssignmentYear(forms, 2025, true)).toBe(2025)
    expect(pickAssignmentYear(forms, 2020, true)).toBe('next')
    // 下次發出 chosen where there is no route: the newest 年度
    expect(pickAssignmentYear(forms, 'next', false)).toBe(2026)
  })
  it('reads the URL’s 年度', () => {
    expect(parseAssignmentYear('next')).toBe('next')
    expect(parseAssignmentYear('2026')).toBe(2026)
    expect(parseAssignmentYear(null)).toBeNull()
    expect(parseAssignmentYear('')).toBeNull()
    expect(parseAssignmentYear('soon')).toBeNull()
  })
  it('leads to a plant’s 年度 or 下次發出', () => {
    expect(assignmentPath('KH-HW', 'next')).toBe('/admin/assignment?plant=KH-HW&year=next')
    expect(assignmentPath('FQ', 2026)).toBe('/admin/assignment?plant=FQ&year=2026')
  })
})

describe('assignmentWriteError', () => {
  it('words the refusals a page can run into', () => {
    expect(assignmentWriteError(t, { code: '23514', hint: 'step_signed' })).toBe('errors.stepSigned')
    expect(assignmentWriteError(t, { code: '23514', hint: 'assessment_closed' })).toBe('errors.closed')
    expect(assignmentWriteError(t, { code: '23514', hint: 'linked_step' }, false)).toBe('errors.linkedStep')
    expect(assignmentWriteError(t, { code: '23514', hint: 'signer_required' }, false)).toBe('errors.signerRequired')
    // Once the forms are out only a 稽核主管 replaces anyone (Q147); before, the plant's 廠區管理員 too.
    expect(assignmentWriteError(t, { code: '42501' })).toBe('errors.deniedIssued')
    expect(assignmentWriteError(t, { code: '42501' }, false)).toBe('errors.denied')
  })
})
