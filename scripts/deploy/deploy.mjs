// npm run deploy -- <test|prod> <步驟...>
//
// 部署指令：兩個互相隔離的環境（test、prod），各自一個 Supabase 專案＋一個前端託管專案。前端只放 build 出來的檔案。
// 設定來源（依序）：
//   1. <csa-deploy>/.env.deploy.<環境> 檔（本機部署；預設是主 checkout 旁邊的 csa-deploy 資料夾，可用 CSA_DEPLOY_DIR 指定）
//   2. 沒有那個檔時，讀目前環境變數（GitHub Actions 把 Environment 的 secrets 放進來；變數名稱同檔內鍵名）
// 必填：SUPABASE_DB_URL、SUPABASE_ANON_KEY、CSA_JWT_SECRET；prod 另外必填 CSA_SITE_URL。
// 第一次初始化用：CSA_SEED_AUDIT_CHIEF（第一位稽核主管工號）、CSA_SEED_MAINTAINERS（系統維護員工號，逗號分隔）、
// CSA_SEED_ALLOWLIST（放行名單，逗號分隔）。OMS 專案（登入用）的 VITE_OMS_URL／VITE_OMS_ANON_KEY 也放在部署設定裡（沒有時才看環境變數與本機 .env）；
// 缺了就拒絕部署換證或 build 前端：少了它，換證會對所有人回 502、前端會把登入送到自己的網址。
// 步驟（可一次給多個，依序執行）：
//   check     連得到資料庫、PostgREST 接受自簽的 token
//   db        套用 migration、建內控文件 bucket 與讀取規則
//   drafts    寫入資料庫還沒有的範本編號（寫成停用，由稽核主管檢查後啟用）；已有的編號不動
//   seed      放行名單；只在第一次（放行名單還是空的）才設角色、寫入範本並全部啟用；之後重跑只補放行名單
//   allow     把命令列後面的工號加進放行名單（npm run deploy -- prod allow AB0123）；加 --maintainer 同時設為系統維護員
//   docs      上傳內控文件 PDF（CSA_CONTROL_DOC_DIR）到 bucket
//   function  設定 Edge Function 的 secrets 並部署換證（需要先 npx supabase login）
//   web       build 前端、檢查沒有金鑰外洩、部署到託管（目前實作為 Vercel；改託管只需改這一步）
//   pages     build 出可發布到 GitHub Pages 的資料夾（<csa-deploy>/pages-<環境>/，含 404.html、.nojekyll；不推送）
//   publish   把 pages 的資料夾推到這個 repo 的 gh-pages 分支，並等網站換成新版
//   update-pages  GitHub Pages 版的 update：db drafts function pages publish
//   backup    pg_dump 到 <csa-deploy>/backups/（prod 的備份請另外排程存到不是個人電腦的地方）
//   restore   還原一份 backup（先再備份一次現況）
//   master    廠區主檔：從 OMS 的 factories 同步廠區與公司
//   reset     只有 test：先 backup，再清空並重建
//   rebuild   只有 test：範本與簽核流程照定義檔重建
//   update    合併後更新環境：db drafts function web（日常用這個）
//   all       第一次建環境：check db seed docs function web
// prod 的 reset、restore 要加 --confirm-prod；rebuild 在 prod 不能執行。
// 會改動環境的步驟只能在 main、沒有未 commit 的修改、和 origin/main 一致時執行；刻意部署別的分支加 --allow-branch。
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import pg from 'pg'
import { SignJWT } from 'jose'
import { pgBin } from '../db/env.mjs'
import { rebuildTemplates, templateDefinitions } from '../templates/rebuild.mjs'

/** name: what the command prints; badge: the tag on the login card and side menu ('' shows none, as on prod); destructive: reset and rebuild are allowed. */
const ENVIRONMENTS = {
  test: { name: '測試環境', badge: '測試環境', destructive: true },
  prod: { name: '正式環境', badge: '', destructive: false },
}
/** Pinned so a CLI release can't change deploy behaviour under us. */
const VERCEL_CLI = 'vercel@62.4.0'
// 內控文件 PDF 的 bucket：畫面已不開這些 PDF（Q127），`docs` 照舊上傳、留給日後恢復畫面時用。
const BUCKET = 'control-docs'
const SYNCHUB_URL = 'https://synchub.syncmold.com.tw'
const ALIASES = { all: ['check', 'db', 'seed', 'docs', 'function', 'web'], update: ['db', 'drafts', 'function', 'web'], 'update-pages': ['db', 'drafts', 'function', 'pages', 'publish'] }
/** Steps that change what an environment runs; they must come from main as merged. */
const FROM_MAIN_ONLY = new Set(['db', 'drafts', 'seed', 'docs', 'function', 'web', 'pages', 'publish', 'reset', 'restore', 'master', 'rebuild'])

const [envName, ...rest] = process.argv.slice(2)
const yes = rest.includes('--yes')
const allowBranch = rest.includes('--allow-branch')
const confirmProd = rest.includes('--confirm-prod')
const asMaintainer = rest.includes('--maintainer')
const dryRun = rest.includes('--dry-run')
const overwriteEdits = rest.includes('--overwrite-edits')
const FLAGS = ['--confirm-prod', '--yes', '--allow-branch', '--maintainer', '--dry-run', '--overwrite-edits']
const args = rest.filter((a) => !FLAGS.includes(a))
if (asMaintainer && !args.includes('allow')) {
  console.error('--maintainer 只能和 allow 一起用：npm run deploy -- <環境> allow <工號> [...] --maintainer')
  process.exit(2)
}
const environment = ENVIRONMENTS[envName]
if (!environment || args.length === 0) {
  console.error('用法：npm run deploy -- <test|prod> <update|update-pages|all|check|db|drafts|seed|allow 工號... [--maintainer]|docs|function|web|pages|publish|reset|backup|restore 備份檔|rebuild [--dry-run] [--overwrite-edits]|master> [--yes] [--allow-branch]')
  process.exit(2)
}

// ---- 設定 ----

if (existsSync('.env')) process.loadEnvFile('.env') // VITE_OMS_*, CSA_CONTROL_DOC_DIR, PG_BIN_DIR

function git(...a) {
  return execFileSync('git', a, { encoding: 'utf8' }).trim()
}
const mainCheckout = dirname(resolve(git('rev-parse', '--path-format=absolute', '--git-common-dir')))
const deployDir = process.env.CSA_DEPLOY_DIR || join(dirname(mainCheckout), 'csa-deploy')
const configFile = join(deployDir, `.env.deploy.${envName}`)
const CONFIG_KEYS = ['SUPABASE_DB_URL', 'SUPABASE_ANON_KEY', 'CSA_JWT_SECRET', 'OMS_CHANNEL_KEY', 'CSA_REQUIRE_OMS_AUTH', 'CSA_SITE_URL', 'CSA_VERCEL_PROJECT', 'CSA_EXTRA_ORIGINS', 'CSA_PAGES_BASE', 'CSA_CUSTOM_DOMAIN', 'CSA_SEED_AUDIT_CHIEF', 'CSA_SEED_MAINTAINERS', 'CSA_SEED_ALLOWLIST', 'VITE_OMS_URL', 'VITE_OMS_ANON_KEY']
const fromEnvVars = !existsSync(configFile)
// No local file: the environment's own variables (a GitHub Actions job gets the Environment's secrets this way).
const config = fromEnvVars ? Object.fromEntries(CONFIG_KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k]])) : parseEnvFile(configFile)
if (fromEnvVars && !config.SUPABASE_DB_URL) fail(`找不到 ${configFile}，環境變數也沒有 SUPABASE_DB_URL`)
if (envName === 'prod' && !config.CSA_SITE_URL) fail('prod 一定要設 CSA_SITE_URL（換證只回應這個網址的來源）')
for (const key of ['SUPABASE_DB_URL', 'SUPABASE_ANON_KEY', 'CSA_JWT_SECRET']) {
  if (!config[key]) fail(`${configFile} 的 ${key} 還沒填`)
}
if (config.CSA_JWT_SECRET.length < 32) fail('CSA_JWT_SECRET 太短，請貼 Supabase 的 Legacy JWT Secret')

const dbUrl = new URL(config.SUPABASE_DB_URL)
const projectRef = decodeURIComponent(dbUrl.username).split('.')[1]
if (!projectRef) fail('SUPABASE_DB_URL 要用 Session pooler 那一串（帳號是 postgres.<專案代碼>）；Direct connection 只有 IPv6，多半連不到')
if (dbUrl.password.includes('YOUR-PASSWORD')) fail('SUPABASE_DB_URL 裡的 [YOUR-PASSWORD] 還沒換成資料庫密碼')
const projectUrl = `https://${projectRef}.supabase.co`
// Vercel 專案名稱不給預設值：名稱一錯，`web` 會在 Vercel 上建出一個新專案，網址與換證允許的來源都會跟著錯。只有 `web` 需要。
const vercelProject = config.CSA_VERCEL_PROJECT || ''
/** The URL people open; it may carry a path (https://<帳號>.github.io/CSA). 沒填 CSA_SITE_URL 時，Vercel 專案推得出網址。 */
const siteUrl = (config.CSA_SITE_URL || (vercelProject ? `https://${vercelProject}.vercel.app` : '')).replace(/\/$/, '')
/** Browsers send only scheme + host as Origin, never the path; the exchange answers these origins only (CORS). */
const siteOrigin = siteUrl ? new URL(siteUrl).origin : ''
const allowedOrigins = [...new Set([siteOrigin, ...(config.CSA_EXTRA_ORIGINS ?? '').split(/[\s,]+/).map((o) => o.replace(/\/$/, ''))].filter(Boolean))]
// The pooler's certificate is signed by Supabase's own CA, which Node does not trust by default.
const sslDbUrl = withSslMode('no-verify')
/**
 * The same for PostgreSQL's own tools (pg_dump): libpq has no 'no-verify'; 'require' is its encrypt-without-verifying
 * mode, which is what no-verify means to Node's pg (libpq would verify after all if a root.crt sat in
 * %APPDATA%/postgresql, and then refuse Supabase's CA: it fails closed).
 */
const libpqDbUrl = withSslMode('require')

function withSslMode(mode) {
  const u = new URL(dbUrl)
  u.searchParams.set('sslmode', mode)
  return u.toString()
}
/** Values that must never appear in anything published. */
const secrets = [config.CSA_JWT_SECRET, decodeURIComponent(dbUrl.password), config.OMS_CHANNEL_KEY].filter(Boolean)

function parseEnvFile(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function step(title) {
  console.log(`\n▶ [${envName}] ${title}`)
}

/** supabase/drafts/templates 的範本定義檔（依廠區分資料夾），依路徑排序；和 rebuild 讀同一份清單。 */
function templateDrafts() {
  return templateDefinitions().map(({ file, text, def }) => ({ file, def: text, code: def.code }))
}

async function withDb(run) {
  const client = new pg.Client({ connectionString: sslDbUrl })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

function serviceToken() {
  return new SignJWT({ role: 'service_role' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('csa-deploy')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.CSA_JWT_SECRET))
}

/** Runs one of the repo's db scripts against this environment's database. */
function runDbScript(script, scriptArgs = []) {
  const r = spawnSync(process.execPath, [script, ...scriptArgs], {
    stdio: 'inherit',
    // OMS_CHANNEL_KEY for any db script that asks OMS's channel; today only demo:build does, for the names it lacks (Q133 (10)).
    env: { ...process.env, CSA_DB_URL: sslDbUrl, CSA_DB_ADMIN_URL: sslDbUrl, ...(config.OMS_CHANNEL_KEY ? { OMS_CHANNEL_KEY: config.OMS_CHANNEL_KEY } : {}) },
  })
  if (r.status !== 0) fail(`${script} 失敗`)
}

/** 放行名單的初始工號：稽核主管、系統維護員與 CSA_SEED_ALLOWLIST。 */
function seedEmpIds() {
  return [...new Set([config.CSA_SEED_AUDIT_CHIEF, ...empIdList(config.CSA_SEED_ALLOWLIST), ...extraAdmins()].map((s) => (s ?? '').trim().toUpperCase()).filter(Boolean))]
}

/** 工號 list from a setting; people type 「，」「、」 as often as ','. */
function empIdList(value) {
  return (value ?? '').split(/[\s,，、]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
}

/** 第一次初始化時設為系統維護員的人（CSA_SEED_MAINTAINERS）；平常在「權限管理」頁維護。 */
function extraAdmins() {
  return empIdList(config.CSA_SEED_MAINTAINERS)
}

/** OMS 專案（登入與查人）：部署設定優先，再看環境變數／本機 .env。 */
const omsUrl = (config.VITE_OMS_URL || process.env.VITE_OMS_URL || '').replace(/\/$/, '')
const omsAnonKey = config.VITE_OMS_ANON_KEY || process.env.VITE_OMS_ANON_KEY || ''
/** 少了 OMS 設定就不部署：換證會對所有人回 502，前端會把登入送到自己的網址（Pages 回 405）。 */
function requireOms(stepName) {
  if (!/^https:\/\/\S+$/.test(omsUrl) || !omsAnonKey) {
    fail(`${stepName} 需要 VITE_OMS_URL 與 VITE_OMS_ANON_KEY：請寫進部署設定（${fromEnvVars ? 'Environment 的 variables' : configFile}）`)
  }
}
/** GitHub Pages 的來源分支。 */
const PAGES_BRANCH = 'gh-pages'

/** The settings baked into the frontend at build time (VITE_*); base is the path the site is served from. */
function frontendBuildEnv(base) {
  return {
    ...process.env,
    VITE_BASE: base,
    VITE_SUPABASE_URL: projectUrl,
    VITE_SUPABASE_ANON_KEY: config.SUPABASE_ANON_KEY,
    VITE_EXCHANGE_URL: `${projectUrl}/functions/v1/csa-exchange`,
    VITE_DEV_LOGIN_URL: '',
    VITE_CSA_ENV_LABEL: environment.badge,
    VITE_SYNCHUB_URL: SYNCHUB_URL,
    VITE_OMS_URL: omsUrl,
    VITE_OMS_ANON_KEY: omsAnonKey,
  }
}

// ---- 步驟 ----

const steps = {
  async check() {
    step(`連線檢查（專案 ${projectRef}）`)
    const version = await withDb(async (c) => (await c.query('show server_version')).rows[0].server_version)
    console.log(`  資料庫 OK（Postgres ${version}）`)
    // OPEN-3 的風險：PostgREST 要接受以 Legacy JWT Secret 自簽的 HS256 token，換證簽的 session 才能用。
    // Asks for a table that does not exist: 404 (PGRST205) means the token got past the JWT check, 401 means it
    // did not. The API root (/rest/v1/) only takes the service_role API key, so it cannot be the probe.
    const r = await fetch(`${projectUrl}/rest/v1/csa_deploy_probe?limit=1`, {
      headers: { apikey: config.SUPABASE_ANON_KEY, Authorization: `Bearer ${await serviceToken()}` },
    })
    if (r.status === 401) fail('PostgREST 不接受自簽的 token（HTTP 401）：確認 CSA_JWT_SECRET 是 Legacy JWT Secret，且專案仍以它簽章')
    if (r.status !== 404 && !r.ok) fail(`PostgREST 回應異常：HTTP ${r.status} ${await r.text()}`)
    console.log('  PostgREST 接受自簽的 HS256 token')
  },

  async db() {
    step('套用 migration')
    runDbScript('scripts/db/migrate.mjs')
    step(`內控文件 bucket「${BUCKET}」與讀取規則`)
    await withDb(async (c) => {
      await c.query(`insert into storage.buckets (id, name, public) values ($1, $1, false)
                     on conflict (id) do update set public = false`, [BUCKET])
      // Any CSA session may read; nobody writes through the API (uploads use service_role).
      await c.query(`drop policy if exists csa_control_docs_read on storage.objects`)
      await c.query(`create policy csa_control_docs_read on storage.objects for select to authenticated
                     using (bucket_id = '${BUCKET}')`)
    })
    console.log('  OK')
  },

  async drafts() {
    step('新的範本（資料庫還沒有的編號，寫成停用）')
    await withDb(async (c) => {
      const existing = new Set((await c.query('select code from public.questionnaire_template')).rows.map((r) => r.code))
      const fresh = templateDrafts().filter((d) => !existing.has(d.code))
      for (const { def } of fresh) await c.query('select public.draft_template($1::jsonb)', [def])
      // 和 drafts:write 一樣提醒：沒有適用廠區的（samoa，Q111）在補上廠區前，發起與流程都用不到。
      const plantless = fresh.filter((d) => { const t = JSON.parse(d.def); return !t.allPlants && !(t.factoryCodes ?? []).length })
      if (plantless.length) console.log(`  ⚠ 沒有適用廠區：${plantless.map((d) => d.code).join('、')}（請稽核主管在範本頁的「編輯抬頭」補上）`)
      const byPlant = Object.entries(Object.groupBy(fresh, (d) => d.file.split(/[\\/]/)[0]))
      console.log(`  新增 ${fresh.length} 份${byPlant.length ? `（${byPlant.map(([plant, ds]) => `${plant} ${ds.length}`).join('、')}）` : ''}，是停用的，請稽核主管檢查後啟用；已有同編號的範本不動`)
    })
  },

  async seed() {
    const empIds = seedEmpIds()
    const chief = (config.CSA_SEED_AUDIT_CHIEF ?? '').trim().toUpperCase()
    if (!chief) fail('設定沒有 CSA_SEED_AUDIT_CHIEF（第一位稽核主管的工號）')
    // An empty 放行名單 means this environment has never been seeded. After that, roles, templates and routes belong to
    // the people using it (the test environment is clicked around on purpose): never overwrite them here. Re-running
    // seed used to set every admin back to 稽核管理者, which now would leave more than one 稽核主管 (#187).
    const fresh = await withDb(async (c) => (await c.query('select count(*)::int as n from public.access_allowlist')).rows[0].n === 0)
    const auditChief = chief
    const staff = []
    const maintainers = extraAdmins().filter((id) => id !== auditChief && !staff.includes(id))
    const roleText = `、稽核主管 ${auditChief}${staff.length ? `、稽核人員 ${staff.join('、')}` : ''}${maintainers.length ? `、系統維護員 ${maintainers.join('、')}` : ''}`
    step(`放行名單 ${empIds.length} 人${fresh ? roleText : ''}`)
    await withDb(async (c) => {
      for (const id of empIds) {
        await c.query('insert into public.access_allowlist (emp_id, note) values ($1, $2) on conflict (emp_id) do nothing', [id, 'seed'])
      }
      if (!fresh) return
      // employee_ref is normally created by the first login; the roles must be there before that login.
      const roles = [[auditChief, 'audit_admin'], ...staff.map((id) => [id, 'audit_staff']), ...maintainers.map((id) => [id, 'system_maintainer'])]
      for (const [id, role] of roles) {
        await c.query(
          `insert into public.employee_ref (emp_id, audit_role) values ($1, $2::public.audit_role)
           on conflict (emp_id) do update set audit_role = excluded.audit_role`,
          [id, role],
        )
      }
    })
    if (!fresh) {
      console.log('  這個環境已初始化過：角色、範本與簽核流程不動（換稽核主管在權限管理頁；要回到基準用 reset）')
      return
    }
    step('範本（supabase/drafts/templates），全部啟用')
    await withDb(async (c) => {
      const existing = new Set((await c.query('select code from public.questionnaire_template')).rows.map((r) => r.code))
      let written = 0
      for (const { file, def, code } of templateDrafts()) {
        if (existing.has(code)) {
          console.log(`  - ${file}：已有 ${code}，略過`)
          continue
        }
        await c.query('select public.draft_template($1::jsonb)', [def])
        written++
      }
      // 對話寫入寫成停用；這些是各廠實際要用的表，種子直接全部啟用（Q137 (7) ②）。
      const r = await c.query(`update public.questionnaire_template set status = 'active' where status <> 'active'`)
      console.log(`  寫入 ${written} 份，${r.rowCount} 份改為啟用`)
    })
  },

  async allow() {
    const ids = args.slice(args.indexOf('allow') + 1).flatMap((s) => s.split(/[,，、]+/)).map((s) => s.trim().toUpperCase()).filter(Boolean)
    if (ids.length === 0) fail('用法：npm run deploy -- <環境> allow <工號> [...] [--maintainer]')
    step(`放行名單加入 ${ids.join('、')}${asMaintainer ? '，設為系統維護員' : ''}`)
    await withDb(async (c) => {
      for (const id of ids) {
        // Role first, then the list, as db:set-role: the 加入 in the 異動紀錄 already says 系統維護員.
        if (asMaintainer) {
          await c.query(
            `insert into public.employee_ref (emp_id, audit_role) values ($1, 'system_maintainer')
             on conflict (emp_id) do update set audit_role = 'system_maintainer'`,
            [id],
          )
        }
        await c.query('insert into public.access_allowlist (emp_id) values ($1) on conflict do nothing', [id])
      }
    })
  },

  async docs() {
    const dir = process.env.CSA_CONTROL_DOC_DIR
    if (!dir || !existsSync(dir)) fail('本機 .env 的 CSA_CONTROL_DOC_DIR 沒設或資料夾不存在')
    const files = readdirSync(dir).filter((f) => /\.pdf$/i.test(f))
    step(`上傳 ${files.length} 份內控文件 PDF`)
    const token = await serviceToken()
    for (const file of files) {
      const r = await fetch(`${projectUrl}/storage/v1/object/${BUCKET}/${encodeURIComponent(file)}`, {
        method: 'POST',
        headers: { apikey: config.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
        body: readFileSync(join(dir, file)),
      })
      if (!r.ok) fail(`${file} 上傳失敗：HTTP ${r.status} ${await r.text()}`)
      console.log(`  ✓ ${file}`)
    }
  },

  async function() {
    step('Edge Function csa-exchange')
    if (!siteOrigin) fail('function 需要 CSA_SITE_URL（或 CSA_VERCEL_PROJECT）：換證只回應這個網址的來源')
    requireOms('function')
    // 匯入分派表的 OMS 比對要這把（Q133 (6)）。沒有時照樣部署（換證與其他修正不該被它擋下），也不寫空值，
    // 以免蓋掉 Supabase 上已經設好的那一把；只提醒。
    if (!config.OMS_CHANNEL_KEY) console.warn(`  ⚠ ${configFile} 沒有 OMS_CHANNEL_KEY：secrets 裡原本有就沿用，沒有的話匯入分派表會說「還沒設定 OMS 通道」`)
    const secretsFile = join(mkdtempSync(join(tmpdir(), 'csa-deploy-')), 'secrets.env')
    writeFileSync(secretsFile, [
      `VITE_OMS_URL=${omsUrl}`,
      `VITE_OMS_ANON_KEY=${omsAnonKey}`,
      `CSA_JWT_SECRET=${config.CSA_JWT_SECRET}`,
      'CSA_ACCESS_ALL=false',
      `CSA_TOKEN_TTL_SECONDS=${process.env.CSA_TOKEN_TTL_SECONDS || 3600}`,
      `CSA_ALLOWED_ORIGINS=${allowedOrigins.join(',')}`,
      ...(config.OMS_CHANNEL_KEY ? [`OMS_CHANNEL_KEY=${config.OMS_CHANNEL_KEY}`] : []),
      `CSA_REQUIRE_OMS_AUTH=${config.CSA_REQUIRE_OMS_AUTH || 'false'}`,
    ].join('\n'))
    try {
      supabase(['secrets', 'set', '--project-ref', projectRef, '--env-file', secretsFile])
    } finally {
      removeTemp(dirname(secretsFile))
    }
    supabase(['functions', 'deploy', 'csa-exchange', '--project-ref', projectRef, '--no-verify-jwt', '--use-api'])
    const r = await fetch(`${projectUrl}/functions/v1/csa-exchange`, { headers: { Origin: siteOrigin } })
    const body = await r.json().catch(() => null)
    if (!r.ok || body?.access_all !== false || body?.dev_login !== false) fail(`換證回應不對：HTTP ${r.status} ${JSON.stringify(body)}`)
    console.log('  換證上線：放行全開關閉、沒有開發期直接登入')
    // 實際走一次換證：假的 OMS token 要被 OMS 拒絕（401）。502 表示換證連不到 OMS（設定錯），那樣沒有人能登入。
    for (const origin of allowedOrigins) {
      const probe = await fetch(`${projectUrl}/functions/v1/csa-exchange`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ oms_token: 'deploy-probe-not-a-token' }),
      })
      const answer = await probe.json().catch(() => null)
      if (probe.status !== 401) fail(`換證連不到 OMS（${origin}）：HTTP ${probe.status} ${JSON.stringify(answer)}；現在沒有人能登入，請檢查 VITE_OMS_URL／VITE_OMS_ANON_KEY 後重跑 function`)
      if (probe.headers.get('access-control-allow-origin') !== origin) fail(`換證沒有允許來源 ${origin}（CORS）`)
    }
    console.log(`  換證連得到 OMS，允許的來源：${allowedOrigins.join('、')}`)
  },

  async web() {
    requireOms('web')
    if (!vercelProject) fail('web 需要 CSA_VERCEL_PROJECT（前端託管的專案名稱，例如 csa-demo-test）；用 GitHub Pages 請改跑 pages')
    // The folder's name is the Vercel project's name: `vercel deploy --yes` in an unlinked folder links to (or, the
    // first time, creates) the project of that name.
    const outDir = join(mkdtempSync(join(tmpdir(), 'csa-web-')), vercelProject)
    step('build 前端')
    const buildEnv = frontendBuildEnv('/')
    try {
      run('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], buildEnv)
      // Files first, then every other path is the app, so deep links and reloads work.
      writeFileSync(join(outDir, 'vercel.json'), JSON.stringify({ rewrites: [{ source: '/(.*)', destination: '/index.html' }] }, null, 2))
      scanForSecrets(outDir)

      step(`部署到 Vercel 專案 ${vercelProject}`)
      const r = spawnSync('npx', ['--yes', VERCEL_CLI, 'deploy', '--prod', '--yes'], { cwd: outDir, encoding: 'utf8', shell: process.platform === 'win32' })
      const output = `${r.stdout}
${r.stderr}`
      if (r.status !== 0) {
        console.error(output)
        fail('vercel deploy 失敗（還沒 npx vercel login？）')
      }
      const aliases = [...output.matchAll(/https:\/\/[a-z0-9.-]+\.vercel\.app/g)].map((m) => m[0])
      console.log(`  已部署：${siteOrigin}`)
      if (!aliases.includes(siteOrigin)) {
        console.warn(`  ⚠ Vercel 回報的網址（${[...new Set(aliases)].join('、')}）不含 ${siteOrigin}：請在設定檔填 CSA_SITE_URL，再跑一次 function 與 web`)
      }
    } finally {
      removeTemp(dirname(outDir))
    }
  },

  // GitHub Pages：只在本機 build 出一個可以直接發布的資料夾（<csa-deploy>/pages-<環境>/），不推送任何東西。
  // 發布方式由你決定：把這個資料夾的內容推到 Pages 用的分支（例如 gh-pages），或交給 actions/deploy-pages。
  //   base 路徑：CSA_PAGES_BASE，沒填就取 CSA_SITE_URL 的路徑（https://x.github.io/CSA → /CSA/；自訂網域 → /）
  //   404.html：Pages 不認得前端路由，重新整理或直接開 /CSA/admin 會 404；把 index.html 複製成 404.html 讓前端接手
  //   .nojekyll：關掉 Pages 的 Jekyll 處理；CNAME：CSA_CUSTOM_DOMAIN 有填才寫
  async pages() {
    requireOms('pages')
    if (!siteUrl) fail('pages 需要 CSA_SITE_URL（例如 https://<帳號>.github.io/CSA，或自訂網域 https://csa.example.com）')
    const base = (config.CSA_PAGES_BASE || new URL(siteUrl).pathname).replace(/\/?$/, '/')
    if (!base.startsWith('/')) fail(`CSA_PAGES_BASE 要以 / 開頭：${base}`)
    const outDir = join(deployDir, `pages-${envName}`)
    step(`build 前端（base ${base}）→ ${outDir}`)
    rmSync(outDir, { recursive: true, force: true })
    run('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], frontendBuildEnv(base))
    copyFileSync(join(outDir, 'index.html'), join(outDir, '404.html'))
    writeFileSync(join(outDir, '.nojekyll'), '')
    if (config.CSA_CUSTOM_DOMAIN) writeFileSync(join(outDir, 'CNAME'), `${config.CSA_CUSTOM_DOMAIN.trim()}
`)
    scanForSecrets(outDir)
    console.log(`  可以發布了：${outDir}`)
    console.log(`  網址：${siteUrl}`)
    console.log(`  換證允許的來源：${allowedOrigins.join('、')}（要和這個網址一致；不一致請設 CSA_SITE_URL 或 CSA_EXTRA_ORIGINS 後跑 function）`)
  },

  // 把 pages 產生的資料夾推到這個 repo 的 gh-pages 分支（GitHub Pages 的來源），再等網站換成新版。
  // gh-pages 只有 build 出來的檔案，和 main 沒有共同歷史。第一次要到 repo 的 Settings → Pages 把來源設成 gh-pages。
  async publish() {
    const outDir = join(deployDir, `pages-${envName}`)
    if (!existsSync(join(outDir, 'index.html'))) fail(`找不到 ${join(outDir, 'index.html')}：先跑 pages`)
    const remote = git('remote', 'get-url', 'origin')
    const work = join(mkdtempSync(join(tmpdir(), 'csa-pages-')), PAGES_BRANCH)
    const gitIn = (...a) => execFileSync('git', ['-C', work, ...a], { encoding: 'utf8' }).trim()
    step(`發布到 ${remote} 的 ${PAGES_BRANCH} 分支`)
    try {
      const exists = spawnSync('git', ['ls-remote', '--exit-code', '--heads', remote, PAGES_BRANCH], { stdio: 'ignore' }).status === 0
      if (exists) run('git', ['clone', '--quiet', '--depth', '1', '--branch', PAGES_BRANCH, '--single-branch', remote, work])
      else {
        mkdirSync(work, { recursive: true })
        gitIn('init', '--quiet', '-b', PAGES_BRANCH)
        gitIn('remote', 'add', 'origin', remote)
      }
      for (const entry of readdirSync(work)) if (entry !== '.git') rmSync(join(work, entry), { recursive: true, force: true })
      cpSync(outDir, work, { recursive: true })
      gitIn('add', '-A')
      if (!gitIn('status', '--porcelain')) console.log('  內容和線上的一樣，沒有東西要發布')
      else {
        // 用這個 repo 設定的作者（不要落到全域設定的個人信箱）。
        const who = ['user.name', 'user.email'].flatMap((k) => ['-c', `${k}=${git('config', k)}`])
        gitIn(...who, 'commit', '--quiet', '-m', `Deploy ${envName} ${git('rev-parse', '--short', 'HEAD')}`)
        run('git', ['-C', work, 'push', '--quiet', 'origin', PAGES_BRANCH])
        console.log('  已推送')
      }
    } finally {
      removeTemp(dirname(work))
    }
    if (!siteUrl) return
    // Pages 換版要一兩分鐘：等到線上的 index.html 指向這次 build 的那支 js。
    const entry = /assets\/index-[\w-]+\.js/.exec(readFileSync(join(outDir, 'index.html'), 'utf8'))?.[0]
    step(`等 ${siteUrl}/ 換成新版（${entry}）`)
    for (let i = 0; i < 30; i++) {
      const html = await fetch(`${siteUrl}/?v=${Date.now()}`).then((r) => r.text()).catch(() => '')
      if (entry && html.includes(entry)) {
        console.log('  線上已經是新版')
        return
      }
      await new Promise((r) => setTimeout(r, 10000))
    }
    fail(`等了 5 分鐘，${siteUrl}/ 還不是新版：到 repo 的 Settings → Pages 確認來源是 ${PAGES_BRANCH} 分支、Actions 頁的 pages build 有沒有失敗`)
  },

  async reset() {
    if (!environment.destructive) fail(`${environment.name}不能 reset（只有 test）；正式環境要重來請先備份，再另行處理`)
    if (!yes) fail(`${environment.name}的資料會全部清掉（會先備份）；確定的話加上 --yes`)
    await steps.backup()
    step('清空 CSA 資料（public、csa_meta schema）')
    await withDb(async (c) => {
      await c.query('drop schema if exists csa_meta cascade')
      await c.query('drop schema public cascade')
      // Recreate public the way a new Supabase project has it.
      await c.query('create schema public authorization pg_database_owner')
      await c.query('grant usage on schema public to postgres, anon, authenticated, service_role')
      for (const kind of ['tables', 'sequences', 'functions']) {
        await c.query(`alter default privileges in schema public grant all on ${kind} to postgres, anon, authenticated, service_role`)
      }
    })
    await steps.db()
    await steps.seed()
  },

  async master() {
    step('廠區主檔（OMS factories）')
    runDbScript('scripts/master/sync-plants.mjs')
  },

  async backup() {
    const bin = pgBin()
    const dir = join(deployDir, 'backups')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
    const file = join(dir, `${envName}-${stamp}.dump`)
    step(`備份到 ${file}`)
    run(join(bin, 'pg_dump'), ['--format=custom', '--no-owner', '--schema=public', '--schema=csa_meta', `--file=${file}`, libpqDbUrl])
    console.log(`  OK（${Math.round(statSync(file).size / 1024)} KB）`)
  },

  // 範本與流程照定義檔重建（#207，scripts/templates/rebuild.mjs）：刪掉全部年度作業與自評表、全部流程，範本照定義檔重寫並
  // 啟用，每份範本 × 廠區建一條分流流程。放行名單、角色、廠區管理員不動。--dry-run 做完再退回，只看結果，不備份。
  async rebuild() {
    if (!environment.destructive) fail(`${environment.name}不能跑 rebuild（只有 test）`)
    if (!dryRun && !yes) fail(`${environment.name}的全部年度作業、自評表與簽核流程都會刪掉，範本照定義檔重寫；確定的話加上 --yes（先看結果用 --dry-run）`)
    if (!dryRun) await steps.backup()
    step(`範本與簽核流程照定義檔重建${dryRun ? '（--dry-run，最後退回）' : ''}`)
    await withDb((c) => rebuildTemplates(c, templateDefinitions(), { dryRun, overwriteEdits }))
  },

  async restore() {
    const file = args[args.indexOf('restore') + 1]
    if (!file || !existsSync(file)) fail('用法：npm run deploy -- <環境> restore <備份檔> --yes')
    if (!yes) fail(`${environment.name}會回到備份當時，備份之後的資料都會消失；確定的話加上 --yes`)
    if (!environment.destructive && !confirmProd) fail(`${environment.name}要還原，請同時加上 --confirm-prod`)
    await steps.backup()
    step(`還原 ${file}`)
    runDbScript('scripts/db/restore.mjs', [file])
  },
}

/** Temp folders only; Windows may still hold a file the CLI just read, which must not fail a finished deploy. */
function removeTemp(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  } catch {
    console.warn(`  （暫存資料夾 ${path} 刪不掉，可以之後手動刪）`)
  }
}

function run(cmd, cmdArgs, env = process.env) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env, shell: process.platform === 'win32' && cmd === 'npx' })
  if (r.status !== 0) fail(`${cmd} ${cmdArgs[0]} 失敗`)
}

function supabase(cmdArgs) {
  run('npx', ['supabase', ...cmdArgs])
}

/** Refuses to publish a build containing a secret value or any JWT that is not a plain anon key. */
function scanForSecrets(dir) {
  const files = readdirSync(dir, { recursive: true }).map((f) => join(dir, f)).filter((f) => statSync(f).isFile())
  for (const file of files) {
    const text = readFileSync(file, 'latin1')
    for (const secret of secrets) if (text.includes(secret)) fail(`build 裡有金鑰（${file}），不推送`)
    for (const jwt of text.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g) ?? []) {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
      if (payload.role !== 'anon') fail(`build 裡有 role=${payload.role} 的 JWT（${file}），不推送`)
    }
  }
  console.log(`  金鑰檢查 OK（${files.length} 個檔案）`)
}

// allow and restore take what follows them as their own arguments.
const argsAt = args.findIndex((a) => a === 'allow' || a === 'restore')
const named = argsAt === -1 ? args : args.slice(0, argsAt + 1)
const unknown = named.filter((a) => !(a in steps) && !(a in ALIASES))
if (unknown.length) fail(`不認得的步驟：${unknown.join('、')}`)
const queue = named.flatMap((a) => ALIASES[a] ?? [a])
if (queue.some((name) => FROM_MAIN_ONLY.has(name))) requireMergedMain()

/** Deploys come from main as merged, so an environment never runs code that is not on GitHub's main. */
function requireMergedMain() {
  if (allowBranch) {
    console.warn('⚠ --allow-branch：不檢查分支，部署目前這份程式')
    return
  }
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') fail(`目前在 ${branch}，部署只能從 main 做（合併後在主 checkout 執行；刻意部署分支加 --allow-branch）`)
  if (git('status', '--porcelain')) fail('有未 commit 的修改，先 commit 或清掉再部署')
  git('fetch', '--quiet', 'origin', 'main')
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('本機 main 和 origin/main 不一致，先 git pull（或推上去）再部署')
}
for (const name of queue) await steps[name]()
console.log(`\n✓ [${envName}] 完成：${queue.join(' → ')}`)
