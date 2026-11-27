import { supabase } from './supabase'

/** The four 系統角色 (Q153: 檢視者 is gone; what it saw is a 一般使用者's optional 檢視廠區). */
export type AuditRole = 'signer' | 'audit_admin' | 'audit_staff' | 'system_maintainer'

/** A role as the 人員異動紀錄 may still hold it: entries from before Q153 name the retired 檢視者. */
export type LoggedRole = AuditRole | 'viewer'

/**
 * My own employee_ref row (RLS lets everyone read their own). The 管理員帳號 (#161) has no row: the database says what
 * it is (系統維護員, Q122 (5)) through the same function its rules use.
 */
export async function fetchMyAuditRole(empId: string): Promise<AuditRole | null> {
  const { data, error } = await supabase.from('employee_ref').select('audit_role').eq('emp_id', empId).maybeSingle<{ audit_role: AuditRole }>()
  if (error) throw error
  if (data) return data.audit_role
  const role = await supabase.rpc('current_audit_role')
  if (role.error) throw role.error
  return (role.data as AuditRole | null) ?? null
}

/** My own 檢視廠區 (plant ids): optional, and only a 一般使用者 has any (Q153). */
export async function fetchMyViewerPlantIds(empId: string): Promise<string[]> {
  const { data, error } = await supabase.from('employee_ref').select('viewer_plant_ids').eq('emp_id', empId).maybeSingle<{ viewer_plant_ids: string[] }>()
  if (error) throw error
  return data?.viewer_plant_ids ?? []
}
