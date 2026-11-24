// npm run templates:spot-check [-- --env <快照.json>] [--json <結果.json>] [--plant <廠區代碼>]
//
// 獨立核對轉檔結果（#84 驗收條件 2、#207）：每一份草稿定義檔都拿它自己的 Word 原檔比，不分組、不抽樣——不同廠區的
// 同一張表也分開比。請 Word 把原檔另存成純文字與頁首文字，不經過 html.ts／parse.ts，逐一確認：
//   - 抬頭：編號＝廠區代碼-檔名的紙本編號、名稱與組成要素照檔名、適用廠區只有該廠、頁首的公司名稱＝legal-names.json（#83）
//   - 章節名稱依序找得到（多層的每一層都是一個章節，Q125；題號在名稱前面，只找名稱）
//   - 控制要點文字依序找得到，每個自評單位（原檔的任一種寫法）出現在這題之後、下一題之前；找到的是哪一種寫法記下來，
//     列出原檔寫法 → CSA 單位的對應（UNIT_MAPPING）
//   - 原檔的問號數＝定義檔章節名稱與控制要點文字裡的問號數（漏掉或多出一題都會對不上）
// 比對時去掉所有空白（純文字的表格以 tab 與換行分格）。需要本機有 Microsoft Word。
//
// --env：環境上範本內容的快照（{ templates: [{ code, name, layout, status, factory_codes, sections }] }，sections 與定義檔
//        同形狀），逐份列出和定義檔不同的地方；定義檔沒有、環境才有的範本（FQ-02 是種子 migration）直接拿環境的內容比原檔。
// --json：每份的結果寫成 JSON（核對清單用）。
// 「待確認」不算失敗：有「待指定單位」、沒有廠區代碼（SAMOA）的照原樣列出，不自己補（#207）。要素類原檔沒有單位欄，
// 整份掛的單位是使用者決定的（ELEMENT_UNITS），不在原檔裡找。
// 和原檔對不上（找不到章節、控制要點、自評單位，問號數不同，抬頭不符）才算失敗。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTemplateFileName } from './parse.ts'
import { defaultSourceRoot, ELEMENT_UNITS, PLANTS, SPLIT_02, UNIT_MAPPING, UNIT_TO_BE_ASSIGNED } from './sources.mjs'
import { saveAs } from './word.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DRAFTS = join(REPO, 'supabase', 'drafts', 'templates')
const LEGAL_NAMES = JSON.parse(readFileSync(join(REPO, 'scripts', 'master', 'legal-names.json'), 'utf8'))
/** 待指定單位改掛的單位（assigned-units.json，#207）：原檔沒有這幾個字，不在原檔裡找。 */
const ASSIGNED_UNITS = JSON.parse(readFileSync(join(REPO, 'scripts', 'templates', 'assigned-units.json'), 'utf8')).templates
/** 檔名讀不出名稱、轉檔照紙本寫法另給的（convert.mjs 的 TEMPLATES.name）。 */
/**
 * 頁首的公司名稱和同廠其他原檔不同、已決定照多數的（legal-names.json 是多數的寫法）：範本編號 → 原檔頁首的寫法。
 * TC-03.1 寫「科技有限公司」、TC 其他 14 份寫「科技股份有限公司」，使用者 2026-11-19 決定統一用多數（#83、Q138）。
 */
const COMPANY_HEADER_VARIANTS = { 'TC-03.1': '敬得(蘇州)科技有限公司' }
const NAME_OVERRIDES = {
  'SAMOA-01': '銷售及收款循環、採購及付款循環',
  'SAMOA-02': '投資循環、融資循環、內部管理控制制度',
}

const args = process.argv.slice(2)
const option = (flag) => {
  const i = args.indexOf(flag)
  return i < 0 ? undefined : args[i + 1]
}
const envFile = option('--env')
const jsonFile = option('--json')
const onlyPlant = option('--plant')?.toUpperCase()

// 另存純文字時 Word 把彎引號、破折號、刪節號換成半形（”產品開發申請單” → "產品開發申請單"、– → -、… → ...），
// 兩邊一起換；格子裡的項目符號印成「*」，定義檔裡第二段以後的條列項留著「·」（Q126），比對時都拿掉。
const squeeze = (text) =>
  text
    .replace(/…/g, '...')
    .replace(/[*•·]/g, '')
    .replace(/[\s 　]/g, '')
    .replace(/[“”〝〞＂]/g, '"')
    .replace(/[‘’＇]/g, "'")
    .replace(/[–—－‐]/g, '-')
const questionMarks = (text) => (text.match(/[?？]/g) ?? []).length

/** 系統的單位名稱 → 原檔可能的寫法（含名稱本身）。 */
const spellings = new Map()
for (const [written, mapped] of Object.entries(UNIT_MAPPING)) {
  for (const unit of [mapped].flat()) spellings.set(unit, [...(spellings.get(unit) ?? [unit]), written])
}
const spellingsOf = (unit) => spellings.get(unit) ?? [unit]

/** 一個廠區資料夾裡的原檔：紙本編號（含同編號時的區分）→ 檔名。 */
function sourcesOf(plant) {
  const dir = join(defaultSourceRoot(), plant.dir)
  const files = readdirSync(dir).filter((f) => /\.docx?$/i.test(f) && !f.startsWith('~$'))
  const infos = files.map((file) => ({ file, info: parseTemplateFileName(file) }))
  return infos.map(({ file, info }) => {
    const twins = infos.filter((x) => x.info.code === info.code).length
    const code = `${plant.code}-${info.code}${twins > 1 ? `-${info.variant}` : ''}`
    return { code, file, info, path: join(dir, file) }
  })
}

const plants = onlyPlant ? PLANTS.filter((p) => p.code === onlyPlant) : PLANTS
const sources = plants.flatMap((plant) => sourcesOf(plant).map((s) => ({ ...s, plant })))
const drafts = new Map(
  readdirSync(DRAFTS, { recursive: true })
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const def = JSON.parse(readFileSync(join(DRAFTS, f), 'utf8'))
      return [def.code, def]
    }),
)
const env = envFile ? new Map(JSON.parse(readFileSync(envFile, 'utf8')).templates.map((t) => [t.code, t])) : null

const texts = await saveAs(
  sources.map((s) => s.path),
  'txt',
)
const headers = await saveAs(
  sources.map((s) => s.path),
  'header',
)
const read = (file) => readFileSync(file, 'utf8').replace(/^﻿/, '')

/** 環境的範本 → 定義檔的形狀。 */
const fromEnv = (t) => ({
  code: t.code,
  name: t.name,
  layout: t.layout,
  factoryCodes: t.factory_codes,
  sections: t.sections.map((s) => ({
    ...(s.level ? { level: s.level } : {}),
    ...(s.code ? { code: s.code } : {}),
    name: s.name,
    controlPoints: s.controlPoints.map((p) => ({ ...(p.code ? { code: p.code } : {}), text: p.text, assessingUnits: p.assessingUnits })),
  })),
})

/** 內容和原檔比：回傳問題清單與原檔寫法 → 單位的對應。 */
function checkBody(def, doc) {
  const problems = []
  const spelled = new Map()
  let cursor = 0
  const points = def.sections.flatMap((s) => s.controlPoints)
  let pointIndex = 0
  for (const section of def.sections) {
    const own = squeeze(section.name)
    // 沒有章節列的原檔，轉檔以範本名稱當章節名稱，原檔表格裡沒有這幾個字。
    if (!(def.sections.length === 1 && section.name === def.name)) {
      const at = doc.indexOf(own, cursor)
      if (at < 0) problems.push(`找不到章節「${section.name}」`)
      else cursor = at + own.length
    }
    for (const point of section.controlPoints) {
      // 轉檔接回的一題（Q79），原檔是兩列、中間隔著自評單位與答題欄：分兩段依序找。
      const joined = point.text === SPLIT_02.first + SPLIT_02.second
      const text = squeeze(joined ? SPLIT_02.second : point.text)
      const firstHalf = joined ? doc.indexOf(squeeze(SPLIT_02.first), cursor) : cursor
      const at = firstHalf < 0 ? -1 : doc.indexOf(text, firstHalf)
      pointIndex++
      if (at < 0) {
        problems.push(`找不到控制要點「${point.text}」`)
        continue
      }
      cursor = at + text.length
      const next = points[pointIndex] ? doc.indexOf(squeeze(points[pointIndex].text), cursor) : doc.length
      let unitCursor = cursor
      // 暫定單位（待指定單位）、要素類整份掛的單位、對照檔帶入的單位，原檔裡沒有這幾個字，不找。
      const notInSource = new Set([
        UNIT_TO_BE_ASSIGNED,
        ...(def.layout === 'element' ? Object.values(ELEMENT_UNITS) : []),
        ...(ASSIGNED_UNITS[def.code]?.[point.text]?.units ?? []),
      ])
      for (const unit of point.assessingUnits.filter((u) => !notInSource.has(u))) {
        const found = spellingsOf(unit)
          .map((s) => ({ s, i: doc.indexOf(squeeze(s), unitCursor) }))
          .filter(({ i }) => i >= 0 && (next < 0 || i < next))
          .sort((a, b) => a.i - b.i || b.s.length - a.s.length)
        if (found.length === 0) {
          problems.push(`控制要點「${point.text}」後面找不到自評單位「${unit}」`)
          continue
        }
        unitCursor = found[0].i
        const key = found[0].s
        spelled.set(key, [...new Set([...(spelled.get(key) ?? []), unit])])
      }
    }
  }
  const expected = def.sections.reduce((n, s) => n + questionMarks(s.name) + s.controlPoints.reduce((m, p) => m + questionMarks(p.text), 0), 0)
  const actual = questionMarks(doc)
  if (actual !== expected) problems.push(`原檔有 ${actual} 個問號，定義檔有 ${expected} 個`)
  return { problems, unitSpellings: Object.fromEntries([...spelled].map(([w, u]) => [w, u.join('、')])) }
}

/** 抬頭和檔名、頁首比。 */
function checkHeader(def, source, headerText) {
  const { plant, info } = source
  const problems = []
  if (def.code !== source.code) problems.push(`編號是 ${def.code}，檔名對應的是 ${source.code}`)
  const name = NAME_OVERRIDES[source.code] ?? (info.variant ? `${info.name}（${info.variant}）` : info.name)
  if (def.name !== name) problems.push(`名稱是「${def.name}」，檔名是「${name}」`)
  if (def.layout !== info.layout) problems.push(`版型是 ${def.layout}，檔名是 ${info.layout}`)
  const factoryCodes = plant.factoryCodes ?? [plant.code]
  if (JSON.stringify(def.factoryCodes) !== JSON.stringify(factoryCodes)) {
    problems.push(`適用廠區是 ${def.factoryCodes.join('、') || '（無）'}，應為 ${factoryCodes.join('、') || '（無）'}`)
  }
  const company = LEGAL_NAMES[plant.code] ?? null
  const variant = COMPANY_HEADER_VARIANTS[source.code]
  const companyInHeader = company !== null && squeeze(headerText).includes(squeeze(variant ?? company))
  if (company && !companyInHeader) problems.push(`頁首找不到公司名稱「${variant ?? company}」`)
  // 頁首通常是「公司＋年度＋問卷表~表名」；表名和檔名不同只提醒，不算對不上（以檔名為準，#84）。
  const notes = []
  if (variant) notes.push(`頁首的公司寫「${variant}」，照同廠多數印「${company}」`)
  const title = /~([^~\r\n\u0007]+)/.exec(headerText)?.[1]?.trim()
  if (title && !squeeze(def.name).includes(squeeze(title)) && !squeeze(title).includes(squeeze(info.name))) {
    notes.push(`頁首的表名是「${title}」`)
  }
  return { problems, notes, company, companyInHeader, header: [...new Set(headerText.split(/[\r\n\u0007]+/).map((l) => l.trim()).filter(Boolean))].join(' ／ ') }
}

/** 一章的控制要點依文字對齊（最長共同子序列），刪一題不會讓後面每題都算不同。 */
function alignPoints(a, b) {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i].text === b[j].text ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const steps = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) steps.push({ p: a[i++], q: b[j++] })
    else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) steps.push({ p: a[i++] })
    else steps.push({ q: b[j++] })
  }
  return steps
}

/** 定義檔和環境的內容差異（章節依位置，控制要點依文字對齊）。 */
function diffEnv(def, live) {
  const diffs = []
  if (def.name !== live.name) diffs.push(`名稱：定義檔「${def.name}」／環境「${live.name}」`)
  if (def.layout !== live.layout) diffs.push(`版型：${def.layout}／${live.layout}`)
  if (JSON.stringify(def.factoryCodes) !== JSON.stringify(live.factoryCodes)) {
    diffs.push(`適用廠區：${def.factoryCodes.join('、') || '（無）'}／${live.factoryCodes.join('、') || '（無）'}`)
  }
  if (def.sections.length !== live.sections.length) diffs.push(`章節數：${def.sections.length}／${live.sections.length}`)
  const unitChanges = new Map()
  for (let i = 0; i < Math.max(def.sections.length, live.sections.length); i++) {
    const a = def.sections[i]
    const b = live.sections[i]
    if (!a || !b) continue
    if (a.name !== b.name || (a.level ?? 1) !== (b.level ?? 1) || (a.code ?? '') !== (b.code ?? '')) {
      diffs.push(`第 ${i + 1} 章：「${a.name}」／「${b.name}」`)
    }
    if (a.controlPoints.length !== b.controlPoints.length) diffs.push(`第 ${i + 1} 章題數：${a.controlPoints.length}／${b.controlPoints.length}`)
    for (const step of alignPoints(a.controlPoints, b.controlPoints)) {
      const { p, q } = step
      if (!q) diffs.push(`第 ${i + 1} 章少了一題（環境刪掉或改寫）：「${p.text}」`)
      else if (!p) diffs.push(`第 ${i + 1} 章多了一題（環境新增或改寫）：「${q.text}」`)
      else {
        if ((p.code ?? '') !== (q.code ?? '')) diffs.push(`第 ${i + 1} 章「${p.text}」的題號：${p.code ?? '（無）'}／${q.code ?? '（無）'}`)
        const from = p.assessingUnits.join('、') || '（無）'
        const to = q.assessingUnits.join('、') || '（無）'
        if (from !== to) unitChanges.set(`${from} → ${to}`, (unitChanges.get(`${from} → ${to}`) ?? 0) + 1)
      }
    }
  }
  for (const [change, n] of unitChanges) diffs.push(`自評單位 ${change}：${n} 題`)
  return diffs
}

const units = (def) => [...new Set(def.sections.flatMap((s) => s.controlPoints.flatMap((p) => p.assessingUnits)))]

const results = []
for (const source of sources) {
  const doc = squeeze(read(texts.get(source.path)))
  const headerText = read(headers.get(source.path))
  const draft = drafts.get(source.code)
  const live = env?.get(source.code)
  const def = draft ?? (live ? fromEnv(live) : null)
  const result = { code: source.code, plant: source.plant.code, file: basename(source.path), from: draft ? 'draft' : live ? 'env' : 'none' }
  if (!def) {
    results.push({ ...result, problems: ['沒有定義檔，環境也沒有這份範本'] })
    continue
  }
  const header = checkHeader(def, source, headerText)
  const body = checkBody(def, doc)
  const allUnits = units(def)
  results.push({
    ...result,
    name: def.name,
    layout: def.layout,
    factoryCodes: def.factoryCodes,
    company: header.company,
    companyInHeader: header.companyInHeader,
    header: header.header,
    sections: def.sections.map((s) => ({ level: s.level ?? 1, name: s.name, points: s.controlPoints.length })),
    points: def.sections.reduce((n, s) => n + s.controlPoints.length, 0),
    units: allUnits,
    unitPoints: Object.fromEntries(allUnits.map((u) => [u, def.sections.reduce((n, s) => n + s.controlPoints.filter((p) => p.assessingUnits.includes(u)).length, 0)])),
    noUnitPoints: def.sections.reduce((n, s) => n + s.controlPoints.filter((p) => p.assessingUnits.length === 0).length, 0),
    unitSpellings: body.unitSpellings,
    problems: [...header.problems, ...body.problems],
    notes: header.notes,
    ...(env
      ? {
          env: live
            ? {
                status: live.status,
                updatedAt: live.updated_at,
                assessments: live.assessments,
                diffs: draft ? diffEnv(draft, fromEnv(live)) : [],
                units: units(fromEnv(live)),
                problems: draft ? checkBody(fromEnv(live), doc).problems : [],
              }
            : null,
        }
      : {}),
  })
}
// 定義檔有、原檔沒有的（原檔刪掉或改了編號）。
for (const code of drafts.keys()) {
  if (!sources.some((s) => s.code === code) && (!onlyPlant || code.startsWith(`${onlyPlant}-`))) {
    results.push({ code, plant: code.split('-')[0], from: 'draft', problems: ['找不到對應的 Word 原檔'] })
  }
}

let failed = 0
for (const r of results) {
  const pending = [
    r.layout === 'element' && r.noUnitPoints ? `${r.noUnitPoints} 題沒有自評單位` : null,
    r.units?.includes(UNIT_TO_BE_ASSIGNED) ? `${r.unitPoints[UNIT_TO_BE_ASSIGNED]} 題待指定單位` : null,
    r.factoryCodes?.length === 0 ? '沒有廠區代碼' : null,
  ].filter(Boolean)
  const label = `${r.code}（${r.from === 'env' ? '環境' : '定義檔'}）${r.sections ? `${r.sections.length} 章 ${r.points} 題` : ''}${pending.length ? `；待確認：${pending.join('、')}` : ''}${r.layout === 'element' && !r.noUnitPoints ? `；整份掛${r.units.join('、')}（原檔沒有單位欄）` : ''}`
  if (r.problems.length === 0) console.log(`✓ ${label}`)
  else {
    failed++
    console.error(`✗ ${label}\n${r.problems.map((p) => `    ${p}`).join('\n')}`)
  }
  for (const note of r.notes ?? []) console.log(`    提醒：${note}`)
  if (r.env?.diffs.length) console.log(`    環境和定義檔不同 ${r.env.diffs.length} 處`)
}
if (jsonFile) writeFileSync(jsonFile, JSON.stringify(results, null, 2))
console.log(`${sources.length} 份原檔、${drafts.size} 份定義檔，逐份核對${failed ? `，${failed} 份和原檔對不上` : '，全部和原檔相符'}`)
process.exit(failed ? 1 : 0)
