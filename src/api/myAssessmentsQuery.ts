import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssessmentStage, AssessmentStatus } from './assessments'

/**
 * Which 自評表 a row is — the part 我參與的自評表 and 我的待簽 (`MyTask`) share. The database defines it once too:
 * `my_pending_assessment` is built on `my_assessment`.
 */
export interface MyAssessmentSummary {
  assessment_id: string
  year: number
  due_date: string
  template_code: string
  template_name: string
  factory_code: string
  plant_name: string
}

export const MY_ASSESSMENT_SUMMARY_COLUMNS = 'assessment_id,year,due_date,template_code,template_name,factory_code,plant_name'

/**
 * 我參與的自評表 (#37): the 自評表 the signed-in employee is on the route of — the ones being signed, already signed and
 * 結案, and since Q152 also the ones whose turn has not come even when they cannot see them yet (`can_open` false).
 * Which ones is decided by the database (view `my_assessment`, which reuses `my_visible_assessment_ids`); a 稽核管理者
 * only gets the ones they are on the route of here (every plant's are in 自評表紀錄). 首頁 keeps only those `on_home`
 * (Q124 (1)).
 */
export interface MyAssessment extends MyAssessmentSummary {
  status: AssessmentStatus
  /** Null only when `can_open` is false: how far the 流程 has got is part of the 自評表, not shown before their turn (Q152). */
  current_step_position: number | null
  current_step_name: string | null
  /** 填寫中／簽核中／結案: whether the current 關卡 is one that answers (Q115). */
  stage: AssessmentStage
  /** Calendar days (Asia/Taipei) from today to the 截止日; negative once it has passed. */
  due_in_days: number
  /** The signed-in employee's part: 待填寫, 待簽核, not their turn yet, or done (Q115). */
  my_part: MyPart
  /** Only for `fill`: the questions of their own 自評單位 at this 關卡 answered so far, and how many there are. */
  my_answered: number | null
  my_question_count: number | null
  /** Only for `fill`: whether any of their questions or their 整體結論 has been touched (開始填寫 vs 繼續填寫). */
  my_started: boolean | null
  /**
   * Whether the employee can open it now. False only for a 尚未輪到我 they cannot see yet (Q152): listed with its 抬頭 so
   * they know it is coming, opened once their 關卡 comes (Q81 (5)).
   */
  can_open: boolean
}

/** `fill`: their turn to answer (my_editable_units); `sign`: their turn, signing only; `upcoming`: a 關卡 of theirs is still ahead. */
export type MyPart = 'fill' | 'sign' | 'upcoming' | 'done'

const MY_ASSESSMENT_COLUMNS =
  `${MY_ASSESSMENT_SUMMARY_COLUMNS},status,current_step_position,current_step_name,stage,due_in_days,my_part,my_answered,my_question_count,my_started,can_open`

/**
 * The page's query, kept apart from the API module (which creates the browser client on import) so tests/db run
 * exactly this against PostgREST: the ones 首頁 keeps, the latest 年度's and any not yet 結案 (`on_home`, Q124 (1)).
 * 簽核中 before 結案 (the enum's declared order), then newest 年度 first.
 */
export const selectMyAssessments = (client: SupabaseClient) => myAssessments(client, true)

/** The same list with the 往年已結案 kept: whom the view lists at all, which tests/db check apart from 首頁's cut. */
export const selectEveryAssessmentOfMine = (client: SupabaseClient) => myAssessments(client, false)

function myAssessments(client: SupabaseClient, homeOnly: boolean) {
  const query = client.from('my_assessment').select(MY_ASSESSMENT_COLUMNS)
  return (homeOnly ? query.eq('on_home', true) : query)
    .order('status')
    .order('year', { ascending: false })
    .order('template_code')
    .order('factory_code')
    .returns<MyAssessment[]>()
}

/** 往年已結案的 the employee was on: no longer on 首頁, only counted there to point to 自評表紀錄 (Q124 (1)). */
export async function countMyPastClosed(client: SupabaseClient): Promise<number> {
  const { data, error } = await client.rpc('my_past_closed_count')
  if (error) throw error
  return data as number
}
