// npm run templates:signatures          從 Word 原檔的簽核欄產生每份範本的流程形狀（route-shapes.json）
// npm run templates:signatures -- --check   只比對，不一致就失敗（不寫檔）
//
// 每份原檔最後一題之後的簽核欄（廠區端那張表與「稽核室（覆核）」那張表），請 Word 另存純文字後依職稱清單讀出
// （#207，Q143；不經過 html.ts／parse.ts）。換算規則是使用者 2026-11-19 的決定：
//   分流    每個自評單位一條：自行檢查人員 →（原檔有「部門主管」就接部門主管；SAMOA 的「相關所屬主管(審核)」當各單位的
//           部門主管；都沒有就只有自行檢查人員，例如 SY 董事長簽的表、D 監督）。
//   匯流後  原檔廠區端的其他職稱（廠區經理人、廠長、執行副總、副總經理、總經理、執行副總經理、董事長），簽核欄由右到左
//           簽，所以照原檔由左到右出現的順序倒過來。「零組件事業群」是欄位標題，不是關卡。
//   稽核室  子公司擔當稽核（原檔寫子公司擔當稽核、子公司廠區擔當稽核、子公司稽核人員、擔當稽核人員）→ 台北稽核人員（連動）
//           → 稽核主管（連動，最後一關）。格子寫「從缺」就不建子公司擔當稽核；原檔沒有台北稽核人員就不建。TC-05、TC-09、
//           TC-10 的稽核室三格是「稽核主管、擔當稽核人員、子公司擔當稽核」，中間那格當台北稽核人員。
// 需要本機有 Microsoft Word。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTemplateFileName } from './parse.ts'
import { defaultSourceRoot, PLANTS } from './sources.mjs'
import { saveAs } from './word.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(REPO, 'scripts', 'templates', 'route-shapes.json')
const check = process.argv.includes('--check')

/** 廠區端的職稱（長的在前，免得「執行副總經理」被讀成「執行副總」）。 */
const PLANT_TITLES = ['相關所屬主管(審核)', '零組件事業群', '執行副總經理', '執行副總', '副總經理', '總經理', '董事長', '廠區經理人', '廠長', '部門主管', '自行檢查人員']
const AUDIT_TITLES = ['子公司廠區擔當稽核', '子公司擔當稽核', '子公司稽核人員', '擔當稽核人員', '台北稽核人員', '稽核主管', '從缺']
const BRANCH_MANAGERS = { 部門主管: '部門主管', '相關所屬主管(審核)': '相關所屬主管(審核)' }
const NOT_STEPS = new Set(['部門主管', '自行檢查人員', '相關所屬主管(審核)', '零組件事業群'])
/** 稽核室中間那格寫「擔當稽核人員」、旁邊另有子公司擔當稽核的範本：那格是台北稽核人員（使用者 2026-11-19）。 */
const MIDDLE_IS_TAIPEI = new Set(['TC-05', 'TC-09', 'TC-10'])

/** 依職稱清單，從左到右讀出出現的職稱（去掉空白與換行，Word 會把「執行副總經理」拆成兩行）。 */
function titles(region, vocab) {
  const s = region.replace(/[\s\u0007　]+/g, '')
  const found = []
  for (let i = 0; i < s.length; ) {
    const w = vocab.find((v) => s.startsWith(v, i))
    if (w) {
      found.push(w)
      i += w.length
    } else i++
  }
  return found
}

export function routeShape(code, text) {
  // 簽核欄在最後一題（問號）之後。
  const region = text.slice(Math.max(text.lastIndexOf('？'), text.lastIndexOf('?')))
  const auditAt = region.search(/稽核室/)
  const plant = [...new Set(titles(region.replace(/稽核室覆核|稽核室/g, '¶'), PLANT_TITLES))]
  const audit = auditAt >= 0 ? titles(region.slice(auditAt), AUDIT_TITLES) : []
  const managerTitle = ['部門主管', '相關所屬主管(審核)'].find((m) => plant.includes(m))
  const merged = plant.filter((t) => !NOT_STEPS.has(t)).reverse()
  const kinds = audit.filter((a) => a !== '從缺').map((a) => {
    if (a === '稽核主管') return 'audit_chief'
    if (a === '台北稽核人員') return 'taipei_auditor'
    if (a === '擔當稽核人員' && MIDDLE_IS_TAIPEI.has(code)) return 'taipei_auditor'
    return 'subsidiary'
  })
  const vacant = audit.includes('從缺')
  const order = ['subsidiary', 'taipei_auditor', 'audit_chief']
  const auditSteps = order.filter((k) => kinds.includes(k) && !(k === 'subsidiary' && vacant))
  if (!auditSteps.includes('audit_chief')) throw new Error(`${code}：簽核欄找不到稽核主管`)
  return {
    branchManager: managerTitle ? BRANCH_MANAGERS[managerTitle] : null,
    merged,
    audit: auditSteps,
    word: { plant, audit },
  }
}

const sources = PLANTS.flatMap((p) => {
  const dir = join(defaultSourceRoot(), p.dir)
  const files = readdirSync(dir).filter((f) => /\.docx?$/i.test(f) && !f.startsWith('~$'))
  const infos = files.map((f) => ({ f, info: parseTemplateFileName(f) }))
  return infos.map(({ f, info }) => {
    const twins = infos.filter((x) => x.info.code === info.code).length
    return { code: `${p.code}-${info.code}${twins > 1 ? `-${info.variant}` : ''}`, path: join(dir, f) }
  })
})

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('signatures.mjs')) {
  const txt = await saveAs(sources.map((s) => s.path), 'txt')
  const shapes = Object.fromEntries(
    sources
      .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
      .map((s) => [s.code, routeShape(s.code, readFileSync(txt.get(s.path), 'utf8'))]),
  )
  const content = `${JSON.stringify({
    _comment: '每份範本照 Word 原檔簽核欄排出的流程形狀（npm run templates:signatures 產生，請勿手改；換算規則見 scripts/templates/signatures.mjs 開頭，Q143）。word 是原檔讀到的職稱，供核對。',
    shapes,
  }, null, 2)}\n`
  if (check) {
    const same = existsSync(OUT) && readFileSync(OUT, 'utf8') === content
    console.log(same ? `✓ ${sources.length} 份原檔的簽核欄與 route-shapes.json 一致` : '✗ route-shapes.json 和原檔的簽核欄不一致（執行 npm run templates:signatures）')
    process.exit(same ? 0 : 1)
  }
  writeFileSync(OUT, content, 'utf8')
  const groups = Object.groupBy(Object.entries(shapes), ([, s]) =>
    `分流：自行檢查人員${s.branchManager ? `→${s.branchManager}` : ''}｜匯流後：${[...s.merged, ...s.audit.map((a) => ({ subsidiary: '子公司擔當稽核', taipei_auditor: '台北稽核人員', audit_chief: '稽核主管' })[a])].join('→')}`)
  for (const [k, v] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) console.log(String(v.length).padStart(3), k, '::', v.map(([c]) => c).join(' '))
  console.log(`寫入 scripts/templates/route-shapes.json：${sources.length} 份`)
}
