// 既有的檢視者轉成一般使用者（Q153、#240，20261222000000）：migration 只跑一次，所以在一個暫時的資料庫上套到它之前的
// 版本、放進幾位檢視者，再套它，看角色、檢視廠區、人員異動紀錄，以及轉換前後同一個人看得到整廠資料的廠區相同。
// 要能以超級使用者直接連 Postgres 並建資料庫：沒設 CSA_DB_URL 或 CSA_DB_ADMIN_URL、或連不到時跳過；連得到卻建不了資料庫
// 是失敗，不是跳過（同 route_step_link_conversion）。
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migratedDb } from './helpers'

const CONVERSION = '20261222000000_viewer_merged_into_signer.sql'
/** 檢視者：只看一廠；看兩廠又負責第三廠；不在放行名單上（部署指令留下的）。另有一位一般使用者、一位稽核人員對照。 */
const EMP = { one: 'VIEWONE', both: 'VIEWBOTH', unlisted: 'VIEWOFF', signer: 'PLAIN', staff: 'STAFF' }

let temp: Awaited<ReturnType<typeof migratedDb>> = null
let db: Client | null = null
const PLANT: Record<'p1' | 'p2' | 'p3', string> = { p1: '', p2: '', p3: '' }
/** 轉換前每個人「看得到整廠資料的廠區」（my_tracking_plant_ids），轉換後要一樣。 */
const BEFORE: Record<string, string[]> = {}

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db!.query(sql, params)).rows as T[]

/** `my_tracking_plant_ids()` as the signed-in `empId` sees it: the claims PostgREST would set, rolled back. */
async function trackingPlants(empId: string): Promise<string[]> {
  await db!.query('begin')
  try {
    await db!.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'authenticated', app_metadata: { emp_id: empId } })])
    const [row] = await rows<{ ids: string[] }>('select public.my_tracking_plant_ids() as ids')
    return [...row!.ids].sort()
  } finally {
    await db!.query('rollback')
  }
}

const refusal = (run: Promise<unknown>) => run.then(() => null, (e: { code?: string; hint?: string; constraint?: string }) => ({ code: e.code, hint: e.hint, constraint: e.constraint }))

beforeAll(async () => {
  temp = await migratedDb('csa_viewer', { before: CONVERSION })
  if (!temp) return
  db = temp.db

  const [company] = await rows<{ id: string }>(`insert into public.company (name) values ('轉換測試公司') returning id`)
  for (const [key, code] of [['p1', 'CV1'], ['p2', 'CV2'], ['p3', 'CV3']] as const) {
    const [plant] = await rows<{ id: string }>(`insert into public.plant (factory_code, name, company_id) values ($1, $2, $3) returning id`, [code, `${code}廠`, company!.id])
    PLANT[key] = plant!.id
  }
  const person = (empId: string, role: string, plants: string[]) =>
    db!.query(`insert into public.employee_ref (emp_id, name, audit_role, viewer_plant_ids) values ($1, $2, $3, $4)`, [empId, `${empId}姓名`, role, plants])
  await person(EMP.one, 'viewer', [PLANT.p1])
  await person(EMP.both, 'viewer', [PLANT.p1, PLANT.p2])
  await person(EMP.unlisted, 'viewer', [PLANT.p2])
  await person(EMP.signer, 'signer', [])
  await person(EMP.staff, 'audit_staff', [])
  await db.query(`insert into public.access_allowlist (emp_id) select unnest($1::text[])`, [[EMP.one, EMP.both, EMP.signer, EMP.staff]])
  await db.query(`insert into public.plant_coordinator (plant_id, emp_id) values ($1, $2), ($3, $4)`, [PLANT.p3, EMP.both, PLANT.p2, EMP.staff])
  for (const empId of Object.values(EMP)) BEFORE[empId] = await trackingPlants(empId)

  await temp.migrateRest()
}, 120_000)

afterAll(async () => {
  await temp?.drop()
})

describe('既有的檢視者轉成一般使用者（Q153）', () => {
  it('saw, before the conversion, what the test expects to be kept', ({ skip }) => {
    if (!db) return skip()
    expect(BEFORE).toEqual({
      [EMP.one]: [PLANT.p1],
      [EMP.both]: [PLANT.p1, PLANT.p2, PLANT.p3].sort(),
      [EMP.unlisted]: [PLANT.p2],
      [EMP.signer]: [],
      [EMP.staff]: [PLANT.p2],
    })
  })

  it('turns every 檢視者 into a 一般使用者 with the 檢視廠區 kept, and leaves the others alone', async ({ skip }) => {
    if (!db) return skip()
    const people = await rows<{ emp_id: string; audit_role: string; viewer_plant_ids: string[] }>(
      `select emp_id, audit_role::text, viewer_plant_ids from public.employee_ref where emp_id = any($1::text[]) order by emp_id`, [Object.values(EMP)],
    )
    expect(Object.fromEntries(people.map((p) => [p.emp_id, [p.audit_role, [...p.viewer_plant_ids].sort()]]))).toEqual({
      [EMP.one]: ['signer', [PLANT.p1]],
      [EMP.both]: ['signer', [PLANT.p1, PLANT.p2].sort()],
      [EMP.unlisted]: ['signer', [PLANT.p2]],
      [EMP.signer]: ['signer', []],
      [EMP.staff]: ['audit_staff', []],
    })
    expect(await rows(`select 1 from public.employee_ref where audit_role = 'viewer'`)).toEqual([])
    // 負責的廠區不動。
    expect(await rows(`select emp_id from public.plant_coordinator where plant_id = $1`, [PLANT.p3])).toEqual([{ emp_id: EMP.both }])
  })

  it('leaves each of them seeing the same plants whole as before', async ({ skip }) => {
    if (!db) return skip()
    for (const empId of Object.values(EMP)) expect(await trackingPlants(empId), empId).toEqual(BEFORE[empId])
  })

  it('writes one 角色 entry, with no operator, for each one on the 放行名單 and nothing else', async ({ skip }) => {
    if (!db) return skip()
    const log = await rows(
      `select target_emp_id, actor_emp_id, action, before, after from public.access_change_log
        where target_emp_id = any($1::text[]) and action::text <> 'added' and action::text not like 'coordinator%' order by target_emp_id`,
      [Object.values(EMP)],
    )
    expect(log).toEqual([EMP.both, EMP.one].map((empId) => ({ target_emp_id: empId, actor_emp_id: null, action: 'role', before: 'viewer', after: 'signer' })))
  })

  it('refuses the retired role afterwards, by the trigger and, with triggers off, by the check', async ({ skip }) => {
    if (!db) return skip()
    const set = `update public.employee_ref set audit_role = 'viewer' where emp_id = $1`
    expect(await refusal(db.query(set, [EMP.one]))).toMatchObject({ code: '22023', hint: 'viewer_retired' })
    expect(await refusal(db.query(`insert into public.employee_ref (emp_id, audit_role) values ('VIEWNEW', 'viewer')`))).toMatchObject({ code: '22023', hint: 'viewer_retired' })
    await db.query('begin')
    try {
      await db.query('set local session_replication_role = replica')
      // Someone with no 檢視廠區, so that only this check stands in the way.
      expect(await refusal(db.query(set, [EMP.signer]))).toMatchObject({ code: '23514', constraint: 'employee_ref_viewer_role_retired' })
    } finally {
      await db.query('rollback')
    }
  })

  it('keeps 檢視廠區 for a 一般使用者 only: another role has them cleared, and the check holds with triggers off', async ({ skip }) => {
    if (!db) return skip()
    const plantsOf = async (empId: string) => (await rows<{ viewer_plant_ids: string[] }>(`select viewer_plant_ids from public.employee_ref where emp_id = $1`, [empId]))[0]!.viewer_plant_ids
    await db.query(`update public.employee_ref set viewer_plant_ids = $2 where emp_id = $1`, [EMP.staff, [PLANT.p1]])
    expect(await plantsOf(EMP.staff)).toEqual([])
    await db.query(`update public.employee_ref set audit_role = 'audit_staff' where emp_id = $1`, [EMP.unlisted])
    expect(await plantsOf(EMP.unlisted)).toEqual([])
    await db.query('begin')
    try {
      await db.query('set local session_replication_role = replica')
      expect(await refusal(db.query(`update public.employee_ref set viewer_plant_ids = $2 where emp_id = $1`, [EMP.staff, [PLANT.p1]])))
        .toMatchObject({ code: '23514', constraint: 'employee_ref_viewer_plants_only_for_signers' })
    } finally {
      await db.query('rollback')
    }
  })
})
