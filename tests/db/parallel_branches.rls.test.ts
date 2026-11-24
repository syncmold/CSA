// 分流並行（工單 #97；Q116，暫定 OPEN-6；ADR 0007）：各自評單位的分流同時填寫、各自核准，全部完成才匯流到
// 廠區經理人，之後稽核室依序覆核；退回只重開一條分流；其他單位的答案要等自己的單位送出後、而且那個單位也送出了
// 才看得到。每次執行建立自己的公司、廠區、自評單位、範本與簽核流程並發起自己的年度作業，結束時全部清掉。
// 「四個單位」那一組測試依序執行，共用同一張自評表，從發起一路簽到結案。
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ASSESSMENT_TREE } from '../../src/api/assessmentQuery'
import {
  launchAssigned,
  admin,
  beginAs,
  directDb,
  insertRow,
  loginAs,
  makeRoute,
  makeTemplate,
  ok,
  planNodes,
  promoteToAuditAdmin,
  requirePostgrest,
  restClient,
  stillWaiting,
  type PlanNode,
  type RouteStepSpec,
} from './helpers'

const RUN = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = {
  boss: `${RUN}A`,
  mat: `${RUN}B`, matMgr: `${RUN}C`,
  qa: `${RUN}D`, qaMgr: `${RUN}E`,
  fin: `${RUN}F`, finChief: `${RUN}G`, finMgr: `${RUN}H`,
  prod: `${RUN}I`, prodMgr: `${RUN}J`,
  plantMgr: `${RUN}K`, sub: `${RUN}L`, taipei: `${RUN}M`, chief: `${RUN}N`,
  both: `${RUN}O`, bothMgr: `${RUN}P`,
  outsider: `${RUN}Q`,
}
const YEAR = 20000 + Math.floor(Math.random() * 900) // 會用到 YEAR … YEAR + 9
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = { mat: `${RUN}資材`, qa: `${RUN}品保`, fin: `${RUN}財務`, prod: `${RUN}生產` }
const COMPLETE = { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }

const ID: Record<string, string> = {}
const conns: Client[] = []

const as = (who: string) => loginAs(who, who.slice(-1))
const unitId = (name: string) => ID[name]!

/**
 * 四個單位的流程，關卡順序照紙本（自行檢查人員都排前面、主管排後面）：
 *   分流 資材 1 → 5、品保 2 → 6、財務 3 → 7（稽核部多加的課長）→ 8、生產 4 → 9；匯流後 10 廠區經理人、11–13 稽核室。
 */
const FOUR: { name: string; signer: string; unit: keyof typeof UNIT | null; branch: keyof typeof UNIT | null; group?: 'audit_review' }[] = [
  { name: '自行檢查人員－資材', signer: EMP.mat, unit: 'mat', branch: 'mat' },
  { name: '自行檢查人員－品保', signer: EMP.qa, unit: 'qa', branch: 'qa' },
  { name: '自行檢查人員－財務', signer: EMP.fin, unit: 'fin', branch: 'fin' },
  { name: '自行檢查人員－生產', signer: EMP.prod, unit: 'prod', branch: 'prod' },
  { name: '部門主管－資材', signer: EMP.matMgr, unit: null, branch: 'mat' },
  { name: '部門主管－品保', signer: EMP.qaMgr, unit: null, branch: 'qa' },
  { name: '課長－財務', signer: EMP.finChief, unit: null, branch: 'fin' },
  { name: '部門主管－財務', signer: EMP.finMgr, unit: null, branch: 'fin' },
  { name: '部門主管－生產', signer: EMP.prodMgr, unit: null, branch: 'prod' },
  { name: '廠區經理人', signer: EMP.plantMgr, unit: null, branch: null },
  { name: '子公司擔當稽核', signer: EMP.sub, unit: null, branch: null, group: 'audit_review' },
  { name: '台北稽核人員', signer: EMP.taipei, unit: null, branch: null, group: 'audit_review' },
  { name: '稽核主管', signer: EMP.chief, unit: null, branch: null, group: 'audit_review' },
]

function routeSpec(steps: typeof FOUR): RouteStepSpec[] {
  return steps.map((s) => ({
    name: s.name,
    group: s.group ?? 'plant',
    signer: s.signer,
    unitId: s.unit ? unitId(UNIT[s.unit]) : null,
    branchUnitId: s.branch ? unitId(UNIT[s.branch]) : null,
  }))
}

/** 一個範本 × 這個廠區的流程，發起成自評表；回傳自評表 id 與控制要點（依自評單位名稱）。 */
async function launch(tag: string, units: (keyof typeof UNIT)[], steps: typeof FOUR, year: number) {
  const templateId = await makeTemplate(`${RUN}${tag}`, 'control_activity', FACTORY, [
    ['第一章', units.map((u) => [`${tag}-${u}`, unitId(UNIT[u])] as [string, string])],
  ])
  ID[`template:${tag}`] = templateId
  await makeRoute(templateId, ID.plant!, routeSpec(steps))
  const launched = await launchAssigned(await as(EMP.boss), {
    p_year: year, p_due_date: '2099-12-31', p_combos: [{ template_id: templateId, plant_id: ID.plant }],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  const assessmentId = ok(await admin.from('assessment').select('id').eq('cycle_id', launched.data.cycle_id).single()).id as string
  const rows = ok(await admin.from('assessment_control_point_unit').select('control_point_id,assessing_unit_name').eq('assessment_id', assessmentId))
  const point = Object.fromEntries((rows as { control_point_id: string; assessing_unit_name: string }[]).map((r) => [r.assessing_unit_name, r.control_point_id]))
  return { assessmentId, point }
}

function saveUnit(client: SupabaseClient, assessmentId: string, point: Record<string, string>, unit: string, fields: object = COMPLETE) {
  return client.rpc('save_assessment_answers', {
    p_assessment_id: assessmentId,
    p_answers: [{ control_point_id: point[unit], assessing_unit_name: unit, ...fields }],
    p_conclusions: [{ assessing_unit_name: unit, conclusion: 'satisfied' }],
  })
}

const submit = (client: SupabaseClient, assessmentId: string, stepPosition?: number) =>
  client.rpc('submit_assessment_step', { p_assessment_id: assessmentId, ...(stepPosition === undefined ? {} : { p_step_position: stepPosition }) })
const approve = (client: SupabaseClient, assessmentId: string, stepPosition?: number) =>
  client.rpc('approve_assessment_step', { p_assessment_id: assessmentId, ...(stepPosition === undefined ? {} : { p_step_position: stepPosition }) })
const returnTo = (client: SupabaseClient, assessmentId: string, to: number, stepPosition?: number) =>
  client.rpc('return_assessment', {
    p_assessment_id: assessmentId, p_to_position: to, p_reason: '請補充說明',
    ...(stepPosition === undefined ? {} : { p_step_position: stepPosition }),
  })

/** 每一關的狀態，依關卡順序：[順序, 狀態]。 */
async function states(assessmentId: string) {
  const rows = ok(await admin.from('assessment_step').select('position,state').eq('assessment_id', assessmentId).order('position'))
  return (rows as { position: number; state: string }[]).map((r) => [r.position, r.state])
}

/** 依關卡順序列出 state 是 current 的關卡。 */
async function current(assessmentId: string) {
  return (await states(assessmentId)).filter(([, s]) => s === 'current').map(([p]) => p)
}

/** 這個人讀得到哪幾個單位的答案與整體結論（兩張表要一致）。 */
async function visibleUnits(who: string, assessmentId: string) {
  const client = await as(who)
  const answers = ok(await client.from('assessment_answer').select('assessing_unit_name').eq('assessment_id', assessmentId)) as { assessing_unit_name: string }[]
  const conclusions = ok(await client.from('assessment_conclusion').select('assessing_unit_name').eq('assessment_id', assessmentId)) as { assessing_unit_name: string }[]
  const a = answers.map((r) => r.assessing_unit_name).sort()
  expect(conclusions.map((r) => r.assessing_unit_name).sort(), `${who} 的整體結論`).toEqual(a)
  return a
}
const unitsOf = (...keys: (keyof typeof UNIT)[]) => keys.map((k) => UNIT[k]).sort()

async function stage(assessmentId: string) {
  const row = ok(await (await as(EMP.boss)).from('my_assessment').select('stage').eq('assessment_id', assessmentId).maybeSingle())
  // 稽核管理者不在流程上就不在 my_assessment；改從追蹤總覽讀（同一個 assessment_stage）。
  if (row) return (row as { stage: string }).stage
  return (ok(await (await as(EMP.boss)).from('tracking_assessment').select('stage').eq('assessment_id', assessmentId).single()) as { stage: string }).stage
}

async function pending(who: string, assessmentId: string) {
  return ok(await (await as(who)).from('my_pending_assessment').select('step_position,step_name').eq('assessment_id', assessmentId))
}

async function conn(): Promise<Client> {
  const c = await directDb()
  if (!c) throw new Error('directDb unreachable')
  conns.push(c)
  return c
}

beforeAll(async () => {
  await requirePostgrest()
  for (const who of Object.values(EMP)) await as(who)
  await promoteToAuditAdmin(EMP.boss)
  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  for (const name of Object.values(UNIT)) ID[name] = (await insertRow('assessing_unit', { name })).id
})

afterAll(async () => {
  for (const c of conns) await c.end().catch(() => {})
  await admin.from('annual_cycle').delete().gte('year', YEAR).lt('year', YEAR + 10)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant ?? '')
  const templates = Object.entries(ID).filter(([k]) => k.startsWith('template:')).map(([, v]) => v)
  if (templates.length) await admin.from('questionnaire_template').delete().in('id', templates)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().in('name', Object.values(UNIT))
})

describe('四個單位的自評表', () => {
  let a = ''
  let point: Record<string, string> = {}

  beforeAll(async () => {
    ;({ assessmentId: a, point } = await launch('four', ['mat', 'qa', 'fin', 'prod'], FOUR, YEAR))
  })

  it('snapshots which branch every 關卡 belongs to, and starts every branch at once', async () => {
    const steps = ok(await admin.from('assessment_step').select('position,branch_unit_name,editable_unit_name,state').eq('assessment_id', a).order('position'))
    expect((steps as { branch_unit_name: string | null }[]).map((s) => s.branch_unit_name)).toEqual([
      UNIT.mat, UNIT.qa, UNIT.fin, UNIT.prod, UNIT.mat, UNIT.qa, UNIT.fin, UNIT.fin, UNIT.prod, null, null, null, null,
    ])
    expect(await current(a)).toEqual([1, 2, 3, 4])
    expect(await stage(a)).toBe('filling')
    for (const [who, position] of [[EMP.mat, 1], [EMP.qa, 2], [EMP.fin, 3], [EMP.prod, 4]] as const) {
      expect({ who, rows: await pending(who, a) }).toEqual({ who, rows: [{ step_position: position, step_name: FOUR[position - 1]!.name }] })
    }
    // 還沒輪到的主管、廠區經理人看不到這張自評表
    for (const who of [EMP.matMgr, EMP.plantMgr, EMP.chief]) {
      const seen = await (await as(who)).from('assessment').select('id').eq('id', a)
      expect({ who, rows: seen.data }).toEqual({ who, rows: [] })
    }
  })

  it('lets each 自行檢查人員 answer only their own unit, all at the same time', async () => {
    const clients = Object.fromEntries(await Promise.all((['mat', 'qa', 'fin', 'prod'] as const).map(async (k) => [k, await as(EMP[k])] as const)))
    const saved = await Promise.all((['mat', 'qa', 'fin', 'prod'] as const).map((k) => saveUnit(clients[k]!, a, point, UNIT[k])))
    expect(saved.map((r) => r.error)).toEqual([null, null, null, null])
    // 別的單位那一列寫不進去
    expect((await saveUnit(clients.qa!, a, point, UNIT.mat)).error?.code).toBe('42501')
    expect(ok(await clients.qa!.from('assessment').select('my_editable_units,can_approve').eq('id', a).single())).toEqual({
      my_editable_units: [UNIT.qa], can_approve: false,
    })
  })

  it('shows another unit’s answers only once one’s own unit and that unit have both submitted (Q116 (9))', async () => {
    // 還沒有人送出：每個人只看得到自己單位的
    expect(await visibleUnits(EMP.qa, a)).toEqual(unitsOf('qa'))
    expect(await visibleUnits(EMP.mat, a)).toEqual(unitsOf('mat'))
    // 主管還沒輪到：連自評表都看不到（Q81 (5)）
    expect(await visibleUnits(EMP.qaMgr, a)).toEqual([])

    expect(ok(await submit(await as(EMP.mat), a))).toEqual({ ok: true, current_step_position: 5 })
    // 品保還沒送出：看不到已送出的資材
    expect(await visibleUnits(EMP.qa, a)).toEqual(unitsOf('qa'))
    // 資材送出了，但其他單位都還沒送出
    expect(await visibleUnits(EMP.mat, a)).toEqual(unitsOf('mat'))
    expect(await visibleUnits(EMP.matMgr, a)).toEqual(unitsOf('mat'))

    const [qa, prod] = await Promise.all([submit(await as(EMP.qa), a), submit(await as(EMP.prod), a)])
    expect([ok(qa), ok(prod)]).toEqual([{ ok: true, current_step_position: 6 }, { ok: true, current_step_position: 9 }])
    // 品保送出後：看得到已送出的資材、生產，看不到還沒送出的財務
    expect(await visibleUnits(EMP.qa, a)).toEqual(unitsOf('mat', 'qa', 'prod'))
    expect(await visibleUnits(EMP.fin, a)).toEqual(unitsOf('fin'))
    // 稽核管理者看得到全部
    expect(await visibleUnits(EMP.boss, a)).toEqual(unitsOf('mat', 'qa', 'fin', 'prod'))
    // 不在流程上的人什麼都看不到；匯流後的關卡還沒輪到也一樣
    expect(await visibleUnits(EMP.outsider, a)).toEqual([])
    expect(await visibleUnits(EMP.plantMgr, a)).toEqual([])
  })

  it('lets each 部門主管 approve their own branch on their own, while the 廠區經理人 keeps waiting', async () => {
    for (const who of [EMP.matMgr, EMP.qaMgr, EMP.prodMgr]) {
      expect({ who, result: ok(await approve(await as(who), a)) }).toEqual({ who, result: { ok: true, closed: false, current_step_position: null } })
    }
    expect(await current(a)).toEqual([3]) // 只剩財務的自行檢查人員
    expect(await stage(a)).toBe('filling')

    // 三個單位核准、財務還在填：廠區經理人沒有輪到、看不到、不能核准
    const plantMgr = await as(EMP.plantMgr)
    expect(await pending(EMP.plantMgr, a)).toEqual([])
    expect((await plantMgr.from('assessment').select('id').eq('id', a)).data).toEqual([])
    expect((await approve(plantMgr, a)).error?.code).toBe('42501')
    // 已核准的主管不能再核准一次
    expect((await approve(await as(EMP.matMgr), a)).error?.code).toBe('42501')
  })

  it('walks the 財務 branch through its extra 關卡, returning inside the branch only', async () => {
    expect(ok(await submit(await as(EMP.fin), a))).toEqual({ ok: true, current_step_position: 7 })
    expect(await stage(a)).toBe('signing') // 匯流前，但沒有分流在答題
    // 財務送出了：輪到的課長看得到已送出的單位；後面的部門主管還沒輪到，看不到自評表，也就看不到答案
    expect(await visibleUnits(EMP.finChief, a)).toEqual(unitsOf('mat', 'qa', 'fin', 'prod'))
    expect(await visibleUnits(EMP.finMgr, a)).toEqual([])
    expect(ok(await approve(await as(EMP.finChief), a))).toEqual({ ok: true, closed: false, current_step_position: 8 })

    const finMgr = await as(EMP.finMgr)
    const mine = ok(await finMgr.from('assessment').select('my_current_steps').eq('id', a).single()) as { my_current_steps: object[] }
    expect(mine.my_current_steps).toEqual([
      { position: 8, name: '部門主管－財務', branch_unit_name: UNIT.fin, editable_unit_name: null, return_targets: [7], closes: false },
    ])
    // 分流內只能退回本分流的前一關（Q116 (10)）：不能跨分流，也不能跳過課長
    expect(ok(await returnTo(finMgr, a, 2))).toEqual({ ok: false, error: 'invalid_target' })
    expect(ok(await returnTo(finMgr, a, 3))).toEqual({ ok: false, error: 'invalid_target' })
    expect(ok(await returnTo(finMgr, a, 7))).toEqual({ ok: true, current_step_position: 7, voided: 1 })
    expect(await current(a)).toEqual([7])
    expect(ok(await approve(await as(EMP.finChief), a))).toEqual({ ok: true, closed: false, current_step_position: 8 })

    // 最後一個分流核准：匯流到廠區經理人
    expect(ok(await approve(finMgr, a))).toEqual({ ok: true, closed: false, current_step_position: 10 })
    expect(await current(a)).toEqual([10])
    expect(await pending(EMP.plantMgr, a)).toEqual([{ step_position: 10, step_name: '廠區經理人' }])
    expect(await visibleUnits(EMP.plantMgr, a)).toEqual(unitsOf('mat', 'qa', 'fin', 'prod'))
  })

  it('lets the 廠區經理人 return one unit to its 自行檢查人員; the other branches stay approved, then it merges again', async () => {
    const plantMgr = await as(EMP.plantMgr)
    const mine = ok(await plantMgr.from('assessment').select('my_current_steps').eq('id', a).single()) as {
      my_current_steps: { return_targets: number[] }[]
    }
    expect(mine.my_current_steps.map((s) => s.return_targets)).toEqual([[1, 2, 3, 4]])
    expect(ok(await returnTo(plantMgr, a, 5))).toEqual({ ok: false, error: 'invalid_target' }) // 退到單位就是它的自行檢查人員

    expect(ok(await returnTo(plantMgr, a, 1))).toEqual({ ok: true, current_step_position: 1, voided: 2 })
    expect(await states(a)).toEqual([
      [1, 'current'], [2, 'done'], [3, 'done'], [4, 'done'], [5, 'pending'], [6, 'done'], [7, 'done'], [8, 'done'], [9, 'done'],
      [10, 'pending'], [11, 'pending'], [12, 'pending'], [13, 'pending'],
    ])
    expect(await stage(a)).toBe('filling')
    // 資材重填：別人看不到，廠區經理人（簽過）照樣看得到全部
    expect(await visibleUnits(EMP.qa, a)).toEqual(unitsOf('qa', 'fin', 'prod'))
    expect(await visibleUnits(EMP.plantMgr, a)).toEqual(unitsOf('mat', 'qa', 'fin', 'prod'))
    expect((await approve(plantMgr, a)).error?.code).toBe('42501')

    const mat = await as(EMP.mat)
    expect(ok(await saveUnit(mat, a, point, UNIT.mat, { ...COMPLETE, improvement: '補充' }))).toMatchObject({ ok: true })
    expect(ok(await submit(mat, a))).toEqual({ ok: true, current_step_position: 5 })
    expect(ok(await approve(await as(EMP.matMgr), a))).toEqual({ ok: true, closed: false, current_step_position: 10 })
    expect(await current(a)).toEqual([10])

    // 作廢的簽核留在歷程
    const history = ok(await admin.from('assessment_signoff').select('step_position,action,voided_at').eq('assessment_id', a).order('serial_no'))
    expect((history as { step_position: number; voided_at: string | null }[]).filter((h) => h.voided_at !== null).map((h) => h.step_position).sort())
      .toEqual([1, 5, 7])
  })

  it('lets 稽核室 return only to the 關卡 before, to the 廠區經理人, or straight to one unit’s 自行檢查人員', async () => {
    expect(ok(await approve(await as(EMP.plantMgr), a))).toEqual({ ok: true, closed: false, current_step_position: 11 })
    expect(ok(await approve(await as(EMP.sub), a))).toEqual({ ok: true, closed: false, current_step_position: 12 })

    const taipei = await as(EMP.taipei)
    const mine = ok(await taipei.from('assessment').select('my_current_steps').eq('id', a).single()) as { my_current_steps: { return_targets: number[] }[] }
    expect(mine.my_current_steps[0]!.return_targets).toEqual([1, 2, 3, 4, 10, 11])
    // 退到廠區經理人：作廢廠區經理人與子公司擔當稽核的核准，分流都不動
    expect(ok(await returnTo(taipei, a, 10))).toEqual({ ok: true, current_step_position: 10, voided: 2 })
    expect(await current(a)).toEqual([10])
    // 子公司擔當稽核的關卡回到還沒輪到，但他簽過（已作廢也算）：仍看得到全部；稽核主管沒輪到過，看不到
    expect(await visibleUnits(EMP.sub, a)).toEqual(unitsOf('mat', 'qa', 'fin', 'prod'))
    expect(await visibleUnits(EMP.chief, a)).toEqual([])
    expect(ok(await approve(await as(EMP.plantMgr), a))).toMatchObject({ current_step_position: 11 })
    expect(ok(await approve(await as(EMP.sub), a))).toMatchObject({ current_step_position: 12 })
    expect(ok(await approve(taipei, a))).toMatchObject({ current_step_position: 13 })

    // 稽核主管：前一關、廠區經理人、各單位的自行檢查人員；不能跳到子公司擔當稽核（Q116 (10)）
    const chief = await as(EMP.chief)
    const chiefs = ok(await chief.from('assessment').select('my_current_steps').eq('id', a).single()) as { my_current_steps: { return_targets: number[] }[] }
    expect(chiefs.my_current_steps[0]!.return_targets).toEqual([1, 2, 3, 4, 10, 12])
    expect(ok(await returnTo(chief, a, 11))).toEqual({ ok: false, error: 'invalid_target' })

    // 稽核主管直接退回品保的自行檢查人員：作廢品保的分流與匯流後全部的核准
    expect(ok(await returnTo(chief, a, 2))).toEqual({ ok: true, current_step_position: 2, voided: 5 })
    expect(await current(a)).toEqual([2])
    expect(await stage(a)).toBe('filling')
    expect(ok(await submit(await as(EMP.qa), a))).toEqual({ ok: true, current_step_position: 6 })
    expect(ok(await approve(await as(EMP.qaMgr), a))).toEqual({ ok: true, closed: false, current_step_position: 10 })
  })

  it('closes after the 稽核主管 approves, and only that last approval says it closes', async () => {
    for (const [who, next] of [[EMP.plantMgr, 11], [EMP.sub, 12], [EMP.taipei, 13]] as const) {
      expect(ok(await approve(await as(who), a))).toEqual({ ok: true, closed: false, current_step_position: next })
    }
    const chief = await as(EMP.chief)
    const mine = ok(await chief.from('assessment').select('my_current_steps').eq('id', a).single()) as { my_current_steps: { closes: boolean }[] }
    expect(mine.my_current_steps.map((s) => s.closes)).toEqual([true])
    expect(ok(await approve(chief, a))).toEqual({ ok: true, closed: true, current_step_position: 13 })
    expect(ok(await admin.from('assessment').select('status,current_step_position').eq('id', a).single())).toEqual({
      status: 'closed', current_step_position: 13,
    })
    expect((await states(a)).every(([, s]) => s === 'done')).toBe(true)
    expect(await stage(a)).toBe('closed')
    // 結案後每個簽核人都看得到全部
    expect(await visibleUnits(EMP.qa, a)).toEqual(unitsOf('mat', 'qa', 'fin', 'prod'))
  })
})

describe('同一人在兩個分流', () => {
  const TWO: typeof FOUR = [
    { name: '自行檢查人員－資材', signer: EMP.both, unit: 'mat', branch: 'mat' },
    { name: '自行檢查人員－品保', signer: EMP.both, unit: 'qa', branch: 'qa' },
    { name: '部門主管－資材', signer: EMP.bothMgr, unit: null, branch: 'mat' },
    { name: '部門主管－品保', signer: EMP.bothMgr, unit: null, branch: 'qa' },
    { name: '廠區經理人', signer: EMP.plantMgr, unit: null, branch: null },
    { name: '台北稽核人員', signer: EMP.chief, unit: null, branch: null, group: 'audit_review' },
    { name: '稽核主管', signer: EMP.chief, unit: null, branch: null, group: 'audit_review' },
  ]
  let a = ''
  let point: Record<string, string> = {}

  beforeAll(async () => {
    ;({ assessmentId: a, point } = await launch('two', ['mat', 'qa'], TWO, YEAR + 1))
  })

  it('lists the 自評表 once on the home page, with both units to answer', async () => {
    const both = await as(EMP.both)
    expect(ok(await both.from('assessment').select('my_editable_units').eq('id', a).single())).toEqual({ my_editable_units: [UNIT.mat, UNIT.qa] })
    ok(await saveUnit(both, a, point, UNIT.qa))
    const row = ok(await both.from('my_assessment').select('my_turn,my_part,my_answered,my_question_count,my_step_position').eq('assessment_id', a))
    expect(row).toEqual([{ my_turn: true, my_part: 'fill', my_answered: 1, my_question_count: 2, my_step_position: 1 }])
    expect(await pending(EMP.both, a)).toEqual([{ step_position: 1, step_name: '自行檢查人員－資材' }])
  })

  it('submits each unit on its own: the given 關卡, or the first one when none is given', async () => {
    const both = await as(EMP.both)
    // 品保已答完、資材還沒：指定品保那一關送出
    expect(ok(await submit(both, a, 2))).toEqual({ ok: true, current_step_position: 4 })
    expect(ok(await both.from('assessment').select('my_editable_units').eq('id', a).single())).toEqual({ my_editable_units: [UNIT.mat] })
    // 不能指定不是自己輪到的關卡
    expect((await submit(both, a, 2)).error?.code).toBe('42501')
    ok(await saveUnit(both, a, point, UNIT.mat))
    // 自己還在答的資材，加上送出的品保；主管只看得到已送出的品保
    expect(await visibleUnits(EMP.both, a)).toEqual(unitsOf('mat', 'qa'))
    expect(await visibleUnits(EMP.bothMgr, a)).toEqual(unitsOf('qa'))
    expect(ok(await submit(both, a))).toEqual({ ok: true, current_step_position: 3 })
  })

  it('lets one 部門主管 approve or return each branch separately', async () => {
    const mgr = await as(EMP.bothMgr)
    const mine = ok(await mgr.from('assessment').select('can_approve,my_current_steps').eq('id', a).single()) as {
      can_approve: boolean; my_current_steps: { position: number; return_targets: number[] }[]
    }
    expect(mine.can_approve).toBe(true)
    expect(mine.my_current_steps.map((s) => [s.position, s.return_targets])).toEqual([[3, [1]], [4, [2]]])
    expect(ok(await mgr.from('my_assessment').select('my_part,my_step_position').eq('assessment_id', a))).toEqual([{ my_part: 'sign', my_step_position: 3 }])

    expect(ok(await approve(mgr, a, 4))).toEqual({ ok: true, closed: false, current_step_position: null })
    expect(ok(await returnTo(mgr, a, 1, 3))).toEqual({ ok: true, current_step_position: 1, voided: 1 })
    expect(await current(a)).toEqual([1])
    // 品保的分流沒有被退回
    expect(await states(a)).toEqual([[1, 'current'], [2, 'done'], [3, 'pending'], [4, 'done'], [5, 'pending'], [6, 'pending'], [7, 'pending']])
    // 資材被退回重填：主管重新送出前看不到，退回的人自己還在答
    expect(await visibleUnits(EMP.bothMgr, a)).toEqual(unitsOf('qa'))
    expect(await visibleUnits(EMP.both, a)).toEqual(unitsOf('mat', 'qa'))
  })
})

describe('一位主管管兩個單位', () => {
  const THREE: typeof FOUR = [
    { name: '自行檢查人員－資材', signer: EMP.mat, unit: 'mat', branch: 'mat' },
    { name: '自行檢查人員－品保', signer: EMP.qa, unit: 'qa', branch: 'qa' },
    { name: '自行檢查人員－財務', signer: EMP.fin, unit: 'fin', branch: 'fin' },
    { name: '部門主管－資材', signer: EMP.bothMgr, unit: null, branch: 'mat' },
    { name: '部門主管－品保', signer: EMP.bothMgr, unit: null, branch: 'qa' },
    { name: '部門主管－財務', signer: EMP.finMgr, unit: null, branch: 'fin' },
    { name: '廠區經理人', signer: EMP.plantMgr, unit: null, branch: null },
    { name: '台北稽核人員', signer: EMP.chief, unit: null, branch: null, group: 'audit_review' },
    { name: '稽核主管', signer: EMP.chief, unit: null, branch: null, group: 'audit_review' },
  ]

  it('sees every submitted unit once either of their units has submitted (Q116 (14))', async () => {
    const { assessmentId: a, point } = await launch('three', ['mat', 'qa', 'fin'], THREE, YEAR + 8)
    ok(await saveUnit(await as(EMP.fin), a, point, UNIT.fin))
    ok(await saveUnit(await as(EMP.mat), a, point, UNIT.mat))
    ok(await submit(await as(EMP.fin), a))
    expect(await visibleUnits(EMP.bothMgr, a)).toEqual([]) // 自己的單位都還沒送出
    ok(await submit(await as(EMP.mat), a))
    // 資材送出了：看得到別人的財務；自己管的品保還沒送出，看不到
    expect(await visibleUnits(EMP.bothMgr, a)).toEqual(unitsOf('mat', 'fin'))
  })
})

describe('可見集合每個查詢只算一次', () => {
  const ANSWERS = ['assessment_answer', 'assessment_conclusion']
  const WITH_ROWS = ['assessment', 'assessment_section', 'assessment_control_point', 'assessment_control_point_unit', 'assessment_step', 'assessment_signoff']
  const armsOf = (table: string) => (ANSWERS.includes(table) ? 2 : 1) // 答案：看得到全部，或分流規則下看得到的單位

  // 這裡的自評表沒有內控文件與內控依據，所以另外兩張只看計畫，不看執行次數。
  it.each([...WITH_ROWS, ...ANSWERS, 'assessment_section_document', 'assessment_control_reference'])(
    'plans every rule of %s as a hash lookup',
    async (table) => {
      const c = await conn()
      await beginAs(c, EMP.outsider)
      try {
        const explained = await c.query(`explain (format json) select * from public.${table}`)
        const filters = planNodes((explained.rows[0]['QUERY PLAN'] as [{ Plan: PlanNode }])[0].Plan).map((n) => n.Filter ?? '')
        expect(new Set(filters.join(' ').match(/hashed SubPlan \d+/g)).size, table).toBe(armsOf(table))
      } finally {
        await c.query('rollback')
      }
    },
  )

  // 看不到任何列的人最容易露餡：每一列都要查過所有規則，答案的第二條也一定會執行。
  it.each([...WITH_ROWS, ...ANSWERS])('builds each set once however many rows of %s it checks', async (table) => {
    const c = await conn()
    const count = (await c.query(`select count(*)::int as n from public.${table}`)).rows[0].n as number
    expect(count, table).toBeGreaterThan(1)
    await beginAs(c, EMP.outsider)
    try {
      const explained = await c.query(`explain (analyze, format json) select * from public.${table}`)
      const plan = (explained.rows[0]['QUERY PLAN'] as [{ Plan: PlanNode }])[0].Plan
      expect(planNodes(plan).filter((n) => n['Subplan Name']).map((n) => n['Actual Loops']), table).toEqual(Array(armsOf(table)).fill(1))
    } finally {
      await c.query('rollback')
    }
  })
})

describe('同時送出、核准、退回', () => {
  const PAIR: typeof FOUR = [
    { name: '自行檢查人員－資材', signer: EMP.mat, unit: 'mat', branch: 'mat' },
    { name: '自行檢查人員－品保', signer: EMP.qa, unit: 'qa', branch: 'qa' },
    { name: '部門主管－資材', signer: EMP.matMgr, unit: null, branch: 'mat' },
    { name: '廠區經理人', signer: EMP.plantMgr, unit: null, branch: null },
    FOUR[11]!,
    FOUR[12]!,
  ]
  let reachable = false

  beforeAll(async () => {
    const probe = await directDb()
    reachable = probe !== null
    await probe?.end()
  })

  async function answered(tag: string, year: number) {
    const launched = await launch(tag, ['mat', 'qa'], PAIR, year)
    ok(await saveUnit(await as(EMP.mat), launched.assessmentId, launched.point, UNIT.mat))
    ok(await saveUnit(await as(EMP.qa), launched.assessmentId, launched.point, UNIT.qa))
    return launched.assessmentId
  }

  it('lets the second of two simultaneous 送出 see the first, so the merge is not lost', async (ctx) => {
    if (!reachable) ctx.skip()
    const a = await answered('race1', YEAR + 2)
    ok(await submit(await as(EMP.mat), a))
    const qa = await conn()
    const matMgr = await conn()

    await beginAs(matMgr, EMP.matMgr)
    expect((await matMgr.query('select public.approve_assessment_step($1) as r', [a])).rows[0].r).toEqual({
      ok: true, closed: false, current_step_position: null,
    })
    await beginAs(qa, EMP.qa)
    const second = qa.query('select public.submit_assessment_step($1) as r', [a])
    expect(await stillWaiting(second)).toBe(true)
    await matMgr.query('commit')
    // 品保等到資材的核准提交後才算：最後一條分流完成，匯流到廠區經理人
    expect((await second).rows[0].r).toEqual({ ok: true, current_step_position: 4 })
    await qa.query('commit')
    expect(await current(a)).toEqual([4])
  })

  it('keeps a 送出 on one branch when a 退回 on another branch commits first', async (ctx) => {
    if (!reachable) ctx.skip()
    const a = await answered('race2', YEAR + 3)
    ok(await submit(await as(EMP.mat), a))
    const matMgr = await conn()
    const qa = await conn()

    await beginAs(matMgr, EMP.matMgr)
    expect((await matMgr.query("select public.return_assessment($1, 1, '重填') as r", [a])).rows[0].r).toMatchObject({ ok: true, voided: 1 })
    await beginAs(qa, EMP.qa)
    const submitted = qa.query('select public.submit_assessment_step($1) as r', [a])
    expect(await stillWaiting(submitted)).toBe(true)
    await matMgr.query('commit')
    expect((await submitted).rows[0].r).toEqual({ ok: true, current_step_position: null })
    await qa.query('commit')
    expect(await states(a)).toEqual([[1, 'current'], [2, 'done'], [3, 'pending'], [4, 'pending'], [5, 'pending'], [6, 'pending']])
  })

  // 兩條分流各有部門主管：資材 1 → 3、品保 2 → 4，匯流到 5 廠區經理人。兩個單位都已送出。
  const MANAGERS: typeof FOUR = [
    ...PAIR.slice(0, 3),
    { name: '部門主管－品保', signer: EMP.qaMgr, unit: null, branch: 'qa' },
    ...PAIR.slice(3),
  ]
  async function atBothManagers(tag: string, year: number) {
    const launched = await launch(tag, ['mat', 'qa'], MANAGERS, year)
    for (const [who, unit] of [[EMP.mat, UNIT.mat], [EMP.qa, UNIT.qa]] as const) {
      const client = await as(who)
      ok(await saveUnit(client, launched.assessmentId, launched.point, unit))
      ok(await submit(client, launched.assessmentId))
    }
    return launched.assessmentId
  }

  it('lets the second of two simultaneous 核准 of the last branches see the first, so they merge', async (ctx) => {
    if (!reachable) ctx.skip()
    const a = await atBothManagers('race3', YEAR + 6)
    const matMgr = await conn()
    const qaMgr = await conn()

    await beginAs(matMgr, EMP.matMgr)
    expect((await matMgr.query('select public.approve_assessment_step($1) as r', [a])).rows[0].r).toEqual({
      ok: true, closed: false, current_step_position: null,
    })
    await beginAs(qaMgr, EMP.qaMgr)
    const second = qaMgr.query('select public.approve_assessment_step($1) as r', [a])
    expect(await stillWaiting(second)).toBe(true)
    await matMgr.query('commit')
    // 品保的核准等資材的提交後才算：兩條分流都完成，匯流到廠區經理人
    expect((await second).rows[0].r).toEqual({ ok: true, closed: false, current_step_position: 5 })
    await qaMgr.query('commit')
    expect(await states(a)).toEqual([[1, 'done'], [2, 'done'], [3, 'done'], [4, 'done'], [5, 'current'], [6, 'pending'], [7, 'pending']])
  })

  it('keeps a 核准 on one branch when a 退回 on another branch commits first, so they do not merge', async (ctx) => {
    if (!reachable) ctx.skip()
    const a = await atBothManagers('race4', YEAR + 7)
    const qaMgr = await conn()
    const matMgr = await conn()

    await beginAs(qaMgr, EMP.qaMgr)
    expect((await qaMgr.query("select public.return_assessment($1, 2, '重填') as r", [a])).rows[0].r).toMatchObject({ ok: true, voided: 1 })
    await beginAs(matMgr, EMP.matMgr)
    const approved = matMgr.query('select public.approve_assessment_step($1) as r', [a])
    expect(await stillWaiting(approved)).toBe(true)
    await qaMgr.query('commit')
    // 資材的核准看得到品保已被退回：資材分流完成，但還在等品保，不匯流
    expect((await approved).rows[0].r).toEqual({ ok: true, closed: false, current_step_position: null })
    await matMgr.query('commit')
    expect(await states(a)).toEqual([[1, 'done'], [2, 'current'], [3, 'done'], [4, 'pending'], [5, 'pending'], [6, 'pending'], [7, 'pending']])
  })
})

describe('轉換清單', () => {
  it('is readable by a 稽核管理者 only', async () => {
    expect((await (await as(EMP.boss)).from('branch_conversion_issue').select('id')).error).toBeNull()
    expect(ok(await (await as(EMP.outsider)).from('branch_conversion_issue').select('id'))).toEqual([])
    expect((await restClient(async () => null).from('branch_conversion_issue').select('id')).error?.code).toBe('42501')
    expect((await (await as(EMP.boss)).from('branch_conversion_issue').insert({ step_position: 1, step_name: 'x', issue: 'unmapped_step' })).error?.code)
      .toBe('42501')
  })

  it('serves the route snapshot with its branches in the page query', async () => {
    const { assessmentId } = await launch('page', ['mat'], [FOUR[0]!, FOUR[4]!, FOUR[9]!, FOUR[11]!, FOUR[12]!], YEAR + 4)
    const page = ok(await (await as(EMP.mat)).from('assessment').select(ASSESSMENT_TREE).eq('id', assessmentId).single()) as unknown as {
      assessment_step: { position: number; branch_unit_name: string | null; state: string }[]
      my_current_steps: { position: number }[]
    }
    expect([...page.assessment_step].sort((x, y) => x.position - y.position).map((s) => [s.position, s.branch_unit_name, s.state])).toEqual([
      [1, UNIT.mat, 'current'], [2, UNIT.mat, 'pending'], [3, null, 'pending'], [4, null, 'pending'], [5, null, 'pending'],
    ])
    expect(page.my_current_steps.map((s) => s.position)).toEqual([1])
  })
})

describe('退回到某單位＝那個單位的自行檢查人員', () => {
  it('targets the branch’s 自行檢查人員 even when another 關卡 of the branch comes before it (Q116 (10))', async (ctx) => {
    const db = await directDb()
    if (!db) ctx.skip()
    try {
      // 資材的分流裡，課長排在自行檢查人員前面（自評表上加簽的結果；流程本身過不了發起檢查，#98，所以發起後才對調）；
      // 退到資材仍是第 2 關，不是分流的第一關。
      const { assessmentId } = await launch(
        'selfcheck',
        ['mat', 'qa'],
        [FOUR[0]!, { name: '課長－資材', signer: EMP.finChief, unit: null, branch: 'mat' }, FOUR[1]!, FOUR[9]!, FOUR[11]!, FOUR[12]!],
        YEAR + 5,
      )
      for (const [from, to] of [[1, 100], [2, 1], [100, 2]]) {
        await db!.query('update public.assessment_step set position = $3 where assessment_id = $1 and position = $2', [assessmentId, from, to])
      }
      await db!.query('select public.refresh_assessment_steps($1)', [assessmentId])
      const { rows } = await db!.query(
        `select s.position, public.return_targets(s) as targets from public.assessment_step s
         where s.assessment_id = $1 and s.branch_unit_name is null order by s.position`,
        [assessmentId],
      )
      expect(rows).toEqual([
        { position: 4, targets: [2, 3] },
        { position: 5, targets: [2, 3, 4] },
        { position: 6, targets: [2, 3, 4, 5] },
      ])
    } finally {
      await db?.end()
    }
  })
})
