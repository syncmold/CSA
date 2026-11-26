// 資料 API 接縫: 核准、退回、作廢標記、簽核歷程與結案鎖定（工單 #6）。
// 每次執行建立自己的公司、廠區、自評單位、範本與簽核流程並發起自己的年度作業，結束時全部清掉。
// 同一個檔案裡的測試依序執行，共用同一張六關的自評表，從答題一路簽到結案。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ASSESSMENT_TREE, SIGNOFF_COLUMNS } from '../../src/api/assessmentQuery'
import type { Signoff } from '../../src/api/signoffModel'
import { launchAssigned, admin, insertRow, loginAs, makeRoute, makeTemplate, promoteToAuditAdmin, requirePostgrest, restClient, listPeople, unlistPeople } from './helpers'

const RUN = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = {
  auditAdmin: `${RUN}A`,
  checker: `${RUN}B`,
  manager: `${RUN}C`,
  auditor: `${RUN}E`,
  chief: `${RUN}F`,
  outsider: `${RUN}D`,
}
const NAME: Record<string, string> = {
  [EMP.auditAdmin]: '甲', [EMP.checker]: '乙', [EMP.manager]: '丙', [EMP.auditor]: '丁', [EMP.chief]: '戊', [EMP.outsider]: '己',
}
const YEAR = 10000 + Math.floor(Math.random() * 1000)
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = `${RUN}資材`

/** 六關：自行檢查人員 → 部門主管 → 廠區經理人（同一人）→ 兩關稽核（同一人）→ 稽核主管。 */
const STEPS = [
  { name: '自行檢查人員－資材', group: 'plant', signer: EMP.checker, unit: true },
  { name: '部門主管－資材', group: 'plant', signer: EMP.manager, unit: false },
  { name: '廠區經理人', group: 'plant', signer: EMP.manager, unit: false },
  { name: '子公司擔當稽核', group: 'audit_review', signer: EMP.auditor, unit: false },
  { name: '台北稽核人員', group: 'audit_review', signer: EMP.auditor, unit: false },
  { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unit: false },
] as const

const ID: Record<string, string> = {}
let assessmentId = ''
let pointId = ''

const COMPLETE = { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }

const as = (who: string) => loginAs(who, NAME[who] ?? who)

const approve = (client: SupabaseClient, comment?: string) =>
  client.rpc('approve_assessment_step', { p_assessment_id: assessmentId, ...(comment === undefined ? {} : { p_comment: comment }) })
const returnTo = (client: SupabaseClient, to: number | null, reason: string | null) =>
  client.rpc('return_assessment', { p_assessment_id: assessmentId, p_to_position: to, p_reason: reason })
const submit = (client: SupabaseClient) => client.rpc('submit_assessment_step', { p_assessment_id: assessmentId })
const save = (client: SupabaseClient, answer: object) =>
  client.rpc('save_assessment_answers', { p_assessment_id: assessmentId, p_answers: [{ control_point_id: pointId, assessing_unit_name: UNIT, ...answer }], p_conclusions: [] })

async function state() {
  const { data } = await admin.from('assessment').select('current_step_position,status').eq('id', assessmentId).single()
  return data as { current_step_position: number; status: string }
}


/** 歷程：用頁面同一個查詢，依時間排序。 */
async function history(client: SupabaseClient = admin) {
  const { data, error } = await client
    .from('assessment_signoff')
    .select(SIGNOFF_COLUMNS)
    .eq('assessment_id', assessmentId)
    .order('signed_at')
    .order('serial_no')
  expect(error).toBeNull()
  return data as unknown as Signoff[]
}

/** 歷程的精簡樣子：[關卡, 動作, 帳號, 是否作廢]。 */
const brief = (rows: Signoff[]) => rows.map((r) => [r.step_position, r.action, r.signer_emp_id, r.voided_at !== null])

async function answerAndSubmit() {
  const me = await as(EMP.checker)
  expect((await save(me, COMPLETE)).error).toBeNull()
  const conclusion = await me.rpc('save_assessment_answers', {
    p_assessment_id: assessmentId, p_answers: [], p_conclusions: [{ assessing_unit_name: UNIT, conclusion: 'satisfied' }],
  })
  expect(conclusion.error).toBeNull()
  return submit(me)
}

beforeAll(async () => {
  await requirePostgrest()
  // 關卡上的人要先在放行名單上（Q150）
  await listPeople(...Object.values(EMP))
  for (const who of Object.values(EMP)) await as(who)
  await promoteToAuditAdmin(EMP.auditAdmin)

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
  ID.template = await makeTemplate(`${RUN}t`, 'control_activity', FACTORY, [['第一章', [['p1', ID.unit]]]])
  await makeRoute(ID.template, ID.plant, STEPS.map((s) => ({ name: s.name, group: s.group, signer: s.signer, unitId: s.unit ? ID.unit! : null })))

  const launched = await launchAssigned(await as(EMP.auditAdmin), {
    p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: ID.template, plant_id: ID.plant }],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  assessmentId = (await admin.from('assessment').select('id').eq('cycle_id', launched.data.cycle_id).single()).data!.id
  pointId = (await admin.from('assessment_control_point').select('id').eq('assessment_id', assessmentId).single()).data!.id
})

afterAll(async () => {
  await unlistPeople(RUN)
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant)
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
})

describe('送出的簽核紀錄', () => {
  it('refuses 核准 and 退回 on a self-check 關卡 — that 關卡 signs by 送出', async () => {
    const me = await as(EMP.checker)
    expect((await approve(me)).data).toEqual({ ok: false, error: 'self_check_step' })
    expect((await returnTo(me, 1, '想退回')).data).toEqual({ ok: false, error: 'self_check_step' })
    expect(await history()).toEqual([])
  })

  it('records the account, name and time of a 送出', async () => {
    const before = Date.now()
    expect((await answerAndSubmit()).data).toEqual({ ok: true, current_step_position: 2 })
    const [row] = await history()
    expect(row).toMatchObject({
      step_position: 1, step_name: '自行檢查人員－資材', action: 'submit', signer_emp_id: EMP.checker, signer_name: '乙',
      comment: null, return_to_position: null, signature_method: 'system_record', voided_at: null,
    })
    expect(Date.parse(row!.signed_at)).toBeGreaterThanOrEqual(before - 60_000)
  })
})

describe('核准', () => {
  it('refuses every write to the control points from the 部門主管 關卡', async () => {
    const manager = await as(EMP.manager)
    expect((await save(manager, { ...COMPLETE, improvement: '主管改' })).error?.code).toBe('42501')
    const direct = await manager.from('assessment_answer').update({ improvement: '主管改' }).eq('control_point_id', pointId).select()
    // RLS 讓 update 看不到可寫的列：不報錯，但一列都沒改
    expect(direct.data ?? []).toEqual([])
    const conclusion = await manager.rpc('save_assessment_answers', {
      p_assessment_id: assessmentId, p_answers: [], p_conclusions: [{ assessing_unit_name: UNIT, conclusion: 'satisfied_except', exceptions: '主管改' }],
    })
    expect(conclusion.error?.code).toBe('42501')
    const { data } = await admin.from('assessment_answer').select('improvement').eq('control_point_id', pointId).single()
    expect(data).toEqual({ improvement: null })
  })

  it('lets only the signer of the current 關卡 approve', async () => {
    for (const who of [EMP.checker, EMP.auditor, EMP.chief, EMP.auditAdmin, EMP.outsider]) {
      const { error } = await approve(await as(who))
      expect({ who, code: error?.code }).toEqual({ who, code: '42501' })
    }
    expect((await approve(restClient(async () => null))).error?.code).toBe('42501')
    expect(await state()).toEqual({ current_step_position: 2, status: 'in_progress' })
  })

  it('advances to the next 關卡 and records the account, name, time and 意見', async () => {
    const manager = await as(EMP.manager)
    expect((await approve(manager, '  請購單據齊全  ')).data).toEqual({ ok: true, closed: false, current_step_position: 3 })
    expect((await approve(manager)).data).toEqual({ ok: true, closed: false, current_step_position: 4 })
    const rows = await history()
    expect(rows.slice(1).map((r) => [r.step_position, r.step_name, r.action, r.signer_emp_id, r.signer_name, r.comment])).toEqual([
      [2, '部門主管－資材', 'approve', EMP.manager, '丙', '請購單據齊全'],
      [3, '廠區經理人', 'approve', EMP.manager, '丙', null],
    ])
    expect(rows.every((r) => r.signed_at && r.voided_at === null)).toBe(true)

    const auditor = await as(EMP.auditor)
    expect((await approve(auditor)).data).toEqual({ ok: true, closed: false, current_step_position: 5 })
  })

  it('offers 核准／退回 on the page only to the signer of a 主管 or 稽核 關卡 whose turn it is', async () => {
    const canApprove = async (who: string) => {
      const { data } = await (await as(who)).from('assessment').select('can_approve,my_editable_units').eq('id', assessmentId).single()
      return data
    }
    expect(await canApprove(EMP.auditor)).toEqual({ can_approve: true, my_editable_units: [] })
    expect(await canApprove(EMP.manager)).toEqual({ can_approve: false, my_editable_units: [] })
    expect(await canApprove(EMP.auditAdmin)).toEqual({ can_approve: false, my_editable_units: [] })
  })

  it('has no direct write on the 簽核紀錄 for anyone signed in', async () => {
    const auditor = await as(EMP.auditor)
    const insert = await auditor.from('assessment_signoff').insert({
      assessment_id: assessmentId, step_id: assessmentId, step_position: 5, step_name: 'x', action: 'approve', signer_emp_id: EMP.auditor,
    })
    expect(insert.error?.code).toBe('42501')
    expect((await auditor.from('assessment_signoff').update({ comment: '改' }).eq('assessment_id', assessmentId)).error?.code).toBe('42501')
    expect((await auditor.from('assessment_signoff').delete().eq('assessment_id', assessmentId)).error?.code).toBe('42501')
    expect(await history()).toHaveLength(4)
  })
})

describe('退回', () => {
  it('requires a reason', async () => {
    const auditor = await as(EMP.auditor)
    for (const reason of [null, '', '   ']) {
      expect((await returnTo(auditor, 2, reason)).data).toEqual({ ok: false, error: 'reason_required' })
    }
    expect(await state()).toEqual({ current_step_position: 5, status: 'in_progress' })
  })

  it('only goes back to an earlier 關卡 of this 自評表', async () => {
    const auditor = await as(EMP.auditor)
    for (const to of [5, 6, 99, 0, null]) {
      expect({ to, result: (await returnTo(auditor, to, '原因')).data }).toEqual({ to, result: { ok: false, error: 'invalid_target' } })
    }
    expect((await returnTo(await as(EMP.manager), 2, '不是我的關卡')).error?.code).toBe('42501')
    expect(await state()).toEqual({ current_step_position: 5, status: 'in_progress' })
    expect(await history()).toHaveLength(4)
  })

  it('from 關卡 5 to 關卡 2: voids the sign-offs of 關卡 2–4, keeps them in the history, and goes back to 關卡 2', async () => {
    const auditor = await as(EMP.auditor)
    expect((await returnTo(auditor, 2, '  付款單未逐筆核章  ')).data).toEqual({ ok: true, current_step_position: 2, voided: 3 })
    expect(await state()).toEqual({ current_step_position: 2, status: 'in_progress' })

    const rows = await history()
    expect(brief(rows)).toEqual([
      [1, 'submit', EMP.checker, false],
      [2, 'approve', EMP.manager, true],
      [3, 'approve', EMP.manager, true],
      [4, 'approve', EMP.auditor, true],
      [5, 'return', EMP.auditor, false],
    ])
    expect(rows[4]).toMatchObject({ comment: '付款單未逐筆核章', return_to_position: 2, signer_name: '丁' })
    // 部門主管重新收到這張自評表
    const pending = await (await as(EMP.manager)).from('my_pending_assessment').select('step_position').eq('assessment_id', assessmentId)
    expect(pending.data).toEqual([{ step_position: 2 }])
  })

  it('still shows the history to everyone who signed it, but not to outsiders', async () => {
    // 稽核人員的關卡（4、5）現在排在目前關卡之後，但他簽過，仍看得到自評表與歷程
    for (const who of [EMP.auditor, EMP.manager, EMP.checker, EMP.auditAdmin]) {
      expect({ who, rows: (await history(await as(who))).length }).toEqual({ who, rows: 5 })
      const { data } = await (await as(who)).from('assessment').select('id').eq('id', assessmentId)
      expect({ who, visible: data?.length }).toEqual({ who, visible: 1 })
    }
    expect(await history(await as(EMP.outsider))).toEqual([])
    expect(await history(await as(EMP.chief))).toEqual([])
    const anon = await restClient(async () => null).from('assessment_signoff').select('serial_no').eq('assessment_id', assessmentId)
    expect(anon.error?.code).toBe('42501')
  })

  it('stops showing it to someone who signed but is no longer on the route (換人, #13)', async () => {
    // 以 service_role 模擬換人：稽核人員的兩關改給別人；他簽過（已作廢的第 4 關與退回），但已不在流程上
    const swap = (signer: string) =>
      admin.from('assessment_step').update({ signer_emp_id: signer }).eq('assessment_id', assessmentId).in('position', [4, 5])
    expect((await swap(EMP.outsider)).error).toBeNull()
    try {
      expect(await history(await as(EMP.auditor))).toEqual([])
      const { data } = await (await as(EMP.auditor)).from('assessment').select('id').eq('id', assessmentId)
      expect(data).toEqual([])
    } finally {
      expect((await swap(EMP.auditor)).error).toBeNull()
    }
    expect(await history(await as(EMP.auditor))).toHaveLength(5)
  })

  it('back to the 自行檢查人員: reopens their 自評單位 and voids their 送出 but not earlier 退回', async () => {
    const manager = await as(EMP.manager)
    expect((await returnTo(manager, 1, '請補充說明')).data).toEqual({ ok: true, current_step_position: 1, voided: 1 })

    const checker = await as(EMP.checker)
    const { data } = await checker.from('assessment').select('my_editable_units,can_approve').eq('id', assessmentId).single()
    expect(data).toEqual({ my_editable_units: [UNIT], can_approve: false })
    expect((await save(checker, { ...COMPLETE, improvement: '已補充' })).error).toBeNull()
    expect((await submit(checker)).data).toEqual({ ok: true, current_step_position: 2 })

    expect(brief(await history())).toEqual([
      [1, 'submit', EMP.checker, true],
      [2, 'approve', EMP.manager, true],
      [3, 'approve', EMP.manager, true],
      [4, 'approve', EMP.auditor, true],
      [5, 'return', EMP.auditor, false],
      [2, 'return', EMP.manager, false],
      [1, 'submit', EMP.checker, false],
    ])
  })
})

describe('結案', () => {
  it('closes the 自評表 when the last 關卡 approves', async () => {
    const manager = await as(EMP.manager)
    await approve(manager)
    await approve(manager)
    const auditor = await as(EMP.auditor)
    await approve(auditor)
    await approve(auditor)
    expect(await state()).toEqual({ current_step_position: 6, status: 'in_progress' })
    expect((await approve(await as(EMP.chief), '同意結案')).data).toEqual({ ok: true, closed: true, current_step_position: 6 })
    expect(await state()).toEqual({ current_step_position: 6, status: 'closed' })

    const rows = await history()
    expect(rows.filter((r) => r.voided_at === null).map((r) => [r.step_position, r.action])).toEqual([
      [5, 'return'], [2, 'return'], [1, 'submit'], [2, 'approve'], [3, 'approve'], [4, 'approve'], [5, 'approve'], [6, 'approve'],
    ])
    // 簽核記錄編號依時間遞增，不重複
    const serials = rows.map((r) => r.serial_no)
    expect([...serials].sort((x, y) => x - y)).toEqual(serials)
    expect(new Set(serials).size).toBe(serials.length)
  })

  it('refuses 送出, 核准 and 退回 from everyone once closed', async () => {
    for (const who of Object.values(EMP)) {
      const client = await as(who)
      expect({ who, approve: (await approve(client)).error?.code }).toEqual({ who, approve: '42501' })
      expect({ who, returnTo: (await returnTo(client, 1, '結案後退回')).error?.code }).toEqual({ who, returnTo: '42501' })
      expect({ who, submit: (await submit(client)).error?.code }).toEqual({ who, submit: '42501' })
    }
    expect(await state()).toEqual({ current_step_position: 6, status: 'closed' })
  })

  it('locks the answers, 整體結論, 簽核紀錄 and 關卡 against everyone, service_role included', async () => {
    expect((await save(await as(EMP.checker), { ...COMPLETE, improvement: '結案後改' })).error?.code).toBe('42501')
    const refused = {
      answerUpdate: await admin.from('assessment_answer').update({ improvement: '結案後改' }).eq('control_point_id', pointId),
      answerDelete: await admin.from('assessment_answer').delete().eq('control_point_id', pointId),
      conclusionUpdate: await admin.from('assessment_conclusion').update({ exceptions: '結案後改' }).eq('assessment_id', assessmentId),
      conclusionDelete: await admin.from('assessment_conclusion').delete().eq('assessment_id', assessmentId),
      signoffUpdate: await admin.from('assessment_signoff').update({ comment: '結案後改' }).eq('assessment_id', assessmentId),
      signoffDelete: await admin.from('assessment_signoff').delete().eq('assessment_id', assessmentId),
      stepUpdate: await admin.from('assessment_step').update({ signer_emp_id: EMP.outsider }).eq('assessment_id', assessmentId),
      stepDelete: await admin.from('assessment_step').delete().eq('assessment_id', assessmentId).eq('position', 6),
    }
    for (const [what, result] of Object.entries(refused)) expect({ what, code: result.error?.code }).toEqual({ what, code: '42501' })

    const { data } = await admin.from('assessment_answer').select('improvement').eq('control_point_id', pointId).single()
    expect(data).toEqual({ improvement: '已補充' })
    expect(await history()).toHaveLength(12)
    expect((await admin.from('assessment_step').select('position').eq('assessment_id', assessmentId)).data).toHaveLength(6)
  })

  it('keeps the closed 自評表 and its whole history visible to every signer, and serves it in the page query', async () => {
    const { data, error } = await (await as(EMP.chief)).from('assessment').select(ASSESSMENT_TREE).eq('id', assessmentId).single()
    expect(error).toBeNull()
    expect(data).toMatchObject({ status: 'closed', can_approve: false, my_current_steps: [] })
    expect(await history(await as(EMP.chief))).toHaveLength(12)
  })

  it('still lets the 年度作業 be deleted together with its closed 自評表 (連帶刪除)', async () => {
    const { error } = await admin.from('annual_cycle').delete().eq('year', YEAR)
    expect(error).toBeNull()
    expect((await admin.from('assessment').select('id').eq('id', assessmentId)).data).toEqual([])
    expect((await admin.from('assessment_signoff').select('serial_no').eq('assessment_id', assessmentId)).data).toEqual([])
  })
})
