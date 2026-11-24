// What was issued in a launched 年度, read from the 自評表 snapshots (ADR-0004). Kept apart from issued.ts (which creates
// the browser client on import) so tests/db run exactly these queries. Who sees which rows is the 自評表's reading rule
// (view issued_template is security_invoker). 範本管理 and 簽核流程 showed a launched year from these (#173, #174) until
// they dropped the 年度 (Q137 (2)); the screens no longer read them, but the view and these queries stay for now.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TemplateComponent, TemplateLayout } from './templates'

/** One 自評表 of a 年度: the 範本 it was issued from, with that year's 編號, 名稱 and 版型. */
export interface IssuedTemplate {
  assessment_id: string
  year: number
  template_id: string
  plant_id: string
  factory_code: string
  code: string
  name: string
  layout: TemplateLayout
  /** The source template's (the snapshot has none); null when 未分類. */
  component: TemplateComponent | null
  /** The snapshot's control points, a multi-unit one counted once. */
  control_point_count: number
}

const ISSUED_COLUMNS = 'assessment_id,year,template_id,plant_id,factory_code,code,name,layout,component,control_point_count'

/** Every 年度 launched so far, newest first. */
export function selectLaunchedYears(client: SupabaseClient) {
  return client.from('annual_cycle').select('year').order('year', { ascending: false }).returns<{ year: number }[]>()
}

/** The 自評表 issued in `year`, by 編號 then 廠區 like the template list. */
export function selectIssuedTemplates(client: SupabaseClient, year: number) {
  return client.from('issued_template').select(ISSUED_COLUMNS).eq('year', year).order('code').order('factory_code').returns<IssuedTemplate[]>()
}

/** A section of an issued 自評表 as 範本管理 shows it: the snapshot's 層級, 題號, name and control points (Q125). */
export interface IssuedSection {
  id: string
  position: number
  level: number
  code: string | null
  name: string
  assessment_control_point: {
    id: string
    position: number
    code: string | null
    text: string
    assessment_control_point_unit: { position: number; assessing_unit_name: string }[]
  }[]
}

/** One 自評表's questions as issued, sections in paper order; the embedded control points and units come back in any order. */
export function selectIssuedSections(client: SupabaseClient, assessmentId: string) {
  return client
    .from('assessment_section')
    .select('id,position,level,code,name,assessment_control_point(id,position,code,text,assessment_control_point_unit(position,assessing_unit_name))')
    .eq('assessment_id', assessmentId)
    .order('position')
    .returns<IssuedSection[]>()
}

/** A 關卡 of an issued 自評表, for a launched year's 簽核流程 list (#174). */
export interface IssuedStep {
  assessment_id: string
  position: number
  name: string
  /** The 自評單位 whose 分流 it is in; null after the 匯流. */
  branch_unit_name: string | null
}

/**
 * The 關卡 of the 自評表 issued in `year`, as they stand now (換人、加簽 change them, #13), rows `from`–`to` (both
 * included) in a stable order. A year has thousands of 關卡 and Supabase answers at most 1000 rows a request, cutting
 * the rest off without an error (supabase/config.toml max_rows), so the caller reads them page by page.
 */
export function selectIssuedSteps(client: SupabaseClient, year: number, from: number, to: number) {
  return client
    .from('assessment_step')
    .select('assessment_id,position,name,branch_unit_name,assessment!inner(annual_cycle!inner(year))')
    .eq('assessment.annual_cycle.year', year)
    .order('assessment_id')
    .order('position')
    .range(from, to)
    .returns<(IssuedStep & { assessment: unknown })[]>()
}
