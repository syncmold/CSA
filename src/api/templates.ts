// 範本管理: reading (#3) and editing (#10). Who may read or write, and every rule about 版型,
// 自評單位 and ordering, is decided in the database (ADR-0001); this file only shapes requests.
import type { LastModifiedFields } from '../domain/lastModified'
import { check } from './result'
import { supabase } from './supabase'

export type TemplateLayout = 'element' | 'control_activity'
/** 啟用／停用 only (Q137 (5)): there is no 草稿, a new template starts 啟用. */
export type TemplateStatus = 'active' | 'inactive'
/**
 * 組成要素 (處理準則第 6 條, #62). 控制活動類 is always control_activities; a 要素類 template is one
 * of the other four, or null (未分類) when nobody chose one and the database could not infer it from the 編號.
 */
export type TemplateComponent =
  | 'control_environment'
  | 'risk_assessment'
  | 'control_activities'
  | 'information_communication'
  | 'monitoring'

/** `updated_*`: the 最後修改 of the header or any 章節, 控制要點 or 自評單位 (#201). */
export interface TemplateSummary extends LastModifiedFields {
  id: string
  code: string
  name: string
  layout: TemplateLayout
  component: TemplateComponent | null
  status: TemplateStatus
  all_plants: boolean
  template_plant: { factory_code: string }[]
  /** Has a 自評表 or any 簽核流程, so it can only be deactivated, not deleted (computed in the database, #31). */
  in_use: boolean
  /** 題數: control points, a multi-unit one counted once (computed in the database, #84). */
  control_point_count: number
  /** Hash of the sections, control points and their 自評單位 in order; equal means the same content (#84, Q111). null when empty. */
  content_fingerprint: string | null
}

export interface ControlPointUnitRow {
  position: number
  assessing_unit_id: string
  assessing_unit: { name: string }
}

export interface ControlPointRow {
  id: string
  position: number
  /** 原檔題號; null: numbered by the page within its card (domain/outline, Q125). */
  code: string | null
  text: string
  /** In answering order (#46); empty only on 要素類 (Q83(3)). */
  control_point_unit: ControlPointUnitRow[]
}

export interface TemplateSectionRow {
  id: string
  position: number
  /** 1 starts a card; 2 and 3 are 分段列 in it, and a section with none of its own control points only heads them (Q125). */
  level: number
  /** 原檔的章節題號; null when the paper has none. */
  code: string | null
  name: string
  control_point: ControlPointRow[]
}

export interface TemplateTree extends TemplateSummary {
  template_section: TemplateSectionRow[]
}

const SUMMARY = 'id,code,name,layout,component,status,all_plants,in_use,control_point_count,content_fingerprint,updated_at,updated_by,updated_by_name,template_plant(factory_code)'
const TREE = `${SUMMARY},template_section(id,position,level,code,name,control_point(id,position,code,text,control_point_unit(position,assessing_unit_id,assessing_unit(name))))`

export async function fetchTemplates(): Promise<TemplateSummary[]> {
  const { data, error } = await supabase.from('questionnaire_template').select(SUMMARY).order('code').returns<TemplateSummary[]>()
  if (error) throw error
  return data
}

/** One template with sections and control points in paper order; null when RLS hides it or it does not exist. */
export async function fetchTemplateTree(id: string): Promise<TemplateTree | null> {
  const { data, error } = await supabase.from('questionnaire_template').select(TREE).eq('id', id).maybeSingle<TemplateTree>()
  if (error) throw error
  if (!data) return null
  // Embedded rows come back in storage order unless each level is given its own `order(…, { referencedTable })`;
  // one client-side sort by position is simpler and keeps the select string readable.
  const byPosition = <T extends { position: number }>(rows: T[]) => [...rows].sort((a, b) => a.position - b.position)
  return {
    ...data,
    template_section: byPosition(data.template_section).map((s) => ({
      ...s,
      control_point: byPosition(s.control_point).map((p) => ({ ...p, control_point_unit: byPosition(p.control_point_unit) })),
    })),
  }
}

// 編輯 (#10) -------------------------------------------------------------------

/** 範本抬頭 as edited in the form; `factory_codes` only matters when `all_plants` is false. */
export interface TemplateHeaderInput {
  code: string
  name: string
  /** Only on an edit: a new template is always 啟用 (Q137 (5)). */
  status?: TemplateStatus
  all_plants: boolean
  factory_codes: string[]
  /**
   * Required when creating: the database derives the 版型 from it (Q101(6)). On an edit it may move only among
   * the four non-控制作業 組成要素; null leaves it as it is.
   */
  component: TemplateComponent | null
}

/** The database function's parameters; it normalizes the 廠區代碼 (trim, upper-case, de-duplicate). */
function headerParams(input: TemplateHeaderInput) {
  return {
    p_code: input.code,
    p_name: input.name,
    p_all_plants: input.all_plants,
    p_factory_codes: input.factory_codes,
    p_component: input.component,
  }
}

/** New template with its 適用廠區, in one transaction; its 組成要素 decides the 版型 for good. Returns its id. */
export async function createTemplate(input: TemplateHeaderInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_template', headerParams(input))
  if (error) throw error
  return data as string
}

/** 範本抬頭 and 適用廠區 in one transaction (there is no 版型 parameter: it is fixed). */
export function updateTemplateHeader(id: string, input: TemplateHeaderInput & { status: TemplateStatus }) {
  return check(supabase.rpc('update_template', { p_template_id: id, ...headerParams(input), p_status: input.status }))
}

/** A 章節 as edited in its form: 層級 1–3 and the paper's 題號 (blank: numbered by the system), Q125. */
export interface SectionInput {
  name: string
  level: number
  code: string | null
}

/** Appended after the last section (the database picks the position). */
export function createSection(templateId: string, input: SectionInput) {
  return check(supabase.from('template_section').insert({ template_id: templateId, ...input }))
}

export function updateSection(id: string, input: SectionInput) {
  return check(supabase.from('template_section').update(input).eq('id', id))
}

/** Deletes the section with its control points; the remaining sections are renumbered by the database. */
export function deleteSection(id: string) {
  return check(supabase.from('template_section').delete().eq('id', id))
}

/** `sectionIds` is every section of the template in the new order. */
export function reorderSections(templateId: string, sectionIds: string[]) {
  return check(supabase.rpc('reorder_template_sections', { p_template_id: templateId, p_section_ids: sectionIds }))
}

export interface ControlPointInput {
  /** The paper's 題號; null: numbered by the system within its card (Q125). */
  code: string | null
  text: string
  /** In answering order; at least one for 控制活動類, any number for 要素類 (enforced by the database, #46). */
  assessing_unit_ids: string[]
}

/** Appended after the last control point of the section, with its 自評單位, in one transaction. */
export function createControlPoint(sectionId: string, input: ControlPointInput) {
  return check(
    supabase.rpc('create_control_point', { p_section_id: sectionId, p_text: input.text, p_unit_ids: input.assessing_unit_ids, p_code: input.code }),
  )
}

/** Text and 自評單位 together, in one transaction; the units are replaced as a whole, in the given order. */
export function updateControlPoint(id: string, input: ControlPointInput) {
  return check(
    supabase.rpc('update_control_point', { p_control_point_id: id, p_text: input.text, p_unit_ids: input.assessing_unit_ids, p_code: input.code }),
  )
}

export function deleteControlPoint(id: string) {
  return check(supabase.from('control_point').delete().eq('id', id))
}

/** `controlPointIds` is every control point of the section in the new order. */
export function reorderControlPoints(sectionId: string, controlPointIds: string[]) {
  return check(supabase.rpc('reorder_control_points', { p_section_id: sectionId, p_control_point_ids: controlPointIds }))
}

// 刪除 (#31) -------------------------------------------------------------------

/**
 * Deletes a template that was never used (no 自評表, no 簽核流程) with its sections, control points
 * and 適用廠區. `confirmCode` must be the template's 編號; a used template is refused with 23503.
 */
export function deleteTemplate(id: string, confirmCode: string) {
  return check(supabase.rpc('delete_template', { p_template_id: id, p_code: confirmCode }))
}
