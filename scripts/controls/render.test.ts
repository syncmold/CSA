// 內控文件轉檔接縫 ②: 解析出的內控文件＋內控依據對照（Q38） → 種子 migration。
// 對照檔寫的是畫面上看得到的簡碼（「PR01 §6.1」），轉檔時先確認每一條都找得到，免得種子默默少了依據。
import { describe, expect, it } from 'vitest'
import { checkReferences, parseReference, renderControlSeedSql, type ControlDocumentSeed, type ReferenceMapping } from './render.ts'

const PR01: ControlDocumentSeed = {
  number: 'FQQP-PR01',
  code: 'PR01',
  name: '供應商管理作業',
  version: '2.0',
  effectiveDate: '2021-07-01',
  pdfFile: 'FQQP-PR01_2.0.pdf',
  clauses: [
    { number: '6', text: '控制重點' },
    { number: '6.1', text: '盡可能由兩家以上之廠商供應。' },
  ],
}

const mapping = (references: string[], documents = ['PR01']): ReferenceMapping => ({
  template: { code: '02', version: '1.0' },
  factoryCode: 'FQ',
  sections: [
    {
      position: 1,
      name: '供應商管理作業',
      documents,
      controlPoints: [{ position: 1, text: '原物料是否由兩家以上之廠商供應？', references }],
    },
  ],
})

describe('parseReference', () => {
  it('reads a short code as written on the page', () => {
    expect(parseReference('PR01 §6.1')).toEqual({ document: 'PR01', clause: '6.1' })
    expect(parseReference('PR08 §5.3')).toEqual({ document: 'PR08', clause: '5.3' })
  })

  it('rejects anything else', () => {
    expect(() => parseReference('PR01 6.1')).toThrow(/PR01 6\.1/)
  })
})

describe('checkReferences', () => {
  it('passes when every reference and section document is one of the converted documents', () => {
    expect(checkReferences([PR01], mapping(['PR01 §6.1']))).toEqual([])
  })

  it('lists references to a clause the document does not have, and documents that were not converted', () => {
    expect(checkReferences([PR01], mapping(['PR01 §6.9', 'PR02 §6.1'], ['PR01', 'PR03']))).toEqual([
      '1. 供應商管理作業 的本章依據 PR03 不是轉檔的內控文件',
      '1.1 的內控依據 PR01 §6.9：PR01 沒有第 6.9 條',
      '1.1 的內控依據 PR02 §6.1：PR02 不是轉檔的內控文件',
    ])
  })
})

describe('renderControlSeedSql', () => {
  it('carries the documents and the mapping as data the SQL expands', () => {
    const sql = renderControlSeedSql([PR01], mapping(['PR01 §6.1']))

    const literals = [...sql.matchAll(/\$csa_json\$([\s\S]*?)\$csa_json\$/g)].map((m) => JSON.parse(m[1]!))
    // The SQL gets each 內控依據 already split into document and clause, so it never parses the short code itself.
    const seeded = mapping([])
    seeded.sections[0]!.controlPoints[0]!.references = [{ document: 'PR01', clause: '6.1' }] as never
    expect(literals).toEqual([[PR01], seeded])
  })

  it('refuses text that would end the dollar-quoted literal early', () => {
    const bad = { ...PR01, clauses: [{ number: '6', text: '$csa_json$' }] }

    expect(() => renderControlSeedSql([bad], mapping([]))).toThrow(/\$csa_json\$/)
  })
})
