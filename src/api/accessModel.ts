// 權限管理 (#58, Q98): the shapes the page reads. Kept apart from the API module (which creates the browser
// client on import) so the domain helpers and their tests use them without a client.
import type { AuditRole, LoggedRole } from './employee'

/** One row of view `access_member`: a person on the 放行名單 with their 稽核角色. */
export interface AccessMember {
  emp_id: string
  /** Shown name; the OMS value from when they were added until their first login refreshes it. Null if never known. */
  name: string | null
  factory_code: string | null
  audit_role: AuditRole
  /** plant.id of their 檢視廠區: optional, and only a 一般使用者 has any (Q153) */
  viewer_plant_ids: string[]
  note: string | null
  added_at: string
  /** Null when the 部署指令 or db:set-role added them. */
  added_by_emp_id: string | null
  added_by_name: string | null
  /** Last successful exchange, renewals included (shown as 最後使用); null = 尚未登入過 */
  last_login_at: string | null
  /** plant.id of the plants they run as 廠區負責人 (Q116 (5)); any 權限角色 may run plants. */
  coordinator_plant_ids: string[]
}

/** What 加入, 編輯 and 廠區權限 send to the database's maintenance functions. */
export interface AccessSettings {
  role: AuditRole
  /** 檢視廠區: a 一般使用者's only (Q153); the database clears them for any other role. */
  viewerPlantIds: string[]
  note: string
  /** The 負責廠區 added and taken off (廠區權限 only); the others stay as they are, and all of them when absent. */
  coordinatorChanges?: { assign: string[]; unassign: string[] }
}

export type ChangeAction =
  | 'added' | 'removed' | 'role' | 'viewer_plants' | 'note'
  | 'coordinator_assigned' | 'coordinator_replaced' | 'coordinator_removed'
  | 'audit_admin_replaced'

/** A 廠區負責人 change, by 廠區代碼. 更換 is one row on the successor, whose `before` also names whom they replaced. */
export interface CoordinatorChange {
  plant: string
  emp_id?: string
  name?: string | null
}

/** 接任稽核主管 (#187) is one row on the new 稽核主管, whose `before` names the one before (and `others` if the database had several). */
export interface AuditAdminChange {
  emp_id?: string
  name?: string | null
  others?: { emp_id: string; name: string | null }[]
}

/** 加入／移除 carry the whole picture at that moment; the others carry the one value. 檢視廠區 are 廠區代碼. */
export interface AccessSnapshot {
  role: LoggedRole
  viewer_plants: string[]
  note: string | null
}

/** One row of the 權限異動紀錄. A null actor is the 部署指令 (or db:set-role). */
export interface ChangeLogRow {
  id: number
  changed_at: string
  actor_emp_id: string | null
  actor_name: string | null
  target_emp_id: string
  target_name: string | null
  action: ChangeAction
  before: unknown
  after: unknown
}

/** What removing someone would leave hanging (function access_removal_impact). */
export interface RemovalImpactRow {
  /** current = their turn now, later = a later 關卡, route = a 關卡 on an active 簽核流程 */
  kind: 'current' | 'later' | 'route'
  assessment_id: string | null
  route_id: string | null
  year: number | null
  template_code: string
  template_name: string
  factory_code: string
  plant_name: string
  step_position: number
  step_name: string
}
