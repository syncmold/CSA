// 內控文件轉檔接縫 ①: Word 原檔的全文（extract-doc.ps1 以 ConvertNumbersToText 後的 Content.Text）→ 版次與條文。
// Fixture 的字元結構取自福清 PR01、PR02、PR04 原檔實際讀出的文字：段落以 \r 分隔、表格的每一格以 \r\x07 結束、
// 條號與內文之間是 Tab；首頁是「文件改廢履歷表」（版次、文件編號、實施日期…）。
import { describe, expect, it } from 'vitest'
import { parseControlDocument, parseDocumentFileName } from './parse.ts'

/** Word 表格：每格以 \r\x07 結束，每列最後多一個 \r\x07。 */
const table = (rows: string[][]) => rows.map((cells) => cells.map((c) => `${c}\r\x07`).join('') + '\r\x07').join('')

const REVISIONS = table([
  ['文 件 名 稱', '請採購作業'],
  ['版本\r版次', '文件編號', '實施日期', '頁次', '制定內容/修訂內容/廢止紀錄'],
  ['1.0', 'FQQP-PR02', '2019.02.15', '全部', '配合集團文件編碼及格式要求，重新制訂發行'],
])

const BODY = [
  '1.\t目的',
  '1.1\t確立各項請、採購作業流程。',
  '',
  '5.\t作業內容',
  '5.1\t原材料、原物料之請採購（流程圖：詳6/10頁）',
  '5.1.1\t原材料（鋁合金及鋅合金）之請採購',
  '5.1.1.1\t生管須於每個月初計算【月末預估庫存量】。',
  '5.2\t消耗品之請採購',
  '',
  '6.\t控制重點',
  '6.1\t對生管發出的生產制令了解查實物料庫存情況。',
  '6.2\t請購應依實際需求提出申請，並經權責主管核准。',
  '',
  '7.\t參考資料',
  '7.1\t供應商管理作業\t\t\tFQQP-PR01',
  '8.\t使用表單',
].join('\r')

describe('parseControlDocument', () => {
  it('reads the clauses of 5 作業內容 and 6 控制重點, numbers and text, in document order', () => {
    const doc = parseControlDocument(`${REVISIONS}${BODY}`, 'FQQP-PR02')

    expect(doc.clauses).toEqual([
      { number: '5', text: '作業內容' },
      { number: '5.1', text: '原材料、原物料之請採購（流程圖：詳6/10頁）' },
      { number: '5.1.1', text: '原材料（鋁合金及鋅合金）之請採購' },
      { number: '5.1.1.1', text: '生管須於每個月初計算【月末預估庫存量】。' },
      { number: '5.2', text: '消耗品之請採購' },
      { number: '6', text: '控制重點' },
      { number: '6.1', text: '對生管發出的生產制令了解查實物料庫存情況。' },
      { number: '6.2', text: '請購應依實際需求提出申請，並經權責主管核准。' },
    ])
  })

  it('takes the version and effective date from the latest row of the 文件改廢履歷表 for this document', () => {
    const revisions = table([
      ['版本\r版次', '文件編號', '實施日期', '頁次', '制定內容/修訂內容/廢止紀錄'],
      ['1.0', 'FQQP-PR01', '2019.02.15', '全部', '重新制訂發行。'],
      ['1.1', 'FQQP-PR01', '2020.01.01', '1/4', '依台北要求於5.2新增「保密契約」。'],
      ['B', 'FQQR-PR01-203', '2020.01.01', '依台北要求修改表單。'],
      ['2.0版', 'FQQP-PR01', '2021.07.01', '全部', '整合優化集團供應商管理作業程序。'],
      ['B版', 'FQQR-PR01-201', '2021.07.01', '調整表單順序。'],
    ])

    const doc = parseControlDocument(`${revisions}${BODY}`, 'FQQP-PR01')

    expect(doc.version).toEqual({ version: '2.0', effectiveDate: '2021-07-01' })
  })

  it('fails when the 文件改廢履歷表 has no row for the document', () => {
    expect(() => parseControlDocument(`${REVISIONS}${BODY}`, 'FQQP-PR09')).toThrow(/FQQP-PR09/)
  })

  it('keeps unnumbered paragraphs under the clause above them, tabs as spaces', () => {
    const body = [
      '5.\t作業內容',
      '5.2.7\t書面評鑑',
      '採購單位提出「供應商初期評鑑表」交供應商自評。',
      '5.8.2.2\t免評鑑/稽核',
      'A.\t免評鑑之條件',
      'a.\tC類/D類供應商得免於評鑑。',
      '6.\t控制重點',
    ].join('\r')

    expect(parseControlDocument(`${REVISIONS}${body}`, 'FQQP-PR02').clauses).toEqual([
      { number: '5', text: '作業內容' },
      { number: '5.2.7', text: '書面評鑑\n採購單位提出「供應商初期評鑑表」交供應商自評。' },
      { number: '5.8.2.2', text: '免評鑑/稽核\nA. 免評鑑之條件\na. C類/D類供應商得免於評鑑。' },
      { number: '6', text: '控制重點' },
    ])
  })

  it('stands in for a table inside a clause with a note pointing to the document, once per table', () => {
    const body =
      ['5.\t作業內容', '5.4\t新供應商評分基準及處置對策', '初期評鑑得分(%)'].join('\r') +
      '\r\x07' +
      table([['等級', '處 置 對 策'], ['91- 100', 'A', '直接納入合格供應商名冊。']]) +
      ['5.5\t登錄合格供應商', '6.\t控制重點'].join('\r')

    expect(parseControlDocument(`${REVISIONS}${body}`, 'FQQP-PR02').clauses).toEqual([
      { number: '5', text: '作業內容' },
      { number: '5.4', text: '新供應商評分基準及處置對策\n（表格見內控文件）' },
      { number: '5.5', text: '登錄合格供應商' },
      { number: '6', text: '控制重點' },
    ])
  })

  it('keeps every paragraph of a multi-paragraph table cell out of the clause text (PR02 5.6.3)', () => {
    const body =
      ['5.\t作業內容', '5.6.3\t各類採購權限核決流程，詳見下表', '性質'].join('\r') +
      '\r\x07' +
      table([['子公司\r經理人', '總   公   司'], ['固定資產請購\r雜項設備請購\r特殊交易事項','高於RMB   10,000元']]) +
      ['6.\t控制重點', '6.1\t請購應經核准。'].join('\r')

    expect(parseControlDocument(`${REVISIONS}${body}`, 'FQQP-PR02').clauses).toEqual([
      { number: '5', text: '作業內容' },
      { number: '5.6.3', text: '各類採購權限核決流程，詳見下表\n（表格見內控文件）' },
      { number: '6', text: '控制重點' },
      { number: '6.1', text: '請購應經核准。' },
    ])
  })

  it('fails on an unnumbered paragraph after a table instead of dropping it from the clause', () => {
    const body =
      ['5.\t作業內容', '5.4\t新供應商評分基準', '初期評鑑得分(%)'].join('\r') +
      '\r\x07' +
      table([['等級', '處 置 對 策']]) +
      ['※ 以上屬A/B類之供應商另依集團規定辦理。', '6.\t控制重點'].join('\r')

    expect(() => parseControlDocument(`${REVISIONS}${body}`, 'FQQP-PR02')).toThrow(/5\.4.*※ 以上屬A\/B類/)
  })

  it('splits a clause the original runs into the previous paragraph (PR01 5.8.1.1／5.8.1.2)', () => {
    const body = ['5.\t作業內容', '5.8.1.1\t於次季度首月10日前完成。5.8.1.2\t免評鑑/稽核條件比照5.8.2.2。', '6.\t控制重點'].join('\r')

    expect(parseControlDocument(`${REVISIONS}${body}`, 'FQQP-PR02').clauses).toEqual([
      { number: '5', text: '作業內容' },
      { number: '5.8.1.1', text: '於次季度首月10日前完成。' },
      { number: '5.8.1.2', text: '免評鑑/稽核條件比照5.8.2.2。' },
      { number: '6', text: '控制重點' },
    ])
  })

  it('drops page breaks: inside a sentence they vanish, before a clause number they start a paragraph', () => {
    const body = ['5.\t作業內容', '5.3\t避免造成不利影\x0c響：', '5.3.1\t供應商誠實信用合約。\x0c5.3.2\t保密契約。', '1.1.1.1\t', '6.\t控制重點'].join('\r')

    expect(parseControlDocument(`${REVISIONS}${body}`, 'FQQP-PR02').clauses).toEqual([
      { number: '5', text: '作業內容' },
      { number: '5.3', text: '避免造成不利影響：' },
      { number: '5.3.1', text: '供應商誠實信用合約。' },
      { number: '5.3.2', text: '保密契約。' },
      { number: '6', text: '控制重點' },
    ])
  })

  it('stops at section 7, so forms appended after the procedure are not read as clauses', () => {
    const body = [BODY, '5\t送貨時請務必在貴司之送貨單上注明本訂單編號'].join('\r')

    expect(parseControlDocument(`${REVISIONS}${body}`, 'FQQP-PR02').clauses.map((c) => c.number)).toEqual([
      '5', '5.1', '5.1.1', '5.1.1.1', '5.2', '6', '6.1', '6.2',
    ])
  })

  it('fails on a clause number that appears twice', () => {
    const body = ['5.\t作業內容', '5.1\t甲', '5.1\t乙', '6.\t控制重點'].join('\r')

    expect(() => parseControlDocument(`${REVISIONS}${body}`, 'FQQP-PR02')).toThrow(/5\.1/)
  })
})

describe('parseDocumentFileName', () => {
  it('reads the document number, short code, name and version from the original file name', () => {
    expect(parseDocumentFileName('FQQP-PR01供應商管理作業_(2.0版)_2021.07.01_整合優化集團供應商管理作業程序.doc')).toEqual({
      number: 'FQQP-PR01',
      code: 'PR01',
      name: '供應商管理作業',
      version: '2.0',
    })
    expect(parseDocumentFileName('FQQP-PR04-進料檢驗作業_(1.0版)_2019.02.15.doc')).toEqual({
      number: 'FQQP-PR04',
      code: 'PR04',
      name: '進料檢驗作業',
      version: '1.0',
    })
    expect(parseDocumentFileName('FQQP-PR02 請採購作業_(1.0版)_2019.02.15.doc').name).toBe('請採購作業')
  })
})
