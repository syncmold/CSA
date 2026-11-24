// 資料 API 接縫: 發起帶入台北稽核人員／稽核主管，換人同步已發出的自評表（工單 #190，規格 #187）。
// 台北稽核人員連動「是稽核人員或稽核主管的廠區管理員」（Q140），稽核主管連動「現任稽核主管」（剛好一位才算）；換人時還沒簽的關卡跟著換，
// 已簽的不動，每一關在新的人身上記一筆換人。這支測台北稽核人員；換稽核主管會動到全部廠區，在自己的資料庫測
// （audit_chief_sync.test.ts）。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, insertRow, launchAssigned, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest, withSuperuser } from './helpers'

const RUN = `L${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
const EMP = {
  chief: `${RUN}A`,
  /** 稽核人員：一廠原本的廠區管理員 */
  staffA: `${RUN}B`,
  /** 稽核人員：接任一廠 */
  staffB: `${RUN}C`,
  /** 廠區端的人：二廠的廠區管理員，後來也接一廠 */
  plantSide: `${RUN}D`,
  /** 流程上存的台北稽核人員、稽核主管 */
  routeAuditor: `${RUN}E`,
  routeChief: `${RUN}F`,
  selfChecker: `${RUN}G`,
  manager: `${RUN}H`,
}
const FACTORY = { one: `${RUN}P1`, two: `${RUN}P2`, none: `${RUN}P3` }
/** tests/db/helpers.ts 檔尾的年度區間表：28000 是這支。 */
const YEAR = 28000 + Math.floor(Math.random() * 900)
const UNIT = `${RUN}業務`
const ID: Record<string, string> = {}

type Step = { id: string; name: string; link: string | null; signer_emp_id: string | null; state: string }

let chief: SupabaseClient

const combo = (template: string, plant: string) => ({ template_id: template, plant_id: plant })

async function linked(assessmentId: string): Promise<Record<string, Step>> {
  const rows = ok(await admin.from('assessment_step').select('id,name,link,signer_emp_id,state').eq('assessment_id', assessmentId)) as Step[]
  return Object.fromEntries(rows.filter((s) => s.link).map((s) => [s.link!, s]))
}

async function routeSigners(routeId: string): Promise<Record<string, string | null>> {
  const rows = ok(await admin.from('route_step').select('link,signer_emp_id').eq('route_id', routeId)) as { link: string | null; signer_emp_id: string | null }[]
  return Object.fromEntries(rows.filter((s) => s.link).map((s) => [s.link!, s.signer_emp_id]))
}

const lastLogId = (): Promise<number> =>
  withSuperuser(async (sql) => (await sql.query('select coalesce(max(id), 0)::int as id from public.access_change_log')).rows[0].id)

const logSince = (since: number, targets: string[]) =>
  withSuperuser(async (sql) =>
    (await sql.query(
      `select target_emp_id, action, before, after from public.access_change_log where id > $1 and target_emp_id = any($2) order by id`,
      [since, targets],
    )).rows as { target_emp_id: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> }[])

/** 自行檢查人員作答送出、廠區經理人核准：輪到台北稽核人員。 */
async function upToTaipei(assessmentId: string): Promise<void> {
  const point = (ok(await admin.from('assessment_control_point').select('id').eq('assessment_id', assessmentId).single()) as { id: string }).id
  const checker = await loginAs(EMP.selfChecker, '自檢')
  ok(await checker.rpc('save_assessment_answers', {
    p_assessment_id: assessmentId,
    p_answers: [{ control_point_id: point, assessing_unit_name: UNIT, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
    p_conclusions: [{ assessing_unit_name: UNIT, conclusion: 'satisfied', exceptions: null }],
  }))
  ok(await checker.rpc('submit_assessment_step', { p_assessment_id: assessmentId }))
  const manager = await loginAs(EMP.manager, '經理')
  ok(await manager.rpc('approve_assessment_step', { p_assessment_id: assessmentId }))
}

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.chief, '甲')
  await promoteToAuditAdmin(EMP.chief)
  ok(await admin.from('access_allowlist').insert({ emp_id: EMP.chief }))
  chief = await loginAs(EMP.chief, '甲')
  ok(await chief.rpc('add_access_members', {
    p_people: [{ emp_id: EMP.staffA, name: '稽甲' }, { emp_id: EMP.staffB, name: '稽乙' }], p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null,
  }))
  ok(await chief.rpc('add_access_members', {
    p_people: [{ emp_id: EMP.plantSide, name: '廠端' }], p_role: 'signer', p_viewer_plant_ids: [], p_note: null,
  }))

  ID.company = (await insertRow('company', { name: `${RUN}公司` })).id
  for (const [key, code] of Object.entries(FACTORY)) {
    ID[key] = (await insertRow('plant', { factory_code: code, name: `${RUN}${key}`, company_id: ID.company })).id
  }
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id

  // 一廠兩份表（一份停在台北稽核人員、一份簽過台北稽核人員），二廠一份。
  const steps = [
    { name: '自行檢查人員', group: 'plant' as const, signer: EMP.selfChecker, unitId: ID.unit! },
    { name: '廠區經理人', group: 'plant' as const, signer: EMP.manager, unitId: null },
    { name: '台北稽核人員', group: 'audit_review' as const, signer: EMP.routeAuditor, unitId: null },
    { name: '稽核主管', group: 'audit_review' as const, signer: EMP.routeChief, unitId: null },
  ]
  // t5 是一廠的第三份，等到切換那一段才補發。
  for (const [key, plant] of [['t1', 'one'], ['t2', 'one'], ['t3', 'two'], ['t5', 'one']] as const) {
    ID[key] = await makeTemplate(`${RUN}${key}`, 'control_activity', FACTORY[plant], [['第一章', [['要點一', ID.unit!]]]])
    ID[`${key}Route`] = await makeRoute(ID[key]!, ID[plant]!, steps)
  }
  // 三廠沒有廠區管理員（不能發起），只拿它的流程直接問 launch_step_signer。
  ID.t4 = await makeTemplate(`${RUN}t4`, 'control_activity', FACTORY.none, [['第一章', [['要點一', ID.unit!]]]])
  ID.t4Route = await makeRoute(ID.t4!, ID.none!, steps)

  ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.one, p_emp_id: EMP.staffA }))
  ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.two, p_emp_id: EMP.plantSide }))
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().in('plant_id', [ID.one, ID.two, ID.none].filter(Boolean))
  await admin.from('questionnaire_template').delete().in('id', [ID.t1, ID.t2, ID.t3, ID.t4, ID.t5].filter(Boolean))
  await admin.from('plant_coordinator').delete().in('plant_id', [ID.one, ID.two, ID.none].filter(Boolean))
  const listed = ok(await admin.from('access_allowlist').select('emp_id').like('emp_id', `${RUN}%`)) as { emp_id: string }[]
  for (const { emp_id } of listed) await admin.from('access_allowlist').delete().eq('emp_id', emp_id)
  await admin.from('plant').delete().in('factory_code', Object.values(FACTORY))
  await admin.from('assessing_unit').delete().eq('name', UNIT)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
})

describe('發起帶入台北稽核人員', () => {
  it('廠區管理員是稽核人員就帶入他；是廠區端的人就照流程上存的人', async () => {
    const launched = ok(await launchAssigned(chief, {
      p_year: YEAR, p_due_date: '2099-12-31', p_combos: [combo(ID.t1!, ID.one!), combo(ID.t2!, ID.one!), combo(ID.t3!, ID.two!)],
    })) as { ok: boolean; cycle_id: string }
    expect(launched).toMatchObject({ ok: true, assessments: 3 })
    const rows = ok(await admin.from('assessment').select('id,template_id').eq('cycle_id', launched.cycle_id)) as { id: string; template_id: string }[]
    for (const key of ['t1', 't2', 't3']) ID[`${key}Form`] = rows.find((r) => r.template_id === ID[key])!.id

    expect((await linked(ID.t1Form!)).taipei_auditor!.signer_emp_id).toBe(EMP.staffA)
    expect((await linked(ID.t2Form!)).taipei_auditor!.signer_emp_id).toBe(EMP.staffA)
    expect((await linked(ID.t3Form!)).taipei_auditor!.signer_emp_id).toBe(EMP.routeAuditor)
  })

  it('沒有廠區管理員也照流程上存的人', async () => {
    const signer = await withSuperuser(async (sql) =>
      (await sql.query(
        `select public.launch_step_signer(rs, $2) as signer_emp_id
           from public.route_step rs where rs.route_id = $1 and rs.link = 'taipei_auditor'`,
        [ID.t4Route, ID.none],
      )).rows[0].signer_emp_id,
    )
    expect(signer).toBe(EMP.routeAuditor)
  })
})

describe('換廠區管理員：還沒簽的台北稽核人員跟著換', () => {
  beforeAll(async () => {
    // t1 正輪到台北稽核人員；t2 台北稽核人員已簽（稽甲核准），輪到稽核主管。
    await upToTaipei(ID.t1Form!)
    await upToTaipei(ID.t2Form!)
    const staffA = await loginAs(EMP.staffA, '稽甲')
    ok(await staffA.rpc('approve_assessment_step', { p_assessment_id: ID.t2Form }))
  })

  it('換成另一位稽核人員：正在輪到的換給他，已簽的不動，流程也換，別的廠區不動；每一關記一筆換人', async () => {
    expect((await linked(ID.t1Form!)).taipei_auditor).toMatchObject({ signer_emp_id: EMP.staffA, state: 'current' })
    expect((await linked(ID.t2Form!)).taipei_auditor).toMatchObject({ signer_emp_id: EMP.staffA, state: 'done' })
    const since = await lastLogId()
    const updatedAt = async () => (ok(await admin.from('approval_route').select('updated_at').eq('id', ID.t1Route!).single()) as { updated_at: string }).updated_at
    const before = await updatedAt()
    const chiefBefore = (await routeSigners(ID.t1Route!)).audit_chief

    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.one, p_emp_id: EMP.staffB }))

    expect((await linked(ID.t1Form!)).taipei_auditor).toMatchObject({ signer_emp_id: EMP.staffB, state: 'current' })
    expect((await linked(ID.t2Form!)).taipei_auditor).toMatchObject({ signer_emp_id: EMP.staffA, state: 'done' })
    expect((await routeSigners(ID.t1Route!)).taipei_auditor).toBe(EMP.staffB)
    expect((await routeSigners(ID.t2Route!)).taipei_auditor).toBe(EMP.staffB)
    expect((await routeSigners(ID.t3Route!)).taipei_auditor).toBe(EMP.routeAuditor)
    expect((await linked(ID.t3Form!)).taipei_auditor!.signer_emp_id).toBe(EMP.routeAuditor)
    // 稽核主管關卡不受影響；流程跟著換不算修改流程。
    expect((await routeSigners(ID.t1Route!)).audit_chief).toBe(chiefBefore)
    expect(await updatedAt()).toBe(before)

    const rows = await logSince(since, [EMP.staffA, EMP.staffB])
    expect(rows.map((r) => [r.target_emp_id, r.action])).toEqual([[EMP.staffB, 'coordinator_replaced'], [EMP.staffB, 'step_reassigned']])
    expect(rows[1]).toMatchObject({
      before: { emp_id: EMP.staffA, name: '稽甲' },
      after: { year: YEAR, plant: FACTORY.one, template: `${RUN}t1`, step: '台北稽核人員', branch: null },
    })
  })

  it('連動時流程上的台北稽核人員不能在流程裡改；計算欄位 linked_now 是真', async () => {
    const taipei = ok(await chief.from('route_step').select('id,linked_now').eq('route_id', ID.t1Route!).eq('link', 'taipei_auditor').single()) as { id: string; linked_now: boolean }
    expect(taipei.linked_now).toBe(true)
    expect((await chief.from('route_step').update({ signer_emp_id: EMP.routeAuditor }).eq('id', taipei.id)).error).toMatchObject({ code: '23514', hint: 'step_linked' })
    expect((await routeSigners(ID.t1Route!)).taipei_auditor).toBe(EMP.staffB)
  })

  it('接手的人簽得到', async () => {
    const staffB = await loginAs(EMP.staffB, '稽乙')
    expect(ok(await staffB.rpc('approve_assessment_step', { p_assessment_id: ID.t1Form }))).toMatchObject({ ok: true })
    expect((await linked(ID.t1Form!)).taipei_auditor).toMatchObject({ signer_emp_id: EMP.staffB, state: 'done' })
  })
})

describe('廠區管理員在稽核人員與廠區端的人之間切換（#187 定案第 4 點）', () => {
  beforeAll(async () => {
    // 補發一份一廠的表：帶入現在的稽乙，台北稽核人員還沒輪到（pending）。
    const launched = ok(await launchAssigned(chief, { p_year: YEAR, p_due_date: '2099-12-31', p_combos: [combo(ID.t5!, ID.one!)] })) as { ok: boolean }
    expect(launched).toMatchObject({ ok: true, top_up: true })
    ID.t5Form = (ok(await admin.from('assessment').select('id').eq('template_id', ID.t5!).single()) as { id: string }).id
    expect((await linked(ID.t5Form!)).taipei_auditor).toMatchObject({ signer_emp_id: EMP.staffB, state: 'pending' })
  })

  it('改成廠區端的人：保留原本的人，不再連動', async () => {
    const since = await lastLogId()
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.one, p_emp_id: EMP.plantSide }))
    expect((await linked(ID.t5Form!)).taipei_auditor!.signer_emp_id).toBe(EMP.staffB)
    expect((await routeSigners(ID.t1Route!)).taipei_auditor).toBe(EMP.staffB)
    expect((await logSince(since, [EMP.plantSide, EMP.staffB])).map((r) => r.action)).toEqual(['coordinator_replaced'])
  })

  it('不連動時在流程裡選人（定案第 1 點）：只能改簽核人，改名、刪除照舊拒絕', async () => {
    const taipei = ok(await chief.from('route_step').select('id,linked_now').eq('route_id', ID.t1Route!).eq('link', 'taipei_auditor').single()) as { id: string; linked_now: boolean }
    expect(taipei.linked_now).toBe(false)
    ok(await chief.from('route_step').update({ signer_emp_id: EMP.routeAuditor }).eq('id', taipei.id))
    expect((await routeSigners(ID.t1Route!)).taipei_auditor).toBe(EMP.routeAuditor)
    const linked = { code: '23514', hint: 'step_linked' }
    expect((await chief.from('route_step').update({ name: '改名' }).eq('id', taipei.id)).error).toMatchObject(linked)
    expect((await chief.from('route_step').delete().eq('id', taipei.id)).error).toMatchObject(linked)
  })

  it('那個人改成稽核人員：他負責的每一廠都蓋成他', async () => {
    const since = await lastLogId()
    ok(await chief.rpc('update_access_member', { p_emp_id: EMP.plantSide, p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null }))
    expect((await linked(ID.t5Form!)).taipei_auditor!.signer_emp_id).toBe(EMP.plantSide)
    expect((await linked(ID.t3Form!)).taipei_auditor!.signer_emp_id).toBe(EMP.plantSide)
    expect((await linked(ID.t2Form!)).taipei_auditor).toMatchObject({ signer_emp_id: EMP.staffA, state: 'done' })
    for (const route of [ID.t1Route!, ID.t2Route!, ID.t3Route!, ID.t5Route!]) expect((await routeSigners(route)).taipei_auditor).toBe(EMP.plantSide)
    const rows = await logSince(since, [EMP.plantSide])
    expect(rows.map((r) => r.action)).toEqual(['role', 'step_reassigned', 'step_reassigned'])
    expect(rows.slice(1).map((r) => [r.before?.emp_id, r.after.plant]).sort()).toEqual([[EMP.staffB, FACTORY.one], [EMP.routeAuditor, FACTORY.two]].sort())
  })

  it('稽核人員的角色被改掉、或卸任廠區管理員：保留原本的人', async () => {
    const since = await lastLogId()
    ok(await chief.rpc('update_access_member', { p_emp_id: EMP.plantSide, p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
    ok(await chief.rpc('remove_plant_coordinator', { p_plant_id: ID.one }))
    expect((await linked(ID.t5Form!)).taipei_auditor!.signer_emp_id).toBe(EMP.plantSide)
    expect((await routeSigners(ID.t1Route!)).taipei_auditor).toBe(EMP.plantSide)
    expect((await logSince(since, [EMP.plantSide])).map((r) => r.action)).toEqual(['role', 'coordinator_removed'])
  })

  it('再指定稽核人員：蓋成新的人', async () => {
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.one, p_emp_id: EMP.staffA }))
    expect((await linked(ID.t5Form!)).taipei_auditor!.signer_emp_id).toBe(EMP.staffA)
    expect((await routeSigners(ID.t1Route!)).taipei_auditor).toBe(EMP.staffA)
  })
})

describe('廠區管理員是稽核主管也連動（Q140）', () => {
  it('指定稽核主管當廠區管理員：那一廠流程上的台北稽核人員換成他，發起也帶入他，流程裡不能改', async () => {
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.none, p_emp_id: EMP.chief }))
    expect((await routeSigners(ID.t4Route!)).taipei_auditor).toBe(EMP.chief)
    const signer = await withSuperuser(async (sql) =>
      (await sql.query(
        `select public.launch_step_signer(rs, $2) as signer_emp_id
           from public.route_step rs where rs.route_id = $1 and rs.link = 'taipei_auditor'`,
        [ID.t4Route, ID.none],
      )).rows[0].signer_emp_id,
    )
    expect(signer).toBe(EMP.chief)
    const taipei = ok(await chief.from('route_step').select('id,linked_now').eq('route_id', ID.t4Route!).eq('link', 'taipei_auditor').single()) as { id: string; linked_now: boolean }
    expect(taipei.linked_now).toBe(true)
    expect((await chief.from('route_step').update({ signer_emp_id: EMP.routeAuditor }).eq('id', taipei.id)).error).toMatchObject({ code: '23514', hint: 'step_linked' })
  })
})
