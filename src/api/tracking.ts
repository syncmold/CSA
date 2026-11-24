import { supabase } from './supabase'
import { selectTracking, selectTrackingTemplates, type TrackingRow, type TrackingTemplate } from './trackingQuery'

export type { TrackingRow, TrackingTemplate } from './trackingQuery'

export async function fetchTracking(year: number): Promise<TrackingRow[]> {
  const { data, error } = await selectTracking(supabase, year)
  if (error) throw error
  return data
}

/** The 範本 the 追蹤總覽 sits among (#86): which 廠區 each 啟用 one applies to; the same for every 年度. */
export async function fetchTrackingTemplates(): Promise<TrackingTemplate[]> {
  const { data, error } = await selectTrackingTemplates(supabase)
  if (error) throw error
  return data
}
