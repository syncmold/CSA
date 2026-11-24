// 資料 API 接縫: 追蹤總覽（工單 #14、Q95；範本與適用廠區 #86）。
// 每次執行建立自己的兩家公司、兩個廠區、自評單位、兩份範本與簽核流程，發起自己的年度作業，結束時全部清掉。
// 同一個檔案裡的測試依序執行：主要那一張（廠區 1、範本 a）從發起一路送出、退回、重簽到結案。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { selectTracking, selectTrackingTemplates, type TrackingRow, type TrackingTemplate } from '../../src/api/trackingQuery'
import { launchAssigned, admin, insertRow, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest, withSuperuser } from './helpers'

const RUN = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = {
  auditAdmin: `${RUN}A`,
  checker: `${RUN}B`,
  manager: `${RUN}C`,
  chief: `${RUN}F`,
  outsider: `${RUN}D`,
  viewer: `${RUN}V`,
}
const NAME: Record<string, string> = {
  [EMP.auditAdmin]: '甲', [EMP.checker]: '乙', [EMP.manager]: '丙', [EMP.chief]: '戊', [EMP.outsider]: '己', [EMP.viewer]: '庚',
}
const YEAR = 17000 + Math.floor(Math.random() * 999)
const FACTORY_1 = `${RUN}P1`.toUpperCase()
const FACTORY_2 = `${RUN}P2`.toUpperCase()
const UNIT = `${RUN}資材`
const CODE_A = `${RUN}a`
const CODE_B = `${RUN}b`
const CODE_INACTIVE = `${RUN}c`

const ID: Record<string, string> = {}
/** 自評表 id，依「廠區/範本」 */
const ASSESSMENT: Record<string, string> = {}
/** 主要那一張：廠區 1、範本 a */
let MAIN = ''

const as = (who: string) => loginAs(who, NAME[who] ?? who)

/** 用頁面同一個查詢讀這一年的追蹤總覽；測試年度是這次執行專用的，所以只會有這個檔案發出的自評表。 */
async function trackingOf(who: string): Promise<TrackingRow[]> {
  return ok(await selectTracking(await as(who), YEAR))
}
/** 用頁面同一個查詢讀追蹤總覽的範本，只留這次執行建的。 */
async function templatesOf(who: string): Promise<TrackingTemplate[]> {
  const ours = new Set([ID.templateA, ID.templateB, ID.templateInactive])
  return ok(await selectTrackingTemplates(await as(who))).filter((t) => ours.has(t.template_id))
}
async function rowOf(id: string): Promise<TrackingRow> {
  const row = (await trackingOf(EMP.auditAdmin)).find((r) => r.assessment_id === id)
  if (!row) throw new Error(`tracking row for ${id} not found`)
  return row
}

/** 把一張自評表的時間（簽核紀錄、發起時間）整體往前推 n 天，模擬停留了 n 天。 */
async function backdate(assessmentId: string, days: number) {
  await withSuperuser(async (sql) => {
    await sql.query(`update public.assessment_signoff set signed_at = signed_at - make_interval(days => $2) where assessment_id = $1`, [assessmentId, days])
    await sql.query(`update public.assessment set created_at = created_at - make_interval(days => $2) where id = $1`, [assessmentId, days])
  })
}

async function lastSignoffAt(assessmentId: string): Promise<string> {
  const rows = ok(await admin.from('assessment_signoff').select('signed_at').eq('assessment_id', assessmentId)
    .order('signed_at', { ascending: false }).limit(1)) as { signed_at: string }[]
  return rows[0]!.signed_at
}

const taipeiDay = (at: Date | string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date(at))
/**
 * 停留天數 as the database should count it for this row: Taipei calendar days from its own entered_step_at to now.
 * Comparing against this instead of a literal keeps the tests green when a run crosses Taipei midnight.
 */
function expectStay(row: TrackingRow, atLeast = 0) {
  const days = (Date.parse(taipeiDay(new Date())) - Date.parse(taipeiDay(row.entered_step_at))) / 86_400_000
  expect(row.days_at_step).toBe(days)
  expect(days).toBeGreaterThanOrEqual(atLeast)
}

const sameInstant = (a: string | null, b: string | null) => a !== null && b !== null && new Date(a).getTime() === new Date(b).getTime()

async function rpcOk(client: SupabaseClient, fn: string, args: object) {
  const result = await client.rpc(fn, args)
  expect(result.error).toBeNull()
  expect(result.data).toMatchObject({ ok: true })
}

async function answerAndSubmit(assessmentId: string) {
  const me = await as(EMP.checker)
  const point = ok(await admin.from('assessment_control_point').select('id').eq('assessment_id', assessmentId).single()) as { id: string }
  const saved = await me.rpc('save_assessment_answers', {
    p_assessment_id: assessmentId,
    p_answers: [{ control_point_id: point.id, assessing_unit_name: UNIT, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
    p_conclusions: [{ assessing_unit_name: UNIT, conclusion: 'satisfied' }],
  })
  expect(saved.error).toBeNull()
  await rpcOk(me, 'submit_assessment_step', { p_assessment_id: assessmentId })
}

beforeAll(async () => {
  await requirePostgrest()
  for (const who of Object.values(EMP)) await as(who)
  await promoteToAuditAdmin(EMP.auditAdmin)

  ID.company1 = (await insertRow('company', { name: `${RUN}1公司` })).id
  ID.company2 = (await insertRow('company', { name: `${RUN}2公司` })).id
  ID.plant1 = (await insertRow('plant', { factory_code: FACTORY_1, name: `${RUN}一廠`, company_id: ID.company1 })).id
  ID.plant2 = (await insertRow('plant', { factory_code: FACTORY_2, name: `${RUN}二廠`, company_id: ID.company2 })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
  ID.templateA = await makeTemplate(CODE_A, 'control_activity', FACTORY_1, [['第一章', [['p1', ID.unit]]]])
  await insertRow('template_plant', { template_id: ID.templateA, factory_code: FACTORY_2 })
  ID.templateB = await makeTemplate(CODE_B, 'control_activity', FACTORY_1, [['第一章', [['p1', ID.unit]]]])
  ID.templateInactive = await makeTemplate(CODE_INACTIVE, 'control_activity', FACTORY_1, [['第一章', [['p1', ID.unit]]]])
  ok(await admin.from('questionnaire_template').update({ status: 'inactive' }).eq('id', ID.templateInactive))
  ok(await admin.from('employee_ref').update({ audit_role: 'viewer', viewer_plant_ids: [ID.plant2] }).eq('emp_id', EMP.viewer))
  const steps = [
    { name: '自行檢查人員－資材', group: 'plant' as const, signer: EMP.checker, unitId: ID.unit },
    { name: '部門主管－資材', group: 'plant' as const, signer: EMP.manager, unitId: null },
    { name: '台北稽核人員', group: 'audit_review' as const, signer: EMP.chief, unitId: null },
    { name: '稽核主管', group: 'audit_review' as const, signer: EMP.chief, unitId: null },
  ]
  await makeRoute(ID.templateA, ID.plant1, steps)
  await makeRoute(ID.templateA, ID.plant2, steps)
  await makeRoute(ID.templateB, ID.plant1, steps)

  const launched = await launchAssigned(await as(EMP.auditAdmin), {
    p_year: YEAR, p_due_date: '2099-12-31',
    p_combos: [
      { template_id: ID.templateA, plant_id: ID.plant1 },
      { template_id: ID.templateA, plant_id: ID.plant2 },
      { template_id: ID.templateB, plant_id: ID.plant1 },
    ],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  const rows = ok(await admin.from('assessment').select('id,template_code,plant_id').eq('cycle_id', launched.data.cycle_id))
  for (const r of rows as { id: string; template_code: string; plant_id: string }[]) {
    ASSESSMENT[`${r.plant_id === ID.plant1 ? 1 : 2}/${r.template_code === CODE_A ? 'a' : 'b'}`] = r.id
  }
  MAIN = ASSESSMENT['1/a']!
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  for (const p of [ID.plant1, ID.plant2]) if (p) await admin.from('approval_route').delete().eq('plant_id', p)
  for (const t of [ID.templateA, ID.templateB, ID.templateInactive]) if (t) await admin.from('questionnaire_template').delete().eq('id', t)
  await admin.from('plant').delete().in('factory_code', [FACTORY_1, FACTORY_2])
  for (const c of [ID.company1, ID.company2]) if (c) await admin.from('company').delete().eq('id', c)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
})

describe('剛發起', () => {
  it('lists every 自評表 of the year for a 稽核管理者, with 公司, 廠區 and 範本, in 公司 → 廠區 → 範本 order', async () => {
    const rows = await trackingOf(EMP.auditAdmin)
    expect(rows.map((r) => [r.company_name, r.factory_code, r.plant_name, r.template_code, r.template_name])).toEqual([
      [`${RUN}1公司`, FACTORY_1, `${RUN}一廠`, CODE_A, `${CODE_A} 範本`],
      [`${RUN}1公司`, FACTORY_1, `${RUN}一廠`, CODE_B, `${CODE_B} 範本`],
      [`${RUN}2公司`, FACTORY_2, `${RUN}二廠`, CODE_A, `${CODE_A} 範本`],
    ])
    expect(rows.every((r) => r.year === YEAR && r.due_date === '2099-12-31')).toBe(true)
    expect(rows.map((r) => r.template_id)).toEqual([ID.templateA, ID.templateB, ID.templateA])
  })

  it('shows 關卡 1 of 4, its signer and name, and counts the stay from the launch', async () => {
    await backdate(MAIN, 2)
    const row = await rowOf(MAIN)
    expect(row).toMatchObject({
      status: 'in_progress', current_step_position: 1, step_count: 4, current_step_name: '自行檢查人員－資材',
      current_signer_emp_id: EMP.checker, current_signer_name: '乙', closed_at: null, stage: 'filling',
    })
    expect(row.due_in_days).toBeGreaterThan(365)
    expectStay(row, 2)
    const created = ok(await admin.from('assessment').select('created_at').eq('id', MAIN).single()) as { created_at: string }
    expect(sameInstant(row.entered_step_at, created.created_at)).toBe(true)
  })
})

describe('送出、退回、重簽', () => {
  it('moves to the next 關卡 on submit and counts the stay from the submit', async () => {
    await answerAndSubmit(MAIN)
    const moved = await rowOf(MAIN)
    expect(moved).toMatchObject({ current_step_position: 2, current_step_name: '部門主管－資材', current_signer_emp_id: EMP.manager, current_signer_name: '丙', stage: 'signing' })
    expect(sameInstant(moved.entered_step_at, await lastSignoffAt(MAIN))).toBe(true)
    expectStay(moved)
    await backdate(MAIN, 5)
    const row = await rowOf(MAIN)
    expectStay(row, 5)
    expect(sameInstant(row.entered_step_at, await lastSignoffAt(MAIN))).toBe(true)
  })

  it('restarts the stay after a 退回 (Q95)', async () => {
    await rpcOk(await as(EMP.manager), 'return_assessment', { p_assessment_id: MAIN, p_to_position: 1, p_reason: '請補附件' })
    const row = await rowOf(MAIN)
    expect(row).toMatchObject({ current_step_position: 1, current_signer_emp_id: EMP.checker, stage: 'filling' })
    expectStay(row)
    expect(row.days_at_step).toBeLessThanOrEqual(1)
    expect(sameInstant(row.entered_step_at, await lastSignoffAt(MAIN))).toBe(true)
  })

  it('matches the 自評表\'s actual 關卡 on every move up to 結案, then shows the 結案 time instead of a stay', async () => {
    await rpcOk(await as(EMP.checker), 'submit_assessment_step', { p_assessment_id: MAIN })
    await rpcOk(await as(EMP.manager), 'approve_assessment_step', { p_assessment_id: MAIN })
    const actual = ok(await admin.from('assessment').select('current_step_position').eq('id', MAIN).single()) as { current_step_position: number }
    expect((await rowOf(MAIN)).current_step_position).toBe(actual.current_step_position)
    expect(await rowOf(MAIN)).toMatchObject({ current_step_position: 3, current_signer_emp_id: EMP.chief, current_signer_name: '戊' })

    await rpcOk(await as(EMP.chief), 'approve_assessment_step', { p_assessment_id: MAIN }) // 台北稽核人員
    expect(await rowOf(MAIN)).toMatchObject({ current_step_position: 4, current_signer_emp_id: EMP.chief })
    await rpcOk(await as(EMP.chief), 'approve_assessment_step', { p_assessment_id: MAIN }) // 稽核主管
    const row = await rowOf(MAIN)
    expect(row).toMatchObject({ status: 'closed', days_at_step: null, stage: 'closed' })
    expect(sameInstant(row.closed_at, await lastSignoffAt(MAIN))).toBe(true)
  })

  it('leaves the other 自評表 of the year where they were', async () => {
    for (const id of [ASSESSMENT['1/b']!, ASSESSMENT['2/a']!]) {
      const row = await rowOf(id)
      expect(row).toMatchObject({ status: 'in_progress', current_step_position: 1 })
      expectStay(row)
    }
  })
})

describe('範本與適用廠區（#86）', () => {
  it('gives a 稽核主管 each 啟用 範本 with its 組成要素 and the 廠區 it applies to, but no 停用 one no 自評表 came from', async () => {
    const templates = await templatesOf(EMP.auditAdmin)
    expect(templates.map((t) => t.template_id).sort()).toEqual([ID.templateA, ID.templateB].sort())
    const a = templates.find((t) => t.template_id === ID.templateA)!
    expect(a).toMatchObject({ template_code: CODE_A, template_name: `${CODE_A} 範本`, template_component: 'control_activities' })
    expect([...a.applies_to].sort()).toEqual([ID.plant1, ID.plant2].sort())
    expect(templates.find((t) => t.template_id === ID.templateB)!.applies_to).toEqual([ID.plant1])
  })

  it('gives a 檢視者 the 範本 of their 檢視廠區 only, applying there only', async () => {
    expect(await trackingOf(EMP.viewer)).toHaveLength(1)
    const templates = await templatesOf(EMP.viewer)
    expect(templates.map((t) => [t.template_id, t.applies_to])).toEqual([[ID.templateA, [ID.plant2]]])
  })

  it('still gives a 範本 a 自評表 came from once it is no longer 啟用, applying nowhere', async () => {
    ok(await admin.from('questionnaire_template').update({ status: 'inactive' }).eq('id', ID.templateB))
    try {
      expect((await templatesOf(EMP.auditAdmin)).find((t) => t.template_id === ID.templateB)).toMatchObject({ applies_to: [] })
    } finally {
      ok(await admin.from('questionnaire_template').update({ status: 'active' }).eq('id', ID.templateB))
    }
  })
})

describe('權限', () => {
  it('gives anyone who is not a 稽核管理者 nothing, even the signers on the route', async () => {
    for (const who of [EMP.checker, EMP.manager, EMP.chief, EMP.outsider]) {
      expect(await trackingOf(who)).toEqual([])
      expect(await templatesOf(who)).toEqual([])
    }
  })
})
