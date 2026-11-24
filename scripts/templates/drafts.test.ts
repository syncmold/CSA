// 進版控的草稿定義檔（supabase/drafts/templates/）本身的檢查：章節分層的形狀，以及 #166（Q125）拆成分層＋題號的
// 範本接回去和拆之前逐字相同。
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DraftTemplate } from './render.ts'

const DRAFTS = join(import.meta.dirname, '..', '..', 'supabase', 'drafts', 'templates')
const drafts: DraftTemplate[] = readdirSync(DRAFTS, { recursive: true })
  .filter((f) => String(f).endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(DRAFTS, String(f)), 'utf8')) as DraftTemplate)

/**
 * 拆之前（20261125000000 的 migration 之前）各份的內容雜湊：每章一行「上層／下層」名稱，接著每題一行（前面兩個空白），
 * 題號與文字之間的空白不算（Q125 不保留）。原檔改了、重新轉檔後這裡會對不上，屆時把那一份刪掉。
 */
const BEFORE_Q125: Record<string, string> = {
  'CF-10.1': 'ca73c0a6579099008ab40b2842a96359682c540d41ad51fc41f20833ebeb8589',
  'FF-10.1': '14fa5aeb79fd7bec8872040cfc6982dee6459006ab3922a138462335dd92c72f',
  'FQ-10.1': '23783bddb3860df043df0b80ed56741350532f8cb37ece4b44ac8f45e7c8740d',
  'GH-10.2': 'e477ccc0618ecb8abe0a0749716ae9736bd95c1343ad39304f42410d6b0b3ef5',
  'GT-05': '2365c8547c7f25d2de8c0f2b92a329bd98a3b95cc8aab7bcc47b3475cbe97c63',
  'JS-10.1': 'cef1371353a3e3d00d3871e99315b1a031a907b4ed87ec32d1cd1c00db4fdc1f',
  'LH-05.1': '9f45aff0472771fcd125cfae008adc3b773c44e6c86e6507d133aaf7a51f3457',
  'LS-5.1': '7fe0ec0a0ac2699ca49912a546afc98597f74262546f6daa60e2d0f3f2c36894',
  'SAMOA-01': 'e22fe424d7111361d5ed98404fae90794a02d1bd159be8d3862a85f7afb0cf4e',
  'SAMOA-02': '88471be5887b69769605541999bde8370dd66b6af41098758bb0a10ea9f21b3a',
  'SF-10.1': 'd5cf2336791ecbbc664a497ee493ce52db3249faafa9672f24a84e1e72c59d17',
  'SH-05': '98ee6fec7a0c161aa105868e3b94fccc0dfd4c4b9fe5458bdb11ec49b8873b69',
  'SY-05': '361d53d18b5227d567145a953577721e9869d344436b2b53b7879f1a80c6ec3d',
  'SY-08': '8d0d7abcc3bf2c3c5f806c9a057d3789abaf27ddf484e191415540b97fa3097a',
  'SY-A': '7d9682af2d77108d1b0e662d9e72d72f1e85ee70621fd422dc2c9618c370d4d8',
  'SY-B': '973ef2a3a8fbf2d40eed9a00bdc6c207c037e8689c780e2240b7fe1bf75d47c5',
  'SY-C': '2349f2ee047e99f8b022104bc65cb779925c87f797c31fe96a5a818d92de4d94',
  'SY-D': 'e29f9f4c3c42cbe0bc2d7289fdf76348cbb88262a26f44dd30b467a55f699d88',
  'TC-05': 'd328306b8b7b29dc886048ace3387710dd31d5cc048b580be8c118444e621bd1',
  'VN-10.1': 'c51891336fffc9d98849aef4d61287575b97ba16622d15dd05d57614bfd3820b',
}

/** 題號不在原檔文字裡、是轉檔照紙本的 Word 自動編號寫進去的（SAMOA，Q125）：接回去時不算。 */
const NUMBERED_FROM_WORD = ['SAMOA-01', 'SAMOA-02']

/** 原檔在詞中間打空白硬湊換行、#170 接回詞的控制要點（VN-10.1，Q126）：接回後的文字 → 之前留著空白的文字。 */
const JOINED_BY_Q126: Record<string, Record<string, string>> = {
  'VN-10.1': {
    '模具的設計變更是否依作業規定填寫「修模檢討報告」與廠區及供應商確認後進行修模？': '模具的設計變更是否依作業規定填寫「修模檢討報    告」與廠區及供應商確認後進行修模？',
    '模具的驗收是否依作業規定提出「模具驗收單」由工程相關人員確認？': '模具的驗收是否依作業規定提出「模具驗收單」由工   程相關人員確認？',
  },
}

/**
 * #170 之前的控制要點文字：一格裡的換行（條列項前面留的「·」）拿掉、接回的詞還原成留著空白的寫法（Q126）；之前是接成
 * 一行的。
 */
function before170(code: string, text: string): string {
  return JOINED_BY_Q126[code]?.[text] ?? text.replace(/\n(· )?/g, '')
}

/** 分層＋題號 → 拆之前的寫法：有控制要點的章節接上它的上層標題，題號接在名稱與文字前面。 */
function beforeQ125(def: DraftTemplate): string {
  const withCode = (code: string | undefined, text: string) => (NUMBERED_FROM_WORD.includes(def.code) ? '' : (code ?? '')) + before170(def.code, text)
  const path: string[] = []
  return def.sections
    .flatMap((s) => {
      path.splice((s.level ?? 1) - 1, path.length, (s.code ?? '') + s.name)
      return s.controlPoints.length ? [path.join('／'), ...s.controlPoints.map((p) => `  ${withCode(p.code, p.text)}`)] : []
    })
    .join('\n')
}

describe('草稿定義檔的章節分層（Q125）', () => {
  it.each(drafts.map((d) => [d.code, d] as const))('%s：第一章是第 1 層，往下一次深一層，只當上層標題的章節後面接著下一層', (_, def) => {
    const levels = def.sections.map((s) => s.level ?? 1)
    levels.forEach((level, i) => {
      expect(level).toBeLessThanOrEqual((levels[i - 1] ?? 0) + 1)
      if (def.sections[i]!.controlPoints.length === 0) expect(levels[i + 1] ?? 0).toBeGreaterThan(level)
    })
  })

  it.each(Object.entries(BEFORE_Q125))('%s 接回去和拆之前逐字相同', (code, hash) => {
    const def = drafts.find((d) => d.code === code)
    expect(def).toBeDefined()
    expect(createHash('sha256').update(beforeQ125(def!)).digest('hex')).toBe(hash)
  })

  it('沒有分層、沒有題號的範本不受影響（SF-A 等）', () => {
    const plain = drafts.filter((d) => !(d.code in BEFORE_Q125))
    expect(plain.length).toBe(drafts.length - Object.keys(BEFORE_Q125).length)
    for (const def of plain) {
      expect(def.sections.every((s) => !s.level && !s.code && s.controlPoints.every((p) => !p.code))).toBe(true)
    }
  })
})

/**
 * #170 之前全部草稿的控制要點（依編號排序，一題一行「編號 題號 文字」）的雜湊。原檔改了、重新轉檔後這裡會對不上，
 * 屆時重算。
 */
const BEFORE_Q126 = '59ae5cc05d3a91b68b1e8c70c6f7e3808e3cb35773757a1680084c22f9e6ae14'

describe('控制要點的換行（Q126）', () => {
  const points = [...drafts]
    .sort((a, b) => (a.code < b.code ? -1 : 1))
    .flatMap((d) => d.sections.flatMap((s) => s.controlPoints.map((p) => ({ code: d.code, item: p.code ?? '', text: p.text }))))

  it('only breaks a line after a finished sentence: a question, a full stop, a colon or a closing bracket', () => {
    const broken = points.filter((p) => p.text.includes('\n'))
    expect(broken.length).toBe(53)
    for (const p of broken) {
      for (const line of p.text.split('\n').slice(0, -1)) expect(line, `${p.code}：${p.text}`).toMatch(/[？?。：:）)]$/)
    }
  })

  it('keeps every other character: without the line breaks (and with the two words of VN-10.1 split again) it is as before', () => {
    const lines = points.map((p) => `${p.code} ${p.item} ${before170(p.code, p.text)}`)
    expect(createHash('sha256').update(lines.join('\n')).digest('hex')).toBe(BEFORE_Q126)
  })

  it('keeps the bullets of a list inside a cell (SY-D 1.7.2-1)', () => {
    const point = points.find((p) => p.code === 'SY-D' && p.item === '1.7.2-1')!
    expect(point.text.split('\n')).toEqual([
      '內部稽核單位是否評估與企業之治理、營運及資訊系統有關之暴險，包括：',
      '· 企業策略目標之達成。',
      '· 財務及營運資訊之可靠性及完整性。',
      '· 營運及計畫之效果及效率。',
      '· 資產之保全。',
      '· 法令、政策、程序及契約之遵循。',
    ])
  })
})
