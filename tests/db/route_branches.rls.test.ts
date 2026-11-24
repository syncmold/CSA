// 簽核流程編輯器的分流與多一關（工單 #98，Q116 (2)(4)）。寫入都以稽核管理者的 CSA session 走 PostgREST，
// 和流程編輯頁一樣；service_role 只用來準備與清理。每次執行建立自己的公司、廠區、範本與五個自評單位，結束時全部清掉。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LaunchCheck } from '../../src/api/approvalRoutes'
import { launchAssigned, admin, insertControlPoint, insertRow, loginAs, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest } from './helpers'

const RUN = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A`, signer: `${RUN}B` }
const YEAR = 22000 + Math.floor(Math.random() * 1000)
const FACTORY = `${RUN}P`.toUpperCase()
const UNITS = { sales: `${RUN}業務`, material: `${RUN}資材`, quality: `${RUN}品保`, finance: `${RUN}財務`, works: `${RUN}工務` }
type UnitKey = keyof typeof UNITS

const ID = { company: '', plant: '', template: '', route: '' }
const UNIT_ID = {} as Record<UnitKey, string>
let boss: SupabaseClient
let signer: SupabaseClient

interface Step {
  id: string
  position: number
  name: string
  editable_unit_id: string | null
  branch_unit_id: string | null
}

const unit = (key: UnitKey) => ({ id: UNIT_ID[key], name: UNITS[key] })

async function steps(routeId: string) {
  return ok(await boss.from('route_step').select('id,position,name,editable_unit_id,branch_unit_id').eq('route_id', routeId).order('position')) as Step[]
}

async function check(routeId: string) {
  return (ok(await boss.from('approval_route').select('launch_check').eq('id', routeId).single()) as { launch_check: LaunchCheck })
    .launch_check
}

/** The 發起檢查 once every 關卡 still without a 簽核人 is 分派 on the route (Q147), the way a 廠區管理員 would before the launch. */
async function assignedCheck(routeId: string) {
  for (const s of (await check(routeId)).unassigned_steps) {
    ok(await boss.rpc('assign_route_signer', { p_route_step_id: s.id, p_emp_id: EMP.signer }))
  }
  return check(routeId)
}

function addBranch(routeId: string, key: UnitKey) {
  return boss.rpc('add_route_branch', { p_route_id: routeId, p_unit_id: UNIT_ID[key] })
}

function addMergeStep(routeId: string, name: string, group: 'plant' | 'audit_review', link: 'taipei_auditor' | 'audit_chief' | null = null) {
  return boss.rpc('insert_route_step', { p_route_id: routeId, p_name: name, p_step_group: group, p_signer_emp_id: group === 'plant' ? null : EMP.boss, p_link: link })
}

/** 稽核室覆核的兩個連動關卡（#189）：發起檢查要各一個。 */
async function addAuditSteps(routeId: string) {
  ok(await addMergeStep(routeId, '台北稽核人員', 'audit_review', 'taipei_auditor'))
  return addMergeStep(routeId, '稽核主管', 'audit_review', 'audit_chief')
}

/** 業務、資材、品保、財務各一條分流，匯流後廠區經理人與稽核主管。 */
async function fourBranchRoute(templateId: string) {
  const route = ok(await boss.from('approval_route').insert({ template_id: templateId, plant_id: ID.plant }).select('id').single()) as { id: string }
  ok(await addMergeStep(route.id, '廠區經理人', 'plant'))
  ok(await addAuditSteps(route.id))
  for (const key of ['sales', 'material', 'quality', 'finance'] as const) ok(await addBranch(route.id, key))
  return route.id
}

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.signer, '甲')
  await loginAs(EMP.boss, '丙')
  await promoteToAuditAdmin(EMP.boss)
  boss = await loginAs(EMP.boss, '丙')
  signer = await loginAs(EMP.signer, '甲')

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  for (const key of Object.keys(UNITS) as UnitKey[]) UNIT_ID[key] = (await insertRow('assessing_unit', { name: UNITS[key] })).id
  // 紙本順序：業務、資材在第一章，品保、財務在第二章（工務之後才加）
  ID.template = await makeTemplate(`${RUN}T`, 'control_activity', FACTORY, [
    ['報價作業', [['報價是否核准？', UNIT_ID.sales], ['備料是否確認？', UNIT_ID.material]]],
    ['交貨作業', [['出貨是否檢驗？', UNIT_ID.quality], ['應收是否入帳？', UNIT_ID.finance]]],
  ])
})

afterAll(async () => {
  ok(await admin.from('annual_cycle').delete().eq('year', YEAR))
  ok(await admin.from('approval_route').delete().eq('plant_id', ID.plant))
  ok(await admin.from('questionnaire_template').delete().like('code', `${RUN}%`))
  ok(await admin.from('plant').delete().eq('factory_code', FACTORY))
  ok(await admin.from('company').delete().eq('id', ID.company))
  ok(await admin.from('assessing_unit').delete().in('name', Object.values(UNITS)))
})

describe('分流與多一關', () => {
  it('builds one 分流 per unit before the 匯流後 steps, and lists the units in paper order', async () => {
    ID.route = await fourBranchRoute(ID.template)
    expect((await steps(ID.route)).map((s) => `${s.position}.${s.name}`)).toEqual([
      `1.自行檢查人員－${UNITS.sales}`, `2.部門主管－${UNITS.sales}`,
      `3.自行檢查人員－${UNITS.material}`, `4.部門主管－${UNITS.material}`,
      `5.自行檢查人員－${UNITS.quality}`, `6.部門主管－${UNITS.quality}`,
      `7.自行檢查人員－${UNITS.finance}`, `8.部門主管－${UNITS.finance}`,
      '9.廠區經理人', '10.台北稽核人員', '11.稽核主管',
    ])
    const route = ok(await boss.from('approval_route').select('branch_units').eq('id', ID.route).single()) as {
      branch_units: { id: string; name: string; in_template: boolean }[]
    }
    expect(route.branch_units).toEqual((['sales', 'material', 'quality', 'finance'] as const).map((k) => ({ ...unit(k), in_template: true })))
    expect((await assignedCheck(ID.route)).ready).toBe(true)
  })

  it('a 課長 added to 財務 makes the 財務 分流 three steps', async () => {
    const manager = (await steps(ID.route)).find((s) => s.name === `部門主管－${UNITS.finance}`)!
    ok(await boss.rpc('insert_route_step', {
      p_route_id: ID.route, p_name: '課長', p_step_group: 'plant', p_signer_emp_id: null,
      p_before_position: manager.position, p_branch_unit_id: UNIT_ID.finance,
    }))
    const finance = (await steps(ID.route)).filter((s) => s.branch_unit_id === UNIT_ID.finance).map((s) => s.name)
    expect(finance).toEqual([`自行檢查人員－${UNITS.finance}`, '課長', `部門主管－${UNITS.finance}`])
    expect((await assignedCheck(ID.route)).ready).toBe(true)
  })

  it('refuses a second 分流 for the same unit, and branch writes by anyone but a 稽核管理者', async () => {
    expect((await addBranch(ID.route, 'sales')).error).toMatchObject({ code: '23505', hint: 'branch_exists' })
    const byOther = await signer.rpc('add_route_branch', { p_route_id: ID.route, p_unit_id: UNIT_ID.works })
    expect(byOther.error?.code).toBe('42501')
  })

  it('reports a 分流 whose first step is not the 自行檢查人員', async () => {
    const tpl = await makeTemplate(`${RUN}F`, 'control_activity', FACTORY, [['報價作業', [['報價是否核准？', UNIT_ID.sales]]]])
    const route = ok(await boss.from('approval_route').insert({ template_id: tpl, plant_id: ID.plant }).select('id').single()) as { id: string }
    ok(await addAuditSteps(route.id))
    ok(await addBranch(route.id, 'sales'))
    ok(await boss.rpc('insert_route_step', {
      p_route_id: route.id, p_name: '課長', p_step_group: 'plant', p_signer_emp_id: null, p_before_position: 1, p_branch_unit_id: UNIT_ID.sales,
    }))
    expect(await check(route.id)).toMatchObject({ ready: false, branch_first_step_not_editable: [unit('sales')], missing_units: [] })
  })
})

describe('年度發起', () => {
  it('launches four 分流 (財務 with its 課長), all four units start at once and the 匯流 waits for them', async () => {
    expect((await assignedCheck(ID.route)).ready).toBe(true)

    const launched = ok(await launchAssigned(boss, {
      p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: ID.template, plant_id: ID.plant }],
    })) as { ok: boolean }
    expect(launched).toMatchObject({ ok: true, assessments: 1 })
    const assessment = ok(await boss.from('assessment')
      .select('id,assessment_step(position,name,branch_unit_name,state)')
      .eq('template_id', ID.template).single()) as { assessment_step: { position: number; name: string; branch_unit_name: string | null; state: string }[] }
    const issued = [...assessment.assessment_step].sort((a, b) => a.position - b.position)
    expect(issued.filter((s) => s.branch_unit_name === UNITS.finance).map((s) => s.name))
      .toEqual([`自行檢查人員－${UNITS.finance}`, '課長', `部門主管－${UNITS.finance}`])
    expect(issued.filter((s) => s.state === 'current').map((s) => s.branch_unit_name))
      .toEqual([UNITS.sales, UNITS.material, UNITS.quality, UNITS.finance])
    expect(issued.filter((s) => !s.branch_unit_name).map((s) => [s.name, s.state])).toEqual([['廠區經理人', 'pending'], ['台北稽核人員', 'pending'], ['稽核主管', 'pending']])
  })

  it('a route can lose a 分流 the template needs after the launch: the delete is saved and the 發起檢查 names the unit', async () => {
    ok(await boss.from('route_step').delete().eq('route_id', ID.route).eq('branch_unit_id', UNIT_ID.quality))
    expect((await steps(ID.route)).filter((s) => s.branch_unit_id === UNIT_ID.quality)).toEqual([])
    expect(await check(ID.route)).toMatchObject({ ready: false, missing_units: [unit('quality')] })
    // 已發出的自評表照舊有品保的分流
    const issued = ok(await boss.from('assessment').select('assessment_step(branch_unit_name)').eq('template_id', ID.template).single()) as {
      assessment_step: { branch_unit_name: string | null }[]
    }
    expect(issued.assessment_step.filter((s) => s.branch_unit_name === UNITS.quality)).toHaveLength(2)

    ok(await addBranch(ID.route, 'quality'))
    expect((await assignedCheck(ID.route)).ready).toBe(true)
  })
})

describe('範本後來新增了自評單位', () => {
  it('the check names the unit without a 分流, and the 年度發起 is refused until it has one', async () => {
    const tpl = await makeTemplate(`${RUN}N`, 'control_activity', FACTORY, [['報價作業', [['報價是否核准？', UNIT_ID.sales]]]])
    const route = ok(await boss.from('approval_route').insert({ template_id: tpl, plant_id: ID.plant }).select('id').single()) as { id: string }
    ok(await addAuditSteps(route.id))
    ok(await addBranch(route.id, 'sales'))
    expect((await assignedCheck(route.id)).ready).toBe(true)

    const section = ok(await admin.from('template_section').select('id').eq('template_id', tpl).single()) as { id: string }
    await insertControlPoint(section.id, 2, '設備是否保養？', UNIT_ID.works)
    expect(await check(route.id)).toMatchObject({ ready: false, missing_units: [unit('works')] })
    const route2 = ok(await boss.from('approval_route').select('branch_units').eq('id', route.id).single()) as { branch_units: { name: string }[] }
    expect(route2.branch_units.map((u) => u.name)).toEqual([UNITS.sales, UNITS.works])

    const refused = ok(await launchAssigned(boss, { p_year: YEAR + 1, p_due_date: '2099-12-31', p_combos: [{ template_id: tpl, plant_id: ID.plant }] }))
    expect(refused).toMatchObject({ ok: false, error: 'missing_route', missing: [{ problem: 'not_ready', launch_check: { missing_units: [unit('works')] } }] })

    ok(await addBranch(route.id, 'works'))
    expect((await assignedCheck(route.id)).ready).toBe(true)
  })

  it('shows a 分流 the template no longer uses, so it can be deleted', async () => {
    const tpl = await makeTemplate(`${RUN}U`, 'control_activity', FACTORY, [['報價作業', [['報價是否核准？', UNIT_ID.sales]]]])
    const route = ok(await boss.from('approval_route').insert({ template_id: tpl, plant_id: ID.plant }).select('id').single()) as { id: string }
    ok(await addAuditSteps(route.id))
    ok(await addBranch(route.id, 'sales'))
    ok(await addBranch(route.id, 'material'))
    const listed = ok(await boss.from('approval_route').select('branch_units').eq('id', route.id).single()) as { branch_units: { name: string; in_template: boolean }[] }
    expect(listed.branch_units.map((u) => [u.name, u.in_template])).toEqual([[UNITS.sales, true], [UNITS.material, false]])
    expect(await check(route.id)).toMatchObject({ ready: false, unused_units: [unit('material')] })

    ok(await boss.from('route_step').delete().eq('route_id', route.id).eq('branch_unit_id', UNIT_ID.material))
    expect((await steps(route.id)).map((s) => s.position)).toEqual([1, 2, 3, 4])
    expect((await assignedCheck(route.id)).ready).toBe(true)
  })
})
