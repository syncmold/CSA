import { selectLaunchedYears } from './issuedQuery'
import { supabase } from './supabase'

/** Every 年度 launched so far, newest first (#173). */
export async function fetchLaunchedYears(): Promise<number[]> {
  const { data, error } = await selectLaunchedYears(supabase)
  if (error) throw error
  return data.map((row) => row.year)
}
