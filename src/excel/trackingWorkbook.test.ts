import readXlsxFile from 'read-excel-file/node'
import { describe, expect, it } from 'vitest'
import type { TrackingSheets } from '../domain/tracking'
import { trackingWorkbook } from './trackingWorkbook'

const SHEETS: TrackingSheets = {
  overview: [
    ['公司／廠區', '02 採購及付款', 'A 控制環境'],
    ['富群 福清（FQ）', '第 3／10 關 部門主管－資材\n王小明（SS140）\n停留 5 天', '未發起'],
  ],
  detail: [
    ['年度', '廠區代碼', '停留天數', '結案日期'],
    [2027, 'FQ', 5, ''],
    [2027, 'SY', '', '2027-02-18'],
  ],
}

describe('trackingWorkbook', () => {
  it('writes the 總覽 and 明細 sheets with exactly the cells it was given', async () => {
    const blob = await trackingWorkbook(SHEETS, { overview: '總覽', detail: '明細' })
    const sheets = await readXlsxFile(Buffer.from(await blob.arrayBuffer()))
    expect(sheets.map((s) => s.sheet)).toEqual(['總覽', '明細'])
    expect(sheets[0]!.data).toEqual(SHEETS.overview)
    // Empty cells read back as null; everything else as written (numbers stay numbers).
    expect(sheets[1]!.data).toEqual(SHEETS.detail.map((r) => r.map((c) => (c === '' ? null : c))))
  })
})
