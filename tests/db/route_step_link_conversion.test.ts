// 既有關卡回填連動標記（#189, 20261204000000）：migration 只跑一次，所以在一個暫時的資料庫上套到它之前的版本、放進
// 沒有標記的簽核流程與自評表，再套它，看每個關卡的標記。要能以超級使用者直接連 Postgres 並建資料庫：本機與 CI 的兩個環境
// 都有跑。沒設 CSA_DB_URL 或 CSA_DB_ADMIN_URL、或連不到時跳過；連得到卻建不了資料庫是失敗，不是跳過。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { directDb } from './helpers'

const MIGRATIONS = 'supabase/migrations'
const CONVERSION = '20261204000000_route_step_link.sql'
const DB = `csa_link_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const UPDATED_AT = '2026-10-01T00:00:00Z'

type OldStep = [name: string, group: 'plant' | 'audit_review']

let root: Client | null = null
let db: Client | null = null

const one = async (sql: string, params: unknown[] = []) => (await db!.query(sql, params)).rows[0]
const id = async (sql: string, params: unknown[] = []): Promise<string> => (await one(`${sql} returning id`, params)).id
const ID: Record<string, string> = {}

async function route(steps: OldStep[]): Promise<string> {
  const routeId = await id(`insert into public.approval_route (template_id, plant_id, updated_at) values (gen_random_uuid(), gen_random_uuid(), $1)`, [UPDATED_AT])
  for (const [i, [name, group]] of steps.entries()) {
    await db!.query(
      `insert into public.route_step (route_id, position, name, step_group, signer_emp_id) values ($1, $2, $3, $4, $5)`,
      [routeId, i + 1, name, group, group === 'plant' ? null : 'E'],
    )
  }
  return routeId
}

async function sheet(steps: OldStep[], status: 'in_progress' | 'closed'): Promise<string> {
  const assessmentId = await id(
    `insert into public.assessment (cycle_id, plant_id, template_id, template_code, template_name, template_layout, template_version,
                                    status, updated_at)
     values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'FQ-02', '測試', 'control_activity', 'v1', $1, $2)`,
    [status, UPDATED_AT],
  )
  for (const [i, [name, group]] of steps.entries()) {
    await db!.query(
      `insert into public.assessment_step (assessment_id, position, name, step_group, signer_emp_id) values ($1, $2, $3, $4, $5)`,
      [assessmentId, i + 1, name, group, group === 'plant' ? null : 'E'],
    )
  }
  return assessmentId
}

const links = async (table: 'route_step' | 'assessment_step', column: 'route_id' | 'assessment_id', ownerId: string) =>
  (await db!.query(`select position, name, link from public.${table} where ${column} = $1 order by position`, [ownerId])).rows.map((r) => [r.position, r.name, r.link])

const FULL: OldStep[] = [
  ['自行檢查人員－資材單位', 'plant'],
  ['部門主管－資材單位', 'plant'],
  ['子公司擔當稽核', 'audit_review'],
  ['台北稽核人員', 'audit_review'],
  ['稽核主管', 'audit_review'],
]

beforeAll(async () => {
  root = await directDb('postgres')
  if (!root) return
  await root.query(`create database ${DB}`)
  db = await directDb(DB)
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= CONVERSION) break
    await db!.query(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }

  // 標記之前的資料（範本、廠區、年度用不存在的 id：關掉觸發器與外鍵檢查，只在這個暫時的資料庫）。
  await db!.query(`set session_replication_role = replica`)
  ID.full = await route(FULL)
  // 同名有兩個：只標位置最前面的；廠區端叫「稽核主管」的關卡不標；沒有稽核室關卡的流程不動。
  ID.dup = await route([['稽核主管', 'audit_review'], ['台北稽核人員', 'audit_review'], ['稽核主管', 'audit_review'], ['稽核主管', 'plant']])
  ID.plain = await route([['自行檢查人員－資材單位', 'plant'], ['子公司擔當稽核', 'audit_review']])
  ID.open = await sheet(FULL, 'in_progress')
  ID.closed = await sheet(FULL, 'closed') // 結案的自評表有守門觸發器：回填要照樣標上
  await db!.query(`set session_replication_role = origin`)
  ID.beforeUpdatedAt = (await one(`select updated_at from public.approval_route where id = $1`, [ID.full])).updated_at.toISOString()

  await db!.query(readFileSync(join(MIGRATIONS, CONVERSION), 'utf8'))
}, 60_000)

afterAll(async () => {
  await db?.end()
  await root?.query(`drop database if exists ${DB} with (force)`)
  await root?.end()
})

describe('既有關卡回填連動標記（20261204000000）', () => {
  it('稽核室覆核裡叫「台北稽核人員」「稽核主管」的標上，其餘不標', async ({ skip }) => {
    if (!db) skip()
    const expected = [
      [1, '自行檢查人員－資材單位', null], [2, '部門主管－資材單位', null], [3, '子公司擔當稽核', null],
      [4, '台北稽核人員', 'taipei_auditor'], [5, '稽核主管', 'audit_chief'],
    ]
    expect(await links('route_step', 'route_id', ID.full!)).toEqual(expected)
    expect(await links('assessment_step', 'assessment_id', ID.open!)).toEqual(expected)
  })

  it('結案的自評表也回填（守門觸發器只在回填時暫停）', async ({ skip }) => {
    if (!db) skip()
    expect((await links('assessment_step', 'assessment_id', ID.closed!)).map((r) => r[2])).toEqual([null, null, null, 'taipei_auditor', 'audit_chief'])
    // 暫停過的觸發器回填後又開了：結案後的寫入照樣被擋
    await expect(db!.query(`update public.assessment_step set name = '改' where assessment_id = $1`, [ID.closed])).rejects.toMatchObject({ code: '42501' })
  })

  it('同名有好幾個時只標位置最前面的一個；廠區端的同名關卡不標', async ({ skip }) => {
    if (!db) skip()
    expect(await links('route_step', 'route_id', ID.dup!)).toEqual([
      [1, '稽核主管', 'audit_chief'], [2, '台北稽核人員', 'taipei_auditor'], [3, '稽核主管', null], [4, '稽核主管', null],
    ])
  })

  it('沒有這兩個關卡的流程不動；啟用檢查據此列出缺的標記', async ({ skip }) => {
    if (!db) skip()
    expect((await links('route_step', 'route_id', ID.plain!)).map((r) => r[2])).toEqual([null, null])
    const check = async (routeId: string) =>
      (await one(`select (public.activation_check(r)) -> 'missing_links' as m from public.approval_route r where r.id = $1`, [routeId])).m
    expect(await check(ID.plain!)).toEqual(['taipei_auditor', 'audit_chief'])
    expect(await check(ID.full!)).toEqual([])
  })

  it('回填不改流程的最後修改時間', async ({ skip }) => {
    if (!db) skip()
    const after = (await one(`select updated_at from public.approval_route where id = $1`, [ID.full])).updated_at.toISOString()
    expect(after).toBe(ID.beforeUpdatedAt)
  })
})
