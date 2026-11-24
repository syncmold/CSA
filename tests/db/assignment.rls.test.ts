// 資料 API 接縫: 分派填寫人（工單 #101、#222；Q147 修訂 Q116 (5)(7)(8)、Q143）。發出前由稽核主管或該廠的廠區管理員在簽核
// 流程上分派，全部分派好才能發出，發出時照抄進自評表、每條分流同時開始；發出後只有稽核主管能換人，換人寫回流程（明年沿用）。
// 被排上的人自動放行，他手上的自評表都結案後失效；換人留著暫存答案；已簽的關卡不能換。Q147 前發出、還有關卡待分派的舊自評表
// 由稽核主管補分派。例子同 Q116 的 mockup：何欣怡是廠區管理員，蔡宛儒不在放行名單上。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { selectTracking, type TrackingRow } from '../../src/api/trackingQuery'
import type { LaunchCheck } from '../../src/api/approvalRoutes'
import { admin, depsFor, insertRow, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest, withSuperuser } from './helpers'

const RUN = `A${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
const EMP = {
  chief: `${RUN}A`,
  /** 何欣怡：這一廠的廠區管理員 */
  owner: `${RUN}B`,
  /** 別的廠區的廠區管理員 */
  otherOwner: `${RUN}C`,
  sales: `${RUN}D`,
  salesManager: `${RUN}E`,
  /** 蔡宛儒：不在放行名單 */
  newcomer: `${RUN}F`,
  replacement: `${RUN}G`,
  plantManager: `${RUN}H`,
  /** 小表的廠區經理人：只有那一張表 */
  smallManager: `${RUN}I`,
  /** 王雅婷：權限管理名單上的本廠人員（Q132） */
  listed: `${RUN}J`,
  /** 權限管理名單上的別廠人員（Q132） */
  listedOther: `${RUN}K`,
  /** 在權限管理名單上、但 employee_ref 沒有他（沒登入過，Q134） */
  noRef: `${RUN}M`,
  /** 子公司擔當稽核（Q143），不在放行名單 */
  subsidiaryAuditor: `${RUN}N`,
}
/** OMS 給的寫法是小寫的工號：照存，放行比對時不分大小寫。 */
const LOWER = `${RUN}l`
const FACTORY = { mine: `${RUN}P1`, other: `${RUN}P2` }
/** tests/db/helpers.ts 檔尾的年度區間表：24000 是這支。 */
const YEAR = 24000 + Math.floor(Math.random() * 900)
const DUE = '2099-12-31'
const UNITS = { sales: `${RUN}業務`, material: `${RUN}資材`, quality: `${RUN}品保`, finance: `${RUN}財務` }
const ID: Record<string, string> = {}

type Step = { id: string; position: number; name: string; signer_emp_id: string | null; state: string; branch_unit_name: string | null }
type RouteStep = { id: string; name: string; signer_emp_id: string | null }

let chief: SupabaseClient
let owner: SupabaseClient
let otherOwner: SupabaseClient

const combo = (template: string, plant = ID.mine!) => ({ template_id: template, plant_id: plant })
/** 發出後換人（assign_step_signer）。 */
const assign = (client: SupabaseClient, stepId: string, empId: string, name: string | null = null) =>
  client.rpc('assign_step_signer', { p_step_id: stepId, p_emp_id: empId, p_emp_name: name })
/** 發出前在流程上分派（assign_route_signer）。 */
const assignRoute = (client: SupabaseClient, stepId: string, empId: string, name: string | null = null) =>
  client.rpc('assign_route_signer', { p_route_step_id: stepId, p_emp_id: empId, p_emp_name: name })

async function steps(assessmentId: string): Promise<Step[]> {
  const rows = ok(await admin.from('assessment_step').select('id,position,name,signer_emp_id,state,branch_unit_name').eq('assessment_id', assessmentId))
  return (rows as Step[]).sort((a, b) => a.position - b.position)
}

const stepNamed = async (assessmentId: string, name: string) => (await steps(assessmentId)).find((s) => s.name === name)!

async function routeSteps(templateId: string): Promise<RouteStep[]> {
  const rows = ok(await admin.from('route_step').select('id,name,position,signer_emp_id,approval_route!inner(template_id)').eq('approval_route.template_id', templateId).order('position'))
  return (rows as (RouteStep & { approval_route: unknown })[]).map(({ id, name, signer_emp_id }) => ({ id, name, signer_emp_id }))
}

const routeStepNamed = async (templateId: string, name: string) => (await routeSteps(templateId)).find((s) => s.name === name)!

async function launchCheck(templateId: string): Promise<LaunchCheck> {
  return (ok(await chief.from('approval_route').select('launch_check').eq('template_id', templateId).single()) as { launch_check: LaunchCheck }).launch_check
}

const admitted = (empId: string) => depsFor(empId, empId).csa.isAdmitted(empId)

async function trackingRow(assessmentId: string): Promise<TrackingRow | undefined> {
  return (ok(await selectTracking(chief, YEAR)) as TrackingRow[]).find((r) => r.assessment_id === assessmentId)
}

async function logOf(target: string) {
  const rows = ok(await chief.from('access_change_log').select('actor_emp_id,target_emp_id,target_name,action,before,after').eq('target_emp_id', target).order('id'))
  return rows as { actor_emp_id: string; target_name: string | null; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> }[]
}

/** 這支測試的廠區的待辦列。 */
async function todoOf(client: SupabaseClient) {
  const rows = ok(await client.from('my_assignment_todo').select('kind,factory_code,year,forms,steps,pending').in('factory_code', Object.values(FACTORY)))
  return rows as { kind: string; factory_code: string; year: number | null; forms: number; steps: number; pending: { template_code: string; name: string }[] }[]
}

const answerFor = (pointId: string, unit: string) => ({
  control_point_id: pointId, assessing_unit_name: unit, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null,
})

/** 銷售循環的每一關發出前要分派給誰。 */
const MAIN_PLAN: [string, string][] = [
  [`自行檢查人員－${UNITS.sales}`, EMP.sales], [`部門主管－${UNITS.sales}`, EMP.salesManager],
  [`自行檢查人員－${UNITS.material}`, EMP.sales], [`部門主管－${UNITS.material}`, EMP.salesManager],
  [`自行檢查人員－${UNITS.quality}`, EMP.newcomer], [`部門主管－${UNITS.quality}`, EMP.salesManager],
  [`自行檢查人員－${UNITS.finance}`, EMP.sales], [`部門主管－${UNITS.finance}`, LOWER], ['課長', EMP.salesManager],
  ['廠區經理人', EMP.plantManager],
]

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.chief, '甲')
  await promoteToAuditAdmin(EMP.chief)
  ok(await admin.from('access_allowlist').insert({ emp_id: EMP.chief }))
  chief = await loginAs(EMP.chief, '甲')
  owner = await loginAs(EMP.owner, '何欣怡')
  otherOwner = await loginAs(EMP.otherOwner, '別廠')

  ID.company = (await insertRow('company', { name: `${RUN}公司` })).id
  ID.mine = (await insertRow('plant', { factory_code: FACTORY.mine, name: `${RUN}一廠`, company_id: ID.company })).id
  ID.other = (await insertRow('plant', { factory_code: FACTORY.other, name: `${RUN}二廠`, company_id: ID.company })).id
  for (const [key, name] of Object.entries(UNITS)) ID[key] = (await insertRow('assessing_unit', { name })).id

  // 銷售循環：四條分流（財務多一位課長）；小表：只有業務一條，走得到結案。流程建好時廠區端都還沒分派。
  ID.main = await makeTemplate(`${RUN}M`, 'control_activity', FACTORY.mine, [['第一章', [
    ['要點一', ID.sales!], ['要點二', ID.material!], ['要點三', ID.quality!], ['要點四', ID.finance!],
  ]]])
  await makeRoute(ID.main, ID.mine!, [
    ...Object.entries(UNITS).map(([key, name]) => ({ name: `自行檢查人員－${name}`, group: 'plant' as const, signer: '', unitId: ID[key]! })),
    ...Object.entries(UNITS).map(([key, name]) => ({ name: `部門主管－${name}`, group: 'plant' as const, signer: '', unitId: null, branchUnitId: ID[key]! })),
    { name: '課長', group: 'plant', signer: '', unitId: null, branchUnitId: ID.finance! },
    { name: '廠區經理人', group: 'plant', signer: '', unitId: null },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
  ])
  ID.small = await makeTemplate(`${RUN}S`, 'control_activity', FACTORY.mine, [['第一章', [['要點一', ID.sales!]]]])
  await makeRoute(ID.small, ID.mine!, [
    { name: '自行檢查人員', group: 'plant', signer: '', unitId: ID.sales! },
    { name: '廠區經理人', group: 'plant', signer: '', unitId: null },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
  ])
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().eq('plant_id', ID.mine!)
  await admin.from('questionnaire_template').delete().in('id', [ID.main, ID.small, ID.audited].filter(Boolean))
  await admin.from('plant_coordinator').delete().in('plant_id', [ID.mine, ID.other].filter(Boolean))
  const listed = ok(await admin.from('access_allowlist').select('emp_id').like('emp_id', `${RUN}%`)) as { emp_id: string }[]
  for (const { emp_id } of listed) await admin.from('access_allowlist').delete().eq('emp_id', emp_id)
  await admin.from('plant').delete().in('factory_code', Object.values(FACTORY))
  await admin.from('assessing_unit').delete().in('name', Object.values(UNITS))
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
})

describe('發出前在流程上分派（Q147）', () => {
  it('流程還沒分派好就不能發起；發起檢查列出是哪幾關（分流的在前）', async () => {
    const check = await launchCheck(ID.main!)
    expect(check.ready).toBe(false)
    expect(check.unassigned_steps.map((s) => s.name)).toEqual(MAIN_PLAN.map(([name]) => name))
    expect(check.unassigned_steps[0]).toMatchObject({ branch_unit_id: ID.sales, branch_unit_name: UNITS.sales })
    expect(check.unassigned_steps.at(-1)).toMatchObject({ name: '廠區經理人', branch_unit_id: null, branch_unit_name: null })
    const candidates = ok(await chief.rpc('launch_candidates')) as { template_id: string; problem: string | null }[]
    expect(candidates.find((c) => c.template_id === ID.main)?.problem).toBe('not_ready')
    const refused = ok(await chief.rpc('launch_annual_cycle', { p_year: YEAR, p_due_date: DUE, p_combos: [combo(ID.main!)] }))
    expect(refused).toMatchObject({ ok: false, error: 'missing_route', missing: [{ problem: 'not_ready' }] })
  })

  it('廠區管理員讀得到本廠的流程、關卡與用到的範本（只讀）；別廠的讀不到', async () => {
    ok(await chief.rpc('add_access_members', {
      p_people: [{ emp_id: EMP.owner, name: '何欣怡', factory_code: FACTORY.mine }, { emp_id: EMP.otherOwner, name: '別廠', factory_code: FACTORY.other }],
      p_role: 'signer', p_viewer_plant_ids: [], p_note: null,
    }))
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.mine, p_emp_id: EMP.owner }))
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.other, p_emp_id: EMP.otherOwner }))

    const routes = ok(await owner.from('approval_route')
      .select('plant_id,questionnaire_template(code),route_step(name,signer_emp_id,branch:assessing_unit!route_step_branch_unit_id_fkey(name))')
      .eq('plant_id', ID.mine!)) as unknown as { questionnaire_template: { code: string }; route_step: { branch: { name: string } | null }[] }[]
    expect(routes.map((r) => r.questionnaire_template.code).sort()).toEqual([`${RUN}M`, `${RUN}S`])
    expect(routes.find((r) => r.questionnaire_template.code === `${RUN}M`)!.route_step).toHaveLength(12)
    expect(routes.flatMap((r) => r.route_step).filter((s) => s.branch?.name === UNITS.finance)).toHaveLength(3)
    expect(ok(await owner.from('template_section').select('id').eq('template_id', ID.main!))).toEqual([])
    expect(ok(await otherOwner.from('approval_route').select('id').eq('plant_id', ID.mine!))).toEqual([])
    expect(ok(await otherOwner.from('route_step').select('id').in('id', (await routeSteps(ID.main!)).map((s) => s.id)))).toEqual([])

    // 只讀：直接改關卡改不到（RLS 不給寫入），流程編輯也不行。
    const step = await routeStepNamed(ID.main!, '廠區經理人')
    ok(await owner.from('route_step').update({ signer_emp_id: EMP.owner }).eq('id', step.id))
    expect((await routeStepNamed(ID.main!, '廠區經理人')).signer_emp_id).toBeNull()
    const routeId = (ok(await admin.from('approval_route').select('id').eq('template_id', ID.main!).single()) as { id: string }).id
    expect((await owner.rpc('insert_route_step', { p_route_id: routeId, p_name: '多一關', p_step_group: 'plant', p_signer_emp_id: null })).error?.code).toBe('42501')
  })

  it('首頁待辦：廠區管理員看到本廠還沒分派好的流程；別廠與稽核主管沒有', async () => {
    expect(await todoOf(owner)).toEqual([expect.objectContaining({ kind: 'route', factory_code: FACTORY.mine, year: null, forms: 2, steps: 12 })])
    expect((await todoOf(owner))[0]!.pending.map((p) => p.name)).toContain('廠區經理人')
    expect(await todoOf(otherOwner)).toEqual([])
    expect(await todoOf(chief)).toEqual([])
  })

  it('廠區管理員在流程上分派、換人，記進權限異動紀錄（哪個範本哪一關、給誰）', async () => {
    const checker = await routeStepNamed(ID.main!, `自行檢查人員－${UNITS.sales}`)
    ok(await assignRoute(owner, checker.id, EMP.replacement, '接手的人'))
    ok(await assignRoute(owner, checker.id, EMP.sales, '業務'))
    expect((await routeStepNamed(ID.main!, checker.name)).signer_emp_id).toBe(EMP.sales)
    const where = { plant: FACTORY.mine, template: `${RUN}M`, step: checker.name, branch: UNITS.sales }
    expect(await logOf(EMP.replacement)).toEqual([
      expect.objectContaining({ actor_emp_id: EMP.owner, target_name: '接手的人', action: 'route_step_assigned', before: null, after: where }),
    ])
    expect(await logOf(EMP.sales)).toEqual([
      expect.objectContaining({
        actor_emp_id: EMP.owner, target_name: '業務', action: 'route_step_reassigned', before: { emp_id: EMP.replacement, name: null }, after: where,
      }),
    ])
    // 改前的姓名取 CSA 存的（接手的人沒登入過，所以是空的，同 assign_step_signer）。換成同一個人什麼都不做，也不留紀錄。
    ok(await assignRoute(owner, checker.id, EMP.sales))
    expect(await logOf(EMP.sales)).toHaveLength(1)
  })

  it('別廠的廠區管理員、一般使用者不能分派；稽核主管可以；連動關卡與空白拒絕', async () => {
    const step = await routeStepNamed(ID.main!, `部門主管－${UNITS.sales}`)
    expect((await assignRoute(otherOwner, step.id, EMP.salesManager)).error?.code).toBe('42501')
    expect((await assignRoute(await loginAs(EMP.sales, '業務'), step.id, EMP.salesManager)).error?.code).toBe('42501')
    ok(await assignRoute(chief, step.id, EMP.salesManager, '業務主管'))
    expect((await routeStepNamed(ID.main!, step.name)).signer_emp_id).toBe(EMP.salesManager)
    const linked = await routeStepNamed(ID.main!, '稽核主管')
    expect((await assignRoute(owner, linked.id, EMP.sales)).error).toMatchObject({ code: '23514', hint: 'linked_step' })
    expect((await assignRoute(chief, linked.id, EMP.sales)).error).toMatchObject({ code: '23514', hint: 'linked_step' })
    expect((await assignRoute(owner, step.id, '  ')).error).toMatchObject({ code: '23514', hint: 'signer_required' })
    expect((await assignRoute(owner, '00000000-0000-4000-8000-000000000000', EMP.sales)).error?.code).toBe('P0002')
  })

  it('全部分派好才通過發起檢查，待辦跟著消失；工號照 OMS 給的寫法存；分派不算修改流程', async () => {
    const updatedAt = async () => (ok(await admin.from('approval_route').select('updated_at').eq('template_id', ID.main!).single()) as { updated_at: string }).updated_at
    const before = await updatedAt()
    for (const [name, empId] of MAIN_PLAN) ok(await assignRoute(owner, (await routeStepNamed(ID.main!, name)).id, ` ${empId} `))
    expect((await routeStepNamed(ID.main!, `部門主管－${UNITS.finance}`)).signer_emp_id).toBe(LOWER)
    expect(await launchCheck(ID.main!)).toMatchObject({ ready: true, unassigned_steps: [] })
    expect(await updatedAt()).toBe(before)
    // 廠區管理員讀到的發起檢查和稽核主管的一樣（他讀不到範本內容，檢查照樣算對）。
    const ownCheck = ok(await owner.from('approval_route').select('launch_check').eq('template_id', ID.main!).single()) as { launch_check: LaunchCheck }
    expect(ownCheck.launch_check).toEqual(await launchCheck(ID.main!))
    expect(ok(await otherOwner.from('approval_route').select('launch_check').eq('template_id', ID.main!))).toEqual([])
    expect(await todoOf(owner)).toEqual([expect.objectContaining({ kind: 'route', forms: 1, steps: 2 })])
    ok(await assignRoute(owner, (await routeStepNamed(ID.small!, '自行檢查人員')).id, EMP.newcomer))
    ok(await assignRoute(owner, (await routeStepNamed(ID.small!, '廠區經理人')).id, EMP.smallManager))
    expect(await todoOf(owner)).toEqual([])
  })
})

describe('發出照抄流程上的人', () => {
  it('不在放行名單的人排在流程上還不能登入；發出後能', async () => {
    expect(await admitted(EMP.newcomer)).toBe(false)
    const launched = ok(await chief.rpc('launch_annual_cycle', { p_year: YEAR, p_due_date: DUE, p_combos: [combo(ID.main!), combo(ID.small!)] }))
    expect(launched).toMatchObject({ ok: true, assessments: 2, checked: false })
    expect(launched).not.toHaveProperty('carried')
    const rows = ok(await admin.from('assessment').select('id,template_id').eq('cycle_id', (launched as { cycle_id: string }).cycle_id)) as { id: string; template_id: string }[]
    ID.mainForm = rows.find((r) => r.template_id === ID.main)!.id
    ID.smallForm = rows.find((r) => r.template_id === ID.small)!.id
    expect(await admitted(EMP.newcomer)).toBe(true)
    const newcomer = await loginAs(EMP.newcomer, '蔡宛儒')
    expect(ok(await newcomer.from('my_assessment').select('assessment_id,my_part')).map((r) => (r as { assessment_id: string }).assessment_id).sort())
      .toEqual([ID.mainForm, ID.smallForm].sort())
  })

  it('每一關都是流程上的人（連動關卡照權限管理），每條分流同時開始', async () => {
    const issued = await steps(ID.mainForm!)
    expect(issued.map((s) => [s.name, s.signer_emp_id])).toEqual((await routeSteps(ID.main!)).map((s) => [s.name, s.signer_emp_id]))
    expect(issued.filter((s) => s.state === 'current').map((s) => s.branch_unit_name)).toEqual(Object.values(UNITS))
    expect(await trackingRow(ID.mainForm!)).toMatchObject({ stage: 'filling', branch_count: 4, branches_done: 0 })
  })
})

describe('發出後只有稽核主管換人（Q147）', () => {
  it('廠區管理員不能再換人', async () => {
    const step = await stepNamed(ID.mainForm!, `自行檢查人員－${UNITS.material}`)
    expect((await assign(owner, step.id, EMP.replacement)).error?.code).toBe('42501')
    expect((await assign(otherOwner, step.id, EMP.replacement)).error?.code).toBe('42501')
    expect((await stepNamed(ID.mainForm!, step.name)).signer_emp_id).toBe(EMP.sales)
  })

  it('稽核主管換正在填寫的關卡：暫存答案留著，新的人接著填，前一人看不到這張表', async () => {
    const before = await loginAs(EMP.newcomer, '蔡宛儒')
    const point = (ok(await admin.from('assessment_control_point_unit').select('control_point_id')
      .eq('assessment_id', ID.mainForm!).eq('assessing_unit_name', UNITS.quality).single()) as { control_point_id: string }).control_point_id
    ok(await before.rpc('save_assessment_answers', { p_assessment_id: ID.mainForm, p_answers: [answerFor(point, UNITS.quality)], p_conclusions: [] }))

    const step = await stepNamed(ID.mainForm!, `自行檢查人員－${UNITS.quality}`)
    expect(step.state).toBe('current')
    ok(await assign(chief, step.id, EMP.replacement, '接手的人'))

    expect(ok(await before.from('assessment').select('id').eq('id', ID.mainForm!))).toEqual([])
    const after = await loginAs(EMP.replacement, '接手的人')
    const saved = ok(await after.from('assessment_answer').select('design').eq('assessment_id', ID.mainForm!).eq('assessing_unit_name', UNITS.quality))
    expect(saved).toEqual([{ design: 'has_rule' }])
    ok(await after.rpc('save_assessment_answers', {
      p_assessment_id: ID.mainForm, p_answers: [{ ...answerFor(point, UNITS.quality), execution: 'no', improvement: '改善' }], p_conclusions: [],
    }))
  })

  it('換人寫進權限異動紀錄（前一人寫在改前），也寫回流程，明年發出沿用', async () => {
    const reassigned = (await logOf(EMP.replacement)).filter((r) => r.action === 'step_reassigned')
    expect(reassigned).toEqual([expect.objectContaining({
      actor_emp_id: EMP.chief, target_name: '接手的人',
      before: { emp_id: EMP.newcomer, name: '蔡宛儒' },
      after: { year: YEAR, plant: FACTORY.mine, template: `${RUN}M`, step: `自行檢查人員－${UNITS.quality}`, branch: UNITS.quality },
    })])
    expect((await routeStepNamed(ID.main!, `自行檢查人員－${UNITS.quality}`)).signer_emp_id).toBe(EMP.replacement)
    // 其他關卡不動。
    expect((await routeStepNamed(ID.main!, `部門主管－${UNITS.quality}`)).signer_emp_id).toBe(EMP.salesManager)
  })

  it('換成同一個人不留紀錄，只把流程對齊回表上的人；連動關卡不能換', async () => {
    const step = await stepNamed(ID.mainForm!, `自行檢查人員－${UNITS.quality}`)
    const count = (await logOf(EMP.replacement)).length
    const onRoute = await routeStepNamed(ID.main!, step.name)
    ok(await assignRoute(owner, onRoute.id, EMP.sales)) // 流程後來又換過
    ok(await assign(chief, step.id, EMP.replacement))
    expect(await logOf(EMP.replacement)).toHaveLength(count)
    expect((await routeStepNamed(ID.main!, step.name)).signer_emp_id).toBe(EMP.replacement)
    const audit = await stepNamed(ID.mainForm!, '稽核主管')
    expect((await assign(chief, audit.id, EMP.sales)).error).toMatchObject({ code: '23514', hint: 'linked_step' })
  })

  it('工號照 OMS 的寫法照抄；放行比對時不分大小寫', async () => {
    expect((await stepNamed(ID.mainForm!, `部門主管－${UNITS.finance}`)).signer_emp_id).toBe(LOWER)
    expect(await admitted(LOWER.toUpperCase())).toBe(true)
  })
})

describe('走到結案（小表）', () => {
  let form: string
  let point: string

  beforeAll(async () => {
    form = ID.smallForm!
    point = (ok(await admin.from('assessment_control_point').select('id').eq('assessment_id', form).single()) as { id: string }).id
  })

  it('分流核准後走到廠區經理人', async () => {
    const newcomer = await loginAs(EMP.newcomer, '蔡宛儒')
    ok(await newcomer.rpc('save_assessment_answers', {
      p_assessment_id: form, p_answers: [answerFor(point, UNITS.sales)],
      p_conclusions: [{ assessing_unit_name: UNITS.sales, conclusion: 'satisfied', exceptions: null }],
    }))
    ok(await newcomer.rpc('submit_assessment_step', { p_assessment_id: form }))
    expect((await steps(form)).map((s) => s.state)).toEqual(['done', 'current', 'pending', 'pending'])
    expect(await trackingRow(form)).toMatchObject({ stage: 'signing', current_step_name: '廠區經理人', current_signer_emp_id: EMP.smallManager })
  })

  it('已簽的關卡不能換人', async () => {
    const signed = await stepNamed(form, '自行檢查人員')
    expect((await assign(chief, signed.id, EMP.replacement)).error).toMatchObject({ code: '23514', hint: 'step_signed' })
  })

  it('退回後那一關稽核主管可以換人，新的人接著送出', async () => {
    const manager = await loginAs(EMP.smallManager, '經理')
    const first = await stepNamed(form, '自行檢查人員')
    ok(await manager.rpc('return_assessment', { p_assessment_id: form, p_to_position: first.position, p_reason: '請修正' }))
    ok(await assign(chief, first.id, EMP.replacement))
    expect(await stepNamed(form, '自行檢查人員')).toMatchObject({ state: 'current', signer_emp_id: EMP.replacement })
    const replacement = await loginAs(EMP.replacement, '接手的人')
    expect(ok(await replacement.rpc('submit_assessment_step', { p_assessment_id: form }))).toMatchObject({ ok: true })
  })

  it('結案後不能再換人；只有這張表的人不再放行，手上還有別張沒結案的照樣放行（Q117 (5)）', async () => {
    const manager = await loginAs(EMP.smallManager, '經理')
    ok(await manager.rpc('approve_assessment_step', { p_assessment_id: form }))
    expect(await admitted(EMP.smallManager)).toBe(true)
    ok(await chief.rpc('approve_assessment_step', { p_assessment_id: form })) // 台北稽核人員
    ok(await chief.rpc('approve_assessment_step', { p_assessment_id: form })) // 稽核主管
    expect(ok(await admin.from('assessment').select('status').eq('id', form).single())).toEqual({ status: 'closed' })

    expect((await assign(chief, (await stepNamed(form, '廠區經理人')).id, EMP.replacement)).error).toMatchObject({ code: '23514', hint: 'assessment_closed' })
    expect(await admitted(EMP.smallManager)).toBe(false)
    expect(await admitted(EMP.replacement)).toBe(true) // 銷售循環的品保自行檢查還是他
  })
})

describe('分派選人的名單：這一廠的自評表與流程已經排過的人（#218，Q133 (11) ④；Q147）', () => {
  const list = (client: SupabaseClient, factory: string) => client.rpc('plant_form_people', { p_factory_code: factory })
  const listed = { emp_id: EMP.listed, name: '王雅婷', factory_code: FACTORY.mine }
  const listedOther = { emp_id: EMP.listedOther, name: '別廠同仁', factory_code: FACTORY.other }

  it('只列這一廠的表上與流程上、由分派決定的關卡排過的人，帶 CSA 存的姓名；權限管理名單上但沒排過的人不列', async () => {
    ok(await chief.rpc('add_access_members', {
      p_people: [listed, listedOther], p_role: 'signer', p_viewer_plant_ids: [], p_note: null,
    }))
    ok(await admin.from('access_allowlist').insert({ emp_id: EMP.noRef }))
    // 只排在流程上（還沒發出）的人也列。
    const routeOnly = `${RUN}R`
    ok(await assignRoute(owner, (await routeStepNamed(ID.small!, '廠區經理人')).id, routeOnly))
    const people = ok(await list(owner, FACTORY.mine)) as { emp_id: string; name: string | null }[]
    // 對照：直接從關卡算（廠區端，加上稽核室不連動的一般關卡；流程上非連動的關卡）。
    const formSteps = ok(await admin.from('assessment_step')
      .select('signer_emp_id,step_group,link,assessment!inner(plant!inner(factory_code))')
      .eq('assessment.plant.factory_code', FACTORY.mine).not('signer_emp_id', 'is', null)) as { signer_emp_id: string; step_group: string; link: string | null }[]
    const routeRows = ok(await admin.from('route_step').select('signer_emp_id,link,approval_route!inner(plant_id)')
      .eq('approval_route.plant_id', ID.mine!).is('link', null).not('signer_emp_id', 'is', null)) as { signer_emp_id: string }[]
    const expected = [...new Set([
      ...formSteps.filter((x) => x.step_group === 'plant' || x.link === null).map((x) => x.signer_emp_id),
      ...routeRows.map((x) => x.signer_emp_id),
    ])].sort()
    expect(people.map((p) => p.emp_id).sort()).toEqual(expected)
    expect(people.map((p) => p.emp_id)).toContain(routeOnly)
    // 被換下來的人（蔡宛儒）表上、流程上都不在了，所以不列。
    expect(people.map((p) => p.emp_id)).not.toContain(EMP.newcomer)
    expect(people.find((p) => p.emp_id === EMP.sales)).toEqual({ emp_id: EMP.sales, name: '業務' })
    for (const absent of [EMP.listed, EMP.listedOther, EMP.noRef]) expect(people.map((p) => p.emp_id)).not.toContain(absent)
    // 稽核主管哪一廠都能查；別廠沒有發過表、沒排過流程就是空的。
    expect((ok(await list(chief, FACTORY.mine)) as unknown[]).length).toBe(people.length)
    expect(ok(await list(chief, FACTORY.other))).toEqual([])
  })

  it('別廠的廠區管理員與一般使用者查不到；原本不限廠區的退路（plant_access_members）已經拿掉', async () => {
    expect((await list(otherOwner, FACTORY.mine)).error?.code).toBe('42501')
    expect((await list(owner, FACTORY.other)).error?.code).toBe('42501')
    const plain = await loginAs(EMP.listed, '王雅婷')
    expect((await list(plain, FACTORY.mine)).error?.code).toBe('42501')
    expect((await list(plain, FACTORY.other)).error?.code).toBe('42501')
    expect((await owner.rpc('plant_access_members', { p_factory_code: FACTORY.mine, p_term: '' })).error?.code).toBe('PGRST202')
  })

  it('廠區管理員看得到本廠流程上的人的姓名（visible_people），別廠的看不到', async () => {
    const names = async (client: SupabaseClient) =>
      (ok(await client.rpc('visible_people').in('emp_id', [EMP.listed])) as { emp_id: string }[]).map((p) => p.emp_id)
    expect(await names(owner)).toEqual([])
    ok(await assignRoute(owner, (await routeStepNamed(ID.small!, '廠區經理人')).id, EMP.listed))
    expect(await names(owner)).toEqual([EMP.listed])
    expect(await names(otherOwner)).toEqual([])
  })

  it('別廠的人被換上後，看得到並能填、送出本廠的那一關（沒有別的跨廠檢查）', async () => {
    const form = ID.mainForm!
    const finance = UNITS.finance
    ok(await assign(chief, (await stepNamed(form, `自行檢查人員－${finance}`)).id, EMP.listedOther, '別廠同仁'))
    expect(await admitted(EMP.listedOther)).toBe(true) // 自動放行不看廠區（Q116 (8)）

    const visitor = await loginAs(EMP.listedOther, '別廠同仁')
    expect(ok(await visitor.from('my_assessment').select('assessment_id,my_part'))).toContainEqual({ assessment_id: form, my_part: 'fill' })
    const point = (ok(await admin.from('assessment_control_point_unit').select('control_point_id')
      .eq('assessment_id', form).eq('assessing_unit_name', finance).single()) as { control_point_id: string }).control_point_id
    ok(await visitor.rpc('save_assessment_answers', {
      p_assessment_id: form, p_answers: [answerFor(point, finance)],
      p_conclusions: [{ assessing_unit_name: finance, conclusion: 'satisfied', exceptions: null }],
    }))
    expect(ok(await visitor.rpc('submit_assessment_step', { p_assessment_id: form }))).toMatchObject({ ok: true })
    expect((await stepNamed(form, `自行檢查人員－${finance}`)).state).toBe('done')
  })
})

describe('Q147 前發出、還有關卡待分派的舊自評表：稽核主管補分派', () => {
  beforeAll(async () => {
    // 原檔有「子公司擔當稽核」的範本，同一年度補發；發出後把那一關清成空的，當作 Q147 之前發出、還沒分派的樣子。
    ID.audited = await makeTemplate(`${RUN}U`, 'control_activity', FACTORY.mine, [['第一章', [['要點一', ID.sales!]]]])
    await makeRoute(ID.audited, ID.mine!, [
      { name: `自行檢查人員－${UNITS.sales}`, group: 'plant', signer: EMP.sales, unitId: ID.sales! },
      { name: '廠區經理人', group: 'plant', signer: EMP.plantManager, unitId: null },
      { name: '子公司擔當稽核', group: 'audit_review', signer: EMP.subsidiaryAuditor, unitId: null },
      { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
      { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
    ])
    ok(await chief.rpc('launch_annual_cycle', { p_year: YEAR, p_due_date: DUE, p_combos: [combo(ID.audited!)] }))
    ID.auditedForm = (ok(await admin.from('assessment').select('id').eq('template_id', ID.audited!).single()) as { id: string }).id
    await withSuperuser((sql) =>
      sql.query(`update public.assessment_step set signer_emp_id = null where assessment_id = $1 and name = '子公司擔當稽核'`, [ID.auditedForm]))
  })

  it('稽核主管的首頁待辦列出那幾張表與關卡；廠區管理員只剩流程的待辦', async () => {
    expect(await todoOf(chief)).toEqual([expect.objectContaining({
      kind: 'assessment', factory_code: FACTORY.mine, year: YEAR, forms: 1, steps: 1, pending: [expect.objectContaining({ template_code: `${RUN}U`, name: '子公司擔當稽核' })],
    })])
    expect((await todoOf(owner)).filter((r) => r.kind === 'assessment')).toEqual([])
  })

  it('廠區管理員不能補；稽核主管補上後被分派的人能登入，待辦消失', async () => {
    const audit = await stepNamed(ID.auditedForm!, '子公司擔當稽核')
    expect(audit).toMatchObject({ signer_emp_id: null, state: 'pending' })
    expect(await admitted(EMP.subsidiaryAuditor)).toBe(false)
    expect((await assign(owner, audit.id, EMP.subsidiaryAuditor)).error?.code).toBe('42501')
    ok(await assign(chief, audit.id, EMP.subsidiaryAuditor, '子公司稽核'))
    expect((await stepNamed(ID.auditedForm!, '子公司擔當稽核')).signer_emp_id).toBe(EMP.subsidiaryAuditor)
    expect(await admitted(EMP.subsidiaryAuditor)).toBe(true)
    expect(await todoOf(chief)).toEqual([])
    const log = (await logOf(EMP.subsidiaryAuditor)).filter((r) => r.action === 'step_assigned')
    expect(log).toEqual([expect.objectContaining({ actor_emp_id: EMP.chief, before: null })])
  })
})
