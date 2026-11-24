// 轉檔接縫 ①½: 原檔的自評單位寫法 → 系統名稱。純函式。
import { describe, expect, it } from 'vitest'
import type { ParsedTemplateBody } from './parse.ts'
import { mapAssessingUnits } from './units.ts'

const body = (...points: string[][]): ParsedTemplateBody => ({
  sections: [{ name: '付款作業', controlPoints: points.map((units, i) => ({ text: `第 ${i + 1} 題？`, assessingUnits: units })) }],
  assessingUnits: [...new Set(points.flat())],
})

describe('mapAssessingUnits', () => {
  it('renames listed units and keeps the others as written', () => {
    expect(mapAssessingUnits(body(['財務單位'], ['資材單位', '環安室']), { 財務單位: '財會單位', 環安室: '環安單位' })).toEqual({
      sections: [
        {
          name: '付款作業',
          controlPoints: [
            { text: '第 1 題？', assessingUnits: ['財會單位'] },
            { text: '第 2 題？', assessingUnits: ['資材單位', '環安單位'] },
          ],
        },
      ],
      assessingUnits: ['財會單位', '資材單位', '環安單位'],
    })
  })

  it('splits one cell naming two units into both, in the written order', () => {
    const mapped = mapAssessingUnits(body(['業務部、工程部']), { '業務部、工程部': ['業務單位', '工程單位'] })
    expect(mapped.sections[0]!.controlPoints[0]!.assessingUnits).toEqual(['業務單位', '工程單位'])
    expect(mapped.assessingUnits).toEqual(['業務單位', '工程單位'])
  })

  it('lists the template units once, in first-appearance order after mapping', () => {
    expect(mapAssessingUnits(body(['品保部'], ['品保單位'], ['管理部']), { 品保部: '品保單位', 管理部: '管理單位' }).assessingUnits).toEqual([
      '品保單位',
      '管理單位',
    ])
  })

  it('rejects a control point that would answer twice as the same unit', () => {
    expect(() => mapAssessingUnits(body(['品保部', '品保單位']), { 品保部: '品保單位' })).toThrow('重複出現自評單位「品保單位」')
  })

  it('does not treat object built-ins as mappings', () => {
    expect(mapAssessingUnits(body(['constructor']), {}).assessingUnits).toEqual(['constructor'])
  })
})
