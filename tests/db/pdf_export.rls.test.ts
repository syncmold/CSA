// 匯出 PDF (#7) end to end over the data API: a 簽核人 reads the 自評表, its 簽核歷程 and the company of the 版頭
// through readAssessmentPdfSource, the same function the page calls, and the PDF made from it shows the 自評表 as
// it stands. Signing goes
// through the real 送出、核准、退回 functions. Each run builds its own company, plant, template and route.
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readAssessmentPdfSource } from '../../src/api/assessmentPdfQuery'
import { renderAssessmentPdf } from '../../src/pdf/assessmentPdf'
import { nodePdfEngine } from '../../src/pdf/testing/nodeEngine'
import { allText, readPdf } from '../../src/pdf/testing/pdfText'
import { launchAssigned, admin, insertRow, loginAs, makeRoute, makeTemplate, promoteToAuditAdmin, requirePostgrest, unlistPeople } from './helpers'

const RUN = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { auditAdmin: `${RUN}A`, checker: `${RUN}B`, manager: `${RUN}C`, chief: `${RUN}F`, outsider: `${RUN}D` }
const NAME: Record<string, string> = {
  [EMP.auditAdmin]: '甲', [EMP.checker]: '乙乙', [EMP.manager]: '丙丙', [EMP.chief]: '戊戊', [EMP.outsider]: '己己',
}
const YEAR = 11000 + Math.floor(Math.random() * 1000)
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = `${RUN}資材`
const COMPANY = `${RUN}測試公司`

const STEPS = [
  { name: '自行檢查人員－資材單位', group: 'plant', signer: EMP.checker, unit: true },
  { name: '部門主管－資材單位', group: 'plant', signer: EMP.manager, unit: false },
  { name: '廠區經理人', group: 'plant', signer: EMP.manager, unit: false },
  { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unit: false },
  { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unit: false },
] as const

const ID: Record<string, string> = {}
let assessmentId = ''
const engine = nodePdfEngine()
const as = (who: string) => loginAs(who, NAME[who] ?? who)

async function submitAsChecker() {
  const me = await as(EMP.checker)
  const point = (await admin.from('assessment_control_point').select('id').eq('assessment_id', assessmentId).single()).data!
  const saved = await me.rpc('save_assessment_answers', {
    p_assessment_id: assessmentId,
    p_answers: [{ control_point_id: point.id, assessing_unit_name: UNIT, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
    p_conclusions: [{ assessing_unit_name: UNIT, conclusion: 'satisfied', exceptions: null }],
  })
  expect(saved.error).toBeNull()
  expect((await me.rpc('submit_assessment_step', { p_assessment_id: assessmentId })).data).toMatchObject({ ok: true })
}

const approveAs = async (who: string) =>
  expect((await (await as(who)).rpc('approve_assessment_step', { p_assessment_id: assessmentId })).data).toMatchObject({ ok: true })

/** What the page's 匯出 PDF reads, read here as `client`, made into the PDF and read back as text. */
async function exportAs(client: SupabaseClient) {
  const source = await readAssessmentPdfSource(client, assessmentId)
  expect(source).not.toBeNull()
  const { assessment, signoffs, company } = source!
  const pdf = await renderAssessmentPdf({ assessment, signoffs, companyName: company.name, timeZone: 'Asia/Taipei', withSignedAt: true }, engine)
  return { pages: await readPdf(pdf), signoffs }
}

beforeAll(async () => {
  await requirePostgrest()
  for (const who of Object.values(EMP)) await as(who)
  await promoteToAuditAdmin(EMP.auditAdmin)
  ID.company = (await insertRow('company', { name: COMPANY })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
  ID.template = await makeTemplate(`${RUN}t`, 'control_activity', FACTORY, [['第一章', [['請購之申請是否經權責主管核准？', ID.unit]]]])
  await makeRoute(ID.template, ID.plant, STEPS.map((s) => ({ name: s.name, group: s.group, signer: s.signer, unitId: s.unit ? ID.unit! : null })))
  const launched = await launchAssigned(await as(EMP.auditAdmin), {
    p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: ID.template, plant_id: ID.plant }],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  assessmentId = (await admin.from('assessment').select('id').eq('cycle_id', launched.data.cycle_id).single()).data!.id
})

afterAll(async () => {
  await unlistPeople(RUN) // 排進關卡時加進放行名單的人（Q150）
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant)
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
})

describe('公司 Logo', () => {
  it('seeds 福清富群 with its logo, served by the web app under logos/', async () => {
    const { data } = await admin.from('company').select('logo_path').eq('name', '福清富群電子有限公司').single()
    expect(data).toEqual({ logo_path: 'logos/fulfil.png' })
  })

  it('lets a 簽核人 read the company name and logo of the 版頭 through the 自評表', async () => {
    await admin.from('company').update({ logo_path: 'logos/test.png' }).eq('id', ID.company)
    const source = await readAssessmentPdfSource(await as(EMP.checker), assessmentId)
    expect(source?.company).toEqual({ name: COMPANY, logo_path: 'logos/test.png' })
    expect(source?.assessment.plant).toEqual({ factory_code: FACTORY, name: `${RUN}廠` })
  })
})

describe('誰能匯出', () => {
  it('gives nothing to someone not on the route, so the page says it cannot read the 自評表', async () => {
    expect(await readAssessmentPdfSource(await as(EMP.outsider), assessmentId)).toBeNull()
  })

  it('gives nothing for a 自評表 that does not exist', async () => {
    expect(await readAssessmentPdfSource(await as(EMP.checker), '00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

describe('匯出反映當下狀態', () => {
  it('signed through the 3rd 關卡: the 簽核欄 has the first three, and the 稽核主管 cell is empty', async () => {
    await submitAsChecker()
    await approveAs(EMP.manager)
    await approveAs(EMP.manager)
    // The 自行檢查人員 is still allowed to see the 自評表 (an earlier 關卡) and exports it mid-route.
    const { pages, signoffs } = await exportAs(await as(EMP.checker))
    const signaturePage = pages.at(-2)!.lines.join('\n')
    expect(signaturePage).toContain('乙乙')
    expect(signaturePage.match(/丙丙/g)).toHaveLength(2)
    for (const s of signoffs) expect(signaturePage).toContain(`No. ${s.serial_no}`)
    expect(signaturePage).not.toContain('戊戊')
    expect(pages[0]!.lines[0]).toBe(COMPANY)
  })

  it('closed after a 退回: every 關卡 is signed and the 簽核歷程 page keeps the voided sign-offs', async () => {
    const chief = await as(EMP.chief)
    expect(
      (await chief.rpc('return_assessment', { p_assessment_id: assessmentId, p_to_position: 2, p_reason: '請主管再確認' })).data,
    ).toMatchObject({ ok: true, voided: 2 })
    await approveAs(EMP.manager)
    await approveAs(EMP.manager)
    await approveAs(EMP.chief)

    const { pages, signoffs } = await exportAs(chief)
    const valid = signoffs.filter((s) => s.action !== 'return' && !s.voided_at)
    expect(valid).toHaveLength(4)
    const signaturePage = pages.at(-2)!.lines.join('\n')
    for (const s of valid) expect(signaturePage).toContain(`No. ${s.serial_no}`)
    for (const s of signoffs.filter((x) => x.voided_at)) expect(signaturePage).not.toContain(`No. ${s.serial_no}`)

    const history = allText(pages.slice(-1))
    expect(signoffs).toHaveLength(7)
    expect(history.match(/ 作廢$/gm)).toHaveLength(2)
    // No 「第 N 關」 (#99): where the 退回 went, by name, on the line below it.
    expect(history).toMatch(/ 退回 請主管再確認\n.*至 部門主管－資材單位$/m)
    for (const s of signoffs) expect(history).toMatch(new RegExp(`^${s.serial_no} `, 'm'))
  })
})
