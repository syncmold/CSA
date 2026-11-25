// 分派表的 .xlsx (#180, Q130 (2)): writes domain/assignmentSheet's sheet with the same library as 追蹤總覽's export (Q95)
// and reads an uploaded one back as plain rows. What write-excel-file has no option for is done by its "features",
// which edit the generated XML: the 系統資料 sheet very hidden (only a macro can show it), the sheets protected, and only the 工號 cells left unlocked.
// The protection has no password: it only stops slips, the checks on import are what count.
import readXlsxFile from 'read-excel-file/universal'
import writeXlsxFile, { type Cell, type CellObject, type Feature, type SheetData } from 'write-excel-file/universal'
import {
  CODE_HEADER,
  HEADER_ROWS,
  NAME_HEADER,
  NOT_HERE,
  SHEET_NAMES,
  sheetTitle,
  systemRows,
  type AssignmentSheet,
  type RawSheet,
} from '../domain/assignmentSheet'
import { saveBlob } from './saveBlob'

const COLOR = {
  header: '#E7E2F6', title: '#F3F0FB', titleText: '#5A3CAC', grey: '#D9D9D9', greyText: '#8A8A8A', empty: '#FFFBE6', manager: '#F6F3FD', line: '#A6A6A6',
}

/**
 * Every cell of the header and the rows is boxed (使用者 2026-11-25: without lines between the columns a 關卡 was
 * left out). The cells a merged header covers stay null: write-excel-file gives them the merge's style, lines too.
 */
const BOXED: Partial<CellObject> = { borderStyle: 'thin', borderColor: COLOR.line }

/** A 工號 cell: text format (so 00123 stays 00123) and, through the feature below, unlocked. Only these use format @. */
const idCell = (value: string, backgroundColor?: string): Cell => ({ type: String, format: '@', value: value || undefined, backgroundColor, ...BOXED })
/** A header cell; `wrap` only in case a name still outgrows the width columnWidths gives it. */
const header = (value: string, extra: Partial<CellObject> = {}): Cell => ({
  value, fontWeight: 'bold', backgroundColor: COLOR.header, align: 'center', alignVertical: 'center', wrap: true, ...BOXED, ...extra,
})

/** Excel's column width (in characters) that shows `text` on one line: a CJK character takes about two, plus a margin. */
const fitWidth = (text: string) => [...text].reduce((w, ch) => w + (/[\u2E80-\uFFEF]/.test(ch) ? 2 : 1), 0) + 3
/** The width a 關卡 column always had. */
const STEP_MIN_WIDTH = 13

/**
 * The 關卡 columns' widths, so every header shows on one line (使用者 2026-11-25: 子公司擔當稽核 was cut): each at least
 * STEP_MIN_WIDTH and wide enough for its 關卡 name; a 自評單位 whose name is wider than its columns together widens its
 * last one. Wrapping is no way out there: Excel does not grow a row for a merged cell.
 */
function columnWidths(columns: AssignmentSheet['layout']['columns']): number[] {
  const widths = columns.map((c) => Math.max(STEP_MIN_WIDTH, fitWidth(c.step)))
  columns.forEach((column, i) => {
    if (column.unit === null || columns[i + 1]?.unit === column.unit) return
    let first = i
    while (first > 0 && columns[first - 1]!.unit === column.unit) first--
    const short = fitWidth(column.unit) - widths.slice(first, i + 1).reduce((a, b) => a + b, 0)
    if (short > 0) widths[i]! += short
  })
  return widths
}

function mainSheet(sheet: AssignmentSheet): SheetData {
  const { columns } = sheet.layout
  const width = 2 + columns.length
  const title: Cell = {
    // 下次發出 is said after the title, which import reads only up to 「年度」 (csa-assignment-v1 unchanged).
    value: `${sheetTitle(sheet)}${sheet.next ? '（下次發出）' : ''}　　產生時間 ${sheet.generatedAt}　　第 1～3 列與 A、B 欄是系統讀取的依據，請勿修改`,
    columnSpan: width, fontWeight: 'bold', backgroundColor: COLOR.title, textColor: COLOR.titleText,
  }
  const units: Cell[] = [header(CODE_HEADER, { rowSpan: 2 }), header(NAME_HEADER, { rowSpan: 2 })]
  const steps: Cell[] = [null, null]
  columns.forEach((column, i) => {
    if (column.unit === null) {
      units.push(header(column.step, { rowSpan: 2 }))
      steps.push(null)
      return
    }
    if (columns[i - 1]?.unit !== column.unit) {
      const span = columns.slice(i).findIndex((c) => c.unit !== column.unit)
      units.push(header(column.unit, { columnSpan: span === -1 ? columns.length - i : span }))
    } else units.push(null)
    steps.push(header(column.step, { fontWeight: undefined }))
  })
  const rows = sheet.rows.map((row) => [
    { value: row.code, ...BOXED } as Cell,
    { value: row.name, ...BOXED } as Cell,
    ...row.cells.map((value, i): Cell => {
      if (value === null) return { value: NOT_HERE, backgroundColor: COLOR.grey, textColor: COLOR.greyText, align: 'center', ...BOXED }
      return idCell(value, columns[i]!.unit === null ? COLOR.manager : COLOR.empty)
    }),
  ])
  return [[title, ...Array<Cell>(width - 1).fill(null)], units, steps, ...rows]
}

/**
 * The wording of the forms sent to the plants before #180 shipped, with Q147's two cases: 下次發出 is written to the
 * 簽核流程 by the plant's 廠區管理員 or a 稽核主管; once the forms are out only a 稽核主管 imports.
 */
function guideSheet(sheet: AssignmentSheet): SheetData {
  const plant = `${sheet.factoryCode} ${sheet.plantName}`
  return [
    `${plant}｜${sheet.year} 年度 分派表${sheet.next ? '（下次發出）' : ''}：填寫說明`,
    '',
    sheet.next
      ? '1. 每一列是一張自評表（一個範本的簽核流程，發出時照這裡的人發出）；每個自評單位有兩格：「自行檢查人員」和「部門主管」，最右邊是這張表的「廠區經理人」。'
      : '1. 每一列是一張自評表；每個自評單位有兩格：「自行檢查人員」和「部門主管」，最右邊是這張表的「廠區經理人」。',
    `2. 黃色格子填工號（例如 ${sheet.factoryCode}0001）。一格只填一位。工號格是文字格式，開頭的 0 不會不見。已經有工號的格子是目前分派的人，可以改。`,
    '3. 灰色「—」的格子表示這張表沒有這個單位，不用填。',
    '4. 「要素類」是控制環境、風險評估、資訊與溝通、監督（A～D）：每張表由一個單位填整張，請填該單位的自行檢查人員與部門主管。',
    '5. 「待指定單位」是範本還沒指定由哪個單位填的部分，請填實際負責的人。',
    '6. 第 1～3 列、A 欄、B 欄已鎖住：系統靠它們讀取，請勿修改、插入或刪除欄列、改分頁名稱，也不要另存成 .xls 或 .csv。',
    sheet.next
      ? '7. 不確定的格子可以先空白；空白表示這次不動，不會清掉原本的人，之後可以在系統上補。每一關都分派好，這張表才能發出。'
      : '7. 不確定的格子可以先空白；空白表示這次不動，不會清掉原本的人，之後可以在系統上補。已經簽過的關卡不能換人，匯入時會跳過。',
    sheet.next
      ? '8. 填好後由廠區管理員或稽核主管在 CSA「分派填寫人」頁的「下次發出」匯入。'
      : '8. 表單已發出，只有稽核主管能換人：填好後請寄回給稽核主管，在 CSA「分派填寫人」頁匯入。',
    '',
    '匯入時系統會檢查：這份是不是這一廠、這一年度的表；格式有沒有被改；每一列是不是這一廠的自評表；',
    '每個工號用「工號＋廠區」到 OMS 比對：不在 OMS 或已離職的人不會匯入；不是這一廠的員工只提醒（跨廠支援）。',
  ].map((line) => [line || null])
}

/** Hides the 系統資料 sheet (veryHidden, as the forms sent before this shipped), protects every sheet, and unlocks the cell styles with the text format (the 工號 cells). */
const protection: Feature<Blob> = {
  files: {
    transform: {
      'xl/workbook.xml': {
        transformElementAttributes: (tag, attributes) =>
          tag === 'sheet' && attributes.name === SHEET_NAMES.system ? { ...attributes, state: 'veryHidden' } : attributes,
      },
      'xl/styles.xml': {
        transform: (xml) => {
          const id = /<numFmt numFmtId="(\d+)" formatCode="@"\/>/.exec(xml)?.[1]
          if (!id) return xml
          return xml.replace(
            new RegExp(`<xf ([^>]*numFmtId="${id}"[^>]*)>(.*?)</xf>`, 'g'),
            '<xf $1 applyProtection="1">$2<protection locked="0"/></xf>',
          )
        },
      },
      'xl/worksheets/sheet{id}.xml': {
        // Right after the cells, as the schema orders it; column widths and row heights stay adjustable.
        transform: (xml) =>
          xml.replace(/(<\/sheetData>|<sheetData\/>)/, '$1<sheetProtection sheet="1" objects="1" scenarios="1" formatColumns="0" formatRows="0"/>'),
      },
    },
  },
}

/** The .xlsx as a Blob, csa-assignment-v1: 分派表 (frozen at the header and the A, B columns), 填寫說明, and the hidden 系統資料. */
export function assignmentWorkbook(sheet: AssignmentSheet): Promise<Blob> {
  return writeXlsxFile(
    [
      {
        sheet: SHEET_NAMES.main,
        data: mainSheet(sheet),
        columns: [{ width: 14 }, { width: 30 }, ...columnWidths(sheet.layout.columns).map((width) => ({ width }))],
        stickyRowsCount: HEADER_ROWS,
        stickyColumnsCount: 2,
      },
      { sheet: SHEET_NAMES.guide, data: guideSheet(sheet), columns: [{ width: 120 }] },
      { sheet: SHEET_NAMES.system, data: systemRows(sheet), columns: [{ width: 12 }, { width: 24 }, { width: 60 }] },
    ],
    { features: [protection] },
  ).toBlob()
}

/** `SY_分派表_2026.xlsx`. */
export const workbookName = (sheet: Pick<AssignmentSheet, 'factoryCode' | 'year'>) => `${sheet.factoryCode}_分派表_${sheet.year}.xlsx`

/** Every sheet of an uploaded file as rows of values; throws when it is not an .xlsx. */
export async function readWorkbook(file: Blob): Promise<RawSheet[]> {
  return (await readXlsxFile(file)) as RawSheet[]
}

/** Save the workbook through the browser's download, as the 追蹤總覽 export does. */
export async function downloadAssignmentWorkbook(sheet: AssignmentSheet): Promise<void> {
  saveBlob(await assignmentWorkbook(sheet), workbookName(sheet))
}
