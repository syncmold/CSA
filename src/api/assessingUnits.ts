// 自評單位清單 (#10): group-wide, maintained by 稽核管理者. RLS decides who may read or write;
// the database refuses duplicates (23505) and deleting a unit still in use (23503).
import { check } from './result'
import { supabase } from './supabase'

export interface AssessingUnit {
  id: string
  name: string
}

export async function fetchAssessingUnits(): Promise<AssessingUnit[]> {
  const { data, error } = await supabase.from('assessing_unit').select('id,name').order('name').returns<AssessingUnit[]>()
  if (error) throw error
  return data
}

/** Returns the new unit, so a control point can choose it straight away. */
export async function createAssessingUnit(name: string): Promise<AssessingUnit> {
  const { data, error } = await supabase.from('assessing_unit').insert({ name }).select('id,name').single<AssessingUnit>()
  if (error) throw error
  return data
}

export function renameAssessingUnit(id: string, name: string) {
  return check(supabase.from('assessing_unit').update({ name }).eq('id', id))
}

export function deleteAssessingUnit(id: string) {
  return check(supabase.from('assessing_unit').delete().eq('id', id))
}
