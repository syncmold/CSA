// 呈現用純函式 for 問卷範本 (技術選型 §5: src/domain/ holds pure presentation logic shared by pages).
import type { TFunction } from 'i18next'
import type { TemplateComponent, TemplateLayout, TemplateSectionRow, TemplateSummary } from '../api/templates'
import { errorText } from './errors'
import type { ShownSection } from './outline'

/** The five 組成要素 in the order of 處理準則第 6 條 (#62). */
export const COMPONENTS: readonly TemplateComponent[] = [
  'control_environment',
  'risk_assessment',
  'control_activities',
  'information_communication',
  'monitoring',
]

/** The four a 要素類 template may belong to; 控制活動類 is always control_activities. */
export const ELEMENT_COMPONENTS = COMPONENTS.filter((c) => c !== 'control_activities')

/** A 組成要素 as the screens name it: the key under templates.components and in `?component=`; 未分類 included. */
export type ComponentKey = TemplateComponent | 'unclassified'

/** The key under templates.components / templates.componentHeadings; null is 未分類. */
export function componentKey(component: TemplateComponent | null): ComponentKey {
  return component ?? 'unclassified'
}

/**
 * A list page (範本管理 or 流程編輯器) opened on the 組成要素 an item belongs to, so the breadcrumb and the
 * page after a delete land where the user came from (#66); a 簽核流程 also on its 廠區 (#85).
 */
export function listPathFor(listPath: string, component: TemplateComponent | null, plant?: string): string {
  const params = new URLSearchParams({ component: componentKey(component) })
  if (plant) params.set('plant', plant)
  return `${listPath}?${params}`
}

/**
 * What the 範本抬頭 form offers for the 組成要素, and the hint under it (a key under templates.). A new
 * template picks any of the five and the database derives the 版型 from it (Q101(6)); afterwards the 版型
 * is fixed, so a 控制作業 template stays put and the others move only among their four.
 */
export function componentChoices(existingLayout?: TemplateLayout): { choices: readonly TemplateComponent[]; hint: string } {
  if (!existingLayout) return { choices: COMPONENTS, hint: 'componentChoiceHint' }
  return existingLayout === 'control_activity'
    ? { choices: ['control_activities'], hint: 'componentFixedControl' }
    : { choices: ELEMENT_COMPONENTS, hint: 'componentFixedElement' }
}

export interface ComponentGroup<T> {
  /** null＝未分類：a 要素類 template nobody has classified yet. */
  component: TemplateComponent | null
  rows: T[]
}

/**
 * 範本管理 and 流程編輯器 list rows under the five 組成要素, in the 準則's order and keeping the rows'
 * own order inside each group. All five groups are always there (they are fixed by law), even when
 * empty; 未分類 is added last only when some row has no component.
 */
export function groupByComponent<T>(rows: readonly T[], componentOf: (row: T) => TemplateComponent | null): ComponentGroup<T>[] {
  const groups: ComponentGroup<T>[] = COMPONENTS.map((component) => ({ component, rows: rows.filter((r) => componentOf(r) === component) }))
  const unclassified = rows.filter((r) => componentOf(r) === null)
  return unclassified.length ? [...groups, { component: null, rows: unclassified }] : groups
}

/** 全部: every row, in the five groups' order. Not a 組成要素, a way to look at all of them. */
export const ALL_VIEW = 'all'

/** What a list page shows: one 組成要素, or 全部. */
export type ComponentView = ComponentKey | typeof ALL_VIEW

/**
 * Which group the list shows (#66, Q106): the one asked for in the URL if the list has it (全部 always), otherwise the
 * first 組成要素 that has rows, otherwise the first of the five. 未分類 counts as present only when it has rows.
 * 全部 is never the default: the page opens on a 組成要素.
 */
export function pickView<T>(groups: readonly ComponentGroup<T>[], requested: string | null): ComponentView {
  if (requested === ALL_VIEW) return ALL_VIEW
  const asked = groups.map((g) => componentKey(g.component)).find((key) => key === requested)
  return asked ?? componentKey((groups.find((g) => g.rows.length) ?? groups[0])?.component ?? COMPONENTS[0]!)
}

/** The rows a view lists. */
export function rowsOfView<T>(groups: readonly ComponentGroup<T>[], view: ComponentView): T[] {
  return view === ALL_VIEW ? groups.flatMap((g) => g.rows) : (groups.find((g) => componentKey(g.component) === view)?.rows ?? [])
}

/**
 * 控制活動類 control points must name a 自評單位; on 要素類 it is optional (the paper has no such
 * column, but one unit can be given to the whole template so one 自行檢查人員 answers it, #5).
 * The database enforces the same rule (Q83).
 */
export function unitRequired(layout: TemplateLayout): boolean {
  return layout === 'control_activity'
}

/** 適用廠區 as shown in the list and the detail header. */
export function applicablePlantsLabel(t: TFunction, row: Pick<TemplateSummary, 'all_plants' | 'template_plant'>): string {
  if (row.all_plants) return t('templates.allPlants')
  return row.template_plant.map((p) => p.factory_code).sort().join('、') || t('templates.noPlants')
}

/**
 * Drag-and-drop result: `moved` takes the place of `target` and everything in between shifts by one,
 * so dropping onto a later row puts it after that row and onto an earlier row puts it before.
 */
export function moveId(ids: readonly string[], moved: string, target: string): string[] {
  const to = ids.indexOf(target)
  if (moved === target || to < 0 || !ids.includes(moved)) return [...ids]
  const rest = ids.filter((id) => id !== moved)
  rest.splice(to, 0, moved)
  return rest
}

/** Rows put into `ids` order with positions renumbered 1..n, for showing a reorder before the database confirms it. */
export function applyOrder<T extends { id: string; position: number }>(rows: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.flatMap((id, i) => {
    const row = byId.get(id)
    return row ? [{ ...row, position: i + 1 }] : []
  })
}

/**
 * Postgres error codes the 範本管理 writes can come back with, mapped to the message keys under templates.errors.
 * The keys name the common namespace so a page translating with its own namespace (flows, launch…) still finds them.
 */
const ERROR_KEYS: Record<string, string> = {
  '23505': 'common:templates.errors.duplicate',
  '23503': 'common:templates.errors.inUse',
  '23514': 'common:templates.errors.unitRule',
  '42501': 'common:templates.errors.forbidden',
  '22023': 'common:templates.errors.stale',
}

/** What to tell the 稽核管理者 when a write fails; `overrides` gives a more specific key per code. */
export function writeErrorMessage(t: TFunction, error: unknown, overrides: Record<string, string> = {}): string {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
  const key = overrides[code] ?? ERROR_KEYS[code]
  if (key) return t(key)
  return t('common:templates.errors.generic', { message: errorText(error) })
}

/** How many 控制要點 a template has across all its sections. */
export function controlPointCount(tpl: { template_section: { control_point: unknown[] }[] }): number {
  return tpl.template_section.reduce((n, s) => n + s.control_point.length, 0)
}

/** The 範本管理 list hides 停用 templates unless asked to show them (#31). */
export function visibleTemplates<T extends Pick<TemplateSummary, 'status'>>(rows: readonly T[], showInactive: boolean): T[] {
  return showInactive ? [...rows] : rows.filter((r) => r.status !== 'inactive')
}

/**
 * Deleting a template asks the 稽核管理者 to type a phrase such as 「刪除 02」 first. Runs of spaces
 * (half- or full-width) count as one, surrounding spaces do not count, and neither does letter case
 * (「Delete 02」 matches the English 「delete 02」).
 */
export function confirmPhraseMatches(typed: string, phrase: string): boolean {
  const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  return normalize(typed) === normalize(phrase)
}

/** A template's sections as the read-only page shows them, the same shape as an issued 自評表's (#173). */
export function shownSections(sections: readonly TemplateSectionRow[]): ShownSection[] {
  return sections.map((s) => ({
    id: s.id,
    level: s.level,
    code: s.code,
    name: s.name,
    points: s.control_point.map((p) => ({ id: p.id, code: p.code, text: p.text, units: p.control_point_unit.map((u) => u.assessing_unit.name) })),
  }))
}
