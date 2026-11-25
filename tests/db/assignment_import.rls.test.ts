// 資料 API 接縫: 匯入分派表（工單 #180、#224；Q130、Q147 (6)）。can_assign_plant 是 CSA 後端擋 OMS 比對的依據（這一廠的廠區管理員
// 與稽核主管，發出前在流程上分派也看它）。發出後：import_assignment 逐格走 assign_step_signer，所以權限（只有稽核主管）、已簽不能換、
// 寫回流程、不記權限異動紀錄（Q149）都和逐格換人相同；剛簽的跳過，其他拒絕整批不寫。發出前（下次發出）：import_route_assignment
// 逐格走 assign_route_signer，這一廠的廠區管理員與稽核主管都能寫，有一格被拒就整批不寫。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, insertRow, loggedActions, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, promoteToSystemMaintainer, requirePostgrest, restClient } from './helpers'

const RUN = `I${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
const EMP = {
  chief: `${RUN}A`,
  maint: `${RUN}B`,
  /** 這一廠的廠區管理員 */
  owner: `${RUN}C`,
  /** 別廠的廠區管理員 */
  otherOwner: `${RUN}D`,
  sales: `${RUN}E`,
  salesManager: `${RUN}F`,
  finance: `${RUN}G`,
  replacement: `${RUN}H`,
  routeSelf: `${RUN}J`,
  routeManager: `${RUN}K`,
  routeChief: `${RUN}L`,
}
const FACTORY = { mine: `${RUN}P1`, other: `${RUN}P2` }
/** tests/db/helpers.ts 檔尾的年度區間表：27000 是這支。 */
const YEAR = 27000 + Math.floor(Math.random() * 900)
const UNITS = { sales: `${RUN}業務`, finance: `${RUN}財務` }
const ID: Record<string, string> = {}

let chief: SupabaseClient
let maint: SupabaseClient
let owner: SupabaseClient
let otherOwner: SupabaseClient

type Step = { id: string; name: string; signer_emp_id: string | null; state: string }
const steps = async () => ok(await admin.from('assessment_step').select('id,name,signer_emp_id,state').eq('assessment_id', ID.form!)) as Step[]
const stepNamed = async (name: string) => (await steps()).find((s) => s.name === name)!
const cell = (step: Step, empId: string) => ({ step_id: step.id, emp_id: empId })
const can = async (client: SupabaseClient, factoryCode: string) => ok(await client.rpc('can_assign_plant', { p_factory_code: factoryCode }))

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.chief, '甲')
  await promoteToAuditAdmin(EMP.chief)
  await loginAs(EMP.maint, '維護員')
  await promoteToSystemMaintainer(EMP.maint)
  ok(await admin.from('access_allowlist').insert([{ emp_id: EMP.chief }, { emp_id: EMP.maint }]))
  chief = await loginAs(EMP.chief, '甲')
  maint = await loginAs(EMP.maint, '維護員')
  owner = await loginAs(EMP.owner, '何欣怡')
  otherOwner = await loginAs(EMP.otherOwner, '別廠')

  ID.company = (await insertRow('company', { name: `${RUN}公司` })).id
  ID.mine = (await insertRow('plant', { factory_code: FACTORY.mine, name: `${RUN}一廠`, company_id: ID.company })).id
  ID.other = (await insertRow('plant', { factory_code: FACTORY.other, name: `${RUN}二廠`, company_id: ID.company })).id
  for (const [key, name] of Object.entries(UNITS)) ID[key] = (await insertRow('assessing_unit', { name })).id

  ID.template = await makeTemplate(`${RUN}M`, 'control_activity', FACTORY.mine, [['第一章', [['要點一', ID.sales!], ['要點二', ID.finance!]]]])
  ID.route = await makeRoute(ID.template, ID.mine!, [
    { name: `自行檢查人員－${UNITS.sales}`, group: 'plant', signer: EMP.sales, unitId: ID.sales! },
    { name: `部門主管－${UNITS.sales}`, group: 'plant', signer: EMP.salesManager, unitId: null, branchUnitId: ID.sales! },
    { name: `自行檢查人員－${UNITS.finance}`, group: 'plant', signer: EMP.finance, unitId: ID.finance! },
    { name: `部門主管－${UNITS.finance}`, group: 'plant', signer: EMP.salesManager, unitId: null, branchUnitId: ID.finance! },
    { name: '廠區經理人', group: 'plant', signer: EMP.salesManager, unitId: null },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
  ])
  ok(await chief.rpc('add_access_members', {
    p_people: [{ emp_id: EMP.owner, name: '何欣怡', factory_code: FACTORY.mine }, { emp_id: EMP.otherOwner, name: '別廠', factory_code: FACTORY.other }],
    p_role: 'signer', p_viewer_plant_ids: [], p_note: null,
  }))
  ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.mine, p_emp_id: EMP.owner }))
  ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.other, p_emp_id: EMP.otherOwner }))
  const launched = ok(await chief.rpc('launch_annual_cycle', {
    p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: ID.template, plant_id: ID.mine }],
  })) as { cycle_id: string }
  ID.form = (ok(await admin.from('assessment').select('id').eq('cycle_id', launched.cycle_id).single()) as { id: string }).id
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().eq('plant_id', ID.mine!)
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
  await admin.from('plant_coordinator').delete().in('plant_id', [ID.mine, ID.other].filter(Boolean))
  const listed = ok(await admin.from('access_allowlist').select('emp_id').like('emp_id', `${RUN}%`)) as { emp_id: string }[]
  for (const { emp_id } of listed) await admin.from('access_allowlist').delete().eq('emp_id', emp_id)
  await admin.from('plant').delete().in('factory_code', Object.values(FACTORY))
  await admin.from('assessing_unit').delete().in('name', Object.values(UNITS))
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
})

describe('can_assign_plant：誰能為這一廠要 OMS 比對', () => {
  it('這一廠的廠區管理員、稽核管理者、系統維護員可以；別廠的廠區管理員、一般簽核人不行', async () => {
    expect(await can(owner, FACTORY.mine)).toBe(true)
    expect(await can(owner, FACTORY.other)).toBe(false)
    expect(await can(otherOwner, FACTORY.mine)).toBe(false)
    expect(await can(chief, FACTORY.mine)).toBe(true)
    expect(await can(maint, FACTORY.other)).toBe(true)
    expect(await can(await loginAs(EMP.sales, '業務'), FACTORY.mine)).toBe(false)
  })

  it('沒有登入的人連問都不能問', async () => {
    expect((await restClient(async () => null).rpc('can_assign_plant', { p_factory_code: FACTORY.mine })).error?.code).toBe('42501')
  })
})

describe('import_assignment：確認匯入（發出後換人）', () => {
  it('稽核主管一次換好幾格，和逐格換人一樣寫回流程，不記權限異動紀錄（Q149）', async () => {
    const [manager, financeChief] = await Promise.all([stepNamed('廠區經理人'), stepNamed(`部門主管－${UNITS.finance}`)])
    expect(ok(await chief.rpc('import_assignment', { p_cells: [cell(manager, EMP.replacement), cell(financeChief, EMP.finance)] })))
      .toEqual({ written: 2, skipped: 0 })
    expect((await stepNamed('廠區經理人')).signer_emp_id).toBe(EMP.replacement)
    expect((await stepNamed(financeChief.name)).signer_emp_id).toBe(EMP.finance)
    expect(await loggedActions(EMP.replacement)).toEqual([])
    const route = ok(await admin.from('route_step').select('name,signer_emp_id,approval_route!inner(template_id)').eq('approval_route.template_id', ID.template!).eq('name', '廠區經理人').single())
    expect(route).toMatchObject({ signer_emp_id: EMP.replacement })
  })

  it('預覽之後才簽的關卡跳過並計數，其餘照寫', async () => {
    const point = (ok(await admin.from('assessment_control_point_unit').select('control_point_id')
      .eq('assessment_id', ID.form!).eq('assessing_unit_name', UNITS.sales).single()) as { control_point_id: string }).control_point_id
    const sales = await loginAs(EMP.sales, '業務')
    ok(await sales.rpc('save_assessment_answers', {
      p_assessment_id: ID.form, p_answers: [{ control_point_id: point, assessing_unit_name: UNITS.sales, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
      p_conclusions: [{ assessing_unit_name: UNITS.sales, conclusion: 'satisfied', exceptions: null }],
    }))
    ok(await sales.rpc('submit_assessment_step', { p_assessment_id: ID.form }))
    const signed = await stepNamed(`自行檢查人員－${UNITS.sales}`)
    expect(signed.state).toBe('done')

    const finance = await stepNamed(`自行檢查人員－${UNITS.finance}`)
    expect(ok(await chief.rpc('import_assignment', { p_cells: [cell(signed, EMP.replacement), cell(finance, EMP.replacement)] }))).toEqual({ written: 1, skipped: 1 })
    expect((await stepNamed(signed.name)).signer_emp_id).toBe(EMP.sales)
    expect((await stepNamed(finance.name)).signer_emp_id).toBe(EMP.replacement)
  })

  it('廠區管理員（本廠的也一樣，Q147）、別廠的廠區管理員被拒絕；有一格不能寫（連動關卡）就整批不寫', async () => {
    const financeChief = await stepNamed(`部門主管－${UNITS.finance}`)
    expect((await owner.rpc('import_assignment', { p_cells: [cell(financeChief, EMP.salesManager)] })).error?.code).toBe('42501')
    expect((await otherOwner.rpc('import_assignment', { p_cells: [cell(financeChief, EMP.salesManager)] })).error?.code).toBe('42501')
    const audit = await stepNamed('稽核主管')
    const refused = await chief.rpc('import_assignment', { p_cells: [cell(financeChief, EMP.salesManager), cell(audit, EMP.replacement)] })
    expect(refused.error).toMatchObject({ code: '23514', hint: 'linked_step' })
    expect((await stepNamed(financeChief.name)).signer_emp_id).toBe(EMP.finance)
    expect((await restClient(async () => null).rpc('import_assignment', { p_cells: [] })).error?.code).toBe('42501')
  })

  it('系統維護員也能匯入（Q129）', async () => {
    const financeChief = await stepNamed(`部門主管－${UNITS.finance}`)
    expect(ok(await maint.rpc('import_assignment', { p_cells: [cell(financeChief, EMP.salesManager)] }))).toEqual({ written: 1, skipped: 0 })
    expect((await stepNamed(financeChief.name)).signer_emp_id).toBe(EMP.salesManager)
  })
})

describe('import_route_assignment：確認匯入到簽核流程（下次發出，發出前，Q147 (6)）', () => {
  type RouteStep = { id: string; name: string; signer_emp_id: string | null }
  const routeStep = async (name: string) =>
    (ok(await admin.from('route_step').select('id,name,signer_emp_id').eq('route_id', ID.route!)) as RouteStep[]).find((s) => s.name === name)!
  const routeCell = (step: RouteStep, empId: string) => ({ route_step_id: step.id, emp_id: empId })
  it('這一廠的廠區管理員一次寫好幾關到流程，不記權限異動紀錄（Q149）；已發出的自評表不動', async () => {
    const [selfCheck, manager] = await Promise.all([routeStep(`自行檢查人員－${UNITS.finance}`), routeStep('廠區經理人')])
    const formBefore = await stepNamed('廠區經理人')
    expect(ok(await owner.rpc('import_route_assignment', { p_cells: [routeCell(selfCheck, EMP.routeSelf), routeCell(manager, EMP.routeManager)] })))
      .toEqual({ written: 2 })
    expect((await routeStep(selfCheck.name)).signer_emp_id).toBe(EMP.routeSelf)
    expect((await routeStep('廠區經理人')).signer_emp_id).toBe(EMP.routeManager)
    // 已發出的自評表照舊：流程上的人下次發出才照抄（發出後換人只有稽核主管，上面那一節）。
    expect((await stepNamed('廠區經理人')).signer_emp_id).toBe(formBefore.signer_emp_id)
    expect(await loggedActions(EMP.routeSelf)).toEqual([])
    expect(await loggedActions(EMP.routeManager)).toEqual([])
  })

  it('稽核主管、系統維護員也能匯入', async () => {
    const chiefStep = await routeStep(`部門主管－${UNITS.sales}`)
    expect(ok(await chief.rpc('import_route_assignment', { p_cells: [routeCell(chiefStep, EMP.routeChief)] }))).toEqual({ written: 1 })
    expect(ok(await maint.rpc('import_route_assignment', { p_cells: [routeCell(chiefStep, EMP.routeChief)] }))).toEqual({ written: 1 })
    expect((await routeStep(chiefStep.name)).signer_emp_id).toBe(EMP.routeChief)
    expect(await loggedActions(EMP.routeChief)).toEqual([])
  })

  it('別廠的廠區管理員、一般簽核人、沒登入的人被拒絕；有一格不能寫（連動關卡、空白）就整批不寫', async () => {
    const [sales, manager, audit] = await Promise.all([routeStep(`自行檢查人員－${UNITS.sales}`), routeStep('廠區經理人'), routeStep('稽核主管')])
    const cells = [routeCell(sales, EMP.replacement)]
    expect((await otherOwner.rpc('import_route_assignment', { p_cells: cells })).error?.code).toBe('42501')
    expect((await (await loginAs(EMP.sales, '業務')).rpc('import_route_assignment', { p_cells: cells })).error?.code).toBe('42501')
    expect((await restClient(async () => null).rpc('import_route_assignment', { p_cells: [] })).error?.code).toBe('42501')

    const linked = await owner.rpc('import_route_assignment', { p_cells: [...cells, routeCell(audit, EMP.replacement)] })
    expect(linked.error).toMatchObject({ code: '23514', hint: 'linked_step' })
    const blank = await owner.rpc('import_route_assignment', { p_cells: [...cells, routeCell(manager, ' ')] })
    expect(blank.error).toMatchObject({ code: '23514', hint: 'signer_required' })
    expect((await routeStep(sales.name)).signer_emp_id).toBe(EMP.sales)
    expect((await routeStep('廠區經理人')).signer_emp_id).toBe(EMP.routeManager)
    expect((await owner.rpc('import_route_assignment', { p_cells: {} })).error?.code).toBe('22023')
  })
})
