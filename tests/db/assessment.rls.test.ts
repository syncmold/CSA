// 資料 API 接縫: 簽核流程、年度發起、自評表快照與可見性（工單 #4）。
// 每次執行建立自己的公司、廠區、範本與簽核流程，不依賴開發資料庫裡的種子流程；
// 只讀用到真實的範本 02（52 題），確認發起真的凍結了紙本結構。結束時全部清掉。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ASSESSMENT_TREE } from '../../src/api/assessmentQuery'
import { withCoordinators, launchAssigned, admin, borrowFq02, insertRow, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, releaseFq02, requirePostgrest, restClient, type RouteStepSpec } from './helpers'

// 前綴與隨機尾巴：資料庫測試檔案並行執行，不能和 template.rls.test.ts 的工號撞在同一毫秒。
const RUN = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { auditAdmin: `${RUN}A`, first: `${RUN}B`, second: `${RUN}C`, outsider: `${RUN}D` }
const YEAR = 7000 + Math.floor(Math.random() * 998) // 會用到 YEAR … YEAR + 2
const DUE = '2099-12-31'

const FACTORY = `${RUN}P`.toUpperCase()
const BARE_FACTORY = `${RUN}Q`.toUpperCase() // 沒有任何簽核流程的廠區
const UNIT = { a: `${RUN}甲單位`, b: `${RUN}乙單位` }
const T_CODE = `${RUN}x`

/** 測試範本的內容：[章名, [[控制要點, 自評單位]]] */
const T_SECTIONS: [string, [string, string][]][] = [
  ['第一章', [['要點一', UNIT.a], ['要點二', UNIT.b]]],
  ['第二章', [['要點三', UNIT.a]]],
]
/** 甲、乙兩條分流（同一位自行檢查人員，同時輪到），匯流後是稽核主管。 */
const T_STEPS = [
  { name: '自行檢查人員－甲單位', group: 'plant', signer: EMP.first, unit: UNIT.a },
  { name: '自行檢查人員－乙單位', group: 'plant', signer: EMP.first, unit: UNIT.b },
  { name: '台北稽核人員', group: 'audit_review', signer: EMP.second, unit: null },
  { name: '稽核主管', group: 'audit_review', signer: EMP.second, unit: null },
] as const

// 與頁面同一個 select（src/api/assessmentQuery.ts）：頁面用的查詢形狀也要在 PostgREST 上跑得通。
const TREE = ASSESSMENT_TREE

interface AssessmentTree {
  id: string
  template_code: string
  template_name: string
  template_layout: string
  status: string
  current_step_position: number
  plant: { factory_code: string }
  annual_cycle: { year: number; due_date: string }
  assessment_section: {
    position: number
    name: string
    assessment_control_point: { position: number; text: string; assessment_control_point_unit: { position: number; assessing_unit_name: string }[] }[]
  }[]
  assessment_step: {
    position: number
    name: string
    step_group: string
    signer_emp_id: string
    editable_unit_name: string | null
  }[]
}

const ID: Record<string, string> = {}
let cycleId = ''
let tAssessmentId = ''
let a02AssessmentId = ''
let launched: unknown

/** 關卡的自評單位用名稱寫，建流程時換成 id。 */
const withUnitIds = (steps: readonly { name: string; group: 'plant' | 'audit_review'; signer: string; unit: string | null }[]): RouteStepSpec[] =>
  steps.map((s) => ({ name: s.name, group: s.group, signer: s.signer, unitId: s.unit ? ID[s.unit]! : null }))

async function fetchTree(client: SupabaseClient, id: string) {
  const { data, error } = await client.from('assessment').select(TREE).eq('id', id).returns<AssessmentTree[]>()
  expect(error).toBeNull()
  return data?.[0] ?? null
}

const sorted = <T extends { position: number }>(rows: T[]) => [...rows].sort((a, b) => a.position - b.position)

/** 快照控制要點的自評單位名稱，依作答順序 (#46)。 */
const unitNames = (p: AssessmentTree['assessment_section'][number]['assessment_control_point'][number]) =>
  sorted(p.assessment_control_point_unit).map((u) => u.assessing_unit_name)

/** 這個身分透過 API 讀得到這次發起的哪些東西。 */
async function whatCanSee(client: SupabaseClient) {
  const ids = [tAssessmentId, a02AssessmentId]
  const out: Record<string, unknown[]> = {}
  for (const table of ['assessment', 'assessment_section', 'assessment_control_point', 'assessment_step']) {
    const column = table === 'assessment' ? 'id' : 'assessment_id'
    const { data, error } = await client.from(table).select(column).in(column, ids)
    expect({ table, error }).toEqual({ table, error: null })
    out[table] = data ?? []
  }
  return out
}

beforeAll(async () => {
  await requirePostgrest()
  for (const [who, name] of [[EMP.auditAdmin, '丙'], [EMP.first, '甲'], [EMP.second, '乙'], [EMP.outsider, '丁']] as const) {
    await loginAs(who, name)
  }
  await promoteToAuditAdmin(EMP.auditAdmin)

  const company = await insertRow('company', { name: `${RUN}測試公司` })
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: company.id })).id
  ID.barePlant = (await insertRow('plant', { factory_code: BARE_FACTORY, name: `${RUN}空廠`, company_id: company.id })).id
  ID.company = company.id
  for (const name of Object.values(UNIT)) ID[name] = (await insertRow('assessing_unit', { name })).id

  // 測試範本：只適用測試廠區，所以不會被別的發起動作帶到
  ID.template = await makeTemplate(
    T_CODE,
    'control_activity',
    FACTORY,
    T_SECTIONS.map(([name, points]) => [name, points.map(([text, unit]) => [text, ID[unit]!] as [string, string])]),
  )
  ID.routeT = await makeRoute(ID.template, ID.plant, withUnitIds(T_STEPS))

  // 真實的範本 FQ-02：三個單位各一關自行檢查，最後是稽核主管，簽核人都是稽核主管（要通過發起檢查才能發起）。
  // 它只適用福清（Q111），測試期間借給兩個測試廠區，收尾時還回去。
  ID.template02 = await borrowFq02(FACTORY, BARE_FACTORY)
  const realUnits = ['資材單位', '品保單位', '財會單位']
  const units = await admin.from('assessing_unit').select('id,name').in('name', realUnits)
  if (units.error) throw units.error
  const realUnitId = (name: string) => units.data.find((u) => u.name === name)!.id as string
  ID.route02 = await makeRoute(ID.template02, ID.plant, [
    ...realUnits.map((unit) => ({ name: `自行檢查人員－${unit}`, group: 'plant' as const, signer: EMP.auditAdmin, unitId: realUnitId(unit) })),
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.auditAdmin, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.auditAdmin, unitId: null },
  ])

  const boss = await loginAs(EMP.auditAdmin, '丙')
  const result = await launchAssigned(boss, {
    p_year: YEAR,
    p_due_date: DUE,
    p_combos: [
      { template_id: ID.template, plant_id: ID.plant },
      { template_id: ID.template02, plant_id: ID.plant },
    ],
  })
  expect(result.error).toBeNull()
  launched = result.data
  cycleId = (result.data as { cycle_id: string }).cycle_id
  const rows = await boss.from('assessment').select('id,template_code').eq('cycle_id', cycleId)
  tAssessmentId = rows.data?.find((r) => r.template_code === T_CODE)?.id ?? ''
  a02AssessmentId = rows.data?.find((r) => r.template_code === 'FQ-02')?.id ?? ''
})

afterAll(async () => {
  // 先刪年度作業（連帶自評表），再刪流程、範本、廠區、公司、自評單位
  await admin.from('annual_cycle').delete().in('year', [YEAR, YEAR + 1, YEAR + 2])
  await admin.from('approval_route').delete().in('plant_id', [ID.plant, ID.barePlant].filter(Boolean))
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
  await releaseFq02(FACTORY, BARE_FACTORY)
  await admin.from('plant').delete().in('factory_code', [FACTORY, BARE_FACTORY])
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().in('name', Object.values(UNIT))
})

describe('年度發起: 規則', () => {
  it('launches one 自評表 per 範本 × 廠區 combination', () => {
    expect(launched).toMatchObject({ ok: true, cycle_id: expect.any(String), assessments: 2 })
    expect(tAssessmentId).toBeTruthy()
    expect(a02AssessmentId).toBeTruthy()
  })

  it('only a 稽核管理者 can launch', async () => {
    const signer = await loginAs(EMP.first, '甲')
    const { error } = await launchAssigned(signer, { p_year: YEAR + 1, p_due_date: DUE, p_combos: [] })
    expect(error?.code).toBe('42501')
    const anon = restClient(async () => null)
    const refused = await launchAssigned(anon, { p_year: YEAR + 1, p_due_date: DUE, p_combos: [] })
    expect(refused.error?.code).toBe('42501')
  })

  it('refuses the whole launch and lists the combinations that have no route', async () => {
    const boss = await loginAs(EMP.auditAdmin, '丙')
    // 不給 p_combos＝所有「啟用範本 × 適用廠區」；空廠區沒有流程，所以整體拒絕
    const { data, error } = await withCoordinators([ID.plant!], () => boss.rpc('launch_annual_cycle', { p_year: YEAR + 1, p_due_date: DUE }))
    expect(error).toBeNull()
    const result = data as { ok: boolean; error: string; missing: { template_code: string; factory_code: string }[] }
    expect(result).toMatchObject({ ok: false, error: 'missing_route' })
    const missing = result.missing.map((m) => `${m.template_code}@${m.factory_code}`)
    expect(missing).toContain(`FQ-02@${BARE_FACTORY}`)
    expect(missing).not.toContain(`FQ-02@${FACTORY}`) // 已有流程的組合不在清單裡
    expect(missing).not.toContain(`${T_CODE}@${FACTORY}`)

    const cycles = await admin.from('annual_cycle').select('id').eq('year', YEAR + 1)
    expect(cycles.data).toEqual([]) // 整體拒絕＝什麼都沒建
  })

  it('treats a route without any step as missing: it fails the 發起檢查', async () => {
    const boss = await loginAs(EMP.auditAdmin, '丙')
    const empty = await insertRow('approval_route', { template_id: ID.template02, plant_id: ID.barePlant })
    const { data } = await launchAssigned(boss, {
      p_year: YEAR + 2,
      p_due_date: DUE,
      p_combos: [{ template_id: ID.template02, plant_id: ID.barePlant }],
    })
    expect(data).toMatchObject({ ok: false, error: 'missing_route', missing: [{ route_id: empty.id, problem: 'not_ready', launch_check: { no_steps: true } }] })
    await admin.from('approval_route').delete().eq('id', empty.id)
  })

  it('rejects a combination whose 範本 does not apply to that 廠區', async () => {
    const boss = await loginAs(EMP.auditAdmin, '丙')
    const { data } = await launchAssigned(boss, {
      p_year: YEAR + 2,
      p_due_date: DUE,
      p_combos: [{ template_id: ID.template, plant_id: ID.barePlant }], // 測試範本只適用 FACTORY
    })
    expect(data).toMatchObject({ ok: false, error: 'invalid_combo' })
  })

  it('answers invalid_combo, not an exception, when a combination is malformed', async () => {
    const boss = await loginAs(EMP.auditAdmin, '丙')
    for (const bad of [[{ template_id: 'not-a-uuid', plant_id: ID.plant }], [{ template_id: ID.template }], ['oops'], { template_id: ID.template, plant_id: ID.plant }]) {
      const { data, error } = await launchAssigned(boss, { p_year: YEAR + 2, p_due_date: DUE, p_combos: bad })
      expect({ bad, error }).toEqual({ bad, error: null })
      expect(data).toMatchObject({ ok: false, error: 'invalid_combo' })
    }
  })

  it('refuses a launch with nothing to launch', async () => {
    const boss = await loginAs(EMP.auditAdmin, '丙')
    const { data } = await launchAssigned(boss, { p_year: YEAR + 2, p_due_date: DUE, p_combos: [] })
    expect(data).toMatchObject({ ok: false, error: 'no_combos' })
  })

  it('launches a 範本 × 廠區 only once a year (Q119)', async () => {
    const boss = await loginAs(EMP.auditAdmin, '丙')
    const { data } = await launchAssigned(boss, {
      p_year: YEAR,
      p_due_date: DUE,
      p_combos: [{ template_id: ID.template, plant_id: ID.plant }],
    })
    expect(data).toMatchObject({ ok: false, error: 'already_launched' })
  })
})

describe('自評表快照', () => {
  it('copies the 範本 header, sections, control points and route steps', async () => {
    const boss = await loginAs(EMP.auditAdmin, '丙')
    const a = await fetchTree(boss, tAssessmentId)
    expect(a).toMatchObject({
      template_code: T_CODE,
      template_name: `${T_CODE} 範本`,
      template_layout: 'control_activity',
      status: 'in_progress',
      current_step_position: 1,
      plant: { factory_code: FACTORY },
      annual_cycle: { year: YEAR, due_date: DUE },
    })
    const sections = sorted(a!.assessment_section).map((s) => [
      s.name,
      sorted(s.assessment_control_point).map((p) => [p.text, unitNames(p)]),
    ])
    expect(sections).toEqual(T_SECTIONS.map(([name, points]) => [name, points.map(([text, unit]) => [text, [unit]])]))
    expect(sorted(a!.assessment_step).map((s) => [s.name, s.step_group, s.signer_emp_id, s.editable_unit_name])).toEqual(
      T_STEPS.map((s) => [s.name, s.group, s.signer, s.unit]),
    )
  })

  it('freezes the real 範本 02: 8 sections, 52 control points in paper order', async () => {
    const boss = await loginAs(EMP.auditAdmin, '丙')
    const a = await fetchTree(boss, a02AssessmentId)
    const sections = sorted(a!.assessment_section)
    expect(sections.map((s) => [s.name, s.assessment_control_point.length])).toEqual([
      ['供應商管理作業', 4],
      ['請、採購作業(適用於各請、採購類型)', 9],
      ['到貨追蹤作業', 2],
      ['驗收作業(適用於各請、採購類型)', 11],
      ['應付帳款作業', 5],
      ['付款作業', 10],
      ['預支(暫付款)作業', 6],
      ['現金支出作業', 5],
    ])
    const perUnit: Record<string, number> = {}
    for (const p of sections.flatMap((s) => s.assessment_control_point)) {
      for (const name of unitNames(p)) perUnit[name] = (perUnit[name] ?? 0) + 1
    }
    expect(perUnit).toEqual({ 資材單位: 26, 品保單位: 3, 財會單位: 23 })
  })

  it('does not change when the 範本 or the route is edited afterwards', async () => {
    const boss = await loginAs(EMP.auditAdmin, '丙')
    const before = await fetchTree(boss, tAssessmentId)

    // 範本被改：換字、改章名、加一章、改自評單位、刪一題、刪一章（連帶它的題）；流程被改：換人、改關卡名
    const section = await admin.from('template_section').select('id').eq('template_id', ID.template).eq('position', 1).single()
    const first = ok(
      await admin.from('control_point').update({ text: '被改過的要點' }).eq('section_id', section.data!.id).eq('position', 1).select('id').single<{ id: string }>(),
    )
    ok(await admin.from('control_point_unit').update({ assessing_unit_id: ID[UNIT.b] }).eq('control_point_id', first.id).select())
    await admin.from('template_section').update({ name: '被改過的章' }).eq('id', section.data!.id)
    await insertRow('template_section', { template_id: ID.template, position: 3, name: '新增的章' })
    await admin.from('control_point').delete().eq('section_id', section.data!.id).eq('position', 2)
    await admin.from('template_section').delete().eq('template_id', ID.template).eq('position', 2)
    await admin.from('questionnaire_template').update({ name: '改名後的範本' }).eq('id', ID.template)
    await admin.from('route_step').update({ name: '改名的關卡' }).eq('route_id', ID.routeT)
    await admin.from('route_step').update({ signer_emp_id: EMP.outsider }).eq('route_id', ID.routeT).eq('step_group', 'audit_review')

    expect(await fetchTree(boss, tAssessmentId)).toEqual(before)
  })
})

describe('自評表可見性', () => {
  it('shows the first signer the 自評表 read-only, with the current step and signer', async () => {
    const me = await loginAs(EMP.first, '甲')
    const a = await fetchTree(me, tAssessmentId)
    expect(a?.id).toBe(tAssessmentId)
    expect(a?.current_step_position).toBe(1)
    const current = a!.assessment_step.find((s) => s.position === a!.current_step_position)
    expect(current).toMatchObject({ name: T_STEPS[0].name, signer_emp_id: EMP.first })
    expect(a!.assessment_section.flatMap((s) => s.assessment_control_point)).toHaveLength(3)

    // 唯讀: 沒有任何寫入授權
    const edit = await me.from('assessment_control_point').update({ text: '偷改' }).eq('assessment_id', tAssessmentId)
    expect(edit.error?.code).toBe('42501')
    const advance = await me.from('assessment_step').update({ state: 'done' }).eq('assessment_id', tAssessmentId)
    expect(advance.error?.code).toBe('42501')
  })

  it('lists the 自評表 under 我的待簽 only for whoever holds the current step', async () => {
    const view = (client: SupabaseClient) =>
      client.from('my_pending_assessment').select('assessment_id,template_code,step_position,step_name,factory_code,year').in('assessment_id', [tAssessmentId, a02AssessmentId])

    const first = await view(await loginAs(EMP.first, '甲'))
    expect(first.error).toBeNull()
    expect(first.data).toEqual([
      { assessment_id: tAssessmentId, template_code: T_CODE, step_position: 1, step_name: T_STEPS[0].name, factory_code: FACTORY, year: YEAR },
    ])

    // 稽核管理者看得到全部自評表，但「我的待簽」只列輪到自己的
    const boss = await view(await loginAs(EMP.auditAdmin, '丙'))
    expect(boss.data?.map((r) => r.assessment_id)).toEqual([a02AssessmentId])

    for (const who of [EMP.second, EMP.outsider]) {
      const none = await view(await loginAs(who, '某人'))
      expect({ who, error: none.error, rows: none.data }).toEqual({ who, error: null, rows: [] })
    }
  })

  it('hides the 自評表 from a later-step signer and from anyone not on the route, even through the API', async () => {
    for (const who of [EMP.second, EMP.outsider]) {
      const seen = await whatCanSee(await loginAs(who, '某人'))
      expect({ who, seen }).toEqual({ who, seen: { assessment: [], assessment_section: [], assessment_control_point: [], assessment_step: [] } })
    }
  })

  it('shows a 稽核管理者 everything and nobody else the route definitions', async () => {
    const boss = await whatCanSee(await loginAs(EMP.auditAdmin, '丙'))
    expect(boss.assessment).toHaveLength(2)
    expect(boss.assessment_section).toHaveLength(2 + 8)
    expect(boss.assessment_control_point).toHaveLength(3 + 52)
    expect(boss.assessment_step).toHaveLength(4 + 5)

    const bossClient = await loginAs(EMP.auditAdmin, '丙')
    const routes = await bossClient.from('route_step').select('id').eq('route_id', ID.routeT)
    expect(routes.data).toHaveLength(4)
    for (const who of [EMP.first, EMP.second]) {
      const me = await loginAs(who, '某人')
      for (const table of ['approval_route', 'route_step']) {
        const { data, error } = await me.from(table).select('id')
        expect({ who, table, error, rows: data }).toEqual({ who, table, error: null, rows: [] })
      }
    }
  })

  it('refuses anonymous requests and any write through the API, even from a 稽核管理者', async () => {
    const anon = restClient(async () => null)
    for (const table of ['assessment', 'assessment_step', 'approval_route']) {
      expect((await anon.from(table).select('id')).error?.code).toBe('42501')
    }
    const boss = await loginAs(EMP.auditAdmin, '丙')
    expect((await boss.from('assessment').update({ status: 'closed' }).eq('id', tAssessmentId)).error?.code).toBe('42501')
    expect((await boss.from('assessment_step').delete().eq('assessment_id', tAssessmentId)).error?.code).toBe('42501')
    expect((await boss.from('annual_cycle').insert({ year: YEAR + 2, due_date: DUE })).error?.code).toBe('42501')
    expect((await boss.from('plant').insert({ factory_code: `${RUN}Z`, name: 'x', company_id: ID.company })).error?.code).toBe('42501')
  })

  it('follows the current step: once it moves on, the next signer sees the 自評表 and the one who signed still does', async () => {
    // 推進的函式是 #6／#97；這裡用 service_role 模擬兩條分流都完成、匯流到稽核主管
    expect((await admin.from('assessment_step').update({ state: 'done' }).eq('assessment_id', tAssessmentId).lt('position', 3)).error).toBeNull()
    expect((await admin.from('assessment_step').update({ state: 'current' }).eq('assessment_id', tAssessmentId).eq('position', 3)).error).toBeNull()

    const second = await loginAs(EMP.second, '乙')
    expect((await fetchTree(second, tAssessmentId))?.current_step_position).toBe(3)
    // 2026-10-15 決定：已簽過的關卡簽核人仍看得到（要看歷程、匯 PDF）；不在流程裡的人仍然看不到。
    const first = await loginAs(EMP.first, '甲')
    expect((await fetchTree(first, tAssessmentId))?.id).toBe(tAssessmentId)
    const outsider = await loginAs(EMP.outsider, '丁')
    expect(await fetchTree(outsider, tAssessmentId)).toBeNull()
    // 但「我的待簽」只列正在輪到的人
    const pending = await first.from('my_pending_assessment').select('assessment_id').eq('assessment_id', tAssessmentId)
    expect(pending.data).toEqual([])
  })
})
