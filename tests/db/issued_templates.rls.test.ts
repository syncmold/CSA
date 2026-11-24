// 範本管理依年度（工單 #173，Q128 (4)）：已發起的年度讀當年發出的自評表快照。建立自己的公司、廠區、自評單位、一份多層
// 章節＋原檔題號的範本與三關的簽核流程，發起一個年度；之後改範本，已發起年度讀到的仍是當年的題目。看得到哪些照自評表的
// 讀取規則。結束時全部清掉。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { selectIssuedSections, selectIssuedSteps, selectIssuedTemplates, selectLaunchedYears } from '../../src/api/issuedQuery'
import {
  admin, insertControlPoint, insertRow, launchAssigned, loginAs, makeRoute, ok, promoteToAuditAdmin, promoteToSystemMaintainer, requirePostgrest,
  restClient,
} from './helpers'

const RUN = `y${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { auditAdmin: `${RUN}A`, maintainer: `${RUN}M`, checker: `${RUN}B`, chief: `${RUN}F`, outsider: `${RUN}D` }
const YEAR = 26000 + Math.floor(Math.random() * 1000)
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT_1 = `${RUN}財會`
const UNIT_2 = `${RUN}資材`
const CODE = `${RUN}-07`

const ID: Record<string, string> = {}
let ASSESSMENT = ''
const as = (who: string) => loginAs(who, who)

/** The template's questions before anyone edits it: what the launched year must keep showing. */
const ISSUED = [
  { level: 1, code: '1', name: '投資取得作業', points: [['1.1', '投資案是否依規定取得權責主管之核准？', [UNIT_1, UNIT_2]]] },
  { level: 2, code: '1.1', name: '有價證券', points: [[null, '取得有價證券時是否洽請會計師表示意見？', [UNIT_1]]] },
  { level: 1, code: null, name: '投資之處分作業', points: [[null, '處分案是否經權責主管核准？\n（意指董事會授權範圍內）', [UNIT_1]], [null, '是否辦理公告及申報？', [UNIT_2]]] },
] as const

/** Sections and control points as the page reads them, sorted, with only what it shows. */
function shown(rows: Awaited<ReturnType<typeof issuedSections>>) {
  const byPosition = <T extends { position: number }>(xs: readonly T[]) => [...xs].sort((a, b) => a.position - b.position)
  return byPosition(rows).map((s) => ({
    level: s.level,
    code: s.code,
    name: s.name,
    points: byPosition(s.assessment_control_point).map((p) => [p.code, p.text, byPosition(p.assessment_control_point_unit).map((u) => u.assessing_unit_name)]),
  }))
}

async function issuedRows(who: string) {
  return ok(await selectIssuedTemplates(await as(who), YEAR))
}
async function issuedSections(who: string, assessmentId: string) {
  return ok(await selectIssuedSections(await as(who), assessmentId))
}

beforeAll(async () => {
  await requirePostgrest()
  for (const who of Object.values(EMP)) await as(who)
  await promoteToAuditAdmin(EMP.auditAdmin)
  await promoteToSystemMaintainer(EMP.maintainer)

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}一廠`, company_id: ID.company })).id
  ID.unit1 = (await insertRow('assessing_unit', { name: UNIT_1 })).id
  ID.unit2 = (await insertRow('assessing_unit', { name: UNIT_2 })).id
  const unitId = { [UNIT_1]: ID.unit1, [UNIT_2]: ID.unit2 }
  ID.template = (
    await insertRow('questionnaire_template', {
      code: CODE, name: '投資循環', layout: 'control_activity', component: 'control_activities', status: 'active', all_plants: false,
    })
  ).id
  await insertRow('template_plant', { template_id: ID.template, factory_code: FACTORY })
  for (const [i, s] of ISSUED.entries()) {
    const section = await insertRow('template_section', { template_id: ID.template, position: i + 1, level: s.level, code: s.code, name: s.name })
    for (const [j, [code, text, units]] of s.points.entries()) {
      const pointId = await insertControlPoint(section.id, j + 1, text, units.map((u) => unitId[u]!))
      if (code) ok(await admin.from('control_point').update({ code }).eq('id', pointId))
    }
  }
  ID.route = await makeRoute(ID.template, ID.plant, [
    { name: '自行檢查人員－財會', group: 'plant', signer: EMP.checker, unitId: ID.unit1 },
    { name: '自行檢查人員－資材', group: 'plant', signer: EMP.checker, unitId: ID.unit2 },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
  ])
  const launched = await launchAssigned(await as(EMP.auditAdmin), {
    p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: ID.template, plant_id: ID.plant }],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  ASSESSMENT = (ok(await admin.from('assessment').select('id').eq('cycle_id', launched.data.cycle_id).single()) as { id: string }).id

  // 發起之後改範本：名稱與一題的文字。已發起的年度不受影響。
  const boss = await as(EMP.auditAdmin)
  ok(await boss.rpc('update_template', {
    p_template_id: ID.template, p_code: CODE, p_name: '投資循環（修訂）', p_status: 'active', p_all_plants: false,
    p_factory_codes: [FACTORY], p_component: null,
  }))
  const firstPoint = ok(await admin.from('control_point').select('id,template_section!inner(template_id,position)').eq('template_section.template_id', ID.template)
    .eq('template_section.position', 3).eq('position', 1).single()) as { id: string }
  // 流程也改：把稽核主管那關換人（有連動標記的關卡不能改名）。已發起年度的關卡不受影響。
  const audit = ok(await admin.from('route_step').select('id').eq('route_id', ID.route).eq('name', '稽核主管').single()) as { id: string }
  ok(await admin.from('route_step').update({ signer_emp_id: EMP.checker }).eq('id', audit.id))
  ok(await boss.rpc('update_control_point', { p_control_point_id: firstPoint.id, p_code: null, p_text: '處分案是否經董事會核准？', p_unit_ids: [ID.unit1] }))
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  if (ID.plant) await admin.from('approval_route').delete().eq('plant_id', ID.plant)
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().in('name', [UNIT_1, UNIT_2])
})

describe('已發起的年度讀當年發出的自評表（#173）', () => {
  it('lists the launched year among the years', async () => {
    expect(ok(await selectLaunchedYears(await as(EMP.auditAdmin))).map((r) => r.year)).toContain(YEAR)
  })

  it('lists the template with that year’s 編號, 名稱 and control point count, though the template changed since', async () => {
    const rows = (await issuedRows(EMP.auditAdmin)).filter((r) => r.template_id === ID.template)
    expect(rows).toEqual([
      {
        assessment_id: ASSESSMENT, year: YEAR, template_id: ID.template, plant_id: ID.plant, factory_code: FACTORY,
        code: CODE, name: '投資循環', layout: 'control_activity', component: 'control_activities', control_point_count: 4,
      },
    ])
  })

  it('reads the questions word for word as issued: 層級, 題號, text with its line break and 自評單位 in order', async () => {
    const expected = ISSUED.map((s) => ({ level: s.level, code: s.code, name: s.name, points: s.points.map(([code, text, units]) => [code, text, [...units]]) }))
    expect(shown(await issuedSections(EMP.auditAdmin, ASSESSMENT))).toEqual(expected)
    // 範本本身已經改了：讀到的是快照，不是範本。
    const now = ok(await admin.from('control_point').select('text').eq('text', '處分案是否經董事會核准？')) as unknown[]
    expect(now).toHaveLength(1)
  })

  it('shows a 系統維護員 the same as a 稽核管理者', async () => {
    expect((await issuedRows(EMP.maintainer)).filter((r) => r.template_id === ID.template)).toEqual(
      (await issuedRows(EMP.auditAdmin)).filter((r) => r.template_id === ID.template),
    )
    expect(shown(await issuedSections(EMP.maintainer, ASSESSMENT))).toEqual(shown(await issuedSections(EMP.auditAdmin, ASSESSMENT)))
  })

  it('follows the 自評表’s reading rule: a signer on it sees it, someone on no route sees nothing', async () => {
    expect((await issuedRows(EMP.checker)).map((r) => r.assessment_id)).toEqual([ASSESSMENT])
    expect(await issuedRows(EMP.outsider)).toEqual([])
    expect(await issuedSections(EMP.outsider, ASSESSMENT)).toEqual([])
  })

  it('reads that year’s 關卡 of each 自評表 as issued, though the route changed since (#174)', async () => {
    const steps = async (who: string) =>
      ok(await selectIssuedSteps(await as(who), YEAR, 0, 999))
        .filter((s) => s.assessment_id === ASSESSMENT)
        .map((s) => [s.position, s.name, s.branch_unit_name])
    const issued = [
      [1, '自行檢查人員－財會', UNIT_1],
      [2, '自行檢查人員－資材', UNIT_2],
      [3, '台北稽核人員', null],
      [4, '稽核主管', null],
    ]
    expect(await steps(EMP.auditAdmin)).toEqual(issued)
    expect(await steps(EMP.maintainer)).toEqual(issued)
    expect(await steps(EMP.checker)).toEqual(issued)
    expect(await steps(EMP.outsider)).toEqual([])
  })

  it('reads the 關卡 page by page without losing or repeating any (Supabase answers at most 1000 rows)', async () => {
    const boss = await as(EMP.auditAdmin)
    const all = ok(await selectIssuedSteps(boss, YEAR, 0, 999)).map((s) => `${s.assessment_id}:${s.position}`)
    const paged: string[] = []
    for (let from = 0; from < all.length; from += 2) {
      paged.push(...ok(await selectIssuedSteps(boss, YEAR, from, from + 1)).map((s) => `${s.assessment_id}:${s.position}`))
    }
    expect(paged).toEqual(all)
  })

  it('gives anonymous callers nothing', async () => {
    const anon = restClient(async () => null)
    expect((await anon.from('issued_template').select('assessment_id')).error?.code).toBe('42501')
  })
})
