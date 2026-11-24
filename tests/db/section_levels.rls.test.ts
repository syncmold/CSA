// 多層章節與原檔題號（工單 #166，Q125）：範本管理寫層級與題號、對話寫入帶層級與題號、年度發起照抄進快照、內容指紋
// 算進層級與題號。寫入都以稽核主管的 CSA session 走 PostgREST（對話寫入以 csa_drafter 直接連線），service_role 只用來
// 準備與清理。每次執行建立自己的範本、廠區與自評單位，結束時全部清掉。
import type { SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drafterConnectionString } from '../../scripts/drafts/connection.ts'
import { admin, insertRow, launchAssigned, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest, withSuperuser } from './helpers'

// 資料庫測試檔案並行執行：前綴與隨機尾巴避免和其他檔案的工號、年度、範本編號撞在一起。
const RUN = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A`, signer: `${RUN}B` }
const YEAR = 14000 + Math.floor(Math.random() * 1000)
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = `${RUN}研發單位`

const ID: Record<string, string> = {}
const createdTemplates: string[] = []
let boss: SupabaseClient
let signer: SupabaseClient
let drafter: pg.Client

interface SectionRow {
  position: number
  level: number
  code: string | null
  name: string
  control_point: { position: number; code: string | null; text: string }[]
}

/** 範本的章節（依序）：層級、題號、名稱，與各自的控制要點（依序）的題號與文字。 */
async function outlineOf(templateId: string) {
  const rows = ok(
    await boss.from('template_section').select('position,level,code,name,control_point(position,code,text)').eq('template_id', templateId).order('position'),
  ) as SectionRow[]
  return rows.map((s) => [s.level, s.code, s.name, [...s.control_point].sort((a, b) => a.position - b.position).map((p) => [p.code, p.text])])
}

async function createTemplate(code: string) {
  const id = ok(
    await boss.rpc('create_template', {
      p_code: code,
      p_name: `${code} 研發循環`,
      p_component: 'control_activities',
      p_all_plants: false,
      p_factory_codes: [FACTORY],
    }),
  ) as string
  createdTemplates.push(id)
  return id
}

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.signer, '甲')
  await loginAs(EMP.boss, '丙')
  await promoteToAuditAdmin(EMP.boss)
  boss = await loginAs(EMP.boss, '丙')
  signer = await loginAs(EMP.signer, '甲')

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id

  const url = new URL(drafterConnectionString(process.env))
  await withSuperuser((sql) =>
    sql.query(`alter role ${sql.escapeIdentifier(url.username)} with login password ${sql.escapeLiteral(decodeURIComponent(url.password))}`),
  )
  drafter = new pg.Client({ connectionString: url.toString() })
  await drafter.connect()
})

afterAll(async () => {
  await drafter?.end()
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant ?? '')
  if (createdTemplates.length) await admin.from('questionnaire_template').delete().in('id', createdTemplates)
  await admin.from('questionnaire_template').delete().like('code', `${RUN}%`)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
})

describe('範本管理：章節層級與題號', () => {
  it('a 稽核管理者 sets a section’s 層級 and 題號 and a control point’s 題號; a blank 題號 is none', async () => {
    const id = await createTemplate(`${RUN}E`)
    const head = ok(
      await boss.from('template_section').insert({ template_id: id, name: '董事會應重視誠信。', level: 1, code: '1' }).select('id').single<{ id: string }>(),
    )
    const sub = ok(await boss.from('template_section').insert({ template_id: id, name: '是否建立行為準則？' }).select('id').single<{ id: string }>())
    ok(await boss.from('template_section').update({ level: 2, code: '1.1' }).eq('id', sub.id))
    const coded = ok(await boss.rpc('create_control_point', { p_section_id: sub.id, p_text: '是否建立董事行為準則？', p_unit_ids: [ID.unit], p_code: ' 1.1.1-1 ' }))
    ok(await boss.rpc('create_control_point', { p_section_id: sub.id, p_text: '是否建立員工行為準則？', p_unit_ids: [ID.unit], p_code: '' }))
    ok(await boss.rpc('create_control_point', { p_section_id: sub.id, p_text: '是否告知所有成員？', p_unit_ids: [ID.unit] }))

    expect(await outlineOf(id)).toEqual([
      [1, '1', '董事會應重視誠信。', []],
      [
        2,
        '1.1',
        '是否建立行為準則？',
        [
          ['1.1.1-1', '是否建立董事行為準則？'],
          [null, '是否建立員工行為準則？'],
          [null, '是否告知所有成員？'],
        ],
      ],
    ])

    ok(await boss.rpc('update_control_point', { p_control_point_id: coded, p_text: '是否建立董事行為準則？', p_unit_ids: [ID.unit], p_code: '  ' }))
    ok(await boss.from('template_section').update({ code: null }).eq('id', head.id))
    expect((await outlineOf(id)).map((s) => s[1])).toEqual([null, '1.1'])
    expect(((await outlineOf(id))[1]![3] as unknown[])[0]).toEqual([null, '是否建立董事行為準則？'])
  })

  it('refuses a 層級 outside 1–3 and a blank or untrimmed 題號 written straight to the table', async () => {
    const id = await createTemplate(`${RUN}F`)
    for (const row of [{ level: 4 }, { level: 0 }, { code: '' }, { code: ' 1.1' }]) {
      const { error } = await boss.from('template_section').insert({ template_id: id, name: '章', ...row })
      expect(error?.code, JSON.stringify(row)).toBe('23514')
    }
  })

  it('keeps the line breaks typed in a control point’s text (Q126, #170)', async () => {
    const id = await createTemplate(`${RUN}N`)
    const section = ok(await boss.from('template_section').insert({ template_id: id, name: '銷售作業' }).select('id').single<{ id: string }>())
    const text = '銷貨單據是否序時序號連續開立？\n(若客戶端採上線模式始確認銷貨者，另應含括上線單據)'
    ok(await boss.rpc('create_control_point', { p_section_id: section.id, p_text: text, p_unit_ids: [ID.unit] }))
    expect(await outlineOf(id)).toEqual([[1, null, '銷售作業', [[null, text]]]])
  })

  it('refuses every 層級 and 題號 write from a signer', async () => {
    const id = await createTemplate(`${RUN}G`)
    const section = ok(await boss.from('template_section').insert({ template_id: id, name: '章' }).select('id').single<{ id: string }>())
    const update = await signer.from('template_section').update({ level: 2, code: '1' }).eq('id', section.id).select()
    expect(update.data ?? []).toEqual([])
    const { error } = await signer.rpc('create_control_point', { p_section_id: section.id, p_text: '題？', p_unit_ids: [ID.unit], p_code: '1' })
    expect(error?.code).toBe('42501')
    expect(await outlineOf(id)).toEqual([[1, null, '章', []]])
  })

  it('counts 層級 and 題號 as content: the same names on other levels are not the same template (Q111)', async () => {
    const make = async (suffix: string, level: number) => {
      const id = await createTemplate(`${RUN}${suffix}`)
      for (const [name, lv] of [
        ['新產品導入管制作業', 1],
        ['估價階段', level],
      ] as const) {
        ok(await boss.from('template_section').insert({ template_id: id, name, level: lv }))
      }
      return id
    }
    const fingerprint = async (id: string) =>
      (ok(await boss.from('questionnaire_template').select('content_fingerprint').eq('id', id).single<{ content_fingerprint: string }>())).content_fingerprint
    const [flat, nested, nestedAgain] = [await make('H1', 1), await make('H2', 2), await make('H3', 2)]
    expect(await fingerprint(flat)).not.toBe(await fingerprint(nested))
    expect(await fingerprint(nested)).toBe(await fingerprint(nestedAgain))
  })
})

describe('對話寫入：level 與 code', () => {
  const def = (code: string, sections: unknown[]) => ({
    kind: 'template',
    code,
    name: `${code} 研發循環`,
    layout: 'control_activity',
    allPlants: false,
    factoryCodes: [FACTORY],
    sections,
  })
  const draft = async (d: object) => (await drafter.query('select public.draft_template($1::jsonb) as result', [JSON.stringify(d)])).rows[0].result

  it('writes 上層標題 without control points, the 層級 and the 題號 of sections and control points', async () => {
    const code = `${RUN}D1`
    await draft(
      def(code, [
        { name: '新產品導入管制作業', controlPoints: [] },
        { level: 2, name: 'DVT(設計驗證測試階段)', controlPoints: [] },
        { level: 3, code: '1.1', name: '開模通知', controlPoints: [{ code: '1.1.1-1', text: '是否發出開模通知？', assessingUnits: [UNIT] }] },
        { name: '工程變更作業', controlPoints: [{ text: '是否提出工程變更？', assessingUnits: [UNIT] }] },
      ]),
    )
    const tpl = ok(await boss.from('questionnaire_template').select('id').eq('code', code).single<{ id: string }>())
    expect(await outlineOf(tpl.id)).toEqual([
      [1, null, '新產品導入管制作業', []],
      [2, null, 'DVT(設計驗證測試階段)', []],
      [3, '1.1', '開模通知', [['1.1.1-1', '是否發出開模通知？']]],
      [1, null, '工程變更作業', [[null, '是否提出工程變更？']]],
    ])
  })

  it('keeps the line breaks of a control point’s text (Q126, #170)', async () => {
    const code = `${RUN}D3`
    const text = '內部稽核單位是否評估下列暴險，包括：\n· 企業策略目標之達成。\n· 資產之保全。'
    await draft(def(code, [{ name: '稽核作業', controlPoints: [{ text, assessingUnits: [UNIT] }] }]))
    const tpl = ok(await boss.from('questionnaire_template').select('id').eq('code', code).single<{ id: string }>())
    expect(await outlineOf(tpl.id)).toEqual([[1, null, '稽核作業', [[null, text]]]])
  })

  it('refuses a first section below 第 1 層, a skipped level and a level outside 1–3', async () => {
    const point = { text: '題？', assessingUnits: [UNIT] }
    for (const sections of [
      [{ level: 2, name: '甲', controlPoints: [point] }],
      [
        { name: '甲', controlPoints: [] },
        { level: 3, name: '乙', controlPoints: [point] },
      ],
      [
        { name: '甲', controlPoints: [] },
        { level: 'x', name: '乙', controlPoints: [point] },
      ],
    ]) {
      await expect(draft(def(`${RUN}D2`, sections)), JSON.stringify(sections)).rejects.toMatchObject({ code: '22023', hint: 'section_level' })
    }
  })
})

describe('年度發起：快照照抄層級與題號（ADR-0004）', () => {
  it('copies each section’s 層級 and 題號 and each control point’s 題號 into the 自評表, and later edits leave it as it was', async () => {
    const templateId = await makeTemplate(`${RUN}L`, 'control_activity', FACTORY, [
      ['董事會應重視誠信。', []],
      ['是否建立行為準則？', [['是否建立董事行為準則？', ID.unit!]]],
    ])
    createdTemplates.push(templateId)
    const sections = ok(await admin.from('template_section').select('id,position').eq('template_id', templateId).order('position')) as { id: string }[]
    ok(await admin.from('template_section').update({ code: '1' }).eq('id', sections[0]!.id))
    ok(await admin.from('template_section').update({ level: 2, code: '1.1' }).eq('id', sections[1]!.id))
    ok(await admin.from('control_point').update({ code: '1.1.1-1' }).eq('section_id', sections[1]!.id))
    await makeRoute(templateId, ID.plant!, [
      { name: '自行檢查人員', group: 'plant', signer: EMP.boss, unitId: ID.unit! },
      { name: '台北稽核人員', group: 'audit_review', signer: EMP.boss, unitId: null },
      { name: '稽核主管', group: 'audit_review', signer: EMP.boss, unitId: null },
    ])

    const launched = await launchAssigned(boss, { p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: templateId, plant_id: ID.plant }] })
    expect(launched.data).toMatchObject({ ok: true, assessments: 1 })
    const assessment = ok(
      await boss.from('assessment').select('id').eq('cycle_id', (launched.data as { cycle_id: string }).cycle_id).single<{ id: string }>(),
    )
    const snapshot = async () =>
      (
        ok(
          await boss
            .from('assessment_section')
            .select('position,level,code,name,assessment_control_point(code,text)')
            .eq('assessment_id', assessment.id)
            .order('position'),
        ) as { level: number; code: string | null; name: string; assessment_control_point: { code: string | null; text: string }[] }[]
      ).map((s) => [s.level, s.code, s.name, s.assessment_control_point.map((p) => [p.code, p.text])])
    const issued = [
      [1, '1', '董事會應重視誠信。', []],
      [2, '1.1', '是否建立行為準則？', [['1.1.1-1', '是否建立董事行為準則？']]],
    ]
    expect(await snapshot()).toEqual(issued)

    ok(await boss.from('template_section').update({ level: 1, code: '2' }).eq('id', sections[1]!.id))
    expect(await snapshot()).toEqual(issued)
  })
})
