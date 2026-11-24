// 資料 API 接縫: 內控文件、條文與內控依據（工單 #9、Q94）。內控依據綁「控制要點 × 廠區 → 條文」，發起時連同條文原文
// 凍結進自評表（ADR-0004），之後文件改版、依據改指新版，已發出的自評表照樣顯示舊版條文。畫面與 PDF 已不顯示
// （Q127），凍結照舊：這裡以凍結的兩張表嵌進自評表的查詢（FROZEN_TREE）、以各簽核人的 CSA session 經 PostgREST 讀；
// service_role 只用來準備與清理。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import MAPPING from '../../scripts/controls/references-02-FQ.json'
import { launchAssigned, admin, insertRow, loginAs, linkedAuditSteps, makeRoute, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest } from './helpers'

/** The frozen 內控文件 of a 內控依據 or a section, as #9's answer page read them before Q127. */
const DOCUMENT_COLUMNS = 'document_number,document_code,document_name,document_version,pdf_file'
const FROZEN_TREE =
  'id,assessment_section(position,name,' +
  `assessment_section_document(position,${DOCUMENT_COLUMNS}),` +
  `assessment_control_point(position,text,assessment_control_reference(position,${DOCUMENT_COLUMNS},clause_number,clause_text)))`

const RUN = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A`, checker: `${RUN}C`, manager: `${RUN}M` }
const YEAR = 16000 + Math.floor(Math.random() * 900)
const DUE = '2099-12-31'
const FACTORY = `${RUN}F`.toUpperCase()
const OTHER_FACTORY = `${RUN}G`.toUpperCase()
const UNIT = `${RUN}資材`

const ID: Record<string, string> = {}
let boss: SupabaseClient
let checker: SupabaseClient
let manager: SupabaseClient

interface Reference {
  position: number
  document_number: string
  document_code: string
  document_name: string
  document_version: string
  pdf_file: string | null
  clause_number: string
  clause_text: string
}
interface Tree {
  assessment_section: {
    position: number
    name: string
    assessment_section_document: Omit<Reference, 'clause_number' | 'clause_text'>[]
    assessment_control_point: { position: number; text: string; assessment_control_reference: Reference[] }[]
  }[]
}

/** One version of a 內控文件 with its clauses in order; returns clause number → id. */
async function documentVersion(documentId: string, version: string, clauses: [string, string][]) {
  const v = await insertRow('control_document_version', {
    document_id: documentId, version, effective_date: '2024-01-01', pdf_file: `FQQP-PR90_${version}.pdf`,
  })
  const ids: Record<string, string> = { version: v.id }
  for (const [i, [number, text]] of clauses.entries()) {
    ids[number] = (await insertRow('control_clause', { version_id: v.id, position: i + 1, number, text })).id
  }
  return ids
}

async function launch(year: number) {
  const result = ok(
    await launchAssigned(boss, { p_year: year, p_due_date: DUE, p_combos: [{ template_id: ID.template, plant_id: ID.plant }] }),
  ) as { ok: boolean }
  expect(result).toMatchObject({ ok: true })
  return ok(await admin.from('assessment').select('id,cycle_id,annual_cycle!inner(year)').eq('template_id', ID.template).eq('annual_cycle.year', year).single<{ id: string }>()).id
}

async function tree(client: SupabaseClient, id: string): Promise<Tree | null> {
  const { data, error } = await client.from('assessment').select(FROZEN_TREE).eq('id', id).maybeSingle<Tree>()
  if (error) throw new Error(JSON.stringify(error))
  return data
}

/** What the page shows per control point: its 內控依據 as short code and clause text, in order. */
function shown(t: Tree) {
  return t.assessment_section[0]!.assessment_control_point
    .sort((a, b) => a.position - b.position)
    .map((p) =>
      [...p.assessment_control_reference]
        .sort((a, b) => a.position - b.position)
        .map((r) => [`${r.document_code} §${r.clause_number}`, r.document_version, r.clause_text]),
    )
}

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.boss, '甲')
  await promoteToAuditAdmin(EMP.boss)
  boss = await loginAs(EMP.boss, '甲')
  checker = await loginAs(EMP.checker, '乙')
  manager = await loginAs(EMP.manager, '丙')

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  ID.otherPlant = (await insertRow('plant', { factory_code: OTHER_FACTORY, name: `${RUN}別廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
  ID.template = await makeTemplate(`${RUN}T`, 'control_activity', FACTORY, [
    ['供應商管理作業', [['是否由兩家以上之廠商供應？', ID.unit], ['供應商之評估作業是否切實依規定辦理？', ID.unit], ['沒有對應條文的題目', ID.unit]]],
  ])
  await makeRoute(ID.template, ID.plant, [
    { name: '自行檢查人員', group: 'plant', signer: EMP.checker, unitId: ID.unit },
    { name: '部門主管', group: 'plant', signer: EMP.manager, unitId: null },
    ...linkedAuditSteps(EMP.boss),
  ])
  const points = ok(
    await admin.from('control_point').select('id,position,template_section!inner(template_id)').eq('template_section.template_id', ID.template).order('position'),
  ) as { id: string }[]
  ID.point1 = points[0]!.id
  ID.point2 = points[1]!.id
  ID.section = ok(await admin.from('template_section').select('id').eq('template_id', ID.template).single<{ id: string }>()).id

  ID.document = (await insertRow('control_document', { plant_id: ID.plant, number: 'FQQP-PR90', code: 'PR90', name: '供應商管理作業' })).id
  const v1 = await documentVersion(ID.document!, '1.0', [
    ['5', '作業內容'],
    ['5.2', '供應商初期評鑑'],
    ['5.2.1', '評鑑方式分為實地評鑑、書面評鑑及免評鑑三種。'],
    ['5.2.2', '應以實地評鑑為作業基本原則。'],
    ['5.20', '不是 5.2 的子條文。'],
    ['6', '控制重點'],
    ['6.1', '盡可能由兩家以上之廠商供應。'],
    ['6.2', '供應商之評估作業應切實依規定辦理。'],
  ])
  ID.v1 = v1.version!
  await insertRow('section_control_document', { section_id: ID.section, plant_id: ID.plant, position: 1, version_id: v1.version })
  await insertRow('control_reference', { control_point_id: ID.point1, plant_id: ID.plant, position: 1, clause_id: v1['6.1'] })
  await insertRow('control_reference', { control_point_id: ID.point2, plant_id: ID.plant, position: 1, clause_id: v1['6.2'] })
  await insertRow('control_reference', { control_point_id: ID.point2, plant_id: ID.plant, position: 2, clause_id: v1['5.2'] })
  // 同一個控制要點在別的廠區對到那個廠區自己的文件，不會跑進這個廠區的自評表。
  const otherDocument = (await insertRow('control_document', { plant_id: ID.otherPlant, number: 'XXQP-PR90', code: 'PR90', name: '別廠的文件' })).id
  const other = await documentVersion(otherDocument, '1.0', [['6.1', '別廠的條文。']])
  await insertRow('control_reference', { control_point_id: ID.point1, plant_id: ID.otherPlant, position: 1, clause_id: other['6.1'] })

  ID.assessment = await launch(YEAR)
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().gte('year', 16000).lt('year', 17000)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant ?? '')
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
  await admin.from('control_document').delete().in('plant_id', [ID.plant ?? '', ID.otherPlant ?? ''])
  await admin.from('plant').delete().in('factory_code', [FACTORY, OTHER_FACTORY])
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
})

describe('發起: 內控依據隨自評表凍結', () => {
  it('copies each control point’s 內控依據 for this 廠區 in order, a clause with its sub-clauses, and leaves the rest blank', async () => {
    expect(shown((await tree(checker, ID.assessment!))!)).toEqual([
      [['PR90 §6.1', '1.0', '6.1 盡可能由兩家以上之廠商供應。']],
      [
        ['PR90 §6.2', '1.0', '6.2 供應商之評估作業應切實依規定辦理。'],
        ['PR90 §5.2', '1.0', '5.2 供應商初期評鑑\n5.2.1 評鑑方式分為實地評鑑、書面評鑑及免評鑑三種。\n5.2.2 應以實地評鑑為作業基本原則。'],
      ],
      [],
    ])
  })

  it('copies the section’s 內控文件 with its version and PDF file', async () => {
    const section = (await tree(checker, ID.assessment!))!.assessment_section[0]!
    expect(section.assessment_section_document).toEqual([
      { position: 1, document_number: 'FQQP-PR90', document_code: 'PR90', document_name: '供應商管理作業', document_version: '1.0', pdf_file: 'FQQP-PR90_1.0.pdf' },
    ])
    expect(section.assessment_control_point.find((p) => p.position === 1)!.assessment_control_reference[0]).toMatchObject({
      document_number: 'FQQP-PR90', document_name: '供應商管理作業', pdf_file: 'FQQP-PR90_1.0.pdf',
    })
  })

  it('keeps showing the old clauses after the 內控文件 is revised and the 內控依據 point at the new version', async () => {
    const v2 = await documentVersion(ID.document!, '2.0', [
      ['6', '控制重點'],
      ['6.1', '至少由兩家以上之廠商供應（改版）。'],
    ])
    ok(await admin.from('control_reference').delete().eq('control_point_id', ID.point1).eq('plant_id', ID.plant))
    await insertRow('control_reference', { control_point_id: ID.point1, plant_id: ID.plant, position: 1, clause_id: v2['6.1'] })
    // 改版後舊版條文就算被改掉，已發出的自評表也不受影響：它存的是發起當時的原文。
    ok(await admin.from('control_clause').update({ text: '舊版被改了' }).eq('version_id', ID.v1).eq('number', '6.2'))

    const old = shown((await tree(checker, ID.assessment!))!)
    expect(old[0]).toEqual([['PR90 §6.1', '1.0', '6.1 盡可能由兩家以上之廠商供應。']])
    expect(old[1]![0]).toEqual(['PR90 §6.2', '1.0', '6.2 供應商之評估作業應切實依規定辦理。'])

    const next = await launch(YEAR + 1)
    expect(shown((await tree(boss, next))!)[0]).toEqual([['PR90 §6.1', '2.0', '6.1 至少由兩家以上之廠商供應（改版）。']])
  })
})

describe('誰讀得到、誰寫得到', () => {
  it('shows the frozen 內控依據 only to those who see the 自評表', async () => {
    // 部門主管還沒輪到：讀不到自評表，也讀不到它的內控依據。
    expect(await tree(manager, ID.assessment!)).toBeNull()
    expect(ok(await manager.from('assessment_control_reference').select('clause_number').eq('assessment_id', ID.assessment!))).toEqual([])
    expect(ok(await manager.from('assessment_section_document').select('document_code').eq('assessment_id', ID.assessment!))).toEqual([])
    expect(ok(await checker.from('assessment_control_reference').select('clause_number').eq('assessment_id', ID.assessment!))).toHaveLength(3)
  })

  it('has no API writes on the snapshot, for anyone', async () => {
    const write = await boss.from('assessment_control_reference').update({ clause_text: '竄改' }).eq('assessment_id', ID.assessment!)
    expect(write.error?.code).toBe('42501')
    const insert = await boss.from('assessment_section_document').insert({
      assessment_id: ID.assessment, section_id: ID.section, position: 9, document_number: 'X', document_code: 'X', document_name: 'X', document_version: '1',
    })
    expect(insert.error?.code).toBe('42501')
  })

  it('keeps a 內控文件 version once a 自評表 froze it, even after no 內控依據 points at it any more', async () => {
    // A document of its own, mapped, frozen by a launch, then unmapped again.
    const documentId = (await insertRow('control_document', { plant_id: ID.plant, number: 'FQQP-PR91', code: 'PR91', name: '用過的文件' })).id
    const used = await documentVersion(documentId, '1.0', [['6.1', '用過的條文。']])
    await insertRow('control_reference', { control_point_id: ID.point2, plant_id: ID.plant, position: 3, clause_id: used['6.1'] })
    await launch(YEAR + 2)
    ok(await admin.from('control_reference').delete().eq('clause_id', used['6.1']!))

    expect((await admin.from('control_document_version').delete().eq('id', used.version!)).error?.code).toBe('23503')
    expect((await admin.from('control_document').delete().eq('id', documentId)).error?.code).toBe('23503')
    expect(ok(await admin.from('control_document_version').select('version').eq('id', used.version!))).toEqual([{ version: '1.0' }])

    // A version no 自評表 ever froze can still be removed (e.g. a mistaken conversion before any launch).
    const unused = await documentVersion(documentId, '9.9', [['6.1', '沒用過。']])
    ok(await admin.from('control_document_version').delete().eq('id', unused.version!))
  })

  it('refuses a 內控依據 or 本章依據 that points at another 廠區’s 內控文件, for every role', async () => {
    const v1Clause = ok(await admin.from('control_clause').select('id').eq('version_id', ID.v1!).eq('number', '6.1').single<{ id: string }>()).id
    const reference = await admin.from('control_reference').insert({
      control_point_id: ID.point2, plant_id: ID.otherPlant, position: 9, clause_id: v1Clause,
    })
    expect(reference.error?.code).toBe('23514')
    const section = await admin.from('section_control_document').insert({
      section_id: ID.section, plant_id: ID.otherPlant, position: 1, version_id: ID.v1,
    })
    expect(section.error?.code).toBe('23514')
  })

  it('lets the 稽核管理者 read the 內控文件 and 內控依據, nobody write them through the API', async () => {
    expect(ok(await boss.from('control_document').select('code').eq('plant_id', ID.plant))).toContainEqual({ code: 'PR90' })
    expect(ok(await checker.from('control_document').select('code').eq('plant_id', ID.plant))).toEqual([])
    expect(ok(await checker.from('control_reference').select('position').eq('control_point_id', ID.point2))).toEqual([])
    expect((await boss.from('control_clause').insert({ version_id: ID.v1, position: 99, number: '9.9', text: 'x' })).error?.code).toBe('42501')
    expect((await boss.from('control_reference').delete().eq('control_point_id', ID.point2).select()).error?.code).toBe('42501')
  })
})

describe('種子: 福清 02 的內控依據初稿（Q38）', () => {
  /** The seeded 內控依據 of 02's control point `section`.`point` at 福清, as short codes in order. */
  async function seeded(section: number, point: number) {
    const rows = ok(
      await boss
        .from('control_reference')
        .select('position,plant!inner(factory_code),control_clause(number,control_document_version(control_document(code))),control_point!inner(position,template_section!inner(position,questionnaire_template!inner(code)))')
        .eq('plant.factory_code', 'FQ')
        .eq('control_point.position', point)
        .eq('control_point.template_section.position', section)
        .eq('control_point.template_section.questionnaire_template.code', 'FQ-02'),
    ) as unknown as { position: number; control_clause: { number: string; control_document_version: { control_document: { code: string } } } }[]
    return rows
      .sort((a, b) => a.position - b.position)
      .map((r) => `${r.control_clause.control_document_version.control_document.code} §${r.control_clause.number}`)
  }

  it('maps 02 to the 福清 PR01–PR08 clauses as drafted, leaving unmatched control points blank', async () => {
    expect(await seeded(1, 1)).toEqual(['PR01 §6.1'])
    expect(await seeded(2, 7)).toEqual([])
    expect(await seeded(6, 7)).toEqual(['PR08 §5.3'])
    expect(await seeded(8, 5)).toEqual(['PR08 §5.5'])
  })

  it('attaches every 內控依據 of the mapping file to the control point with that text, in order', async () => {
    const rows = ok(
      await boss
        .from('control_reference')
        .select('position,plant!inner(factory_code),control_clause(number,control_document_version(control_document(code))),control_point!inner(text,template_section!inner(position,questionnaire_template!inner(code)))')
        .eq('plant.factory_code', 'FQ')
        .eq('control_point.template_section.questionnaire_template.code', 'FQ-02'),
    ) as unknown as {
      position: number
      control_clause: { number: string; control_document_version: { control_document: { code: string } } }
      control_point: { text: string; template_section: { position: number } }
    }[]
    const actual = new Map<string, string[]>()
    for (const r of [...rows].sort((a, b) => a.position - b.position)) {
      const key = `${r.control_point.template_section.position} ${r.control_point.text}`
      actual.set(key, [...(actual.get(key) ?? []), `${r.control_clause.control_document_version.control_document.code} §${r.control_clause.number}`])
    }
    const expected = new Map(
      MAPPING.sections.flatMap((s) => s.controlPoints.filter((p) => p.references.length > 0).map((p) => [`${s.position} ${p.text}`, p.references] as const)),
    )
    expect(actual).toEqual(expected)
    expect(rows).toHaveLength(68)
  })

  it('records PR01 at its latest revision, 2.0 of 2021-07-01', async () => {
    const versions = ok(
      await boss
        .from('control_document_version')
        .select('version,effective_date,pdf_file,control_document!inner(code,plant!inner(factory_code))')
        .eq('control_document.code', 'PR01')
        .eq('control_document.plant.factory_code', 'FQ'),
    )
    expect(versions).toMatchObject([{ version: '2.0', effective_date: '2021-07-01', pdf_file: 'FQQP-PR01_2.0.pdf' }])
  })
})
