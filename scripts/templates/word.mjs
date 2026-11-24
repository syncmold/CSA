// Word 原檔 → filtered HTML（交給 html.ts 解析）、純文字或頁首文字（獨立核對用，spot-check.mjs），#84、#207。
// 需要本機有 Microsoft Word，所以只在開發機跑。
//
// 另存的檔案以原檔內容的雜湊為名放在快取資料夾（預設系統暫存資料夾的 csa-word-html，可用 CSA_WORD_CACHE_DIR
// 指定）：原檔一改雜湊就變、會重新另存，所以 templates:verify 比對的永遠是原檔現在的內容；沒改的不必再開 Word。
// 另存的方式（word-save.ps1 的格式、編碼）改了，就換 FORMATS 的副檔名，舊的快取自然不再被用到。
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'word-save.ps1')
/** 種類 → 快取檔的副檔名與 Word 的 SaveAs2 格式：filtered HTML、純文字（另存時指定 UTF-8）。 */
const FORMATS = { htm: { ext: 'htm', format: 10 }, txt: { ext: 'utf8.txt', format: 7 }, header: { ext: 'header.txt', format: -1 } }
// 一份另存約 2 秒；Word 偶爾整個卡住（不回應也不報錯），超過這麼久沒有進度就關掉它，腳本會重開 Word 再試。
const STALL_MS = 90_000

// Word 存檔遇到 8.3 短檔名（PEICHU~1.CHE）或正斜線的路徑會跳出看不見的對話框卡住，所以一律給完整的長路徑。
const longPath = (p) => realpathSync.native(resolve(p))

function cacheDir() {
  const dir = process.env.CSA_WORD_CACHE_DIR ?? join(longPath(tmpdir()), 'csa-word-html')
  mkdirSync(dir, { recursive: true })
  return longPath(dir)
}

/** 原檔路徑 → 另存的檔案路徑（kind：htm 或 txt）。缺的一次交給 Word 另存。 */
export async function saveAs(sources, kind) {
  const { ext, format } = FORMATS[kind]
  const dir = cacheDir()
  const targets = new Map(
    sources.map((s) => [s, join(dir, `${createHash('sha256').update(readFileSync(s)).digest('hex').slice(0, 32)}.${ext}`)]),
  )
  const missing = [...targets].filter(([, target]) => !existsSync(target))
  if (missing.length === 0) return targets

  console.log(`Word 另存 ${kind}：${missing.length} 份（快取在 ${dir}）`)
  const list = join(dir, `list-${process.pid}.txt`)
  writeFileSync(list, missing.map(([source, target]) => `${longPath(source)}\t${target}`).join('\n'), 'utf8')
  try {
    await new Promise((done, failed) => {
      const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ListFile', list, '-Format', String(format)], {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      let wordPid = null
      let timer = null
      const watch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          if (!wordPid) {
            // Word 在啟動時就卡住（還沒回報是哪個行程），只能整批停下來。
            console.log(`  Word 超過 ${STALL_MS / 1000} 秒沒有啟動完成，停止另存`)
            child.kill()
            return
          }
          console.log(`  Word 超過 ${STALL_MS / 1000} 秒沒有進度，關掉重開`)
          try {
            process.kill(wordPid)
          } catch {
            // 已經結束了
          }
        }, STALL_MS)
      }
      createInterface({ input: child.stdout }).on('line', (line) => {
        const pid = /^word-pid (\d+)$/.exec(line)
        if (pid) wordPid = Number(pid[1])
        else console.log(line)
        watch()
      })
      child.on('error', failed)
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) done()
        else failed(new Error(`Word 另存 ${kind} 失敗（訊息見上方）`))
      })
      watch()
    })
  } finally {
    rmSync(list, { force: true })
  }
  return targets
}
