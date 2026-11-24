// 範本管理先選廠區（#84 第三段，B2；Q111 (4)）。每廠一份範本，所以清單先選廠區，再照舊依組成要素分頁。
// 簽核流程（#85）用同一組廠區按鈕與同一個選擇。
import type { TemplateComponent } from '../api/templates'
import { ALL_VIEW, componentKey } from './templates'

/** 不掛廠區的範本沒有廠區代碼可選，以這個鍵另成一項（samoa 原本在這裡，Q139 起掛「其他廠區」）。 */
export const NO_PLANT = 'none'

/**
 * CSA 自己的廠區「其他廠區」（Q139）：OMS 沒有的單位（samoa）掛在這裡。OMS 沒有屬於它的員工：分派和別的廠區一樣，從表上
 * 排過的人選或輸入工號（#218），匯入分派表的比對在這個廠區找得到的在職人員都算對得上。代碼寫在這裡、20261208000000 的
 * migration 與 exchange/omsChannel.ts 的 ANY_PLANT_CODES（exchange 不引用 app 的程式），改名要三處一起改。
 */
export const OTHER_PLANT = 'OTHER'

export interface PlantOption {
  /** OMS 廠區代碼，或 NO_PLANT。 */
  key: string
  code: string
  name: string
}

interface PlantScoped {
  all_plants: boolean
  template_plant: { factory_code: string }[]
}

/** 這份範本適用的廠區代碼；所有廠區適用的回 null。 */
function plantsOf(row: PlantScoped): string[] | null {
  return row.all_plants ? null : row.template_plant.map((p) => p.factory_code)
}

/** 範本適不適用這個廠區（OMS 廠區代碼）：所有廠區適用的一定適用。 */
export function appliesTo(row: PlantScoped, plant: string): boolean {
  const plants = plantsOf(row)
  return plants === null || plants.includes(plant)
}

/** 選中廠區要列的範本：適用這個廠區的（含所有廠區適用的）；NO_PLANT 列沒有任何適用廠區的。 */
export function rowsOfPlant<T extends PlantScoped>(rows: readonly T[], plant: string): T[] {
  return rows.filter((row) => (plant === NO_PLANT ? plantsOf(row)?.length === 0 : appliesTo(row, plant)))
}

/**
 * 範本自己的廠區，範本頁的麵包屑回清單時停在這裡（#85）：只適用一個廠區的回那個代碼，不掛廠區的回 NO_PLANT；適用好幾個
 * 或所有廠區的回 undefined，清單照舊停在上次的廠區。
 */
export function ownPlantOf(row: PlantScoped): string | undefined {
  const plants = plantsOf(row)
  if (plants === null || plants.length > 1) return undefined
  return plants[0] ?? NO_PLANT
}

/**
 * 廠區按鈕：廠區主檔的每個廠區；範本掛了主檔沒有的廠區代碼（適用廠區可以手打，Q81）也各一個，只寫代碼，免得那些範本
 * 在清單上找不到；再加上有不掛廠區的範本時的「未指定廠區」。
 */
export function plantOptions(plants: readonly { factory_code: string; name: string }[], rows: readonly PlantScoped[], noPlantName: string): PlantOption[] {
  const options: PlantOption[] = plants.map((p) => ({ key: p.factory_code, code: p.factory_code, name: p.name }))
  const known = new Set(options.map((o) => o.key))
  const unknown = [...new Set(rows.flatMap((row) => plantsOf(row) ?? []))].filter((code) => !known.has(code)).sort()
  options.push(...unknown.map((code) => ({ key: code, code, name: '' })))
  return rowsOfPlant(rows, NO_PLANT).length ? [...options, { key: NO_PLANT, code: '', name: noPlantName }] : options
}

/**
 * 選哪個廠區：網址指定的（清單有的話）、否則這個瀏覽器上次選的（範本管理與簽核流程共用）、否則第一個。
 * 沒有任何廠區可選時回 null，清單就不分廠區。
 */
export function pickPlant(options: readonly PlantOption[], requested: string | null, remembered: string | null): string | null {
  const has = (key: string | null) => key !== null && options.some((o) => o.key === key)
  if (has(requested)) return requested
  if (has(remembered)) return remembered
  return options[0]?.key ?? null
}

/**
 * 內容相同的其他廠區（Q111 (4)）：題目與自評單位完全相同（content_fingerprint 一樣）的範本適用的廠區，不含選中的
 * 廠區，依代碼排序。同一份範本適用好幾個廠區的（測試環境的 FQ- 範本），那些廠區本來就是同一份內容，也列出來。
 * 還沒有任何內容的範本沒有指紋（null），不和誰相同；停用的範本不算（舊版內容相同，不代表那個廠現在相同）。每廠各一份
 * 範本、互不影響，這只是參考：稽核部要統一修改同一題時，看得出還有哪些廠要一起改。依指紋先分好組（一次），每列查表。
 */
export function sameContentIndex(
  rows: readonly (PlantScoped & { content_fingerprint: string | null; status: string })[],
): (row: { content_fingerprint: string | null }, plant: string) => string[] {
  const plantsByContent = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.content_fingerprint === null || row.status === 'inactive') continue
    const codes = plantsByContent.get(row.content_fingerprint) ?? new Set<string>()
    for (const code of plantsOf(row) ?? []) codes.add(code)
    plantsByContent.set(row.content_fingerprint, codes)
  }
  return (row, plant) => {
    if (row.content_fingerprint === null) return []
    return [...(plantsByContent.get(row.content_fingerprint) ?? [])].filter((code) => code !== plant).sort()
  }
}

/**
 * 換廠區時能不能留在目前的分頁（`?component=`）：新廠區在這一類有範本、或是「全部」、或還沒選分頁。不能的話清單
 * 改停在新廠區第一個有範本的組成要素（samoa 只有控制作業）。
 */
export function hasRowsInView(rows: readonly { component: TemplateComponent | null }[], view: string | null): boolean {
  return view === null || view === ALL_VIEW || rows.some((row) => componentKey(row.component) === view)
}

/** 廠區按鈕與清單上方那一行的寫法：「GT 敬得(觀音)」；主檔沒有的代碼只寫代碼，「未指定廠區」只寫名稱。 */
export function plantLabel(option: PlantOption): string {
  return [option.code, option.name].filter(Boolean).join(' ')
}

/**
 * 換廠區時網址的分頁要不要清掉：新廠區在目前分頁有看得到的列（範本或流程；`rows` 是新廠區的列，停用的範本只在
 * `?inactive=1` 時看得到，流程沒有狀態）就留著，各廠可以對照；沒有就清掉，清單改停在它第一個有內容的組成要素（samoa 只有控制作業）。
 * 回傳對網址的修改，看的是寫入當下的網址：畫面可能還沒跟上剛點的分頁或停用開關（#85，CI 上重現過）。
 */
export function viewAfterPlantChange(rows: readonly { component: TemplateComponent | null; status?: string }[]): (params: URLSearchParams) => void {
  return (params) => {
    const visible = params.get('inactive') === '1' ? rows : rows.filter((row) => row.status !== 'inactive')
    if (!hasRowsInView(visible, params.get('component'))) params.delete('component')
  }
}
