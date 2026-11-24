import { selectAssessmentRecords, selectRecordScope, type AssessmentRecord, type RecordScope } from './recordsQuery'
import { supabase } from './supabase'

export type { AssessmentRecord, RecordScope } from './recordsQuery'

export async function fetchAssessmentRecords(): Promise<AssessmentRecord[]> {
  const { data, error } = await selectAssessmentRecords(supabase)
  if (error) throw error
  return data
}

export async function fetchRecordScope(): Promise<RecordScope> {
  const { data, error } = await selectRecordScope(supabase)
  if (error) throw error
  return data
}
