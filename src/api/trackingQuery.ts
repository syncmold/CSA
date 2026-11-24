import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssessmentStage, AssessmentStatus } from './assessments'
import type { TemplateComponent } from './templates'

/**
 * 追蹤總覽 (#14, Q95): one row per 自評表 of a 年度, for 稽核管理者 only (view `tracking_assessment`; anyone else
 * gets an empty list). 停留天數 is counted by the database from the last 簽核紀錄 (送出、核准、退回) or, before
 * any, from the launch — so a 退回 restarts it. Before the 匯流 (#99) the 關卡 shown is the one of the 分流 longest
 * without a move, and its 停留天數 counts from that 分流's last 簽核紀錄.
 */
export interface TrackingRow {
  assessment_id: string
  year: number
  due_date: string
  company_id: string
  company_name: string
  plant_id: string
  factory_code: string
  plant_name: string
  /** 矩陣的欄（一個編號一份範本，Q137 (4)）。 */
  template_id: string
  template_code: string
  template_name: string
  status: AssessmentStatus
  current_step_position: number
  step_count: number
  current_step_name: string
  /** null: 待分派 (#101). */
  current_signer_emp_id: string | null
  /** employee_ref's current name; null when that employee has never signed in to CSA */
  current_signer_name: string | null
  /** When the 自評表 entered its current 關卡 (for a 結案 one: when it was closed). */
  entered_step_at: string
  /** Calendar days (Asia/Taipei) at the current 關卡; null once 結案. */
  days_at_step: number | null
  closed_at: string | null
  /** 填寫中／簽核中／結案 (Q115, the same definition as 我的自評表). */
  stage: AssessmentStage
  /** Calendar days (Asia/Taipei) from today to the 截止日; negative once it has passed. */
  due_in_days: number
  /** 適用單位數: the 分流 this 自評表 has (#99); 0 for a route without any. */
  branch_count: number
  /** 已核准單位數: the 分流 whose every 關卡 is done. */
  branches_done: number
  /** The 分流 of the 關卡 shown (before the 匯流, the one longest without a move); null after the 匯流. */
  current_step_branch_unit: string | null
}

const TRACKING_COLUMNS = [
  'assessment_id', 'year', 'due_date', 'company_id', 'company_name', 'plant_id', 'factory_code', 'plant_name',
  'template_id', 'template_code', 'template_name', 'status', 'current_step_position', 'step_count', 'current_step_name',
  'current_signer_emp_id', 'current_signer_name', 'entered_step_at', 'days_at_step', 'closed_at', 'stage', 'due_in_days',
  'branch_count', 'branches_done', 'current_step_branch_unit',
].join(',')

/**
 * The page's query, kept apart from the API module (which creates the browser client on import) so tests/db run
 * exactly this against PostgREST. 公司 → 廠區 → 範本.
 */
export function selectTracking(client: SupabaseClient, year: number) {
  return client
    .from('tracking_assessment')
    .select(TRACKING_COLUMNS)
    .eq('year', year)
    .order('company_name')
    .order('factory_code')
    .order('template_code')
    .order('template_id')
    .returns<TrackingRow[]>()
}

/**
 * A 範本 the 追蹤總覽 needs (#86, function `tracking_template`): one that is 啟用 and applies to a 廠區 the caller
 * sees, or one a 自評表 there was launched from. Its 組成要素 places the 自評表 in a column (the snapshot has none,
 * Q101 (4)); `applies_to` tells a 未發起 cell from a 不適用 one. Same reach as tracking_assessment.
 */
export interface TrackingTemplate {
  template_id: string
  template_code: string
  template_name: string
  template_component: TemplateComponent | null
  /** The 廠區 (plant ids) it applies to now, as long as it is 啟用; empty otherwise. */
  applies_to: string[]
}

export async function selectTrackingTemplates(client: SupabaseClient) {
  const { data, error } = await client.rpc('tracking_template')
  return { data: (data ?? []) as TrackingTemplate[], error }
}
