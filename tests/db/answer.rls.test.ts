// 資料 API 接縫: 自行檢查人員答題——可編輯範圍、暫存、送出驗證與推進（工單 #5）。
// 每次執行建立自己的公司、廠區、自評單位、範本與簽核流程並發起自己的年度作業，結束時全部清掉。
// 同一個檔案裡的測試依序執行，而且共用同一張自評表：先驗範圍與暫存，再驗送出被擋，最後才送出推進。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ASSESSMENT_TREE } from '../../src/api/assessmentQuery'
import { launchAssigned, admin, insertRow, loginAs, linkedAuditSteps, makeRoute, makeTemplate, promoteToAuditAdmin, requirePostgrest, restClient, type TemplateSections, unlistPeople } from './helpers'

const RUN = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { auditAdmin: `${RUN}A`, checker: `${RUN}B`, checkerB: `${RUN}E`, manager: `${RUN}C`, outsider: `${RUN}D` }
const NAME: Record<string, string> = {
  [EMP.auditAdmin]: '丙', [EMP.checker]: '乙', [EMP.checkerB]: '己', [EMP.manager]: '丁', [EMP.outsider]: '戊',
}
const YEAR = 4000 + Math.floor(Math.random() * 1000)
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = { a: `${RUN}資材`, b: `${RUN}品保` }

/** 控制活動類測試範本：第一章 [p1 資材, p2 品保]，第二章 [p3 資材, p4 資材]。 */
const T_SECTIONS: [string, [string, string][]][] = [
  ['第一章', [['p1', UNIT.a], ['p2', UNIT.b]]],
  ['第二章', [['p3', UNIT.a], ['p4', UNIT.a]]],
]
/**
 * 資材、品保兩條分流（各只有自行檢查人員一關）同時作答，都送出後匯流到部門主管。同一人兼任兩個單位的情形
 * 在 parallel_branches.rls.test.ts。
 */
const T_STEPS = [
  { name: '自行檢查人員－資材', signer: EMP.checker, unit: UNIT.a },
  { name: '自行檢查人員－品保', signer: EMP.checkerB, unit: UNIT.b },
  { name: '部門主管', signer: EMP.manager, unit: null },
]

const ID: Record<string, string> = {}
const CP: Record<string, string> = {} // 控制要點文字 → 自評表快照上的 id
const CP_UNIT: Record<string, string> = {} // 控制要點文字 → 快照上它的（唯一一個）自評單位名稱
let tAssessment = ''
let eAssessment = ''
let lAssessment = ''

/** 一題完整、不需改善措施的答案。 */
const COMPLETE = { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }

/** 一題答案：快照控制要點 × 它的自評單位 (#46)，加上作答欄位。 */
const answer = (text: string, fields: object = COMPLETE) => ({ control_point_id: CP[text], assessing_unit_name: CP_UNIT[text], ...fields })

/** 測試裡的自評單位寫名稱；建範本與流程時換成 id。 */
const unitId = (name: string) => ID[name]!

function template(code: string, layout: 'control_activity' | 'element', sections: [string, [string, string][]][]) {
  const withIds: TemplateSections = sections.map(([name, points]) => [name, points.map(([text, unit]) => [text, unitId(unit)])])
  return makeTemplate(code, layout, FACTORY, withIds)
}

function route(templateId: string, steps: { name: string; signer: string; unit: string | null }[]) {
  return makeRoute(templateId, ID.plant!, [
    ...steps.map((s) => ({ name: s.name, group: 'plant' as const, signer: s.signer, unitId: s.unit ? unitId(s.unit) : null })),
    ...linkedAuditSteps(EMP.auditAdmin),
  ])
}

const as = (who: string) => loginAs(who, NAME[who] ?? who)

function save(client: SupabaseClient, answers: object[], conclusions: object[] = [], assessmentId = tAssessment) {
  return client.rpc('save_assessment_answers', { p_assessment_id: assessmentId, p_answers: answers, p_conclusions: conclusions })
}

function submit(client: SupabaseClient, assessmentId = tAssessment) {
  return client.rpc('submit_assessment_step', { p_assessment_id: assessmentId })
}

async function currentStep(assessmentId = tAssessment) {
  const { data } = await admin.from('assessment').select('current_step_position,status').eq('id', assessmentId).single()
  return data as { current_step_position: number; status: string }
}

async function answerOf(text: string) {
  const { data } = await admin.from('assessment_answer').select('design,execution,satisfaction,improvement,updated_by').eq('control_point_id', CP[text]).maybeSingle()
  return data
}

beforeAll(async () => {
  await requirePostgrest()
  for (const who of Object.values(EMP)) await as(who)
  await promoteToAuditAdmin(EMP.auditAdmin)

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  for (const name of Object.values(UNIT)) ID[name] = (await insertRow('assessing_unit', { name })).id

  ID.templateT = await template(`${RUN}t`, 'control_activity', T_SECTIONS)
  await route(ID.templateT, T_STEPS)
  // 要素類範本：一題，自行檢查人員之後是部門主管
  ID.templateE = await template(`${RUN}e`, 'element', [['要素', [['e1', UNIT.a]]]])
  await route(ID.templateE, [T_STEPS[0]!, T_STEPS[2]!])
  // 流程設錯（自行檢查人員排在最後一關）的自評表：發起檢查不通過、發起也擋下這種流程 (Q86、Q89)，
  // 所以照正確的流程發起，發起後再拿掉自評表上的最後一關（見下方）
  ID.templateL = await template(`${RUN}l`, 'control_activity', [['唯一一章', [['l1', UNIT.a]]]])
  await route(ID.templateL, [T_STEPS[0]!, T_STEPS[2]!])

  const boss = await as(EMP.auditAdmin)
  const launched = await launchAssigned(boss, {
    p_year: YEAR,
    p_due_date: '2099-12-31',
    p_combos: [
      { template_id: ID.templateT, plant_id: ID.plant },
      { template_id: ID.templateE, plant_id: ID.plant },
      { template_id: ID.templateL, plant_id: ID.plant },
    ],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  const { data: rows } = await admin.from('assessment').select('id,template_id').eq('cycle_id', launched.data.cycle_id)
  tAssessment = rows!.find((r) => r.template_id === ID.templateT)!.id
  eAssessment = rows!.find((r) => r.template_id === ID.templateE)!.id
  lAssessment = rows!.find((r) => r.template_id === ID.templateL)!.id
  const cut = await admin.from('assessment_step').delete().eq('assessment_id', lAssessment).gte('position', 2)
  if (cut.error) throw new Error(`cut last step: ${JSON.stringify(cut.error)}`)
  const { data: points } = await admin
    .from('assessment_control_point')
    .select('id,text,assessment_control_point_unit(assessing_unit_name)')
    .in('assessment_id', [tAssessment, eAssessment, lAssessment])
  for (const p of points!) {
    CP[p.text] = p.id
    CP_UNIT[p.text] = p.assessment_control_point_unit[0]!.assessing_unit_name
  }
})

afterAll(async () => {
  await unlistPeople(RUN) // 排進關卡時加進放行名單的人（Q150）
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant)
  await admin.from('questionnaire_template').delete().in('id', [ID.templateT, ID.templateE, ID.templateL].filter(Boolean))
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().in('name', Object.values(UNIT))
})

describe('可編輯範圍', () => {
  it('lets the current 自行檢查人員 save the control points and 整體結論 of their own 自評單位', async () => {
    const me = await as(EMP.checker)
    const { data, error } = await save(me, [answer('p1')], [{ assessing_unit_name: UNIT.a, conclusion: 'satisfied' }])
    expect(error).toBeNull()
    expect(data).toEqual({ ok: true, answers: 1, conclusions: 1 })
    expect(await answerOf('p1')).toMatchObject({ ...COMPLETE, updated_by: EMP.checker })
  })

  it('refuses a write to another 自評單位, through the save function or straight into the table, and writes nothing', async () => {
    const me = await as(EMP.checker)
    // 資材的自行檢查人員寫品保的控制要點；同一次呼叫裡合法的 p1 也不能寫進去
    const mixed = await save(me, [answer('p1', { ...COMPLETE, improvement: '不該被寫入' }), answer('p2')])
    expect(mixed.error?.code).toBe('42501')
    expect((await answerOf('p1'))?.improvement).toBeNull()
    expect(await answerOf('p2')).toBeNull()

    const direct = await me.from('assessment_answer').insert({ ...answer('p2'), assessment_id: tAssessment })
    expect(direct.error?.code).toBe('42501')
    const conclusion = await save(me, [], [{ assessing_unit_name: UNIT.b, conclusion: 'satisfied' }])
    expect(conclusion.error?.code).toBe('42501')
    const deleted = await me.from('assessment_answer').delete().eq('control_point_id', CP.p1)
    expect(deleted.error?.code).toBe('42501')
  })

  it('refuses every write from a later signer, the 稽核管理者, an outsider and anonymous callers', async () => {
    for (const who of [EMP.manager, EMP.auditAdmin, EMP.outsider]) {
      const { error } = await save(await as(who), [answer('p1')])
      expect({ who, code: error?.code }).toEqual({ who, code: '42501' })
    }
    const anon = restClient(async () => null)
    expect((await save(anon, [answer('p1')])).error?.code).toBe('42501')
  })

  it('records who wrote an answer from the session, not from what the caller sends', async () => {
    const me = await as(EMP.checker)
    const { error } = await me
      .from('assessment_answer')
      .upsert({ ...answer('p3', { execution: 'yes' }), assessment_id: tAssessment, updated_by: EMP.manager })
    expect(error).toBeNull()
    expect((await answerOf('p3'))?.updated_by).toBe(EMP.checker)
  })

  it('keeps 暫存 answers across a fresh login and serves them, with the editable 自評單位, in the page query', async () => {
    type PageTree = {
      my_current_steps: { editable_unit_name: string | null }[]
      assessment_section: {
        assessment_control_point: { text: string; assessment_control_point_unit: { assessing_unit_name: string; assessment_answer: object | null }[] }[]
      }[]
      assessment_conclusion: object[]
    }
    const page = async (who: string) => {
      const { data, error } = await (await as(who)).from('assessment').select(ASSESSMENT_TREE).eq('id', tAssessment).single()
      expect(error).toBeNull()
      return data as unknown as PageTree
    }

    const again = await page(EMP.checker)
    const points = again.assessment_section.flatMap((s) => s.assessment_control_point)
    // 答案掛在「控制要點 × 自評單位」底下 (#46)；這裡每題只有一個自評單位
    const answerOnPage = (text: string) => {
      const units = points.find((p) => p.text === text)!.assessment_control_point_unit
      expect(units.map((u) => u.assessing_unit_name)).toEqual([CP_UNIT[text]])
      return units[0]!.assessment_answer
    }
    expect(answerOnPage('p1')).toEqual({ design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null })
    expect(answerOnPage('p2')).toBeNull()
    expect(again.assessment_conclusion).toEqual([{ assessing_unit_name: UNIT.a, conclusion: 'satisfied', exceptions: null }])
    // 頁面依資料庫決定哪幾列可輸入：輪到的人拿到自己的自評單位，稽核管理者看得到但唯讀
    expect(again.my_current_steps.map((s) => s.editable_unit_name)).toEqual([UNIT.a])
    expect((await page(EMP.auditAdmin)).my_current_steps).toEqual([])
  })
})

describe('送出驗證', () => {
  type Violation = { kind: string; control_point_id?: string; assessing_unit_name?: string; rule: string; section_position?: number; position?: number }
  const ruleOf = (violations: Violation[], text: string) => violations.filter((v) => v.control_point_id === CP[text]).map((v) => v.rule)

  it('refuses an incomplete submission, lists every violation of the 自評單位 in paper order, and does not advance', async () => {
    const me = await as(EMP.checker)
    await save(
      me,
      [
        answer('p1', { design: 'has_rule', execution: 'no', satisfaction: 'satisfied', improvement: '   ' }), // 空白＝沒填
        answer('p3', { design: null, execution: 'yes', satisfaction: 'satisfied' }), // 缺內控設計
        // p4 完全沒作答；p2 是品保的，不在這一關的驗證範圍
      ],
      [{ assessing_unit_name: UNIT.a, conclusion: 'satisfied_except', exceptions: '' }],
    )

    const { data, error } = await submit(me)
    expect(error).toBeNull()
    expect(data).toEqual({
      ok: false,
      error: 'incomplete',
      violations: [
        { kind: 'control_point', control_point_id: CP.p1, section_position: 1, position: 1, rule: 'improvement_required' },
        { kind: 'control_point', control_point_id: CP.p3, section_position: 2, position: 1, rule: 'unanswered' },
        { kind: 'control_point', control_point_id: CP.p4, section_position: 2, position: 2, rule: 'unanswered' },
        { kind: 'conclusion', assessing_unit_name: UNIT.a, rule: 'explanation_required' },
      ],
    })
    expect(await currentStep()).toEqual({ current_step_position: 1, status: 'in_progress' })
  })

  it.each([
    ['否', { execution: 'no' }],
    ['無內控規範', { design: 'no_rule' }],
    ['需要加強', { satisfaction: 'needs_improvement' }],
    ['不滿意', { satisfaction: 'dissatisfied' }],
  ])('requires 改善措施 when 「%s」 is ticked', async (_label, tick) => {
    const me = await as(EMP.checker)
    await save(me, [answer('p1', { ...COMPLETE, ...tick })]) // p4 仍沒作答，所以不會推進
    const without = (await submit(me)).data as { violations: Violation[] }
    expect(ruleOf(without.violations, 'p1')).toEqual(['improvement_required'])

    await save(me, [answer('p1', { ...COMPLETE, ...tick, improvement: '加強覆核' })])
    const withIt = (await submit(me)).data as { ok: boolean; violations: Violation[] }
    expect(withIt.ok).toBe(false)
    expect(ruleOf(withIt.violations, 'p1')).toEqual([])
  })

  it('does not require 改善措施 for 是／不適用／無此情形 with a satisfied rating', async () => {
    const me = await as(EMP.checker)
    for (const execution of ['yes', 'not_applicable', 'no_case']) {
      for (const satisfaction of ['very_satisfied', 'satisfied', 'adequate']) {
        await save(me, [answer('p1', { ...COMPLETE, execution, satisfaction })])
        const result = (await submit(me)).data as { violations: Violation[] }
        expect({ execution, satisfaction, rules: ruleOf(result.violations, 'p1') }).toEqual({ execution, satisfaction, rules: [] })
      }
    }
  })

  it('reports both rules when a control point is half answered and needs 改善措施', async () => {
    const me = await as(EMP.checker)
    await save(me, [answer('p1', { design: 'has_rule', execution: 'no', satisfaction: null })])
    const result = (await submit(me)).data as { violations: Violation[] }
    expect(ruleOf(result.violations, 'p1')).toEqual(['unanswered', 'improvement_required'])
  })

  it('requires a 整體結論, and an explanation for 「除下列事項外」', async () => {
    const me = await as(EMP.checker)
    const conclusionRule = async () => {
      const result = (await submit(me)).data as { violations: Violation[] }
      return result.violations.filter((v) => v.kind === 'conclusion').map((v) => [v.assessing_unit_name, v.rule])
    }
    await save(me, [], [{ assessing_unit_name: UNIT.a, conclusion: null }])
    expect(await conclusionRule()).toEqual([[UNIT.a, 'unanswered']])
    await save(me, [], [{ assessing_unit_name: UNIT.a, conclusion: 'satisfied_except', exceptions: ' ' }])
    expect(await conclusionRule()).toEqual([[UNIT.a, 'explanation_required']])
    await save(me, [], [{ assessing_unit_name: UNIT.a, conclusion: 'satisfied_except', exceptions: '付款單未逐筆核章' }])
    expect(await conclusionRule()).toEqual([])
    expect(await currentStep()).toEqual({ current_step_position: 1, status: 'in_progress' })
  })

  it('lets only the signer of the current 關卡 submit', async () => {
    for (const who of [EMP.manager, EMP.auditAdmin, EMP.outsider]) {
      const { error } = await submit(await as(who))
      expect({ who, code: error?.code }).toEqual({ who, code: '42501' })
    }
    expect((await submit(restClient(async () => null))).error?.code).toBe('42501')
  })
})

describe('推進', () => {
  it('completes the 資材 branch once its 自評單位 is complete, and the submitted 關卡 can no longer be changed', async () => {
    const me = await as(EMP.checker)
    await save(me, ['p1', 'p3', 'p4'].map((p) => answer(p)), [{ assessing_unit_name: UNIT.a, conclusion: 'satisfied' }])
    const { data, error } = await submit(me)
    expect(error).toBeNull()
    // 資材的分流只有這一關；品保還沒送出，所以還沒有下一關（匯流前）
    expect(data).toEqual({ ok: true, current_step_position: null })

    expect((await save(me, [answer('p1', { ...COMPLETE, improvement: '事後改' })])).error?.code).toBe('42501')
    expect((await save(me, [], [{ assessing_unit_name: UNIT.a, conclusion: 'satisfied_except', exceptions: '事後改' }])).error?.code).toBe('42501')
    expect((await answerOf('p1'))?.improvement).toBeNull()
    expect((await me.from('my_pending_assessment').select('step_position').eq('assessment_id', tAssessment)).data).toEqual([])

    // 品保同時在作答，不受資材送出影響
    const other = await as(EMP.checkerB)
    expect((await save(other, [answer('p2')])).error).toBeNull()
    expect((await other.from('my_pending_assessment').select('step_position').eq('assessment_id', tAssessment)).data).toEqual([{ step_position: 2 }])
  })

  it('merges to the next signer’s 我的待簽 after the last branch submits, read-only for them', async () => {
    const me = await as(EMP.checkerB)
    expect((await save(me, [], [{ assessing_unit_name: UNIT.b, conclusion: 'satisfied' }])).error).toBeNull()
    expect((await submit(me)).data).toEqual({ ok: true, current_step_position: 3 })
    expect((await save(me, [answer('p2', { ...COMPLETE, improvement: '事後改' })])).error?.code).toBe('42501')

    const manager = await as(EMP.manager)
    const pending = await manager.from('my_pending_assessment').select('step_position,step_name').eq('assessment_id', tAssessment)
    expect(pending.data).toEqual([{ step_position: 3, step_name: '部門主管' }])
    // 部門主管看得到全部答案，但不能寫，也不能用「送出」（核准是 #6）
    const answers = await manager.from('assessment_answer').select('control_point_id').eq('assessment_id', tAssessment)
    expect(answers.data).toHaveLength(4)
    expect((await save(manager, [answer('p2')])).error?.code).toBe('42501')
    expect((await submit(manager)).data).toEqual({ ok: false, error: 'not_self_check_step' })
    expect((await submit(me)).error?.code).toBe('42501')
    expect((await submit(await as(EMP.checker))).error?.code).toBe('42501')
    expect(await currentStep()).toEqual({ current_step_position: 3, status: 'in_progress' })
  })
})

describe('要素類', () => {
  it('has no 內控設計 and no 無此情形, and submits on 執行情形 and 滿意度 alone', async () => {
    const me = await as(EMP.checker)
    const bad1 = await save(me, [answer('e1', { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied' })], [], eAssessment)
    expect(bad1.error?.code).toBe('23514')
    const bad2 = await save(me, [answer('e1', { execution: 'no_case', satisfaction: 'satisfied' })], [], eAssessment)
    expect(bad2.error?.code).toBe('23514')

    await save(me, [answer('e1', { execution: 'yes', satisfaction: 'satisfied' })], [{ assessing_unit_name: UNIT.a, conclusion: 'satisfied' }], eAssessment)
    expect((await submit(me, eAssessment)).data).toEqual({ ok: true, current_step_position: 2 })
  })
})

describe('最後一關與結案', () => {
  it('refuses to submit a 自行檢查人員 關卡 that has no 關卡 after it, and does not close the 自評表', async () => {
    const me = await as(EMP.checker)
    await save(me, [answer('l1')], [{ assessing_unit_name: UNIT.a, conclusion: 'satisfied' }], lAssessment)
    expect((await submit(me, lAssessment)).data).toEqual({ ok: false, error: 'no_next_step' })
    expect(await currentStep(lAssessment)).toEqual({ current_step_position: 1, status: 'in_progress' })
  })

  it('refuses every write and 送出 once the 自評表 is closed', async () => {
    const closed = await admin.from('assessment').update({ status: 'closed' }).eq('id', lAssessment)
    expect(closed.error).toBeNull() // 結案是 #6 的核准；這裡用 service_role 模擬
    const me = await as(EMP.checker)
    expect((await save(me, [answer('l1', { ...COMPLETE, improvement: '結案後改' })], [], lAssessment)).error?.code).toBe('42501')
    expect((await submit(me, lAssessment)).error?.code).toBe('42501')
  })
})
