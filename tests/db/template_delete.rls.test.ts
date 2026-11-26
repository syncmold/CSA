// 資料 API 接縫: 刪除從未使用過的問卷範本（工單 #31）。刪除以稽核管理者的 CSA session 走 PostgREST 的
// delete_template，service_role 只用來準備、查驗與清理。
// 每次執行建立自己的公司、廠區、範本與自評單位，結束時全部清掉；不動真實範本 02（其他測試檔會並行讀它）。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchAssigned, admin, insertRow, loginAs, makeRoute, makeTemplate, promoteToAuditAdmin, requirePostgrest, withSuperuser, unlistPeople } from './helpers'

// 資料庫測試檔案並行執行：前綴與隨機尾巴避免和其他檔案的工號、年度撞在一起。
const RUN = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A`, signer: `${RUN}B` }
const YEAR = 9000 + Math.floor(Math.random() * 1000)
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = `${RUN}單位`

const ID: Record<string, string> = {}
const createdTemplates: string[] = []
let boss: SupabaseClient
let signer: SupabaseClient

function ok<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.error) throw new Error(JSON.stringify(result.error))
  return result.data as NonNullable<T>
}

/** 以稽核主管身分建一份範本，帶兩章、三個控制要點與一個適用廠區；記下來給 afterAll 清。 */
async function templateWithContent(code: string) {
  const id = ok(
    await boss.rpc('create_template', {
      p_code: code, p_name: '開錯的範本', p_component: 'control_activities', p_all_plants: false, p_factory_codes: [FACTORY],
    }),
  ) as string
  createdTemplates.push(id)
  const sectionIds = ok(await boss.from('template_section').insert([{ template_id: id, name: '甲' }, { template_id: id, name: '乙' }]).select('id'))
    .map((s) => s.id as string)
  const [first, second] = sectionIds
  for (const [sectionId, text] of [[first, '一'], [first, '二'], [second, '三']]) {
    ok(await boss.rpc('create_control_point', { p_section_id: sectionId, p_text: text, p_unit_ids: [ID.unit] }))
  }
  return { id, sectionIds }
}

/** service_role 看得到的：範本還在嗎、它的章節、控制要點、適用廠區各剩幾筆。 */
async function leftovers(templateId: string, sectionIds: string[]) {
  const count = async (table: string, column: string, values: string[]) => {
    const { count: n, error } = await admin.from(table).select('*', { count: 'exact', head: true }).in(column, values)
    if (error) throw new Error(JSON.stringify(error))
    return n
  }
  return {
    template: await count('questionnaire_template', 'id', [templateId]),
    sections: await count('template_section', 'template_id', [templateId]),
    points: await count('control_point', 'section_id', sectionIds),
    plants: await count('template_plant', 'template_id', [templateId]),
  }
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
})

afterAll(async () => {
  await unlistPeople(RUN) // 排進關卡時加進放行名單的人（Q150）
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant ?? '')
  if (createdTemplates.length) await admin.from('questionnaire_template').delete().in('id', createdTemplates)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
})

describe('刪除範本: 從未使用過的', () => {
  it('deletes the template together with its sections, control points and 適用廠區', async () => {
    const { id, sectionIds } = await templateWithContent(`${RUN}A`)
    expect(await leftovers(id, sectionIds)).toEqual({ template: 1, sections: 2, points: 3, plants: 1 })

    expect(ok(await boss.from('questionnaire_template').select('in_use').eq('id', id).single())).toEqual({ in_use: false })
    ok(await boss.rpc('delete_template', { p_template_id: id, p_code: ` ${RUN}A ` })) // 前後空白不算錯
    expect(await leftovers(id, sectionIds)).toEqual({ template: 0, sections: 0, points: 0, plants: 0 })
  })

  it('refuses a wrong confirmation code and leaves everything in place', async () => {
    const { id, sectionIds } = await templateWithContent(`${RUN}B`)
    for (const code of [`${RUN}X`, '', null, `${RUN}b`]) {
      const { error } = await boss.rpc('delete_template', { p_template_id: id, p_code: code })
      expect({ code, error: error?.code }).toEqual({ code, error: '22023' })
    }
    expect(await leftovers(id, sectionIds)).toEqual({ template: 1, sections: 2, points: 3, plants: 1 })
  })

  it('reports a template that does not exist', async () => {
    const { error } = await boss.rpc('delete_template', { p_template_id: '00000000-0000-4000-8000-000000000000', p_code: 'x' })
    expect(error?.code).toBe('P0002')
  })
})

describe('刪除範本: 已使用過的不能刪', () => {
  it('refuses a template that has a 簽核流程, and leaves the route alone', async () => {
    const { id, sectionIds } = await templateWithContent(`${RUN}R`)
    const route = await insertRow('approval_route', { template_id: id, plant_id: ID.plant })

    expect(ok(await boss.from('questionnaire_template').select('in_use').eq('id', id).single())).toEqual({ in_use: true })
    const { error } = await boss.rpc('delete_template', { p_template_id: id, p_code: `${RUN}R` })
    expect(error?.code).toBe('23503')
    expect(error?.message).toContain('請改用停用')
    expect(await leftovers(id, sectionIds)).toEqual({ template: 1, sections: 2, points: 3, plants: 1 })
    expect(ok(await admin.from('approval_route').select('id').eq('id', route.id).single())).toEqual({ id: route.id })
  })

  it('becomes deletable again once its only 簽核流程, made in the flow editor, is deleted through delete_route (#11, Q137)', async () => {
    const { id, sectionIds } = await templateWithContent(`${RUN}E`)
    const route = ok(await boss.from('approval_route').insert({ template_id: id, plant_id: ID.plant }).select('id').single<{ id: string }>())
    expect((await boss.rpc('delete_template', { p_template_id: id, p_code: `${RUN}E` })).error?.code).toBe('23503')

    // 流程不能再直接刪，要走 delete_route 並親手輸入範本編號
    expect((await boss.from('approval_route').delete().eq('id', route.id)).error?.code).toBe('42501')
    expect((await boss.rpc('delete_route', { p_route_id: route.id, p_code: `${RUN}X` })).error?.code).toBe('22023')
    ok(await boss.rpc('delete_route', { p_route_id: route.id, p_code: ` ${RUN}E ` }))
    expect(ok(await boss.from('questionnaire_template').select('in_use').eq('id', id).single())).toEqual({ in_use: false })
    ok(await boss.rpc('delete_template', { p_template_id: id, p_code: `${RUN}E` }))
    expect(await leftovers(id, sectionIds)).toEqual({ template: 0, sections: 0, points: 0, plants: 0 })
  })

  it('refuses a template that has an issued 自評表, leaving the template and the 自評表 untouched', async () => {
    const templateId = await makeTemplate(`${RUN}F`, 'control_activity', FACTORY, [['章', [['要點', ID.unit!]]]])
    createdTemplates.push(templateId)
    const routeId = await makeRoute(templateId, ID.plant!, [
      { name: '自行檢查人員', group: 'plant', signer: EMP.boss, unitId: ID.unit! },
      { name: '台北稽核人員', group: 'audit_review', signer: EMP.boss, unitId: null },
      { name: '稽核主管', group: 'audit_review', signer: EMP.boss, unitId: null },
    ])
    const launched = await launchAssigned(boss, { p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: templateId, plant_id: ID.plant }] })
    expect(launched.data).toMatchObject({ ok: true, assessments: 1 })
    // 只剩自評表參照它：流程（連同關卡）拿掉後，擋下刪除的就是自評表
    await admin.from('approval_route').delete().eq('id', routeId)
    const assessment = async () =>
      ok(await admin.from('assessment').select('id,template_code,status').eq('template_id', templateId).single<{ id: string; template_code: string }>())
    const before = await assessment()

    expect(ok(await boss.from('questionnaire_template').select('in_use').eq('id', templateId).single())).toEqual({ in_use: true })
    const { error } = await boss.rpc('delete_template', { p_template_id: templateId, p_code: `${RUN}F` })
    expect(error?.code).toBe('23503')
    expect(ok(await admin.from('questionnaire_template').select('code').eq('id', templateId).single())).toEqual({ code: `${RUN}F` })
    expect(await assessment()).toEqual(before)
  })
})

describe('刪除範本: 外鍵是最後防線', () => {
  it('refuses a template referenced by a table in_use does not know about, with the same message', async () => {
    // 模擬日後新增、沒列進 in_use 的參照（例如流程編輯的資料）：只為這個測試存在的表，結束就拿掉
    const probe = `csa_test.${RUN}_probe`
    const { id, sectionIds } = await templateWithContent(`${RUN}K`)
    await withSuperuser(async (sql) => {
      await sql.query('create schema if not exists csa_test')
      await sql.query(`create table ${probe} (template_id uuid not null references public.questionnaire_template (id))`)
      await sql.query(`insert into ${probe} values ($1)`, [id])
    })
    try {
      expect(ok(await boss.from('questionnaire_template').select('in_use').eq('id', id).single())).toEqual({ in_use: false })
      const { error } = await boss.rpc('delete_template', { p_template_id: id, p_code: `${RUN}K` })
      expect(error?.code).toBe('23503')
      expect(error?.message).toContain('請改用停用')
      expect(await leftovers(id, sectionIds)).toEqual({ template: 1, sections: 2, points: 3, plants: 1 })
    } finally {
      await withSuperuser((sql) => sql.query(`drop table ${probe}`))
    }
  })
})

describe('刪除範本: 只有稽核管理者', () => {
  it('refuses a signer, even with the right code', async () => {
    const { id, sectionIds } = await templateWithContent(`${RUN}S`)
    const { error } = await signer.rpc('delete_template', { p_template_id: id, p_code: `${RUN}S` })
    expect(error?.code).toBe('42501')
    expect(await leftovers(id, sectionIds)).toEqual({ template: 1, sections: 2, points: 3, plants: 1 })
  })

  it('still has no direct delete on the template table, only the function', async () => {
    const { id } = await templateWithContent(`${RUN}T`)
    const direct = await boss.from('questionnaire_template').delete().eq('id', id)
    expect(direct.error?.code).toBe('42501')
  })
})
