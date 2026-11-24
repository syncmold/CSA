// 呈現用純函式 for 首頁 (Q115): the 我的自評表 tabs and the 各廠填單進度 card. Whose turn it is, whether a 關卡 answers or
// signs, how many questions are answered and how many days are left all come from the database (views my_assessment and
// tracking_assessment); these only sort the rows into tabs and counts and pick a word or a colour.
import type { MyAssessment } from '../api/myAssessmentsQuery'
import type { TrackingRow } from '../api/trackingQuery'
import { closedCount, plantOptions, type PlantOption } from './tracking'

/**
 * 待處理 and 我參與的, in this order on screen. 待處理 holds both what the employee fills in and what they sign: either
 * way they open the 自評表 and act on it, and the row's button says which (使用者 2026-10-30, replacing Q115 (1)'s 待填寫
 * and 待簽核 tabs).
 */
export type MyTab = 'todo' | 'all'
export const MY_TABS: readonly MyTab[] = ['todo', 'all']

export type MyTabs = Record<MyTab, MyAssessment[]>

/** Whether it is the employee's turn on a 自評表, to fill in their part or to sign. */
export const isMyTurn = (row: Pick<MyAssessment, 'my_part'>) => row.my_part === 'fill' || row.my_part === 'sign'

/** The rows of each tab, in the database's order; 我參與的 has all of them. */
export function myTabs(rows: readonly MyAssessment[]): MyTabs {
  return { todo: rows.filter(isMyTurn), all: [...rows] }
}

/** The tab the page opens on: 待處理, or 我參與的 when nothing waits (待處理 when both are empty). */
export function firstTab(tabs: MyTabs): MyTab {
  return MY_TABS.find((tab) => tabs[tab].length > 0) ?? 'todo'
}

/**
 * From this many days before the 截止日 a row is marked as close (orange); a stand-in until it is decided (Q115 (3)), so
 * settling it is this one change.
 */
export const DUE_SOON_DAYS = 7

/** `overdue`: the 截止日 has passed (red 逾期 n 天); `soon`: within DUE_SOON_DAYS (orange n 天後); null: neither. */
export type DueLevel = 'overdue' | 'soon' | null

export function dueLevel(dueInDays: number, soonDays = DUE_SOON_DAYS): DueLevel {
  return dueInDays < 0 ? 'overdue' : dueInDays <= soonDays ? 'soon' : null
}

/** A 待處理 row's button: 開始填寫 until their part has been touched (my_started), then 繼續填寫; 前往簽核 to sign. */
export type TodoAction = 'start' | 'continue' | 'sign'

export function todoAction(row: Pick<MyAssessment, 'my_part' | 'my_started'>): TodoAction {
  if (row.my_part !== 'fill') return 'sign'
  return row.my_started ? 'continue' : 'start'
}

/** 我的填寫進度 gets a column only when something in 待處理 is to be filled in; rows to sign leave it empty. */
export const showsFillProgress = (rows: readonly Pick<MyAssessment, 'my_part'>[]) => rows.some((r) => r.my_part === 'fill')

/** 我參與的's 狀態: 等我處理 (fill or sign), 尚未輪到我, 我的部分已完成, or 已結案. */
export type MyStatus = 'my_turn' | 'upcoming' | 'done' | 'closed'

export function myStatus(row: Pick<MyAssessment, 'my_part' | 'status'>): MyStatus {
  if (isMyTurn(row)) return 'my_turn'
  if (row.my_part === 'upcoming') return 'upcoming'
  return row.status === 'closed' ? 'closed' : 'done'
}

/** How many of one 年度's 自評表 are 填寫中, 簽核中 and 結案. */
export interface StageCounts {
  filling: number
  signing: number
  closed: number
  total: number
}

export interface PlantProgress extends PlantOption, StageCounts {}

export interface PlantsProgress {
  total: StageCounts
  /** One per 廠區 the rows have, in the rows' order (公司 → 廠區 from the database, as on 追蹤總覽). */
  plants: PlantProgress[]
  /** 填寫中 past their 截止日, the most overdue first. */
  overdueFilling: TrackingRow[]
}

function stageCounts(rows: readonly TrackingRow[]): StageCounts {
  const { closed, total } = closedCount(rows)
  return { filling: rows.filter((r) => r.stage === 'filling').length, signing: rows.filter((r) => r.stage === 'signing').length, closed, total }
}

/** 各廠填單進度 (Q115 (4)): one 年度's 追蹤總覽 rows counted as a whole and per 廠區. */
export function plantsProgress(rows: readonly TrackingRow[]): PlantsProgress {
  return {
    total: stageCounts(rows),
    plants: plantOptions([...rows], null).map((p) => ({ ...p, ...stageCounts(rows.filter((r) => r.plant_id === p.id)) })),
    overdueFilling: rows.filter((r) => r.stage === 'filling' && r.due_in_days < 0).sort((a, b) => a.due_in_days - b.due_in_days),
  }
}
