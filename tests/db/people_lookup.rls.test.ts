// 資料 API 接縫: 用工號查人與姓名的保密規則（工單 #218；Q133 (6)）。people_lookup_limit 是 CSA 後端向 OMS 查人之前問的；
// record_people 只給後端記姓名；visible_people 決定每個人看得到誰的姓名（整份名單只有稽核主管與系統維護員）。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, insertRow, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, promoteToSystemMaintainer, requirePostgrest, restClient } from './helpers'

const RUN = `K${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
const EMP = {
  chief: `${RUN}A`,
  maint: `${RUN}B`,
  /** 稽核人員（沒有負責的廠區） */
  staff: `${RUN}C`,
  /** 這一廠的廠區管理員 */
  owner: `${RUN}D`,
  /** 別廠的廠區管理員 */
  otherOwner: `${RUN}E`,
  /** 這一廠自評表上的自行檢查人員 */
  checker: `${RUN}F`,
  /** 沒登入過、被分派當部門主管，姓名是查人時記下的 */
  manager: `${RUN}G`,
  /** 只有登入過、不在任何表上 */
  bystander: `${RUN}H`,
  /** 只在簽核流程上（稽核室關卡），不在這張自評表以外的地方 */
  routeOnly: `${RUN}J`,
}
const FACTORY = { mine: `${RUN}P1`, other: `${RUN}P2` }
/** tests/db/helpers.ts 檔尾的年度區間表：29000 是這支。 */
const YEAR = 29000 + Math.floor(Math.random() * 900)
const UNIT = `${RUN}業務`
const ID: Record<string, string> = {}

const clients: Record<keyof typeof EMP, SupabaseClient> = {} as Record<keyof typeof EMP, SupabaseClient>
const limit = async (client: SupabaseClient) => (await client.rpc('people_lookup_limit')).data as number
/** 這個人看得到其中哪幾位的姓名（只看這支測試建的人）。 */
const seen = async (client: SupabaseClient) =>
  (ok(await client.rpc('visible_people').like('emp_id', `${RUN}%`)) as { emp_id: string; name: string | null }[])
    .map((p) => p.emp_id).sort()
const all = (...keys: (keyof typeof EMP)[]) => keys.map((k) => EMP[k]).sort()

beforeAll(async () => {
  await requirePostgrest()
  for (const [key, name] of [['chief', '甲'], ['maint', '維護員'], ['staff', '稽核'], ['owner', '廠管'], ['otherOwner', '別廠'], ['checker', '乙'], ['bystander', '路人']] as const) {
    clients[key] = await loginAs(EMP[key], name)
  }
  await promoteToAuditAdmin(EMP.chief)
  await promoteToSystemMaintainer(EMP.maint)
  ok(await admin.from('access_allowlist').insert([{ emp_id: EMP.chief }, { emp_id: EMP.maint }]))
  clients.chief = await loginAs(EMP.chief, '甲')
  clients.maint = await loginAs(EMP.maint, '維護員')

  ID.company = (await insertRow('company', { name: `${RUN}公司` })).id
  ID.mine = (await insertRow('plant', { factory_code: FACTORY.mine, name: `${RUN}一廠`, company_id: ID.company })).id
  ID.other = (await insertRow('plant', { factory_code: FACTORY.other, name: `${RUN}二廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id

  ok(await clients.chief.rpc('add_access_members', {
    p_people: [{ emp_id: EMP.owner, name: '廠管' }, { emp_id: EMP.otherOwner, name: '別廠' }], p_role: 'signer', p_viewer_plant_ids: [], p_note: null,
  }))
  ok(await clients.chief.rpc('add_access_members', { p_people: [{ emp_id: EMP.staff, name: '稽核' }], p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null }))
  ok(await clients.chief.rpc('set_plant_coordinator', { p_plant_id: ID.mine, p_emp_id: EMP.owner }))
  ok(await clients.chief.rpc('set_plant_coordinator', { p_plant_id: ID.other, p_emp_id: EMP.otherOwner }))
  for (const key of ['staff', 'owner', 'otherOwner'] as const) clients[key] = await loginAs(EMP[key], key)

  ID.template = await makeTemplate(`${RUN}M`, 'control_activity', FACTORY.mine, [['第一章', [['要點一', ID.unit!]]]])
  await makeRoute(ID.template, ID.mine!, [
    { name: `自行檢查人員－${UNIT}`, group: 'plant', signer: EMP.checker, unitId: ID.unit! },
    { name: `部門主管－${UNIT}`, group: 'plant', signer: EMP.manager, unitId: null, branchUnitId: ID.unit! },
    { name: '廠區經理人', group: 'plant', signer: EMP.manager, unitId: null },
    { name: '子公司擔當稽核', group: 'audit_review', signer: EMP.routeOnly, unitId: null },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
  ])
  const launched = ok(await clients.chief.rpc('launch_annual_cycle', {
    p_year: YEAR, p_due_date: '2099-12-31', p_combos: [{ template_id: ID.template, plant_id: ID.mine }],
  })) as { cycle_id: string }
  ID.form = (ok(await admin.from('assessment').select('id').eq('cycle_id', launched.cycle_id).single()) as { id: string }).id
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  if (ID.mine) await admin.from('approval_route').delete().eq('plant_id', ID.mine)
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
  await admin.from('plant_coordinator').delete().in('plant_id', [ID.mine, ID.other].filter(Boolean))
  const listed = ok(await admin.from('access_allowlist').select('emp_id').like('emp_id', `${RUN}%`)) as { emp_id: string }[]
  for (const { emp_id } of listed) await admin.from('access_allowlist').delete().eq('emp_id', emp_id)
  await admin.from('employee_ref').delete().in('emp_id', [EMP.manager, EMP.routeOnly])
  await admin.from('plant').delete().in('factory_code', Object.values(FACTORY))
  await admin.from('assessing_unit').delete().eq('name', UNIT)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
})

describe('people_lookup_limit：誰能用工號向 OMS 查人、一次幾個', () => {
  it('稽核主管、系統維護員一次 200；稽核人員、任何一廠的廠區管理員一次 20；一般簽核人不能查', async () => {
    expect(await limit(clients.chief)).toBe(200)
    expect(await limit(clients.maint)).toBe(200)
    expect(await limit(clients.staff)).toBe(20)
    expect(await limit(clients.owner)).toBe(20)
    expect(await limit(clients.otherOwner)).toBe(20)
    expect(await limit(clients.checker)).toBe(0)
    expect(await limit(clients.bystander)).toBe(0)
  })

  it('沒有登入的人連問都不能問', async () => {
    expect((await restClient(async () => null).rpc('people_lookup_limit')).error?.code).toBe('42501')
  })
})

describe('record_people：只有 CSA 後端能記姓名，而且只動姓名', () => {
  it('登入的人（連稽核主管）都不能呼叫', async () => {
    expect((await clients.chief.rpc('record_people', { p_people: [{ emp_id: EMP.manager, name: '偷改' }] })).error?.code).toBe('42501')
    expect((await clients.checker.rpc('record_people', { p_people: [{ emp_id: EMP.manager, name: '偷改' }] })).error?.code).toBe('42501')
  })

  it('沒見過的人新增一列（一般使用者、不進放行名單）；見過的人只改姓名，角色、廠區、放行都不動', async () => {
    ok(await admin.rpc('record_people', {
      p_people: [
        // 前後空白不算；同一個工號送兩次只記一次。
        { emp_id: ` ${EMP.manager} `, name: ' 丙 ' }, { emp_id: EMP.routeOnly, name: '外稽' }, { emp_id: EMP.routeOnly, name: '外稽' },
        { emp_id: EMP.staff, name: '稽核（新名）' }, { emp_id: EMP.bystander, name: '' }, { emp_id: '', name: '沒有工號' },
      ],
    }))
    const rows = ok(await admin.from('employee_ref').select('emp_id,name,factory_code,audit_role').in('emp_id', [EMP.manager, EMP.routeOnly, EMP.staff, EMP.bystander]))
    expect(Object.fromEntries((rows as { emp_id: string }[]).map((r) => [r.emp_id, r]))).toMatchObject({
      [EMP.manager]: { name: '丙', factory_code: null, audit_role: 'signer' },
      [EMP.routeOnly]: { name: '外稽', audit_role: 'signer' },
      [EMP.staff]: { name: '稽核（新名）', audit_role: 'audit_staff' },
      [EMP.bystander]: { name: '路人' }, // 空白姓名不蓋掉原本的
    })
    const listed = ok(await admin.from('access_allowlist').select('emp_id').in('emp_id', [EMP.manager, EMP.routeOnly])) as unknown[]
    expect(listed).toEqual([])
    // 新的一列不進異動紀錄（不是放行名單上的人）。
    const logged = ok(await admin.from('access_change_log').select('id').in('target_emp_id', [EMP.routeOnly]).in('action', ['added', 'role'])) as unknown[]
    expect(logged).toEqual([])
  })
})

describe('visible_people：每個人看得到誰的姓名', () => {
  it('稽核主管、系統維護員看得到全部', async () => {
    const everyone = all('chief', 'maint', 'staff', 'owner', 'otherOwner', 'checker', 'manager', 'bystander', 'routeOnly')
    expect(await seen(clients.chief)).toEqual(everyone)
    expect(await seen(clients.maint)).toEqual(everyone)
  })

  it('這一廠的廠區管理員：自己，加上這一廠自評表上的簽核人；看不到別廠的廠區管理員與不在表上的人', async () => {
    expect(await seen(clients.owner)).toEqual(all('owner', 'checker', 'manager', 'routeOnly', 'chief'))
  })

  it('別廠的廠區管理員、不在任何表上的人：只有自己', async () => {
    expect(await seen(clients.otherOwner)).toEqual(all('otherOwner'))
    expect(await seen(clients.bystander)).toEqual(all('bystander'))
  })

  it('自行檢查人員：自己，加上輪到他的那張自評表上的簽核人', async () => {
    expect(await seen(clients.checker)).toEqual(all('checker', 'manager', 'routeOnly', 'chief'))
  })

  it('稽核人員：自己，加上簽核流程上的簽核人（他看得到所有流程；Q147 起廠區端也分派在流程上）', async () => {
    expect(await seen(clients.staff)).toEqual(all('staff', 'checker', 'manager', 'routeOnly', 'chief'))
  })

  it('直接讀員工參照仍然只有自己那一列（稽核主管與系統維護員除外）', async () => {
    const own = ok(await clients.owner.from('employee_ref').select('emp_id').like('emp_id', `${RUN}%`)) as { emp_id: string }[]
    expect(own.map((r) => r.emp_id)).toEqual([EMP.owner])
  })

  it('追蹤總覽的姓名函式跟著同一條規則，不再回整份名單', async () => {
    const names = async (client: SupabaseClient) =>
      (ok(await client.rpc('tracking_signer_names').like('emp_id', `${RUN}%`)) as { emp_id: string }[]).map((p) => p.emp_id).sort()
    expect(await names(clients.owner)).toEqual(all('owner', 'checker', 'manager', 'routeOnly', 'chief'))
    expect(await names(clients.otherOwner)).toEqual(all('otherOwner'))
    const row = ok(await clients.owner.from('tracking_assessment').select('current_signer_emp_id,current_signer_name').eq('assessment_id', ID.form!).single())
    expect(row).toEqual({ current_signer_emp_id: EMP.checker, current_signer_name: '乙' })
  })
})
