// 簽核流程 (#11): the 流程編輯器's reads and writes. Who may read or write, the 發起檢查 and every rule
// about ordering and 可編輯範圍 are decided in the database (ADR-0001); this file only shapes requests.
import type { LastModifiedFields } from '../domain/lastModified'
import { check } from './result'
import { supabase } from './supabase'
import type { TemplateComponent } from './templates'

export type StepGroup = 'plant' | 'audit_review'
/** 連動標記 (#187, #189): the two 稽核室覆核 steps whose 簽核人 follows 權限管理 (see `route_step.link`). */
export const ROUTE_LINKS = ['taipei_auditor', 'audit_chief'] as const
export type RouteLink = (typeof ROUTE_LINKS)[number]

/**
 * The database's 發起檢查 (`launch_check` computed column; 啟用檢查 before Q137 (6)), the same one the 年度發起 runs: a
 * route that does not pass it cannot be launched.
 */
export interface LaunchCheck {
  ready: boolean
  no_steps: boolean
  /** There are steps but none after the 匯流: a 部門主管 approving the last 分流 would have no next step. */
  no_merge_steps: boolean
  /** 自評單位 the template uses that have no 分流 (no 自行檢查人員 step), in paper order. */
  missing_units: Unit[]
  /** 可編輯範圍 the template has no control points for, in step order: that step would have nothing to answer. */
  unused_units: Unit[]
  /** 分流 whose first step is not the unit's 自行檢查人員, in step order. */
  branch_first_step_not_editable: Unit[]
  /** The 連動標記 the 稽核室覆核 steps still lack (each of 台北稽核人員 and 稽核主管 must be there once), in this order. */
  missing_links: RouteLink[]
  /** The 稽核主管 step is not the last step of the route (#187: every route ends with it). */
  audit_chief_not_last: boolean
  /** How many of the template's control points still carry the placeholder unit 待指定單位 (Q142): any blocks the launch. */
  pending_unit_points: number
  /**
   * 關卡 without a 簽核人 yet (not 連動), 分流 ones first: everyone is 分派 on the route before the launch (Q147), so any
   * blocks it. `branch_unit_name` is null for a 匯流後 step.
   */
  unassigned_steps: UnassignedStep[]
}

export interface UnassignedStep {
  id: string
  name: string
  branch_unit_id: string | null
  branch_unit_name: string | null
}

interface Unit {
  id: string
  name: string
}

/** `updated_*`: the 最後修改 of the route or any of its 關卡 (#201). */
interface RouteHead extends LastModifiedFields {
  id: string
  template: { id: string; code: string; name: string; component: TemplateComponent | null }
  plant: { id: string; factory_code: string; name: string }
  launch_check: LaunchCheck
}

export interface RouteSummary extends RouteHead {
  step_count: number
}

export interface RouteStepRow {
  id: string
  position: number
  name: string
  step_group: StepGroup
  /**
   * OMS 工號 (Q61) of the step's 簽核人; the name comes from CSA's own copy (visible_people, #218). Every step that is not
   * 連動 is 分派 here before the launch and copied onto the 自評表 (Q147); null＝not assigned yet.
   */
  signer_emp_id: string | null
  /** null＝唯讀 */
  editable_unit_id: string | null
  /** The 自評單位 whose 分流 the step is in; null＝匯流後 (廠區經理人, 稽核室覆核). */
  branch_unit_id: string | null
  assessing_unit: { name: string } | null
  /** 連動標記: the step's 簽核人 is set by 權限管理, so it is read-only here; null＝an ordinary step. */
  link: RouteLink | null
  /**
   * A 連動關卡 follows 權限管理 right now (`linked_now` computed column, #190): its 廠區管理員 is a 稽核人員, or there is
   * exactly one 稽核主管. When it does not, its 簽核人 (and only that) is chosen here (#187 decision 1). False on other steps.
   */
  linked_now: boolean
}

/** One 分流 card on the 流程編輯器 (`branch_units` computed column): the template's units in paper order first. */
export interface BranchUnit {
  id: string
  name: string
  /** false: the route still has a 分流 for a unit the template no longer uses. */
  in_template: boolean
}

export interface RouteTree extends RouteHead {
  route_step: RouteStepRow[]
  branch_units: BranchUnit[]
}

const HEAD = 'id,updated_at,updated_by,updated_by_name,launch_check,template:questionnaire_template(id,code,name,component),plant(id,factory_code,name)'
const SUMMARY = `${HEAD},route_step(count)`
const TREE = `${HEAD},branch_units,route_step(id,position,name,step_group,signer_emp_id,editable_unit_id,branch_unit_id,link,linked_now,assessing_unit!route_step_editable_unit_id_fkey(name))`

/** Every route visible to the caller, in no particular order (the list page sorts them). */
export async function fetchRoutes(): Promise<RouteSummary[]> {
  const { data, error } = await supabase.from('approval_route').select(SUMMARY).returns<(RouteHead & { route_step: { count: number }[] })[]>()
  if (error) throw error
  return data.map(({ route_step, ...head }) => ({ ...head, step_count: route_step[0]?.count ?? 0 }))
}

/** One route with its steps in order; null when RLS hides it or it does not exist. */
export async function fetchRoute(id: string): Promise<RouteTree | null> {
  const { data, error } = await supabase.from('approval_route').select(TREE).eq('id', id).maybeSingle<RouteTree>()
  if (error) throw error
  if (!data) return null
  return { ...data, route_step: [...data.route_step].sort((a, b) => a.position - b.position) }
}

/** The only route of this 範本 × 廠區 (a second one is refused, 23505); returns its id. */
export async function createRoute(templateId: string, plantId: string): Promise<string> {
  const { data, error } = await supabase.from('approval_route').insert({ template_id: templateId, plant_id: plantId }).select('id').single<{ id: string }>()
  if (error) throw error
  return data.id
}

/**
 * Deletes the route with its steps. `confirmCode` is its 範本編號, which the database compares once more (22023: the
 * page is stale); only a 稽核主管 may (42501). Issued 自評表 keep their own copy of the steps.
 */
export function deleteRoute(id: string, confirmCode: string) {
  return check(supabase.rpc('delete_route', { p_route_id: id, p_code: confirmCode }))
}

export interface StepInput {
  name: string
  step_group: StepGroup
  /** Only 稽核室覆核 steps have one (the database refuses it on 廠區端). */
  signer_emp_id: string | null
  /** Only 廠區端 steps may have one (the database refuses it on 稽核室覆核). */
  editable_unit_id: string | null
}

/** A new step may carry a 連動標記 (稽核室覆核 only); an existing step's mark cannot be changed. */
export interface NewStepInput extends StepInput {
  link?: RouteLink | null
}

/**
 * Adds a step after the last one, or before the step now at `beforePosition` (the ones from there on move
 * down), in the 分流 of `branchUnitId` (null＝匯流後), in one database call.
 */
export function createStep(routeId: string, input: NewStepInput, beforePosition: number | null = null, branchUnitId: string | null = null) {
  return check(
    supabase.rpc('insert_route_step', {
      p_route_id: routeId,
      p_name: input.name,
      p_step_group: input.step_group,
      p_signer_emp_id: input.signer_emp_id,
      p_editable_unit_id: input.editable_unit_id,
      p_before_position: beforePosition,
      p_branch_unit_id: branchUnitId,
      p_link: input.link ?? null,
    }),
  )
}

/** A new 分流: 自行檢查人員 → 部門主管 for the unit, placed before the 匯流後 steps (the names come from the database). */
export function addBranch(routeId: string, unitId: string) {
  return check(supabase.rpc('add_route_branch', { p_route_id: routeId, p_unit_id: unitId }))
}

/** Deletes every step of one 分流 (a unit the template no longer uses); the rest are renumbered by the database. */
export function deleteBranch(routeId: string, unitId: string) {
  return check(supabase.from('route_step').delete().eq('route_id', routeId).eq('branch_unit_id', unitId))
}

/**
 * A step with a 連動標記 is refused by the database (hint `step_linked`) while it is linked, and anything but its 簽核人
 * while it is not (#190); the page offers only what is allowed.
 */
export function updateStep(id: string, input: StepInput) {
  return check(supabase.from('route_step').update(input).eq('id', id))
}

/** The remaining steps are renumbered by the database. */
export function deleteStep(id: string) {
  return check(supabase.from('route_step').delete().eq('id', id))
}

/** `stepIds` is every step of the route in the new order. */
export function reorderSteps(routeId: string, stepIds: string[]) {
  return check(supabase.rpc('reorder_route_steps', { p_route_id: routeId, p_step_ids: stepIds }))
}
