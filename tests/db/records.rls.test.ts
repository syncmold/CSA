// 資料 API 接縫: 首頁只留當期、往年移到自評表紀錄（工單 #164，Q124）。
// 建立自己的公司、兩個廠區、一份範本（兩廠都適用）與兩關的簽核流程，發起去年與今年（全庫最新年度），各廠一張；
// 一廠兩年都簽到結案，二廠都還在簽核中。結束時全部清掉。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { countMyPastClosed, selectEveryAssessmentOfMine, selectMyAssessments } from '../../src/api/myAssessmentsQuery'
import { selectAssessmentRecords, selectRecordScope } from '../../src/api/recordsQuery'
import { admin, insertRow, launchAssigned, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, promoteToSystemMaintainer, requirePostgrest, restClient, unlistPeople } from './helpers'

const RUN = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = {
  checker: `${RUN}B`,
  chief: `${RUN}F`,
  auditAdmin: `${RUN}A`,
  maintainer: `${RUN}M`,
  viewer: `${RUN}V`,
  coordinator: `${RUN}C`.toUpperCase(),
  outsider: `${RUN}D`,
}
// 首頁看的是全庫最新年度，所以這個檔案的年度要比其他測試檔都大（tests/db/helpers.ts 的年度區間）。
const YEAR = 99001 + Math.floor(Math.random() * 998)
const LAST_YEAR = YEAR - 1
const FACTORY_1 = `${RUN}P1`.toUpperCase()
const FACTORY_2 = `${RUN}P2`.toUpperCase()
const UNIT = `${RUN}資材`
const CODE = `${RUN}a`

const ID: Record<string, string> = {}
/** 自評表 id，依「年度/廠」：old1、old2 是去年的，new1、new2 是今年的 */
const FORM: Record<'old1' | 'old2' | 'new1' | 'new2', string> = { old1: '', old2: '', new1: '', new2: '' }
const OURS = () => Object.values(FORM)

const as = (who: string) => loginAs(who, who)

async function launch(year: number) {
  const launched = await launchAssigned(await as(EMP.auditAdmin), {
    p_year: year, p_due_date: '2099-12-31',
    p_combos: [{ template_id: ID.template, plant_id: ID.plant1 }, { template_id: ID.template, plant_id: ID.plant2 }],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  const rows = ok(await admin.from('assessment').select('id,plant_id').eq('cycle_id', launched.data.cycle_id)) as { id: string; plant_id: string }[]
  const age = year === YEAR ? 'new' : 'old'
  for (const r of rows) FORM[`${age}${r.plant_id === ID.plant1 ? 1 : 2}`] = r.id
}

/** 自行檢查人員答完送出，稽核主管核准：結案。 */
async function close(assessmentId: string) {
  const checker = await as(EMP.checker)
  const point = ok(await admin.from('assessment_control_point').select('id').eq('assessment_id', assessmentId).single()) as { id: string }
  expect((await checker.rpc('save_assessment_answers', {
    p_assessment_id: assessmentId,
    p_answers: [{ control_point_id: point.id, assessing_unit_name: UNIT, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
    p_conclusions: [{ assessing_unit_name: UNIT, conclusion: 'satisfied' }],
  })).error).toBeNull()
  expect(ok(await checker.rpc('submit_assessment_step', { p_assessment_id: assessmentId }))).toMatchObject({ ok: true })
  for (const _step of ['台北稽核人員', '稽核主管']) {
    expect(ok(await (await as(EMP.chief)).rpc('approve_assessment_step', { p_assessment_id: assessmentId }))).toMatchObject({ ok: true })
  }
}

/** 自評表紀錄頁的查詢，只留這個檔案發出的（稽核管理者與系統維護員看得到全庫）。 */
async function recordsOf(who: string) {
  return ok(await selectAssessmentRecords(await as(who))).filter((r) => OURS().includes(r.assessment_id))
}
const recordIdsOf = async (who: string) => (await recordsOf(who)).map((r) => r.assessment_id)

beforeAll(async () => {
  await requirePostgrest()
  for (const who of Object.values(EMP)) await as(who)
  await promoteToAuditAdmin(EMP.auditAdmin)
  await promoteToSystemMaintainer(EMP.maintainer)

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant1 = (await insertRow('plant', { factory_code: FACTORY_1, name: `${RUN}一廠`, company_id: ID.company })).id
  ID.plant2 = (await insertRow('plant', { factory_code: FACTORY_2, name: `${RUN}二廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
  ID.template = await makeTemplate(CODE, 'control_activity', FACTORY_1, [['第一章', [['p1', ID.unit]]]])
  await insertRow('template_plant', { template_id: ID.template, factory_code: FACTORY_2 })
  for (const plant of [ID.plant1, ID.plant2]) {
    await makeRoute(ID.template, plant, [
      { name: '自行檢查人員－資材', group: 'plant', signer: EMP.checker, unitId: ID.unit },
      { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
      { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
    ])
  }
  ok(await admin.from('employee_ref').update({ audit_role: 'viewer', viewer_plant_ids: [ID.plant1] }).eq('emp_id', EMP.viewer))
  ok(await admin.from('access_allowlist').insert({ emp_id: EMP.coordinator }))
  ok(await admin.from('plant_coordinator').insert({ plant_id: ID.plant2, emp_id: EMP.coordinator }))

  await launch(LAST_YEAR)
  await launch(YEAR)
  await close(FORM.old1)
  await close(FORM.new1)
})

afterAll(async () => {
  await unlistPeople(RUN) // 排進關卡時加進放行名單的人（Q150）
  await admin.from('annual_cycle').delete().in('year', [LAST_YEAR, YEAR])
  await admin.from('approval_route').delete().in('plant_id', [ID.plant1, ID.plant2].filter(Boolean))
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
  if (ID.plant2) await admin.from('plant_coordinator').delete().eq('plant_id', ID.plant2)
  await admin.from('access_allowlist').delete().eq('emp_id', EMP.coordinator)
  await admin.from('plant').delete().in('factory_code', [FACTORY_1, FACTORY_2])
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
})

describe('首頁「我參與的」只留當期（Q124 (1)）', () => {
  it('runs with this file’s 年度 as the latest one', async () => {
    // 其他測試檔的年度若比這裡大，下面的「今年」就不是最新年度：先講清楚，免得看起來像規則錯了
    expect(ok(await (await as(EMP.checker)).rpc('latest_cycle_year'))).toBe(YEAR)
  })

  it('keeps the latest 年度 and anything not yet 結案, of any 年度; drops last year’s 結案', async () => {
    // 簽核中在前（今年、去年），再來結案。稽核主管在二廠的兩張還沒輪到，也照樣列著（Q152）
    const expected = { [EMP.checker]: [FORM.new2, FORM.old2, FORM.new1], [EMP.chief]: [FORM.new2, FORM.old2, FORM.new1] }
    for (const [who, ids] of Object.entries(expected)) {
      expect(ok(await selectMyAssessments(await as(who))).map((r) => r.assessment_id), who).toEqual(ids)
      expect(await countMyPastClosed(await as(who)), who).toBe(1)
    }
  })

  it('deletes nothing: the dropped one is still the employee’s, and still opens', async () => {
    const checker = await as(EMP.checker)
    const all = ok(await selectEveryAssessmentOfMine(checker))
    expect(all.map((r) => r.assessment_id)).toEqual([FORM.new2, FORM.old2, FORM.new1, FORM.old1])
    expect(ok(await checker.from('assessment').select('id,status').eq('id', FORM.old1))).toEqual([{ id: FORM.old1, status: 'closed' }])
  })

  it('counts nothing for someone on no route, a 稽核管理者 included', async () => {
    for (const who of [EMP.outsider, EMP.auditAdmin]) {
      expect(ok(await selectMyAssessments(await as(who)))).toEqual([])
      expect(await countMyPastClosed(await as(who))).toBe(0)
    }
  })
})

describe('自評表紀錄：看得到哪些照自評表的讀取規則（Q124 (2)）', () => {
  it('gives a 稽核管理者 and a 系統維護員 every plant and every 年度, on a route or not', async () => {
    for (const who of [EMP.auditAdmin, EMP.maintainer]) {
      expect((await recordIdsOf(who)).sort()).toEqual(OURS().sort())
      expect(ok(await selectRecordScope(await as(who)))).toEqual({ all_plants: true, plant_ids: [] })
    }
  })

  it('gives a 檢視者 their 檢視廠區 and a 廠區負責人 the plant they run, every 年度', async () => {
    expect((await recordIdsOf(EMP.viewer)).sort()).toEqual([FORM.old1, FORM.new1].sort())
    expect(ok(await selectRecordScope(await as(EMP.viewer)))).toEqual({ all_plants: false, plant_ids: [ID.plant1] })
    expect((await recordIdsOf(EMP.coordinator)).sort()).toEqual([FORM.old2, FORM.new2].sort())
    expect(ok(await selectRecordScope(await as(EMP.coordinator)))).toEqual({ all_plants: false, plant_ids: [ID.plant2] })
  })

  it('gives a signer the ones they are on, 往年已結案 included, and someone on no route none', async () => {
    // 新的年度在前，同年度依範本、廠區
    expect(await recordIdsOf(EMP.checker)).toEqual([FORM.new1, FORM.new2, FORM.old1, FORM.old2])
    expect(ok(await selectRecordScope(await as(EMP.checker)))).toEqual({ all_plants: false, plant_ids: [] })
    expect(await recordIdsOf(EMP.outsider)).toEqual([])
  })

  it('gives the 結案日 as the time of the last approval, and none while 簽核中', async () => {
    // 最後一關（稽核主管）的核准
    const approved = ok(await admin.from('assessment_signoff').select('signed_at').eq('assessment_id', FORM.old1).eq('action', 'approve').order('signed_at', { ascending: false }).limit(1).single()) as { signed_at: string }
    const rows = await recordsOf(EMP.checker)
    expect(rows.find((r) => r.assessment_id === FORM.old1)).toEqual({
      assessment_id: FORM.old1, year: LAST_YEAR, company_id: ID.company, company_name: `${RUN}測試公司`, plant_id: ID.plant1,
      factory_code: FACTORY_1, plant_name: `${RUN}一廠`, template_code: CODE, template_name: `${CODE} 範本`, status: 'closed', closed_at: expect.any(String),
    })
    expect(new Date(rows.find((r) => r.assessment_id === FORM.old1)!.closed_at!).getTime()).toBe(new Date(approved.signed_at).getTime())
    expect(rows.find((r) => r.assessment_id === FORM.old2)).toMatchObject({ status: 'in_progress', closed_at: null })
  })

  it('gives anonymous callers nothing', async () => {
    const anon = restClient(async () => null)
    expect((await anon.from('assessment_record').select('assessment_id')).error?.code).toBe('42501')
    expect((await anon.rpc('my_record_scope')).error?.code).toBe('42501')
    for (const fn of ['latest_cycle_year', 'my_past_closed_count']) expect((await anon.rpc(fn)).error?.code, fn).toBe('42501')
  })
})
