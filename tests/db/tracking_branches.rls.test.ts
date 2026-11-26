// 追蹤總覽配合分流（工單 #99；Q116 (11)）：匯流前顯示最久沒動的那條分流的關卡，停留天數從那條分流自己最後一筆
// 簽核紀錄（或發起）起算，別的單位核准不會讓它歸零；另給適用單位數與已核准單位數。匯流後照舊。
// 每次執行建立自己的公司、廠區、兩個自評單位、範本與簽核流程（財務多一關課長），發起自己的年度作業（23000 區間），
// 結束時全部清掉。測試依序執行，共用同一張自評表，從發起一路簽到匯流、再退回一條分流。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { selectTracking, type TrackingRow } from '../../src/api/trackingQuery'
import { launchAssigned, admin, insertRow, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest, withSuperuser, unlistPeople } from './helpers'

const RUN = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = {
  boss: `${RUN}A`,
  mat: `${RUN}B`, matMgr: `${RUN}C`,
  fin: `${RUN}D`, finChief: `${RUN}E`, finMgr: `${RUN}F`,
  plantMgr: `${RUN}G`, chief: `${RUN}H`,
}
const YEAR = 23000 + Math.floor(Math.random() * 999)
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = { mat: `${RUN}資材`, fin: `${RUN}財務` }
const COMPLETE = { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }

const ID: Record<string, string> = {}
let a = ''
let point: Record<string, string> = {}

const as = (who: string) => loginAs(who, who.slice(-1))

async function row(): Promise<TrackingRow> {
  const found = ok(await selectTracking(await as(EMP.boss), YEAR)).find((r) => r.assessment_id === a)
  if (!found) throw new Error('tracking row not found')
  return found
}
/** Where the row stands, without the times. */
const where = (r: TrackingRow) => ({
  position: r.current_step_position, name: r.current_step_name, unit: r.current_step_branch_unit, signer: r.current_signer_emp_id,
  stage: r.stage, branches: [r.branches_done, r.branch_count],
})

async function lastSignoffAt(): Promise<string> {
  const rows = ok(await admin.from('assessment_signoff').select('signed_at').eq('assessment_id', a).order('signed_at', { ascending: false }).limit(1))
  return (rows as { signed_at: string }[])[0]!.signed_at
}
const sameInstant = (x: string, y: string) => new Date(x).getTime() === new Date(y).getTime()

async function rpcOk(client: SupabaseClient, fn: string, args: object) {
  const result = await client.rpc(fn, { p_assessment_id: a, ...args })
  if (result.error || !result.data?.ok) throw new Error(`${fn}: ${JSON.stringify(result)}`)
}
async function submitUnit(who: string, unit: string) {
  const client = await as(who)
  await rpcOk(client, 'save_assessment_answers', {
    p_answers: [{ control_point_id: point[unit], assessing_unit_name: unit, ...COMPLETE }],
    p_conclusions: [{ assessing_unit_name: unit, conclusion: 'satisfied' }],
  })
  await rpcOk(client, 'submit_assessment_step', {})
}
const approve = async (who: string) => rpcOk(await as(who), 'approve_assessment_step', {})

beforeAll(async () => {
  await requirePostgrest()
  for (const who of Object.values(EMP)) await as(who)
  await promoteToAuditAdmin(EMP.boss)
  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  for (const name of Object.values(UNIT)) ID[name] = (await insertRow('assessing_unit', { name })).id
  ID.template = await makeTemplate(`${RUN}t`, 'control_activity', FACTORY, [
    ['第一章', [['資材題', ID[UNIT.mat]!], ['財務題', ID[UNIT.fin]!]]],
  ])
  // 分流 資材 1 → 3、財務 2 → 4（多一關課長）→ 5；匯流後 6 廠區經理人、7 稽核主管。
  const mat = ID[UNIT.mat]!
  const fin = ID[UNIT.fin]!
  await makeRoute(ID.template, ID.plant, [
    { name: `自行檢查人員－${UNIT.mat}`, group: 'plant', signer: EMP.mat, unitId: mat, branchUnitId: mat },
    { name: `自行檢查人員－${UNIT.fin}`, group: 'plant', signer: EMP.fin, unitId: fin, branchUnitId: fin },
    { name: `部門主管－${UNIT.mat}`, group: 'plant', signer: EMP.matMgr, unitId: null, branchUnitId: mat },
    { name: '課長', group: 'plant', signer: EMP.finChief, unitId: null, branchUnitId: fin },
    { name: `部門主管－${UNIT.fin}`, group: 'plant', signer: EMP.finMgr, unitId: null, branchUnitId: fin },
    { name: '廠區經理人', group: 'plant', signer: EMP.plantMgr, unitId: null, branchUnitId: null },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null, branchUnitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null, branchUnitId: null },
  ])
  const launched = await launchAssigned(await as(EMP.boss), {
    p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: ID.template, plant_id: ID.plant }],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  a = ok(await admin.from('assessment').select('id').eq('cycle_id', launched.data.cycle_id).single()).id as string
  const rows = ok(await admin.from('assessment_control_point_unit').select('control_point_id,assessing_unit_name').eq('assessment_id', a))
  point = Object.fromEntries((rows as { control_point_id: string; assessing_unit_name: string }[]).map((r) => [r.assessing_unit_name, r.control_point_id]))
})

afterAll(async () => {
  await unlistPeople(RUN) // 排進關卡時加進放行名單的人（Q150）
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant ?? '')
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().in('name', Object.values(UNIT))
})

describe('追蹤總覽的分流（#99）', () => {
  it('counts both units, none approved, and shows the first 分流 while every 分流 waits since the launch', async () => {
    const r = await row()
    expect(where(r)).toEqual({ position: 1, name: `自行檢查人員－${UNIT.mat}`, unit: UNIT.mat, signer: EMP.mat, stage: 'filling', branches: [0, 2] })
    expect(r.days_at_step).toBe(0)
  })

  it('keeps counting the untouched unit from the launch after the other one is approved', async () => {
    // Launched 10 days ago; 資材 submits and is approved today.
    await withSuperuser((sql) => sql.query(`update public.assessment set created_at = created_at - interval '10 days' where id = $1`, [a]))
    await submitUnit(EMP.mat, UNIT.mat)
    await approve(EMP.matMgr)
    const r = await row()
    expect(where(r)).toEqual({ position: 2, name: `自行檢查人員－${UNIT.fin}`, unit: UNIT.fin, signer: EMP.fin, stage: 'filling', branches: [1, 2] })
    expect(r.days_at_step).toBe(10)
  })

  it('moves to the extra 關卡 of the 分流 once its unit submits, counting from that 送出', async () => {
    await submitUnit(EMP.fin, UNIT.fin)
    const r = await row()
    expect(where(r)).toEqual({ position: 4, name: '課長', unit: UNIT.fin, signer: EMP.finChief, stage: 'signing', branches: [1, 2] })
    expect(sameInstant(r.entered_step_at, await lastSignoffAt())).toBe(true)
    expect(r.days_at_step).toBe(0)
  })

  it('shows the one 關卡 after the 匯流, with no 分流', async () => {
    await approve(EMP.finChief)
    await approve(EMP.finMgr)
    const r = await row()
    expect(where(r)).toEqual({ position: 6, name: '廠區經理人', unit: null, signer: EMP.plantMgr, stage: 'signing', branches: [2, 2] })
    expect(sameInstant(r.entered_step_at, await lastSignoffAt())).toBe(true)
  })

  it('reopens one 分流 on a 退回 and counts it from the 退回', async () => {
    await rpcOk(await as(EMP.plantMgr), 'return_assessment', { p_to_position: 2, p_reason: '請補充說明' })
    const r = await row()
    expect(where(r)).toEqual({ position: 2, name: `自行檢查人員－${UNIT.fin}`, unit: UNIT.fin, signer: EMP.fin, stage: 'filling', branches: [1, 2] })
    expect(sameInstant(r.entered_step_at, await lastSignoffAt())).toBe(true)
  })
})
