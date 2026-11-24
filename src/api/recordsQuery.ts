import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssessmentStatus } from './assessments'

/**
 * 自評表紀錄 (#164, Q124 (2)): every 自評表 the signed-in employee can see, of every 年度. Which ones is the
 * database's reading rule (`my_visible_assessment_ids`, through view `assessment_record`), not a rule of this page:
 * every plant for 稽核管理者 and 系統維護員, the plants they view or run for 檢視者 and 廠區負責人, their own for the rest.
 */
export interface AssessmentRecord {
  assessment_id: string
  year: number
  company_id: string
  company_name: string
  plant_id: string
  factory_code: string
  plant_name: string
  template_code: string
  template_name: string
  status: AssessmentStatus
  /** 結案日: when the last 關卡 was approved; null while 簽核中. */
  closed_at: string | null
}

const RECORD_COLUMNS = 'assessment_id,year,company_id,company_name,plant_id,factory_code,plant_name,template_code,template_name,status,closed_at'

/**
 * The page's query, kept apart from the API module (which creates the browser client on import) so tests/db run
 * exactly this against PostgREST. Newest 年度 first, then by 範本 and 廠區 as the other lists.
 */
export function selectAssessmentRecords(client: SupabaseClient) {
  return client
    .from('assessment_record')
    .select(RECORD_COLUMNS)
    .order('year', { ascending: false })
    .order('template_code')
    .order('factory_code')
    .returns<AssessmentRecord[]>()
}

/**
 * What the signed-in employee sees there, for the label beside the title: every plant, or every 自評表 of these plants
 * (the ones they view or run), besides the ones they are on the route of.
 */
export interface RecordScope {
  all_plants: boolean
  plant_ids: string[]
}

export function selectRecordScope(client: SupabaseClient) {
  return client.rpc('my_record_scope').single<RecordScope>()
}
