// 轉檔 ⓪: Word 另存的 filtered HTML → 主表格的列（每列是儲存格文字陣列），交給 parse.ts。
// 和原本逐格讀 COM 的結果同形狀：垂直合併的格只出現在第一列，後面幾列少一格（#46）；福清 16 份逐字相同。
import { JSDOM } from 'jsdom'
import { cleanCell, HEADER_MARKERS } from './parse.ts'

/** Word 的 HTML 依 <meta charset> 編碼（繁中系統是 big5），不一定是 UTF-8。 */
export function decodeWordHtml(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096))
  const charset = /charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8'
  return new TextDecoder(charset).decode(bytes)
}

/**
 * Word 的清單編號（「1.」「◆」「（一）」）在 HTML 是文字＋一個 `font:7.0pt` 的空白 span；COM 讀到的儲存格文字沒有
 * 編號，原檔的題號與章節符號也不屬於控制要點文字，所以整段拿掉。`keepMarker` 時（一格裡有字的段落之後的條列項，
 * SY-D 1.7.2-1 的「·」，Q126）符號留下、後面接一個空白，只拿掉對齊用的空白 span。
 */
function dropListMarkers(paragraph: Element, keepMarker: boolean): void {
  const spacers = [...paragraph.querySelectorAll('span')].filter((s) => /^\s*font:\s*7\.0pt/i.test(s.getAttribute('style') ?? ''))
  for (const spacer of spacers) {
    const nested = spacer.parentElement && spacer.parentElement !== paragraph && spacer.parentElement.tagName === 'SPAN'
    const marker = nested ? spacer.parentElement! : spacer.previousSibling
    if (keepMarker) {
      spacer.replaceWith(' ')
      continue
    }
    marker?.remove()
    if (!nested) spacer.remove()
  }
}

/** 一格的文字：段落以 \r 分開、結尾 \r\a，和 COM 的 Range.Text 一樣（parse.ts 的 cleanCell 會去掉）。 */
function cellText(cell: Element): string {
  const paragraphs = [...cell.querySelectorAll('p')]
  // 有字的第一段帶的是這一格自己的編號（拿掉）；它後面的條列項留下符號。
  paragraphs.forEach((p, i) => dropListMarkers(p, paragraphs.slice(0, i).some((before) => before.textContent?.trim())))
  const parts = paragraphs.length ? paragraphs.map((p) => p.textContent ?? '') : [cell.textContent ?? '']
  // HTML 原始碼的換行與縮排只是 Word 折行（折在空白處），和瀏覽器一樣收成一個空白；原文連打的空白 Word 寫成
  // &nbsp;，照樣保留。
  return `${parts.map((t) => t.replace(/[ \t\r\n]+/g, ' ').replace(/ /g, ' ')).join('\r')}\r\u0007`
}

/**
 * 問卷主表＝帶問卷表頭的最外層表格（後面的小表格是簽核欄）。表頭重複出現的（KH 03.3 的問卷分成兩個表格）依序
 * 接成一個，後面表格的兩列表頭不重複；都沒有表頭時取列數最多的，交給 parse.ts 報錯。
 * 原檔留著追蹤修訂時（SY 04、05，FQ 03.1），照「接受所有修訂」後的文字：刪掉的字（<del>）不算，新增的（<ins>）算，
 * 和 Word 另存純文字的結果一樣（#84；原本逐格讀 COM 會把兩者都讀進來）。
 */
export function htmlTableRows(html: string): string[][] {
  const document = new JSDOM(html).window.document
  for (const deleted of document.querySelectorAll('del')) deleted.remove()
  const tables = [...document.querySelectorAll('table')]
    .filter((t) => !t.parentElement?.closest('table'))
    .map((t) => [...t.rows].map((row) => [...row.cells].map(cellText)))
  const headerOf = (rows: string[][]) => rows.findIndex((cells) => cells.some((c) => HEADER_MARKERS.includes(cleanCell(c))))
  const questionnaires = tables.filter((rows) => headerOf(rows) >= 0)
  if (questionnaires.length === 0) {
    const largest = tables.sort((a, b) => b.length - a.length)[0]
    if (!largest) throw new Error('原檔裡沒有表格')
    return largest
  }
  // 表頭兩列：組別（內部控制制度設計…）與逐欄的答題欄名稱。parse.ts 只看第一個表頭，所以後面的表格欄位要一樣。
  const columns = (rows: string[][]) => [headerOf(rows), headerOf(rows) + 1].map((i) => rows[i]?.map(cleanCell).join('|')).join('/')
  if (questionnaires.some((rows) => columns(rows) !== columns(questionnaires[0]!))) {
    throw new Error('問卷分成幾個表格，表頭的欄位卻不一樣，不能接成一份')
  }
  return questionnaires.flatMap((rows, i) => (i === 0 ? rows : rows.slice(headerOf(rows) + 2)))
}
