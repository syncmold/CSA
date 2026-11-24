// 資料 API 接縫: 流程編輯器與發起檢查（工單 #11）。所有寫入都以稽核主管的 CSA session 走 PostgREST，
// 不用 service_role，因為要驗的正是 API 開給誰、擋下什麼。service_role 只用來準備與清理。
// 每次執行建立自己的公司、廠區與範本（只適用這個廠區），結束時全部清掉；每個範本 × 廠區只有一條流程（Q137 (6)），
// 要另一條流程的測試各用一份新範本（anotherTemplate）。自評單位用範本 02 種子建立的三個真實單位，
// 只讀不改，所以訊息裡看得到「品保單位」。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import type { LaunchCheck, NewStepInput as StepInput } from '../../src/api/approvalRoutes'
import { launchAssigned, admin, insertControlPoint, insertRow, loginAs, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest } from './helpers'

// 資料庫測試檔案並行執行：前綴與隨機尾巴避免和其他檔案的工號、年度撞在一起。
const RUN = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A`, signer: `${RUN}B`, other: `${RUN}C` }
const YEAR = 6000 + Math.floor(Math.random() * 1000)
const DUE = '2099-12-31'
const FACTORY = `${RUN}P`.toUpperCase()
const UNITS = ['資材單位', '品保單位', '財會單位'] as const
/** 這個檔案自己建、結束時刪掉的自評單位（範本後來才用到的單位、範本沒用到的單位）。 */
const OWN_UNITS = { later: `${RUN}稽核單位`, extra: `${RUN}人資單位` }

type Unit = (typeof UNITS)[number]

const ID = { company: '', plant: '', template: '', route: '', assessment: '', later: '', extra: '' }
const UNIT_ID = {} as Record<Unit, string>
let boss: SupabaseClient
let signer: SupabaseClient

/** 通過的發起檢查。 */
const READY: LaunchCheck = {
  ready: true, no_steps: false, no_merge_steps: false, missing_units: [], unused_units: [], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [],
}

const selfCheck = (unit: Unit): StepInput => ({
  name: `自行檢查人員－${unit}`, step_group: 'plant', signer_emp_id: EMP.signer, editable_unit_id: UNIT_ID[unit],
})
const manager: StepInput = { name: '部門主管', step_group: 'plant', signer_emp_id: EMP.signer, editable_unit_id: null }
const auditChief: StepInput = { name: '稽核主管', step_group: 'audit_review', signer_emp_id: EMP.boss, editable_unit_id: null, link: 'audit_chief' }
const taipeiAuditor: StepInput = { name: '台北稽核人員', step_group: 'audit_review', signer_emp_id: EMP.boss, editable_unit_id: null, link: 'taipei_auditor' }
/** 稽核室覆核的兩個連動關卡（#189）：發起檢查要各一個。 */
const audit = [taipeiAuditor, auditChief]
/** 沒有標記的稽核室關卡（像子公司擔當稽核）：一般關卡，可以改名、換人、刪除。 */
const plainAudit: StepInput = { name: '子公司擔當稽核', step_group: 'audit_review', signer_emp_id: EMP.boss, editable_unit_id: null }

/** 以稽核主管身分新增一條流程（流程沒有狀態，Q137 (6)）並逐關加入。 */
async function createRoute(templateId: string, steps: StepInput[]) {
  const route = ok(await boss.from('approval_route').insert({ template_id: templateId, plant_id: ID.plant }).select('id').single())
  for (const step of steps) await addStep(route.id, step)
  return route as { id: string }
}

let copies = 0
/** 和 ID.template 同樣內容的另一份範本（編號 `${RUN}T<n>`）：每個範本 × 廠區只有一條流程，要另一條流程就要另一份範本。 */
async function anotherTemplate() {
  copies += 1
  return makeTemplate(`${RUN}T${copies}`, 'control_activity', FACTORY, [
    ['請購作業', [['請購是否核准？', UNIT_ID['資材單位']], ['付款是否核對？', UNIT_ID['財會單位']]]],
    ['驗收作業', [['驗收是否抽驗？', UNIT_ID['品保單位']]]],
  ])
}

/** 在一份新範本上新增一條流程。 */
async function createOwnRoute(steps: StepInput[]) {
  return createRoute(await anotherTemplate(), steps)
}

/** insert_route_step 的參數；`before` 為空＝排最後。 */
function stepParams(routeId: string, step: StepInput, before: number | null = null) {
  return {
    p_route_id: routeId,
    p_name: step.name,
    p_step_group: step.step_group,
    p_signer_emp_id: step.signer_emp_id,
    p_editable_unit_id: step.editable_unit_id,
    p_before_position: before,
    p_link: step.link ?? null,
  }
}

/** 以稽核管理者身分新增一關，回傳它的 id 與資料庫給的位置。 */
async function addStep(routeId: string, step: StepInput, before: number | null = null) {
  const id = ok(await boss.rpc('insert_route_step', stepParams(routeId, step, before))) as string
  return ok(await boss.from('route_step').select('id,position').eq('id', id).single<{ id: string; position: number }>())
}

interface Step {
  id: string
  position: number
  name: string
}

async function steps(routeId: string) {
  return ok(await boss.from('route_step').select('id,position,name').eq('route_id', routeId).order('position')) as Step[]
}

/** 流程的發起檢查（PostgREST 計算欄位 launch_check）。 */
async function launchCheck(id: string) {
  return (ok(await boss.from('approval_route').select('launch_check').eq('id', id).single()) as { launch_check: LaunchCheck }).launch_check
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
  const units = ok(await admin.from('assessing_unit').select('id,name').in('name', [...UNITS])) as { id: string; name: string }[]
  for (const u of units) UNIT_ID[u.name as Unit] = u.id
  ID.later = (await insertRow('assessing_unit', { name: OWN_UNITS.later })).id
  ID.extra = (await insertRow('assessing_unit', { name: OWN_UNITS.extra })).id
  // 控制活動類：三個自評單位都有控制要點（品保在第二章才出現）
  ID.template = await makeTemplate(`${RUN}T`, 'control_activity', FACTORY, [
    ['請購作業', [['請購是否核准？', UNIT_ID['資材單位']], ['付款是否核對？', UNIT_ID['財會單位']]]],
    ['驗收作業', [['驗收是否抽驗？', UNIT_ID['品保單位']]]],
  ])
})

afterAll(async () => {
  // 每一步都檢查錯誤：清理失敗留下的啟用範本會讓之後不給組合的年度發起失敗。
  ok(await admin.from('annual_cycle').delete().gte('year', YEAR).lte('year', YEAR + 2))
  ok(await admin.from('approval_route').delete().eq('plant_id', ID.plant))
  ok(await admin.from('questionnaire_template').delete().like('code', `${RUN}%`))
  ok(await admin.from('plant').delete().eq('factory_code', FACTORY))
  ok(await admin.from('company').delete().eq('id', ID.company))
  ok(await admin.from('assessing_unit').delete().in('name', Object.values(OWN_UNITS)))
})

describe('發起檢查與年度發起', () => {
  let issuedSteps: unknown

  it('reports a route without a 品保單位 自行檢查 step in its 發起檢查, listing 品保單位', async () => {
    const route = await createRoute(ID.template, [selfCheck('資材單位'), selfCheck('財會單位'), manager, ...audit])
    ID.route = route.id

    expect(await launchCheck(route.id)).toEqual({
      ready: false,
      no_steps: false,
      no_merge_steps: false,
      missing_units: [{ id: UNIT_ID['品保單位'], name: '品保單位' }],
      unused_units: [],
      branch_first_step_not_editable: [],
      missing_links: [],
      audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [],
    })
  })

  it('a route that fails the 發起檢查 cannot be launched', async () => {
    const { data } = await launchAssigned(boss, { p_year: YEAR, p_due_date: DUE, p_combos: [{ template_id: ID.template, plant_id: ID.plant }] })
    expect(data).toMatchObject({
      ok: false,
      error: 'missing_route',
      missing: [{ route_id: ID.route, problem: 'not_ready', launch_check: { ready: false, missing_units: [{ name: '品保單位' }] } }],
    })
  })

  it('passes once the missing step is added, and the route can then be launched', async () => {
    const added = await addStep(ID.route, selfCheck('品保單位'))
    expect(added.position).toBe(6) // 新增排最後
    const ids = (await steps(ID.route)).map((s) => s.id)
    // 品保自檢移到財務之後、主管之前：資材 → 財務 → 品保 → 主管 → 台北稽核人員 → 稽核主管
    ok(await boss.rpc('reorder_route_steps', { p_route_id: ID.route, p_step_ids: [ids[0], ids[1], added.id, ids[2], ids[3], ids[4]] }))
    expect((await steps(ID.route)).map((s) => `${s.position}.${s.name}`)).toEqual([
      '1.自行檢查人員－資材單位',
      '2.自行檢查人員－財會單位',
      '3.自行檢查人員－品保單位',
      '4.部門主管',
      '5.台北稽核人員',
      '6.稽核主管',
    ])
    expect(await launchCheck(ID.route)).toEqual(READY)

    const { data } = await launchAssigned(boss, { p_year: YEAR, p_due_date: DUE, p_combos: [{ template_id: ID.template, plant_id: ID.plant }] })
    expect(data).toMatchObject({ ok: true, assessments: 1 })
    const assessment = ok(
      await boss
        .from('assessment')
        .select('id,assessment_step(position,name,step_group,signer_emp_id,editable_unit_name)')
        .eq('template_id', ID.template)
        .single(),
    ) as { id: string; assessment_step: { position: number }[] }
    ID.assessment = assessment.id
    issuedSteps = [...assessment.assessment_step].sort((a, b) => a.position - b.position)
    expect(issuedSteps).toHaveLength(6)
  })

  it('edits to the route leave the issued 自評表 unchanged', async () => {
    const [first] = (await steps(ID.route)) as [Step]
    ok(await boss.from('route_step').update({ name: '自行檢查人員－資材（新）' }).eq('id', first.id))
    // 一般的稽核室關卡，插在台北稽核人員之前（稽核主管要是最後一關）
    const taipeiAt = (await steps(ID.route)).find((s) => s.name === '台北稽核人員')!.position
    const extra = await addStep(ID.route, plainAudit, taipeiAt)
    ok(await boss.from('route_step').update({ signer_emp_id: EMP.signer }).eq('id', extra.id))
    ok(await boss.from('route_step').delete().eq('id', extra.id)) // 刪掉後重編，仍然通過檢查
    expect((await steps(ID.route)).map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6])

    const after = ok(
      await boss
        .from('assessment_step')
        .select('position,name,step_group,signer_emp_id,editable_unit_name')
        .eq('assessment_id', ID.assessment)
        .order('position'),
    )
    expect(after).toEqual(issuedSteps)
  })

  it('saves an edit that makes the route fail the 發起檢查, and the 發起檢查 shows the problem (Q137 (6))', async () => {
    const quality = (await steps(ID.route)).find((s) => s.name === '自行檢查人員－品保單位')!
    // 拿掉可編輯範圍、再整關刪掉：流程隨時能改，不再擋，發起檢查列出缺品保單位
    ok(await boss.from('route_step').update({ editable_unit_id: null }).eq('id', quality.id))
    expect(await launchCheck(ID.route)).toMatchObject({ ready: false, missing_units: [{ name: '品保單位' }] })
    ok(await boss.from('route_step').delete().eq('id', quality.id))
    expect((await steps(ID.route)).map((s) => s.name)).not.toContain('自行檢查人員－品保單位')
    expect(await launchCheck(ID.route)).toMatchObject({ ready: false, missing_units: [{ name: '品保單位' }] })

    // 補回來就又通過
    await addStep(ID.route, selfCheck('品保單位'))
    expect(await launchCheck(ID.route)).toEqual(READY)
  })

  it('keeps one route per 範本 × 廠區: a second one is refused', async () => {
    const second = await boss.from('approval_route').insert({ template_id: ID.template, plant_id: ID.plant })
    expect(second.error?.code).toBe('23505')
    expect(ok(await boss.from('approval_route').select('id').eq('template_id', ID.template).eq('plant_id', ID.plant))).toEqual([{ id: ID.route }])
  })
})

describe('發起檢查: 其他情形', () => {
  it('reports a route without steps, and a route without 匯流後 steps', async () => {
    const empty = await createOwnRoute([])
    expect(await launchCheck(empty.id)).toMatchObject({ ready: false, no_steps: true })

    const branchesOnly = await createOwnRoute(UNITS.map(selfCheck))
    expect(await launchCheck(branchesOnly.id)).toEqual({
      ready: false, no_steps: false, no_merge_steps: true, missing_units: [], unused_units: [], branch_first_step_not_editable: [],
      missing_links: ['audit_chief'], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [],
    })
  })

  it('control points without a 自評單位 (要素類) need no step', async () => {
    const element = (await insertRow('questionnaire_template', {
      code: `${RUN}E`, name: '要素類', layout: 'element', status: 'active', all_plants: false,
    })).id
    await insertRow('template_plant', { template_id: element, factory_code: FACTORY })
    const section = (await insertRow('template_section', { template_id: element, position: 1, name: '控制環境' })).id
    await insertControlPoint(section, 1, '是否訂定道德行為準則？', null)

    const route = await createRoute(element, audit)
    expect(await launchCheck(route.id)).toEqual(READY)

    // 整份掛同一個自評單位 (Q83) 之後，就要有涵蓋它的關卡
    await insertControlPoint(section, 2, '是否宣導誠信經營？', UNIT_ID['財會單位'])
    expect(await launchCheck(route.id)).toMatchObject({ ready: false, missing_units: [{ name: '財會單位' }] })
  })
})

describe('發起檢查: 範本後來改過、可編輯範圍沒用到', () => {
  it('reports a step scoped to a 自評單位 the template does not use', async () => {
    const route = await createOwnRoute([
      ...UNITS.map(selfCheck),
      { ...manager, name: '自行檢查人員－人資', editable_unit_id: ID.extra },
      ...audit,
    ])
    expect(await launchCheck(route.id)).toEqual({
      ready: false, no_steps: false, no_merge_steps: false, missing_units: [],
      unused_units: [{ id: ID.extra, name: OWN_UNITS.extra }], branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [],
    })
  })

  it('a route broken by a template edit can be edited step by step, and the 發起檢查 follows every edit', async () => {
    const tpl = await makeTemplate(`${RUN}L`, 'control_activity', FACTORY, [['請購', [['請購是否核准？', UNIT_ID['資材單位']]]]])
    const route = await createRoute(tpl, [selfCheck('資材單位'), ...audit])
    expect(await launchCheck(route.id)).toEqual(READY)

    // 範本管理之後加了兩個控制要點，分別掛品保與新的單位：流程不再通過
    const section = ok(await admin.from('template_section').select('id').eq('template_id', tpl).single()) as { id: string }
    await insertControlPoint(section.id, 2, '驗收是否抽驗？', UNIT_ID['品保單位'])
    await insertControlPoint(section.id, 3, '稽核是否覆核？', ID.later)
    expect(await launchCheck(route.id)).toMatchObject({ ready: false, missing_units: [{ name: '品保單位' }, { name: OWN_UNITS.later }] })

    // 改名、只補一個單位：照常儲存
    const [first, taipei, chief] = (await steps(route.id)) as [Step, Step, Step]
    ok(await boss.from('route_step').update({ name: '自行檢查人員－資材（新）' }).eq('id', first.id))
    // 分流與匯流後各自排順序：自行檢查人員加在最後也沒有新問題
    await addStep(route.id, selfCheck('品保單位'))
    expect((await steps(route.id)).map((s) => s.id)).toEqual([first.id, taipei.id, chief.id, expect.any(String)])
    expect(await launchCheck(route.id)).toMatchObject({ ready: false, missing_units: [{ name: OWN_UNITS.later }] })

    // 刪掉資材自檢：多出「缺資材單位」也照常儲存，發起檢查兩個都列
    ok(await boss.from('route_step').delete().eq('id', first.id))
    expect(await launchCheck(route.id)).toEqual({
      ready: false, no_steps: false, no_merge_steps: false,
      missing_units: [{ id: UNIT_ID['資材單位'], name: '資材單位' }, { id: ID.later, name: OWN_UNITS.later }], unused_units: [],
      branch_first_step_not_editable: [], missing_links: [], audit_chief_not_last: false, pending_unit_points: 0, unassigned_steps: [],
    })
  })
})

describe('關卡寫入規則', () => {
  it('appends, renumbers after a delete, and refuses a reorder that is not exactly the route’s steps', async () => {
    const route = await createOwnRoute([manager, { ...manager, name: '廠區經理人' }, auditChief])
    const [a, b, c] = (await steps(route.id)) as [Step, Step, Step]
    ok(await boss.from('route_step').delete().eq('id', b.id))
    expect((await steps(route.id)).map((s) => `${s.position}.${s.name}`)).toEqual(['1.部門主管', '2.稽核主管'])

    const missingOne = await boss.rpc('reorder_route_steps', { p_route_id: route.id, p_step_ids: [c.id] })
    expect(missingOne.error?.code).toBe('22023')
    const withForeign = await boss.rpc('reorder_route_steps', { p_route_id: route.id, p_step_ids: [c.id, a.id, b.id] })
    expect(withForeign.error?.code).toBe('22023')
  })

  it('lets the same signer hold several steps', async () => {
    const route = await createOwnRoute([...UNITS.map(selfCheck), ...audit])
    expect((await steps(route.id)).length).toBe(5)
    expect((await launchCheck(route.id)).ready).toBe(true)
  })

  it('廠區端的關卡也存簽核人（Q147）；沒存人的非連動關卡列在發起檢查的「還沒分派」', async () => {
    const route = await createOwnRoute([...UNITS.map(selfCheck), { ...manager, signer_emp_id: null }, { ...plainAudit, signer_emp_id: null }, ...audit])
    const all = await steps(route.id)
    const id = (name: string) => all.find((s) => s.name === name)!.id
    expect(await launchCheck(route.id)).toEqual({
      ...READY,
      ready: false,
      unassigned_steps: [
        { id: id('部門主管'), name: '部門主管', branch_unit_id: null, branch_unit_name: null },
        { id: id('子公司擔當稽核'), name: '子公司擔當稽核', branch_unit_id: null, branch_unit_name: null },
      ],
    })
    // 分流裡的關卡帶著分流的名稱。
    ok(await boss.from('route_step').update({ signer_emp_id: null }).eq('id', id('自行檢查人員－財會單位')))
    expect((await launchCheck(route.id)).unassigned_steps[0]).toEqual({
      id: id('自行檢查人員－財會單位'), name: '自行檢查人員－財會單位', branch_unit_id: UNIT_ID['財會單位'], branch_unit_name: '財會單位',
    })
    ok(await boss.from('route_step').update({ signer_emp_id: EMP.other }).eq('id', id('自行檢查人員－財會單位')))
    ok(await boss.from('route_step').update({ signer_emp_id: EMP.other }).eq('id', id('部門主管')))
    ok(await boss.from('route_step').update({ signer_emp_id: EMP.other }).eq('id', id('子公司擔當稽核')))
    expect(await launchCheck(route.id)).toEqual(READY)
  })

  it('keeps 稽核室覆核 steps read-only and refuses a blank name or signer', async () => {
    const route = await createOwnRoute([])
    const scoped = await boss.rpc('insert_route_step', stepParams(route.id, { ...auditChief, editable_unit_id: UNIT_ID['品保單位'] }))
    expect(scoped.error?.code).toBe('23514')
    const blankName = await boss.rpc('insert_route_step', stepParams(route.id, { ...manager, name: '  ' }))
    expect(blankName.error?.code).toBe('23514')
    const blankSigner = await boss.rpc('insert_route_step', stepParams(route.id, { ...auditChief, signer_emp_id: ' ' }))
    expect(blankSigner.error?.code).toBe('23514')
    // 稽核室的一般關卡（子公司擔當稽核）可以不存人：自評表發出後由廠區管理員分派（Q143）。
    const unassigned = await boss.rpc('insert_route_step', stepParams(route.id, { ...plainAudit, signer_emp_id: ' ' }))
    expect(unassigned.error).toBeNull()
    const stored = ok(await boss.from('route_step').select('signer_emp_id').eq('id', unassigned.data as string).single())
    expect(stored).toEqual({ signer_emp_id: null })
  })

  it('cannot set a position directly', async () => {
    const route = await createOwnRoute([manager])
    const { error } = await boss.from('route_step').insert({ route_id: route.id, ...manager, position: 9 })
    expect(error?.code).toBe('42501') // 關卡沒有直接新增的授權，只能走 insert_route_step
  })

  it('inserts a step before a given position and shifts the rest', async () => {
    const route = await createOwnRoute([manager, auditChief])
    const added = await addStep(route.id, { ...manager, name: '廠區經理人' }, 2)
    expect(added.position).toBe(2)
    expect((await steps(route.id)).map((s) => `${s.position}.${s.name}`)).toEqual(['1.部門主管', '2.廠區經理人', '3.稽核主管'])
    for (const before of [0, 4]) {
      const { error } = await boss.rpc('insert_route_step', stepParams(route.id, manager, before))
      expect(error?.code).toBe('22023')
    }
  })
})

describe('刪除流程（delete_route，Q137 (6)）', () => {
  it('deletes a route only through delete_route, with the 範本編號 typed in, together with its steps', async () => {
    const tpl = await anotherTemplate()
    const route = await createRoute(tpl, [manager, ...audit]) // 有標記的關卡跟著流程一起刪
    const code = `${RUN}T${copies}`

    // 直接刪資料表：沒有刪除的授權
    expect((await boss.from('approval_route').delete().eq('id', route.id)).error?.code).toBe('42501')
    // 編號不符：拒絕，什麼都沒刪
    expect((await boss.rpc('delete_route', { p_route_id: route.id, p_code: `${code}X` })).error?.code).toBe('22023')
    expect((await boss.rpc('delete_route', { p_route_id: route.id, p_code: null })).error?.code).toBe('22023')
    expect(await steps(route.id)).toHaveLength(3)
    // 找不到流程
    expect((await boss.rpc('delete_route', { p_route_id: '00000000-0000-4000-8000-000000000000', p_code: code })).error?.code).toBe('P0002')

    ok(await boss.rpc('delete_route', { p_route_id: route.id, p_code: ` ${code} ` }))
    expect(ok(await admin.from('approval_route').select('id').eq('id', route.id))).toEqual([])
    expect(ok(await admin.from('route_step').select('id').eq('route_id', route.id))).toEqual([])
    // 刪掉之後這個組合可以再建一條
    await createRoute(tpl, [manager])
  })

  it('leaves the 自評表 already issued from the route as they are', async () => {
    const tpl = await anotherTemplate()
    const code = `${RUN}T${copies}`
    const route = await createRoute(tpl, [...UNITS.map(selfCheck), manager, ...audit])
    const launchYear = YEAR + 2
    onTestFinished(async () => void ok(await admin.from('annual_cycle').delete().eq('year', launchYear)))
    const { data } = await launchAssigned(boss, { p_year: launchYear, p_due_date: DUE, p_combos: [{ template_id: tpl, plant_id: ID.plant }] })
    expect(data).toMatchObject({ ok: true, assessments: 1 })
    const issued = async () =>
      ok(await boss.from('assessment').select('id,status,assessment_step(position,name)').eq('template_id', tpl).single()) as {
        id: string; status: string; assessment_step: { position: number; name: string }[]
      }
    const before = await issued()
    expect(before.assessment_step).toHaveLength(6)

    ok(await boss.rpc('delete_route', { p_route_id: route.id, p_code: code }))
    expect(await issued()).toEqual(before)
    // 這個組合沒有流程了：之後的年度不能發起
    const candidates = ok(await boss.rpc('launch_candidates')) as { template_id: string; plant_id: string; route_id: string | null; problem: string | null }[]
    expect(candidates.find((c) => c.template_id === tpl && c.plant_id === ID.plant)).toMatchObject({ route_id: null, problem: 'no_route' })
  })

  it('only a 稽核主管 can delete a route', async () => {
    const tpl = await anotherTemplate()
    const route = await createRoute(tpl, [manager])
    expect((await signer.rpc('delete_route', { p_route_id: route.id, p_code: `${RUN}T${copies}` })).error?.code).toBe('42501')
    expect((await signer.from('approval_route').delete().eq('id', route.id)).error?.code).toBe('42501')
    expect(await steps(route.id)).toHaveLength(1)
  })
})

describe('連動標記（#189）', () => {
  const stepRow = async (id: string) =>
    ok(await admin.from('route_step').select('name,signer_emp_id,link,position').eq('id', id).single()) as { name: string; signer_emp_id: string; link: string | null; position: number }

  it('lists a missing 稽核主管 in the 發起檢查; 台北稽核人員 may be left out (Q143)', async () => {
    const onlyChief = await createOwnRoute([...UNITS.map(selfCheck), auditChief])
    expect(await launchCheck(onlyChief.id)).toEqual(READY)

    // 名稱對得上也不算：標記才算（不靠名稱比對）
    const unmarked = await createOwnRoute([...UNITS.map(selfCheck), { ...taipeiAuditor, link: null }, { ...auditChief, link: null }])
    expect(await launchCheck(unmarked.id)).toMatchObject({ ready: false, missing_links: ['audit_chief'] })

    const both = await createOwnRoute([...UNITS.map(selfCheck), ...audit])
    expect(await launchCheck(both.id)).toEqual(READY)
  })

  it('keeps a marked step as it is: no rename, no delete, and a new signer only while it is not linked', async () => {
    const route = await createOwnRoute([manager, ...audit])
    const [, taipei, chief] = (await steps(route.id)) as [Step, Step, Step]
    const before = await stepRow(taipei.id)
    expect(before).toMatchObject({ name: '台北稽核人員', signer_emp_id: EMP.boss, link: 'taipei_auditor' })

    // 透過 API 改名或刪：說明原因拒絕，什麼都沒動
    const linked = { code: '23514', hint: 'step_linked' }
    expect((await boss.from('route_step').update({ name: '改名' }).eq('id', taipei.id)).error).toMatchObject(linked)
    expect((await boss.from('route_step').update({ signer_emp_id: EMP.other, name: '改名' }).eq('id', taipei.id)).error).toMatchObject(linked)
    expect((await boss.from('route_step').delete().eq('id', chief.id)).error).toMatchObject(linked)
    expect(await stepRow(taipei.id)).toEqual(before)
    // 不連動時只能改簽核人（#190，#187 定案第 1 點）：這一廠沒有是稽核人員的廠區管理員。連動時拒絕改簽核人在
    // audit_link_sync 測（要有稽核人員當廠區管理員）。
    ok(await boss.from('route_step').update({ signer_emp_id: EMP.other }).eq('id', taipei.id))
    expect(await stepRow(taipei.id)).toEqual({ ...before, signer_emp_id: EMP.other })
    expect(await stepRow(chief.id)).toMatchObject({ name: '稽核主管', link: 'audit_chief' })
    // 標記本身也寫不進去（欄位沒有寫入授權）
    expect((await boss.from('route_step').update({ link: null }).eq('id', taipei.id)).error?.code).toBe('42501')
    const [plain] = [ok(await boss.from('route_step').select('id').eq('route_id', route.id).is('link', null).limit(1).single()) as { id: string }]
    expect((await boss.from('route_step').update({ link: 'audit_chief' }).eq('id', plain.id)).error?.code).toBe('42501')

    // 一般稽核室關卡照舊可以改、可以刪；排序（資料庫函式）也可以動到有標記的關卡
    const extra = await addStep(route.id, plainAudit, 2)
    const ids = (await steps(route.id)).map((s) => s.id)
    ok(await boss.rpc('reorder_route_steps', { p_route_id: route.id, p_step_ids: [ids[0], ids[2], ids[1], ids[3]] }))
    expect((await stepRow(taipei.id)).position).toBe(2)
    ok(await boss.from('route_step').update({ name: '子公司擔當稽核（新）', signer_emp_id: EMP.other }).eq('id', extra.id))
    ok(await boss.from('route_step').delete().eq('id', extra.id))
  })

  it('refuses a second step with the same mark, a mark on a 廠區端 step and an unknown mark', async () => {
    const route = await createOwnRoute([taipeiAuditor])
    const twice = await boss.rpc('insert_route_step', stepParams(route.id, { ...taipeiAuditor, name: '另一個台北稽核人員' }))
    expect(twice.error).toMatchObject({ code: '23505', hint: 'link_exists' })
    // 另一條流程不受影響
    const other = await createOwnRoute([taipeiAuditor])
    expect(await steps(other.id)).toHaveLength(1)

    const plant = await boss.rpc('insert_route_step', stepParams(route.id, { ...manager, link: 'audit_chief' }))
    expect(plant.error?.code).toBe('23514')
    const unknown = await boss.rpc('insert_route_step', stepParams(route.id, { ...plainAudit, link: 'somebody' as 'audit_chief' }))
    expect(unknown.error?.code).toBe('23514')
    // 名稱就是它連動的那一關
    const renamed = await boss.rpc('insert_route_step', stepParams(route.id, { ...auditChief, name: '別的名字' }))
    expect(renamed.error?.code).toBe('23514')
    expect(await steps(route.id)).toHaveLength(1)
  })

  it('keeps the marked steps of a route: they cannot be deleted', async () => {
    const route = await createOwnRoute([...UNITS.map(selfCheck), manager, ...audit])
    expect(await launchCheck(route.id)).toEqual(READY)
    // 刪不掉，流程仍通過檢查
    const taipei = (await steps(route.id)).find((s) => s.name === '台北稽核人員')!
    expect((await boss.from('route_step').delete().eq('id', taipei.id)).error).toMatchObject({ code: '23514', hint: 'step_linked' })
    expect(await launchCheck(route.id)).toEqual(READY)
    // 匯流後的關卡全刪：有標記的兩關刪不掉，整筆拒絕
    const merged = (await steps(route.id)).filter((s) => !['自行檢查人員－資材單位', '自行檢查人員－品保單位', '自行檢查人員－財會單位'].includes(s.name))
    expect((await boss.from('route_step').delete().in('id', merged.map((s) => s.id))).error?.code).toBe('23514')
    expect(await steps(route.id)).toHaveLength(6)
  })

  it('wants the 稽核主管 last: a reorder that moves it up is saved, and the 發起檢查 says so until it is moved back', async () => {
    const notLast = await createOwnRoute([...UNITS.map(selfCheck), ...audit, plainAudit])
    expect(await launchCheck(notLast.id)).toMatchObject({ ready: false, audit_chief_not_last: true, missing_links: [] })

    const route = await createOwnRoute([...UNITS.map(selfCheck), plainAudit, ...audit])
    expect(await launchCheck(route.id)).toEqual(READY)
    const ids = (await steps(route.id)).map((s) => s.id)
    // 稽核主管（最後一關）拖到子公司擔當稽核前面：流程隨時能改（Q137 (6)），照常儲存
    const moved = [ids[0], ids[1], ids[2], ids[5], ids[3], ids[4]]
    ok(await boss.rpc('reorder_route_steps', { p_route_id: route.id, p_step_ids: moved }))
    expect((await steps(route.id)).map((s) => s.id)).toEqual(moved)
    expect(await launchCheck(route.id)).toMatchObject({ ready: false, audit_chief_not_last: true })

    ok(await boss.rpc('reorder_route_steps', { p_route_id: route.id, p_step_ids: ids }))
    expect(await launchCheck(route.id)).toEqual(READY)
  })

  it('fails while the template still has 待指定單位 control points, however complete the route is (Q142)', async () => {
    // 轉檔留下的暫定單位（scripts/templates/sources.mjs 的 UNIT_TO_BE_ASSIGNED）：環境上可能已經有，沒有就建。
    const existing = ok(await admin.from('assessing_unit').select('id').eq('name', '待指定單位').maybeSingle()) as { id: string } | null
    const pending = existing ?? ok(await admin.from('assessing_unit').insert({ name: '待指定單位' }).select('id').single()) as { id: string }
    copies += 1
    const templateId = await makeTemplate(`${RUN}T${copies}`, 'control_activity', FACTORY, [
      ['請購作業', [['請購是否核准？', UNIT_ID['資材單位']], ['付款是否核對？', pending.id], ['驗收是否抽驗？', pending.id]]],
    ])
    const route = await createRoute(templateId, [
      selfCheck('資材單位'),
      { name: '自行檢查人員－待指定單位', step_group: 'plant', signer_emp_id: EMP.signer, editable_unit_id: pending.id },
      ...audit,
    ])
    expect(await launchCheck(route.id)).toEqual({ ...READY, ready: false, pending_unit_points: 2 })
  })

  it('copies the marks onto the issued 自評表 and the issued steps cannot lose them', async () => {
    const tpl = await anotherTemplate()
    await createRoute(tpl, [...UNITS.map(selfCheck), manager, plainAudit, ...audit])
    const launchYear = YEAR + 1
    // 這一年在測試結束前自己清掉。
    onTestFinished(async () => void ok(await admin.from('annual_cycle').delete().eq('year', launchYear)))
    const { data } = await launchAssigned(boss, { p_year: launchYear, p_due_date: DUE, p_combos: [{ template_id: tpl, plant_id: ID.plant }] })
    expect(data).toMatchObject({ ok: true, assessments: 1 })
    const issued = ok(
      await boss.from('assessment').select('assessment_step(position,name,link)').eq('template_id', tpl).eq('cycle_id', (data as { cycle_id: string }).cycle_id).single(),
    ) as { assessment_step: { position: number; name: string; link: string | null }[] }
    expect([...issued.assessment_step].sort((a, b) => a.position - b.position).map((s) => [s.name, s.link])).toEqual([
      ['自行檢查人員－資材單位', null], ['自行檢查人員－品保單位', null], ['自行檢查人員－財會單位', null],
      ['部門主管', null], ['子公司擔當稽核', null], ['台北稽核人員', 'taipei_auditor'], ['稽核主管', 'audit_chief'],
    ])
  })
})

describe('只有稽核管理者', () => {
  it('a signer cannot read, create, edit, reorder or delete routes', async () => {
    expect(ok(await signer.from('approval_route').select('id').eq('plant_id', ID.plant))).toEqual([])
    const created = await signer.from('approval_route').insert({ template_id: await anotherTemplate(), plant_id: ID.plant })
    expect(created.error?.code).toBe('42501')

    const route = await createOwnRoute([manager])
    const step = await signer.rpc('insert_route_step', stepParams(route.id, manager))
    expect(step.error?.code).toBe('42501')
    expect((await signer.rpc('reorder_route_steps', { p_route_id: route.id, p_step_ids: [] })).error?.code).toBe('42501')
    expect((await signer.rpc('delete_route', { p_route_id: route.id, p_code: `${RUN}T${copies}` })).error?.code).toBe('42501')
  })

  it('refuses a route for a 廠區 the 範本 does not apply to', async () => {
    const other = await makeTemplate(`${RUN}O`, 'control_activity', `${FACTORY}X`, [['章', [['題', UNIT_ID['資材單位']]]]])
    const { error } = await boss.from('approval_route').insert({ template_id: other, plant_id: ID.plant })
    expect(error).toMatchObject({ code: '23514', hint: 'plant_not_applicable' })
  })

  it('a 稽核主管 cannot change a route’s 範本 or 廠區 directly', async () => {
    const route = await createOwnRoute([manager])
    expect((await boss.from('approval_route').update({ template_id: ID.template }).eq('id', route.id)).error?.code).toBe('42501')
    expect((await boss.from('approval_route').update({ plant_id: ID.plant }).eq('id', route.id)).error?.code).toBe('42501')
  })
})
