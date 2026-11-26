// 資料 API 接縫: 一個控制要點多個自評單位（工單 #46、Q92）。範本的寫入以稽核管理者、答題以各關卡簽核人的
// CSA session 走 PostgREST；service_role 只用來準備與清理。每次執行建立自己的公司、廠區、範本與自評單位，結束時清掉。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchAssigned, admin, insertRow, linkedAuditSteps, loginAs, makeRoute, ok, promoteToAuditAdmin, requirePostgrest, unlistPeople } from './helpers'

const RUN = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A`, quality: `${RUN}Q`, production: `${RUN}P`, manager: `${RUN}M` }
const YEAR = 15000 + Math.floor(Math.random() * 1000)
const FACTORY = `${RUN}F`.toUpperCase()
const UNIT = { quality: `${RUN}品保`, production: `${RUN}生產`, materials: `${RUN}資材` }

const ID: Record<string, string> = {}
const createdTemplates: string[] = []
let boss: SupabaseClient

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.boss, '甲')
  await promoteToAuditAdmin(EMP.boss)
  boss = await loginAs(EMP.boss, '甲')

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  for (const name of Object.values(UNIT)) ID[name] = (await insertRow('assessing_unit', { name })).id
})

afterAll(async () => {
  await unlistPeople(RUN) // 排進關卡時加進放行名單的人（Q150）
  await admin.from('annual_cycle').delete().gte('year', 15000).lt('year', 16000)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant ?? '')
  if (createdTemplates.length) await admin.from('questionnaire_template').delete().in('id', createdTemplates)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().in('name', Object.values(UNIT))
})

/** A 稽核主管's new template (create_template; new templates are active, Q137 (5)) with one section; returns the section id. */
async function templateWithSection(code: string, layout: 'control_activity' | 'element') {
  const templateId = ok(
    await boss.rpc('create_template', {
      p_code: `${RUN}${code}`, p_name: `${code} 範本`, p_component: layout === 'control_activity' ? 'control_activities' : 'control_environment',
      p_all_plants: false, p_factory_codes: [FACTORY],
    }),
  ) as string
  createdTemplates.push(templateId)
  const section = ok(await boss.from('template_section').insert({ template_id: templateId, name: '物料標示' }).select('id').single<{ id: string }>())
  return { templateId, sectionId: section.id }
}

/** A control point's 自評單位 names, in their order. */
async function unitsOf(pointId: string): Promise<string[]> {
  const row = ok(
    await boss
      .from('control_point')
      .select('control_point_unit(position,assessing_unit(name))')
      .eq('id', pointId)
      .single<{ control_point_unit: { position: number; assessing_unit: { name: string } }[] }>(),
  )
  return [...row.control_point_unit].sort((a, b) => a.position - b.position).map((u) => u.assessing_unit.name)
}

describe('範本: 控制要點掛一組有順序的自評單位', () => {
  it('saves a control point with its 自評單位 in the given order, and replaces them on update', async () => {
    const { sectionId } = await templateWithSection('T1', 'control_activity')
    const id = ok(
      await boss.rpc('create_control_point', {
        p_section_id: sectionId,
        p_text: '製程階段之物料標示是否依既定之作業程序確實遵循？',
        p_unit_ids: [ID[UNIT.quality], ID[UNIT.production], ID[UNIT.materials]],
      }),
    ) as string
    expect(await unitsOf(id)).toEqual([UNIT.quality, UNIT.production, UNIT.materials])

    ok(await boss.rpc('update_control_point', { p_control_point_id: id, p_text: '改過', p_unit_ids: [ID[UNIT.materials], ID[UNIT.quality]] }))
    expect(await unitsOf(id)).toEqual([UNIT.materials, UNIT.quality])
  })

  it('requires at least one 自評單位 on 控制活動類, not even a direct insert gets around it', async () => {
    const { sectionId } = await templateWithSection('T2', 'control_activity')
    const none = await boss.rpc('create_control_point', { p_section_id: sectionId, p_text: '沒有單位', p_unit_ids: [] })
    expect(none.error?.code).toBe('23514')

    const id = ok(await boss.rpc('create_control_point', { p_section_id: sectionId, p_text: '有單位', p_unit_ids: [ID[UNIT.quality]] })) as string
    const cleared = await boss.rpc('update_control_point', { p_control_point_id: id, p_text: '有單位', p_unit_ids: [] })
    expect(cleared.error?.code).toBe('23514')
    expect(await unitsOf(id)).toEqual([UNIT.quality])

  })

  it('writes text and 自評單位 only together: a 稽核管理者 cannot insert or edit a control point directly (Q92)', async () => {
    const { sectionId } = await templateWithSection('T7', 'element')
    const id = ok(await boss.rpc('create_control_point', { p_section_id: sectionId, p_text: '原文', p_unit_ids: [ID[UNIT.quality]] })) as string
    expect((await boss.from('control_point').insert({ section_id: sectionId, text: '直接新增' })).error?.code).toBe('42501')
    expect((await boss.from('control_point').update({ text: '直接改' }).eq('id', id)).error?.code).toBe('42501')
    expect(ok(await admin.from('control_point').select('text').eq('section_id', sectionId))).toEqual([{ text: '原文' }])
    // 刪除照舊可以直接刪（範本管理的刪除鈕）。
    ok(await boss.from('control_point').delete().eq('id', id))
    expect(ok(await admin.from('control_point').select('id').eq('section_id', sectionId))).toEqual([])
  })

  it('lets 要素類 control points have no 自評單位, or several', async () => {
    const { sectionId } = await templateWithSection('T3', 'element')
    const none = ok(await boss.rpc('create_control_point', { p_section_id: sectionId, p_text: '沒有單位', p_unit_ids: [] })) as string
    const two = ok(
      await boss.rpc('create_control_point', { p_section_id: sectionId, p_text: '兩個單位', p_unit_ids: [ID[UNIT.production], ID[UNIT.quality]] }),
    ) as string
    expect(await unitsOf(none)).toEqual([])
    expect(await unitsOf(two)).toEqual([UNIT.production, UNIT.quality])
  })

  it('refuses the same 自評單位 twice on one control point, and a signer altogether', async () => {
    const { sectionId } = await templateWithSection('T4', 'control_activity')
    const twice = await boss.rpc('create_control_point', {
      p_section_id: sectionId, p_text: '重複', p_unit_ids: [ID[UNIT.quality], ID[UNIT.quality]],
    })
    expect(twice.error?.code).toBe('23505')

    const signer = await loginAs(EMP.quality, '乙')
    const refused = await signer.rpc('create_control_point', { p_section_id: sectionId, p_text: '越權', p_unit_ids: [ID[UNIT.quality]] })
    expect(refused.error?.code).toBe('42501')
    expect(ok(await admin.from('control_point').select('id').eq('section_id', sectionId))).toEqual([])
  })
})

describe('流程發起檢查: 自評單位改從控制要點的單位清單取', () => {
  it('lists the 自評單位 of a multi-unit control point that no 關卡 covers yet', async () => {
    const { templateId, sectionId } = await templateWithSection('T5', 'control_activity')
    ok(await boss.rpc('create_control_point', { p_section_id: sectionId, p_text: '單一', p_unit_ids: [ID[UNIT.materials]] }))
    ok(
      await boss.rpc('create_control_point', {
        p_section_id: sectionId, p_text: '多單位', p_unit_ids: [ID[UNIT.quality], ID[UNIT.production]],
      }),
    )
    const route = await makeRoute(templateId, ID.plant!, [
      { name: '自行檢查人員－資材', group: 'plant', signer: EMP.quality, unitId: ID[UNIT.materials]! },
      { name: '自行檢查人員－品保', group: 'plant', signer: EMP.quality, unitId: ID[UNIT.quality]! },
      { name: '部門主管', group: 'plant', signer: EMP.manager, unitId: null },
      { name: '台北稽核人員', group: 'audit_review', signer: EMP.manager, unitId: null },
      { name: '稽核主管', group: 'audit_review', signer: EMP.manager, unitId: null },
    ])
    const read = async () =>
      ok(await boss.from('approval_route').select('launch_check').eq('id', route).single<{ launch_check: { ready: boolean; missing_units: { name: string }[] } }>())
        .launch_check
    expect((await read()).missing_units.map((u) => u.name)).toEqual([UNIT.production])

    // 插在第 3 關：後面三關各往後挪一位（由後往前，位置不撞）
    for (const position of [5, 4, 3]) ok(await admin.from('route_step').update({ position: position + 1 }).eq('route_id', route).eq('position', position))
    await insertRow('route_step', {
      route_id: route, position: 3, name: '自行檢查人員－生產', step_group: 'plant', signer_emp_id: EMP.quality, editable_unit_id: ID[UNIT.production],
    })
    expect(await read()).toMatchObject({ ready: true, missing_units: [] })
  })
})

describe('自評表: 每個自評單位各答自己那一列', () => {
  const FULL = { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }
  let assessmentId: string
  let points: { id: string; position: number; text: string; assessment_control_point_unit: { position: number; assessing_unit_name: string }[] }[]
  let quality: SupabaseClient
  let production: SupabaseClient

  beforeAll(async () => {
    const { templateId, sectionId } = await templateWithSection('T6', 'control_activity')
    ok(await boss.rpc('create_control_point', { p_section_id: sectionId, p_text: '單一', p_unit_ids: [ID[UNIT.materials]] }))
    ok(
      await boss.rpc('create_control_point', {
        p_section_id: sectionId, p_text: '多單位', p_unit_ids: [ID[UNIT.quality], ID[UNIT.production]],
      }),
    )
    await makeRoute(templateId, ID.plant!, [
      { name: '自行檢查人員－品保', group: 'plant', signer: EMP.quality, unitId: ID[UNIT.quality]! },
      { name: '自行檢查人員－生產', group: 'plant', signer: EMP.production, unitId: ID[UNIT.production]! },
      { name: '自行檢查人員－資材', group: 'plant', signer: EMP.production, unitId: ID[UNIT.materials]! },
      { name: '部門主管', group: 'plant', signer: EMP.manager, unitId: null },
      ...linkedAuditSteps(EMP.manager),
    ])
    const launched = ok(
      await launchAssigned(boss, { p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: templateId, plant_id: ID.plant }] }),
    ) as { ok: boolean }
    expect(launched).toMatchObject({ ok: true })
    assessmentId = ok(await admin.from('assessment').select('id').eq('template_id', templateId).single<{ id: string }>()).id

    quality = await loginAs(EMP.quality, '乙')
    production = await loginAs(EMP.production, '丁')
    points = ok(
      await quality
        .from('assessment_control_point')
        .select('id,position,text,assessment_control_point_unit(position,assessing_unit_name)')
        .eq('assessment_id', assessmentId)
        .order('position'),
    )
  })

  const save = (client: SupabaseClient, pointId: string, unit: string, answer: object = FULL) =>
    client.rpc('save_assessment_answers', {
      p_assessment_id: assessmentId,
      p_answers: [{ control_point_id: pointId, assessing_unit_name: unit, ...answer }],
      p_conclusions: [],
    })

  it('freezes each control point with its 自評單位 in order, numbered by control point', () => {
    expect(
      points.map((p) => [
        p.position,
        p.text,
        [...p.assessment_control_point_unit].sort((a, b) => a.position - b.position).map((u) => u.assessing_unit_name),
      ]),
    ).toEqual([
      [1, '單一', [UNIT.materials]],
      [2, '多單位', [UNIT.quality, UNIT.production]],
    ])
  })

  it('lets each 自行檢查人員 answer only their own unit row of a multi-unit control point, at the same time', async () => {
    const multi = points[1]!.id
    ok(await save(quality, multi, UNIT.quality))
    expect((await save(quality, multi, UNIT.production)).error?.code).toBe('42501')
    expect((await save(quality, points[0]!.id, UNIT.materials)).error?.code).toBe('42501')
    // 分流並行（Q116）：生產不必等品保送出，同時答自己那一列
    ok(await save(production, multi, UNIT.production, { ...FULL, execution: 'no', improvement: '改善中' }))

    // 還沒送出的單位彼此看不到對方的答案（Q116 (9)）
    const seen = async (client: SupabaseClient) =>
      ok(await client.from('assessment_answer').select('control_point_id,assessing_unit_name,execution').eq('assessment_id', assessmentId))
    expect(await seen(quality)).toEqual([{ control_point_id: multi, assessing_unit_name: UNIT.quality, execution: 'yes' }])
    expect(await seen(production)).toEqual([{ control_point_id: multi, assessing_unit_name: UNIT.production, execution: 'no' }])
  })

  it('validates only the submitting unit\'s rows, and the next unit then answers its row', async () => {
    const multi = points[1]!.id
    ok(
      await quality.rpc('save_assessment_answers', {
        p_assessment_id: assessmentId,
        p_answers: [],
        p_conclusions: [{ assessing_unit_name: UNIT.quality, conclusion: 'satisfied', exceptions: null }],
      }),
    )
    // 品保的分流只有這一關，其他單位還在答，所以還沒有下一關
    expect(ok(await quality.rpc('submit_assessment_step', { p_assessment_id: assessmentId }))).toEqual({ ok: true, current_step_position: null })

    type Incomplete = { violations: { kind: string; control_point_id?: string; position?: number; rule: string }[] }
    const pointViolations = async (stepPosition: number) =>
      (ok(await production.rpc('submit_assessment_step', { p_assessment_id: assessmentId, p_step_position: stepPosition })) as Incomplete)
        .violations.filter((v) => v.kind === 'control_point')
    // 同一人的兩個單位各自送出、各自驗證：生產那一列已答完，資材那一題還沒答
    expect(await pointViolations(2)).toEqual([])
    expect(await pointViolations(3)).toEqual([expect.objectContaining({ control_point_id: points[0]!.id, position: 1, rule: 'unanswered' })])
    expect((await save(production, multi, UNIT.quality)).error?.code).toBe('42501')
  })
})
