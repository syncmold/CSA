// 轉檔接縫 ①: Word 表格的列 → 章節與控制要點。純函式，不碰 Word、不碰資料庫。
// Fixture 的列結構取自「02 採購及付款循環」實際的 Word 檔（Word COM 逐列讀出的儲存格文字）：
// 表頭兩列、章節列只有一格、控制要點列第 1 格是控制要點文字、第 2 格是自評單位，後面是空的答題欄。
import { describe, expect, it } from 'vitest'
import { mergeSplitControlPoints, numberPointsPerSubsection, parseTemplateFileName, parseTemplateRows, splitSourceCode, takeSourceCodes } from './parse.ts'

const BLANK_ANSWER_CELLS = Array(12).fill('')
const HEADER_ROWS = [
  ['', '自評單位', '內部控制制度設計', '內部控制制度執行情形', '設計、執行有效控制滿意度', '備註說明'],
  ['有內控規範', '無內控規範', '是', '否', '不適用', '無此情形', '非常滿意', '滿意', '剛好', '需要加強', '不滿意', '所需採行之改善措施/其他考量'],
]

describe('parseTemplateRows：控制活動類', () => {
  it('puts each control point under the section row above it, in paper order, with its 自評單位', () => {
    const rows = [
      ...HEADER_ROWS,
      ['供應商管理作業'],
      ['供應商之評估作業是否切實依規定辦理？', '資材單位', ...BLANK_ANSWER_CELLS],
      ['是否依規定辦理供應商的後續評鑑？', '資材單位', ...BLANK_ANSWER_CELLS],
      ['驗收作業(適用於各請、採購類型)'],
      ['是否確依進料檢驗規範所定之程序辦理檢驗？', '品保單位', ...BLANK_ANSWER_CELLS],
    ]

    expect(parseTemplateRows(rows)).toEqual({
      sections: [
        {
          name: '供應商管理作業',
          controlPoints: [
            { text: '供應商之評估作業是否切實依規定辦理？', assessingUnits: ['資材單位'] },
            { text: '是否依規定辦理供應商的後續評鑑？', assessingUnits: ['資材單位'] },
          ],
        },
        {
          name: '驗收作業(適用於各請、採購類型)',
          controlPoints: [{ text: '是否確依進料檢驗規範所定之程序辦理檢驗？', assessingUnits: ['品保單位'] }],
        },
      ],
      assessingUnits: ['資材單位', '品保單位'],
    })
  })

  it('refuses a control point without a 自評單位 instead of silently dropping the row', () => {
    const rows = [...HEADER_ROWS, ['付款作業'], ['支票是否序號控管？', '', ...BLANK_ANSWER_CELLS]]
    expect(() => parseTemplateRows(rows)).toThrow(/支票是否序號控管/)
  })

  it("strips Word's end-of-cell marker and ignores blank rows", () => {
    const END = '\r\u0007'
    const rows = [
      ...HEADER_ROWS,
      [`付款作業${END}`],
      [`  ${END}`],
      [`支票是否序號控管？${END}`, `財務單位${END}`, ...BLANK_ANSWER_CELLS.map((c) => `${c}${END}`)],
    ]

    expect(parseTemplateRows(rows)).toEqual({
      sections: [{ name: '付款作業', controlPoints: [{ text: '支票是否序號控管？', assessingUnits: ['財務單位'] }] }],
      assessingUnits: ['財務單位'],
    })
  })

  it('一個控制要點跨多列、由幾個自評單位各答一列時，是一個控制要點帶多個自評單位（04 存貨循環的形狀，#46）', () => {
    // Word 把垂直合併的控制要點格讀成：第一列有文字，之後的列不是少一格（13 格）就是控制要點格空白（14 格）。
    const rows = [
      ...HEADER_ROWS,
      ['物料標示與追溯性管理作業'],
      ['進料階段之物料標示是否依既定之作業程序確實遵循？', '資材單位', ...BLANK_ANSWER_CELLS],
      ['品保單位', ...BLANK_ANSWER_CELLS],
      ['製程階段之物料標示是否依既定之作業程序確實遵循？', '品保單位', ...BLANK_ANSWER_CELLS],
      ['生產單位', ...BLANK_ANSWER_CELLS],
      ['', '資材單位', ...BLANK_ANSWER_CELLS],
      ['出貨階段之物料標示是否依既定之作業程序確實遵循？', '品保單位', ...BLANK_ANSWER_CELLS],
    ]
    expect(parseTemplateRows(rows).sections).toEqual([
      {
        name: '物料標示與追溯性管理作業',
        controlPoints: [
          { text: '進料階段之物料標示是否依既定之作業程序確實遵循？', assessingUnits: ['資材單位', '品保單位'] },
          { text: '製程階段之物料標示是否依既定之作業程序確實遵循？', assessingUnits: ['品保單位', '生產單位', '資材單位'] },
          { text: '出貨階段之物料標示是否依既定之作業程序確實遵循？', assessingUnits: ['品保單位'] },
        ],
      },
    ])
  })

  it('同一題合併格裡出現重複的自評單位就拒絕（原檔或解析出了問題）', () => {
    const rows = [...HEADER_ROWS, ['物料標示'], ['製程？', '品保單位', ...BLANK_ANSWER_CELLS], ['品保單位', ...BLANK_ANSWER_CELLS]]
    expect(() => parseTemplateRows(rows)).toThrow(/製程？/)
  })
})

describe('parseTemplateRows：原檔形狀不同的地方', () => {
  const NO_UNIT_HEADER = [
    ['', '內部控制制度設計', '內部控制制度執行情形', '設計、執行有效控制滿意度', '備註說明'],
    HEADER_ROWS[1]!,
  ]

  it('表頭沒有自評單位欄（10.1、15）時，整份掛 unitWhenNoColumn 指定的單位', () => {
    const rows = [...NO_UNIT_HEADER, ['公告申報程序'], ['是否依規定期限公告申報？', ...BLANK_ANSWER_CELLS]]
    expect(parseTemplateRows(rows, { unitWhenNoColumn: '待指定單位' })).toEqual({
      sections: [{ name: '公告申報程序', controlPoints: [{ text: '是否依規定期限公告申報？', assessingUnits: ['待指定單位'] }] }],
      assessingUnits: ['待指定單位'],
    })
  })

  it('要素類（A–D）：表頭是「評估結果」、沒有自評單位欄，控制要點不掛單位', () => {
    const rows = [
      ['', '評估結果', '設計、執行有效控制滿意度', '備註說明'],
      ['是', '否', '不適用', '補充說明', '非常滿意', '滿    意', '剛    好', '需要加強', '不滿意', '所需採行之改善措施/其他考量'],
      ['高階管理階層應重視誠信與道德價值'],
      ['是否建立內部行為準則包括員工行為準則等規範？', ...Array(10).fill('')],
    ]
    expect(parseTemplateRows(rows).sections).toEqual([
      { name: '高階管理階層應重視誠信與道德價值', controlPoints: [{ text: '是否建立內部行為準則包括員工行為準則等規範？', assessingUnits: [] }] },
    ])
  })

  it('沒有章節列（11 預算管理制度）時，控制要點放進 untitledSection；沒指定就拒絕', () => {
    const rows = [...HEADER_ROWS, ['管理階層是否追蹤預算編製之進度？', '財務單位', ...BLANK_ANSWER_CELLS]]
    expect(() => parseTemplateRows(rows)).toThrow(/管理階層是否追蹤預算編製之進度/)
    expect(parseTemplateRows(rows, { untitledSection: '預算管理制度' }).sections).toEqual([
      { name: '預算管理制度', controlPoints: [{ text: '管理階層是否追蹤預算編製之進度？', assessingUnits: ['財務單位'] }] },
    ])
  })

  it('多層章節（10.1 研發循環）每個章節列一個章節，層級依 headingLevels，上層標題沒有控制要點；名稱前的 --- 拿掉（Q125）', () => {
    const point = (text: string) => [text, ...BLANK_ANSWER_CELLS]
    const rows = [
      ...NO_UNIT_HEADER,
      ['新產品導入管制作業'],
      ['估價階段'],
      point('是否於三個工作日內提報報價？'),
      ['設計評估階段(由台北研發部進行)'],
      ['DVT(設計驗證測試階段)'],
      ['---開模通知'],
      point('是否發出開模通知？'),
      ['---料號申請'],
      point('是否申請料號？'),
      ['工程變更作業'],
      point('是否於系統提出工程變更？'),
    ]
    const options = {
      unitWhenNoColumn: '待指定單位',
      headingLevels: { 估價階段: 2, '設計評估階段(由台北研發部進行)': 2, 'DVT(設計驗證測試階段)': 2, '---開模通知': 3, '---料號申請': 3 },
      emptyHeadings: ['設計評估階段(由台北研發部進行)'],
    }
    expect(parseTemplateRows(rows, options).sections.map((s) => [s.level ?? 1, s.name, s.controlPoints.map((p) => p.text)])).toEqual([
      [1, '新產品導入管制作業', []],
      [2, '估價階段', ['是否於三個工作日內提報報價？']],
      [2, 'DVT(設計驗證測試階段)', []],
      [3, '開模通知', ['是否發出開模通知？']],
      [3, '料號申請', ['是否申請料號？']],
      [1, '工程變更作業', ['是否於系統提出工程變更？']],
    ])
    // 第 1 層不寫 level，草稿定義檔和單層的範本一樣。
    expect(parseTemplateRows(rows, options).sections[0]).toEqual({ name: '新產品導入管制作業', controlPoints: [] })
  })

  it('上層標題底下的下一層若是 emptyHeadings 而且後面沒有別的下一層，上層就成了空章節：拒絕', () => {
    const rows = [
      ...NO_UNIT_HEADER,
      ['新產品導入管制作業'],
      ['設計評估階段(由台北研發部進行)'],
      ['工程變更作業'],
      ['是否於系統提出工程變更？', ...BLANK_ANSWER_CELLS],
    ]
    const options = {
      unitWhenNoColumn: '待指定單位',
      headingLevels: { '設計評估階段(由台北研發部進行)': 2 },
      emptyHeadings: ['設計評估階段(由台北研發部進行)'],
    }
    expect(() => parseTemplateRows(rows, options)).toThrow(/新產品導入管制作業/)
  })

  it('超過三層的章節列拒絕', () => {
    const rows = [...NO_UNIT_HEADER, ['一'], ['二'], ['三'], ['四'], ['是否？', ...BLANK_ANSWER_CELLS]]
    expect(() => parseTemplateRows(rows, { unitWhenNoColumn: '待指定單位', headingLevels: { 二: 2, 三: 3, 四: 4 } })).toThrow(/最多三層/)
  })

  it('底下沒有任何控制要點的章節列，沒列在 emptyHeadings 就拒絕，不默默丟掉', () => {
    const rows = [...HEADER_ROWS, ['付款作業'], ['驗收作業'], ['是否確依規範辦理檢驗？', '品保單位', ...BLANK_ANSWER_CELLS]]
    expect(() => parseTemplateRows(rows)).toThrow(/付款作業/)
  })
})

describe('parseTemplateRows：登錄過的原檔更正', () => {
  const rows = [
    ...HEADER_ROWS,
    ['資料輸出入之控制作業'],
    ['輸入錯誤時是否顯示錯誤訊息？', '資訊部', ...BLANK_ANSWER_CELLS],
    ['異常是否產生例外報表？', '', ...BLANK_ANSWER_CELLS],
    ['銷貨單據是否經收貨人簽收？', '模具業務', ...BLANK_ANSWER_CELLS],
    ['模具業務', ...BLANK_ANSWER_CELLS],
  ]
  const options = { blankUnits: { '異常是否產生例外報表？': '待指定單位' }, repeatedUnitRows: ['銷貨單據是否經收貨人簽收？'] }

  it('fills a registered blank unit cell and drops a registered repeated unit row', () => {
    expect(parseTemplateRows(rows, options).sections[0]!.controlPoints).toEqual([
      { text: '輸入錯誤時是否顯示錯誤訊息？', assessingUnits: ['資訊部'] },
      { text: '異常是否產生例外報表？', assessingUnits: ['待指定單位'] },
      { text: '銷貨單據是否經收貨人簽收？', assessingUnits: ['模具業務'] },
    ])
  })

  it('still rejects blank or repeated units that are not registered', () => {
    expect(() => parseTemplateRows(rows, { repeatedUnitRows: options.repeatedUnitRows })).toThrow('控制要點沒有自評單位')
    expect(() => parseTemplateRows(rows, { blankUnits: options.blankUnits })).toThrow('重複出現自評單位「模具業務」')
  })

  it('fails once the source is fixed, so the correction gets removed', () => {
    expect(() => parseTemplateRows(rows, { ...options, blankUnits: { ...options.blankUnits, '不存在的題目？': '待指定單位' } })).toThrow(
      '不存在的題目？',
    )
  })
})

describe('parseTemplateFileName', () => {
  it('reads code, layout and name; 「所有廠區適用」 means all plants', () => {
    expect(parseTemplateFileName('02~控制活動~採購及付款循環(所有廠區適用)..doc')).toEqual({
      code: '02',
      layout: 'control_activity',
      name: '採購及付款循環',
      allPlants: true,
    })
  })

  it('a plant-limited template is not all-plants, and keeps a dotted code', () => {
    expect(parseTemplateFileName('01.1~控制活動~銷售及收款循環(組裝廠及福清富群)..doc')).toEqual({
      code: '01.1',
      layout: 'control_activity',
      name: '銷售及收款循環',
      allPlants: false,
    })
  })

  it('檔名在括號後多了註記（「.小改」）也讀得出來', () => {
    expect(parseTemplateFileName('03.1~控制活動~生產循環(組裝廠及福清富群).小改.doc')).toEqual({
      code: '03.1',
      layout: 'control_activity',
      name: '生產循環',
      allPlants: false,
    })
  })

  it('要素類只有「編號~名稱」，沒有版型那一段', () => {
    expect(parseTemplateFileName('A~控制環境..doc')).toEqual({ code: 'A', layout: 'element', name: '控制環境', allPlants: false })
  })

  it.each([
    ['05.2~控制活動~研發循環(陸合-台中)~沖壓..doc', { code: '05.2', name: '研發循環', variant: '沖壓' }],
    ['5.1~控制活動~研發循環(陸和-蘇州)~模具..doc', { code: '5.1', name: '研發循環', variant: '模具' }],
    ['03~控制活動~生產循環(陸合-台中) 模具&沖壓..doc', { code: '03', name: '生產循環', variant: '模具&沖壓' }],
    ['03.2~控制活動~生產循環(昆山鴻嘉駿)~沖壓&塑膠..doc', { code: '03.2', name: '生產循環', variant: '沖壓&塑膠' }],
    ['03.1~控制活動~生產循環~(敬得-桃園)..doc', { code: '03.1', name: '生產循環' }],
    ['02~控制活動~採購及付款循環(協和-泰國.doc', { code: '02', name: '採購及付款循環' }],
    ['07~控制活動~融資循環.(信鋐文件無).doc', { code: '07', name: '融資循環' }],
    ['10.1~控制活動~研發循環(組裝／沖壓／小五金).增加模具管理.doc', { code: '10.1', name: '研發循環' }],
    ['09~控制活動~薪工循環(信錦泰國).docx', { code: '09', name: '薪工循環' }],
    [
      '14~控制活動~財務報表編制流程管理作業(包含國際會計準則管理、會計專業判斷程序會計政策與估計變動之流程)(敬得-桃園)..doc',
      { code: '14', name: '財務報表編制流程管理作業' },
    ],
  ])('各廠的寫法：%s', (fileName, expected) => {
    expect(parseTemplateFileName(fileName)).toEqual({ layout: 'control_activity', allPlants: false, ...expected })
  })
})

describe('mergeSplitControlPoints', () => {
  const body = {
    sections: [
      {
        name: '驗收作業',
        controlPoints: [
          { text: '倉庫單位是否依據經核准之採購訂單數量、品名、規格等核', assessingUnits: ['資材單位'] },
          { text: '對廠商之送貨單以為數量暫收之基礎？', assessingUnits: ['資材單位'] },
          { text: '是否確依進料檢驗規範所定之程序辦理檢驗？', assessingUnits: ['品保單位'] },
        ],
      },
    ],
    assessingUnits: ['資材單位', '品保單位'],
  }
  const SPLIT = [{ first: '倉庫單位是否依據經核准之採購訂單數量、品名、規格等核', second: '對廠商之送貨單以為數量暫收之基礎？' }]

  it('joins a question the source split across two rows, keeping the first row’s 自評單位', () => {
    const merged = mergeSplitControlPoints(body, SPLIT)
    expect(merged.sections[0]!.controlPoints).toEqual([
      { text: '倉庫單位是否依據經核准之採購訂單數量、品名、規格等核對廠商之送貨單以為數量暫收之基礎？', assessingUnits: ['資材單位'] },
      { text: '是否確依進料檢驗規範所定之程序辦理檢驗？', assessingUnits: ['品保單位'] },
    ])
  })

  it('fails loudly when the source no longer has the split, so a stale correction gets removed', () => {
    const fixedAtSource = { ...body, sections: [{ name: '驗收作業', controlPoints: body.sections[0]!.controlPoints.slice(2) }] }
    expect(() => mergeSplitControlPoints(fixedAtSource, SPLIT)).toThrow(/倉庫單位是否依據/)
  })
})

describe('原檔題號（Q125）', () => {
  it('splitSourceCode：開頭的題號（含結尾的點）後面接中文才算，題號＋空白＋文字＝原文', () => {
    expect(splitSourceCode('1.1.1-1公司是否建立董事行為準則？')).toEqual({ code: '1.1.1-1', text: '公司是否建立董事行為準則？' })
    expect(splitSourceCode('1.1.1-3 公司是否透過使命聲明？')).toEqual({ code: '1.1.1-3', text: '公司是否透過使命聲明？' })
    expect(splitSourceCode('1.2.企業整體目標是否有效地在組織內傳達？')).toEqual({ code: '1.2.', text: '企業整體目標是否有效地在組織內傳達？' })
    expect(splitSourceCode('1董事會與高階管理階層應重視誠信與道德價值。')).toEqual({ code: '1', text: '董事會與高階管理階層應重視誠信與道德價值。' })
    expect(splitSourceCode('10.避險性交易淨累計部位金額？')).toEqual({ code: '10.', text: '避險性交易淨累計部位金額？' })
    for (const plain of ['3D圖面是否確認？', 'IPQC是否依規定時間對產品？', '是否於3個工作日內？', '1.2.3']) {
      expect(splitSourceCode(plain)).toBeNull()
    }
  })

  it('takeSourceCodes 拿出章節與控制要點的題號，沒有題號的不動', () => {
    const body = {
      assessingUnits: [],
      sections: [
        { name: '1董事會應重視誠信。', controlPoints: [] },
        { level: 2 as const, name: '1.1公司是否建立行為準則？', controlPoints: [{ text: '1.1.1-1 公司是否建立董事行為準則？', assessingUnits: [] }] },
        { level: 2 as const, name: '沒有題號的章節', controlPoints: [{ text: '沒有題號的題目？', assessingUnits: [] }] },
      ],
    }
    expect(takeSourceCodes(body).sections).toEqual([
      { code: '1', name: '董事會應重視誠信。', controlPoints: [] },
      { level: 2, code: '1.1', name: '公司是否建立行為準則？', controlPoints: [{ code: '1.1.1-1', text: '公司是否建立董事行為準則？', assessingUnits: [] }] },
      { level: 2, name: '沒有題號的章節', controlPoints: [{ text: '沒有題號的題目？', assessingUnits: [] }] },
    ])
  })

  it('takeSourceCodes 遇到開頭是數字卻拆不出題號的就失敗', () => {
    const body = { assessingUnits: [], sections: [{ name: '章', controlPoints: [{ text: '1.1.1-1ABC 公司是否？', assessingUnits: [] }] }] }
    expect(() => takeSourceCodes(body)).toThrow(/1.1.1-1ABC/)
  })

  it('numberPointsPerSubsection：第二層以下的章節每段從 1 編進題號欄（SAMOA 的紙本），第一層的不動', () => {
    const point = (text: string) => ({ text, assessingUnits: ['待指定單位'] })
    const body = {
      assessingUnits: ['待指定單位'],
      sections: [
        { name: '投資循環', controlPoints: [] },
        { level: 2 as const, name: '投資取得作業', controlPoints: [point('甲？'), point('乙？')] },
        { level: 2 as const, name: '投資收益作業', controlPoints: [point('丙？')] },
        { name: '印鑑管理作業', controlPoints: [point('丁？')] },
      ],
    }
    expect(numberPointsPerSubsection(body).sections.map((s) => s.controlPoints.map((p) => p.code ?? '-'))).toEqual([[], ['1', '2'], ['1'], ['-']])
  })
})

describe('一格裡的換行（Q126）', () => {
  // 原檔的儲存格：段落以 \r 分開、結尾 \r\a（html.ts 的 cellText）。
  const cell = (...paragraphs: string[]) => `${paragraphs.join('\r')}\r\u0007`
  const parse = (text: string, options = {}) =>
    parseTemplateRows([...HEADER_ROWS, ['銷售作業'], [text, '業務單位', ...BLANK_ANSWER_CELLS]], options).sections[0]!.controlPoints[0]!.text

  it('keeps a line break after a finished sentence: the note in brackets, the items of a list', () => {
    expect(parse(cell('銷貨單據是否序時序號連續開立？', '(若客戶端採上線模式始確認銷貨者，另應含括上線單據)'))).toBe(
      '銷貨單據是否序時序號連續開立？\n(若客戶端採上線模式始確認銷貨者，另應含括上線單據)',
    )
    expect(parse(cell('是否包括下列項目： ', '1.目的。', '2.程序。'))).toBe('是否包括下列項目：\n1.目的。\n2.程序。')
  })

  it('joins a break in the middle of a sentence as before', () => {
    expect(parse(cell('機器設備保養人員是否經適當培訓，且經考核', '合格後，方可擔認維修工作？'))).toBe('機器設備保養人員是否經適當培訓，且經考核合格後，方可擔認維修工作？')
  })

  it('joins a registered word the source broke with spaces, and refuses an unregistered one', () => {
    const text = cell('是否填寫「修模檢討報    ', '告」與廠區確認？')
    expect(() => parse(text)).toThrow(/wordBreaks/)
    expect(parse(text, { wordBreaks: ['修模檢討報告'] })).toBe('是否填寫「修模檢討報告」與廠區確認？')
  })

  it('fails once the source no longer breaks the registered word', () => {
    expect(() => parse(cell('是否填寫「修模檢討報告」與廠區確認？'), { wordBreaks: ['修模檢討報告'] })).toThrow(/修模檢討報告/)
  })
})
