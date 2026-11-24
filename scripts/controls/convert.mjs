// node scripts/controls/convert.mjs           從內控文件 Word 原檔與內控依據對照重新產生種子 migration；
//                                              有設 CSA_CONTROL_DOC_DIR 時，同時把每份文件轉成 PDF 放進那個資料夾
// node scripts/controls/convert.mjs --check   只重新讀 Word 並與進版控的 migration 比對，不一致就失敗（不寫檔）
//
// 公司的 Word 原檔放在 repo 外（預設 ../富群自評/FQ_福清富群(內控文件)/02~採購循環(PR)，可用 --source 或
// CSA_CONTROL_DOC_SOURCE_DIR 指定；在 worktree 裡一定要指定）。需要本機有 Microsoft Word，所以不跑在 CI。
// 產生的 migration 只含第 5、6 節的作業程序條文與版次，不含人名；轉成的 PDF 只放在本機設定的資料夾，不進版控（#9）。
// 內控依據對照（references-02-FQ.json）是 Claude 提出、稽核確認的初稿（Q38），改對照後重跑本指令。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseControlDocument, parseDocumentFileName } from './parse.ts'
import { parseReference, renderControlSeedSql } from './render.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const MIGRATION = join(REPO, 'supabase', 'migrations', '20261026000001_seed_control_documents_fq.sql')
const MAPPING = join(HERE, 'references-02-FQ.json')

if (existsSync(join(REPO, '.env'))) process.loadEnvFile(join(REPO, '.env'))

const args = process.argv.slice(2)
const verifyOnly = args.includes('--check')
const sourceIdx = args.indexOf('--source')
if (sourceIdx >= 0 && !args[sourceIdx + 1]) {
  console.error('用法：node scripts/controls/convert.mjs [--check] [--source <內控文件 Word 原檔資料夾>]')
  process.exit(2)
}
const sourceDir = resolve(
  sourceIdx >= 0
    ? args[sourceIdx + 1]
    : (process.env.CSA_CONTROL_DOC_SOURCE_DIR || join(REPO, '..', '富群自評', 'FQ_福清富群(內控文件)', '02~採購循環(PR)')),
)
const pdfDir = verifyOnly ? null : process.env.CSA_CONTROL_DOC_DIR ? resolve(process.env.CSA_CONTROL_DOC_DIR) : null

const mapping = JSON.parse(readFileSync(MAPPING, 'utf8'))
const codes = [...new Set(mapping.sections.flatMap((s) => [...s.documents, ...s.controlPoints.flatMap((p) => p.references.map((r) => parseReference(r).document))]))].sort()

if (!existsSync(sourceDir)) {
  console.error(`找不到內控文件原檔資料夾 ${sourceDir}（用 --source 或 CSA_CONTROL_DOC_SOURCE_DIR 指定）`)
  process.exit(1)
}
const files = codes.map((code) => {
  // 一份文件只能有一個原檔：同時放著新舊兩版時，挑哪個要看檔名排序，種子可能默默變成舊版。（~$ 開頭的是 Word 開著時的暫存檔。）
  const matches = readdirSync(sourceDir).filter((f) => /\.docx?$/i.test(f) && !f.startsWith('~$') && f.includes(`-${code}`))
  if (matches.length === 0) throw new Error(`在 ${sourceDir} 找不到 ${code} 的 Word 檔`)
  if (matches.length > 1) throw new Error(`${sourceDir} 裡 ${code} 有 ${matches.length} 個 Word 檔（${matches.join('、')}），請只留目前這一版`)
  const name = matches[0]
  return { name, info: parseDocumentFileName(name) }
})

const work = mkdtempSync(join(tmpdir(), 'csa-controls-'))
try {
  if (pdfDir) mkdirSync(pdfDir, { recursive: true })
  const jobs = files.map(({ name, info }) => ({
    path: join(sourceDir, name),
    text: join(work, `${info.code}.txt`),
    pdf: pdfDir ? join(pdfDir, `${info.number}_${info.version}.pdf`) : null,
  }))
  writeFileSync(join(work, 'jobs.json'), JSON.stringify(jobs), 'utf8')
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'extract-doc.ps1'), '-Jobs', join(work, 'jobs.json')], {
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`讀取 Word 失敗：${r.stderr || r.stdout}`)

  const documents = files.map(({ name, info }) => {
    const parsed = parseControlDocument(readFileSync(join(work, `${info.code}.txt`), 'utf8'), info.number)
    if (parsed.version.version !== info.version) {
      throw new Error(`${name}：檔名是 ${info.version} 版，文件改廢履歷表最後一版是 ${parsed.version.version}`)
    }
    console.log(`${info.code} ${info.name}：${parsed.version.version} 版（${parsed.version.effectiveDate}），${parsed.clauses.length} 條`)
    return {
      number: info.number,
      code: info.code,
      name: info.name,
      version: parsed.version.version,
      effectiveDate: parsed.version.effectiveDate,
      pdfFile: `${info.number}_${info.version}.pdf`,
      clauses: parsed.clauses,
    }
  })

  const sql = renderControlSeedSql(documents, mapping)
  const shown = relative(REPO, MIGRATION)
  if (verifyOnly) {
    if (existsSync(MIGRATION) && readFileSync(MIGRATION, 'utf8') === sql) {
      console.log(`✓ ${shown} 與 Word 原檔、內控依據對照一致`)
    } else {
      console.error(`✗ ${shown} 與 Word 原檔或內控依據對照不一致（執行 node scripts/controls/convert.mjs 看差異）`)
      process.exitCode = 1
    }
  } else {
    writeFileSync(MIGRATION, sql, 'utf8')
    console.log(`wrote ${shown}`)
    if (pdfDir) console.log(`PDF 寫到 ${pdfDir}`)
    else console.log('沒有設 CSA_CONTROL_DOC_DIR，沒有轉 PDF（側邊欄的整份文件需要它）')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
