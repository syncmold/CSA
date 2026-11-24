// npm run deploy:push-config -- <test|prod> [--only=variables|secrets] [--dry-run] [--repo owner/name]
//
// 把本機的部署設定（<csa-deploy>/.env.deploy.<環境> 與 .env 的 OMS 設定）上傳到 GitHub 的 Environment，讓 Actions 可以部署，
// 不再依賴某一台電腦。需要先 `gh auth login`，且帳號對 repo 有管理權限。
//
// 一律用 stdin 傳值（不放在命令列、不印在畫面上）；只印名稱。
//   secrets   ：SUPABASE_DB_URL、SUPABASE_ANON_KEY、CSA_JWT_SECRET、OMS_CHANNEL_KEY，
//               加上環境變數裡有的 SUPABASE_ACCESS_TOKEN、VERCEL_TOKEN（這兩個要自己到各服務產生）
//   variables ：CSA_SITE_URL、CSA_VERCEL_PROJECT、CSA_REQUIRE_OMS_AUTH、CSA_SEED_*（有填才傳）、VITE_OMS_URL、VITE_OMS_ANON_KEY
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const envName = args.find((a) => a === 'test' || a === 'prod')
const dryRun = args.includes('--dry-run')
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7)
const repoArg = args.indexOf('--repo')
const repo = repoArg === -1 ? execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' }).trim() : args[repoArg + 1]
if (!envName || (only && only !== 'variables' && only !== 'secrets')) {
  console.error('用法：npm run deploy:push-config -- <test|prod> [--only=variables|secrets] [--dry-run] [--repo owner/name]')
  process.exit(2)
}
const githubEnv = envName === 'prod' ? 'production' : 'test'

function parseEnvFile(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
const deployDir = process.env.CSA_DEPLOY_DIR || join(dirname(dirname(resolve(common))), 'csa-deploy')
const file = join(deployDir, `.env.deploy.${envName}`)
if (!existsSync(file)) {
  console.error(`找不到 ${file}`)
  process.exit(2)
}
const config = parseEnvFile(file)
const local = existsSync('.env') ? parseEnvFile('.env') : {}

const secrets = ['SUPABASE_DB_URL', 'SUPABASE_ANON_KEY', 'CSA_JWT_SECRET', 'OMS_CHANNEL_KEY'].map((k) => [k, config[k]])
for (const k of ['SUPABASE_ACCESS_TOKEN', 'VERCEL_TOKEN']) secrets.push([k, process.env[k]])
const variables = [
  ['CSA_SITE_URL', config.CSA_SITE_URL],
  ['CSA_VERCEL_PROJECT', config.CSA_VERCEL_PROJECT],
  ['CSA_REQUIRE_OMS_AUTH', config.CSA_REQUIRE_OMS_AUTH || 'false'],
  ['CSA_SEED_AUDIT_CHIEF', config.CSA_SEED_AUDIT_CHIEF],
  ['CSA_SEED_MAINTAINERS', config.CSA_SEED_MAINTAINERS],
  ['CSA_SEED_ALLOWLIST', config.CSA_SEED_ALLOWLIST],
  ['VITE_OMS_URL', local.VITE_OMS_URL],
  ['VITE_OMS_ANON_KEY', local.VITE_OMS_ANON_KEY],
]

function push(kind, list) {
  console.log(`\n${kind === 'secret' ? 'Secrets' : 'Variables'} → ${repo} 的 Environment「${githubEnv}」`)
  for (const [name, value] of list) {
    if (!value) {
      console.log(`  - ${name}：本機沒有值，略過`)
      continue
    }
    if (!dryRun) execFileSync('gh', [kind, 'set', name, '--env', githubEnv, '--repo', repo], { input: value, stdio: ['pipe', 'ignore', 'inherit'] })
    console.log(`  ✓ ${name}${dryRun ? '（dry-run，沒有上傳）' : ''}`)
  }
}

if (only !== 'variables') push('secret', secrets)
if (only !== 'secrets') push('variable', variables)
