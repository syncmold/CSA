import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import type { LaunchCandidate } from '../api/launch'
import {
  candidateKey,
  candidateProblem,
  departedFix,
  departedLabel,
  filterScope,
  isYearFull,
  launchRefusal,
  launchScope,
  launchSelection,
  launchStatus,
  byPlantOrder,
  plantOptions,
  toCombos,
  uncheckAfter,
} from './launch'

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${Object.values(options).join('|')})` : key) as unknown as TFunction

const ready = { ready: true, no_steps: false, no_merge_steps: false, missing_units: [], unused_units: [], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [] }

function candidate(template: string, plant: string, problem: LaunchCandidate['problem'] = null, launchedYears: number[] = []): LaunchCandidate {
  return {
    template_id: `t-${template}`, template_code: template, template_name: `${template} 範本`,
    plant_id: `p-${plant}`, factory_code: plant, plant_name: `${plant} 廠`,
    route_id: problem === 'no_route' ? null : `r-${template}-${plant}`,
    step_count: problem === 'no_route' ? 0 : 3,
    problem,
    launch_check: problem === 'no_route' ? null : problem === 'not_ready' ? { ...ready, ready: false, missing_units: [{ id: 'u', name: '品保單位' }] } : ready,
    launched_years: launchedYears,
  }
}

const codes = (cs: LaunchCandidate[]) => cs.map((c) => `${c.template_code}@${c.factory_code}`)

describe('isYearFull', () => {
  it('is full once every combination has been launched that year, not before', () => {
    const rows = [candidate('02', 'FQ', null, [2027]), candidate('02', 'GT', 'no_route')]
    expect(isYearFull(rows, 2027)).toBe(false)
    expect(isYearFull([rows[0]!], 2027)).toBe(true)
    expect(isYearFull([], 2027)).toBe(false)
  })
})

describe('launchSelection', () => {
  const rows = [
    candidate('02', 'FQ', null, [2027]),
    candidate('A', 'FQ', 'no_route'),
    candidate('01.1', 'FQ', 'not_ready'),
    candidate('02', 'GT'),
    candidate('A', 'GT', 'no_route'),
    candidate('02', 'TC'),
  ]
  const none = { plants: [], unchecked: new Set<string>(), year: 2027 }

  it('launches every combination that has not been unchecked or launched this year', () => {
    const unchecked = new Set([candidateKey(rows[1]!)])
    const s = launchSelection(rows, { ...none, unchecked })
    expect(codes(s.selectable)).toEqual(['A@FQ', '01.1@FQ', '02@GT', 'A@GT', '02@TC'])
    expect(toCombos(s.picked)).toEqual([
      { template_id: 't-01.1', plant_id: 'p-FQ' },
      { template_id: 't-02', plant_id: 'p-GT' },
      { template_id: 't-A', plant_id: 'p-GT' },
      { template_id: 't-02', plant_id: 'p-TC' },
    ])
  })

  it('counts a combination launched in another year as not launched', () => {
    expect(codes(launchSelection(rows, { ...none, year: 2028 }).selectable)).toContain('02@FQ')
  })

  it('shows, counts and launches only the chosen 廠區; the filtered-out ones are never sent', () => {
    const s = launchSelection(rows, { ...none, plants: ['p-GT'] })
    expect(codes(s.visible)).toEqual(['02@GT', 'A@GT'])
    expect(codes(s.picked)).toEqual(['02@GT', 'A@GT'])
    expect(codes(s.blocked)).toEqual(['A@GT']) // FQ's combinations without a route do not block a GT launch
  })

  it('shows the launched combinations of the chosen 廠區 without making them selectable', () => {
    const s = launchSelection(rows, { ...none, plants: ['p-FQ'] })
    expect(codes(s.visible)).toEqual(['02@FQ', 'A@FQ', '01.1@FQ'])
    expect(codes(s.selectable)).toEqual(['A@FQ', '01.1@FQ'])
  })

  it('is blocked by the checked combinations whose route cannot be launched, and only those', () => {
    expect(codes(launchSelection(rows, none).blocked)).toEqual(['A@FQ', '01.1@FQ', 'A@GT'])
    const unchecked = new Set([rows[1]!, rows[2]!, rows[4]!].map(candidateKey))
    expect(launchSelection(rows, { ...none, unchecked }).blocked).toEqual([])
  })

  it('keeps what the hidden rows had when 全選 is toggled for the filtered ones', () => {
    const hidden = new Set([candidateKey(rows[5]!)]) // 02@TC unchecked before filtering on GT
    const gt = launchSelection(rows, { ...none, plants: ['p-GT'], unchecked: hidden })
    const cleared = uncheckAfter(hidden, gt.selectable, [])
    expect([...cleared].sort()).toEqual([rows[3]!, rows[4]!, rows[5]!].map(candidateKey).sort())
    expect([...uncheckAfter(cleared, gt.selectable, gt.selectable.map(candidateKey))]).toEqual([candidateKey(rows[5]!)])
  })
})

describe('the 狀態 filter (#125)', () => {
  const rows = [
    candidate('02', 'FQ', null, [2027]),
    candidate('A', 'FQ', 'no_route'),
    candidate('01.1', 'FQ', 'not_ready'),
    candidate('02', 'GT'),
    candidate('A', 'GT', 'no_coordinator', [2027]),
    candidate('02', 'TC'),
  ]
  const none = { plants: [], unchecked: new Set<string>(), year: 2027 }

  it('puts a combination launched this year under 已發起 whatever its route, the rest under 可發起 or 流程有問題', () => {
    expect(rows.map((c) => launchStatus(c, 2027))).toEqual(['launched', 'problem', 'problem', 'ready', 'launched', 'ready'])
    expect(launchStatus(rows[0]!, 2028)).toBe('ready')
  })

  it('counts each 狀態 within the chosen 廠區', () => {
    expect(launchSelection(rows, none).counts).toEqual({ all: 6, ready: 2, problem: 2, launched: 2 })
    expect(launchSelection(rows, { ...none, plants: ['p-FQ'], status: 'ready' }).counts).toEqual({ all: 3, ready: 0, problem: 2, launched: 1 })
  })

  it('shows and launches only the 可發起 ones when 可發起 is chosen, so a missing route no longer blocks', () => {
    const s = launchSelection(rows, { ...none, status: 'ready' })
    expect(codes(s.visible)).toEqual(['02@GT', '02@TC'])
    expect(codes(s.picked)).toEqual(['02@GT', '02@TC'])
    expect(s.blocked).toEqual([])
  })

  it('narrows the 廠區 filter rather than replacing it', () => {
    expect(codes(launchSelection(rows, { ...none, plants: ['p-FQ'], status: 'problem' }).visible)).toEqual(['A@FQ', '01.1@FQ'])
    expect(codes(launchSelection(rows, { ...none, plants: ['p-GT'], status: 'launched' }).selectable)).toEqual([])
  })

  it('names the chosen 狀態 after the 廠區, and nothing for 全部', () => {
    expect(filterScope(t, rows, [])).toBe('launch:allPlants')
    expect(filterScope(t, rows, ['p-GT'], 'ready')).toBe('launch:scopeStatus(GT GT 廠|launch:status.ready)')
  })
})

describe('plantOptions and launchScope', () => {
  const rows = [candidate('02', 'GT'), candidate('02', 'FQ'), candidate('A', 'FQ'), candidate('02', 'TC')]

  it('lists each 廠區 once, by 廠區代碼 when no order is given', () => {
    expect(plantOptions(rows).map((p) => p.factory_code)).toEqual(['FQ', 'GT', 'TC'])
  })

  it('orders the table by the 廠區 menu, each 廠區 keeping its 範本 order', () => {
    expect(byPlantOrder(rows, ['p-TC', 'p-FQ']).map((r) => `${r.factory_code} ${r.template_code}`)).toEqual(['TC 02', 'FQ 02', 'FQ A', 'GT 02'])
  })

  it('follows the 廠區主檔 order like the other pages, 廠區 it does not list last by 廠區代碼', () => {
    expect(plantOptions(rows, ['p-TC', 'p-GT']).map((p) => p.factory_code)).toEqual(['TC', 'GT', 'FQ'])
    expect(launchScope(t, rows.slice(0, 3), ['p-GT', 'p-FQ'])).toBe('launch:scopeItem(GT GT 廠|1)launch:listSeparatorlaunch:scopeItem(FQ FQ 廠|2)')
  })

  it('says how many 自評表 each 廠區 gets', () => {
    expect(launchScope(t, rows.slice(0, 3))).toBe('launch:scopeItem(FQ FQ 廠|2)launch:listSeparatorlaunch:scopeItem(GT GT 廠|1)')
  })
})

describe('launchRefusal', () => {
  it('words each refusal of launch_annual_cycle', () => {
    expect(launchRefusal(t, 2027, { ok: false, error: 'already_launched', launched: [candidate('02', 'FQ', null, [2027])] })).toBe(
      'launch:refused.alreadyLaunched(2027|02 02 範本 × FQ FQ 廠)',
    )
    expect(launchRefusal(t, 2027, { ok: false, error: 'no_combos' })).toBe('launch:refused.noCombos')
    expect(launchRefusal(t, 2027, { ok: false, error: 'invalid_combo', invalid: [] })).toBe('launch:refused.stale')
    expect(
      launchRefusal(t, 2027, { ok: false, error: 'missing_route', missing: [candidate('A', 'FQ', 'no_route'), candidate('01.1', 'FQ', 'not_ready')] }),
    ).toBe('launch:refused.missingRoute(A A 範本 × FQ FQ 廠launch:listSeparator01.1 01.1 範本 × FQ FQ 廠)')
  })

  it('counts who on the routes has left; the page lists them, each with where to replace them (Q147 (4))', () => {
    const at = { template_id: 't', template_code: 'FQ-02', template_name: '銷售', plant_id: 'p', factory_code: 'KH-HW', plant_name: '高雄', step_id: 's' }
    const departed = [
      { ...at, step: '部門主管', branch_unit_name: '財務部', link: null, emp_id: 'FQ1021', name: '許文彬' },
      { ...at, step: '廠區經理人', branch_unit_name: null, link: null, emp_id: 'FQ9001', name: null },
      { ...at, step: '台北稽核人員', branch_unit_name: null, link: 'taipei_auditor', emp_id: 'SS1', name: '王' },
    ]
    expect(launchRefusal(t, 2027, { ok: false, error: 'departed_signers', departed })).toBe('launch:refused.departedSigners(3)')
    expect(departed.map((d) => departedLabel(t, d))).toEqual([
      'launch:departedItem(FQ-02|KH-HW 高雄|財務部・部門主管|許文彬（FQ1021）)',
      'launch:departedItem(FQ-02|KH-HW 高雄|廠區經理人|FQ9001)',
      'launch:departedLinkedItem(FQ-02|KH-HW 高雄|台北稽核人員|王（SS1）)',
    ])
    // 分派 on the plant's routes, on 下次發出; a 連動關卡 follows 權限管理.
    expect(departed.map(departedFix)).toEqual([
      { to: '/admin/assignment?plant=KH-HW&year=next', label: 'toAssignReplace' },
      { to: '/admin/assignment?plant=KH-HW&year=next', label: 'toAssignReplace' },
      { to: '/admin/access', label: 'toAccessReplace' },
    ])
  })
})

describe('candidateProblem', () => {
  const unassigned = [{ id: 's', name: '部門主管', branch_unit_id: 'u', branch_unit_name: '品保單位' }]
  it('reads a route whose only fault is 關卡 nobody is 分派 to as 還沒分派 (Q147)', () => {
    const c = { ...candidate('02', 'FQ', 'not_ready'), launch_check: { ...ready, ready: false, unassigned_steps: unassigned } }
    expect(candidateProblem(c)).toBe('unassigned')
  })
  it('keeps a route with other faults 流程未通過, and every other answer as the database gave it', () => {
    const c = candidate('02', 'FQ', 'not_ready')
    expect(candidateProblem({ ...c, launch_check: { ...c.launch_check!, unassigned_steps: unassigned } })).toBe('not_ready')
    expect(candidateProblem(c)).toBe('not_ready')
    expect(candidateProblem(candidate('02', 'FQ', 'no_route'))).toBe('no_route')
    expect(candidateProblem(candidate('02', 'FQ', 'no_coordinator'))).toBe('no_coordinator')
    expect(candidateProblem(candidate('02', 'FQ'))).toBeNull()
  })
})
