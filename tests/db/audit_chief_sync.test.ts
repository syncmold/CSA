// 換稽核主管：還沒簽的稽核主管關卡跟著換，發起帶入現任稽核主管（#190, 20261205000000）。換稽核主管動到全部廠區的
// 流程與自評表，在共用的資料庫裡做會改到（鎖住）別的測試檔正在用的資料，所以在自己的資料庫上測（migratedDb）。
// 要能以超級使用者直接連 Postgres 並建資料庫：沒設 CSA_DB_URL 或 CSA_DB_ADMIN_URL、或連不到時跳過；連得到卻建不了資料庫
// 是失敗，不是跳過（同 route_step_link_conversion）。
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migratedDb } from './helpers'

const UPDATED_AT = '2026-10-01T00:00:00Z'
const EMP = { chief: 'CHIEF', next: 'NEXT', maint: 'MAINT', other: 'OTHER', routeChief: 'ROUTE', auditor: 'TAIPEI' }

let temp: Awaited<ReturnType<typeof migratedDb>> = null
let db: Client | null = null

const one = async (sql: string, params: unknown[] = []) => (await db!.query(sql, params)).rows[0]
const id = async (sql: string, params: unknown[] = []): Promise<string> => (await one(`${sql} returning id`, params)).id
const ID: Record<string, string> = {}

/** 一條流程（範本是不存在的新 id，流程沒有狀態，Q137 (6)）：台北稽核人員、稽核主管兩關，稽核主管存的是 EMP.routeChief。 */
async function route(): Promise<string> {
  const routeId = await id(`insert into public.approval_route (template_id, plant_id, updated_at) values (gen_random_uuid(), $1, $2)`, [
    ID.plant, UPDATED_AT,
  ])
  await db!.query(
    `insert into public.route_step (route_id, position, name, step_group, signer_emp_id, link)
     values ($1, 1, '台北稽核人員', 'audit_review', $2, 'taipei_auditor'), ($1, 2, '稽核主管', 'audit_review', $3, 'audit_chief')`,
    [routeId, EMP.auditor, EMP.routeChief],
  )
  return routeId
}

async function sheet(code: string, status: 'in_progress' | 'closed', states: [string, string]): Promise<string> {
  const assessmentId = await id(
    `insert into public.assessment (cycle_id, plant_id, template_id, template_code, template_name, template_layout, status)
     values ($1, $2, gen_random_uuid(), $3, '測試', 'control_activity', $4)`,
    [ID.cycle, ID.plant, code, status],
  )
  await db!.query(
    `insert into public.assessment_step (assessment_id, position, name, step_group, signer_emp_id, link, state)
     values ($1, 1, '台北稽核人員', 'audit_review', $2, 'taipei_auditor', $4), ($1, 2, '稽核主管', 'audit_review', $3, 'audit_chief', $5)`,
    [assessmentId, EMP.auditor, EMP.routeChief, ...states],
  )
  return assessmentId
}

const chiefStep = async (assessmentId: string) =>
  one(`select signer_emp_id, state from public.assessment_step where assessment_id = $1 and link = 'audit_chief'`, [assessmentId])
const routeSigner = async (routeId: string, link: string) =>
  (await one(`select signer_emp_id from public.route_step where route_id = $1 and link = $2`, [routeId, link])).signer_emp_id

/** Run `sql` as the signed-in `empId`, the way PostgREST runs a request. */
async function as(empId: string, sql: string, params: unknown[] = []): Promise<void> {
  await db!.query('begin')
  try {
    await db!.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'authenticated', app_metadata: { emp_id: empId } })])
    await db!.query('set local role authenticated')
    await db!.query(sql, params)
    await db!.query('commit')
  } catch (e) {
    await db!.query('rollback')
    throw e
  }
}

beforeAll(async () => {
  temp = await migratedDb('csa_chief')
  if (!temp) return
  db = temp.db

  // 範本用不存在的 id：關掉觸發器與外鍵檢查，只在這個暫時的資料庫。觸發器關著，所以這時還沒有任何同步。
  await db!.query(`set session_replication_role = replica`)
  ID.company = await id(`insert into public.company (name) values ('公司')`)
  ID.plant = await id(`insert into public.plant (factory_code, name, company_id) values ('P1', '一廠', $1)`, [ID.company])
  ID.cycle = await id(`insert into public.annual_cycle (year, due_date) values (2030, '2030-12-31')`)
  await db!.query(
    `insert into public.employee_ref (emp_id, name, audit_role) values
       ($1, '舊主管', 'audit_admin'), ($2, '新主管', 'signer'), ($3, '維護', 'system_maintainer'), ($4, '別人', 'signer'), ($5, '流程上的人', 'signer')`,
    [EMP.chief, EMP.next, EMP.maint, EMP.other, EMP.routeChief],
  )
  await db!.query(`insert into public.access_allowlist (emp_id) select unnest($1::text[])`, [[EMP.chief, EMP.next, EMP.maint, EMP.other]])
  ID.first = await route()
  ID.second = await route()
  ID.waiting = await sheet('T-01', 'in_progress', ['current', 'pending'])
  ID.current = await sheet('T-02', 'in_progress', ['done', 'current'])
  ID.closed = await sheet('T-03', 'closed', ['done', 'done'])
  await db!.query(`set session_replication_role = origin`)
}, 120_000)

afterAll(() => temp?.drop())

describe('換稽核主管（20261205000000）', () => {
  it('還沒簽的稽核主管關卡（含正輪到的）換成新的人，結案的不動；每條流程都換（流程沒有狀態，Q137 (6)）', async ({ skip }) => {
    if (!db) skip()
    await as(EMP.maint, `select public.update_access_member($1, 'audit_admin', '{}', null)`, [EMP.next])

    expect(await chiefStep(ID.waiting!)).toEqual({ signer_emp_id: EMP.next, state: 'pending' })
    expect(await chiefStep(ID.current!)).toEqual({ signer_emp_id: EMP.next, state: 'current' })
    expect(await chiefStep(ID.closed!)).toEqual({ signer_emp_id: EMP.routeChief, state: 'done' })
    expect(await routeSigner(ID.first!, 'audit_chief')).toBe(EMP.next)
    expect(await routeSigner(ID.second!, 'audit_chief')).toBe(EMP.next)
    // 台北稽核人員不受影響。
    expect(await routeSigner(ID.first!, 'taipei_auditor')).toBe(EMP.auditor)
  })

  it('只記接任稽核主管；關卡跟著換不記（Q149）', async ({ skip }) => {
    if (!db) skip()
    const rows = (await db!.query(`select action from public.access_change_log where target_emp_id = $1 order by id`, [EMP.next])).rows
    expect(rows.map((r) => r.action)).toEqual(['audit_admin_replaced'])
  })

  it('流程跟著換不算修改流程：最後修改時間不變', async ({ skip }) => {
    if (!db) skip()
    const updated = (await db!.query(`select updated_at from public.approval_route where id = any($1)`, [[ID.first, ID.second]])).rows
    expect(updated.map((r) => r.updated_at.toISOString())).toEqual([UPDATED_AT, UPDATED_AT].map((t) => new Date(t).toISOString()))
  })

  it('發起帶入現任稽核主管，不看流程上存的人；不是剛好一位時照流程上存的人', async ({ skip }) => {
    if (!db) skip()
    // 流程上存的還是 EMP.routeChief 的一條（觸發器關著直接寫入，沒經過同步）。
    await db!.query(`set session_replication_role = replica`)
    const stale = await route()
    await db!.query(`set session_replication_role = origin`)
    const launchSigner = async () =>
      (await one(
        `select public.launch_step_signer(rs, $2) as s
           from public.route_step rs where rs.id = $1`,
        [(await one(`select id from public.route_step where route_id = $1 and link = 'audit_chief'`, [stale])).id, ID.plant],
      )).s
    const linkedNow = async () =>
      (await one(`select public.linked_now(rs) as l from public.route_step rs where rs.route_id = $1 and rs.link = 'audit_chief'`, [ID.first])).l
    expect(await launchSigner()).toBe(EMP.next)
    expect(await linkedNow()).toBe(true)
    // 兩位稽核主管（測試環境整理前的樣子）：誰都不連動，現有的關卡也不動；流程裡可以選人。
    await db!.query(`update public.employee_ref set audit_role = 'audit_admin' where emp_id = $1`, [EMP.other])
    expect(await launchSigner()).toBe(EMP.routeChief)
    expect(await linkedNow()).toBe(false)
    expect(await chiefStep(ID.waiting!)).toEqual({ signer_emp_id: EMP.next, state: 'pending' })
  })

  it('多位降成剩一位時，同步到剩下的那一位', async ({ skip }) => {
    if (!db) skip()
    await db!.query(`update public.employee_ref set audit_role = 'signer' where emp_id = $1`, [EMP.next])
    expect(await chiefStep(ID.waiting!)).toEqual({ signer_emp_id: EMP.other, state: 'pending' })
    expect(await routeSigner(ID.first!, 'audit_chief')).toBe(EMP.other)
  })

  it('廠區管理員當上稽核主管：那一廠還沒簽的台北稽核人員與流程換成他（Q140）', async ({ skip }) => {
    if (!db) skip()
    const taipeiStep = async (assessmentId: string) =>
      one(`select signer_emp_id, state from public.assessment_step where assessment_id = $1 and link = 'taipei_auditor'`, [assessmentId])
    // 廠區端的人當廠區管理員：不連動，什麼都不動。
    await db!.query(`insert into public.plant_coordinator (plant_id, emp_id) values ($1, $2)`, [ID.plant, EMP.next])
    expect(await taipeiStep(ID.waiting!)).toEqual({ signer_emp_id: EMP.auditor, state: 'current' })
    expect(await routeSigner(ID.first!, 'taipei_auditor')).toBe(EMP.auditor)
    // 他成為稽核主管（角色改變的觸發器）：還沒簽的換成他，已簽的不動。
    await db!.query(`update public.employee_ref set audit_role = 'audit_admin' where emp_id = $1`, [EMP.next])
    expect(await taipeiStep(ID.waiting!)).toEqual({ signer_emp_id: EMP.next, state: 'current' })
    expect(await taipeiStep(ID.current!)).toEqual({ signer_emp_id: EMP.auditor, state: 'done' })
    expect(await routeSigner(ID.first!, 'taipei_auditor')).toBe(EMP.next)
    expect(await routeSigner(ID.second!, 'taipei_auditor')).toBe(EMP.next)
  })

  it('負責廠區的稽核主管被降成一般使用者：保留原本的人，不再連動（#187 定案第 3 點）', async ({ skip }) => {
    if (!db) skip()
    const taipeiStep = async (assessmentId: string) =>
      one(`select signer_emp_id, state from public.assessment_step where assessment_id = $1 and link = 'taipei_auditor'`, [assessmentId])
    await db!.query(`update public.employee_ref set audit_role = 'signer' where emp_id = $1`, [EMP.next])
    expect(await taipeiStep(ID.waiting!)).toEqual({ signer_emp_id: EMP.next, state: 'current' })
    expect(await routeSigner(ID.first!, 'taipei_auditor')).toBe(EMP.next)
    const linkedNow = (await one(`select public.linked_now(rs) as l from public.route_step rs where rs.route_id = $1 and rs.link = 'taipei_auditor'`, [ID.first])).l
    expect(linkedNow).toBe(false)
  })
})
