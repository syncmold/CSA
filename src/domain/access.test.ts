import type { LookedUpPerson } from '../api/people'
import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import type { AccessMember, ChangeLogRow, RemovalImpactRow } from '../api/accessModel'
import type { AuditRole } from '../api/employee'
import {
  accessWriteError, actsAsAuditAdmin, assignableRoles, canEditRoute, canEditTemplate, mayAddSettings, readsSettings, linksTaipeiAudit, changeText, defaultViewerPlants, exportablePlants, filterLog, filterMembers, groupImpact, identitiesOf,
  managesAccess, mayManage, mayRunPlant, parseEmpIds, personLabel, planAdd, plantChanges, plantRoster, reachOf, readsAll, seesTracking,
  takeovers,
} from './access'

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${Object.values(options).join('|')})` : key) as unknown as TFunction

const PLANTS = [
  { id: 'p-FQ', factory_code: 'FQ', name: '福清富群' },
  { id: 'p-SY', factory_code: 'SY', name: '松岡' },
]

function member(empId: string, over: Partial<AccessMember> = {}): AccessMember {
  return {
    emp_id: empId, name: `${empId}姓名`, factory_code: 'FQ', audit_role: 'signer', viewer_plant_ids: [], note: null,
    added_at: '2026-10-20T01:00:00Z', added_by_emp_id: null, added_by_name: null, last_login_at: null, coordinator_plant_ids: [],
    ...over,
  }
}

describe('personLabel', () => {
  it('is 姓名（工號）, or the 工號 alone before CSA knows the name', () => {
    expect(personLabel('FQ0123', '王小明')).toBe('王小明（FQ0123）')
    expect(personLabel('FQ0123', null)).toBe('FQ0123')
  })
})

describe('parseEmpIds', () => {
  it('splits pasted 工號 on commas, 頓號, spaces and new lines, upper-cased and once each, in order', () => {
    expect(parseEmpIds(' fq0123，SY0002、fq0123\nSS140 ,, ss140\r\n')).toEqual(['FQ0123', 'SY0002', 'SS140'])
    expect(parseEmpIds('  ')).toEqual([])
  })
})

describe('planAdd', () => {
  const person = (emp_id: string, name: string | null, factory_code: string | null, status: LookedUpPerson['status'] = 'active', csa = true, csaRequired = false): LookedUpPerson =>
    ({ asked: emp_id.toUpperCase(), emp_id, name, factory_code, status, csa, other_plant: false, csaRequired })

  it('adds those OMS has as 在職, says why the others are not added, and skips those already on the list (found or not)', () => {
    const people = [
      person('fq0123', '王小明', 'FQ'),
      person('SS140', '李大華', 'SY'),
      person('XX9999', null, null, 'not_found', false),
      person('FQ0500', null, null, 'departed', false),
      person('FQ0600', null, null, 'on_leave', false),
      person('FQ0700', null, null, 'transferred', false),
      person('FQ0800', '陳小美', 'FQ', 'active', false),
    ]
    expect(planAdd(['FQ0123', 'XX9999', 'SS140', 'SSA78', 'FQ0500', 'FQ0600', 'FQ0700', 'FQ0800', 'ZZ1'], people, [member('SS140'), member('SSA78')])).toEqual([
      // The person keeps OMS's spelling of the 工號; the list is keyed by the pasted one.
      { empId: 'FQ0123', status: 'add', person: { emp_id: 'fq0123', name: '王小明', factory_code: 'FQ' }, noCsa: false },
      { empId: 'XX9999', status: 'not_in_oms' },
      { empId: 'SS140', status: 'already_listed', person: { emp_id: 'SS140', name: '李大華', factory_code: 'SY' } },
      { empId: 'SSA78', status: 'already_listed' },
      { empId: 'FQ0500', status: 'departed' },
      { empId: 'FQ0600', status: 'on_leave' },
      { empId: 'FQ0700', status: 'transferred' },
      // OMS has not ticked CSA for them yet: added all the same, and pointed out (Q133 (4)).
      { empId: 'FQ0800', status: 'add', person: { emp_id: 'FQ0800', name: '陳小美', factory_code: 'FQ' }, noCsa: true },
      { empId: 'ZZ1', status: 'not_in_oms' }, // not answered at all
    ])
  })

  it('does not add someone OMS has not enabled for CSA once CSA_REQUIRE_OMS_AUTH is on (Q133 (4))', () => {
    expect(planAdd(['FQ0800'], [person('FQ0800', '陳小美', 'FQ', 'active', false, true)], [])).toEqual([{ empId: 'FQ0800', status: 'no_csa' }])
  })
})

describe('defaultViewerPlants', () => {
  it('is the batch\'s own OMS 廠區 that the plant master has', () => {
    const people = [{ emp_id: 'A', name: 'a', factory_code: 'SY' }, { emp_id: 'B', name: 'b', factory_code: 'ZZ' }, { emp_id: 'C', name: 'c', factory_code: 'SY' }]
    expect(defaultViewerPlants(people, PLANTS)).toEqual(['p-SY'])
  })
})

describe('identitiesOf', () => {
  it('is the 權限角色, plus 廠區負責人 for someone who runs a plant', () => {
    expect(identitiesOf(member('A'))).toEqual(['signer'])
    expect(identitiesOf(member('B', { audit_role: 'viewer', coordinator_plant_ids: ['p-SY'] }))).toEqual(['viewer', 'coordinator'])
  })
})

describe('filterMembers', () => {
  const members = [
    member('FQ0123', { name: '王小明', coordinator_plant_ids: ['p-FQ'] }),
    member('SS140', { name: '李大華', audit_role: 'viewer', viewer_plant_ids: ['p-SY'] }),
    member('SSA78', { audit_role: 'audit_admin' }),
  ]
  const all = { query: '', identity: null, plantId: null }

  it('searches 工號 or 姓名, ignoring case, and narrows by 身分', () => {
    expect(filterMembers(members, { ...all, query: 'ss' }).map((m) => m.emp_id)).toEqual(['SS140', 'SSA78'])
    expect(filterMembers(members, { ...all, query: '小明' }).map((m) => m.emp_id)).toEqual(['FQ0123'])
    expect(filterMembers(members, { ...all, identity: 'viewer' }).map((m) => m.emp_id)).toEqual(['SS140'])
    expect(filterMembers(members, { ...all, identity: 'coordinator' }).map((m) => m.emp_id)).toEqual(['FQ0123'])
  })

  it('narrows by 廠區 to whoever sees it: its 檢視者, its 廠區負責人 and every 稽核主管', () => {
    expect(filterMembers(members, { ...all, plantId: 'p-FQ' }).map((m) => m.emp_id)).toEqual(['FQ0123', 'SSA78'])
    expect(filterMembers(members, { ...all, plantId: 'p-SY' }).map((m) => m.emp_id)).toEqual(['SS140', 'SSA78'])
  })
})

describe('plantRoster', () => {
  it('gives each plant, in the master’s order, its 廠區負責人 (or none) and its 檢視者', () => {
    const owner = member('FQ0050', { coordinator_plant_ids: ['p-FQ'] })
    const viewer = member('FQ0001', { audit_role: 'viewer', viewer_plant_ids: ['p-FQ', 'p-SY'] })
    expect(plantRoster(PLANTS, [owner, viewer, member('X')]).map((r) => [r.plant.factory_code, r.coordinator?.emp_id ?? null, r.viewers.map((v) => v.emp_id)]))
      .toEqual([['FQ', 'FQ0050', ['FQ0001']], ['SY', null, ['FQ0001']]])
  })
})

describe('takeovers', () => {
  it('lists the chosen plants someone else runs now, whom they take over from', () => {
    const owner = member('FQ0050', { name: '何欣怡', coordinator_plant_ids: ['p-FQ'] })
    const me = member('SY0201', { coordinator_plant_ids: ['p-SY'] })
    expect(takeovers('SY0201', ['p-SY', 'p-FQ'], [owner, me])).toEqual([{ plantId: 'p-FQ', from: owner }])
    expect(takeovers('FQ0050', ['p-FQ'], [owner, me])).toEqual([])
  })
})

describe('seesTracking', () => {
  it('is for 稽核主管, 檢視者 and anyone who runs a plant (Q117 (3))', () => {
    expect(seesTracking('audit_admin', false)).toBe(true)
    expect(seesTracking('viewer', false)).toBe(true)
    expect(seesTracking('signer', true)).toBe(true)
    expect(seesTracking('signer', false)).toBe(false)
    expect(seesTracking(null, false)).toBe(false)
  })
})

describe('changeText', () => {
  const row = (over: Partial<ChangeLogRow>): ChangeLogRow => ({
    id: 1, changed_at: '2026-10-20T01:00:00Z', actor_emp_id: null, actor_name: null, target_emp_id: 'FQ0123', target_name: '王小明',
    action: 'role', before: null, after: null, ...over,
  })

  it('words each kind of change as 改前 → 改後', () => {
    expect(changeText(row({ action: 'role', before: 'signer', after: 'viewer' }), t, PLANTS))
      .toEqual({ action: 'access:log.action.role', before: 'access:role.signer', after: 'access:role.viewer' })
    expect(changeText(row({ action: 'viewer_plants', before: [], after: ['FQ', 'SY'] }), t, PLANTS))
      .toEqual({ action: 'access:log.action.viewer_plants', before: 'access:log.none', after: 'FQ 福清富群、SY 松岡' })
    expect(changeText(row({ action: 'note', before: null, after: '廠長' }), t, PLANTS))
      .toEqual({ action: 'access:log.action.note', before: 'access:log.none', after: '廠長' })
    expect(changeText(row({ action: 'added', after: { role: 'viewer', viewer_plants: ['XX'], note: null } }), t, PLANTS))
      .toEqual({ action: 'access:log.action.added', before: '', after: 'access:role.viewer；access:log.plants(XX)' })
    expect(changeText(row({ action: 'removed', before: { role: 'audit_admin', viewer_plants: [], note: '主管' } }), t, PLANTS))
      .toEqual({ action: 'access:log.action.removed', before: 'access:role.audit_admin；access:log.note(主管)', after: '' })
  })

  it('words 廠區負責人 changes by the plant, naming whom a successor replaced', () => {
    expect(changeText(row({ action: 'coordinator_assigned', after: { plant: 'FQ' } }), t, PLANTS))
      .toEqual({ action: 'access:log.action.coordinator_assigned', before: '', after: 'FQ 福清富群' })
    expect(changeText(row({ action: 'coordinator_removed', before: { plant: 'SY' } }), t, PLANTS))
      .toEqual({ action: 'access:log.action.coordinator_removed', before: 'SY 松岡', after: '' })
    const replaced = row({ action: 'coordinator_replaced', before: { plant: 'FQ', emp_id: 'FQ0050', name: '何欣怡' }, after: { plant: 'FQ' } })
    expect(changeText(replaced, t, PLANTS))
      .toEqual({ action: 'access:log.action.coordinator_replaced', before: '', after: 'access:log.replaced(FQ 福清富群|何欣怡（FQ0050）)' })
  })

  it('words 換稽核主管 on the new one, naming the one before and any others the database had', () => {
    const one = row({ action: 'audit_admin_replaced', before: { emp_id: 'FQ0050', name: '何欣怡' }, after: 'audit_admin' })
    expect(changeText(one, t, PLANTS))
      .toEqual({ action: 'access:log.action.audit_admin_replaced', before: '', after: 'access:log.adminReplaced(何欣怡（FQ0050）)' })
    const several = row({ action: 'audit_admin_replaced', before: { emp_id: 'FQ0050', name: '何欣怡', others: [{ emp_id: 'SY0001', name: null }] }, after: 'audit_admin' })
    expect(changeText(several, t, PLANTS).after).toBe('access:log.adminReplaced(何欣怡（FQ0050）、SY0001)')
  })

  it('words 分派, 換人 and 從缺 by the 自評表 and 關卡, naming whom a 換人 replaced', () => {
    const where = { year: 2026, plant: 'FQ', template: 'FQ-01.1', step: '部門主管－業務單位', branch: '業務單位' }
    const place = 'access:log.step(2026|FQ-01.1|FQ 福清富群|業務單位・部門主管)'
    expect(changeText(row({ action: 'step_assigned', after: where }), t, PLANTS))
      .toEqual({ action: 'access:log.action.step_assigned', before: '', after: place })
    expect(changeText(row({ action: 'step_vacated', after: where }), t, PLANTS))
      .toEqual({ action: 'access:log.action.step_vacated', before: '', after: place })
    expect(changeText(row({ action: 'step_carried', after: { year: 2026, plant: 'FQ', steps: 12 } }), t, PLANTS))
      .toEqual({ action: 'access:log.action.step_carried', before: '', after: 'access:log.carried(2026|FQ 福清富群|12)' })
    expect(changeText(row({ action: 'step_reassigned', before: { emp_id: 'FQ4007', name: '蔡宛儒' }, after: where }), t, PLANTS))
      .toEqual({ action: 'access:log.action.step_reassigned', before: '', after: `access:log.reassigned(${place}|蔡宛儒（FQ4007）)` })
  })

  it('says which route and 關卡 a 分派 before the launch was on, without a 年度 (Q147)', () => {
    const onRoute = { plant: 'FQ', template: 'FQ-01.1', step: '部門主管', branch: '財務部' }
    const routePlace = 'access:log.routeStep(FQ-01.1|FQ 福清富群|財務部・部門主管)'
    expect(changeText(row({ action: 'route_step_assigned', after: onRoute }), t, PLANTS))
      .toEqual({ action: 'access:log.action.route_step_assigned', before: '', after: routePlace })
    expect(changeText(row({ action: 'route_step_reassigned', before: { emp_id: 'FQ4007', name: '蔡宛儒' }, after: onRoute }), t, PLANTS))
      .toEqual({ action: 'access:log.action.route_step_reassigned', before: '', after: `access:log.reassigned(${routePlace}|蔡宛儒（FQ4007）)` })
  })
})

describe('filterLog', () => {
  const rows: ChangeLogRow[] = [
    { id: 3, changed_at: '', actor_emp_id: 'A001', actor_name: '劉雅婷', target_emp_id: 'FQ0050', target_name: '何欣怡', action: 'coordinator_assigned', before: null, after: { plant: 'FQ' } },
    { id: 2, changed_at: '', actor_emp_id: null, actor_name: null, target_emp_id: 'SS140', target_name: null, action: 'role', before: 'signer', after: 'viewer' },
  ]

  it('searches 對象 or 操作者 by 工號 or 姓名 and narrows by 動作', () => {
    expect(filterLog(rows, { query: '雅婷', action: null }).map((r) => r.id)).toEqual([3])
    expect(filterLog(rows, { query: 'ss1', action: null }).map((r) => r.id)).toEqual([2])
    expect(filterLog(rows, { query: '', action: 'role' }).map((r) => r.id)).toEqual([2])
  })

  it('finds a 更換 by the predecessor too, who has no row of their own', () => {
    const replaced: ChangeLogRow = {
      id: 4, changed_at: '', actor_emp_id: 'A001', actor_name: '劉雅婷', target_emp_id: 'FQ3019', target_name: '謝承恩',
      action: 'coordinator_replaced', before: { plant: 'FQ', emp_id: 'FQ0050', name: '何欣怡' }, after: { plant: 'FQ' },
    }
    expect(filterLog([...rows, replaced], { query: '何欣怡', action: null }).map((r) => r.id)).toEqual([3, 4])
    expect(filterLog([...rows, replaced], { query: 'fq0050', action: 'coordinator_replaced' }).map((r) => r.id)).toEqual([4])
  })

  it('finds a 換稽核主管 by the one before too, others included', () => {
    const replaced: ChangeLogRow = {
      id: 6, changed_at: '', actor_emp_id: 'M001', actor_name: '維護', target_emp_id: 'FQ3019', target_name: '謝承恩',
      action: 'audit_admin_replaced', before: { emp_id: 'FQ0050', name: '何欣怡', others: [{ emp_id: 'SY0001', name: '陳大文' }] }, after: 'audit_admin',
    }
    expect(filterLog([replaced], { query: '何欣怡', action: null }).map((r) => r.id)).toEqual([6])
    expect(filterLog([replaced], { query: 'sy0001', action: null }).map((r) => r.id)).toEqual([6])
    expect(filterLog([replaced], { query: '陳大文', action: 'audit_admin_replaced' }).map((r) => r.id)).toEqual([6])
  })

  it('finds a 換人 by the person replaced too', () => {
    const reassigned: ChangeLogRow = {
      id: 5, changed_at: '', actor_emp_id: 'FQ0050', actor_name: '何欣怡', target_emp_id: 'FQ3019', target_name: '謝承恩',
      action: 'step_reassigned', before: { emp_id: 'FQ4007', name: '蔡宛儒' }, after: { year: 2026, plant: 'FQ', template: 'FQ-01.1', step: '關卡', branch: null },
    }
    expect(filterLog([reassigned], { query: '蔡宛儒', action: null }).map((r) => r.id)).toEqual([5])
  })
})

describe('exportablePlants', () => {
  it('is every plant for a 稽核主管 and the 檢視廠區 for a 檢視者; running a plant adds none (Q117 (3))', () => {
    expect(exportablePlants('audit_admin', [], [])).toBe('all')
    expect(exportablePlants('viewer', ['p1'], [])).toEqual(['p1'])
    expect(exportablePlants('viewer', ['p1'], ['p2'])).toEqual(['p1'])
    expect(exportablePlants('signer', ['p1'], ['p2'])).toEqual([])
    expect(exportablePlants(undefined, [], [])).toEqual([])
  })

  it('is the plants a 稽核人員 runs as 廠區管理員, none while they run none (#187)', () => {
    expect(exportablePlants('audit_staff', [], ['p-FQ', 'p-SZ'])).toEqual(['p-FQ', 'p-SZ'])
    expect(exportablePlants('audit_staff', [], [])).toEqual([])
  })
})

describe('reachOf', () => {
  it('is everything for a 稽核主管; otherwise the plants viewed (檢視者 only) and the plants run', () => {
    expect(reachOf(member('A', { audit_role: 'audit_admin', coordinator_plant_ids: ['p-FQ'] }))).toEqual({ all: true })
    expect(reachOf(member('B', { audit_role: 'viewer', viewer_plant_ids: ['p-SY'], coordinator_plant_ids: ['p-FQ'] })))
      .toEqual({ all: false, view: ['p-SY'], run: ['p-FQ'] })
    expect(reachOf(member('C', { viewer_plant_ids: ['p-SY'] }))).toEqual({ all: false, view: [], run: [] })
    expect(reachOf(member('D', { audit_role: 'system_maintainer' }))).toEqual({ all: true })
  })
})

describe('who manages whom (Q122)', () => {
  it('opens 權限管理 to 稽核主管 and 系統維護員 only', () => {
    const roles: (AuditRole | null)[] = ['signer', 'viewer', 'audit_staff', 'audit_admin', 'system_maintainer', null]
    expect(roles.map(managesAccess)).toEqual([false, false, false, true, true, false])
  })

  it('gives a 系統維護員 every 稽核主管 page and button (Q129)', () => {
    const roles: (AuditRole | null)[] = ['signer', 'viewer', 'audit_staff', 'audit_admin', 'system_maintainer', null]
    expect(roles.map(actsAsAuditAdmin)).toEqual([false, false, false, true, true, false])
  })

  it('lets a 系統維護員 read everything and export every plant, as a 稽核主管', () => {
    expect(readsAll('system_maintainer')).toBe(true)
    expect(readsAll('viewer')).toBe(false)
    expect(seesTracking('system_maintainer', false)).toBe(true)
    expect(exportablePlants('system_maintainer', [], [])).toBe('all')
  })

  it('lets a 系統維護員 give every role, a 稽核主管 only 一般使用者, 檢視者 and 稽核人員 (#187)', () => {
    expect(assignableRoles('system_maintainer')).toEqual(['signer', 'viewer', 'audit_staff', 'audit_admin', 'system_maintainer'])
    expect(assignableRoles('audit_admin')).toEqual(['signer', 'viewer', 'audit_staff'])
    expect(assignableRoles('audit_staff')).toEqual(['signer', 'viewer', 'audit_staff'])
  })

  it('lets a 稽核主管 edit only 一般使用者, 檢視者 and 稽核人員, a 系統維護員 anyone, nobody else anyone', () => {
    const roles = ['signer', 'viewer', 'audit_staff', 'audit_admin', 'system_maintainer'] as const
    const editable = (me: AuditRole | undefined) => roles.filter((r) => mayManage(me, member('X', { audit_role: r })))
    expect(editable('audit_admin')).toEqual(['signer', 'viewer', 'audit_staff'])
    expect(editable('system_maintainer')).toEqual(roles)
    expect(editable('viewer')).toEqual([])
    expect(editable('audit_staff')).toEqual([])
    expect(editable(undefined)).toEqual([])
  })

  it('links the Taipei 稽核人員 step only for a 稽核人員 or the 稽核主管 who runs a plant (#187, Q140)', () => {
    expect((['signer', 'viewer', 'audit_staff', 'audit_admin', 'system_maintainer'] as const).map(linksTaipeiAudit)).toEqual([false, false, true, true, false])
  })

  it('keeps a 系統維護員 off the 廠區負責人 choices', () => {
    expect(mayRunPlant(member('X', { audit_role: 'system_maintainer' }))).toBe(false)
    expect(mayRunPlant(member('X', { audit_role: 'audit_admin' }))).toBe(true)
  })

  it('tells the refusals apart by their hint', () => {
    expect(accessWriteError(t, { code: '23514', hint: 'last_audit_admin' })).toBe('access:errors.lastAdmin')
    expect(accessWriteError(t, { code: '23514', hint: 'last_system_maintainer' })).toBe('access:errors.lastMaintainer')
    expect(accessWriteError(t, { code: '23514', hint: 'maintainer_not_coordinator' })).toBe('access:errors.maintainerNotCoordinator')
    expect(accessWriteError(t, { code: '42501', hint: 'maintainer_only' })).toBe('access:errors.maintainerOnly')
    expect(accessWriteError(t, { code: '22023', hint: 'single_audit_admin' })).toBe('access:errors.singleAdmin')
    expect(accessWriteError(t, { code: 'P0002' })).toBe('access:errors.notListed')
  })
})

describe('plantChanges', () => {
  it('is the plants added and taken off, nothing when only the order differs', () => {
    expect(plantChanges(['a', 'b'], ['b', 'a'])).toBeUndefined()
    expect(plantChanges(['a'], [])).toEqual({ assign: [], unassign: ['a'] })
    expect(plantChanges(['a', 'b'], ['b', 'c'])).toEqual({ assign: ['c'], unassign: ['a'] })
  })
})

describe('範本與流程的維護範圍 (Q144)', () => {
  const tpl = (codes: string[], all = false) => ({ all_plants: all, template_plant: codes.map((factory_code) => ({ factory_code })) })

  it('稽核主管與系統維護員改得動任何範本與流程', () => {
    for (const role of ['audit_admin', 'system_maintainer'] as const) {
      expect(canEditTemplate(role, [], tpl([], true))).toBe(true)
      expect(canEditRoute(role, [], 'p1')).toBe(true)
      expect(mayAddSettings(role, [])).toBe(true)
    }
  })

  it('稽核人員只改適用廠區都是他負責的範本，全部廠區、跨廠、沒有適用廠區的都不行', () => {
    expect(canEditTemplate('audit_staff', ['FQ', 'SZ'], tpl(['FQ']))).toBe(true)
    expect(canEditTemplate('audit_staff', ['FQ', 'SZ'], tpl(['FQ', 'SZ']))).toBe(true)
    expect(canEditTemplate('audit_staff', ['FQ'], tpl(['FQ', 'SZ']))).toBe(false)
    expect(canEditTemplate('audit_staff', ['FQ'], tpl(['SZ']))).toBe(false)
    expect(canEditTemplate('audit_staff', ['FQ'], tpl(['FQ'], true))).toBe(false)
    expect(canEditTemplate('audit_staff', ['FQ'], tpl([]))).toBe(false)
  })

  it('稽核人員只改負責廠區的流程，沒負責廠區就什麼都不能新增', () => {
    expect(canEditRoute('audit_staff', ['p1'], 'p1')).toBe(true)
    expect(canEditRoute('audit_staff', ['p1'], 'p2')).toBe(false)
    expect(mayAddSettings('audit_staff', ['p1'])).toBe(true)
    expect(mayAddSettings('audit_staff', [])).toBe(false)
  })

  it('其他角色都不能改', () => {
    for (const role of ['signer', 'viewer', null, undefined] as const) {
      expect(canEditTemplate(role, ['FQ'], tpl(['FQ']))).toBe(false)
      expect(canEditRoute(role, ['p1'], 'p1')).toBe(false)
      expect(mayAddSettings(role, ['p1'])).toBe(false)
    }
  })

  it('稽核人員看得到全部設定，一般使用者與檢視者看不到', () => {
    expect(readsSettings('audit_staff')).toBe(true)
    expect(readsSettings('audit_admin')).toBe(true)
    expect(readsSettings('viewer')).toBe(false)
    expect(readsSettings('signer')).toBe(false)
  })
})

describe('groupImpact', () => {
  it('splits the 關卡 into now, later and on active routes', () => {
    const r = (kind: RemovalImpactRow['kind'], step: number): RemovalImpactRow => ({
      kind, assessment_id: kind === 'route' ? null : `a${step}`, route_id: kind === 'route' ? `r${step}` : null, year: kind === 'route' ? null : 2027,
      template_code: '02', template_name: '採購', factory_code: 'FQ', plant_name: '福清', step_position: step, step_name: `第${step}關`,
    })
    const groups = groupImpact([r('current', 1), r('later', 3), r('later', 5), r('route', 1)])
    expect([groups.current.length, groups.later.length, groups.route.length]).toEqual([1, 2, 1])
    expect(groupImpact([]).empty).toBe(true)
    expect(groups.empty).toBe(false)
  })
})
