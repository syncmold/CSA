// 反向題目（Q148，#233）：範本控制要點可設為反向題；發起時凍結進自評表；送出時反向題答「是」才要填改善措施／補充說明。
// 每次執行建立自己的公司、廠區、自評單位、範本與簽核流程並發起自己的年度作業（31000 區間），結束時全部清掉。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, insertRow, launchAssigned, linkedAuditSteps, loginAs, makeRoute, makeTemplate, promoteToAuditAdmin, requirePostgrest } from './helpers'

const RUN = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { auditAdmin: `${RUN}A`, checker: `${RUN}B`, manager: `${RUN}C`, outsider: `${RUN}D` }
const YEAR = 31000 + Math.floor(Math.random() * 1000)
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = `${RUN}管理`

const ID: Record<string, string> = {}
/** 範本控制要點文字 → 範本上的 id */
const TPL_CP: Record<string, string> = {}
/** 控制要點文字 → 自評表快照上的 id */
const CP: Record<string, string> = {}
let cAssessment = ''
let eAssessment = ''

type Violation = { kind: string; control_point_id?: string; rule: string }
const as = (who: string) => loginAs(who, who)
const ruleOf = (violations: Violation[] | undefined, text: string) =>
  (violations ?? []).filter((v) => v.control_point_id === CP[text]).map((v) => v.rule)

/** 一題完整、一般題不用填改善措施的答案。 */
const COMPLETE = { design: 'has_rule', execution: 'no', satisfaction: 'satisfied', improvement: null }

function save(client: SupabaseClient, assessmentId: string, text: string, fields: object) {
  return client.rpc('save_assessment_answers', {
    p_assessment_id: assessmentId,
    p_answers: [{ control_point_id: CP[text], assessing_unit_name: UNIT, ...COMPLETE, ...fields }],
    p_conclusions: [],
  })
}

/** 存一題答案再送出（一定被擋：另一題沒答或整體結論沒填），回傳這題的違規規則。 */
async function rulesAfter(assessmentId: string, text: string, fields: object) {
  const me = await as(EMP.checker)
  const saved = await save(me, assessmentId, text, fields)
  if (saved.error) throw new Error(`save: ${JSON.stringify(saved.error)}`)
  const { data, error } = await me.rpc('submit_assessment_step', { p_assessment_id: assessmentId })
  expect(error).toBeNull()
  expect(data).toMatchObject({ ok: false, error: 'incomplete' })
  return ruleOf((data as { violations: Violation[] }).violations, text)
}

async function templatePoint(id: string) {
  const { data } = await admin.from('control_point').select('text,code,is_reverse').eq('id', id).single()
  return data as { text: string; code: string | null; is_reverse: boolean }
}

async function fingerprint(templateId: string) {
  const { data } = await admin.from('questionnaire_template').select('content_fingerprint').eq('id', templateId).single()
  return (data as { content_fingerprint: string }).content_fingerprint
}

beforeAll(async () => {
  await requirePostgrest()
  for (const who of Object.values(EMP)) await as(who)
  await promoteToAuditAdmin(EMP.auditAdmin)

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id

  // 控制活動類：反向題 rc、一般題 nc；要素類：反向題 re、一般題 ne
  ID.templateC = await makeTemplate(`${RUN}c`, 'control_activity', FACTORY, [['第一章', [['rc', ID.unit], ['nc', ID.unit]]]])
  ID.templateE = await makeTemplate(`${RUN}e`, 'element', FACTORY, [['要素', [['re', ID.unit], ['ne', ID.unit]]]])
  const { data: points } = await admin
    .from('control_point')
    .select('id,text,template_section!inner(template_id)')
    .in('template_section.template_id', [ID.templateC, ID.templateE])
  for (const p of points!) TPL_CP[p.text] = p.id

  for (const templateId of [ID.templateC, ID.templateE]) {
    await makeRoute(templateId, ID.plant, [
      { name: '自行檢查人員', group: 'plant', signer: EMP.checker, unitId: ID.unit },
      { name: '部門主管', group: 'plant', signer: EMP.manager, unitId: null },
      ...linkedAuditSteps(EMP.auditAdmin),
    ])
  }
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant)
  await admin.from('questionnaire_template').delete().in('id', [ID.templateC, ID.templateE].filter(Boolean))
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
})

describe('範本：設定反向題目', () => {
  it('a control point is not reverse unless someone ticks it', async () => {
    expect((await templatePoint(TPL_CP.nc!)).is_reverse).toBe(false)
  })

  it('lets a template editor tick and untick it from the list, and nobody else', async () => {
    const boss = await as(EMP.auditAdmin)
    expect((await boss.rpc('set_control_point_reverse', { p_control_point_id: TPL_CP.rc, p_is_reverse: true })).error).toBeNull()
    expect((await templatePoint(TPL_CP.rc!)).is_reverse).toBe(true)

    const outsider = await as(EMP.outsider)
    const refused = await outsider.rpc('set_control_point_reverse', { p_control_point_id: TPL_CP.rc, p_is_reverse: false })
    expect(refused.error?.code).toBe('42501')
    expect((await templatePoint(TPL_CP.rc!)).is_reverse).toBe(true)

    // 直接改資料表也不行（範本表沒有寫入授權，只能走函式）
    const direct = await outsider.from('control_point').update({ is_reverse: false }).eq('id', TPL_CP.rc).select()
    expect(direct.data ?? []).toEqual([])
    expect((await templatePoint(TPL_CP.rc!)).is_reverse).toBe(true)
  })

  it('saves it with the edit dialog, and an edit that does not mention it leaves it alone', async () => {
    const boss = await as(EMP.auditAdmin)
    const update = (p_is_reverse?: boolean) =>
      boss.rpc('update_control_point', {
        p_control_point_id: TPL_CP.re, p_text: 're', p_unit_ids: [ID.unit], p_code: null,
        ...(p_is_reverse === undefined ? {} : { p_is_reverse }),
      })
    expect((await update(true)).error).toBeNull()
    expect((await templatePoint(TPL_CP.re!)).is_reverse).toBe(true)
    expect((await update()).error).toBeNull()
    expect((await templatePoint(TPL_CP.re!)).is_reverse).toBe(true)
    expect((await update(false)).error).toBeNull()
    expect((await templatePoint(TPL_CP.re!)).is_reverse).toBe(false)
    expect((await update(true)).error).toBeNull()
  })

  it('creates a control point already reverse, or plain by default', async () => {
    const boss = await as(EMP.auditAdmin)
    const { data: section } = await admin.from('template_section').select('id').eq('template_id', ID.templateC).single()
    const created = await boss.rpc('create_control_point', { p_section_id: section!.id, p_text: '新反向題', p_unit_ids: [ID.unit], p_is_reverse: true })
    expect(created.error).toBeNull()
    expect((await templatePoint(created.data as string)).is_reverse).toBe(true)
    const plain = await boss.rpc('create_control_point', { p_section_id: section!.id, p_text: '新一般題', p_unit_ids: [ID.unit] })
    expect((await templatePoint(plain.data as string)).is_reverse).toBe(false)
    await admin.from('control_point').delete().in('id', [created.data, plain.data])
  })

  it('counts it as content: ticking it changes the template fingerprint, unticking restores it', async () => {
    const boss = await as(EMP.auditAdmin)
    const before = await fingerprint(ID.templateC!)
    await boss.rpc('set_control_point_reverse', { p_control_point_id: TPL_CP.nc, p_is_reverse: true })
    expect(await fingerprint(ID.templateC!)).not.toBe(before)
    await boss.rpc('set_control_point_reverse', { p_control_point_id: TPL_CP.nc, p_is_reverse: false })
    expect(await fingerprint(ID.templateC!)).toBe(before)
  })
})

describe('發起：凍結進自評表', () => {
  beforeAll(async () => {
    const boss = await as(EMP.auditAdmin)
    const launched = await launchAssigned(boss, {
      p_year: YEAR,
      p_due_date: '2099-12-31',
      p_combos: [
        { template_id: ID.templateC, plant_id: ID.plant },
        { template_id: ID.templateE, plant_id: ID.plant },
      ],
    })
    if (launched.error || !(launched.data as { ok: boolean })?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
    const { data: rows } = await admin.from('assessment').select('id,template_id').eq('cycle_id', (launched.data as { cycle_id: string }).cycle_id)
    cAssessment = rows!.find((r) => r.template_id === ID.templateC)!.id
    eAssessment = rows!.find((r) => r.template_id === ID.templateE)!.id
    const { data: points } = await admin.from('assessment_control_point').select('id,text').in('assessment_id', [cAssessment, eAssessment])
    for (const p of points!) CP[p.text] = p.id
  })

  it('copies each control point’s setting into the 自評表', async () => {
    const { data } = await admin.from('assessment_control_point').select('text,is_reverse').in('assessment_id', [cAssessment, eAssessment])
    expect(Object.fromEntries(data!.map((p) => [p.text, p.is_reverse]))).toEqual({ rc: true, nc: false, re: true, ne: false })
  })

  it('lets whoever sees the 自評表 read the setting', async () => {
    const me = await as(EMP.checker)
    const { data, error } = await me.from('assessment_control_point').select('text,is_reverse').eq('assessment_id', cAssessment)
    expect(error).toBeNull()
    expect(data).toEqual(expect.arrayContaining([{ text: 'rc', is_reverse: true }]))
  })

  it('keeps the 自評表 as launched when the template is changed afterwards', async () => {
    const boss = await as(EMP.auditAdmin)
    await boss.rpc('set_control_point_reverse', { p_control_point_id: TPL_CP.rc, p_is_reverse: false })
    const { data } = await admin.from('assessment_control_point').select('is_reverse').eq('id', CP.rc).single()
    expect(data).toEqual({ is_reverse: true })
    await boss.rpc('set_control_point_reverse', { p_control_point_id: TPL_CP.rc, p_is_reverse: true })
  })
})

describe('送出：反向題答「是」才要填', () => {
  it.each([
    ['反向題答「是」', 'rc', { execution: 'yes' }, ['improvement_required']],
    ['反向題答「否」', 'rc', { execution: 'no' }, []],
    ['反向題答「是」並寫了改善措施', 'rc', { execution: 'yes', improvement: '說明' }, []],
    ['反向題答「需要加強」', 'rc', { execution: 'no', satisfaction: 'needs_improvement' }, ['improvement_required']],
    ['反向題答「不滿意」', 'rc', { execution: 'no', satisfaction: 'dissatisfied' }, ['improvement_required']],
    ['反向題答「無內控規範」', 'rc', { execution: 'no', design: 'no_rule' }, ['improvement_required']],
    ['反向題答「不適用」', 'rc', { execution: 'not_applicable' }, []],
    ['一般題答「否」', 'nc', { execution: 'no' }, ['improvement_required']],
    ['一般題答「是」', 'nc', { execution: 'yes' }, []],
  ])('控制活動類 %s', async (_label, text, fields, rules) => {
    expect(await rulesAfter(cAssessment, text, fields)).toEqual(rules)
  })

  it.each([
    ['反向題答「是」', 're', { design: null, execution: 'yes' }, ['improvement_required']],
    ['反向題答「否」', 're', { design: null, execution: 'no' }, []],
    ['一般題答「否」', 'ne', { design: null, execution: 'no' }, ['improvement_required']],
    ['一般題答「是」', 'ne', { design: null, execution: 'yes' }, []],
  ])('要素類 %s', async (_label, text, fields, rules) => {
    expect(await rulesAfter(eAssessment, text, fields)).toEqual(rules)
  })
})
