// 分派 (#101, Q116 (5)(7); Q147): a plant's 簽核流程 (分派 before the launch) and issued 自評表, and the writes that assign
// or replace a 關卡's 簽核人. Who may change what is decided by assign_route_signer and assign_step_signer (ADR-0001).
import type { Plant } from './plants'
import type { RouteLink, StepGroup } from './approvalRoutes'
import type { AssessmentStep, StepState } from './assessments'
import { check } from './result'
import { supabase } from './supabase'

/**
 * 分派's picker (#218, Q133 (11) ④): the people already on this plant's 自評表 (any 年度), with the names CSA keeps.
 * Only a 稽核主管, a 系統維護員 or the plant's 廠區管理員 may ask (plant_form_people).
 */
export async function plantFormPeople(factoryCode: string): Promise<{ emp_id: string; name: string | null }[]> {
  const { data, error } = await supabase.rpc('plant_form_people', { p_factory_code: factoryCode })
  if (error) throw error
  return data as { emp_id: string; name: string | null }[]
}

/**
 * A 關卡 the 分派 page shows, on a 簽核流程 (下次發出, Q147) or an issued 自評表: a route's 關卡 have no `state` (nobody
 * signs a route) and no `vacated_*`.
 */
export interface AssignableStep {
  id: string
  position: number
  name: string
  step_group: StepGroup
  link: string | null
  signer_emp_id: string | null
  branch_unit_name: string | null
  state?: StepState
  vacated_emp_id?: string | null
  vacated_name?: string | null
}

/** A 關卡 on an issued 自評表 on the 分派 page; `vacated_*` name who left when its 簽核人 was carried over (#102). */
export interface AssignmentStep extends AssessmentStep {
  /** 連動標記 (#189): 台北稽核人員／稽核主管 follow 權限管理 and are never assigned here; null for every other 關卡. */
  link: string | null
  vacated_emp_id: string | null
  vacated_name: string | null
}

export interface AssignmentForm {
  id: string
  template_code: string
  template_name: string
  /** 要素類 (A–D) forms answer as one 「要素類」 group in the 分派表 (#180). */
  template_layout: 'element' | 'control_activity'
  status: 'in_progress' | 'closed'
  annual_cycle: { year: number; due_date: string }
  assessment_step: AssignmentStep[]
}

/** A 關卡 left 從缺 at the launch: whoever held it last year has left (#102). */
export interface Vacancy {
  template_code: string
  name: string
  branch_unit_name: string | null
  vacated_emp_id: string
  vacated_name: string | null
}

/** A 關卡 still without a 簽核人, under an {@link AssignmentTodo}; `vacated_*` only on a 自評表 issued before Q147 (#102). */
export interface PendingStep {
  template_code: string
  name: string
  branch_unit_name: string | null
  vacated_emp_id?: string | null
  vacated_name?: string | null
}

/**
 * What the signed-in employee still has to assign (view my_assignment_todo, Q147). `route`: a plant they run whose
 * 簽核流程 still have 關卡 without a 簽核人 (to 分派 before the forms go out), one row per plant, `year` null. `assessment`:
 * for a 稽核主管, 自評表 issued before Q147 that still wait for someone, one row per plant and 年度.
 */
export interface AssignmentTodo {
  kind: 'route' | 'assessment'
  plant_id: string
  factory_code: string
  plant_name: string
  year: number | null
  due_date: string | null
  /** 簽核流程 (route) or 自評表 (assessment) with a 關卡 nobody is assigned to yet. */
  forms: number
  steps: number
  pending: PendingStep[]
}

/**
 * A 簽核流程 of one plant on 分派填寫人's 下次發出 (Q147): the 關卡 whose 簽核人 the next launch copies onto the 自評表.
 */
export interface AssignmentRoute {
  id: string
  template_code: string
  template_name: string
  template_layout: 'element' | 'control_activity'
  route_step: AssignableStep[]
}

interface RouteRow {
  id: string
  template: { code: string; name: string; layout: AssignmentRoute['template_layout']; all_plants: boolean; template_plant: { factory_code: string }[] }
  route_step: { id: string; position: number; name: string; step_group: StepGroup; link: RouteLink | null; signer_emp_id: string | null; branch: { name: string } | null }[]
}

const ROUTE_COLUMNS =
  'id,template:questionnaire_template!inner(code,name,layout,all_plants,template_plant(factory_code)),' +
  'route_step(id,position,name,step_group,link,signer_emp_id,branch:assessing_unit!route_step_branch_unit_id_fkey(name))'

/**
 * The 簽核流程 the next launch would issue to this plant (啟用 templates that apply to it), in 範本編號 order. A 廠區管理員
 * reads his plants' routes with their templates and units (Q147); the database shows nothing to anyone else.
 */
export async function fetchAssignmentRoutes(plant: Pick<Plant, 'id' | 'factory_code'>): Promise<AssignmentRoute[]> {
  const { data, error } = await supabase
    .from('approval_route')
    .select(ROUTE_COLUMNS)
    .eq('plant_id', plant.id)
    .eq('template.status', 'active')
    .returns<RouteRow[]>()
  if (error) throw error
  return data
    .filter(({ template: t }) => t.all_plants || t.template_plant.some((p) => p.factory_code === plant.factory_code))
    .map(({ id, template: t, route_step }) => ({
      id,
      template_code: t.code,
      template_name: t.name,
      template_layout: t.layout,
      route_step: route_step.map(({ branch, ...s }) => ({ ...s, branch_unit_name: branch?.name ?? null })),
    }))
    .sort((a, b) => (a.template_code < b.template_code ? -1 : a.template_code > b.template_code ? 1 : 0))
}

const FORM_COLUMNS =
  'id,template_code,template_name,template_layout,status,annual_cycle(year,due_date),' +
  'assessment_step(id,position,name,step_group,link,signer_emp_id,editable_unit_name,branch_unit_name,state,vacated_emp_id,vacated_name)'

/** Every 自評表 of a plant, of every 年度; the database shows only what the signed-in employee may see. */
export async function fetchAssignmentForms(plantId: string): Promise<AssignmentForm[]> {
  const { data, error } = await supabase.from('assessment').select(FORM_COLUMNS).eq('plant_id', plantId).order('template_code').returns<AssignmentForm[]>()
  if (error) throw error
  return data
}

export async function fetchAssignmentTodo(): Promise<AssignmentTodo[]> {
  const { data, error } = await supabase
    .from('my_assignment_todo')
    .select('kind,plant_id,factory_code,plant_name,year,due_date,forms,steps,pending')
    .order('kind', { ascending: false })
    .order('year', { ascending: false })
    .order('factory_code')
    .returns<AssignmentTodo[]>()
  if (error) throw error
  return data
}

/** The plants this employee runs as 廠區負責人. */
export async function fetchMyPlants(empId: string): Promise<Plant[]> {
  const { data, error } = await supabase
    .from('plant_coordinator')
    .select('plant(id,factory_code,name)')
    .eq('emp_id', empId)
    .returns<{ plant: Plant }[]>()
  if (error) throw error
  return data.map((r) => r.plant)
}

/**
 * 分派 on the 簽核流程 before the forms go out (Q147): a 稽核主管 or the plant's 廠區管理員 sets or replaces a 關卡's 簽核人,
 * copied onto the 自評表 at the launch. `name` is the OMS name, for the 異動紀錄 of someone who has not logged in yet.
 */
export function assignRouteStep(stepId: string, empId: string, name: string | null) {
  return check(supabase.rpc('assign_route_signer', { p_route_step_id: stepId, p_emp_id: empId, p_emp_name: name }))
}

/**
 * Replaces the 簽核人 of an issued 自評表's 關卡 (Q147: only a 稽核主管 once the forms are out), and the route's too, for
 * next year; `name` is the OMS name, for the 異動紀錄 of someone who has not logged in yet.
 */
export function assignStep(stepId: string, empId: string, name: string | null) {
  return check(supabase.rpc('assign_step_signer', { p_step_id: stepId, p_emp_id: empId, p_emp_name: name }))
}
