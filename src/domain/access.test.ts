import type { LookedUpPerson } from '../api/people'
import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import type { AccessMember, ChangeLogRow, RemovalImpactRow } from '../api/accessModel'
import type { AuditRole } from '../api/employee'
import {
  accessWriteError, actsAsAuditAdmin, admitsPeople, assignableRoles, AUDIT_ROLES, canEditRoute, canEditTemplate, mayAddSettings, readsSettings, linksTaipeiAudit, changeText, exportablePlants, filterLog, filterMembers, groupImpact, identitiesOf,
  IDENTITIES, managesAccess, mayEditPlantRights, mayEditViewerPlants, mayRunPlant, mayViewPlants, parseEmpIds, personLabel, planAdd, plantChanges, plantRightsSettings, plantRoster, reachOf,
  readsAll,
  seesTracking, takeovers, viewedPlants,
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
    ({ asked: emp_id.toUpperCase(), emp_id, name, factory_code, status, csa, other_plant: false, csaRequired, listed: false })

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

describe('the roles after Q153', () => {
  it('are four, with no 檢視者 among the roles to give or the 身分 to show', () => {
    expect(AUDIT_ROLES).toEqual(['signer', 'audit_staff', 'audit_admin', 'system_maintainer'])
    expect(IDENTITIES).toEqual(['signer', 'coordinator', 'audit_staff', 'audit_admin', 'system_maintainer'])
  })

  it('give 檢視廠區 to a 一般使用者 only, whatever a row still holds', () => {
    expect(AUDIT_ROLES.filter(mayViewPlants)).toEqual(['signer'])
    expect(viewedPlants(member('A', { viewer_plant_ids: ['p-SY'] }))).toEqual(['p-SY'])
    expect(viewedPlants(member('B', { audit_role: 'audit_staff', viewer_plant_ids: ['p-SY'] }))).toEqual([])
    expect(viewedPlants(member('C'))).toEqual([])
  })
})

describe('identitiesOf', () => {
  it('is the 權限角色, plus 廠區負責人 for someone who runs a plant', () => {
    expect(identitiesOf(member('A'))).toEqual(['signer'])
    // 檢視廠區 are a setting, not a 身分 (Q153): a 一般使用者 who views one plant and runs another is still these two.
    expect(identitiesOf(member('B', { viewer_plant_ids: ['p-FQ'], coordinator_plant_ids: ['p-SY'] }))).toEqual(['signer', 'coordinator'])
  })
})

describe('filterMembers', () => {
  const members = [
    member('FQ0123', { name: '王小明', coordinator_plant_ids: ['p-FQ'] }),
    member('SS140', { name: '李大華', viewer_plant_ids: ['p-SY'] }),
    member('SSA78', { audit_role: 'audit_admin' }),
  ]
  const all = { query: '', identity: null, plantId: null }

  it('searches 工號 or 姓名, ignoring case, and narrows by 身分', () => {
    expect(filterMembers(members, { ...all, query: 'ss' }).map((m) => m.emp_id)).toEqual(['SS140', 'SSA78'])
    expect(filterMembers(members, { ...all, query: '小明' }).map((m) => m.emp_id)).toEqual(['FQ0123'])
    expect(filterMembers(members, { ...all, identity: 'signer' }).map((m) => m.emp_id)).toEqual(['FQ0123', 'SS140'])
    expect(filterMembers(members, { ...all, identity: 'coordinator' }).map((m) => m.emp_id)).toEqual(['FQ0123'])
  })

  it('narrows by 廠區 to whoever sees it: whoever has it among their 檢視廠區, its 廠區管理員 and every 稽核主管', () => {
    expect(filterMembers(members, { ...all, plantId: 'p-FQ' }).map((m) => m.emp_id)).toEqual(['FQ0123', 'SSA78'])
    expect(filterMembers(members, { ...all, plantId: 'p-SY' }).map((m) => m.emp_id)).toEqual(['SS140', 'SSA78'])
  })
})

describe('plantRoster', () => {
  it('gives each plant, in the master’s order, its 廠區管理員 (or none) and the 一般使用者 who have it among their 檢視廠區', () => {
    const owner = member('FQ0050', { coordinator_plant_ids: ['p-FQ'] })
    const viewer = member('FQ0001', { viewer_plant_ids: ['p-FQ', 'p-SY'] })
    // Views one plant and runs the other (Q153).
    const both = member('SY0009', { viewer_plant_ids: ['p-FQ'], coordinator_plant_ids: ['p-SY'] })
    expect(plantRoster(PLANTS, [owner, viewer, both, member('X')]).map((r) => [r.plant.factory_code, r.coordinator?.emp_id ?? null, r.viewers.map((v) => v.emp_id)]))
      .toEqual([['FQ', 'FQ0050', ['FQ0001', 'SY0009']], ['SY', 'SY0009', ['FQ0001']]])
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
  it('is for 稽核主管, a 一般使用者 with 檢視廠區 (Q153) and anyone who runs a plant (Q117 (3))', () => {
    expect(seesTracking('audit_admin', false, false)).toBe(true)
    expect(seesTracking('signer', false, true)).toBe(true)
    expect(seesTracking('signer', true, false)).toBe(true)
    expect(seesTracking('signer', false, false)).toBe(false)
    expect(seesTracking('audit_staff', false, false)).toBe(false)
    expect(seesTracking('audit_staff', true, false)).toBe(true)
    expect(seesTracking(null, false, false)).toBe(false)
  })
})

describe('changeText', () => {
  const row = (over: Partial<ChangeLogRow>): ChangeLogRow => ({
    id: 1, changed_at: '2026-10-20T01:00:00Z', actor_emp_id: null, actor_name: null, target_emp_id: 'FQ0123', target_name: '王小明',
    action: 'role', before: null, after: null, ...over,
  })

  it('words each kind of change as 改前 → 改後', () => {
    expect(changeText(row({ action: 'role', before: 'signer', after: 'audit_staff' }), t, PLANTS))
      .toEqual({ action: 'access:log.action.role', before: 'access:role.signer', after: 'access:role.audit_staff' })
    expect(changeText(row({ action: 'viewer_plants', before: [], after: ['FQ', 'SY'] }), t, PLANTS))
      .toEqual({ action: 'access:log.action.viewer_plants', before: 'access:log.none', after: 'FQ 福清富群、SY 松岡' })
    expect(changeText(row({ action: 'note', before: null, after: '廠長' }), t, PLANTS))
      .toEqual({ action: 'access:log.action.note', before: 'access:log.none', after: '廠長' })
    expect(changeText(row({ action: 'added', after: { role: 'signer', viewer_plants: ['XX'], note: null } }), t, PLANTS))
      .toEqual({ action: 'access:log.action.added', before: '', after: 'access:role.signer；access:log.plants(XX)' })
    expect(changeText(row({ action: 'removed', before: { role: 'audit_admin', viewer_plants: [], note: '主管' } }), t, PLANTS))
      .toEqual({ action: 'access:log.action.removed', before: 'access:role.audit_admin；access:log.note(主管)', after: '' })
  })

  it('still words the entries that name the retired 檢視者 (Q153): old ones, and the one the conversion left on each', () => {
    // The conversion wrote these with no actor: 檢視者 → 一般使用者, the 檢視廠區 untouched.
    expect(changeText(row({ action: 'role', before: 'viewer', after: 'signer' }), t, PLANTS))
      .toEqual({ action: 'access:log.action.role', before: 'access:role.viewer', after: 'access:role.signer' })
    expect(changeText(row({ action: 'added', after: { role: 'viewer', viewer_plants: ['FQ'], note: null } }), t, PLANTS))
      .toEqual({ action: 'access:log.action.added', before: '', after: 'access:role.viewer；access:log.plants(FQ 福清富群)' })
    expect(changeText(row({ action: 'removed', before: { role: 'viewer', viewer_plants: [], note: '廠長' } }), t, PLANTS))
      .toEqual({ action: 'access:log.action.removed', before: 'access:role.viewer；access:log.note(廠長)', after: '' })
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

})

describe('exportablePlants', () => {
  it('is every plant for a 稽核主管 and their 檢視廠區 for a 一般使用者 (Q153); running a plant adds none (Q117 (3))', () => {
    expect(exportablePlants('audit_admin', [], [])).toBe('all')
    expect(exportablePlants('signer', ['p1'], [])).toEqual(['p1'])
    expect(exportablePlants('signer', ['p1'], ['p2'])).toEqual(['p1'])
    expect(exportablePlants('signer', [], ['p2'])).toEqual([])
    expect(exportablePlants(undefined, ['p1'], [])).toEqual([])
  })

  it('is the plants a 稽核人員 runs as 廠區管理員, none while they run none (#187)', () => {
    expect(exportablePlants('audit_staff', [], ['p-FQ', 'p-SZ'])).toEqual(['p-FQ', 'p-SZ'])
    expect(exportablePlants('audit_staff', [], [])).toEqual([])
  })
})

describe('reachOf', () => {
  it('is everything for a 稽核主管; otherwise the plants viewed (a 一般使用者 only, Q153) and the plants run', () => {
    expect(reachOf(member('A', { audit_role: 'audit_admin', coordinator_plant_ids: ['p-FQ'] }))).toEqual({ all: true })
    expect(reachOf(member('B', { viewer_plant_ids: ['p-SY'], coordinator_plant_ids: ['p-FQ'] })))
      .toEqual({ all: false, view: ['p-SY'], run: ['p-FQ'] })
    expect(reachOf(member('C'))).toEqual({ all: false, view: [], run: [] })
    expect(reachOf(member('E', { audit_role: 'audit_staff', coordinator_plant_ids: ['p-FQ'] }))).toEqual({ all: false, view: [], run: ['p-FQ'] })
    expect(reachOf(member('D', { audit_role: 'system_maintainer' }))).toEqual({ all: true })
  })
})

describe('who manages whom (Q122)', () => {
  it('opens 權限管理 to 稽核主管 and 系統維護員 only', () => {
    const roles: (AuditRole | null)[] = ['signer', 'audit_staff', 'audit_admin', 'system_maintainer', null]
    expect(roles.map(managesAccess)).toEqual([false, false, true, true, false])
  })

  it('gives a 系統維護員 every 稽核主管 page and button (Q129)', () => {
    const roles: (AuditRole | null)[] = ['signer', 'audit_staff', 'audit_admin', 'system_maintainer', null]
    expect(roles.map(actsAsAuditAdmin)).toEqual([false, false, true, true, false])
  })

  it('lets a 系統維護員 read everything and export every plant, as a 稽核主管', () => {
    expect(readsAll('system_maintainer')).toBe(true)
    expect(readsAll('signer')).toBe(false)
    expect(seesTracking('system_maintainer', false, false)).toBe(true)
    expect(exportablePlants('system_maintainer', [], [])).toBe('all')
  })

  it('lets only a 系統維護員 let people in and give roles (Q150)', () => {
    expect(assignableRoles('system_maintainer')).toEqual(['signer', 'audit_staff', 'audit_admin', 'system_maintainer'])
    expect(assignableRoles('audit_admin')).toEqual([])
    expect(assignableRoles('audit_staff')).toEqual([])
    expect(AUDIT_ROLES.map(admitsPeople)).toEqual([false, false, false, true])
    expect(admitsPeople(undefined)).toBe(false)
  })

  it('lets a 稽核主管 open 廠區權限 for anyone who may run a plant, a 一般使用者 with 檢視廠區 included (Q153), a 系統維護員 for anyone (Q150)', () => {
    const editable = (me: AuditRole | undefined) => AUDIT_ROLES.filter((r) => mayEditPlantRights(me, member('X', { audit_role: r })))
    expect(editable('audit_admin')).toEqual(['signer', 'audit_staff', 'audit_admin'])
    expect(mayEditPlantRights('audit_admin', member('V', { viewer_plant_ids: ['p-FQ'] }))).toBe(true)
    expect(editable('system_maintainer')).toEqual(AUDIT_ROLES)
    expect(editable('signer')).toEqual([])
    expect(editable('audit_staff')).toEqual([])
    expect(editable(undefined)).toEqual([])
  })

  it('lets only a 系統維護員 change 檢視廠區: there the 稽核主管 only names 廠區管理員 (Q150, Q153)', () => {
    expect(AUDIT_ROLES.filter(mayEditViewerPlants)).toEqual(['system_maintainer'])
    expect(mayEditViewerPlants(undefined)).toBe(false)
  })

  it('links the Taipei 稽核人員 step only for a 稽核人員 or the 稽核主管 who runs a plant (#187, Q140)', () => {
    expect(AUDIT_ROLES.map(linksTaipeiAudit)).toEqual([false, true, true, false])
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

describe('plantRightsSettings', () => {
  const signer = member('KS0031', { note: '窗口', viewer_plant_ids: ['p-FQ'], coordinator_plant_ids: ['p-SY'] })

  it('saves nothing when neither group changed', () => {
    expect(plantRightsSettings(signer, { view: ['p-FQ'], run: ['p-SY'] }, true)).toBeUndefined()
    expect(plantRightsSettings(signer, { view: ['p-FQ'], run: ['p-SY'] }, false)).toBeUndefined()
  })

  it('writes both groups of a 一般使用者 in one save for a 系統維護員', () => {
    expect(plantRightsSettings(signer, { view: ['p-FQ', 'p-SY'], run: [] }, true))
      .toEqual({ role: 'signer', note: '窗口', viewerPlantIds: ['p-FQ', 'p-SY'], coordinatorChanges: { assign: [], unassign: ['p-SY'] } })
    // Only the 檢視廠區: no 負責廠區 are sent, so they stay as they are. Emptying them is allowed (they are optional).
    expect(plantRightsSettings(signer, { view: [], run: ['p-SY'] }, true)).toEqual({ role: 'signer', note: '窗口', viewerPlantIds: [] })
  })

  it('sends the 檢視廠區 back untouched for a 稽核主管, who only names 廠區管理員 (the database refuses anything else)', () => {
    expect(plantRightsSettings(signer, { view: ['p-FQ'], run: ['p-SY', 'p-FQ'] }, false))
      .toEqual({ role: 'signer', note: '窗口', viewerPlantIds: ['p-FQ'], coordinatorChanges: { assign: ['p-FQ'], unassign: [] } })
    // Whatever the greyed boxes hold is not sent.
    expect(plantRightsSettings(signer, { view: [], run: [] }, false))
      .toEqual({ role: 'signer', note: '窗口', viewerPlantIds: ['p-FQ'], coordinatorChanges: { assign: [], unassign: ['p-SY'] } })
    expect(plantRightsSettings(signer, { view: [], run: ['p-SY'] }, false)).toBeUndefined()
  })

  it('never gives 檢視廠區 to another role: a 稽核人員 has only the plants they run', () => {
    const staff = member('SY0204', { audit_role: 'audit_staff', note: null, coordinator_plant_ids: [] })
    expect(plantRightsSettings(staff, { view: ['p-FQ'], run: ['p-SY'] }, true))
      .toEqual({ role: 'audit_staff', note: '', viewerPlantIds: [], coordinatorChanges: { assign: ['p-SY'], unassign: [] } })
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
    for (const role of ['signer', null, undefined] as const) {
      expect(canEditTemplate(role, ['FQ'], tpl(['FQ']))).toBe(false)
      expect(canEditRoute(role, ['p1'], 'p1')).toBe(false)
      expect(mayAddSettings(role, ['p1'])).toBe(false)
    }
  })

  it('稽核人員看得到全部設定，一般使用者看不到', () => {
    expect(readsSettings('audit_staff')).toBe(true)
    expect(readsSettings('audit_admin')).toBe(true)
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
