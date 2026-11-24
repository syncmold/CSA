// npm run env:clone -- <來源 .env> <N>
//
// 平行開發 (README › 平行開發): a second worktree must not share the first one's database,
// PostgREST or Vite, or their migrations and sessions trample each other. This copies an
// existing .env into the current directory with three values shifted by N:
//   CSA_DB_URL   … /csa_dev  →  … /csa_dev_<N>
//   CSA_REST_URL http://127.0.0.1:3000  →  :3000+N
//   CSA_WEB_PORT 5173                   →  5173+N
// Everything else (OMS keys, JWT secret, CSA_DEMO_* 工號, CSA_DEV_LOGIN) is kept, so the
// worktree can run db:init → db:migrate → db:seed-route → db:launch on its own database.
// Keys the source .env predates (e.g. CSA_DRAFTER_PASSWORD, #15) are added with their
// .env.example value, the same way setup-local-db.sh upgrades an older .env.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [source, nArg] = process.argv.slice(2)
const n = Number(nArg)

if (!source || !existsSync(source) || !Number.isInteger(n) || n < 1 || n > 999) {
  console.error('用法：npm run env:clone -- <來源 .env 的路徑> <N：1–999，例如工單編號>')
  process.exit(2)
}
if (existsSync('.env')) {
  console.error('這個目錄已經有 .env，不覆蓋。請先改名或刪除它。')
  process.exit(1)
}

const lines = readFileSync(source, 'utf8').split(/\r?\n/)
const changed = {}

function setValue(key, transform) {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(`${key}=`)) continue
    // setup-local-db.sh writes values in single quotes; keep whatever quoting the source used.
    const raw = lines[i].slice(key.length + 1).trim()
    const quoted = raw.match(/^(['"])(.*)\1$/)
    const after = transform(quoted ? quoted[2] : raw)
    lines[i] = `${key}=${quoted ? `${quoted[1]}${after}${quoted[1]}` : after}`
    changed[key] = after
    return
  }
  // Key absent in the source (older .env): append with the shifted default.
  const after = transform(null)
  lines.push(`${key}=${after}`)
  changed[key] = after
}

setValue('CSA_DB_URL', (v) => {
  const url = new URL(v ?? 'postgres://authenticator:csa-authenticator-dev@127.0.0.1:5432/csa_dev')
  url.pathname = `/${url.pathname.replace(/^\//, '').replace(/_\d+$/, '')}_${n}`
  return url.toString()
})
setValue('CSA_REST_URL', (v) => {
  const url = new URL(v ?? 'http://127.0.0.1:3000')
  url.port = String(3000 + n)
  return url.origin
})
setValue('CSA_WEB_PORT', () => String(5173 + n))

const example = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env.example')
const added = []
for (const line of readFileSync(example, 'utf8').split(/\r?\n/)) {
  const key = /^([A-Z0-9_]+)=/.exec(line)?.[1]
  if (!key || lines.some((l) => l.startsWith(`${key}=`))) continue
  lines.push(line)
  added.push(key)
}

writeFileSync('.env', lines.join('\n'))
console.log(`已寫入 ${process.cwd()}\\.env（來源 ${source}）：`)
for (const [key, value] of Object.entries(changed)) console.log(`  ${key}=${value.replace(/:[^:@/]*@/, ':***@')}`)
if (added.length) console.log(`  來源沒有、照 .env.example 補上：${added.join('、')}`)
console.log('接著：npm run db:init && npm run db:migrate && npm run db:seed-route，再 npm run dev:all。')
