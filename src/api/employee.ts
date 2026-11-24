import { supabase } from './supabase'

export type AuditRole = 'signer' | 'audit_admin' | 'audit_staff' | 'viewer' | 'system_maintainer'

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

/** My own 檢視廠區 (plant ids); empty unless I am a 檢視者. */
export async function fetchMyViewerPlantIds(empId: string): Promise<string[]> {
  const { data, error } = await supabase.from('employee_ref').select('viewer_plant_ids').eq('emp_id', empId).maybeSingle<{ viewer_plant_ids: string[] }>()
  if (error) throw error
  return data?.viewer_plant_ids ?? []
}
