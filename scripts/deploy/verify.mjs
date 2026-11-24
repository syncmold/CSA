// npm run deploy:verify -- <A> <B>
//
// 比較兩個環境是不是「除了資料庫本身，設計都一樣」。A、B 可以是 test、prod（讀 <csa-deploy>/.env.deploy.<環境>，
// 找法同 deploy.mjs）或 local（本機 .env 的 CSA_DB_ADMIN_URL ＋ CSA_DB_URL 的資料庫名稱）。
// 全程唯讀，不寫任何資料；金鑰與連線字串不會印出來。
//
// 檢查四件事：
//   1. 資料庫結構：資料表欄位、限制、索引、函式內容、RLS 規則、觸發器、權限、列舉、已套用的 migration
//   2. 換證服務（Edge Function）的安全開關：放行全開與開發期直接登入都必須是關閉（只對有 Supabase 專案的環境）
//   3. 設定性資料：範本（章節、控制要點、自評單位、適用廠區）、簽核流程、廠區與公司、廠區管理員
//   4. 資訊（不算不一致）：放行名單與使用者資料的筆數，這些本來就會因環境而不同
// 有不一致時結束代碼是 1。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import pg from 'pg'

const [a, b] = process.argv.slice(2)
if (!a || !b) {
  console.error('用法：npm run deploy:verify -- <test|prod|local> <test|prod|local>')
  process.exit(2)
}

function parseEnvFile(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function deployDir() {
  if (process.env.CSA_DEPLOY_DIR) return process.env.CSA_DEPLOY_DIR
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  return join(dirname(dirname(resolve(common))), 'csa-deploy')
}

/** → { label, client config, supabase?: { projectUrl, siteOrigin } } */
function target(name) {
  if (name === 'local') {
    if (existsSync('.env')) process.loadEnvFile('.env')
    const admin = new URL(process.env.CSA_DB_ADMIN_URL ?? '')
    admin.pathname = new URL(process.env.CSA_DB_URL ?? '').pathname
    return { label: 'local', config: { connectionString: admin.toString() } }
  }
  const file = join(deployDir(), `.env.deploy.${name}`)
  if (!existsSync(file)) {
    console.error(`找不到 ${file}`)
    process.exit(2)
  }
  const cfg = parseEnvFile(file)
  const url = new URL(cfg.SUPABASE_DB_URL)
  const ref = decodeURIComponent(url.username).split('.')[1]
  url.searchParams.delete('sslmode')
  const vercelProject = cfg.CSA_VERCEL_PROJECT || ''
  return {
    label: name,
    config: { connectionString: url.toString(), ssl: { rejectUnauthorized: false } },
    supabase: {
      projectUrl: `https://${ref}.supabase.co`,
      siteOrigin: (() => { const u = (cfg.CSA_SITE_URL || (vercelProject ? `https://${vercelProject}.vercel.app` : '')).replace(/\/$/, ''); return u ? new URL(u).origin : '' })(),
    },
  }
}

// ---- 查詢 ----
// 每個查詢回傳 { key, value } 列：key 是這一項的名字，value 是它的內容；兩邊用 key 對，value 不同就是不一致。

const SCHEMAS = `('public','csa_meta')`

const STRUCTURE = {
  欄位: `
    select table_schema || '.' || table_name || '.' || column_name as key,
           concat_ws(' | ', udt_name, is_nullable, coalesce(column_default, '')) as value
    from information_schema.columns where table_schema in ${SCHEMAS}`,
  限制: `
    select c.conrelid::regclass::text || ' :: ' || c.conname as key, pg_get_constraintdef(c.oid) as value
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${SCHEMAS}`,
  索引: `
    select schemaname || '.' || tablename || ' :: ' || indexname as key, indexdef as value
    from pg_indexes where schemaname in ${SCHEMAS}`,
  函式: `
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as key,
           md5(pg_get_functiondef(p.oid)) as value
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ${SCHEMAS} and p.prokind in ('f', 'p')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
  函式執行權限: `
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as key,
           concat_ws(',', case when has_function_privilege('anon', p.oid, 'execute') then 'anon' end,
                          case when has_function_privilege('authenticated', p.oid, 'execute') then 'authenticated' end,
                          case when has_function_privilege('service_role', p.oid, 'execute') then 'service_role' end) as value
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ${SCHEMAS} and p.prokind in ('f', 'p')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
  RLS規則: `
    select schemaname || '.' || tablename || ' :: ' || policyname as key,
           concat_ws(' | ', cmd, roles::text, coalesce(qual, ''), coalesce(with_check, '')) as value
    from pg_policies where schemaname in ${SCHEMAS}`,
  RLS開關: `
    select n.nspname || '.' || c.relname as key, concat_ws(' | ', c.relrowsecurity::text, c.relforcerowsecurity::text) as value
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ${SCHEMAS} and c.relkind = 'r'`,
  觸發器: `
    select t.tgrelid::regclass::text || ' :: ' || t.tgname as key, pg_get_triggerdef(t.oid) as value
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname in ${SCHEMAS}`,
  資料表權限: `
    select table_schema || '.' || table_name || ' :: ' || grantee as key, string_agg(privilege_type, ',' order by privilege_type) as value
    from information_schema.role_table_grants
    where table_schema in ${SCHEMAS} and grantee in ('anon', 'authenticated', 'service_role')
    group by 1`,
  列舉: `
    select n.nspname || '.' || t.typname as key, string_agg(e.enumlabel, ',' order by e.enumsortorder) as value
    from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
    where n.nspname in ${SCHEMAS} group by 1`,
  已套用的migration: `select version as key, 'applied' as value from csa_meta.schema_migrations`,
}

/** 設定性資料：用業務上的名字當 key，不用 uuid（兩個環境各自產生的 uuid 本來就不同）。 */
const CONFIG = {
  公司: `
    select name as key, coalesce(logo_path, '') as value from public.company`,
  廠區: `
    select p.factory_code as key, concat_ws(' | ', p.name, c.name, coalesce(p.sort_order::text, '')) as value
    from public.plant p join public.company c on c.id = p.company_id`,
  自評單位: `select name as key, 'unit' as value from public.assessing_unit`,
  範本: `
    select t.code as key,
      md5(jsonb_build_object(
        'name', t.name, 'layout', t.layout, 'status', t.status, 'all_plants', t.all_plants, 'component', t.component,
        'plants', coalesce((select jsonb_agg(tp.factory_code order by tp.factory_code) from public.template_plant tp where tp.template_id = t.id), '[]'::jsonb),
        'sections', coalesce((
          select jsonb_agg(jsonb_build_object(
            'pos', s.position, 'name', s.name, 'code', s.code, 'level', s.level,
            'points', coalesce((
              select jsonb_agg(jsonb_build_object(
                'pos', cp.position, 'text', cp.text, 'code', cp.code,
                'units', coalesce((select jsonb_agg(u2.name order by cpu.position) from public.control_point_unit cpu
                                   join public.assessing_unit u2 on u2.id = cpu.assessing_unit_id where cpu.control_point_id = cp.id), '[]'::jsonb)
              ) order by cp.position) from public.control_point cp where cp.section_id = s.id), '[]'::jsonb)
          ) order by s.position) from public.template_section s where s.template_id = t.id), '[]'::jsonb)
      )::text) as value
    from public.questionnaire_template t`,
  簽核流程: `
    select t.code || ' × ' || p.factory_code as key,
      md5(jsonb_build_object(
        'steps', coalesce((
          select jsonb_agg(jsonb_build_object(
            'pos', st.position, 'name', st.name, 'group', st.step_group, 'signer', st.signer_emp_id, 'link', st.link,
            'unit', (select u.name from public.assessing_unit u where u.id = st.editable_unit_id),
            'branch', (select u.name from public.assessing_unit u where u.id = st.branch_unit_id)
          ) order by st.position) from public.route_step st where st.route_id = r.id), '[]'::jsonb)
      )::text) as value
    from public.approval_route r
    join public.questionnaire_template t on t.id = r.template_id
    join public.plant p on p.id = r.plant_id`,
  廠區管理員: `
    select p.factory_code as key, pc.emp_id as value
    from public.plant_coordinator pc join public.plant p on p.id = pc.plant_id`,
}

/** 資訊：這些本來就會因環境而不同，只列筆數。 */
const INFO = {
  放行名單: 'select count(*) from public.access_allowlist',
  員工參照: 'select count(*) from public.employee_ref',
  年度作業: 'select count(*) from public.annual_cycle',
  自評表: 'select count(*) from public.assessment',
}

async function connect(t) {
  const client = new pg.Client(t.config)
  await client.connect()
  await client.query('set default_transaction_read_only = on')
  return client
}

async function rows(client, sql) {
  return new Map((await client.query(sql)).rows.map((r) => [r.key, r.value]))
}

/** Edge Function 的安全開關（唯讀 GET）。 */
async function functionFlags(t) {
  if (!t.supabase) return null
  try {
    const r = await fetch(`${t.supabase.projectUrl}/functions/v1/csa-exchange`, { headers: { Origin: t.supabase.siteOrigin } })
    const body = await r.json().catch(() => null)
    return { status: r.status, access_all: body?.access_all, dev_login: body?.dev_login }
  } catch (e) {
    return { error: String(e.message ?? e) }
  }
}

const LIMIT = 8
let problems = 0

function compare(group, name, left, right) {
  const onlyA = [...left.keys()].filter((k) => !right.has(k))
  const onlyB = [...right.keys()].filter((k) => !left.has(k))
  const differ = [...left.keys()].filter((k) => right.has(k) && left.get(k) !== right.get(k))
  const n = onlyA.length + onlyB.length + differ.length
  if (n === 0) {
    console.log(`  ✓ ${name}（${left.size} 項）`)
    return
  }
  problems += n
  console.log(`  ✗ ${name}：${A.label} ${left.size} 項、${B.label} ${right.size} 項，${n} 處不同`)
  const show = (title, list) => {
    if (!list.length) return
    console.log(`      ${title}（${list.length}）`)
    for (const k of list.slice(0, LIMIT)) console.log(`        - ${k}`)
    if (list.length > LIMIT) console.log(`        … 還有 ${list.length - LIMIT} 項`)
  }
  show(`只在 ${A.label}`, onlyA)
  show(`只在 ${B.label}`, onlyB)
  show('內容不同', differ)
}

const A = target(a)
const B = target(b)
console.log(`比較 ${A.label} ⇄ ${B.label}（唯讀）`)
const ca = await connect(A)
const cb = await connect(B)
try {
  console.log('\n1. 資料庫結構')
  for (const [name, sql] of Object.entries(STRUCTURE)) compare('structure', name, await rows(ca, sql), await rows(cb, sql))

  console.log('\n2. 換證服務的安全開關')
  for (const t of [A, B]) {
    const f = await functionFlags(t)
    if (!f) console.log(`  - ${t.label}：不是 Supabase 專案，略過`)
    else if (f.error) {
      problems++
      console.log(`  ✗ ${t.label}：連不到換證服務（${f.error}）`)
    } else if (f.status === 200 && f.access_all === false && f.dev_login === false) console.log(`  ✓ ${t.label}：放行全開＝關、開發期直接登入＝關`)
    else {
      problems++
      console.log(`  ✗ ${t.label}：HTTP ${f.status}，access_all=${f.access_all}、dev_login=${f.dev_login}（兩者都必須是 false）`)
    }
  }

  console.log('\n3. 設定性資料（範本、簽核流程、廠區）')
  for (const [name, sql] of Object.entries(CONFIG)) compare('config', name, await rows(ca, sql), await rows(cb, sql))

  console.log('\n4. 資訊（本來就會因環境而不同，不算不一致）')
  for (const [name, sql] of Object.entries(INFO)) {
    const [x, y] = await Promise.all([ca.query(sql), cb.query(sql)])
    console.log(`  · ${name}：${A.label} ${x.rows[0].count}、${B.label} ${y.rows[0].count}`)
  }
} finally {
  await ca.end()
  await cb.end()
}

if (problems) {
  console.log(`\n✗ 有 ${problems} 處不一致`)
  process.exit(1)
}
console.log('\n✓ 結構、換證開關與設定性資料都一致')
