// 權限管理 (#58, Q98). Reads go through view access_member and table access_change_log, writes through the
// database's maintenance functions; both are for 稽核管理者 only, which the database decides (ADR-0001).
import type { PickerRow } from '../../exchange/core'
import type { AccessMember, ChangeLogRow, RemovalImpactRow } from './accessModel'
import type { AuditRole } from './employee'
import { check } from './result'
import { supabase } from './supabase'

export type { AccessMember, ChangeLogRow, RemovalImpactRow } from './accessModel'

const MEMBER_COLUMNS =
  'emp_id,name,factory_code,audit_role,viewer_plant_ids,note,added_at,added_by_emp_id,added_by_name,last_login_at,coordinator_plant_ids'

export async function fetchAccessMembers(): Promise<AccessMember[]> {
  const { data, error } = await supabase.from('access_member').select(MEMBER_COLUMNS).order('emp_id').returns<AccessMember[]>()
  if (error) throw error
  return data
}

/** The 權限異動紀錄 only grows; the page shows the latest this many. */
export const CHANGE_LOG_LIMIT = 1000

/** Newest first, at most CHANGE_LOG_LIMIT. */
export async function fetchChangeLog(): Promise<ChangeLogRow[]> {
  const { data, error } = await supabase
    .from('access_change_log')
    .select('id,changed_at,actor_emp_id,actor_name,target_emp_id,target_name,action,before,after')
    .order('id', { ascending: false })
    .limit(CHANGE_LOG_LIMIT)
    .returns<ChangeLogRow[]>()
  if (error) throw error
  return data
}

export interface AccessSettings {
  role: AuditRole
  viewerPlantIds: string[]
  note: string
  /** The 負責廠區 added and taken off (編輯 only); the others stay as they are, and all of them when absent. */
  coordinatorChanges?: { assign: string[]; unassign: string[] }
}

/** The 工號 the database added and the ones it skipped because they were already on the list. */
export interface AddResult {
  added: string[]
  skipped: string[]
}

export async function addAccessMembers(people: PickerRow[], settings: AccessSettings): Promise<AddResult> {
  const { data, error } = await supabase.rpc('add_access_members', {
    p_people: people,
    p_role: settings.role,
    p_viewer_plant_ids: settings.viewerPlantIds,
    p_note: settings.note,
  })
  if (error) throw error
  return data as AddResult
}

export function updateAccessMember(empId: string, settings: AccessSettings): Promise<void> {
  return check(
    supabase.rpc('update_access_member', {
      p_emp_id: empId,
      p_role: settings.role,
      p_viewer_plant_ids: settings.viewerPlantIds,
      p_note: settings.note,
      ...(settings.coordinatorChanges
        ? { p_coordinator_assign: settings.coordinatorChanges.assign, p_coordinator_unassign: settings.coordinatorChanges.unassign }
        : {}),
    }),
  )
}

/** 指定 or 更換 a plant's 廠區負責人: whoever ran it steps down. */
export function setPlantCoordinator(plantId: string, empId: string): Promise<void> {
  return check(supabase.rpc('set_plant_coordinator', { p_plant_id: plantId, p_emp_id: empId }))
}

/** 移除 a plant's 廠區負責人: the plant has none until someone is named. */
export function removePlantCoordinator(plantId: string): Promise<void> {
  return check(supabase.rpc('remove_plant_coordinator', { p_plant_id: plantId }))
}

/** Whether I run any plant (everyone reads their own rows of plant_coordinator); for showing the menu only. */
export async function fetchRunsAPlant(empId: string): Promise<boolean> {
  const { count, error } = await supabase.from('plant_coordinator').select('plant_id', { count: 'exact', head: true }).eq('emp_id', empId)
  if (error) throw error
  return (count ?? 0) > 0
}

/** The plants I run as 廠區管理員 (everyone reads their own rows of plant_coordinator); for 匯出 Excel only. */
export async function fetchMyRunPlantIds(empId: string): Promise<string[]> {
  const { data, error } = await supabase.from('plant_coordinator').select('plant_id').eq('emp_id', empId).returns<{ plant_id: string }[]>()
  if (error) throw error
  return data.map((r) => r.plant_id)
}

export function removeAccessMember(empId: string): Promise<void> {
  return check(supabase.rpc('remove_access_member', { p_emp_id: empId }))
}

export async function fetchRemovalImpact(empId: string): Promise<RemovalImpactRow[]> {
  const { data, error } = await supabase.rpc('access_removal_impact', { p_emp_id: empId })
  if (error) throw error
  return data as RemovalImpactRow[]
}
