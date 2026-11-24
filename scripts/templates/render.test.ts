// 轉檔接縫 ②: 範本定義 → 種子 SQL（migration 檔）。純函式。
// SQL 文字本身不逐字比對；只驗兩件事：進版控的 JSON 與 SQL 帶的是同一份資料、
// 內容裡出現引號或 $ 也不會破壞 SQL。實際寫進資料庫的結果由 tests/db/template.rls.test.ts 驗。
import { describe, expect, it } from 'vitest'
import { renderSeedSql, seedSections, type TemplateDefinition } from './render.ts'

const DEFINITION: TemplateDefinition = {
  code: '02',
  name: '採購及付款循環',
  layout: 'control_activity',
  version: '1.0',
  status: 'active',
  allPlants: true,
  assessingUnits: ['資材單位', '財務單位'],
  sections: [
    {
      name: '付款作業',
      controlPoints: [
        { text: '支票是否序號控管？', assessingUnit: '財務單位' },
        { text: "O'Brien 的 $$ 單據是否「齊全」？", assessingUnit: '資材單位' },
      ],
    },
  ],
}

/** The JSON document embedded in the generated SQL. */
function embeddedJson(sql: string): unknown {
  const match = /\$csa_json\$(.*)\$csa_json\$/s.exec(sql)
  if (!match) throw new Error('no embedded JSON found')
  return JSON.parse(match[1]!)
}

describe('renderSeedSql', () => {
  it('embeds exactly the definition, quotes and dollar signs included', () => {
    expect(embeddedJson(renderSeedSql(DEFINITION))).toEqual(DEFINITION)
  })

  it('refuses text that would close the dollar-quoted literal', () => {
    const bad = structuredClone(DEFINITION)
    bad.sections[0]!.controlPoints[0]!.text = 'x $csa_json$ drop table employee_ref; --'
    expect(() => renderSeedSql(bad)).toThrow(/csa_json/)
  })

  it('is deterministic, so re-running the conversion produces no diff', () => {
    expect(renderSeedSql(DEFINITION)).toBe(renderSeedSql(structuredClone(DEFINITION)))
  })
})

describe('seedSections', () => {
  // 02 的種子 migration 早已套用，格式不能變（一題一個 assessingUnit）；02 沒有一題多單位，有的話要改走草稿途徑。
  it('keeps the seed migration’s one 自評單位 per control point', () => {
    expect(seedSections([{ name: '付款作業', controlPoints: [{ text: '支票是否序號控管？', assessingUnits: ['財務單位'] }] }])).toEqual([
      { name: '付款作業', controlPoints: [{ text: '支票是否序號控管？', assessingUnit: '財務單位' }] },
    ])
  })

  it('refuses a multi-unit control point instead of dropping a unit', () => {
    expect(() => seedSections([{ name: '物料標示', controlPoints: [{ text: '製程？', assessingUnits: ['品保單位', '生產單位'] }] }])).toThrow(/製程？/)
  })
})
