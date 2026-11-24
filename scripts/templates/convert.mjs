// npm run templates:convert           從 Word 原檔重新產生範本：FQ-02 是種子 migration，其餘是草稿定義檔
// npm run templates:verify            只重新讀 Word 並與進版控的檔案比對，不一致或多出檔案就失敗（不寫檔）
//   [--source <資料夾>] [--plant <廠區代碼>]  只轉一個廠區時不檢查多出來的檔案
//
// 公司的 Word 原檔放在 repo 外（預設主 checkout 旁邊的 各廠自評，每個廠區一個資料夾，見 PLANTS；可用 --source 或
// CSA_WORD_SOURCE_DIR 指定）。需要本機有 Microsoft Word，所以不跑在 CI。
// 產生的檔案只含控制要點文字與結構，不含人名。
//
// 每廠一份範本，編號＝「廠區代碼-該廠紙本編號」（#84，Q111），適用廠區只有該廠。寫成
// supabase/drafts/templates/<廠區>/<編號>.json，由 `npm run drafts:write -- supabase/drafts/templates` 以對話寫入
// 寫成停用的範本（資料庫已有的編號不寫），稽核主管檢查後啟用（Q90、Q137 (7) ①）。福清的 02 在 #3 就以 migration 種成啟用中的範本，那時還沒有這條規則：種子照舊產生
// 原本的「02」與原檔的單位寫法，20261103000000 的 migration 再把它改成 FQ-02、換掉改名的自評單位。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeWordHtml, htmlTableRows } from './html.ts'
import { mergeSplitControlPoints, numberPointsPerSubsection, parseTemplateFileName, parseTemplateRows, takeSourceCodes } from './parse.ts'
import { renderDraftJson, renderSeedSql, seedSections } from './render.ts'
import { defaultSourceRoot, ELEMENT_UNITS, PLANTS, SPLIT_02, UNIT_MAPPING, UNIT_TO_BE_ASSIGNED, UNITS } from './sources.mjs'
import { mapAssessingUnits } from './units.ts'
import { saveAs } from './word.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** 「待指定單位」的控制要點改掛的單位（#207，Q138 (6)）：範本編號 → 控制要點文字 → { units }。沒列的照舊待指定單位。 */
const ASSIGNED_UNITS = JSON.parse(readFileSync(join(REPO, 'scripts', 'templates', 'assigned-units.json'), 'utf8')).templates
/** 套用過的「範本編號／控制要點文字」，用來找出對照檔裡已經對不上原檔的列。 */
const assignedUsed = new Set()
const MIGRATIONS = join(REPO, 'supabase', 'migrations')
const DRAFTS = join(REPO, 'supabase', 'drafts', 'templates')

// 範本沒有版本（Q137 (4)）：定義檔不寫。02 的種子 migration 是當年就套用的，仍產生原本的 1.0（20261101000000 的
// migration 把它改成建立年月，20261207000000 再把欄位拿掉），改掉會讓 templates:verify 對不上已套用的 migration。
const SEED_VERSION = '1.0'

/**
 * 多層章節的層級（Q125：每個章節列一個章節，第 1 層是卡片，2、3 層是卡片裡的分段列）。各廠寫法不同，依寫法判斷：
 * - 「---開模通知」：上面最近一個不是「---」的章節的下一層（研發循環的小節、samoa 各循環底下的作業）。
 * - 研發循環「新產品導入管制作業」底下含「階段」的（估價階段、RFQ階段、EVT(工程驗證測試階段)…）是第 2 層。
 * - SY 要素類的「1董事會…」「1.1公司是否…」依編號的段數。
 */
function headingLevel(heading, above) {
  if (heading.startsWith('---')) return above.findLastIndex((h) => !h.startsWith('---')) + 2
  if (heading.includes('階段') && above[0] === '新產品導入管制作業') return 2
  const numbered = /^(\d+(?:\.\d+)*)\D/.exec(heading)
  return numbered ? numbered[1].split('.').length : 1
}

/**
 * 個別範本（依產生的編號）的形狀差異。原檔改了會讓轉檔失敗，屆時更新或刪掉這裡的設定。
 * migration：種子 migration 的檔名（只有 FQ-02）。
 * splitControlPoints：原檔把一題拆在相鄰兩列，接回一題；稽核部修好原檔後，這一條會讓轉檔失敗，屆時把它刪掉。
 * parse：交給 parseTemplateRows 的選項（見 parse.ts 的 ParseOptions）。
 * name：檔名讀不出名稱時（samoa 一份涵蓋幾個循環）照紙本的寫法。
 * sourceCodes：原檔把題號寫在章節名稱與控制要點文字開頭（「1.1.1-1公司是否…」），拿出來放進題號欄（Q125）。
 * pointsPerSubsection：紙本在第二層的章節裡每段從 1 重編，把號碼寫進題號欄（Q125，系統預設是卡片內連續編）。
 */
const TEMPLATES = {
  'FQ-02': { migration: '20261014000003_seed_template_02.sql', splitControlPoints: [SPLIT_02] },
  // 這幾廠的 02 也是同一份原檔拆成兩列（其他廠已經修好），照 Q79 接回一題。
  ...Object.fromEntries(['CF', 'FF', 'GH', 'JS', 'KS', 'SF', 'VN'].map((plant) => [`${plant}-02`, { splitControlPoints: [SPLIT_02] }])),
  // 原檔有幾題的自評單位格空白（同章節其他題是資訊單位）；使用者 2026-10-29 決定先掛待指定單位。
  'SY-12': {
    parse: {
      blankUnits: {
        '介面系統輸入處理時，若有異常事項發生，系統是否會自動產生異常及例外報表，並授權專人覆核追蹤？': UNIT_TO_BE_ASSIGNED,
        '是否針對機敏性資料之處理及儲存建立適當之防護措施，如：實體隔離、專用電腦作業環境、存取權限、資料加密、傳輸加密、資料遮蔽、人員管理及處理規範等？':
          UNIT_TO_BE_ASSIGNED,
      },
    },
  },
  'LH-12': { parse: { blankUnits: { '已離職之資訊人員，是否已確實完成移交手續，並移除其電腦或資訊系統使用權限？': UNIT_TO_BE_ASSIGNED } } },
  // 原檔這題多了一列，兩列都是模具業務；同一個單位不能答同一題兩次（Q92），只留一列。
  'GH-01.4': { parse: { repeatedUnitRows: ['銷貨單據是否經收貨人簽收並依序號歸檔存查？'] } },
  // 台北總公司的要素類章節與控制要點都有原檔題號；SY-08、VN-10.1 有幾題的題號手打在文字裡（其他題是 Word 自動編號）。
  ...Object.fromEntries(['SY-A', 'SY-B', 'SY-C', 'SY-D', 'SY-08'].map((code) => [code, { sourceCodes: true }])),
  // 原檔在詞中間打空白硬湊換行，接回一個詞（Q126，使用者 2026-11-11 決定）。
  'VN-10.1': { sourceCodes: true, parse: { wordBreaks: ['修模檢討報告', '由工程相關人員'] } },
  'SAMOA-01': { name: '銷售及收款循環、採購及付款循環', pointsPerSubsection: true },
  'SAMOA-02': { name: '投資循環、融資循環、內部管理控制制度', pointsPerSubsection: true },
}

const args = process.argv.slice(2)
const verifyOnly = args.includes('--check')
const option = (flag) => {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  if (!args[i + 1]) {
    console.error('用法：node scripts/templates/convert.mjs [--check] [--source <原檔根目錄>] [--plant <廠區代碼>]')
    process.exit(2)
  }
  return args[i + 1]
}
const sourceRoot = resolve(option('--source') ?? defaultSourceRoot())
const onlyPlant = option('--plant')?.toUpperCase()

/** 一個廠區資料夾裡的原檔 → 要轉的範本。編號重複（陸合有兩份 05.2）時以檔名的區分接在後面（Q111）。 */
function templatesOf(plant) {
  const dir = join(sourceRoot, plant.dir)
  const files = readdirSync(dir).filter((f) => /\.docx?$/i.test(f) && !f.startsWith('~$')) // ~$ 是 Word 開著時的鎖定檔
  const parsed = files.map((file) => ({ file, info: parseTemplateFileName(file) }))
  return parsed.map(({ file, info }) => {
    const twins = parsed.filter((p) => p.info.code === info.code)
    let code = `${plant.code}-${info.code}`
    if (twins.length > 1) {
      if (!info.variant || twins.filter((t) => t.info.variant === info.variant).length > 1) {
        throw new Error(`${plant.dir} 有 ${twins.length} 份編號 ${info.code} 的原檔，檔名也分不出來：${twins.map((t) => t.file).join('、')}`)
      }
      code += `-${info.variant}`
    }
    const config = TEMPLATES[code] ?? {}
    const target = config.migration ? join(MIGRATIONS, config.migration) : join(DRAFTS, plant.code, `${code}.json`)
    return { plant, file, path: join(dir, file), info, code, config, target }
  })
}

/** 一份範本 → 要寫的檔案與內容。 */
function convert(t, html) {
  const { plant, file, info, code, config } = t
  const rows = htmlTableRows(decodeWordHtml(readFileSync(html)))
  // 控制作業的原檔有不少沒有自評單位欄（SY 的 06、07…，各廠的 15）或沒有章節列（各廠的 11）：前者整份掛
  // 「待指定單位」（Q90 的做法），後者整份放在以範本名稱命名的一個章節。要素類沒有自評單位欄，整份掛 ELEMENT_UNITS 的單位（#207）。
  const defaults = {
    headingLevel,
    // 研發循環的這個階段由台北研發部進行，原檔底下沒有控制要點。
    emptyHeadings: ['設計評估階段(由台北研發部進行)'],
    ...(info.layout === 'control_activity' ? { unitWhenNoColumn: UNIT_TO_BE_ASSIGNED, untitledSection: info.name } : {}),
  }
  let body = mergeSplitControlPoints(parseTemplateRows(rows, { ...defaults, ...config.parse }), config.splitControlPoints ?? [])
  if (config.sourceCodes) body = takeSourceCodes(body)
  if (config.pointsPerSubsection) body = numberPointsPerSubsection(body)
  if (info.layout === 'control_activity' && body.sections.some((s) => s.controlPoints.some((p) => p.assessingUnits.length === 0))) {
    throw new Error(`${file} 有控制要點沒有自評單位；控制作業的範本一定要有自評單位`)
  }
  const points = body.sections.reduce((n, s) => n + s.controlPoints.length, 0)
  const name = config.name ?? (info.variant ? `${info.name}（${info.variant}）` : info.name)
  const summary = `${config.migration ? info.code : code} ${name}：${body.sections.length} 章 ${points} 題`

  if (config.migration) {
    const sql = renderSeedSql({
      code: info.code,
      name: info.name,
      layout: info.layout,
      version: SEED_VERSION,
      status: 'active',
      allPlants: info.allPlants,
      assessingUnits: body.assessingUnits,
      sections: seedSections(body.sections),
    })
    return { content: sql, summary }
  }
  const elementUnit = info.layout === 'element' ? ELEMENT_UNITS[info.code] : undefined
  if (info.layout === 'element' && !elementUnit) throw new Error(`${file}：要素類 ${info.code} 沒有在 ELEMENT_UNITS 指定單位`)
  if (elementUnit && body.sections.some((s) => s.controlPoints.some((p) => p.assessingUnits.length))) {
    throw new Error(`${file}：要素類的原檔有自評單位欄了，確認後拿掉 ELEMENT_UNITS 的 ${info.code}`)
  }
  if (elementUnit) {
    body = {
      sections: body.sections.map((s) => ({ ...s, controlPoints: s.controlPoints.map((p) => ({ ...p, assessingUnits: [elementUnit] })) })),
      assessingUnits: [elementUnit],
    }
  }
  const converted = mapAssessingUnits(body, UNIT_MAPPING)
  // 待指定單位換成對照檔的單位（原檔沒有這幾個字，以稽核主管的說明依其他表單帶入，#207）。
  const assigned = ASSIGNED_UNITS[code] ?? {}
  const mapped = {
    ...converted,
    sections: converted.sections.map((s) => ({
      ...s,
      controlPoints: s.controlPoints.map((p) => {
        const entry = Object.hasOwn(assigned, p.text) ? assigned[p.text] : null
        if (!entry) return p
        if (!p.assessingUnits.includes(UNIT_TO_BE_ASSIGNED)) throw new Error(`assigned-units.json 的 ${code}「${p.text}」原檔已經有單位，請拿掉這一列`)
        assignedUsed.add(`${code}|${p.text}`)
        return { ...p, assessingUnits: [...new Set(p.assessingUnits.flatMap((u) => (u === UNIT_TO_BE_ASSIGNED ? entry.units : [u])))] }
      }),
    })),
  }
  mapped.assessingUnits = [...new Set(mapped.sections.flatMap((s) => s.controlPoints.flatMap((p) => p.assessingUnits)))]
  const unknown = mapped.assessingUnits.filter((u) => !UNITS.has(u))
  if (unknown.length) throw new Error(`${file} 有對應表沒有的自評單位：${unknown.join('、')}（先決定對應到哪個單位，加進 UNIT_MAPPING）`)
  const json = renderDraftJson({
    kind: 'template',
    generatedBy: `npm run templates:convert 從 Word 原檔「${file}」產生，請勿手改`,
    code,
    name,
    layout: info.layout,
    allPlants: false,
    factoryCodes: plant.factoryCodes ?? [plant.code],
    sections: mapped.sections,
  })
  return { content: json, summary }
}

const plants = onlyPlant ? PLANTS.filter((p) => p.code === onlyPlant) : PLANTS
if (plants.length === 0) {
  console.error(`沒有廠區 ${onlyPlant}；可用：${PLANTS.map((p) => p.code).join('、')}`)
  process.exit(2)
}
const templates = plants.flatMap(templatesOf)
const unused = onlyPlant ? [] : Object.keys(TEMPLATES).filter((code) => !templates.some((t) => t.code === code))
const html = await saveAs(templates.map((t) => t.path), 'htm')

let failed = false
const fail = (message) => {
  console.error(`✗ ${message}`)
  failed = true
}
for (const code of unused) fail(`範本設定 ${code} 沒有對應的原檔（原檔改了編號或檔名？）`)
// 對照檔裡沒用上的列（原檔改了題目文字、或範本編號打錯）：放著會讓人以為那一題有單位。等全部轉完才檢查（見檔尾）。
for (const t of templates) {
  let result
  try {
    result = convert(t, html.get(t.path))
  } catch (e) {
    fail(`${t.code}（${t.plant.dir}/${t.file}）：${e.message}`)
    continue
  }
  const { content, summary } = result
  const { target } = t
  const shown = relative(REPO, target)
  if (verifyOnly) {
    if (!existsSync(target)) fail(`${summary}：${shown} 不存在（執行 npm run templates:convert 產生）`)
    else if (readFileSync(target, 'utf8') === content) console.log(`✓ ${summary}，與 Word 原檔一致`)
    else fail(`${summary}：${shown} 與 Word 原檔不一致（執行 npm run templates:convert 看差異）`)
  } else {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
    console.log(`wrote ${shown}：${summary}`)
  }
}
// 原檔刪掉或改了編號，留在 repo 的舊定義檔就不再對應任何原檔，drafts:write 會把它寫成多出來的範本。
if (!onlyPlant) {
  const expected = new Set(templates.map((t) => t.target))
  for (const file of readdirSync(DRAFTS, { recursive: true }).filter((f) => f.endsWith('.json'))) {
    if (!expected.has(join(DRAFTS, file))) fail(`supabase/drafts/templates/${file.replaceAll('\\', '/')} 沒有對應的原檔，請刪掉`)
  }
  for (const [code, points] of Object.entries(ASSIGNED_UNITS)) {
    for (const text of Object.keys(points)) {
      if (!assignedUsed.has(`${code}|${text}`)) fail(`assigned-units.json 的 ${code}「${text}」對不上任何待指定單位的控制要點（原檔改了文字？）`)
    }
  }
}
console.log(`${templates.length} 份原檔${failed ? '，有錯誤（見上方 ✗）' : ''}`)
process.exit(failed ? 1 : 0)
