import { countMyPastClosed, selectMyAssessments, type MyAssessment } from './myAssessmentsQuery'
import { supabase } from './supabase'

export type { MyAssessment } from './myAssessmentsQuery'

export async function fetchMyAssessments(): Promise<MyAssessment[]> {
  const { data, error } = await selectMyAssessments(supabase)
  if (error) throw error
  return data
}

export const fetchMyPastClosedCount = () => countMyPastClosed(supabase)
