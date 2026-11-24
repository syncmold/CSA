// 既有資料轉成分流 (#97, 20261109000000)：migration 只跑一次，所以在一個暫時的資料庫上套到它之前的版本、放進
// 分流之前的簽核流程與自評表，再套它，看每張的狀態與對應不了的清單（Q116 (12) 的「狀態與轉換前一致、對不上的有清單」）。
// 要能以超級使用者直接連 Postgres 並建資料庫：本機與 CI 的兩個環境都有跑。沒設 CSA_DB_URL 或 CSA_DB_ADMIN_URL、
// 或連不到時跳過；連得到卻建不了資料庫是失敗，不是跳過。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StepGroup } from '../../src/api/assessments'
import { directDb } from './helpers'

const MIGRATIONS = 'supabase/migrations'
const CONVERSION = '20261109000000_parallel_unit_branches.sql'
const DB = `csa_conv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const UPDATED_AT = '2026-10-01T00:00:00Z'

/** A 關卡 as it was before 分流: its name, group, and editable unit (an id on a route, a name on a 自評表) or null. */
type OldStep = [name: string, group: StepGroup, unit: string | null]

let root: Client | null = null
let db: Client | null = null

const one = async (sql: string, params: unknown[] = []) => (await db!.query(sql, params)).rows[0]
const id = async (sql: string, params: unknown[] = []): Promise<string> => (await one(`${sql} returning id`, params)).id

/** A route as it was before 分流. */
async function route(steps: OldStep[]): Promise<string> {
  const routeId = await id(`insert into public.approval_route (template_id, plant_id) values (gen_random_uuid(), gen_random_uuid())`)
  for (const [i, [name, group, unitId]] of steps.entries()) {
    await db!.query(
      `insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id) values ($1, $2, $3, $4, 'E', $5)`,
      [routeId, i + 1, name, group, unitId],
    )
  }
  return routeId
}

/**
 * A 自評表 as it was before 分流: where it stood (current_step_position) and which steps have a valid 送出／核准
 * (`signed`) or only a voided one (`voided`).
 */
async function assessment(
  steps: OldStep[],
  at: { status: 'in_progress' | 'closed'; current: number; signed: number[]; voided?: number[] },
): Promise<string> {
  const assessmentId = await id(
    `insert into public.assessment (cycle_id, plant_id, template_id, template_code, template_name, template_layout, template_version,
                                    status, current_step_position, updated_at)
     values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'FQ-02', '測試', 'control_activity', 'v1', $1, $2, $3)`,
    [at.status, at.current, UPDATED_AT],
  )
  for (const [i, [name, group, unit]] of steps.entries()) {
    const position = i + 1
    const stepId = await id(
      `insert into public.assessment_step (assessment_id, position, name, step_group, signer_emp_id, editable_unit_name)
       values ($1, $2, $3, $4, 'E', $5)`,
      [assessmentId, position, name, group, unit],
    )
    const sign = async (voided: boolean) =>
      db!.query(
        `insert into public.assessment_signoff (assessment_id, step_id, step_position, step_name, action, signer_emp_id, voided_by, voided_at)
         values ($1, $2, $3, $4, $5, 'E', case when $6::timestamptz is not null then gen_random_uuid() end, $6)`,
        [assessmentId, stepId, position, name, unit ? 'submit' : 'approve', voided ? UPDATED_AT : null],
      )
    if (at.voided?.includes(position)) await sign(true)
    if (at.signed.includes(position)) await sign(false)
  }
  return assessmentId
}

const states = async (assessmentId: string) =>
  (await db!.query(`select position, branch_unit_name, state from public.assessment_step where assessment_id = $1 order by position`, [assessmentId]))
    .rows.map((r) => [r.position, r.branch_unit_name, r.state])

const issues = async (column: 'route_id' | 'assessment_id', ownerId: string) =>
  (await db!.query(`select step_position, issue from public.branch_conversion_issue where ${column} = $1 order by step_position, issue`, [ownerId]))
    .rows.map((r) => [r.step_position, r.issue])

const TWO_UNITS: OldStep[] = [
  ['自行檢查人員－資材單位', 'plant', '資材單位'],
  ['自行檢查人員－品保單位', 'plant', '品保單位'],
  ['部門主管－資材單位', 'plant', null],
  ['部門主管 - 品保單位', 'plant', null],
  ['廠區經理人', 'plant', null],
  ['稽核主管', 'audit_review', null],
]
const ID: Record<string, string> = {}

beforeAll(async () => {
  root = await directDb('postgres')
  if (!root) return
  await root.query(`create database ${DB}`)
  db = await directDb(DB)
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= CONVERSION) break
    await db!.query(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }

  // 分流之前的資料。只放轉換讀得到的表；範本、廠區、年度用不存在的 id（關掉觸發器與外鍵檢查，只在這個暫時的資料庫）。
  await db!.query(`set session_replication_role = replica`)
  // 種子資料可能已經有這些單位。
  const unit = async (name: string) =>
    id(`insert into public.assessing_unit (name) values ($1) on conflict (name) do update set name = excluded.name`, [name])
  const [materials, quality] = [await unit('資材單位'), await unit('品保單位')]
  ID.route = await route([
    ['自行檢查人員', 'plant', materials],
    ['自行檢查人員', 'plant', quality],
    ['部門主管－資材單位', 'plant', null],
    ['部門主管 - 品保單位', 'plant', null],
    ['部門主管－財會單位', 'plant', null], // 「－單位」對不上任何自行檢查人員的單位
    ['廠區經理人', 'plant', null],
    ['稽核主管', 'audit_review', null],
  ])
  ID.cleanRoute = await route([['自行檢查人員', 'plant', materials], ['部門主管－資材單位', 'plant', null], ['廠區經理人', 'plant', null]])
  // 停在品保的部門主管（第 4 關）：資材已核准，品保那條就停在第 4 關。
  ID.atQualityManager = await assessment(TWO_UNITS, { status: 'in_progress', current: 4, signed: [1, 2, 3] })
  // 停在資材的部門主管（第 3 關），之前退回作廢過第 3 關：品保的部門主管（第 4 關）現在同時輪到。
  ID.atMaterialsManager = await assessment(TWO_UNITS, { status: 'in_progress', current: 3, signed: [1, 2], voided: [3] })
  ID.closed = await assessment(TWO_UNITS, { status: 'closed', current: 6, signed: [1, 2, 3, 4, 5, 6] })
  // 原本停在第 3 關，但第 1 關沒有簽核紀錄（早於紀錄的資料）：資材那條回到第 1 關。
  ID.missingRecord = await assessment(TWO_UNITS, { status: 'in_progress', current: 3, signed: [2] })
  // 匯流後的關卡輪到：廠區經理人（第 5 關）、稽核主管（第 6 關）。
  ID.atPlantManager = await assessment(TWO_UNITS, { status: 'in_progress', current: 5, signed: [1, 2, 3, 4] })
  ID.atAudit = await assessment(TWO_UNITS, { status: 'in_progress', current: 6, signed: [1, 2, 3, 4, 5] })
  // 自評表上對不上分流的關卡：簽過的「課長」排在分流關卡之前、「部門主管－財會單位」對不上單位。停在資材的部門主管。
  ID.unmappedOnSheet = await assessment(
    [
      ['自行檢查人員－資材單位', 'plant', '資材單位'],
      ['自行檢查人員－品保單位', 'plant', '品保單位'],
      ['課長', 'plant', null],
      ['部門主管－資材單位', 'plant', null],
      ['部門主管－財會單位', 'plant', null],
      ['廠區經理人', 'plant', null],
      ['稽核主管', 'audit_review', null],
    ],
    { status: 'in_progress', current: 4, signed: [1, 2, 3] },
  )
  // 沒有「－單位」、排在所有分流後面、替所有單位簽一次的部門主管：仍轉成匯流後的一關，但列在清單上（使用者 2026-11-03）。
  const afterBranches: OldStep[] = [['部門主管', 'plant', null], ['廠區經理人', 'plant', null], ['稽核主管', 'audit_review', null]]
  ID.singleManagerRoute = await route([['自行檢查人員', 'plant', materials], ['自行檢查人員', 'plant', quality], ...afterBranches])
  ID.singleManagerSheet = await assessment(
    [['自行檢查人員－資材單位', 'plant', '資材單位'], ['自行檢查人員－品保單位', 'plant', '品保單位'], ...afterBranches],
    { status: 'in_progress', current: 3, signed: [1, 2] },
  )
  await db!.query(`set session_replication_role = origin`)

  await db!.query(readFileSync(join(MIGRATIONS, CONVERSION), 'utf8'))
}, 60_000)

afterAll(async () => {
  await db?.end()
  await root?.query(`drop database if exists ${DB} with (force)`)
  await root?.end()
})

describe('既有資料轉成分流（20261109000000）', () => {
  it('簽核流程：自行檢查人員依可編輯範圍、部門主管依名稱「－單位」對到分流，其餘在匯流後', async ({ skip }) => {
    if (!db) skip()
    const steps = await db!.query(
      `select rs.position, u.name from public.route_step rs left join public.assessing_unit u on u.id = rs.branch_unit_id
       where rs.route_id = $1 order by rs.position`,
      [ID.route],
    )
    expect(steps.rows.map((r) => r.name)).toEqual(['資材單位', '品保單位', '資材單位', '品保單位', null, null, null])
  })

  it('對不上單位的「職稱－單位」關卡列在清單上；對得上的流程沒有任何一筆', async ({ skip }) => {
    if (!db) skip()
    expect(await issues('route_id', ID.route!)).toEqual([[5, 'unmapped_step']])
    expect(await issues('route_id', ID.cleanRoute!)).toEqual([])
  })

  it('原本的目前關卡仍輪到，之前的都已完成；其他單位排在後面的關卡同時輪到', async ({ skip }) => {
    if (!db) skip()
    expect(await states(ID.atQualityManager!)).toEqual([
      [1, '資材單位', 'done'], [2, '品保單位', 'done'], [3, '資材單位', 'done'], [4, '品保單位', 'current'],
      [5, null, 'pending'], [6, null, 'pending'],
    ])
    // 作廢的核准不算：第 3 關仍輪到。
    expect(await states(ID.atMaterialsManager!)).toEqual([
      [1, '資材單位', 'done'], [2, '品保單位', 'done'], [3, '資材單位', 'current'], [4, '品保單位', 'current'],
      [5, null, 'pending'], [6, null, 'pending'],
    ])
    for (const a of [ID.atQualityManager!, ID.atMaterialsManager!]) expect(await issues('assessment_id', a)).toEqual([])
    const summary = await one(
      `select a.status, public.current_step_position(a) as position, public.assessment_stage(a) as stage, a.updated_at
       from public.assessment a where a.id = $1`,
      [ID.atQualityManager],
    )
    // 只補欄位：階段照舊是簽核中，最後異動時間不動。
    expect([summary.status, summary.position, summary.stage, summary.updated_at.toISOString()]).toEqual([
      'in_progress', 4, 'signing', new Date(UPDATED_AT).toISOString(),
    ])
  })

  it('原本輪到匯流後關卡（廠區經理人、稽核室）的，所有分流都已完成、仍輪到那一關', async ({ skip }) => {
    if (!db) skip()
    expect(await states(ID.atPlantManager!)).toEqual([
      [1, '資材單位', 'done'], [2, '品保單位', 'done'], [3, '資材單位', 'done'], [4, '品保單位', 'done'],
      [5, null, 'current'], [6, null, 'pending'],
    ])
    expect((await states(ID.atAudit!)).map(([, , state]) => state)).toEqual([...Array(5).fill('done'), 'current'])
    for (const [a, position] of [[ID.atPlantManager!, 5], [ID.atAudit!, 6]] as const) {
      expect(await issues('assessment_id', a)).toEqual([])
      expect((await one(`select public.current_step_position(a) as p from public.assessment a where a.id = $1`, [a])).p).toBe(position)
    }
  })

  it('自評表上對不上分流的關卡列在清單上；已簽卻因此移到匯流後的關卡也列出', async ({ skip }) => {
    if (!db) skip()
    expect(await states(ID.unmappedOnSheet!)).toEqual([
      [1, '資材單位', 'done'], [2, '品保單位', 'done'], [3, null, 'pending'], [4, '資材單位', 'current'],
      [5, null, 'pending'], [6, null, 'pending'], [7, null, 'pending'],
    ])
    expect(await issues('assessment_id', ID.unmappedOnSheet!)).toEqual([
      [3, 'signed_step_reopened'], [3, 'unmapped_step'], [5, 'unmapped_step'],
    ])
  })

  it('沒有「－單位」的單一部門主管轉成匯流後的一關，仍列在清單上', async ({ skip }) => {
    if (!db) skip()
    expect(await issues('route_id', ID.singleManagerRoute!)).toEqual([[3, 'unmapped_step']])
    expect(await states(ID.singleManagerSheet!)).toEqual([
      [1, '資材單位', 'done'], [2, '品保單位', 'done'], [3, null, 'current'], [4, null, 'pending'], [5, null, 'pending'],
    ])
    expect(await issues('assessment_id', ID.singleManagerSheet!)).toEqual([[3, 'unmapped_step']])
  })

  it('結案的全部已完成、仍結案', async ({ skip }) => {
    if (!db) skip()
    expect((await states(ID.closed!)).map(([, , state]) => state)).toEqual(Array(6).fill('done'))
    expect((await one(`select status from public.assessment where id = $1`, [ID.closed])).status).toBe('closed')
    expect(await issues('assessment_id', ID.closed!)).toEqual([])
  })

  it('原本已簽卻沒有有效紀錄的關卡、與因此不再輪到的原目前關卡，列在清單上', async ({ skip }) => {
    if (!db) skip()
    expect(await states(ID.missingRecord!)).toEqual([
      [1, '資材單位', 'current'], [2, '品保單位', 'done'], [3, '資材單位', 'pending'], [4, '品保單位', 'current'],
      [5, null, 'pending'], [6, null, 'pending'],
    ])
    expect(await issues('assessment_id', ID.missingRecord!)).toEqual([[1, 'signed_step_reopened'], [3, 'current_step_moved']])
  })
})
