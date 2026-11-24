// 轉檔接縫 ⓪: Word 另存的 HTML → 主表格的列。純函式；片段照 Word filtered HTML 的實際寫法。
import { describe, expect, it } from 'vitest'
import { decodeWordHtml, htmlTableRows } from './html.ts'

const END = '\r\u0007'
const LIST_ITEM = `<p class=MsoNormal style='margin-left:14.2pt;text-indent:-14.2pt'><span lang=EN-US style='font-size:10.0pt'>1.<span
style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;
</span></span><span style='font-size:10.0pt'>各存貨是否符合一料一號，一號一料之原則？</span></p>`

describe('htmlTableRows', () => {
  it('reads the table with the most rows, one array of cell texts per row', () => {
    const html = `<table><tr><td><p>簽核</p></td></tr></table>
      <table><tr><td><p>作業</p></td><td><p>自評單位</p></td></tr><tr><td><p>題</p></td><td><p>品保單位</p></td></tr></table>`
    expect(htmlTableRows(html)).toEqual([[`作業${END}`, `自評單位${END}`], [`題${END}`, `品保單位${END}`]])
  })

  it('drops Word list numbers, which are not part of the control point text', () => {
    expect(htmlTableRows(`<table><tr><td>${LIST_ITEM}</td></tr></table>`)).toEqual([[`各存貨是否符合一料一號，一號一料之原則？${END}`]])
  })

  it('drops a bare marker followed by its spacer', () => {
    const html = `<table><tr><td><p>◆<span style='font:7.0pt "Times New Roman"'>&nbsp; </span>倉存管理作業</p></td></tr></table>`
    expect(htmlTableRows(html)).toEqual([[`倉存管理作業${END}`]])
  })

  it('collapses source line wraps like a browser, keeps typed spaces, and separates paragraphs like COM', () => {
    const html = `<table><tr><td><p>Life
  Cycle&nbsp; two</p><p>D</p></td></tr></table>`
    expect(htmlTableRows(html)).toEqual([[`Life Cycle  two\rD${END}`]])
  })

  it('leaves out a vertically merged cell in the rows it spans, like COM', () => {
    const html = `<table><tr><td rowspan=2><p>題</p></td><td><p>品保單位</p></td></tr><tr><td><p>生產單位</p></td></tr></table>`
    expect(htmlTableRows(html)).toEqual([[`題${END}`, `品保單位${END}`], [`生產單位${END}`]])
  })

  it('reads tracked changes as accepted: deleted text out, inserted text in', () => {
    const html = `<table><tr><td><p>接受<del cite="mailto:x" datetime="2025-11-24T11:49">訂單</del><ins cite="mailto:x">業務出貨排程</ins>後是否評估？</p></td></tr></table>`
    expect(htmlTableRows(html)).toEqual([[`接受業務出貨排程後是否評估？${END}`]])
  })

  it('joins a questionnaire split into two tables, without repeating the second header', () => {
    const header = '<tr><td><p>自評單位</p></td><td><p>內部控制制度設計</p></td></tr><tr><td><p>是</p></td><td><p>否</p></td></tr>'
    const html = `<table>${header}<tr><td><p>排程作業</p></td></tr><tr><td><p>題一？</p></td><td><p>業務部</p></td></tr></table>
      <table>${header}<tr><td><p>題二？</p></td><td><p>業務部</p></td></tr></table>
      <table><tr><td><p>簽核</p></td></tr><tr><td><p>簽核</p></td></tr><tr><td><p>簽核</p></td></tr><tr><td><p>簽核</p></td></tr><tr><td><p>簽核</p></td></tr></table>`
    expect(htmlTableRows(html).map((row) => row[0]!.replace(/[\r\u0007]/g, ''))).toEqual(['自評單位', '是', '排程作業', '題一？', '題二？'])
  })

  it('refuses to join questionnaire tables whose headers differ', () => {
    const header = (unit: string) =>
      `<tr><td><p>${unit}</p></td><td><p>內部控制制度設計</p></td></tr><tr><td><p>是</p></td><td><p>否</p></td></tr>`
    const html = `<table>${header('自評單位')}<tr><td><p>題一？</p></td></tr></table><table>${header('')}<tr><td><p>題二？</p></td></tr></table>`
    expect(() => htmlTableRows(html)).toThrow('表頭的欄位卻不一樣')
  })

  it('ignores tables nested inside cells when picking the main table', () => {
    const inner = '<table><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></table>'
    const html = `<table><tr><td>${inner}</td></tr><tr><td><p>x</p></td></tr></table>`
    expect(htmlTableRows(html)).toHaveLength(2)
  })

  it('fails when there is no table', () => {
    expect(() => htmlTableRows('<p>沒有表格</p>')).toThrow('沒有表格')
  })
})

describe('decodeWordHtml', () => {
  it('decodes with the charset Word declared', () => {
    // 「存貨」in big5
    const bytes = new Uint8Array([...new TextEncoder().encode('<meta charset=big5><p>'), 0xa6, 0x73, 0xb3, 0x66])
    expect(decodeWordHtml(bytes)).toBe('<meta charset=big5><p>存貨')
  })
})

describe('htmlTableRows: a list inside a cell (Q126)', () => {
  it('keeps the bullets of the paragraphs after the first, dropping only the alignment spacer', () => {
    const item = (text: string) =>
      `<p class=MsoNormal><span style='font-family:Symbol'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span><span>${text}</span></p>`
    const html = `<table><tr><td><p>是否評估下列暴險，包括：</p>${item('企業策略目標之達成。')}${item('資產之保全。')}</td></tr></table>`
    expect(htmlTableRows(html)).toEqual([[`是否評估下列暴險，包括：\r· 企業策略目標之達成。\r· 資產之保全。${END}`]])
  })
})
