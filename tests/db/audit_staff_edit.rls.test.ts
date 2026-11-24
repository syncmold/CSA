// 資料 API 接縫: 稽核人員維護負責廠區的範本與簽核流程（Q144，修訂 Q136 (2)）。
// 稽核人員看得到全部廠區的範本、自評單位、流程；負責廠區（他是稽核人員、而且是那廠的廠區管理員）的範本與流程能新增、修改、
// 刪除；別廠、跨廠（適用廠區有任何一個不是他負責的）、全部廠區的範本只能看。自評單位只能新增。年度發起仍只有稽核主管。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, insertRow, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest } from './helpers'

const RUN = `S${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
const EMP = { chief: `${RUN}A`, staff: `${RUN}B`, plantSide: `${RUN}C`, bareStaff: `${RUN}D` }
const FACTORY = { mine: `${RUN}P1`, other: `${RUN}P2` }
const UNIT = `${RUN}業務`
const ID: Record<string, string> = {}
const created: string[] = []

let chief: SupabaseClient
let staff: SupabaseClient
let plantSide: SupabaseClient
let bareStaff: SupabaseClient

const code = (s: string) => `${RUN}${s}`
const point = (sectionId: string) => ({ p_section_id: sectionId, p_text: '新要點', p_unit_ids: [ID.unit], p_code: null })

async function newTemplate(client: SupabaseClient, c: string, factoryCodes: string[], allPlants = false) {
  const result = await client.rpc('create_template', {
    p_code: code(c), p_name: `${c} 範本`, p_component: 'control_activities', p_all_plants: allPlants, p_factory_codes: factoryCodes,
  })
  if (result.data) created.push(result.data as string)
  return result
}

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.chief, '甲')
  await promoteToAuditAdmin(EMP.chief)
  ok(await admin.from('access_allowlist').insert({ emp_id: EMP.chief }))
  chief = await loginAs(EMP.chief, '甲')
  ok(await chief.rpc('add_access_members', {
    p_people: [{ emp_id: EMP.staff, name: '稽核' }, { emp_id: EMP.bareStaff, name: '沒廠' }], p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null,
  }))
  ok(await chief.rpc('add_access_members', { p_people: [{ emp_id: EMP.plantSide, name: '廠端' }], p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))

  ID.company = (await insertRow('company', { name: `${RUN}公司` })).id
  for (const [key, c] of Object.entries(FACTORY)) {
    ID[key] = (await insertRow('plant', { factory_code: c, name: `${RUN}${key}`, company_id: ID.company })).id
  }
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
  ID.mineT = await makeTemplate(code('mine'), 'control_activity', FACTORY.mine, [['第一章', [['要點一', ID.unit!]]]])
  ID.otherT = await makeTemplate(code('other'), 'control_activity', FACTORY.other, [['第一章', [['要點一', ID.unit!]]]])
  ID.shared = await makeTemplate(code('shared'), 'control_activity', FACTORY.mine, [['第一章', [['要點一', ID.unit!]]]])
  await insertRow('template_plant', { template_id: ID.shared, factory_code: FACTORY.other })
  ID.mineRoute = await makeRoute(ID.mineT!, ID.mine!, [{ name: '自行檢查人員', group: 'plant', signer: EMP.staff, unitId: ID.unit! }])
  ID.otherRoute = await makeRoute(ID.otherT!, ID.other!, [{ name: '自行檢查人員', group: 'plant', signer: EMP.staff, unitId: ID.unit! }])

  // 稽核人員負責 mine；廠區端的人負責 other。
  ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.mine, p_emp_id: EMP.staff }))
  ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.other, p_emp_id: EMP.plantSide }))
  staff = await loginAs(EMP.staff, '稽核')
  plantSide = await loginAs(EMP.plantSide, '廠端')
  bareStaff = await loginAs(EMP.bareStaff, '沒廠')
})

afterAll(async () => {
  await admin.from('approval_route').delete().in('plant_id', [ID.mine, ID.other].filter(Boolean))
  await admin.from('questionnaire_template').delete().in('id', [ID.mineT, ID.otherT, ID.shared, ...created].filter(Boolean))
  await admin.from('plant_coordinator').delete().in('plant_id', [ID.mine, ID.other].filter(Boolean))
  const listed = ok(await admin.from('access_allowlist').select('emp_id').like('emp_id', `${RUN}%`)) as { emp_id: string }[]
  for (const { emp_id } of listed) await admin.from('access_allowlist').delete().eq('emp_id', emp_id)
  await admin.from('plant').delete().in('factory_code', Object.values(FACTORY))
  await admin.from('assessing_unit').delete().like('name', `${RUN}%`)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
})

describe('看：稽核人員看得到全部廠區的設定', () => {
  it('範本、章節、流程、自評單位都讀得到（含別廠的）', async () => {
    const templates = ok(await staff.from('questionnaire_template').select('id').in('id', [ID.mineT, ID.otherT, ID.shared])) as unknown[]
    expect(templates).toHaveLength(3)
    expect(ok(await staff.from('approval_route').select('id').in('id', [ID.mineRoute, ID.otherRoute]))).toHaveLength(2)
    expect(ok(await staff.from('route_step').select('id').in('route_id', [ID.otherRoute]))).toHaveLength(1)
    expect(ok(await staff.from('assessing_unit').select('id').eq('id', ID.unit))).toHaveLength(1)
  })

  it('沒負責廠區的稽核人員與廠區端的人也看得到（唯讀）；一般使用者不再是這樣的人', async () => {
    expect(ok(await bareStaff.from('questionnaire_template').select('id').eq('id', ID.otherT))).toHaveLength(1)
    // 廠區端的人（角色是一般使用者）看不到別廠的範本；當廠區管理員的那一廠，流程用到的範本只看得到範本本身（發出前
    // 分派要看流程，Q147），內容照舊看不到。
    expect(ok(await plantSide.from('questionnaire_template').select('id').eq('id', ID.mineT))).toHaveLength(0)
    expect(ok(await plantSide.from('questionnaire_template').select('id').eq('id', ID.otherT))).toHaveLength(1)
    expect(ok(await plantSide.from('template_section').select('id').eq('template_id', ID.otherT))).toHaveLength(0)
  })
})

describe('改：負責廠區的範本', () => {
  it('新增只適用負責廠區的範本；新增、修改、重排、刪除題目與章節', async () => {
    const id = ok(await newTemplate(staff, 'new', [FACTORY.mine])) as string
    const section = ok(await staff.from('template_section').insert({ template_id: id, name: '章' }).select('id').single<{ id: string }>())
    const cp = ok(await staff.rpc('create_control_point', point(section.id))) as string
    ok(await staff.rpc('update_control_point', { p_control_point_id: cp, p_text: '改過', p_unit_ids: [ID.unit], p_code: null }))
    ok(await staff.rpc('reorder_control_points', { p_section_id: section.id, p_control_point_ids: [cp] }))
    ok(await staff.rpc('reorder_template_sections', { p_template_id: id, p_section_ids: [section.id] }))
    ok(await staff.from('template_section').update({ name: '章改' }).eq('id', section.id))
    ok(await staff.from('control_point').delete().eq('id', cp))
    ok(await staff.from('template_section').delete().eq('id', section.id))
    ok(await staff.rpc('update_template', {
      p_template_id: id, p_code: code('new'), p_name: '改名', p_status: 'inactive', p_all_plants: false, p_factory_codes: [FACTORY.mine],
    }))
    ok(await staff.rpc('delete_template', { p_template_id: id, p_code: code('new') }))
    expect(ok(await admin.from('questionnaire_template').select('id').eq('id', id))).toHaveLength(0)
  })

  it('修改負責廠區的既有範本', async () => {
    ok(await staff.rpc('update_template', {
      p_template_id: ID.mineT, p_code: code('mine'), p_name: '稽核人員改的', p_status: 'active', p_all_plants: false, p_factory_codes: [FACTORY.mine],
    }))
    expect(ok(await admin.from('questionnaire_template').select('name').eq('id', ID.mineT).single()).name).toBe('稽核人員改的')
  })
})

describe('不能改：別廠、跨廠、全部廠區的範本', () => {
  const refused = (r: { error: { code?: string } | null }) => expect(r.error?.code).toBe('42501')

  it('別廠的範本：改、刪、加題目都被擋', async () => {
    refused(await staff.rpc('update_template', {
      p_template_id: ID.otherT, p_code: code('other'), p_name: '偷改', p_status: 'active', p_all_plants: false, p_factory_codes: [FACTORY.other],
    }))
    refused(await staff.rpc('delete_template', { p_template_id: ID.otherT, p_code: code('other') }))
    const section = ok(await admin.from('template_section').select('id').eq('template_id', ID.otherT).limit(1).single()).id as string
    refused(await staff.rpc('create_control_point', point(section)))
    refused(await staff.rpc('reorder_template_sections', { p_template_id: ID.otherT, p_section_ids: [section] }))
    expect((await staff.from('template_section').update({ name: '偷改' }).eq('id', section).select('id')).data).toEqual([])
    expect((await staff.from('template_section').delete().eq('id', section).select('id')).data).toEqual([])
  })

  it('跨廠的範本（適用廠區有一個不是他負責的）只能看', async () => {
    refused(await staff.rpc('update_template', {
      p_template_id: ID.shared, p_code: code('shared'), p_name: '偷改', p_status: 'active', p_all_plants: false, p_factory_codes: [FACTORY.mine, FACTORY.other],
    }))
  })

  it('不能新增適用別廠或全部廠區的範本，也不能把自己的範本改到別廠', async () => {
    refused(await newTemplate(staff, 'x1', [FACTORY.other]))
    refused(await newTemplate(staff, 'x2', [FACTORY.mine, FACTORY.other]))
    refused(await newTemplate(staff, 'x3', [], true))
    refused(await newTemplate(staff, 'x4', []))
    refused(await staff.rpc('update_template', {
      p_template_id: ID.mineT, p_code: code('mine'), p_name: '改', p_status: 'active', p_all_plants: false, p_factory_codes: [FACTORY.mine, FACTORY.other],
    }))
    refused(await staff.rpc('update_template', {
      p_template_id: ID.mineT, p_code: code('mine'), p_name: '改', p_status: 'active', p_all_plants: true, p_factory_codes: [],
    }))
    // 被擋的交易整筆退回：適用廠區沒被改到。
    const plants = ok(await admin.from('template_plant').select('factory_code').eq('template_id', ID.mineT)) as { factory_code: string }[]
    expect(plants.map((p) => p.factory_code)).toEqual([FACTORY.mine])
  })

  it('沒負責廠區的稽核人員、廠區端的負責人都不能改範本', async () => {
    refused(await newTemplate(bareStaff, 'y1', [FACTORY.mine]))
    refused(await newTemplate(plantSide, 'y2', [FACTORY.other]))
    refused(await plantSide.rpc('update_template', {
      p_template_id: ID.otherT, p_code: code('other'), p_name: '偷改', p_status: 'active', p_all_plants: false, p_factory_codes: [FACTORY.other],
    }))
  })
})

describe('簽核流程', () => {
  const refused = (r: { error: { code?: string } | null }) => expect(r.error?.code).toBe('42501')

  it('負責廠區的流程：新增、加關卡、改關卡、重排、刪除', async () => {
    const t = ok(await newTemplate(staff, 'route', [FACTORY.mine])) as string
    const route = ok(await staff.from('approval_route').insert({ template_id: t, plant_id: ID.mine }).select('id').single<{ id: string }>())
    const step = ok(await staff.rpc('insert_route_step', {
      p_route_id: route.id, p_name: '稽核', p_step_group: 'audit_review', p_signer_emp_id: EMP.staff, p_editable_unit_id: null,
      p_before_position: null, p_branch_unit_id: null, p_link: null,
    })) as string
    ok(await staff.from('route_step').update({ name: '稽核改' }).eq('id', step))
    ok(await staff.rpc('reorder_route_steps', { p_route_id: route.id, p_step_ids: [step] }))
    ok(await staff.rpc('add_route_branch', { p_route_id: route.id, p_unit_id: ID.unit }))
    ok(await staff.rpc('delete_route', { p_route_id: route.id, p_code: code('route') }))
    expect(ok(await admin.from('approval_route').select('id').eq('id', route.id))).toHaveLength(0)
  })

  it('別廠的流程：改、刪都被擋；也不能替別廠新增流程', async () => {
    refused(await staff.rpc('insert_route_step', {
      p_route_id: ID.otherRoute, p_name: '偷加', p_step_group: 'audit_review', p_signer_emp_id: EMP.staff, p_editable_unit_id: null,
      p_before_position: null, p_branch_unit_id: null, p_link: null,
    }))
    refused(await staff.rpc('delete_route', { p_route_id: ID.otherRoute, p_code: code('other') }))
    refused(await staff.rpc('add_route_branch', { p_route_id: ID.otherRoute, p_unit_id: ID.unit }))
    const step = ok(await admin.from('route_step').select('id').eq('route_id', ID.otherRoute).limit(1).single()).id as string
    refused(await staff.rpc('reorder_route_steps', { p_route_id: ID.otherRoute, p_step_ids: [step] }))
    expect((await staff.from('route_step').update({ name: '偷改' }).eq('id', step).select('id')).data).toEqual([])
    expect((await staff.from('route_step').delete().eq('id', step).select('id')).data).toEqual([])
    const t = ok(await admin.from('questionnaire_template').select('id').eq('id', ID.otherT).single()).id as string
    expect((await staff.from('approval_route').insert({ template_id: t, plant_id: ID.other })).error).not.toBeNull()
  })

  it('廠區端的負責人與沒負責廠區的稽核人員不能改流程', async () => {
    refused(await plantSide.rpc('delete_route', { p_route_id: ID.otherRoute, p_code: code('other') }))
    refused(await bareStaff.rpc('delete_route', { p_route_id: ID.mineRoute, p_code: code('mine') }))
  })
})

describe('自評單位：稽核人員只能新增', () => {
  it('新增可以；改名、刪除被擋；沒負責廠區的稽核人員連新增也不行', async () => {
    const added = ok(await staff.from('assessing_unit').insert({ name: `${RUN}新增` }).select('id').single<{ id: string }>())
    expect((await staff.from('assessing_unit').update({ name: `${RUN}改名` }).eq('id', added.id).select('id')).data).toEqual([])
    expect((await staff.from('assessing_unit').delete().eq('id', added.id).select('id')).data).toEqual([])
    expect((await bareStaff.from('assessing_unit').insert({ name: `${RUN}不行` })).error).not.toBeNull()
    expect((await plantSide.from('assessing_unit').insert({ name: `${RUN}不行二` })).error).not.toBeNull()
  })
})

describe('不變的部分', () => {
  it('稽核人員不能發起年度作業；稽核主管仍能改任何廠區的範本', async () => {
    const launch = await staff.rpc('launch_annual_cycle', { p_year: 1, p_due_date: '2099-12-31', p_combos: [], p_departed: [], p_checked: false })
    expect(launch.error?.code).toBe('42501')
    ok(await chief.rpc('update_template', {
      p_template_id: ID.otherT, p_code: code('other'), p_name: '主管改', p_status: 'active', p_all_plants: false, p_factory_codes: [FACTORY.other],
    }))
  })

  it('稽核人員看不到別廠的自評表（讀全部的範圍沒有放大）', async () => {
    expect(ok(await staff.from('assessment').select('id').eq('plant_id', ID.other))).toHaveLength(0)
  })
})
