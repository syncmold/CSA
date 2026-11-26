// 資料 API 接縫: 廠區負責人（工單 #100、Q116 (5)，暫定 OPEN-6）——稽核管理者在權限管理按廠區指定一位，
// 他唯讀看得到本廠所有自評表與答案；指定、更換、移除都進權限異動紀錄。
// 每次執行用自己的工號（RUN 開頭），結束時移出放行名單；權限異動紀錄只新增、刪不掉，所以留著。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readAssessmentPdfSource } from '../../src/api/assessmentPdfQuery'
import { selectTracking } from '../../src/api/trackingQuery'
import { launchAssigned, admin, insertRow, loginAs, linkedAuditSteps, makeRoute, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest, restClient, withSuperuser, loginAsMaintainer } from './helpers'

const RUN = `C${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
const EMP = {
  chief: `${RUN}A`,
  /** 何欣怡：第一位廠區負責人 */
  owner: `${RUN}B`,
  /** 接任的人 */
  next: `${RUN}C`,
  viewer: `${RUN}D`,
  checker: `${RUN}E`,
  manager: `${RUN}F`,
  unlisted: `${RUN}G`,
  /** 分流的那張自評表的廠區負責人 */
  branchOwner: `${RUN}H`,
}
const FACTORY = { 1: `${RUN}P1`, 2: `${RUN}P2`, 3: `${RUN}P3` } as const
/** tests/db/helpers.ts 檔尾的年度區間表：21000 是這支。 */
const YEAR = 21000 + Math.floor(Math.random() * 900) // 會用到 YEAR 與 YEAR + 1
const UNIT = `${RUN}資材`
const UNIT2 = `${RUN}品保`
const ID: Record<string, string> = {}
/** 自評表 id，依廠區 1／2 */
const ASSESSMENT: Record<1 | 2, string> = { 1: '', 2: '' }
const NO_PLANT = '00000000-0000-4000-8000-000000000000'

const person = (empId: string, name: string) => ({ emp_id: empId, name, factory_code: FACTORY[1] })
const chiefClient = () => loginAs(EMP.chief, '甲')
/** 系統維護員：只有他能放行人員、移出名單（Q150）；稽核主管只指定、更換、卸任廠區負責人 */
const MAINT = `${RUN}MT`
const maintClient = () => loginAs(MAINT, '維護員')

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.chief, '甲')
  await promoteToAuditAdmin(EMP.chief)
  ok(await admin.from('access_allowlist').insert({ emp_id: EMP.chief }))
  for (const [who, name] of [[EMP.checker, '乙'], [EMP.manager, '丙']] as const) await loginAs(who, name)
  const maint = await loginAsMaintainer(MAINT, '維護員')

  ID.company = (await insertRow('company', { name: `${RUN}公司` })).id
  ID.plant1 = (await insertRow('plant', { factory_code: FACTORY[1], name: `${RUN}一廠`, company_id: ID.company })).id
  ID.plant2 = (await insertRow('plant', { factory_code: FACTORY[2], name: `${RUN}二廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
  ID.template = await makeTemplate(`${RUN}t`, 'control_activity', FACTORY[1], [['第一章', [['p1', ID.unit]]]])
  await insertRow('template_plant', { template_id: ID.template, factory_code: FACTORY[2] })
  for (const plant of [ID.plant1, ID.plant2]) {
    await makeRoute(ID.template!, plant!, [
      { name: '自行檢查人員－資材', group: 'plant', signer: EMP.checker, unitId: ID.unit },
      { name: '部門主管－資材', group: 'plant', signer: EMP.manager, unitId: null },
      ...linkedAuditSteps(EMP.chief),
    ])
  }
  const chief = await chiefClient()
  const launched = await launchAssigned(chief, {
    p_year: YEAR, p_due_date: '2099-12-31',
    p_combos: [{ template_id: ID.template, plant_id: ID.plant1 }, { template_id: ID.template, plant_id: ID.plant2 }],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  for (const r of ok(await admin.from('assessment').select('id,plant_id').eq('cycle_id', launched.data.cycle_id)) as { id: string; plant_id: string }[]) {
    ASSESSMENT[r.plant_id === ID.plant1 ? 1 : 2] = r.id
  }

  // 自行檢查人員先存一筆答案，廠區負責人要讀得到。
  const checker = await loginAs(EMP.checker, '乙')
  const point = ok(await admin.from('assessment_control_point').select('id').eq('assessment_id', ASSESSMENT[1]).single()) as { id: string }
  ID.point1 = point.id
  ok(await checker.rpc('save_assessment_answers', {
    p_assessment_id: ASSESSMENT[1],
    p_answers: [{ control_point_id: point.id, assessing_unit_name: UNIT, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
    p_conclusions: [],
  }))

  ok(await maint.rpc('add_access_members', {
    p_people: [person(EMP.owner, '何欣怡'), person(EMP.next, '接任者')], p_role: 'signer', p_viewer_plant_ids: [], p_note: null,
  }))
  ok(await maint.rpc('add_access_members', { p_people: [person(EMP.viewer, '檢視者')], p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: null }))
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().in('year', [YEAR, YEAR + 1])
  for (const p of [ID.plant1, ID.plant2, ID.plant3]) if (p) await admin.from('approval_route').delete().eq('plant_id', p)
  for (const t of [ID.template, ID.template3]) if (t) await admin.from('questionnaire_template').delete().eq('id', t)
  // One at a time: the database keeps at least one 稽核管理者 on the list, which may be this run's own (then it stays).
  const listed = ok(await admin.from('access_allowlist').select('emp_id').like('emp_id', `${RUN}%`)) as { emp_id: string }[]
  for (const { emp_id } of listed) await admin.from('access_allowlist').delete().eq('emp_id', emp_id)
  await admin.from('plant').delete().in('factory_code', Object.values(FACTORY))
  await admin.from('assessing_unit').delete().in('name', [UNIT, UNIT2])
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
})

interface LogRow {
  actor_emp_id: string | null
  target_emp_id: string
  target_name: string | null
  action: string
  before: unknown
  after: unknown
}
const COORDINATOR_ACTIONS = ['coordinator_assigned', 'coordinator_replaced', 'coordinator_removed']
async function logOf(...targets: string[]): Promise<LogRow[]> {
  const chief = await chiefClient()
  return ok(await chief.from('access_change_log').select('actor_emp_id,target_emp_id,target_name,action,before,after')
    .in('target_emp_id', targets).in('action', COORDINATOR_ACTIONS).order('id')) as LogRow[]
}
const coordinatorOf = async (plantId: string) =>
  ((ok(await admin.from('plant_coordinator').select('emp_id').eq('plant_id', plantId)) as { emp_id: string }[])[0]?.emp_id ?? null)

describe('指定', () => {
  it('refuses anyone but a 稽核管理者 (42501), and nobody writes the table directly', async () => {
    const signer = await loginAs(EMP.checker, '乙')
    expect((await signer.rpc('set_plant_coordinator', { p_plant_id: ID.plant1, p_emp_id: EMP.checker })).error?.code).toBe('42501')
    expect((await signer.rpc('remove_plant_coordinator', { p_plant_id: ID.plant1 })).error?.code).toBe('42501')
    const chief = await chiefClient()
    expect((await chief.from('plant_coordinator').insert({ plant_id: ID.plant1, emp_id: EMP.owner })).error?.code).toBe('42501')
    expect((await restClient(async () => null).from('plant_coordinator').select('plant_id')).error?.code).toBe('42501')
    expect(await coordinatorOf(ID.plant1!)).toBeNull()
  })

  it('only takes someone on the 放行名單 (P0002), for a plant in the plant master (23503, as 檢視廠區)', async () => {
    const chief = await chiefClient()
    expect((await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant1, p_emp_id: EMP.unlisted })).error?.code).toBe('P0002')
    expect((await chief.rpc('set_plant_coordinator', { p_plant_id: NO_PLANT, p_emp_id: EMP.owner })).error?.code).toBe('23503')
  })

  it('a 稽核管理者 makes 何欣怡 the 廠區負責人 of plant 1: she reads its 自評表 and answers, not plant 2', async () => {
    const chief = await chiefClient()
    const owner = await loginAs(EMP.owner, '何欣怡')
    expect(await readAssessmentPdfSource(owner, ASSESSMENT[1])).toBeNull()

    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant1, p_emp_id: ` ${EMP.owner.toLowerCase()}` }))
    expect(await coordinatorOf(ID.plant1!)).toBe(EMP.owner)

    const own = await readAssessmentPdfSource(owner, ASSESSMENT[1])
    expect(own?.assessment.id).toBe(ASSESSMENT[1])
    expect(ok(await owner.from('assessment_answer').select('control_point_id,execution').eq('assessment_id', ASSESSMENT[1])))
      .toEqual([{ control_point_id: ID.point1, execution: 'yes' }])
    expect(await readAssessmentPdfSource(owner, ASSESSMENT[2])).toBeNull()
    // Being the 廠區負責人 is not a 稽核角色: still a 簽核人, and 追蹤總覽 stays the 稽核管理者's and 檢視者's.
    expect(ok(await owner.from('employee_ref').select('audit_role').eq('emp_id', EMP.owner).single())).toEqual({ audit_role: 'signer' })
    // She reads her own assignment (for the menu); others' stay hidden.
    expect(ok(await owner.from('plant_coordinator').select('plant_id,emp_id'))).toEqual([{ plant_id: ID.plant1, emp_id: EMP.owner }])
    expect(ok(await (await loginAs(EMP.checker, '乙')).from('plant_coordinator').select('plant_id'))).toEqual([])
  })

  it('reads only: she cannot answer, submit, approve or return', async () => {
    const owner = await loginAs(EMP.owner, '何欣怡')
    const saved = await owner.rpc('save_assessment_answers', {
      p_assessment_id: ASSESSMENT[1],
      p_answers: [{ control_point_id: ID.point1, assessing_unit_name: UNIT, design: 'has_rule', execution: 'no', satisfaction: 'satisfied', improvement: null }],
      p_conclusions: [],
    })
    expect(saved.error?.code).toBe('42501')
    expect((await owner.rpc('submit_assessment_step', { p_assessment_id: ASSESSMENT[1] })).error?.code).toBe('42501')
    expect((await owner.rpc('approve_assessment_step', { p_assessment_id: ASSESSMENT[1], p_comment: null })).error?.code).toBe('42501')
    expect((await owner.rpc('return_assessment', { p_assessment_id: ASSESSMENT[1], p_to_position: 1, p_reason: 'x' })).error?.code).toBe('42501')
    expect(ok(await admin.from('assessment').select('current_step_position').eq('id', ASSESSMENT[1]).single())).toEqual({ current_step_position: 1 })
  })

  it('發出前分派要看流程：她讀得到本廠的流程與關卡、分派得了（Q147）；發出後不能換人，別廠的流程讀不到', async () => {
    const owner = await loginAs(EMP.owner, '何欣怡')
    const steps = ok(await owner.from('route_step').select('id,name,approval_route!inner(plant_id)').eq('approval_route.plant_id', ID.plant1!)) as { id: string; name: string }[]
    expect(steps.map((s) => s.name).sort()).toEqual(['台北稽核人員', '稽核主管', '自行檢查人員－資材', '部門主管－資材'].sort())
    expect(ok(await owner.from('route_step').select('id,approval_route!inner(plant_id)').eq('approval_route.plant_id', ID.plant2!))).toEqual([])
    const manager = steps.find((s) => s.name === '部門主管－資材')!
    ok(await owner.rpc('assign_route_signer', { p_route_step_id: manager.id, p_emp_id: EMP.manager }))
    const issued = ok(await admin.from('assessment_step').select('id').eq('assessment_id', ASSESSMENT[1]).eq('name', '部門主管－資材').single()) as { id: string }
    expect((await owner.rpc('assign_step_signer', { p_step_id: issued.id, p_emp_id: EMP.checker })).error?.code).toBe('42501')
  })

  it('naming someone else for the plant replaces her: she no longer sees it, and the log has both', async () => {
    const chief = await chiefClient()
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant1, p_emp_id: EMP.next }))
    // Naming the same person again changes nothing and logs nothing.
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant1, p_emp_id: EMP.next }))
    expect(await coordinatorOf(ID.plant1!)).toBe(EMP.next)

    expect(await readAssessmentPdfSource(await loginAs(EMP.owner, '何欣怡'), ASSESSMENT[1])).toBeNull()
    expect((await readAssessmentPdfSource(await loginAs(EMP.next, '接任者'), ASSESSMENT[1]))?.assessment.id).toBe(ASSESSMENT[1])
    // 流程也跟著換人看（Q147）。
    const routesOf = async (who: string, name: string) =>
      ok(await (await loginAs(who, name)).from('approval_route').select('id').eq('plant_id', ID.plant1!)) as unknown[]
    expect(await routesOf(EMP.owner, '何欣怡')).toEqual([])
    expect(await routesOf(EMP.next, '接任者')).toHaveLength(1)

    expect(await logOf(EMP.owner, EMP.next)).toEqual([
      { actor_emp_id: EMP.chief, target_emp_id: EMP.owner, target_name: '何欣怡', action: 'coordinator_assigned',
        before: null, after: { plant: FACTORY[1] } },
      { actor_emp_id: EMP.chief, target_emp_id: EMP.next, target_name: '接任者', action: 'coordinator_replaced',
        before: { plant: FACTORY[1], emp_id: EMP.owner, name: '何欣怡' }, after: { plant: FACTORY[1] } },
    ])
  })

  it('one person may be the 廠區負責人 of more than one plant', async () => {
    const chief = await chiefClient()
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant2, p_emp_id: EMP.next }))
    const next = await loginAs(EMP.next, '接任者')
    expect((await readAssessmentPdfSource(next, ASSESSMENT[2]))?.assessment.id).toBe(ASSESSMENT[2])
    ok(await chief.rpc('remove_plant_coordinator', { p_plant_id: ID.plant2 }))
  })
})

describe('移除', () => {
  it('removing the 廠區負責人 leaves the plant without one, logged; removing again is P0002', async () => {
    const chief = await chiefClient()
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant2, p_emp_id: EMP.owner }))
    ok(await chief.rpc('remove_plant_coordinator', { p_plant_id: ID.plant2 }))
    expect(await coordinatorOf(ID.plant2!)).toBeNull()
    expect(await readAssessmentPdfSource(await loginAs(EMP.owner, '何欣怡'), ASSESSMENT[2])).toBeNull()
    expect((await logOf(EMP.owner)).slice(-1)).toEqual([
      { actor_emp_id: EMP.chief, target_emp_id: EMP.owner, target_name: '何欣怡', action: 'coordinator_removed',
        before: { plant: FACTORY[2] }, after: null },
    ])
    expect((await chief.rpc('remove_plant_coordinator', { p_plant_id: ID.plant2 })).error?.code).toBe('P0002')
  })

  it('taking someone off the 放行名單 also ends their 廠區負責人, logged', async () => {
    const chief = await chiefClient()
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant2, p_emp_id: EMP.owner }))
    ok(await (await maintClient()).rpc('remove_access_member', { p_emp_id: EMP.owner }))
    expect(await coordinatorOf(ID.plant2!)).toBeNull()
    expect((await logOf(EMP.owner)).slice(-1).map((r) => [r.action, r.before])).toEqual([['coordinator_removed', { plant: FACTORY[2] }]])
  })

  it('a plant that still has a 廠區負責人 cannot be deleted from the master (23503), so 卸任 always names it', async () => {
    const chief = await chiefClient()
    const bare = (await insertRow('plant', { factory_code: `${RUN}P3`, name: `${RUN}三廠`, company_id: ID.company })).id
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: bare, p_emp_id: EMP.next }))
    expect((await admin.from('plant').delete().eq('id', bare)).error?.code).toBe('23503')
    ok(await chief.rpc('remove_plant_coordinator', { p_plant_id: bare }))
    ok(await admin.from('plant').delete().eq('id', bare))
    expect((await logOf(EMP.next)).slice(-1).map((r) => r.before)).toEqual([{ plant: `${RUN}P3` }])
  })

  it('nothing skips the log: no truncate, even for the 部署指令', async () => {
    const code = await withSuperuser((sql) => sql.query('truncate public.plant_coordinator').then(() => null, (e: { code?: string }) => e.code))
    expect(code).toBe('42501')
  })
})

describe('檢視者', () => {
  it('a 檢視者 named 廠區負責人 of another plant keeps their 檢視廠區 and sees both', async () => {
    const chief = await chiefClient()
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant2, p_emp_id: EMP.viewer }))
    expect(ok(await chief.from('access_member').select('audit_role,viewer_plant_ids').eq('emp_id', EMP.viewer).single()))
      .toEqual({ audit_role: 'viewer', viewer_plant_ids: [ID.plant1] })
    const viewer = await loginAs(EMP.viewer, '檢視者')
    expect((await readAssessmentPdfSource(viewer, ASSESSMENT[1]))?.assessment.id).toBe(ASSESSMENT[1])
    expect((await readAssessmentPdfSource(viewer, ASSESSMENT[2]))?.assessment.id).toBe(ASSESSMENT[2])

    ok(await chief.rpc('remove_plant_coordinator', { p_plant_id: ID.plant2 }))
    expect(ok(await chief.from('access_member').select('viewer_plant_ids').eq('emp_id', EMP.viewer).single()))
      .toEqual({ viewer_plant_ids: [ID.plant1] })
    expect(await readAssessmentPdfSource(viewer, ASSESSMENT[2])).toBeNull()
  })
})

describe('追蹤總覽（Q117 (3)）', () => {
  it('a 廠區負責人 sees only the plants they run, with the current signer’s name; a plain 簽核人 sees none', async () => {
    const next = await loginAs(EMP.next, '接任者')
    const rows = ok(await selectTracking(next, YEAR))
    expect(rows.map((r) => [r.factory_code, r.current_signer_emp_id, r.current_signer_name])).toEqual([[FACTORY[1], EMP.checker, '乙']])
    expect(ok(await selectTracking(await loginAs(EMP.checker, '乙'), YEAR))).toEqual([])
  })
})

describe('在編輯對話框改負責廠區（只送有變的廠區）', () => {
  const coordinatorPlants = async () =>
    [...(ok(await (await chiefClient()).from('access_member').select('coordinator_plant_ids').eq('emp_id', EMP.viewer).single()) as
      { coordinator_plant_ids: string[] }).coordinator_plant_ids].sort()
  const update = async (changes?: { assign?: string[]; unassign?: string[] }) =>
    (await chiefClient()).rpc('update_access_member', {
      p_emp_id: EMP.viewer, p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: null,
      ...(changes ? { p_coordinator_assign: changes.assign ?? [], p_coordinator_unassign: changes.unassign ?? [] } : {}),
    })

  it('assigns the plants added in the dialog, replacing whoever ran them, and keeps one handed to them meanwhile', async () => {
    // 另一位稽核管理者在對話框開著時，從廠區方格把二廠指定給他。
    ok(await (await chiefClient()).rpc('set_plant_coordinator', { p_plant_id: ID.plant2, p_emp_id: EMP.viewer }))
    ok(await update({ assign: [ID.plant1!] }))
    expect(await coordinatorPlants()).toEqual([ID.plant1, ID.plant2].sort())
    expect(await coordinatorOf(ID.plant1!)).toBe(EMP.viewer)
    expect((await logOf(EMP.viewer)).slice(-2).map((r) => [r.action, r.before])).toEqual([
      ['coordinator_assigned', null],
      ['coordinator_replaced', { plant: FACTORY[1], emp_id: EMP.next, name: '接任者' }],
    ])
  })

  it('leaves them as they are when the page sends no change', async () => {
    ok(await update())
    expect(await coordinatorPlants()).toEqual([ID.plant1, ID.plant2].sort())
  })

  it('ends only the plants taken off in the dialog, not one someone else took over meanwhile', async () => {
    // 另一位稽核管理者在這之間把二廠換給接任者；這邊的對話框還以為二廠是他的。
    ok(await (await chiefClient()).rpc('set_plant_coordinator', { p_plant_id: ID.plant2, p_emp_id: EMP.next }))
    ok(await update({ unassign: [ID.plant1!, ID.plant2!] }))
    expect(await coordinatorPlants()).toEqual([])
    expect(await coordinatorOf(ID.plant2!)).toBe(EMP.next)
    expect((await logOf(EMP.viewer)).slice(-1).map((r) => [r.action, r.before])).toEqual([['coordinator_removed', { plant: FACTORY[1] }]])
  })

  it('an unknown plant is 23503', async () => {
    expect((await update({ assign: [NO_PLANT] })).error?.code).toBe('23503')
  })
})

describe('分流（#97，Q116 (9)）', () => {
  /** 資材與品保兩條分流同時作答，都還沒送出；匯流後是廠區經理人。 */
  let assessment = ''

  beforeAll(async () => {
    ID.plant3 = (await insertRow('plant', { factory_code: FACTORY[3], name: `${RUN}三廠`, company_id: ID.company })).id
    ID.unit2 = (await insertRow('assessing_unit', { name: UNIT2 })).id
    ID.template3 = await makeTemplate(`${RUN}t3`, 'control_activity', FACTORY[3], [['第一章', [['p-資材', ID.unit!], ['p-品保', ID.unit2!]]]])
    await makeRoute(ID.template3!, ID.plant3!, [
      { name: '自行檢查人員－資材', group: 'plant', signer: EMP.checker, unitId: ID.unit!, branchUnitId: ID.unit! },
      { name: '自行檢查人員－品保', group: 'plant', signer: EMP.manager, unitId: ID.unit2!, branchUnitId: ID.unit2! },
      { name: '廠區經理人', group: 'plant', signer: EMP.chief, unitId: null, branchUnitId: null },
      ...linkedAuditSteps(EMP.chief),
    ])
    const chief = await chiefClient()
    const launched = await launchAssigned(chief, {
      p_year: YEAR + 1, p_due_date: '2099-12-31', p_combos: [{ template_id: ID.template3, plant_id: ID.plant3 }],
    })
    if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
    assessment = ok(await admin.from('assessment').select('id').eq('cycle_id', launched.data.cycle_id).single()).id as string
    const points = ok(await admin.from('assessment_control_point_unit').select('control_point_id,assessing_unit_name').eq('assessment_id', assessment)) as
      { control_point_id: string; assessing_unit_name: string }[]
    for (const [who, name, unit] of [[EMP.checker, '乙', UNIT], [EMP.manager, '丙', UNIT2]] as const) {
      const point = points.find((p) => p.assessing_unit_name === unit)!
      ok(await (await loginAs(who, name)).rpc('save_assessment_answers', {
        p_assessment_id: assessment,
        p_answers: [{ control_point_id: point.control_point_id, assessing_unit_name: unit, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
        p_conclusions: [{ assessing_unit_name: unit, conclusion: 'satisfied' }],
      }))
    }
    ok(await (await maintClient()).rpc('add_access_members', { p_people: [person(EMP.branchOwner, '三廠負責人')], p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant3, p_emp_id: EMP.branchOwner }))
  })

  /** 這個人讀得到哪幾個單位的答案與整體結論。 */
  async function visibleUnits(who: string, name: string) {
    const client = await loginAs(who, name)
    const answers = ok(await client.from('assessment_answer').select('assessing_unit_name').eq('assessment_id', assessment)) as { assessing_unit_name: string }[]
    const conclusions = ok(await client.from('assessment_conclusion').select('assessing_unit_name').eq('assessment_id', assessment)) as { assessing_unit_name: string }[]
    return [answers.map((r) => r.assessing_unit_name).sort(), conclusions.map((r) => r.assessing_unit_name).sort()]
  }

  it('the 廠區負責人 reads every unit’s answers before any unit submits, like a 檢視者; a unit’s 自行檢查人員 reads only their own', async () => {
    const both = [UNIT, UNIT2].sort()
    expect(await visibleUnits(EMP.branchOwner, '三廠負責人')).toEqual([both, both])
    expect(await visibleUnits(EMP.manager, '丙')).toEqual([[UNIT2], [UNIT2]])
  })
})
