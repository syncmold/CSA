import i18next, { type TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import zhTWCommon from '../locales/zh-TW/common.json'
import zhTWFlows from '../locales/zh-TW/flows.json'
import type { LaunchCheck, BranchUnit, RouteLink, RouteStepRow, RouteSummary } from '../api/approvalRoutes'
import {
  launchProblems,
  branchInsertOptions,
  branchState,
  canDeleteBranchStep,
  linkedSignerText,
  mergeWaitsFor,
  reorderMerged,
  routeFor,
  routeLayout,
  routesOfPlant,
  routeWriteError,
  signerLabel,
  sortRoutes,
} from './routes'

const t = ((key: string, options?: Record<string, string>) =>
  options ? `${key}(${Object.values(options).join('|')})` : key) as unknown as TFunction

const ready: Omit<LaunchCheck, 'ready'> = {
  no_steps: false, no_merge_steps: false, missing_units: [], unused_units: [], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [],
}

describe('launchProblems', () => {
  it('is empty for a route that passes the check', () => {
    expect(launchProblems(t, ready)).toEqual([])
  })

  it('names the 自評單位 no step covers, in the order the database gives', () => {
    const check = { ...ready, missing_units: [{ id: '1', name: '品保單位' }, { id: '2', name: '財務單位' }] }
    expect(launchProblems(t, check)).toEqual(['flows:problems.missingUnits(品保單位、財務單位)'])
  })

  it('lists every problem at once', () => {
    const all = {
      no_steps: true,
      no_merge_steps: true,
      missing_units: [{ id: '1', name: '資材單位' }],
      unused_units: [{ id: '2', name: '人資單位' }],
      branch_first_step_not_editable: [{ id: '3', name: '財務單位' }],
      missing_links: ['taipei_auditor', 'audit_chief'] as RouteLink[],
      audit_chief_not_last: true,
      pending_unit_points: 3,
      unassigned_steps: [
        { id: '4', name: '自行檢查人員', branch_unit_id: '1', branch_unit_name: '資材單位' },
        { id: '5', name: '廠區經理人', branch_unit_id: null, branch_unit_name: null },
      ],
    }
    expect(launchProblems(t, all)).toEqual([
      'flows:problems.noSteps',
      'flows:problems.missingUnits(資材單位)',
      'flows:problems.branchFirstStep(財務單位)',
      'flows:problems.unusedUnits(人資單位)',
      'flows:problems.noMergeSteps',
      'flows:problems.auditChiefNotLast',
      'flows:problems.pendingUnits(3)',
      'flows:problems.missingLinks(flows:links.taipei_auditor.name、flows:links.audit_chief.name)',
      'flows:problems.unassignedSteps(資材單位・自行檢查人員、廠區經理人)',
    ])
  })
})

describe('routeWriteError', () => {
  it('says when the 範本 does not apply to the 廠區', () => {
    expect(routeWriteError(t, { code: '23514', hint: 'plant_not_applicable', details: null })).toBe('flows:errors.plantNotApplicable')
    // 同一單位的分流已經有人建好：不是「這個範本與廠區已有流程」
    expect(routeWriteError(t, { code: '23505', hint: 'branch_exists' })).toBe('flows:errors.branchExists')
    expect(routeWriteError(t, { code: '23505', hint: 'link_exists' })).toBe('flows:errors.linkExists')
    expect(routeWriteError(t, { code: '23514', hint: 'step_linked', details: null })).toBe('flows:errors.stepLinked')
  })

  it('maps the other refusals to the 流程編輯器 messages', () => {
    expect(routeWriteError(t, { code: '23514', message: 'route_step_name_present', details: 'Failing row contains …' })).toBe('flows:errors.stepRule')
    expect(routeWriteError(t, { code: '23505' })).toBe('flows:errors.duplicateRoute')
    expect(routeWriteError(t, { code: 'P0002', message: 'route 1 not found' })).toBe('common:templates.errors.stale')
    expect(routeWriteError(t, { code: '22023' })).toBe('common:templates.errors.stale')
  })

  it('shows words, not keys, through the 流程編輯器 own namespace', async () => {
    const i18n = i18next.createInstance()
    await i18n.init({ lng: 'zh-TW', resources: { 'zh-TW': { common: zhTWCommon, flows: zhTWFlows } }, defaultNS: 'common', interpolation: { escapeValue: false } })
    const flowsT = i18n.getFixedT(null, 'flows')
    expect(routeWriteError(flowsT, { code: '42501' })).toBe('只有稽核主管可以修改簽核流程')
    expect(routeWriteError(flowsT, { code: '22023' })).toBe('畫面上的資料已過期，請重新整理後再試')
    expect(routeWriteError(flowsT, new Error('Failed to fetch'))).toBe('儲存失敗：Failed to fetch')
  })
})

describe('linkedSignerText (#189)', () => {
  const flowsFor = async () => {
    const i18n = i18next.createInstance()
    await i18n.init({ lng: 'zh-TW', resources: { 'zh-TW': { common: zhTWCommon, flows: zhTWFlows } }, defaultNS: 'common', interpolation: { escapeValue: false } })
    return i18n.getFixedT(null, 'flows')
  }

  it('says whose 簽核人 a 連動關卡 follows, in the words of the editor', async () => {
    const flowsT = await flowsFor()
    expect(linkedSignerText(flowsT, 'taipei_auditor', true)).toBe('＝廠區管理員（自動）')
    expect(linkedSignerText(flowsT, 'audit_chief', true)).toBe('＝稽核主管（自動）')
    // 不連動時（#190）說明為什麼，簽核人在流程裡選
    expect(linkedSignerText(flowsT, 'taipei_auditor', false)).toBe('（不連動：廠區管理員不是稽核人員或稽核主管）')
    expect(linkedSignerText(flowsT, 'audit_chief', false)).toBe('（不連動：稽核主管不是剛好一位）')
  })

  it('names the missing 連動關卡 in the 發起檢查 problems', async () => {
    const flowsT = await flowsFor()
    expect(launchProblems(flowsT, { ...ready, missing_links: ['taipei_auditor'] })).toEqual(['稽核室覆核還缺連動關卡：台北稽核人員。新增關卡時選「連動」。'])
  })
})

describe('signerLabel', () => {
  it('shows 姓名（工號，廠區）', () => {
    expect(signerLabel({ emp_id: 'SSA77', name: '乙', factory_code: 'SY' })).toBe('乙（SSA77，SY）')
    expect(signerLabel({ emp_id: 'SSA77', name: '乙', factory_code: null })).toBe('乙（SSA77）')
    expect(signerLabel({ emp_id: 'SSA77', name: '乙', factory_code: '' })).toBe('乙（SSA77）')
  })
})

describe('sortRoutes', () => {
  const route = (id: string, code: string, plant: string) =>
    ({ id, updated_at: '2026-10-01', template: { id: code, code, name: code }, plant: { id: plant, factory_code: plant, name: plant } }) as RouteSummary

  it('groups by 範本 and then 廠區', () => {
    const sorted = sortRoutes([route('a', '02', 'SY'), route('b', '01.1', 'FQ'), route('c', '02', 'FQ')])
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('orders 範本 as the paper numbers them, 10.1 after 09 (Q111 codes)', () => {
    const sorted = sortRoutes([route('a', 'GT-10.1', 'GT'), route('b', 'GT-09', 'GT'), route('c', 'GT-01.1', 'GT')])
    expect(sorted.map((r) => r.template.code)).toEqual(['GT-01.1', 'GT-09', 'GT-10.1'])
  })
})

describe('routeFor', () => {
  const route = (id: string, template: string, plant: string) =>
    ({ id, updated_at: '2026-10-01', template: { id: template, code: template, name: template }, plant: { id: plant, factory_code: plant, name: plant } }) as RouteSummary
  const routes = [route('a', '02', 'FQ'), route('c', '02', 'SY')]

  it('opens the route of the 範本 × 廠區', () => {
    expect(routeFor(routes, '02', 'FQ')?.id).toBe('a')
    expect(routeFor(routes, '02', 'SY')?.id).toBe('c')
  })

  it('has none for a 範本 × 廠區 without a route', () => {
    expect(routeFor(routes, '02', 'GT')).toBeUndefined()
    expect(routeFor(routes, '03', 'FQ')).toBeUndefined()
  })
})

describe('routesOfPlant', () => {
  it('keeps the routes of one 廠區', () => {
    const routes = [{ id: 'a', plant: { factory_code: 'GT' } }, { id: 'b', plant: { factory_code: 'TC' } }] as RouteSummary[]
    expect(routesOfPlant(routes, 'GT').map((r) => r.id)).toEqual(['a'])
  })
})

const unitOf = (id: string, over: Partial<BranchUnit> = {}): BranchUnit => ({ id, name: `${id}單位`, in_template: true, ...over })
const step = (id: string, position: number, branch: string | null, editable = false): RouteStepRow => ({
  id, position, name: id, step_group: branch ? 'plant' : 'audit_review', signer_emp_id: 'E1',
  editable_unit_id: editable ? branch : null, branch_unit_id: branch, assessing_unit: null, link: null, linked_now: false,
})

describe('分流 layout (#98)', () => {
  // 業務、財務兩條分流（財務多一位課長），匯流後廠區經理人、稽核主管；位置交錯也照分流分開
  const steps = [
    step('稽核主管', 7, null), step('業務自檢', 1, '業務', true), step('財務自檢', 3, '財務', true), step('業務主管', 2, '業務'),
    step('課長', 4, '財務'), step('財務主管', 5, '財務'), step('廠區經理人', 6, null),
  ]
  const units = [unitOf('業務'), unitOf('財務'), unitOf('工務')]
  const { branches, merged } = routeLayout(units, steps)

  it('groups steps by 分流 in unit order, and keeps the 匯流後 steps apart', () => {
    expect(branches.map((b) => [b.unit.id, b.steps.map((s) => s.id)])).toEqual([
      ['業務', ['業務自檢', '業務主管']], ['財務', ['財務自檢', '課長', '財務主管']], ['工務', []],
    ])
    expect(merged.map((s) => s.id)).toEqual(['廠區經理人', '稽核主管'])
  })

  it('tells each card what to show, and which units the 匯流 waits for', () => {
    expect(branches.map(branchState)).toEqual(['set', 'set', 'missing'])
    expect(branchState({ unit: unitOf('舊', { in_template: false }), steps: [] })).toBe('unused')
    expect(mergeWaitsFor(branches)).toEqual(['業務單位', '財務單位', '工務單位'])
  })

  it('offers to add a step after any step of the 分流, never before the 自行檢查人員', () => {
    const finance = branches[1]!.steps
    // 部門主管一定是分流的最後一關，所以沒有「財務主管之後」
    expect(branchInsertOptions(finance, 7).map((o) => [o.after.id, o.before])).toEqual([['財務自檢', 4], ['課長', 5]])
    // 只有自行檢查人員的分流：排在它後面；它是整條流程的最後一關時排最後
    expect(branchInsertOptions([step('自檢', 1, 'x', true)], 1).map((o) => o.before)).toEqual([null])
  })

  it('keeps the 自行檢查人員 and the 部門主管 of a 分流: only an added step can be deleted', () => {
    const [self, chief, manager] = branches[1]!.steps as [RouteStepRow, RouteStepRow, RouteStepRow]
    expect([self, chief, manager].map((s) => canDeleteBranchStep(branches[1]!.steps, s))).toEqual([false, true, false])
    expect(canDeleteBranchStep(branches[0]!.steps, branches[0]!.steps[1]!)).toBe(false)
  })

  it('puts the dragged 匯流後 order after the 分流 steps', () => {
    expect(reorderMerged(steps, ['稽核主管', '廠區經理人'])).toEqual(['業務自檢', '業務主管', '財務自檢', '課長', '財務主管', '稽核主管', '廠區經理人'])
  })
})
