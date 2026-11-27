// 資料 API 接縫的共用輔助: 走真實的 換證 → CSA session token → PostgREST 路徑。
// Needs a running CSA database behind PostgREST (`npm run db:start`, or the Supabase stack in CI).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'
import { ADMIN_EMAIL } from '../../exchange/adminAccount'
import { exchange, type ExchangeDeps } from '../../exchange/core'
import { depsFromEnv, mintServiceToken } from '../../exchange/node'

export const REST_URL = (process.env.CSA_REST_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
const JWT_SECRET = process.env.CSA_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long'
const ANON_KEY =
  process.env.VITE_SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

/** supabase-js is pointed at an origin and appends /rest/v1 itself. */
const API_ORIGIN = REST_URL.replace(/\/rest\/v1$/, '')
const usesRestPrefix = REST_URL.endsWith('/rest/v1')

export function restClient(token: () => Promise<string | null>): SupabaseClient {
  // Plain PostgREST has no /rest/v1 prefix; point supabase-js at a tiny shim via fetch rewrite.
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const rewritten = usesRestPrefix ? url : url.replace(`${API_ORIGIN}/rest/v1`, API_ORIGIN)
    return fetch(rewritten, init)
  }
  return createClient(API_ORIGIN, ANON_KEY, { accessToken: token, global: { fetch: fetchImpl } })
}

/** service_role client, for test setup only. */
export const admin = restClient(() => mintServiceToken(JWT_SECRET))

/** A stable, valid UUID per fake employee (JWT `sub` must be a uuid for auth.uid()). */
function fakeUserId(empId: string): string {
  const hex = Buffer.from(empId, 'utf8').toString('hex').padEnd(12, '0').slice(-12)
  return `00000000-0000-4000-8000-${hex}`
}

/** Real CSA-side deps (writes employee_ref as service_role); fake OMS. */
export function depsFor(empId: string, name: string, accessAll = true): ExchangeDeps {
  const real = depsFromEnv({
    OMS_URL: 'http://oms.invalid',
    OMS_ANON_KEY: 'unused',
    CSA_REST_URL: REST_URL,
    CSA_JWT_SECRET: JWT_SECRET,
    CSA_ACCESS_ALL: String(accessAll),
    CSA_REST_APIKEY: ANON_KEY,
    CSA_TOKEN_TTL_SECONDS: '600',
    CSA_DEV_LOGIN: 'false',
    OMS_CHANNEL_KEY: '',
    CSA_REQUIRE_OMS_AUTH: 'false',
  })
  return {
    ...real,
    oms: {
      getUser: async () => ({ id: fakeUserId(empId), email: `${empId.toLowerCase()}@id.syncmold.com.tw` }),
      // OMS's oms_my_access row for them: 在職 at FQ (Q133 (5)); the channel knows them the same way (#218).
      getAccess: async () => ({ emp_id: empId, name, factory_code: 'FQ', active: true, systems: ['OMS'] }),
      channel: async (ids) =>
        new Map(ids.map((id) => [id.trim().toUpperCase(), {
          asked: id.trim().toUpperCase(), found: true, emp_id: empId, status: '在職', factory_code: 'FQ', posting_factory: null,
          concurrent_factories: [], name, has_account: true, account_active: true, csa: true,
        }])),
    },
  }
}

/** Run the real exchange for `empId` (creates/refreshes the employee_ref row); returns the raw result. */
export function exchangeAs(empId: string, name: string) {
  return exchange('fake-oms-token', depsFor(empId, name))
}

/** Log in as `empId`: exchange, then a PostgREST client carrying the CSA session token. */
export async function loginAs(empId: string, name: string): Promise<SupabaseClient> {
  const result = await exchangeAs(empId, name)
  if (!result.ok) throw new Error(`exchange failed: ${result.error}`)
  return restClient(async () => result.csaToken)
}

/** Run the real exchange for the 管理員帳號 (#161): OMS knows it by its Email and gives it no 工號. */
export function exchangeAsAdminAccount() {
  return exchange('fake-oms-token', {
    ...depsFor('UNUSED', 'unused'),
    oms: {
      getUser: async () => ({ id: fakeUserId('admin'), email: ADMIN_EMAIL }),
      getAccess: async () => ({ emp_id: null, name: 'DTO', factory_code: null, active: true, systems: ['OMS'] }),
      channel: async () => {
        throw new Error('not an employee: must not be looked up')
      },
    },
  })
}

/** Log in as the 管理員帳號: exchange, then a PostgREST client carrying its CSA session token. */
export async function loginAsAdminAccount(): Promise<SupabaseClient> {
  const result = await exchangeAsAdminAccount()
  if (!result.ok) throw new Error(`exchange failed: ${result.error}`)
  return restClient(async () => result.csaToken)
}

export async function requirePostgrest(): Promise<void> {
  const probe = await fetch(`${REST_URL}/`).catch(() => null)
  if (!probe) {
    throw new Error(`PostgREST is not reachable at ${REST_URL}. Run \`npm run db:start\` first (see README › 本機開發).`)
  }
}

/**
 * 放行（Q150）：關卡上的簽核人要在放行名單上（require_listed_signer），被分派也不再放行，所以測試先把要排進關卡的人
 * 加進名單，像系統維護員開通過一樣。以超級使用者寫，工號照名單的寫法（大寫、去空白），已在名單上的不動。
 */
export async function listPeople(...empIds: (string | null | undefined)[]): Promise<void> {
  const ids = [...new Set(empIds.flatMap((id) => (id?.trim() ? [id.trim().toUpperCase()] : [])))]
  if (!ids.length) return
  await withSuperuser((sql) => sql.query('insert into public.access_allowlist (emp_id) select unnest($1::text[]) on conflict do nothing', [ids]))
}

/**
 * afterAll：把工號以 `prefix` 開頭（不分大小寫）的人移出放行名單。逐筆刪，最後一位稽核主管、系統維護員的守門
 * （guard_last_holder）擋下的那一筆留著，不影響其他筆。負責廠區跟著名單刪（外鍵 on delete cascade）。
 */
export async function unlistPeople(prefix: string): Promise<void> {
  await withSuperuser(async (sql) => {
    const { rows } = await sql.query('select emp_id from public.access_allowlist where emp_id like $1', [`${prefix.toUpperCase()}%`])
    for (const { emp_id } of rows) await sql.query('delete from public.access_allowlist where emp_id = $1', [emp_id]).catch(() => null)
  })
}

/**
 * Insert one row as service_role (test setup) and return it. A 關卡 (route_step, assessment_step) with a 簽核人 first
 * puts that person on the 放行名單 (listPeople, Q150), since the database refuses an unlisted one.
 */
export async function insertRow<T = { id: string }>(table: string, row: object): Promise<T> {
  if (table === 'route_step' || table === 'assessment_step') await listPeople((row as { signer_emp_id?: string | null }).signer_emp_id)
  const { data, error } = await admin.from(table).insert(row).select().single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data as T
}

/** 範本內容：[章名, [[控制要點, 自評單位 id（多單位給依序的清單；要素類可以是 null）]]]，依紙本順序。 */
export type TemplateSections = [string, [string, UnitIds][]][]
type UnitIds = string | string[] | null

/**
 * Test setup: a control point and its 自評單位 (in order) in one transaction, as superuser. A 控制活動類 control point
 * must have a unit when its transaction ends (#46), and service_role over PostgREST can only write one table per request.
 */
export async function insertControlPoint(sectionId: string, position: number, text: string, units: UnitIds): Promise<string> {
  const ids = units === null ? [] : Array.isArray(units) ? units : [units]
  return withSuperuser(async (sql) => {
    await sql.query('begin')
    try {
      const { rows } = await sql.query('insert into public.control_point (section_id, position, text) values ($1, $2, $3) returning id', [
        sectionId, position, text,
      ])
      await sql.query(
        'insert into public.control_point_unit (control_point_id, position, assessing_unit_id) select $1, o.ord, o.id from unnest($2::uuid[]) with ordinality o(id, ord)',
        [rows[0].id, ids],
      )
      await sql.query('commit')
      return rows[0].id as string
    } catch (e) {
      await sql.query('rollback')
      throw e
    }
  })
}

/** An active 問卷範本 that applies only to `factoryCode`, so other tests' launches never pick it up. */
export async function makeTemplate(code: string, layout: 'control_activity' | 'element', factoryCode: string, sections: TemplateSections) {
  const template = await insertRow('questionnaire_template', {
    code, name: `${code} 範本`, layout, status: 'active', all_plants: false,
  })
  await insertRow('template_plant', { template_id: template.id, factory_code: factoryCode })
  for (const [i, [name, points]] of sections.entries()) {
    const section = await insertRow('template_section', { template_id: template.id, position: i + 1, name })
    for (const [j, [text, units]] of points.entries()) await insertControlPoint(section.id, j + 1, text, units)
  }
  return template.id
}

/**
 * The real FQ-02 (the seeded 02, Q111) applies only to FQ; a test that launches it or builds a route on it for its own
 * plants adds them here and removes them with `releaseFq02`. Returns the template id.
 */
export async function borrowFq02(...factoryCodes: string[]): Promise<string> {
  const id = await fq02Id()
  for (const factoryCode of factoryCodes) await insertRow('template_plant', { template_id: id, factory_code: factoryCode })
  return id
}

export async function releaseFq02(...factoryCodes: string[]): Promise<void> {
  await admin.from('template_plant').delete().eq('template_id', await fq02Id()).in('factory_code', factoryCodes)
}

async function fq02Id(): Promise<string> {
  return ok(await admin.from('questionnaire_template').select('id').eq('code', 'FQ-02').single()).id as string
}

export interface RouteStepSpec {
  name: string
  group: 'plant' | 'audit_review'
  /** 流程上的簽核人（Q147：廠區端也在發出前分派在流程上）；空字串＝還沒分派 */
  signer: string
  /** 可編輯範圍的自評單位 id；null＝唯讀 */
  unitId: string | null
  /** 所屬分流的自評單位 id（#97）；不給＝自行檢查人員關卡跟著可編輯範圍，其餘在匯流後 */
  branchUnitId?: string | null
}

/** 連動標記（#189）：makeRoute 給稽核室覆核裡這兩個名稱的關卡帶標記。 */
const LINK_NAMES = { 台北稽核人員: 'taipei_auditor', 稽核主管: 'audit_chief' } as const

/** 發起檢查要的兩個連動關卡（#189），依序放在流程最後：台北稽核人員、稽核主管（稽核主管要是最後一關）。 */
export function linkedAuditSteps(signer: string): RouteStepSpec[] {
  return [
    { name: '台北稽核人員', group: 'audit_review', signer, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer, unitId: null },
  ]
}

/**
 * The 簽核流程 for 範本 × 廠區 with these 關卡 in order; returns the route id. 稽核室覆核 steps named 台北稽核人員 or
 * 稽核主管 get their 連動標記 (#189); a route launched through the 發起檢查 needs both (see linkedAuditSteps). Its 簽核人
 * go on the 放行名單 first (listPeople, Q150); call unlistPeople(RUN) in afterAll.
 */
export async function makeRoute(templateId: string, plantId: string, steps: RouteStepSpec[]): Promise<string> {
  await listPeople(...steps.map((s) => s.signer))
  const route = await insertRow('approval_route', { template_id: templateId, plant_id: plantId })
  for (const [i, s] of steps.entries()) {
    await insertRow('route_step', {
      route_id: route.id, position: i + 1, name: s.name, step_group: s.group, signer_emp_id: s.signer || null, editable_unit_id: s.unitId,
      ...(s.branchUnitId === undefined ? {} : { branch_unit_id: s.branchUnitId }),
      ...(s.group === 'audit_review' && s.name in LINK_NAMES ? { link: LINK_NAMES[s.name as keyof typeof LINK_NAMES] } : {}),
    })
  }
  return route.id
}

/** 測試用的廠區負責人：發起要廠區有負責人（#101），這個人不做別的事。 */
const LAUNCH_COORDINATOR = 'ZZLAUNCH'

/** Runs `launch` with every given plant that has no 廠區負責人 temporarily given one, because a plant needs one to launch. */
export async function withCoordinators<T>(plantIds: readonly string[], launch: () => PromiseLike<T>): Promise<T> {
  const added = await withSuperuser(async (sql) => {
    // In the order access_management's truncate takes these tables, or the two can deadlock when the test files overlap.
    await sql.query('begin')
    await sql.query('lock table public.access_allowlist in row share mode')
    await sql.query('insert into public.access_allowlist (emp_id) values ($1) on conflict do nothing', [LAUNCH_COORDINATOR])
    const { rows } = await sql.query(
      `insert into public.plant_coordinator (plant_id, emp_id) select p, $2 from unnest($1::uuid[]) p
       on conflict do nothing returning plant_id`,
      [[...new Set(plantIds)], LAUNCH_COORDINATOR],
    )
    await sql.query('commit')
    return rows.map((r) => r.plant_id as string)
  })
  try {
    return await launch()
  } finally {
    await withSuperuser((sql) => sql.query('delete from public.plant_coordinator where plant_id = any($1::uuid[]) and emp_id = $2', [added, LAUNCH_COORDINATOR]))
  }
}

const UUID = /^[0-9a-f-]{36}$/i

interface LaunchArgs {
  p_year: number
  p_due_date: string
  p_combos?: unknown
}

/**
 * 發起 as `client` with a 廠區管理員 on every plant (a plant needs one to launch). The routes carry their 簽核人 (Q147:
 * 分派 before the launch, makeRoute's `signer`), so the 自評表 come out assigned; for the many tests about what happens
 * after that. The 分派 itself is tested in assignment.rls.test.ts.
 */
export async function launchAssigned<T extends { data: unknown; error: unknown }>(
  client: { rpc(fn: 'launch_annual_cycle', args: LaunchArgs): PromiseLike<T> },
  args: LaunchArgs,
): Promise<T> {
  // Some tests send malformed 組合 on purpose; those plants need no 負責人, the launch refuses first.
  const combos = (Array.isArray(args.p_combos) ? args.p_combos : []) as { plant_id?: string }[]
  const plantIds = combos.flatMap((c) => (UUID.test(c?.plant_id ?? '') ? [c.plant_id!] : []))
  return withCoordinators(plantIds, () => client.rpc('launch_annual_cycle', args))
}

/** Make `empId` a 稽核管理者 (employee_ref is service_role-writable only). */
export async function promoteToAuditAdmin(empId: string): Promise<void> {
  const { error } = await admin.from('employee_ref').update({ audit_role: 'audit_admin' }).eq('emp_id', empId)
  if (error) throw error
}

/** Make `empId` a 系統維護員 (Q122), the same way. */
export async function promoteToSystemMaintainer(empId: string): Promise<void> {
  const { error } = await admin.from('employee_ref').update({ audit_role: 'system_maintainer' }).eq('emp_id', empId)
  if (error) throw error
}

/**
 * Log in as a 系統維護員 on the 放行名單: the only one who adds, edits and removes people (Q150), so test setup that
 * lets people in goes through them.
 */
export async function loginAsMaintainer(empId: string, name: string): Promise<SupabaseClient> {
  await loginAs(empId, name)
  await promoteToSystemMaintainer(empId)
  await listPeople(empId)
  return loginAs(empId, name)
}

/** Throws on a PostgREST error; writes without `.select()` come back with null data, which callers ignore. */
export function ok<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.error) throw new Error(JSON.stringify(result.error))
  return result.data as NonNullable<T>
}

/**
 * A direct Postgres connection (superuser, on the CSA database, or on `database` when given) for tests that need two
 * transactions at once, which PostgREST cannot hold open, or a database of their own. Null when the database is not
 * reachable this way.
 */
export async function directDb(database?: string): Promise<import('pg').Client | null> {
  const dbUrl = process.env.CSA_DB_URL
  const adminUrl = process.env.CSA_DB_ADMIN_URL
  if (!dbUrl || !adminUrl) return null
  const url = new URL(adminUrl)
  url.pathname = database ? `/${database}` : new URL(dbUrl).pathname
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 2000 })
  try {
    await client.connect()
    return client
  } catch {
    return null
  }
}

/**
 * A database of its own (`<prefix>_<random>`) with every migration applied, for tests of what is database-wide: 換稽核主管
 * demotes the one before and moves the 稽核主管 關卡 of every route and 自評表 (#190), which in the shared database would
 * rewrite and lock what the other test files are using. Null when directDb cannot connect (the test skips); `drop` ends
 * the connection and removes the database. With `before`, only the migrations named before it are applied, and
 * `migrateRest` applies the others: for a test of what a migration does to the data already there.
 */
export async function migratedDb(
  prefix: string,
  { before }: { before?: string } = {},
): Promise<{ db: import('pg').Client; drop: () => Promise<void>; migrateRest: () => Promise<void> } | null> {
  const root = await directDb('postgres')
  if (!root) return null
  const name = `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  await root.query(`create database ${name}`)
  const db = await directDb(name)
  const drop = async () => {
    await db?.end()
    await root.query(`drop database if exists ${name} with (force)`)
    await root.end()
  }
  if (!db) {
    await drop()
    throw new Error(`created ${name} but cannot connect to it`)
  }
  const dir = 'supabase/migrations'
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const apply = async (names: string[]) => {
    for (const file of names) await db.query(readFileSync(join(dir, file), 'utf8'))
  }
  try {
    await apply(files.filter((f) => !before || f < before))
  } catch (e) {
    await drop()
    throw e
  }
  return { db, drop, migrateRest: () => apply(files.filter((f) => before !== undefined && f >= before)) }
}

/** Start a transaction on `client` as the signed-in employee `empId`, the way PostgREST runs a request. */
export async function beginAs(client: import('pg').Client, empId: string): Promise<void> {
  await client.query('begin')
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ role: 'authenticated', app_metadata: { emp_id: empId } }),
  ])
  await client.query('set local role authenticated')
}

/** A node of `EXPLAIN (FORMAT JSON)`, with the fields the tests read. */
export interface PlanNode {
  Filter?: string
  'Subplan Name'?: string
  'Actual Rows': number
  'Actual Loops': number
  'Rows Removed by Filter'?: number
  Plans?: PlanNode[]
}

/** A plan node and everything under it. */
export const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)]

/** Whether a query is still waiting on a lock after a short while. */
export async function stillWaiting(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false, () => false), new Promise<boolean>((r) => setTimeout(() => r(true), 300))])
}

/**
 * Superuser SQL on the CSA database, for the rare test that needs what no API role can run: DDL (a table that
 * exists only for that test), or bulk rows written and rolled back in one transaction (the EXPLAIN check in
 * my_assessment). Same connection as `db:migrate`: CSA_DB_ADMIN_URL's server and login,
 * CSA_DB_URL's database.
 */
export async function withSuperuser<T>(run: (sql: pg.Client) => Promise<T>): Promise<T> {
  const url = new URL(process.env.CSA_DB_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres')
  url.pathname = new URL(process.env.CSA_DB_URL ?? 'postgres://authenticator@127.0.0.1:5432/csa_dev').pathname
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

/** 權限異動紀錄裡這個人的動作（依先後），以超級使用者讀、不受讀取規則影響，看得出到底有沒有寫進去（Q149）。 */
export function loggedActions(target: string): Promise<string[]> {
  return withSuperuser(async (sql) =>
    (await sql.query('select action from public.access_change_log where target_emp_id = $1 order by id', [target])).rows.map((r) => r.action as string))
}

/*
 * 年度區間約定：annual_cycle.year 全庫唯一，各測試檔並行執行，afterAll 依年度刪除。每個會發起年度作業的檔
 * 各佔一個 1000 年的區間，隨機年度（含 YEAR + n 這類衍生年度）不得超出自己的區間；2000–2999 留給真實年度。
 *   3000 submit_race      4000 answer          5000 route_signoff   6000 route_edit
 *   7000 assessment       8000 template_edit   9000 template_delete 10000 signoff
 *  11000 pdf_export
 *  12000 launch
 *  13000 draft_path
 *  14000 my_assessment
 *  15000 multi_unit
 *  16000 control_reference
 *  17000 tracking
 *  18000 e2e/main-flow（Playwright 主線驗收，#8）
 *  19000 access_management（人員管理的檢視廠區，#58；Q153 前是檢視者）
 *  20000 parallel_branches（分流並行，#97）
 *  21000 plant_coordinator（廠區負責人，#100）
 *  22000 route_branches（簽核流程編輯器的分流、多一關，#98）
 *  23000 保留給 #99（追蹤、PDF、歷程）
 *  24000 assignment（廠區負責人分派與換人，#101）
 *  25000 launch_departed（發出前的離職檢查與流程回填，#222；原 carry_assignment，#102）
 *  26000 issued_templates（範本管理依年度，#173）
 *  27000 assignment_import（匯入分派表，#180）
 *  28000 audit_link_sync（連動關卡的發起帶入與換人同步，#190）
 *  29000 people_lookup（用工號查人與姓名的保密規則，#218）
 *  30000 e2e/assign-before-launch（發出前分派到發出後換人的完整流程，#223）
 *  31000 reverse_question（反向題目，#233）
 *  99000 records（自評表紀錄，#164）：首頁只留「最新年度」，所以要是全庫最大的年度，放在最上面
 * 新測試檔請挑一個沒人用的 1000 年區間（下一個是 32000），並補進上表。
 */
