// 權限管理 (#58, Q98, Q117): what the page works out before and after talking to the database. The rules themselves
// (who may change what, at least one 稽核主管, the 異動紀錄) are in the database (ADR-0001).
import type { TFunction } from 'i18next'
import type { PickerRow } from '../../exchange/core'
import type { LookedUpPerson } from '../api/people'
import { bringIn } from './people'
import type { AccessMember, AccessSnapshot, AuditAdminChange, ChangeAction, ChangeLogRow, CoordinatorChange, RemovalImpactRow } from '../api/accessModel'
import type { AuditRole } from '../api/employee'
import type { Plant } from '../api/plants'
import { writeErrorMessage } from './templates'

/** The roles kept in employee_ref.audit_role, in the order the dialogs offer them (Q98 (2), Q122 (1), #187). */
export const AUDIT_ROLES: readonly AuditRole[] = ['signer', 'viewer', 'audit_staff', 'audit_admin', 'system_maintainer']

/**
 * Only a 系統維護員 makes someone one of these, or changes or removes someone who is (Q122 (3)). A 稽核人員 is not one:
 * the 稽核主管 sets those too (#187).
 */
const MAINTAINER_ONLY: readonly AuditRole[] = ['audit_admin', 'system_maintainer']

/**
 * The 權限管理 page is for 稽核主管 and 系統維護員 (Q122 (2)(3)). For showing and hiding only; the database decides
 * (can_manage_access).
 */
export const managesAccess = (role: AuditRole | null | undefined): boolean => role === 'audit_admin' || role === 'system_maintainer'

/**
 * Who sees everything: every plant's 自評表 and answers, 追蹤總覽, 範本 and 簽核流程: the 稽核主管 and the 系統維護員
 * (Q122 (2)). The database decides (can_read_all).
 */
export const readsAll = (role: AuditRole | null | undefined): boolean => role === 'audit_admin' || role === 'system_maintainer'

/**
 * Who does what a 稽核主管 does: change 範本 and 簽核流程, launch a year, assign 填寫人 and swap signers. A 系統維護員
 * too, since Q129 (2026-11-16, revising Q122 (2)): they test each update by doing it themselves. For showing and hiding
 * only; the database decides (is_audit_admin).
 */
export const actsAsAuditAdmin = (role: AuditRole | null | undefined): boolean =>
  role === 'audit_admin' || role === 'system_maintainer'
// managesAccess, readsAll and actsAsAuditAdmin now name the same two roles. They stay apart on purpose, one per database
// seam (can_manage_access, can_read_all, is_audit_admin): a role that reads all but changes nothing (OPEN-6) would only
// change readsAll.

/**
 * Who sees every plant's 範本, 自評單位 and 簽核流程: the two above, and the 稽核人員 (Q144), who may change only what is
 * his plants'. For showing and hiding only; the database decides (can_read_settings).
 */
export const readsSettings = (role: AuditRole | null | undefined): boolean => readsAll(role) || role === 'audit_staff'

/** A 範本 as far as who may change it goes. */
export interface TemplateScope {
  all_plants: boolean
  template_plant: { factory_code: string }[]
}

/**
 * Whether `role` may change this 範本 (Q144): a 稽核主管 or 系統維護員 any; a 稽核人員 one that applies to some plants,
 * not all, every one of which he runs as 廠區管理員 (`runCodes`, their 廠區代碼). For showing and hiding only; the
 * database decides (my_editable_template_ids).
 */
export function canEditTemplate(role: AuditRole | null | undefined, runCodes: readonly string[], tpl: TemplateScope): boolean {
  if (actsAsAuditAdmin(role)) return true
  return (
    role === 'audit_staff' &&
    !tpl.all_plants &&
    tpl.template_plant.length > 0 &&
    tpl.template_plant.every((p) => runCodes.includes(p.factory_code))
  )
}

/** Whether `role` may change the 簽核流程 of this plant: a 稽核人員 only where he is 廠區管理員 (Q144). */
export function canEditRoute(role: AuditRole | null | undefined, runPlantIds: readonly string[], plantId: string): boolean {
  return actsAsAuditAdmin(role) || (role === 'audit_staff' && runPlantIds.includes(plantId))
}

/** Whether `role` may add a 範本, a 簽核流程 or a 自評單位: a 稽核人員 only once he runs a plant (Q144). */
export const mayAddSettings = (role: AuditRole | null | undefined, runPlantIds: readonly string[]): boolean =>
  actsAsAuditAdmin(role) || (role === 'audit_staff' && runPlantIds.length > 0)

/** The roles `myRole` may give someone: every role for a 系統維護員, 一般使用者, 檢視者 and 稽核人員 for a 稽核主管 (Q122 (3), #187). */
export function assignableRoles(myRole: AuditRole | null | undefined): AuditRole[] {
  return AUDIT_ROLES.filter((r) => myRole === 'system_maintainer' || !MAINTAINER_ONLY.includes(r))
}

/** Whether `myRole` may edit or remove `m`: a 稽核主管 leaves 稽核主管 and 系統維護員 to a 系統維護員 (Q122 (3)). */
export function mayManage(myRole: AuditRole | null | undefined, m: Pick<AccessMember, 'audit_role'>): boolean {
  return myRole === 'system_maintainer' || (myRole === 'audit_admin' && !MAINTAINER_ONLY.includes(m.audit_role))
}

/**
 * Whether the plant someone runs has its Taipei 稽核人員 step follow them (#187): a 稽核人員 or the 稽核主管 does (Q140);
 * anyone else running a plant leaves that step to be set route by route, which the dialogs say. Same rule as the
 * database's linked_signer.
 */
export const linksTaipeiAudit = (role: AuditRole | null | undefined): boolean => role === 'audit_staff' || role === 'audit_admin'

/** A 系統維護員 runs no plant: they already assign and swap signers at every plant (Q129). */
export const mayRunPlant = (m: Pick<AccessMember, 'audit_role'>): boolean => m.audit_role !== 'system_maintainer'

/**
 * The 權限角色 (Q117 (2), Q122), shown as someone's 身分: their audit_role, plus 廠區負責人, which is set per plant
 * rather than kept in audit_role, so one person may hold both (Q117 (4)).
 */
export type Identity = AuditRole | 'coordinator'

/**
 * In the order of the 權限說明 tab: from the narrowest reach to the widest, then the 系統維護員, who does everything (Q129).
 * 稽核人員 sits after 廠區管理員: with no plant he is a 一般使用者, with one he is a 廠區管理員 who also exports (#187).
 */
export const IDENTITIES: readonly Identity[] = ['signer', 'viewer', 'coordinator', 'audit_staff', 'audit_admin', 'system_maintainer']

/**
 * Database refusals on this page in its words (the rules are in the database, ADR-0001). Two kinds of 23514 and the
 * 42501 for a 稽核主管 touching a 稽核主管 or 系統維護員 are told apart by their hint.
 */
export function accessWriteError(t: TFunction, error: unknown): string {
  const hint = typeof error === 'object' && error && 'hint' in error ? String(error.hint) : ''
  if (hint === 'last_system_maintainer') return t('access:errors.lastMaintainer')
  if (hint === 'maintainer_only') return t('access:errors.maintainerOnly')
  if (hint === 'maintainer_not_coordinator') return t('access:errors.maintainerNotCoordinator')
  if (hint === 'single_audit_admin') return t('access:errors.singleAdmin')
  return writeErrorMessage(t, error, { '23514': 'access:errors.lastAdmin', P0002: 'access:errors.notListed', '23503': 'access:errors.plant' })
}

/** Every action of the 權限異動紀錄, in the order its filter offers them: 人員異動 only, no 分派 (Q149). */
export const CHANGE_ACTIONS: readonly ChangeAction[] = [
  'added', 'removed', 'role', 'audit_admin_replaced', 'viewer_plants', 'note', 'coordinator_assigned', 'coordinator_replaced', 'coordinator_removed',
]

/**
 * 追蹤總覽, and with it 首頁's 各廠填單進度 (Q115 (4)), is for 稽核主管, 系統維護員 and 檢視者, and also for whoever runs a plant,
 * whatever their role (Q117 (3)); the view gives anyone else no rows anyway.
 */
export function seesTracking(role: AuditRole | null | undefined, runsAPlant: boolean): boolean {
  return runsAPlant || readsAll(role) || role === 'viewer'
}

/**
 * The plants 追蹤總覽's 匯出 Excel may hold: every plant for a 稽核主管 or 系統維護員, the 檢視廠區 for a 檢視者, the plants
 * a 稽核人員 runs as 廠區管理員 (#187), none otherwise. audit_role holds one value, so no one is both a 檢視者 and a
 * 稽核人員, and the union #191 asks for is just one of the two. Running a plant adds none for anyone else, a 檢視者 who
 * runs one included: those plants stay on screen but out of the Excel (Q117 (3), the user 2026-11-02 and 2026-11-03).
 * The Excel is built in the browser from rows already shown, so this is not a database rule.
 */
export function exportablePlants(role: AuditRole | null | undefined, viewerPlantIds: string[], runPlantIds: string[]): 'all' | string[] {
  if (readsAll(role)) return 'all'
  if (role === 'viewer') return viewerPlantIds
  return role === 'audit_staff' ? runPlantIds : []
}

export function identitiesOf(m: Pick<AccessMember, 'audit_role' | 'coordinator_plant_ids'>): Identity[] {
  return m.coordinator_plant_ids.length ? [m.audit_role, 'coordinator'] : [m.audit_role]
}

/** 「王小明（FQ0123）」, or just the 工號 while CSA does not know the name yet. */
export function personLabel(empId: string, name: string | null | undefined): string {
  return name ? `${name}（${empId}）` : empId
}

/** 工號 pasted in one go: commas, 頓號, spaces or new lines between them; upper-cased, each once, in order. */
export function parseEmpIds(text: string): string[] {
  const ids = text.split(/[\s,，、;；]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
  return [...new Set(ids)]
}

export type AddPlan =
  /** `noCsa`: OMS has not let them use CSA yet (授權頁沒勾 CSA, or no active account); added all the same (Q133 (4)). */
  | { empId: string; status: 'add'; person: PickerRow; noCsa: boolean }
  | { empId: string; status: 'already_listed'; person?: PickerRow }
  /** `no_csa`: CSA_REQUIRE_OMS_AUTH is on and OMS has not let them use CSA. */
  | { empId: string; status: 'not_in_oms' | 'departed' | 'on_leave' | 'transferred' | 'no_csa' }

/**
 * Each pasted 工號 against what OMS says (asked by the CSA backend, #218) and the current list: only people OMS has as
 * 在職 are added (Q98 (3)); the CSA database cannot reach OMS, so this check happens here. Someone already on the list is
 * skipped either way.
 */
export function planAdd(empIds: string[], people: LookedUpPerson[], members: Pick<AccessMember, 'emp_id'>[]): AddPlan[] {
  const found = new Map(people.map((p) => [p.asked, p]))
  const listed = new Set(members.map((m) => m.emp_id))
  return empIds.map((empId) => {
    const oms = found.get(empId)
    // The 工號 as OMS writes it (what CSA stores); `empId` is the pasted one, which the list is keyed by.
    const verdict = bringIn(oms)
    const person = oms?.status === 'active' ? { emp_id: oms.emp_id, name: oms.name ?? '', factory_code: oms.factory_code ?? '' } : undefined
    if (listed.has(empId)) return person ? { empId, status: 'already_listed', person } : { empId, status: 'already_listed' }
    if (verdict.ok) return { empId, status: 'add', person: person!, noCsa: verdict.reminders.includes('no_csa') }
    return { empId, status: verdict.reason === 'not_found' ? 'not_in_oms' : verdict.reason }
  })
}

/** 檢視廠區 to start from: the people's own OMS 廠區, where the plant master has it. */
export function defaultViewerPlants(people: Pick<PickerRow, 'factory_code'>[], plants: Plant[]): string[] {
  const codes = new Set(people.map((p) => p.factory_code))
  return plants.filter((p) => codes.has(p.factory_code)).map((p) => p.id)
}

export interface MemberFilter {
  query: string
  identity: Identity | null
  /** Only those who see this plant's 自評表: its 檢視者, its 廠區負責人 and every 稽核主管. */
  plantId: string | null
}

/** Which 自評表 someone sees beyond their own 關卡: every plant, or the plants they view and the plants they run. */
export type Reach = { all: true } | { all: false; view: string[]; run: string[] }

export function reachOf(m: Pick<AccessMember, 'audit_role' | 'viewer_plant_ids' | 'coordinator_plant_ids'>): Reach {
  if (readsAll(m.audit_role)) return { all: true }
  return { all: false, view: m.audit_role === 'viewer' ? m.viewer_plant_ids : [], run: m.coordinator_plant_ids }
}

const seesPlant = (m: AccessMember, plantId: string) => {
  const reach = reachOf(m)
  return reach.all || reach.view.includes(plantId) || reach.run.includes(plantId)
}

export function filterMembers(members: AccessMember[], { query, identity, plantId }: MemberFilter): AccessMember[] {
  const q = query.trim().toLowerCase()
  return members.filter(
    (m) =>
      (!identity || identitiesOf(m).includes(identity)) &&
      (!plantId || seesPlant(m, plantId)) &&
      (!q || m.emp_id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q)),
  )
}

export interface PlantRoster {
  plant: Plant
  coordinator: AccessMember | null
  viewers: AccessMember[]
}

/** Each plant of the master, in its order, with who runs it and who views it (the 人員 tab's 各廠區負責人). */
export function plantRoster(plants: Plant[], members: AccessMember[]): PlantRoster[] {
  return plants.map((plant) => ({
    plant,
    coordinator: members.find((m) => m.coordinator_plant_ids.includes(plant.id)) ?? null,
    viewers: members.filter((m) => m.audit_role === 'viewer' && m.viewer_plant_ids.includes(plant.id)),
  }))
}

/** The chosen plants that someone other than `empId` runs now: saving hands them over, so the dialog says so. */
export function takeovers(empId: string, plantIds: string[], members: AccessMember[]): { plantId: string; from: AccessMember }[] {
  return plantIds.flatMap((plantId) => {
    const from = members.find((m) => m.emp_id !== empId && m.coordinator_plant_ids.includes(plantId))
    return from ? [{ plantId, from }] : []
  })
}

/** 「FQ 福清富群」 */
export const plantText = (p: Pick<Plant, 'factory_code' | 'name'>) => `${p.factory_code} ${p.name}`

/** 「FQ 福清富群」 by 廠區代碼, or just the code when the plant master no longer has it. */
export function plantLabel(code: string, plants: Plant[]): string {
  const plant = plants.find((p) => p.factory_code === code)
  return plant ? plantText(plant) : code
}

export const plantById = (id: string, plants: Plant[]): Plant | undefined => plants.find((p) => p.id === id)

/** 「FQ 福清富群」 by plant.id, or the id when the plant master no longer has it. */
export function plantLabelById(id: string, plants: Plant[]): string {
  const plant = plantById(id, plants)
  return plant ? plantText(plant) : id
}

const plantList = (codes: string[], plants: Plant[]) => codes.map((c) => plantLabel(c, plants)).join('、')

function snapshotText(s: AccessSnapshot, t: TFunction, plants: Plant[]): string {
  return [
    t(`access:role.${s.role}`),
    s.viewer_plants.length ? t('access:log.plants', { plants: plantList(s.viewer_plants, plants) }) : null,
    s.note ? t('access:log.note', { note: s.note }) : null,
  ].filter(Boolean).join('；')
}

/**
 * On a 更換 and a 換稽核主管 the row is the successor's, and the predecessor is in `before` (the 稽核主管 before the
 * 換稽核主管 may be several, where the database had more than one).
 */
const predecessorOf = (r: ChangeLogRow) =>
  r.action === 'coordinator_replaced' || r.action === 'audit_admin_replaced'
    ? (r.before as AuditAdminChange)
    : null

/** One 異動紀錄 row in words: 動作, 改前, 改後. 廠區負責人 changes name the plant (and, on 更換, the predecessor). */
export function changeText(row: ChangeLogRow, t: TFunction, plants: Plant[]): { action: string; before: string; after: string } {
  const action = t(`access:log.action.${row.action}`)
  if (row.action === 'audit_admin_replaced') {
    const before = row.before as AuditAdminChange
    const previous = [before, ...(before.others ?? [])].map((p) => personLabel(p.emp_id ?? '', p.name)).join('、')
    return { action, before: '', after: t('access:log.adminReplaced', { previous }) }
  }
  if (row.action === 'coordinator_replaced') {
    const before = row.before as CoordinatorChange
    const plant = plantLabel((row.after as CoordinatorChange).plant, plants)
    return { action, before: '', after: t('access:log.replaced', { plant, previous: personLabel(before.emp_id ?? '', before.name) }) }
  }
  const none = t('access:log.none')
  const value = (v: unknown): string => {
    switch (row.action) {
      case 'role':
        return t(`access:role.${v as AuditRole}`)
      case 'viewer_plants':
        return (v as string[]).length ? plantList(v as string[], plants) : none
      case 'note':
        return (v as string | null) || none
      case 'coordinator_assigned':
      case 'coordinator_removed':
        return v ? plantLabel((v as CoordinatorChange).plant, plants) : ''
      default:
        return v ? snapshotText(v as AccessSnapshot, t, plants) : ''
    }
  }
  return { action, before: value(row.before), after: value(row.after) }
}

export interface LogFilter {
  query: string
  action: ChangeAction | null
}

/**
 * The 異動紀錄 tab's search (對象 or 操作者, by 工號 or 姓名; on a 更換 also the predecessor, who has no row of their
 * own) and 動作 filter.
 */
export function filterLog(rows: ChangeLogRow[], { query, action }: LogFilter): ChangeLogRow[] {
  const q = query.trim().toLowerCase()
  const has = (v: string | null | undefined) => (v ?? '').toLowerCase().includes(q)
  return rows.filter(
    (r) =>
      (!action || r.action === action) &&
      (!q || has(r.target_emp_id) || has(r.target_name) || has(r.actor_emp_id) || has(r.actor_name) ||
        has(predecessorOf(r)?.emp_id) || has(predecessorOf(r)?.name) ||
        (predecessorOf(r)?.others ?? []).some((o) => has(o.emp_id) || has(o.name))),
  )
}

/** What the edit dialog changed in someone's 負責廠區: the plants added and the plants taken off. */
export interface PlantChanges {
  assign: string[]
  unassign: string[]
}

/**
 * The edit dialog sends only these, never the whole list, so a plant another 稽核主管 handed to or took from this
 * person meanwhile stays as they left it; nothing when nothing changed.
 */
export function plantChanges(before: string[], after: string[]): PlantChanges | undefined {
  const assign = after.filter((id) => !before.includes(id))
  const unassign = before.filter((id) => !after.includes(id))
  return assign.length || unassign.length ? { assign, unassign } : undefined
}

/** The removal warning's three lists (Q98 (5)). */
export function groupImpact(rows: RemovalImpactRow[]) {
  return {
    current: rows.filter((r) => r.kind === 'current'),
    later: rows.filter((r) => r.kind === 'later'),
    route: rows.filter((r) => r.kind === 'route'),
    empty: rows.length === 0,
  }
}
