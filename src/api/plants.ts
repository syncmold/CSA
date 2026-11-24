// 廠區主檔 (#4, Q81): readable by everyone signed in. 範本管理 offers these OMS 廠區代碼 as
// 適用廠區 suggestions; the master's real source is still open (Q68), so other codes may be typed too. Listed in
// SyncHub's order (OMS sort_order, by 事業群, #84), plants not synced yet last by code.
import { supabase } from './supabase'

export interface Plant {
  id: string
  factory_code: string
  name: string
}

export async function fetchPlants(): Promise<Plant[]> {
  const { data, error } = await supabase.from('plant').select('id,factory_code,name').order('sort_order', { nullsFirst: false }).order('factory_code').returns<Plant[]>()
  if (error) throw error
  return data
}
