// 追蹤總覽的 Excel 匯出 (#14)：把 domain/tracking 的 trackingSheets 原樣寫成 .xlsx，只加版面（欄寬、粗體表頭、
// 凍結表頭、換行），不改任何儲存格內容，所以檔案與畫面一致。
import writeXlsxFile, { type Cell, type SheetData } from 'write-excel-file/universal'
import type { SheetCell, TrackingSheets } from '../domain/tracking'
import { saveBlob } from './saveBlob'

export interface SheetNames {
  overview: string
  detail: string
}

const header = (value: SheetCell): Cell => ({ value, fontWeight: 'bold', backgroundColor: '#F0F0F0', alignVertical: 'center', wrap: true })
const cell = (value: SheetCell): Cell => (value === '' ? null : { value, alignVertical: 'top', wrap: true })

function sheetData(rows: SheetCell[][], headerColumns = 0): SheetData {
  return rows.map((row, i) => row.map((value, j) => (i === 0 || j < headerColumns ? header(value) : cell(value))))
}

/** The .xlsx as a Blob: 總覽 (the matrix, its 廠區 column kept as a header) and 明細. */
export function trackingWorkbook(sheets: TrackingSheets, names: SheetNames): Promise<Blob> {
  const templateColumns = Math.max(0, (sheets.overview[0]?.length ?? 1) - 1)
  const detailColumns = sheets.detail[0]?.length ?? 0
  return writeXlsxFile([
    {
      sheet: names.overview,
      data: sheetData(sheets.overview, 1),
      columns: [{ width: 24 }, ...Array.from({ length: templateColumns }, () => ({ width: 26 }))],
      stickyRowsCount: 1,
      stickyColumnsCount: 1,
    },
    {
      sheet: names.detail,
      data: sheetData(sheets.detail),
      columns: Array.from({ length: detailColumns }, () => ({ width: 16 })),
      stickyRowsCount: 1,
    },
  ]).toBlob()
}

/** Save the workbook through the browser's download, the same way as the PDF export. */
export async function downloadTrackingWorkbook(sheets: TrackingSheets, names: SheetNames, fileName: string): Promise<void> {
  saveBlob(await trackingWorkbook(sheets, names), fileName)
}
