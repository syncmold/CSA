// 送出與同時寫入的先後 (#5 的保證，#6 review 後改為鎖自評表那一列，Q85 (10))：
// 驗證過的內容就是送出的內容，而且不會再與連帶刪除死結。需要同時開兩個交易，PostgREST 做不到，
// 所以直接連 Postgres（本機與 CI 的兩個環境都有跑）；沒設 CSA_DB_URL 或 CSA_DB_ADMIN_URL、或連不到時跳過。
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchAssigned, admin, beginAs, directDb, insertRow, linkedAuditSteps, loginAs, makeRoute, makeTemplate, promoteToAuditAdmin, requirePostgrest, stillWaiting, unlistPeople } from './helpers'

const RUN = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A`, checker: `${RUN}B`, manager: `${RUN}C` }
const YEAR = 3000 + Math.floor(Math.random() * 950) // 會用到 YEAR … YEAR + 49
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = `${RUN}資材`
const COMPLETE = { design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }

const ID: Record<string, string> = {}
const conns: Client[] = []
let reachable = false

/** Launch a fresh one-point 自評表 (自行檢查人員 → 部門主管) whose only control point is answered completely. */
async function freshAssessment(): Promise<{ assessmentId: string; pointId: string }> {
  const code = `${RUN}t${Object.keys(ID).length}`
  const templateId = await makeTemplate(code, 'control_activity', FACTORY, [['章', [['p1', ID.unit!]]]])
  ID[code] = templateId
  await makeRoute(templateId, ID.plant!, [
    { name: '自行檢查人員', group: 'plant', signer: EMP.checker, unitId: ID.unit! },
    { name: '部門主管', group: 'plant', signer: EMP.manager, unitId: null },
    ...linkedAuditSteps(EMP.boss),
  ])
  const boss = await loginAs(EMP.boss, '甲')
  const year = YEAR + Object.keys(ID).length
  const launched = await launchAssigned(boss, {
    p_year: year, p_due_date: '2099-12-31', p_combos: [{ template_id: templateId, plant_id: ID.plant }],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  const assessmentId = (await admin.from('assessment').select('id').eq('cycle_id', launched.data.cycle_id).single()).data!.id
  const pointId = (await admin.from('assessment_control_point').select('id').eq('assessment_id', assessmentId).single()).data!.id
  const checker = await loginAs(EMP.checker, '乙')
  const saved = await checker.rpc('save_assessment_answers', {
    p_assessment_id: assessmentId,
    p_answers: [{ control_point_id: pointId, assessing_unit_name: UNIT, ...COMPLETE }],
    p_conclusions: [{ assessing_unit_name: UNIT, conclusion: 'satisfied' }],
  })
  if (saved.error) throw new Error(`save: ${saved.error.message}`)
  return { assessmentId, pointId }
}

async function conn(): Promise<Client> {
  const c = (await directDb())!
  conns.push(c)
  return c
}

beforeAll(async () => {
  const probe = await directDb()
  reachable = probe !== null
  await probe?.end()
  if (!reachable) return
  await requirePostgrest()
  for (const [who, name] of [[EMP.boss, '甲'], [EMP.checker, '乙'], [EMP.manager, '丙']] as const) await loginAs(who, name)
  await promoteToAuditAdmin(EMP.boss)
  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
})

afterAll(async () => {
  await unlistPeople(RUN) // 排進關卡時加進放行名單的人（Q150）
  for (const c of conns) await c.end().catch(() => {})
  if (!reachable) return
  await admin.from('annual_cycle').delete().gte('year', YEAR).lt('year', YEAR + 50)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant ?? '')
  const templates = Object.entries(ID).filter(([k]) => k.startsWith(RUN)).map(([, v]) => v)
  if (templates.length) await admin.from('questionnaire_template').delete().in('id', templates)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
})

describe('送出與同時寫入', () => {
  it('refuses a write that was waiting on a 送出, once the 送出 has moved the 自評表 on', async (ctx) => {
    if (!reachable) ctx.skip()
    const { assessmentId, pointId } = await freshAssessment()
    const submitter = await conn()
    const writer = await conn()

    await beginAs(submitter, EMP.checker)
    const submitted = await submitter.query('select public.submit_assessment_step($1) as r', [assessmentId])
    expect(submitted.rows[0].r).toEqual({ ok: true, current_step_position: 2 })

    // 同一位自行檢查人員在另一個分頁直接寫表：送出還沒提交，寫入要排隊
    await beginAs(writer, EMP.checker)
    const write = writer.query("update public.assessment_answer set improvement = '送出後才寫' where control_point_id = $1", [pointId])
    expect(await stillWaiting(write)).toBe(true)

    await submitter.query('commit')
    await expect(write).rejects.toMatchObject({ code: '42501' })
    await writer.query('rollback')

    const { data } = await admin.from('assessment_answer').select('improvement').eq('control_point_id', pointId).single()
    expect(data).toEqual({ improvement: null })
  })

  it('makes a 送出 wait for a write in progress and validate what that write committed', async (ctx) => {
    if (!reachable) ctx.skip()
    const { assessmentId, pointId } = await freshAssessment()
    const submitter = await conn()
    const writer = await conn()

    // 暫存進行中：把答案改成「否」卻沒填改善措施，還沒提交
    await beginAs(writer, EMP.checker)
    await writer.query("update public.assessment_answer set execution = 'no' where control_point_id = $1", [pointId])

    await beginAs(submitter, EMP.checker)
    const submit = submitter.query('select public.submit_assessment_step($1) as r', [assessmentId])
    expect(await stillWaiting(submit)).toBe(true)

    await writer.query('commit')
    const result = (await submit).rows[0].r
    await submitter.query('commit')
    expect(result).toMatchObject({ ok: false, error: 'incomplete' })
    expect(result.violations.map((v: { rule: string }) => v.rule)).toEqual(['improvement_required'])
  })

  it('does not deadlock a 送出 with deleting another 年度作業', async (ctx) => {
    if (!reachable) ctx.skip()
    const first = await freshAssessment()
    const second = await freshAssessment()
    const submitter = await conn()
    const deleter = await conn()

    // 舊做法：刪年度作業的連帶刪除先鎖整體結論再鎖答案，送出先鎖答案再鎖整體結論 → 互等
    await beginAs(submitter, EMP.checker)
    await submitter.query('select public.submit_assessment_step($1) as r', [first.assessmentId])
    await deleter.query('begin')
    await deleter.query(
      'delete from public.annual_cycle where id = (select cycle_id from public.assessment where id = $1)',
      [second.assessmentId],
    )
    await deleter.query('commit')
    await submitter.query('commit')

    const { data } = await admin.from('assessment').select('current_step_position').eq('id', first.assessmentId).single()
    expect(data).toEqual({ current_step_position: 2 })
  })
})
