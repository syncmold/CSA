import { MY_ASSESSMENT_SUMMARY_COLUMNS, type MyAssessmentSummary } from './myAssessmentsQuery'
import { supabase } from './supabase'

/**
 * A 自評表 waiting for the signed-in employee: it is their turn at the current 關卡.
 * The database decides that (view `my_pending_assessment`: the 簽核中 rows of `my_assessment` whose current 關卡 is
 * theirs), not the front end — a 稽核管理者 can read every 自評表 but only gets the ones at their own 關卡 here.
 */
export interface MyTask extends MyAssessmentSummary {
  step_position: number
  step_name: string
}

export async function fetchMyTasks(): Promise<MyTask[]> {
  const { data, error } = await supabase
    .from('my_pending_assessment')
    .select(`${MY_ASSESSMENT_SUMMARY_COLUMNS},step_position,step_name`)
    .order('due_date')
    .order('template_code')
    .returns<MyTask[]>()
  if (error) throw error
  return data
}
