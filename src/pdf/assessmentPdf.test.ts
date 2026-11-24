// PDF 接縫 (#7): a fixed 自評表 snapshot, answers and 簽核紀錄 go in, and the test reads the printed text of the
// PDF that comes out. Checked against the paper 02 採購及付款循環 sample.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AssessmentControlPoint } from '../api/assessments'
import { renderAssessmentPdf } from './assessmentPdf'
import { NAME_ONLY_FONT_SIZE, SIGNED_CELL_FONT_SIZE, SIGNED_CELL_HEIGHT } from './signatures'
import { LONG_POINT, pdfInput, point as snapshotPoint, signoff } from './testing/fixtures'
import { nodePdfEngine } from './testing/nodeEngine'
import { allText, checkedColumns, readPdf, type PdfPage } from './testing/pdfText'

const engine = nodePdfEngine()
const render = async (input = pdfInput()) => readPdf(await renderAssessmentPdf(input, engine))
const png = (path: string) => `data:image/png;base64,${readFileSync(new URL(path, import.meta.url)).toString('base64')}`

describe('版頭', () => {
  it('prints the company and "{年度} 年度內部控制制度自行評估問卷表~{範本名稱}" on every A4 landscape page, with n / N', async () => {
    const pages = await render()
    expect(pages.length).toBeGreaterThan(1)
    pages.forEach((page, i) => {
      expect([Math.round(page.width), Math.round(page.height)]).toEqual([842, 595])
      expect(page.lines[0]).toBe('福清富群電子有限公司')
      expect(page.lines[1]).toBe('2026 年度內部控制制度自行評估問卷表~採購及付款循環')
      expect(page.lines.at(-1)).toBe(`${i + 1} / ${pages.length}`)
      expect(page.images).toBe(0)
    })
  }, 30_000)

  it('draws the group logo on the left and the company logo on the right of every page when given', async () => {
    const pages = await render(pdfInput({ logos: { group: png('./assets/group-logo.png'), company: png('../../public/logos/fulfil.png') } }))
    for (const page of pages) expect(page.images).toBe(2)
  }, 30_000)

  it('leaves the right side blank for a company without a logo', async () => {
    const pages = await render(pdfInput({ logos: { group: png('./assets/group-logo.png') } }))
    for (const page of pages) {
      expect(page.images).toBe(1)
      expect(page.lines[0]).toBe('福清富群電子有限公司')
    }
  }, 30_000)

  it('draws the Word form’s colors (#78): the red bar and hairline, the titles in black', async () => {
    const pages = await render()
    for (const page of pages) {
      expect(page.fillColors).toContain('#cc0000')
      expect(page.strokeColors).toContain('#cc0000')
      expect(page.fillColors).not.toContain('#8c8c8c')
      expect(page.textByColor.get('#000000')).toContain('福清富群電子有限公司2026年度內部控制制度自行評估問卷表~採購及付款循環')
    }
  }, 30_000)
})

describe('控制要點表（控制活動類）', () => {
  it('prints the paper column headers, each section as a "◆" row and the numbers restarting at 1 per section', async () => {
    const [page] = await render()
    const text = page!.lines.join('\n')
    for (const header of ['控制要點', '自評單位', '內部控制制度設計', '內部控制制度執行情形', '設計、執行有效控制滿意度', '備註說明']) {
      expect(text).toContain(header)
    }
    expect(page!.lines).toContain('◆ 供應商管理作業')
    expect(page!.lines).toContain('◆ 請、採購作業')
    // The number leads the control point's first line.
    expect(text).toMatch(/^2\. 供應商之評估作業是否切實依規定/m)
    expect(text).toMatch(/^1\. 請購前是否先查閱公司現有的資產/m)
  }, 30_000)

  it('prints the section rows in red like the Word form (#78), and nothing else', async () => {
    const [page] = await render()
    expect(page!.textByColor.get('#ff0000')).toBe('◆供應商管理作業◆請、採購作業')
  }, 30_000)

  it('wraps a long control point inside its cell instead of cutting it', async () => {
    const [page] = await render()
    const first = page!.items.find((i) => i.str.startsWith('1. 原物料'))!
    const column = page!.items.filter((i) => Math.abs(i.x - first.x) < 1 && i.y >= first.y)
    const end = column.findIndex((i, n) => n > 0 && /^(\d+\.|◆)/.test(i.str))
    const cell = column.slice(0, end)
    expect(cell.length).toBeGreaterThan(1)
    expect(cell.map((i) => i.str).join('')).toBe(`1. ${LONG_POINT}`)
  }, 30_000)

  it('ticks the answered choice under its column and prints the 改善措施 in 備註說明', async () => {
    const [page] = await render()
    expect(checkedColumns(page!, '1. 原物料')).toEqual(['有內控規範', '是', '滿意'])
    expect(checkedColumns(page!, '2. 供應商之評估')).toEqual(['無內控規範', '否', '需要加強'])
    expect(page!.lines.find((l) => l.startsWith('2. 供應商之評估'))).toContain('每季重新評估一次')
    expect(checkedColumns(page!, '1. 請購前')).toEqual([])
  }, 30_000)
})

describe('內控依據（Q127）', () => {
  it('prints no 內控依據 column: 備註說明 is the last one, as on paper', async () => {
    const pages = await render()
    expect(allText(pages)).not.toContain('內控依據')
    // Nothing in the header rows sits right of the 改善措施 header beyond its own 100pt column.
    const improvement = pages[0]!.items.find((i) => i.str.startsWith('所需採行之改善措施'))!
    const headerRow = pages[0]!.items.filter((i) => Math.abs(i.y - improvement.y) < 30)
    expect(Math.max(...headerRow.map((i) => i.x))).toBeLessThan(improvement.x + 100)
  }, 30_000)
})

/** The page with the 整體結論 and the 簽核欄 (the one before the 簽核歷程 page). */
const signaturePage = (pages: PdfPage[]) => pages.at(-2)!
const itemOf = (page: PdfPage, str: string) => {
  const found = page.items.filter((i) => i.str === str)
  if (found.length !== 1) throw new Error(`${found.length} items "${str}"`)
  return found[0]!
}

describe('一個控制要點多個自評單位（#46）', () => {
  // 04 存貨循環「物料標示與追溯性管理作業」第 2 題：紙本是一個合併的控制要點格，品保、生產、資材各答一列。
  const multi = () => {
    const input = pdfInput()
    const [first, second] = input.assessment.assessment_section
    const tick = (design: 'has_rule' | 'no_rule', execution: 'yes' | 'no', improvement: string | null = null) =>
      ({ design, execution, satisfaction: 'satisfied', improvement }) as const
    return pdfInput({
      assessment: {
        ...input.assessment,
        assessment_section: [
          first!,
          {
            ...second!,
            assessment_control_point: [
              ...second!.assessment_control_point,
              snapshotPoint('p4', 2, '製程階段之物料標示是否依既定之作業程序確實遵循？', [
                ['檢驗單位', tick('has_rule', 'yes')],
                ['生產單位', tick('no_rule', 'no', '標示改由系統列印')],
                ['倉儲單位', null],
              ]),
            ],
          },
        ],
      },
    })
  }

  it('prints the number and text once and gives each 自評單位 its own row with its own ticks and 改善措施', async () => {
    const [page] = await render(multi())
    const text = page!.lines.join('\n')
    expect(text.match(/製程階段之物料標示/g)).toHaveLength(1)
    // The units run 檢驗 → 生產 → 倉儲 down the merged cell, and the text sits in it, centred between the first and last.
    const textStart = page!.items.find((i) => i.str.startsWith('2. 製程階段之物料標示'))!
    const [production, storage] = ['生產單位', '倉儲單位'].map((u) => page!.items.find((i) => i.str === u)!)
    const quality = page!.items.find((i) => i.str === '檢驗單位')!
    expect(quality.y < production!.y && production!.y < storage!.y).toBe(true)
    expect(textStart.y).toBeGreaterThan(quality.y - 10)
    expect(textStart.y).toBeLessThan(storage!.y)
    expect(page!.lines).toContainEqual(expect.stringMatching(/^生產單位 .*標示改由系統列印$/))
    expect(page!.lines).toContain('倉儲單位')
    expect(checkedColumns(page!, '檢驗單位')).toEqual(['有內控規範', '是', '滿意'])
    expect(checkedColumns(page!, '生產單位')).toEqual(['無內控規範', '否', '滿意'])
    expect(checkedColumns(page!, '倉儲單位')).toEqual([])
  }, 30_000)

  it('repeats the 自評單位 on the 「n.（續）」 rows of a 改善措施 longer than a page, so it is clear whose text goes on', async () => {
    const input = multi()
    const [first, second] = input.assessment.assessment_section
    const p4 = second!.assessment_control_point[1]!
    const long = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 項改善說明`).join('\n')
    const withLong = {
      ...p4,
      assessment_control_point_unit: p4.assessment_control_point_unit.map((u) =>
        u.assessing_unit_name === '檢驗單位' ? { ...u, assessment_answer: { ...u.assessment_answer!, improvement: long } } : u,
      ),
    }
    const pages = await render(
      pdfInput({
        assessment: {
          ...input.assessment,
          assessment_section: [first!, { ...second!, assessment_control_point: [second!.assessment_control_point[0]!, withLong] }],
        },
      }),
    )
    const continued = pages.flatMap((p) => p.lines).filter((l) => l.startsWith('2.（續）'))
    expect(continued.length).toBeGreaterThan(0)
    for (const line of continued) expect(line).toMatch(/^2\.（續） 檢驗單位/)
  }, 30_000)

  it('lists the 整體結論 of every 自評單位 that answers a multi-unit control point', async () => {
    const pages = await render(multi())
    expect(allText(pages)).toMatch(/倉儲單位/)
    const last = pages.find((p) => p.lines.some((l) => l.includes('※ 尚屬滿意')))!
    expect(last.lines.join('\n')).toContain('倉儲單位')
  }, 30_000)
})

describe('整體結論', () => {
  it('lists each 自評單位 in paper order under the conclusion it chose, with the 說明', async () => {
    const page = signaturePage(await render())
    const text = page.lines.join('\n')
    expect(text).toContain('整體結論／需採行之改善措施')
    expect(text).toMatch(/※ 尚屬滿意\n✓ 資材單位\n品保單位\n※ 除下列事項外，尚屬滿意\n資材單位 【說明】：\n✓ 品保單位 【說明】：供應商評估頻率不足/)
  }, 30_000)
})

describe('簽核欄', () => {
  it('lays out the 廠區端 and 稽核室覆核 rows right to left like the paper, headed by the 關卡 names', async () => {
    const page = signaturePage(await render())
    expect(page.lines).toContain('廠區經理人 部門主管 自行檢查人員')
    expect(page.lines).toContain('品保單位 資材單位 品保單位 資材單位')
    expect(page.lines).toContain('稽核室覆核')
    expect(page.lines).toContain('稽核主管 台北稽核人員 子公司擔當稽核')
  }, 30_000)

  it('signed through the 3rd 關卡: only the first three cells carry name, time and 簽核記錄編號', async () => {
    const page = signaturePage(await render(pdfInput({ signoffs: [signoff(1, 11), signoff(2, 12), signoff(3, 13)] })))
    const text = page.lines.join('\n')
    for (const n of [1, 2, 3]) {
      expect(text).toContain(`簽核人${n}`)
      expect(text).toContain(`2026-10-16 09:0${n}`)
      expect(text).toContain(`No. ${10 + n}`)
    }
    expect(text).not.toMatch(/簽核人[4-8]/)
    // 關卡 1 自行檢查人員－資材單位 is the rightmost cell, 關卡 3 部門主管－資材單位 sits under its header.
    expect(itemOf(page, '簽核人1').x).toBeGreaterThan(itemOf(page, '簽核人2').x)
    const center = (i: { x: number; width: number }) => i.x + i.width / 2
    const gridTop = itemOf(page, '部門主管').y
    const managerUnit = page.items.filter((i) => i.str === '資材單位' && i.y > gridTop).sort((a, b) => a.x - b.x)[0]!
    expect(Math.abs(center(itemOf(page, '簽核人3')) - center(managerUnit))).toBeLessThan(5)
  }, 30_000)

  it('prints only valid sign-offs: a 關卡 voided by a 退回 is blank until it is signed again', async () => {
    const voided = { voided_at: '2026-10-16T02:00:00+00:00' }
    const page = signaturePage(
      await render(
        pdfInput({
          signoffs: [
            signoff(1, 11),
            signoff(2, 12, voided),
            signoff(3, 13, voided),
            signoff(4, 14, { action: 'return', return_to_position: 2, comment: '品保第 2 題請補改善措施', signed_at: '2026-10-16T02:00:00+00:00' }),
            signoff(2, 15, { signer_name: '重簽的人', signed_at: '2026-10-16T03:00:00+00:00' }),
          ],
        }),
      ),
    )
    const text = page.lines.join('\n')
    expect(text).toContain('簽核人1')
    expect(text).toContain('重簽的人')
    expect(text).toContain('No. 15')
    expect(text).not.toMatch(/簽核人[234]|No\. 1[234]/)
  }, 30_000)
})

describe('不含簽核時間的版本（Q109）', () => {
  const signed = [signoff(1, 11), signoff(2, 12, { voided_at: '2026-10-16T02:00:00+00:00' }), signoff(3, 13), signoff(6, 16)]

  it('prints only the signers’ names in the 簽核欄: no time and no 簽核記錄編號', async () => {
    // Without the 簽核歷程 page, the 簽核欄 is on the last page.
    const page = (await render(pdfInput({ signoffs: signed, withSignedAt: false }))).at(-1)!
    const text = page.lines.join('\n')
    expect(text).toContain('稽核室覆核')
    for (const n of [1, 3, 6]) expect(text).toContain(`簽核人${n}`)
    expect(text).not.toContain('簽核人2')
    expect(text).not.toMatch(/2026-10-16|No\. /)
  }, 30_000)

  it('prints the name larger than the version with times does, in the middle of its cell', async () => {
    const [withTimes, withoutTimes] = await Promise.all([
      render(pdfInput({ signoffs: signed })),
      render(pdfInput({ signoffs: signed, withSignedAt: false })),
    ])
    const small = itemOf(signaturePage(withTimes), '簽核人1')
    const page = withoutTimes.at(-1)!
    const large = itemOf(page, '簽核人1')
    expect(large.width / small.width).toBeCloseTo(NAME_ONLY_FONT_SIZE / SIGNED_CELL_FONT_SIZE, 1)
    // The cell runs from the nearest rule above the name to the nearest below it, across the name's column.
    const across = page.rules.filter((r) => r.x1 < large.x && large.x + large.width < r.x2)
    const top = Math.max(...across.filter((r) => r.y < large.y - NAME_ONLY_FONT_SIZE).map((r) => r.y))
    const bottom = Math.min(...across.filter((r) => r.y > large.y).map((r) => r.y))
    expect(bottom - top).toBeGreaterThanOrEqual(SIGNED_CELL_HEIGHT)
    // A Chinese glyph's middle sits about 0.38 em above its baseline; top- or bottom-aligned it would be ~10pt off.
    expect(Math.abs(large.y - 0.38 * NAME_ONLY_FONT_SIZE - (top + bottom) / 2)).toBeLessThan(1.5)
  }, 30_000)

  it('leaves out the 簽核歷程 page and prints every other page as the version with times does', async () => {
    const [withTimes, withoutTimes] = await Promise.all([
      render(pdfInput({ signoffs: signed })),
      render(pdfInput({ signoffs: signed, withSignedAt: false })),
    ])
    expect(withoutTimes).toHaveLength(withTimes.length - 1)
    expect(allText(withoutTimes)).not.toContain('簽核歷程')
    expect(allText(withoutTimes)).not.toContain('簽核記錄編號')
    // Page by page without the 「n / N」 footer: the 簽核欄 page differs only by the lines of times and numbers.
    const body = (page: PdfPage) => page.lines.slice(0, -1)
    const timesLeftOut = (line: string) => line.replace(/ ?(2026-10-16 \d\d:\d\d|No\. \d+)/g, '')
    expect(withoutTimes.map(body)).toEqual(
      withTimes.slice(0, -1).map((page, i) => (i < withoutTimes.length - 1 ? body(page) : body(page).map(timesLeftOut).filter((l) => l !== ''))),
    )
  }, 30_000)
})

describe('簽核歷程頁', () => {
  it('lists every 簽核紀錄 in time order on its own last page, voided ones and the 退回 included', async () => {
    const voided = { voided_at: '2026-10-16T02:00:00+00:00' }
    const pages = await render(
      pdfInput({
        signoffs: [
          signoff(2, 12, voided),
          signoff(1, 11, voided),
          signoff(3, 13, { action: 'return', return_to_position: 1, comment: '資材第 1 題請補改善措施', signed_at: '2026-10-16T02:00:00+00:00' }),
          signoff(1, 14, { signed_at: '2026-10-16T03:00:00+00:00' }),
        ],
      }),
    )
    const lines = pages.at(-1)!.lines
    expect(lines[2]).toBe('簽核歷程')
    expect(lines).toContain('簽核記錄編號 時間 關卡 簽核人 動作 意見／原因 狀態')
    const rows = lines.filter((l) => /^1[1-4] /.test(l))
    // 關卡 by unit and name, no 「第 N 關」 (#99); a 退回 names where it went on the line below.
    expect(rows).toEqual([
      '11 2026-10-16 09:01 資材單位・自行檢查人員 簽核人1（E1） 送出 作廢',
      '12 2026-10-16 09:02 品保單位・自行檢查人員 簽核人2（E2） 送出 作廢',
      '13 2026-10-16 10:00 資材單位・部門主管 簽核人3（E3） 退回 資材第 1 題請補改善措施',
      '14 2026-10-16 11:00 資材單位・自行檢查人員 簽核人1（E1） 送出 有效',
    ])
    expect(lines[lines.indexOf(rows[2]!) + 1]).toBe('至 資材單位・自行檢查人員')
  }, 30_000)

  it('says so when nothing has been signed yet', async () => {
    const pages = await render()
    expect(pages.at(-1)!.lines).toContain('還沒有任何簽核紀錄')
  }, 30_000)
})

describe('要素類', () => {
  const element = () => {
    const input = pdfInput()
    const unit = '稽核室'
    return pdfInput({
      assessment: {
        ...input.assessment,
        template_name: '控制環境',
        template_layout: 'element',
        assessment_section: [
          {
            id: 'e1',
            position: 1,
            level: 1,
            code: null,
            name: '（一）高階管理階層應重視誠信與道德價值',
            assessment_control_point: [
              snapshotPoint('ep1', 1, '是否建立內部行為準則包括員工行為準則等規範？', [
                [unit, { design: null, execution: 'no', satisfaction: 'needs_improvement', improvement: '尚未發布' }],
              ]),
            ],
          },
        ],
        assessment_conclusion: [{ assessing_unit_name: unit, conclusion: 'satisfied_except', exceptions: '行為準則待發布' }],
      },
    })
  }

  it('prints 評估結果 是／否／不適用 with 補充說明 and no 自評單位 column, like the paper A~控制環境', async () => {
    const [page] = await render(element())
    const text = page!.lines.join('\n')
    expect(text).toContain('評估結果')
    expect(text).not.toContain('自評單位')
    expect(text).not.toContain('內部控制制度設計')
    expect(page!.lines).toContain('（一）高階管理階層應重視誠信與道德價值')
    expect(page!.textByColor.get('#ff0000')).toBe('（一）高階管理階層應重視誠信與道德價值')
    expect(checkedColumns(page!, '1. 是否建立')).toEqual(['否', '需要加強'])
    expect(page!.lines.find((l) => l.startsWith('1. 是否建立'))).toContain('尚未發布')
  }, 30_000)

  it('has a single 整體結論 without unit names', async () => {
    const page = signaturePage(await render(element()))
    expect(page.lines.join('\n')).toMatch(/尚屬滿意\n✓ 除下列事項外，尚屬滿意\n說明：行為準則待發布/)
  }, 30_000)
})

describe('簽章接縫 (🔴 OPEN-1)', () => {
  it('方案A puts no digital signature on the file: the sign-offs are system records printed on it', async () => {
    const bytes = await renderAssessmentPdf(pdfInput(), engine)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  }, 30_000)

  it('hands the finished PDF to a digital-signature step and returns its result, for a later server signature', async () => {
    const seen: Uint8Array[] = []
    const signed = new Uint8Array([1, 2, 3])
    const result = await renderAssessmentPdf(pdfInput(), engine, async (pdf) => {
      seen.push(pdf)
      return signed
    })
    expect(result).toBe(signed)
    expect((await readPdf(seen[0]!))[0]!.lines[0]).toBe('福清富群電子有限公司')
  }, 30_000)
})

describe('中文字型', () => {
  it('embeds every font it uses (a Noto Sans TC subset), so the PDF reads the same where no Chinese font is installed', async () => {
    const raw = Buffer.from(await renderAssessmentPdf(pdfInput(), engine)).toString('latin1')
    const fonts = [...raw.matchAll(/\/BaseFont \/([^\s/>]+)/g)].map((m) => m[1])
    expect(fonts.length).toBeGreaterThan(0)
    for (const font of fonts) expect(font).toMatch(/^[A-Z]{6}\+NotoSansTC-Regular$/)
    expect(raw.match(/\/FontFile2 /g)?.length).toBe(new Set(fonts).size)
  }, 30_000)
})

describe('長文字不被截斷', () => {
  // One character per field, so wrapping and page breaks can split the text anywhere and the count still says
  // whether every character made it onto some page.
  const count = (pages: PdfPage[], ch: string) => pages.flatMap((p) => p.items).reduce((n, i) => n + [...i.str].filter((c) => c === ch).length, 0)

  const withImprovement = (p: AssessmentControlPoint, improvement: string): AssessmentControlPoint => ({
    ...p,
    assessment_control_point_unit: p.assessment_control_point_unit.map((u) => ({ ...u, assessment_answer: { ...u.assessment_answer!, improvement } })),
  })

  it('prints every character of a 改善措施, 整體結論說明 or 退回原因 longer than a page', async () => {
    const input = pdfInput()
    const [first, second] = input.assessment.assessment_section
    const point = first!.assessment_control_point[1]!
    const pages = await render(
      pdfInput({
        assessment: {
          ...input.assessment,
          assessment_section: [
            { ...first!, assessment_control_point: [first!.assessment_control_point[0]!, withImprovement(point, '鑫'.repeat(900))] },
            second!,
          ],
          assessment_conclusion: [
            { assessing_unit_name: '資材單位', conclusion: 'satisfied', exceptions: null },
            { assessing_unit_name: '品保單位', conclusion: 'satisfied_except', exceptions: '淼'.repeat(3000) },
          ],
        },
        signoffs: [signoff(1, 11), signoff(3, 12, { action: 'return', return_to_position: 1, comment: '焱'.repeat(2500) })],
      }),
    )
    expect(count(pages, '鑫')).toBe(900)
    expect(count(pages, '淼')).toBe(3000)
    expect(count(pages, '焱')).toBe(2500)
  }, 60_000)
})

describe('關卡名稱的分隔符號', () => {
  it('groups the 簽核欄 header the same when a 關卡 name uses a half-width "-" or a dash instead of "－"', async () => {
    const input = pdfInput()
    const separators = ['-', '—', '–', '－']
    const steps = input.assessment.assessment_step.map((s, i) => ({ ...s, name: s.name.replace('－', separators[i % separators.length]!) }))
    const page = signaturePage(await render(pdfInput({ assessment: { ...input.assessment, assessment_step: steps } })))
    expect(page.lines).toContain('廠區經理人 部門主管 自行檢查人員')
    expect(page.lines).toContain('品保單位 資材單位 品保單位 資材單位')
  }, 30_000)

  it('takes a cell’s unit from its 分流, not from the name (#99): an added 課長 sits over its unit, a dashed name after the 匯流 stays whole', async () => {
    const input = pdfInput()
    const [self1, self2, head1, head2, manager, ...audit] = input.assessment.assessment_step
    const steps = [
      self1!, self2!, head1!, head2!,
      { ...head2!, id: 'step-chief', name: '課長' },
      manager!,
      { ...manager!, id: 'step-vp', name: '副總－台北' },
      ...audit,
    ].map((s, i) => ({ ...s, position: i + 1 }))
    const page = signaturePage(await render(pdfInput({ assessment: { ...input.assessment, assessment_step: steps } })))
    expect(page.lines).toContain('副總－台北 廠區經理人 課長 部門主管 自行檢查人員')
    expect(page.lines).toContain('品保單位 品保單位 資材單位 品保單位 資材單位')
  }, 30_000)
})

describe('章節列不落單', () => {
  it('never leaves a section row at the bottom of a page without its first control point', async () => {
    const input = pdfInput()
    const [first, second] = input.assessment.assessment_section
    const filler = first!.assessment_control_point[1]!
    // Grow the first section one control point at a time, so that at some count the next section row falls on
    // the last line of a page.
    for (let n = 10; n <= 40; n++) {
      const points = Array.from({ length: n }, (_, i) => ({ ...filler, id: `f${i}`, position: i + 1 }))
      const pages = await render(
        pdfInput({ assessment: { ...input.assessment, assessment_section: [{ ...first!, assessment_control_point: points }, second!] } }),
      )
      for (const page of pages) {
        for (const section of page.items.filter((i) => i.str.startsWith('◆'))) {
          const firstPoint = page.items.find((i) => i.str.startsWith('1. ') && i.y > section.y)
          expect(firstPoint, `${n} points: ${section.str} is alone at the bottom of a page`).toBeDefined()
        }
      }
    }
  }, 120_000)
})

describe('簽核欄不拆頁', () => {
  it('keeps the 廠區端 and 稽核室覆核 rows of the 簽核欄 on one page, however long the 整體結論 above them runs', async () => {
    const input = pdfInput()
    // Grow the 整體結論 one line at a time, so that at some length the two 簽核欄 rows straddle a page break.
    for (let n = 1; n <= 40; n++) {
      const exceptions = Array.from({ length: n }, (_, i) => `第 ${i + 1} 項例外說明`).join('\n')
      const pages = await render(
        pdfInput({
          assessment: {
            ...input.assessment,
            assessment_conclusion: [
              { assessing_unit_name: '資材單位', conclusion: 'satisfied', exceptions: null },
              { assessing_unit_name: '品保單位', conclusion: 'satisfied_except', exceptions },
            ],
          },
        }),
      )
      const audit = pages.findIndex((p) => p.lines.some((l) => l.includes('稽核室覆核')))
      const plant = pages.findIndex((p) => p.lines.some((l) => l.includes('廠區經理人')))
      expect(audit, `${n} lines of 說明: the 稽核室覆核 row is on another page than the 廠區端 row`).toBe(plant)
    }
  }, 180_000)
})

describe('多單位控制要點的列等高（#46）', () => {
  const LONG = '如為保稅原物料，是否除按規定補繳稅額或向海關辦理備案並同意外，應遵守法律法規之規定，不得私自以調撥方式將保稅物料任意調往他處？'
  const UNITS = ['甲單位', '乙單位', '丙單位']
  const withPoints = (fillers: number) => {
    const input = pdfInput()
    const [first] = input.assessment.assessment_section
    const filler = first!.assessment_control_point[1]!
    return pdfInput({
      assessment: {
        ...input.assessment,
        assessment_section: [
          {
            ...first!,
            assessment_control_point: [
              ...Array.from({ length: fillers }, (_, i) => ({ ...filler, id: `f${i}`, position: i + 1 })),
              snapshotPoint('m', fillers + 1, LONG, UNITS.map((u) => [u, null] as [string, null])),
            ],
          },
        ],
      },
    })
  }

  it('shares the merged cell evenly: every 自評單位 row of a control point is as tall as the others, as on paper', async () => {
    const [page] = await render(withPoints(1))
    const ys = UNITS.map((u) => page!.items.find((i) => i.str === u)!.y)
    const [a, b] = [ys[1]! - ys[0]!, ys[2]! - ys[1]!]
    expect(Math.abs(a - b), `row pitch ${a.toFixed(1)} then ${b.toFixed(1)}`).toBeLessThan(1)
  }, 30_000)

  it('keeps the merged cell whole at a page break: the text and every 自評單位 row move to the next page together', async () => {
    // Push the control point down one row at a time, so that at some count it meets the end of a page.
    for (let n = 10; n <= 30; n++) {
      const pages = await render(withPoints(n))
      const page = pages.find((p) => p.items.some((i) => i.str.startsWith(`${n + 1}. `)))!
      const text = page.items.map((i) => i.str).join('')
      expect([...LONG].every((c) => text.includes(c)), `${n} fillers: the text is split across pages`).toBe(true)
      for (const u of UNITS) expect(text, `${n} fillers: ${u} is on another page than its control point`).toContain(u)
      // Nothing of the cell spills below the table's last rule onto the page footer.
      const footer = page.items.find((i) => /^\d+ \/ \d+$/.test(i.str))!
      expect(page.items.filter((i) => i.y > footer.y - 30 && i.str !== footer.str), `${n} fillers: text runs into the footer`).toEqual([])
    }
  }, 180_000)
})

describe('多層章節與原檔題號（#166）', () => {
  const unit = '研發單位'
  const ticked = { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null } as const
  const coded = (code: string, p: AssessmentControlPoint): AssessmentControlPoint => ({ ...p, code })
  const section = (id: string, position: number, level: number, code: string | null, name: string, points: AssessmentControlPoint[] = []) => ({
    id,
    position,
    level,
    code,
    name,
    assessment_control_point: points,
  })
  const withSections = (layout: 'control_activity' | 'element', sections: ReturnType<typeof section>[]) => {
    const input = pdfInput()
    return pdfInput({ assessment: { ...input.assessment, template_layout: layout, assessment_section: sections } })
  }

  it('prints a 第一層 once with ◆, its 分段 set in under it, and numbers the control points 1–n over the card (研發循環)', async () => {
    const [page] = await render(
      withSections('control_activity', [
        section('a', 1, 1, null, '新產品導入管制作業'),
        section('b', 2, 2, null, '估價階段', [snapshotPoint('b1', 1, '是否提報報價？', [[unit, ticked]])]),
        section('c', 3, 2, null, 'DVT(設計驗證測試階段)'),
        section('d', 4, 3, null, '開模通知', [
          snapshotPoint('d1', 1, '是否發出開模通知？', [[unit, ticked]]),
          snapshotPoint('d2', 2, '是否召開說明會？', [[unit, ticked]]),
        ]),
        section('e', 5, 1, null, '工程變更作業', [snapshotPoint('e1', 1, '是否提出工程變更？', [[unit, ticked]])]),
      ]),
    )
    const lines = page!.lines
    expect(lines.filter((l) => l.includes('新產品導入管制作業'))).toEqual(['◆ 新產品導入管制作業'])
    for (const row of ['估價階段', 'DVT(設計驗證測試階段)', '開模通知', '◆ 工程變更作業']) expect(lines).toContain(row)
    expect(lines.some((l) => l.includes('／'))).toBe(false)
    for (const printed of ['1. 是否提報報價？', '2. 是否發出開模通知？', '3. 是否召開說明會？', '1. 是否提出工程變更？']) {
      expect(lines.some((l) => l.startsWith(printed))).toBe(true)
    }
    // The 分段 rows are set in from the 第一層's, a 第三層 further.
    const x = (str: string) => page!.items.find((i) => i.str.startsWith(str))!.x
    expect(x('估價階段')).toBeGreaterThan(x('◆ 新產品導入管制作業'))
    expect(x('開模通知')).toBeGreaterThan(x('估價階段'))
  }, 30_000)

  it('prints the paper’s 題號 before section names and control points instead of a second number (台北總公司 A)', async () => {
    const answered = { ...ticked, design: null }
    const [page] = await render(
      withSections('element', [
        section('a', 1, 1, '1', '董事會應重視誠信與道德價值。'),
        section('b', 2, 2, '1.1', '公司是否建立內部行為準則？', [coded('1.1.1-1', snapshotPoint('b1', 1, '公司是否建立董事行為準則？', [[unit, answered]]))]),
        section('c', 3, 2, '1.2.', '組織成員往來是否符合誠信？', [coded('1.2.1', snapshotPoint('c1', 1, '是否建立誠信標準？', [[unit, answered]]))]),
      ]),
    )
    const lines = page!.lines
    for (const row of ['1 董事會應重視誠信與道德價值。', '1.1 公司是否建立內部行為準則？', '1.2. 組織成員往來是否符合誠信？']) expect(lines).toContain(row)
    expect(lines.some((l) => l.startsWith('1.1.1-1 公司是否建立董事行為準則？'))).toBe(true)
    expect(lines.some((l) => l.startsWith('1.2.1 是否建立誠信標準？'))).toBe(true)
    expect(lines.some((l) => /^[12]\. /.test(l))).toBe(false)
  }, 30_000)
})

describe('控制要點的換行（#170）', () => {
  it('prints a control point’s note and list items on lines of their own, as on paper', async () => {
    const input = pdfInput()
    const [first] = input.assessment.assessment_section
    const note = snapshotPoint('n1', 1, '銷貨單據是否序時序號連續開立？\n(若客戶端採上線模式始確認銷貨者，另應含括上線單據)', [
      ['資材單位', { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
    ])
    const list = snapshotPoint('n2', 2, '是否評估下列暴險，包括：\n· 企業策略目標之達成。\n· 資產之保全。', [
      ['資材單位', { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
    ])
    const [page] = await render(
      pdfInput({ assessment: { ...input.assessment, assessment_section: [{ ...first!, assessment_control_point: [note, list] }] } }),
    )
    const lines = page!.lines
    const at = (start: string) => lines.findIndex((l) => l.startsWith(start))
    expect(at('1. 銷貨單據是否序時序號連續開立？')).toBeGreaterThanOrEqual(0)
    expect(at('(若客戶端採上線模式')).toBeGreaterThan(at('1. 銷貨單據是否序時序號連續開立？'))
    expect(at('· 企業策略目標之達成。')).toBeGreaterThan(at('2. 是否評估下列暴險，包括：'))
    expect(at('· 資產之保全。')).toBeGreaterThan(at('· 企業策略目標之達成。'))
  }, 30_000)
})
