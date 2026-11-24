// 資料 API 接縫: 範本管理編輯（工單 #10）。所有寫入都以稽核管理者的 CSA session 走 PostgREST，
// 不用 service_role，因為要驗的正是 API 開給誰、擋下什麼。service_role 只用來準備與清理。
// 每次執行建立自己的公司、廠區、範本與自評單位，結束時全部清掉；不動真實範本 02（其他測試檔會並行讀它）。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchAssigned, admin, insertRow, loginAs, makeRoute, makeTemplate, promoteToAuditAdmin, requirePostgrest, withSuperuser } from './helpers'

// 資料庫測試檔案並行執行：前綴與隨機尾巴避免和其他檔案的工號、年度撞在一起。
const RUN = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A`, signer: `${RUN}B` }
const YEAR = 8000 + Math.floor(Math.random() * 1000)
const DUE = '2099-12-31'
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = { a: `${RUN}甲單位`, b: `${RUN}乙單位`, fresh: `${RUN}新單位` }

const ID: Record<string, string> = {}
const createdTemplates: string[] = []
let boss: SupabaseClient
let signer: SupabaseClient

/** Throws on a PostgREST error; writes without `.select()` come back with null data, which callers ignore. */
function ok<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.error) throw new Error(JSON.stringify(result.error))
  return result.data as NonNullable<T>
}

interface Header {
  code: string
  name: string
  layout: 'element' | 'control_activity'
  status?: 'active' | 'inactive'
  all_plants?: boolean
  factory_codes?: (string | null)[]
}

/**
 * 以稽核主管身分新增一份範本（走 create_template；新範本是啟用，Q137 (5)），記下來給 afterAll 清。
 * 要停用的再走 update_template 改狀態。
 */
async function createTemplate(h: Header) {
  const id = ok(
    await boss.rpc('create_template', {
      p_code: h.code,
      p_name: h.name,
      p_component: h.layout === 'control_activity' ? 'control_activities' : 'control_environment',
      p_all_plants: h.all_plants ?? false,
      p_factory_codes: h.factory_codes ?? [],
    }),
  ) as string
  createdTemplates.push(id)
  if (h.status === 'inactive') {
    ok(await boss.rpc('update_template', {
      p_template_id: id, p_code: h.code, p_name: h.name, p_status: 'inactive', p_all_plants: h.all_plants ?? false, p_factory_codes: h.factory_codes ?? [],
    }))
  }
  return id
}

async function addSection(templateId: string, name: string) {
  return ok(await boss.from('template_section').insert({ template_id: templateId, name }).select('id,position').single<{ id: string; position: number }>())
}

/** 新增控制要點連同它的自評單位（走 create_control_point，#46）。 */
async function addPoint(sectionId: string, text: string, unitId: string | null = null) {
  const id = ok(await boss.rpc('create_control_point', { p_section_id: sectionId, p_text: text, p_unit_ids: unitId ? [unitId] : [] })) as string
  return ok(await boss.from('control_point').select('id,position').eq('id', id).single<{ id: string; position: number }>())
}

/** 控制要點的自評單位名稱，依作答順序。 */
async function unitsOf(pointId: string) {
  const row = ok(
    await boss
      .from('control_point')
      .select('control_point_unit(position,assessing_unit(name))')
      .eq('id', pointId)
      .single<{ control_point_unit: { position: number; assessing_unit: { name: string } }[] }>(),
  )
  return [...row.control_point_unit].sort((a, b) => a.position - b.position).map((u) => u.assessing_unit.name)
}

async function sectionNames(client: SupabaseClient, templateId: string) {
  const rows = ok(await client.from('template_section').select('name,position').eq('template_id', templateId).order('position'))
  return rows.map((r) => `${r.position}.${r.name}`)
}

async function pointTexts(client: SupabaseClient, sectionId: string) {
  const rows = ok(await client.from('control_point').select('text,position').eq('section_id', sectionId).order('position'))
  return rows.map((r) => `${r.position}.${r.text}`)
}

async function plantCodes(templateId: string) {
  return ok(await admin.from('template_plant').select('factory_code').eq('template_id', templateId))
    .map((r) => r.factory_code as string)
    .sort()
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
  for (const name of [UNIT.a, UNIT.b]) ID[name] = (await insertRow('assessing_unit', { name })).id
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant ?? '')
  if (createdTemplates.length) await admin.from('questionnaire_template').delete().in('id', createdTemplates)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().in('name', Object.values(UNIT))
})

describe('範本管理編輯: 新增與版型', () => {
  it('creates an 要素類 template with sections and control points that are still there on a fresh session', async () => {
    const id = await createTemplate({ code: `${RUN}A`, name: '控制環境', layout: 'element' })
    const first = await addSection(id, '（一）高階管理階層應重視誠信與道德價值')
    const second = await addSection(id, '（二）董事會應負監督責任')
    expect([first.position, second.position]).toEqual([1, 2]) // 位置由資料庫排到最後
    await addPoint(first.id, '是否訂定道德行為準則？')
    await addPoint(first.id, '是否宣導誠信經營？')
    await addPoint(second.id, '董事會是否定期開會？')

    const again = await loginAs(EMP.boss, '丙') // 相當於重新整理：新的 session、重新查
    const tree = ok(
      await again
        .from('questionnaire_template')
        .select('code,layout,status,template_section(position,name,control_point(position,text,control_point_unit(position,assessing_unit_id)))')
        .eq('id', id)
        .single<{
          code: string
          layout: string
          status: string
          template_section: {
            position: number
            name: string
            control_point: { position: number; text: string; control_point_unit: { position: number; assessing_unit_id: string }[] }[]
          }[]
        }>(),
    )
    expect(tree).toMatchObject({ code: `${RUN}A`, layout: 'element', status: 'active' }) // 新範本是啟用（Q137 (5)：沒有草稿）
    const sections = [...tree.template_section].sort((a, b) => a.position - b.position)
    const unitIds = (p: { control_point_unit: { position: number; assessing_unit_id: string }[] }) =>
      [...p.control_point_unit].sort((a, b) => a.position - b.position).map((u) => u.assessing_unit_id)
    expect(sections.map((s) => [s.name, [...s.control_point].sort((a, b) => a.position - b.position).map((p) => [p.position, p.text, unitIds(p)])])).toEqual([
      ['（一）高階管理階層應重視誠信與道德價值', [[1, '是否訂定道德行為準則？', []], [2, '是否宣導誠信經營？', []]]],
      ['（二）董事會應負監督責任', [[1, '董事會是否定期開會？', []]]],
    ])
  })

  it('never lets the 版型 change, not through the API and not even for service_role', async () => {
    const id = await createTemplate({ code: `${RUN}L`, name: '版型測試', layout: 'element' })
    const viaApi = await boss.from('questionnaire_template').update({ layout: 'control_activity' }).eq('id', id)
    expect(viaApi.error?.code).toBe('42501') // 範本表沒有直接寫入授權
    const viaService = await admin.from('questionnaire_template').update({ layout: 'control_activity' }).eq('id', id)
    expect(viaService.error?.code).toBe('22023') // 觸發器

    // 其他抬頭欄位由 update_template 一次改（它沒有版型參數）；停用的範本不會被別的測試的發起帶到
    ok(
      await boss.rpc('update_template', {
        p_template_id: id, p_code: ` ${RUN}L2 `, p_name: '改名', p_status: 'inactive', p_all_plants: true,
      }),
    )
    const header = ok(await boss.from('questionnaire_template').select('code,name,status,all_plants,layout').eq('id', id).single())
    expect(header).toEqual({ code: `${RUN}L2`, name: '改名', status: 'inactive', all_plants: true, layout: 'element' })
  })

  it('requires a 自評單位 on 控制活動類 control points; on 要素類 it is optional', async () => {
    const activity = await createTemplate({ code: `${RUN}C`, name: '控制活動', layout: 'control_activity' })
    const element = await createTemplate({ code: `${RUN}E`, name: '要素', layout: 'element' })
    const sa = await addSection(activity, '章')
    const se = await addSection(element, '章')

    const missing = await boss.rpc('create_control_point', { p_section_id: sa.id, p_text: '沒有單位', p_unit_ids: [] })
    expect(missing.error?.code).toBe('23514')
    const point = await addPoint(sa.id, '有單位', ID[UNIT.a])
    const cleared = await boss.rpc('update_control_point', { p_control_point_id: point.id, p_text: '有單位', p_unit_ids: [] })
    expect(cleared.error?.code).toBe('23514')
    expect(await unitsOf(point.id)).toEqual([UNIT.a])
    expect(await pointTexts(boss, sa.id)).toEqual(['1.有單位'])

    // 要素類：整份可以掛同一個自評單位（交給一個自行檢查人員答，#5），也可以不掛
    await addPoint(se.id, '有單位', ID[UNIT.a])
    await addPoint(se.id, '沒有單位')
    expect(await pointTexts(boss, se.id)).toEqual(['1.有單位', '2.沒有單位'])
  })

  it('allows one template per 編號 (Q137 (4)), also for renames and writes that bypass the screen, and refuses a blank header', async () => {
    await createTemplate({ code: `${RUN}D`, name: '一', layout: 'element' })
    const dup = await boss.rpc('create_template', { p_code: ` ${RUN}D `, p_name: '二', p_component: 'control_environment' })
    expect(dup.error?.code).toBe('23505')
    const other = await createTemplate({ code: `${RUN}D2`, name: '二', layout: 'element' })
    const renamed = await boss.rpc('update_template', { p_template_id: other, p_code: `${RUN}D`, p_name: '二', p_status: 'active', p_all_plants: false })
    expect(renamed.error?.code).toBe('23505')
    const bypass = await withSuperuser((sql) =>
      sql
        .query(`insert into public.questionnaire_template (code, name, layout) values ($1, 'x', 'element')`, [`${RUN}D`])
        .then(() => null, (e: { code?: string }) => e.code),
    )
    expect(bypass).toBe('23505')
    const blank = await boss.rpc('create_template', { p_code: '  ', p_name: '空白', p_component: 'control_environment' })
    expect(blank.error?.code).toBe('23514')
  })
})

describe('範本管理編輯: 章節與控制要點', () => {
  it('renames, reorders and deletes sections, keeping positions 1..n', async () => {
    const id = await createTemplate({ code: `${RUN}S`, name: '章節', layout: 'element' })
    const [a, b, c] = [await addSection(id, '甲'), await addSection(id, '乙'), await addSection(id, '丙')]
    ok(await boss.from('template_section').update({ name: '甲改' }).eq('id', a.id))

    ok(await boss.rpc('reorder_template_sections', { p_template_id: id, p_section_ids: [c.id, a.id, b.id] }))
    expect(await sectionNames(boss, id)).toEqual(['1.丙', '2.甲改', '3.乙'])

    await addPoint(a.id, '會跟著章一起刪掉')
    ok(await boss.from('template_section').delete().eq('id', a.id))
    expect(await sectionNames(boss, id)).toEqual(['1.丙', '2.乙'])
    expect(ok(await admin.from('control_point').select('id').eq('section_id', a.id))).toEqual([])
  })

  it('edits, reorders and deletes control points within a section, keeping positions 1..n', async () => {
    const id = await createTemplate({ code: `${RUN}P`, name: '要點', layout: 'control_activity' })
    const s = await addSection(id, '章')
    const [p1, p2, p3] = [
      await addPoint(s.id, '一', ID[UNIT.a]),
      await addPoint(s.id, '二', ID[UNIT.a]),
      await addPoint(s.id, '三', ID[UNIT.a]),
    ]
    ok(await boss.rpc('update_control_point', { p_control_point_id: p2.id, p_text: '二改', p_unit_ids: [ID[UNIT.b]] }))
    ok(await boss.rpc('reorder_control_points', { p_section_id: s.id, p_control_point_ids: [p3.id, p2.id, p1.id] }))
    expect(await pointTexts(boss, s.id)).toEqual(['1.三', '2.二改', '3.一'])

    ok(await boss.from('control_point').delete().eq('id', p3.id))
    expect(await pointTexts(boss, s.id)).toEqual(['1.二改', '2.一'])
    expect(await unitsOf(p2.id)).toEqual([UNIT.b])
  })

  it('does not let the API write positions directly, only through append, delete and reorder', async () => {
    const id = await createTemplate({ code: `${RUN}Q`, name: '位置', layout: 'element' })
    const s = await addSection(id, '章')
    const p = await addPoint(s.id, '一')
    const insertAt = await boss.from('control_point').insert({ section_id: s.id, text: '跳號', position: 9 })
    expect(insertAt.error?.code).toBe('42501')
    const moveTo = await boss.from('control_point').update({ position: 9 }).eq('id', p.id)
    expect(moveTo.error?.code).toBe('42501')
    const sectionAt = await boss.from('template_section').insert({ template_id: id, name: '跳號', position: 9 })
    expect(sectionAt.error?.code).toBe('42501')
    expect(await pointTexts(boss, s.id)).toEqual(['1.一'])
  })

  it('appends concurrent inserts without colliding on a position', async () => {
    const id = await createTemplate({ code: `${RUN}K`, name: '同時新增', layout: 'element' })
    const results = await Promise.all(['甲', '乙', '丙', '丁', '戊'].map((name) => boss.from('template_section').insert({ template_id: id, name })))
    expect(results.map((r) => r.error)).toEqual([null, null, null, null, null])
    const positions = ok(await boss.from('template_section').select('position').eq('template_id', id)).map((r) => r.position).sort()
    expect(positions).toEqual([1, 2, 3, 4, 5])
  })

  it('refuses a reorder that is not exactly the current set of ids', async () => {
    const id = await createTemplate({ code: `${RUN}R`, name: '排序', layout: 'element' })
    const [a, b] = [await addSection(id, '甲'), await addSection(id, '乙')]
    const other = await addSection(await createTemplate({ code: `${RUN}R2`, name: '別份', layout: 'element' }), '別人的章')
    for (const ids of [[a.id], [a.id, b.id, b.id], [a.id, b.id, other.id], [b.id, other.id]]) {
      const { error } = await boss.rpc('reorder_template_sections', { p_template_id: id, p_section_ids: ids })
      expect({ ids, code: error?.code }).toEqual({ ids, code: '22023' })
    }
    expect(await sectionNames(boss, id)).toEqual(['1.甲', '2.乙'])
  })
})

describe('範本管理編輯: 適用廠區與年度發起', () => {
  it('saves 適用廠區 codes with the header: trimmed, upper-cased, de-duplicated, blanks and nulls dropped', async () => {
    // 新範本是啟用：用沒有這個廠區的代碼，別的測試「不給組合」的發起才不會帶到它
    const U = RUN.toUpperCase()
    const id = await createTemplate({ code: `${RUN}T`, name: '廠區', layout: 'element', factory_codes: [`${RUN}q`, ` ${U}S `, `${RUN}s`, '', null] })
    expect(await plantCodes(id)).toEqual([`${U}Q`, `${U}S`])

    // 之後都改成停用：適用所有廠區的啟用範本會被別的測試的發起帶到
    const update = (codes: (string | null)[], allPlants = false) =>
      boss.rpc('update_template', {
        p_template_id: id, p_code: `${RUN}T`, p_name: '廠區', p_status: 'inactive', p_all_plants: allPlants, p_factory_codes: codes,
      })
    ok(await update([`${U}S`, null, `${RUN}-hw`]))
    expect(await plantCodes(id)).toEqual([`${U}-HW`, `${U}S`])
    ok(await update([`${U}S`], true)) // 所有廠區：清空代碼清單
    expect(await plantCodes(id)).toEqual([])
  })

  it('leaves inactive templates out of the annual launch', async () => {
    // 兩份都只適用測試廠區、都沒有簽核流程：「不給組合」的發起會整體拒絕並列出缺流程的組合
    const codes = { active: `${RUN}V`, inactive: `${RUN}X` }
    const ids: Record<string, string> = {}
    for (const [status, code] of Object.entries(codes)) {
      ids[status] = await createTemplate({ code, name: status, layout: 'element', status: status as Header['status'], factory_codes: [FACTORY] })
    }

    const { data, error } = await launchAssigned(boss, { p_year: YEAR, p_due_date: DUE })
    expect(error).toBeNull()
    const result = data as { ok: boolean; error: string; missing: { template_code: string; factory_code: string }[] }
    expect(result).toMatchObject({ ok: false, error: 'missing_route' })
    const missing = result.missing.map((m) => `${m.template_code}@${m.factory_code}`)
    expect(missing).toContain(`${codes.active}@${FACTORY}`)
    expect(missing).not.toContain(`${codes.inactive}@${FACTORY}`)

    const explicit = await launchAssigned(boss, { p_year: YEAR, p_due_date: DUE, p_combos: [{ template_id: ids.inactive, plant_id: ID.plant }] })
    expect(explicit.data).toMatchObject({ ok: false, error: 'invalid_combo' })
    // 收回啟用的那份，以免並行測試「不給組合」的發起多出缺流程的組合
    ok(await boss.rpc('update_template', {
      p_template_id: ids.active, p_code: codes.active, p_name: 'active', p_status: 'inactive', p_all_plants: false, p_factory_codes: [FACTORY],
    }))
  })

  it('does not change an issued 自評表 when the template is edited through the API afterwards', async () => {
    // 自建範本而不是 02：其他測試檔並行讀 02 的快照（「修改 02」本身由人工驗收）
    const templateId = await makeTemplate(`${RUN}F`, 'control_activity', FACTORY, [['章', [['原本的要點', ID[UNIT.a]!]]]])
    createdTemplates.push(templateId)
    await makeRoute(templateId, ID.plant!, [
      { name: '自行檢查人員', group: 'plant', signer: EMP.boss, unitId: ID[UNIT.a]! },
      { name: '台北稽核人員', group: 'audit_review', signer: EMP.boss, unitId: null },
      { name: '稽核主管', group: 'audit_review', signer: EMP.boss, unitId: null },
    ])
    const launched = await launchAssigned(boss, { p_year: YEAR, p_due_date: DUE, p_combos: [{ template_id: templateId, plant_id: ID.plant }] })
    expect(launched.data).toMatchObject({ ok: true, assessments: 1 })
    const cycleId = (launched.data as { cycle_id: string }).cycle_id
    const assessment = ok(await boss.from('assessment').select('id').eq('cycle_id', cycleId).single<{ id: string }>())
    const snapshot = async () =>
      ok(
        await boss
          .from('assessment_control_point')
          .select('position,text,assessment_control_point_unit(position,assessing_unit_name)')
          .eq('assessment_id', assessment.id)
          .order('position'),
      )
    const before = await snapshot()
    expect(before).toEqual([{ position: 1, text: '原本的要點', assessment_control_point_unit: [{ position: 1, assessing_unit_name: UNIT.a }] }])

    const section = ok(await boss.from('template_section').select('id').eq('template_id', templateId).single<{ id: string }>())
    const point = ok(await boss.from('control_point').select('id').eq('section_id', section.id).single<{ id: string }>())
    ok(await boss.rpc('update_control_point', { p_control_point_id: point.id, p_text: '改過的要點', p_unit_ids: [ID[UNIT.b]] }))
    await addPoint(section.id, '新增的要點', ID[UNIT.a])
    ok(await boss.from('template_section').update({ name: '改過的章' }).eq('id', section.id))

    expect(await snapshot()).toEqual(before)
  })
})

describe('範本管理編輯: 自評單位清單', () => {
  it('a new 自評單位 can be chosen for a control point straight away', async () => {
    const unit = ok(await boss.from('assessing_unit').insert({ name: UNIT.fresh }).select('id,name').single<{ id: string; name: string }>())
    const id = await createTemplate({ code: `${RUN}U`, name: '單位', layout: 'control_activity' })
    const point = await addPoint((await addSection(id, '章')).id, '用新單位', unit.id)
    expect(await unitsOf(point.id)).toEqual([UNIT.fresh])
  })

  it('refuses a duplicate name and the deletion of a unit that is in use, but allows renaming it', async () => {
    const dup = await boss.from('assessing_unit').insert({ name: UNIT.a })
    expect(dup.error?.code).toBe('23505')

    const id = await createTemplate({ code: `${RUN}N`, name: '使用中', layout: 'control_activity' })
    await addPoint((await addSection(id, '章')).id, '用乙單位', ID[UNIT.b])
    const del = await boss.from('assessing_unit').delete().eq('id', ID[UNIT.b])
    expect(del.error?.code).toBe('23503')

    const renamed = `${UNIT.b}改`
    ok(await boss.from('assessing_unit').update({ name: renamed }).eq('id', ID[UNIT.b]))
    ok(await boss.from('assessing_unit').update({ name: UNIT.b }).eq('id', ID[UNIT.b]))

    const unused = ok(await boss.from('assessing_unit').insert({ name: `${RUN}暫時` }).select('id').single<{ id: string }>())
    ok(await boss.from('assessing_unit').delete().eq('id', unused.id))
    expect(ok(await admin.from('assessing_unit').select('id').eq('id', unused.id))).toEqual([])
  })
})

describe('範本管理編輯: 只有稽核管理者', () => {
  it('refuses every template write from a signer', async () => {
    const id = await createTemplate({ code: `${RUN}Y`, name: '不給改', layout: 'element' })
    const s = await addSection(id, '章')

    const inserts = [
      await signer.from('questionnaire_template').insert({ code: `${RUN}Z`, name: 'x', layout: 'element' }),
      await signer.from('template_section').insert({ template_id: id, name: '偷加' }),
      await signer.from('control_point').insert({ section_id: s.id, text: '偷加' }),
      await signer.from('assessing_unit').insert({ name: `${RUN}偷加` }),
      await signer.from('template_plant').insert({ template_id: id, factory_code: 'FQ' }),
    ]
    expect(inserts.map((r) => r.error?.code)).toEqual(['42501', '42501', '42501', '42501', '42501'])

    for (const fn of [
      signer.rpc('create_template', { p_code: `${RUN}Z`, p_name: 'x', p_component: 'control_environment' }),
      signer.rpc('update_template', { p_template_id: id, p_code: 'x', p_name: 'x', p_status: 'inactive', p_all_plants: true }),
      signer.rpc('reorder_template_sections', { p_template_id: id, p_section_ids: [s.id] }),
      signer.rpc('reorder_control_points', { p_section_id: s.id, p_control_point_ids: [] }),
    ]) {
      expect((await fn).error?.code).toBe('42501')
    }

    // update／delete 被 RLS 濾掉：不報錯，但什麼都沒動
    await signer.from('template_section').update({ name: '被改了' }).eq('id', s.id)
    await signer.from('template_section').delete().eq('id', s.id)
    expect(ok(await admin.from('questionnaire_template').select('name,status').eq('id', id).single())).toEqual({ name: '不給改', status: 'active' })
    expect(await sectionNames(admin, id)).toEqual(['1.章'])
  })

  it('does not let even a 稽核管理者 delete a template or call the internal helpers', async () => {
    const id = await createTemplate({ code: `${RUN}G`, name: '不能刪', layout: 'element' })
    const del = await boss.from('questionnaire_template').delete().eq('id', id)
    expect(del.error?.code).toBe('42501')
    const internal = await boss.rpc('replace_template_plants', { p_template_id: id, p_all_plants: false, p_factory_codes: ['FQ'] })
    expect(internal.error?.code).toBe('42501')
  })
})
