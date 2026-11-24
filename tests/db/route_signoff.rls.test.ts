// 資料 API 接縫: 流程編輯器 (#11) × 簽核 (#6)。流程編輯器建、經發起檢查的流程，發起後能照自評表上複製的關卡
// 送出、退回、核准到結案；發起後改流程不影響這張簽核中的自評表 (ADR-0004、Q86(5))。全部走真實 session。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchAssigned, admin, insertRow, loginAs, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest } from './helpers'

const RUN = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A`, checker: `${RUN}B`, manager: `${RUN}C` }
const YEAR = 5000 + Math.floor(Math.random() * 1000)
const FACTORY = `${RUN}P`.toUpperCase()
const ID = { company: '', plant: '', unit: '', template: '', route: '', assessment: '', cp: '' }
let boss: SupabaseClient
let checker: SupabaseClient
let manager: SupabaseClient

beforeAll(async () => {
  await requirePostgrest()
  for (const e of Object.values(EMP)) await loginAs(e, e)
  await promoteToAuditAdmin(EMP.boss)
  boss = await loginAs(EMP.boss, '甲')
  checker = await loginAs(EMP.checker, '乙')
  manager = await loginAs(EMP.manager, '丙')
  ID.company = (await insertRow('company', { name: `${RUN}公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: `${RUN}資材` })).id
  ID.template = await makeTemplate(`${RUN}T`, 'control_activity', FACTORY, [['請購', [['請購是否核准？', ID.unit]]]])
})

afterAll(async () => {
  ok(await admin.from('annual_cycle').delete().eq('year', YEAR))
  ok(await admin.from('approval_route').delete().eq('plant_id', ID.plant))
  ok(await admin.from('questionnaire_template').delete().like('code', `${RUN}%`))
  ok(await admin.from('plant').delete().eq('factory_code', FACTORY))
  ok(await admin.from('company').delete().eq('id', ID.company))
  ok(await admin.from('assessing_unit').delete().eq('id', ID.unit))
})

describe('流程編輯器 → 年度發起 → 簽核', () => {
  it('a route built in the editor launches and signs through to 結案, with a 退回 on the way', async () => {
    const route = ok(await boss.from('approval_route').insert({ template_id: ID.template, plant_id: ID.plant }).select('id').single())
    ID.route = route.id
    for (const step of [
      { name: '自行檢查人員－資材', step_group: 'plant', signer_emp_id: EMP.checker, editable_unit_id: ID.unit },
      { name: '部門主管', step_group: 'plant', signer_emp_id: EMP.manager, editable_unit_id: null },
      { name: '台北稽核人員', step_group: 'audit_review', signer_emp_id: EMP.boss, editable_unit_id: null, link: 'taipei_auditor' },
      { name: '稽核主管', step_group: 'audit_review', signer_emp_id: EMP.boss, editable_unit_id: null, link: 'audit_chief' },
    ]) ok(await boss.rpc('insert_route_step', { p_route_id: ID.route, p_name: step.name, p_step_group: step.step_group, p_signer_emp_id: step.signer_emp_id, p_editable_unit_id: step.editable_unit_id, p_link: step.link ?? null }))
    expect((ok(await boss.from('approval_route').select('launch_check').eq('id', ID.route).single()) as { launch_check: { ready: boolean } }).launch_check.ready).toBe(true)
    expect(ok(await launchAssigned(boss, { p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: ID.template, plant_id: ID.plant }] }))).toMatchObject({ ok: true })
    const a = ok(await boss.from('assessment').select('id,assessment_control_point(id)').eq('template_id', ID.template).single()) as { id: string; assessment_control_point: { id: string }[] }
    ID.assessment = a.id
    ID.cp = a.assessment_control_point[0]!.id

    // 流程在發起後被改：第 2 關改名 —— 簽核中的自評表照舊是發起時的關卡
    const steps = ok(await boss.from('route_step').select('id,name').eq('route_id', ID.route).order('position')) as { id: string; name: string }[]
    ok(await boss.from('route_step').update({ name: '部門主管（改）' }).eq('id', steps[1]!.id))

    const answer = { control_point_id: ID.cp, assessing_unit_name: `${RUN}資材`, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }
    const conclusion = { assessing_unit_name: `${RUN}資材`, conclusion: 'satisfied', exceptions: null }
    ok(await checker.rpc('save_assessment_answers', { p_assessment_id: ID.assessment, p_answers: [answer], p_conclusions: [conclusion] }))
    expect(ok(await checker.rpc('submit_assessment_step', { p_assessment_id: ID.assessment }))).toMatchObject({ ok: true })

    // 第 2 關仍是發起時的主管（不是流程後來換上的人）
    expect((await boss.rpc('approve_assessment_step', { p_assessment_id: ID.assessment })).error?.code).toBe('42501')
    expect(ok(await manager.rpc('return_assessment', { p_assessment_id: ID.assessment, p_to_position: 1, p_reason: '請補充' }))).toMatchObject({ ok: true, current_step_position: 1 })
    expect(ok(await checker.rpc('submit_assessment_step', { p_assessment_id: ID.assessment }))).toMatchObject({ ok: true })
    expect(ok(await manager.rpc('approve_assessment_step', { p_assessment_id: ID.assessment }))).toMatchObject({ ok: true, closed: false })
    expect(ok(await boss.rpc('approve_assessment_step', { p_assessment_id: ID.assessment }))).toMatchObject({ ok: true, closed: false }) // 台北稽核人員
    expect(ok(await boss.rpc('approve_assessment_step', { p_assessment_id: ID.assessment }))).toMatchObject({ ok: true, closed: true }) // 稽核主管
    const done = ok(await boss.from('assessment').select('status').eq('id', ID.assessment).single()) as { status: string }
    expect(done.status).toBe('closed')
  })
})
