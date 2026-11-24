// 年度發起 (#12): the 發起畫面's reads and the launch itself. Which combinations exist, whether each one's
// route can be launched (every 關卡 分派 on the route, Q147), who may launch and the once-a-year-per-combination rule
// are all decided in the database (`launch_candidates`, `launch_annual_cycle`, Q81 (4), Q89, Q119); this file shapes
// requests and, since the database cannot reach OMS, asks OMS's channel who on the routes has left (Q147 (4)).
import { notEmployed } from '../domain/employment'
import type { LaunchCheck } from './approvalRoutes'
import { lookUpPeople, omsCouldNotAnswer } from './people'
import { supabase } from './supabase'

/** One 啟用範本 × 適用廠區, with whether its 簽核流程 can be launched. */
export interface LaunchCandidate {
  template_id: string
  template_code: string
  template_name: string
  plant_id: string
  factory_code: string
  plant_name: string
  /** The 範本 × 廠區's route (one at most, Q137 (6)), or null when there is none. */
  route_id: string | null
  /** How many 關卡 the route has (0 without one). */
  step_count: number
  /** null＝can be launched; `no_route`＝no route; `not_ready`＝the route fails the 發起檢查; `no_coordinator`＝the plant has no 廠區管理員. */
  problem: 'no_route' | 'not_ready' | 'no_coordinator' | null
  /** The route's 發起檢查; null when there is no route. */
  launch_check: LaunchCheck | null
  /** The years this 範本 × 廠區 has been launched in; each year once (Q119). */
  launched_years: number[]
}

/** A launched 年度作業 and how many 自評表 it issued. */
export interface LaunchedCycle {
  year: number
  due_date: string
  assessments: number
}

export interface Combo {
  template_id: string
  plant_id: string
}

/** A 關卡 on a route whose 簽核人 OMS says is not 在職: the launch is refused until someone else is 分派 there (Q147 (4)). */
export interface DepartedSigner {
  template_id: string
  template_code: string
  template_name: string
  plant_id: string
  factory_code: string
  plant_name: string
  step_id: string
  /** The 關卡's name and 分流 (null＝匯流後). */
  step: string
  branch_unit_name: string | null
  /** 連動標記: a 連動關卡's 簽核人 is changed in 權限管理, not on the route. */
  link: string | null
  emp_id: string
  /** CSA's own copy of the name; null when CSA has never had it. */
  name: string | null
}

/** What a launch comes to: `launch_annual_cycle`'s answer. A refusal changes nothing. */
export type LaunchResult =
  | {
      ok: true
      cycle_id: string
      /** The year already had its 年度作業: these were added to it, with its 截止日. */
      top_up: boolean
      due_date: string
      assessments: number
      /** false when OMS did not answer: launched all the same, without checking who has left (Q147 (4)). */
      checked: boolean
    }
  | { ok: false; error: 'no_combos' }
  | { ok: false; error: 'already_launched'; launched: LaunchCandidate[] }
  | { ok: false; error: 'missing_route'; missing: LaunchCandidate[] }
  | { ok: false; error: 'invalid_combo'; invalid: unknown[] }
  | { ok: false; error: 'departed_signers'; departed: DepartedSigner[] }

/** Every candidate in 範本編號, 廠區代碼 order; empty for anyone but a 稽核管理者 (RLS). */
export async function fetchLaunchCandidates(): Promise<LaunchCandidate[]> {
  const { data, error } = await supabase.rpc('launch_candidates')
  if (error) throw error
  return data as LaunchCandidate[]
}

/** Every launched 年度作業, latest first. */
export async function fetchLaunchedCycles(): Promise<LaunchedCycle[]> {
  const { data, error } = await supabase
    .from('annual_cycle')
    .select('year,due_date,assessment(count)')
    .order('year', { ascending: false })
    .returns<{ year: number; due_date: string; assessment: { count: number }[] }[]>()
  if (error) throw error
  return data.map((c) => ({ year: c.year, due_date: c.due_date, assessments: c.assessment[0]?.count ?? 0 }))
}

/**
 * How many 工號 go to OMS's channel in one request: what the CSA backend lets a 稽核主管 ask at once (people_lookup_limit,
 * and the backend's MAX_LOOKUP). A whole year's routes take a few requests out of OMS's daily allowance.
 */
const LOOKUP_BATCH = 200

/** Of these 工號, the ones OMS says are not 在職; null when OMS could not answer (down, over its daily limit, key trouble). */
async function notEmployedOf(empIds: readonly string[]): Promise<string[] | null> {
  try {
    const left: string[] = []
    for (let i = 0; i < empIds.length; i += LOOKUP_BATCH) left.push(...notEmployed(await lookUpPeople(empIds.slice(i, i + LOOKUP_BATCH))))
    return left
  } catch (error) {
    // Only OMS not answering launches without the check; CSA refusing (not_allowed, too_many…) stops the launch.
    if (omsCouldNotAnswer(error)) return null
    throw error
  }
}

/**
 * Launches `year` for exactly these combinations, or tops it up when it already has its 年度作業 (then `dueDate` is
 * not used: one 截止日 a year). The database checks everything again and copies each route's 簽核人 onto the 自評表
 * (Q147). It cannot reach OMS, so the people those routes would put on the 自評表 are looked up here, once, and whoever
 * is not 在職 goes along: the database then refuses, naming them. With no answer from OMS it launches all the same,
 * unchecked, and says so (`checked`).
 */
export async function launchCycle(year: number, dueDate: string, combos: Combo[]): Promise<LaunchResult> {
  const signers = await supabase.rpc('launch_signers', { p_combos: combos })
  if (signers.error) throw signers.error
  const departed = await notEmployedOf(signers.data as string[])

  const { data, error } = await supabase.rpc('launch_annual_cycle', {
    p_year: year, p_due_date: dueDate, p_combos: combos, p_departed: departed ?? [], p_checked: departed !== null,
  })
  if (error) throw error
  return data as LaunchResult
}
