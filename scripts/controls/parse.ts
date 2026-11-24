// 內控文件轉檔 ①: Word 原檔的全文 → 版次與條文（第 5 節作業內容、第 6 節控制重點）。
// 全文由 extract-doc.ps1 以 Word 讀出：先把自動編號轉成文字（ConvertNumbersToText），所以條號就在段落開頭、
// 後面接 Tab。只依文字形狀判斷，不依賴任何人名；條文只有作業程序，不含簽核欄。

export interface ParsedClause {
  /** 條號，如 5.1.2；章是 5、6。 */
  number: string
  /** 條文原文；條號下面沒有編號的段落接在後面，一段一行。 */
  text: string
}

export interface ParsedControlDocument {
  /** 文件改廢履歷表上這份文件的最後一版。 */
  version: { version: string; effectiveDate: string }
  clauses: ParsedClause[]
}

/** 條文中的表格不轉成文字（合併格與勾選欄轉不出原樣），只留一句指向原文件；側邊欄可看整份文件。 */
export const TABLE_NOTE = '（表格見內控文件）'

/** 只讀這兩節：作業內容與控制重點（Q39）。 */
const FIRST_SECTION = 5
const LAST_SECTION = 6

const CLAUSE_LINE = /^(\d+(?:\.\d+)*)\.?\t+(.*)$/
/** 原檔把下一條接在同一段（PR01 的 5.8.1.1「…完成。5.8.1.2\t免評鑑…」）。 */
const RUN_IN_CLAUSE = /(?<=\S)(\d+(?:\.\d+)+)\t/g

/**
 * Word 的全文 → 段落。段落以 \r 分隔；\v（段落內換行）也當成分段；分頁符號 \f 出現在條號前面就是分段，
 * 夾在句子中間（PR01「不利影\f響」）就拿掉。
 */
function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\v/g, '\n')
    .replace(/\f(?=\d+(?:\.\d+)*\t)/g, '\n')
    .replace(/\f/g, '')
    .split('\n')
}

/** 文件改廢履歷表：版次、文件編號、實施日期三格相鄰；版次可能寫「2.0版」。取這份文件最後一列。 */
function latestRevision(text: string, documentNumber: string): ParsedControlDocument['version'] {
  const cells = text.replace(/\r\n?/g, '\n')
  const escaped = documentNumber.replace(/[-]/g, '\\-')
  const row = new RegExp(`(?:^|\\x07)\\s*(\\d+\\.\\d+)\\s*版?\\s*\\n\\x07\\s*${escaped}\\s*\\n\\x07\\s*(\\d{4})[./](\\d{1,2})[./](\\d{1,2})\\s*\\n\\x07`, 'g')
  const rows = [...cells.matchAll(row)]
  const last = rows.at(-1)
  if (!last) throw new Error(`文件改廢履歷表裡找不到 ${documentNumber} 的版次`)
  const [, version, y, m, d] = last
  return { version: version!, effectiveDate: `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}` }
}

export function parseControlDocument(text: string, documentNumber: string): ParsedControlDocument {
  const lines = paragraphs(text)
  const clauses: { number: string; lines: string[]; table: boolean }[] = []
  let started = false
  let current: (typeof clauses)[number] | null = null

  const startClause = (number: string, first: string) => {
    if (clauses.some((c) => c.number === number)) throw new Error(`${documentNumber} 的條號 ${number} 出現兩次`)
    const clause = { number, lines: [first], table: false }
    clauses.push(clause)
    return clause
  }

  // 表格：一格以 \r\x07 結束，所以下一段以 \x07 開頭的段落結束了一格；一格可以有好幾段（PR02 5.6.3）。從表格的
  // 第一格到下一條條文之間都是表格內容（原檔表格後面接的都是下一條，不是沒有編號的段落）。
  let inTable = false
  for (let i = 0; i < lines.length; i++) {
    const content = lines[i]!.replace(/^\x07+/, '')
    if (lines[i + 1]?.startsWith('\x07')) {
      if (started && current && !current.table) {
        current.lines.push(TABLE_NOTE)
        current.table = true
      }
      inTable = true
      continue
    }
    const m = content.match(CLAUSE_LINE)
    if (m) {
      const [, number, rest] = m
      const section = Number(number!.split('.')[0])
      // 只有條號、沒有內文的是轉換編號留下的殘段（PR01 的「1.1.1.1\t」）。
      if (!rest!.trim()) continue
      if (!started) {
        if (number !== String(FIRST_SECTION)) continue
        started = true
      } else if (section > LAST_SECTION) {
        break
      }
      inTable = false
      const pieces = rest!.split(RUN_IN_CLAUSE)
      current = startClause(number!, clean(pieces[0]!))
      for (let p = 1; p + 1 < pieces.length; p += 2) current = startClause(pieces[p]!, clean(pieces[p + 1]!))
      continue
    }
    if (inTable) {
      // 一格的中間段落後面遲早有一段結束一格；在下一條之前都沒有，就是表格後面的內文，不能默默丟掉。
      if (started && current && content.trim() && !cellEndsBeforeNextClause(lines, i)) {
        throw new Error(`${documentNumber} 第 ${current.number} 條的表格後面有沒有編號的段落「${clean(content)}」，請確認原檔後調整轉檔`)
      }
      continue
    }
    if (started && current && content.trim()) current.lines.push(clean(content))
  }

  return {
    version: latestRevision(text, documentNumber),
    clauses: clauses.map((c) => ({ number: c.number, text: c.lines.join('\n') })),
  }
}

/** 從第 i 段起，在下一條有內文的條文之前，是否還有一段結束了表格的一格（下一段以 \x07 開頭）。 */
function cellEndsBeforeNextClause(lines: string[], i: number): boolean {
  for (let j = i; j < lines.length; j++) {
    if (lines[j + 1]?.startsWith('\x07')) return true
    const m = lines[j]!.replace(/^\x07+/, '').match(CLAUSE_LINE)
    if (j > i && m && m[2]!.trim()) return false
  }
  return false
}

/** 段落內的 Tab（「A.\t免評鑑之條件」）換成一個空白。 */
function clean(line: string): string {
  return line.replace(/\t+/g, ' ').trim()
}

export interface DocumentFileInfo {
  /** 文件編號，如 FQQP-PR01。 */
  number: string
  /** 簡碼：文件編號去掉公司前綴，如 PR01；畫面與 PDF 印「PR01 §6.1」。 */
  code: string
  name: string
  /** 檔名上的版次；與文件改廢履歷表不一致時轉檔失敗。 */
  version: string
}

/** 原檔檔名：「FQQP-PR01供應商管理作業_(2.0版)_2021.07.01_….doc」，編號與名稱之間可能是空白、- 或什麼都沒有。 */
export function parseDocumentFileName(fileName: string): DocumentFileInfo {
  const m = fileName.match(/^([A-Z]+-([A-Z]+\d+))[\s-]*(.+?)_\((\d+\.\d+)版\)/)
  if (!m) throw new Error(`看不懂內控文件檔名：${fileName}`)
  const [, number, code, name, version] = m
  return { number: number!, code: code!, name: name!.trim(), version: version! }
}
