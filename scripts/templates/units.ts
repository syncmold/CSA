// 轉檔 ①½: 原檔的自評單位寫法 → 系統的自評單位名稱（#84，Q111）。
// 各廠寫法不同（管理部／管理單位…），轉成集團共用清單上的同一個名稱；對應表登錄在 sources.mjs。
import type { ParsedTemplateBody } from './parse.ts'

/** 原檔寫法 → 系統名稱。一格寫了兩個單位（「業務部、工程部」）時對應到多個，依寫的順序。沒列的照原檔。 */
export type UnitMapping = Record<string, string | string[]>

/**
 * 依對應表換掉每個控制要點的自評單位，整份的單位清單依第一次出現的順序重算。
 * 換完同一題出現兩次同一個單位就丟錯：資料庫也不收（Q92），而且多半是對應表把兩個不同的單位併在一起了。
 */
export function mapAssessingUnits(body: ParsedTemplateBody, mapping: UnitMapping): ParsedTemplateBody {
  const assessingUnits: string[] = []
  const sections = body.sections.map((s) => ({
    ...s,
    controlPoints: s.controlPoints.map((p) => {
      const units = p.assessingUnits.flatMap((u) => (Object.hasOwn(mapping, u) ? mapping[u]! : u))
      const repeated = units.find((u, i) => units.indexOf(u) !== i)
      if (repeated) throw new Error(`控制要點「${p.text}」換算後重複出現自評單位「${repeated}」（原檔：${p.assessingUnits.join('、')}）`)
      for (const u of units) if (!assessingUnits.includes(u)) assessingUnits.push(u)
      return { ...p, assessingUnits: units }
    }),
  }))
  return { sections, assessingUnits }
}
