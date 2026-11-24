// 資料 API 接縫: 發出前的離職檢查與既有流程回填（工單 #222；Q147 (3)(4)，取代 #102 的「帶入去年、離職的從缺」）。
// 發起前前端用 launch_signers 拿到這些組合發出時會照抄的人，經 OMS 通道查在不在職：流程上有人已離職就整批拒絕並列出是誰，
// 換人之後才能發；OMS 連不上時照樣發出（p_checked = false），回傳讓畫面提示沒檢查離職。發出後稽核主管換人寫回流程：同名的
// 關卡（兩條分流都有「部門主管」）靠分流分開。migration 把 Q147 之前的流程用最近一次發出的自評表上的人回填。
// 例子同 Q116 的 mockup：何欣怡是廠區管理員，許文彬是已離職的財務部門主管。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, insertRow, loginAs, makeRoute, makeTemplate, migratedDb, ok, promoteToAuditAdmin, requirePostgrest } from './helpers'

const RUN = `C${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
const EMP = {
  chief: `${RUN}A`,
  /** 何欣怡：這一廠的廠區管理員 */
  owner: `${RUN}B`,
  sales: `${RUN}C`,
  salesManager: `${RUN}D`,
  finance: `${RUN}E`,
  /** 許文彬：流程上的財務部門主管，已離職 */
  departed: `${RUN}G`,
  /** 流程上的廠區經理人，從沒登入過（CSA 沒有姓名），已離職 */
  neverLoggedIn: `${RUN}H`,
  newcomer: `${RUN}I`,
}
const FACTORY = `${RUN}P1`
/** tests/db/helpers.ts 檔尾的年度區間表：25000 是這支。 */
const YEAR = 25000 + Math.floor(Math.random() * 900)
const DUE = '2099-12-31'
const UNITS = { sales: `${RUN}業務`, finance: `${RUN}財務` }
const ID: Record<string, string> = {}

let chief: SupabaseClient
let owner: SupabaseClient

const combo = (template: string) => ({ template_id: template, plant_id: ID.plant! })

/** 流程上的關卡（依位置），`branch` 是分流的單位名稱。 */
async function routeSteps(templateId: string) {
  const rows = ok(await admin.from('route_step')
    .select('id,name,position,signer_emp_id,branch:assessing_unit!route_step_branch_unit_id_fkey(name),approval_route!inner(template_id)')
    .eq('approval_route.template_id', templateId).order('position')) as unknown as { id: string; name: string; signer_emp_id: string | null; branch: { name: string } | null }[]
  return rows.map((r) => ({ id: r.id, name: r.name, branch: r.branch?.name ?? null, signer_emp_id: r.signer_emp_id }))
}

const routeStep = async (templateId: string, branch: string | null, name: string) =>
  (await routeSteps(templateId)).find((s) => s.branch === branch && s.name === name)!

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.chief, '甲')
  await promoteToAuditAdmin(EMP.chief)
  ok(await admin.from('access_allowlist').insert({ emp_id: EMP.chief }))
  chief = await loginAs(EMP.chief, '甲')
  owner = await loginAs(EMP.owner, '何欣怡')
  await loginAs(EMP.departed, '許文彬')

  ID.company = (await insertRow('company', { name: `${RUN}公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}一廠`, company_id: ID.company })).id
  for (const [key, name] of Object.entries(UNITS)) ID[key] = (await insertRow('assessing_unit', { name })).id
  ok(await chief.rpc('add_access_members', {
    p_people: [{ emp_id: EMP.owner, name: '何欣怡', factory_code: FACTORY }],
    p_role: 'signer', p_viewer_plant_ids: [], p_note: null,
  }))
  ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant, p_emp_id: EMP.owner }))

  // 兩條分流都有「部門主管」，同名的關卡要靠分流分開。
  ID.main = await makeTemplate(`${RUN}M`, 'control_activity', FACTORY, [['第一章', [['要點一', ID.sales!], ['要點二', ID.finance!]]]])
  await makeRoute(ID.main, ID.plant!, [
    { name: '自行檢查人員', group: 'plant', signer: EMP.sales, unitId: ID.sales! },
    { name: '自行檢查人員', group: 'plant', signer: EMP.finance, unitId: ID.finance! },
    { name: '部門主管', group: 'plant', signer: EMP.salesManager, unitId: null, branchUnitId: ID.sales! },
    { name: '部門主管', group: 'plant', signer: EMP.departed, unitId: null, branchUnitId: ID.finance! },
    { name: '廠區經理人', group: 'plant', signer: EMP.neverLoggedIn, unitId: null },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
  ])
  ID.other = await makeTemplate(`${RUN}N`, 'control_activity', FACTORY, [['第一章', [['要點一', ID.sales!]]]])
  await makeRoute(ID.other, ID.plant!, [
    { name: '自行檢查人員', group: 'plant', signer: EMP.sales, unitId: ID.sales! },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
  ])
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().eq('year', YEAR)
  await admin.from('approval_route').delete().eq('plant_id', ID.plant!)
  await admin.from('questionnaire_template').delete().in('id', [ID.main, ID.other].filter(Boolean))
  await admin.from('plant_coordinator').delete().eq('plant_id', ID.plant!)
  await admin.from('access_allowlist').delete().like('emp_id', `${RUN}%`)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  await admin.from('assessing_unit').delete().in('name', Object.values(UNITS))
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
})

describe('發起前要查的人（launch_signers，取代 last_year_signers）', () => {
  it('是這些組合的流程發出時會照抄的人（連動關卡照權限管理）；只有稽核主管查得到', async () => {
    expect(ok(await chief.rpc('launch_signers', { p_combos: [combo(ID.main!)] }))).toEqual(
      [EMP.chief, EMP.departed, EMP.finance, EMP.neverLoggedIn, EMP.sales, EMP.salesManager].sort(),
    )
    expect(ok(await chief.rpc('launch_signers', { p_combos: [combo(ID.other!)] }))).toEqual([EMP.chief, EMP.sales].sort())
    expect((await owner.rpc('launch_signers', { p_combos: [combo(ID.main!)] })).error?.code).toBe('42501')
    expect((await chief.rpc('last_year_signers', { p_year: YEAR })).error?.code).toBe('PGRST202')
    // OMS 通道一天有額度：一定要給要發的組合。
    expect((await chief.rpc('launch_signers', { p_combos: null })).error?.code).toBe('22023')
  })
})

describe('發出前的離職檢查（Q147 (4)）', () => {
  it('流程上的人已離職：整批拒絕，列出範本、廠區、關卡、工號、姓名（工號大小寫不拘），什麼都沒發', async () => {
    const refused = ok(await chief.rpc('launch_annual_cycle', {
      p_year: YEAR, p_due_date: DUE, p_combos: [combo(ID.main!), combo(ID.other!)],
      p_departed: [EMP.departed.toLowerCase(), ` ${EMP.neverLoggedIn} `], p_checked: true,
    }))
    expect(refused).toEqual({
      ok: false, error: 'departed_signers',
      departed: [
        expect.objectContaining({
          template_code: `${RUN}M`, factory_code: FACTORY, step: '部門主管', branch_unit_name: UNITS.finance, link: null, emp_id: EMP.departed, name: '許文彬',
        }),
        expect.objectContaining({ template_code: `${RUN}M`, step: '廠區經理人', branch_unit_name: null, emp_id: EMP.neverLoggedIn, name: null }),
      ],
    })
    expect(ok(await admin.from('annual_cycle').select('id').eq('year', YEAR))).toEqual([])
  })

  it('廠區管理員換人之後就能發出，回傳 checked；照抄的是新的人', async () => {
    ok(await owner.rpc('assign_route_signer', { p_route_step_id: (await routeStep(ID.main!, UNITS.finance, '部門主管')).id, p_emp_id: EMP.newcomer }))
    ok(await owner.rpc('assign_route_signer', { p_route_step_id: (await routeStep(ID.main!, null, '廠區經理人')).id, p_emp_id: EMP.salesManager }))
    const launched = ok(await chief.rpc('launch_annual_cycle', {
      p_year: YEAR, p_due_date: DUE, p_combos: [combo(ID.main!)], p_departed: [EMP.departed, EMP.neverLoggedIn], p_checked: true,
    }))
    expect(launched).toEqual({ ok: true, cycle_id: expect.any(String), top_up: false, due_date: DUE, assessments: 1, checked: true })
    ID.mainForm = (ok(await admin.from('assessment').select('id').eq('template_id', ID.main!).single()) as { id: string }).id
    const issued = ok(await admin.from('assessment_step').select('name,branch_unit_name,signer_emp_id,vacated_emp_id').eq('assessment_id', ID.mainForm!).order('position'))
    expect(issued).toContainEqual({ name: '部門主管', branch_unit_name: UNITS.finance, signer_emp_id: EMP.newcomer, vacated_emp_id: null })
    expect(issued).toContainEqual({ name: '廠區經理人', branch_unit_name: null, signer_emp_id: EMP.salesManager, vacated_emp_id: null })
    // 發出時不再記「帶入」「從缺」。
    const log = ok(await chief.from('access_change_log').select('action').in('target_emp_id', [EMP.newcomer, EMP.departed]).in('action', ['step_carried', 'step_vacated']))
    expect(log).toEqual([])
  })

  it('OMS 連不上（p_checked = false）照樣發出，回傳 checked = false；不給 p_checked 也當作沒查', async () => {
    const launched = ok(await chief.rpc('launch_annual_cycle', { p_year: YEAR, p_due_date: DUE, p_combos: [combo(ID.other!)], p_checked: false }))
    expect(launched).toMatchObject({ ok: true, top_up: true, assessments: 1, checked: false })
    const refusedAgain = ok(await chief.rpc('launch_annual_cycle', { p_year: YEAR, p_due_date: DUE, p_combos: [combo(ID.other!)] }))
    expect(refusedAgain).toMatchObject({ ok: false, error: 'already_launched' })
  })
})

describe('發出後換人寫回流程', () => {
  it('同名的關卡靠分流分開：換財務的部門主管只寫回財務那一關', async () => {
    const step = ok(await admin.from('assessment_step').select('id').eq('assessment_id', ID.mainForm!).eq('name', '部門主管').eq('branch_unit_name', UNITS.finance).single()) as { id: string }
    ok(await chief.rpc('assign_step_signer', { p_step_id: step.id, p_emp_id: EMP.finance }))
    expect((await routeStep(ID.main!, UNITS.finance, '部門主管')).signer_emp_id).toBe(EMP.finance)
    expect((await routeStep(ID.main!, UNITS.sales, '部門主管')).signer_emp_id).toBe(EMP.salesManager)
  })
})

describe('既有流程回填（migration 20261215000000）', () => {
  it('非連動、還沒有人的關卡用最近一次發出的自評表上同一關的人；那一關沒人、或從沒發過就留空；不算修改流程', async ({ skip }) => {
    const temp = await migratedDb('csa_backfill', { before: '20261215000000' })
    if (!temp) return skip()
    const { db } = temp
    try {
      const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
      const id = async (sql: string, params: unknown[] = []): Promise<string> => (await one(`${sql} returning id`, params)).id
      // 範本、流程、自評表直接寫入（關掉觸發器與外鍵），只在這個暫時的資料庫。
      await db.query('set session_replication_role = replica')
      const unit = await id(`insert into public.assessing_unit (name) values ('業務')`)
      const plant = await id(`insert into public.plant (factory_code, name, company_id) values ('P1', '一廠', gen_random_uuid())`)
      const template = await id(`insert into public.questionnaire_template (code, name, layout, component) values ('T-01', '範本', 'control_activity', 'control_activities')`)
      const route = await id(`insert into public.approval_route (template_id, plant_id, updated_at) values ($1, $2, '2026-10-01T00:00:00Z')`, [template, plant])
      await db.query(
        `insert into public.route_step (route_id, position, name, step_group, signer_emp_id, editable_unit_id, branch_unit_id, link) values
           ($1, 1, '自行檢查人員', 'plant', null, $2, $2, null),
           ($1, 2, '部門主管', 'plant', null, null, $2, null),
           ($1, 3, '課長', 'plant', null, null, $2, null),
           ($1, 4, '廠區經理人', 'plant', null, null, null, null),
           ($1, 5, '子公司擔當稽核', 'audit_review', null, null, null, null),
           ($1, 6, '稽核主管', 'audit_review', 'ROUTECHIEF', null, null, 'audit_chief')`,
        [route, unit],
      )
      // 兩年的自評表：2025 的部門主管與子公司擔當稽核還沒分派。2025 那份的範本是改過編號前的舊 id（同編號也算）。
      for (const [year, templateId, signers] of [
        [2024, template, ['OLD1', 'OLD2', 'OLD3', 'OLDAUD']],
        [2025, null, ['NEW1', null, 'NEW3', null]],
      ] as const) {
        const cycle = await id(`insert into public.annual_cycle (year, due_date) values ($1, '2099-12-31')`, [year])
        const form = await id(
          `insert into public.assessment (cycle_id, plant_id, template_id, template_code, template_name, template_layout)
           values ($1, $2, coalesce($3, gen_random_uuid()), 'T-01', '範本', 'control_activity')`,
          [cycle, plant, templateId],
        )
        await db.query(
          `insert into public.assessment_step (assessment_id, position, name, step_group, signer_emp_id, editable_unit_name, branch_unit_name, link) values
             ($1, 1, '自行檢查人員', 'plant', $2, '業務', '業務', null),
             ($1, 2, '部門主管', 'plant', $3, null, '業務', null),
             ($1, 3, '廠區經理人', 'plant', $4, null, null, null),
             ($1, 4, '子公司擔當稽核', 'audit_review', $5, null, null, null),
             ($1, 5, '稽核主管', 'audit_review', 'FORMCHIEF', null, null, 'audit_chief')`,
          [form, ...signers],
        )
      }
      await db.query('set session_replication_role = origin')

      await temp.migrateRest()

      const rows = (await db.query(`select name, signer_emp_id from public.route_step where route_id = $1 order by position`, [route])).rows
      expect(rows).toEqual([
        { name: '自行檢查人員', signer_emp_id: 'NEW1' },
        { name: '部門主管', signer_emp_id: null }, // 2025 還沒分派：不往 2024 找
        { name: '課長', signer_emp_id: null },
        { name: '廠區經理人', signer_emp_id: 'NEW3' },
        { name: '子公司擔當稽核', signer_emp_id: null },
        { name: '稽核主管', signer_emp_id: 'ROUTECHIEF' },
      ])
      expect((await one(`select updated_at from public.approval_route where id = $1`, [route])).updated_at.toISOString()).toBe('2026-10-01T00:00:00.000Z')
      expect((await one(`select count(*)::int as n from public.access_change_log`)).n).toBe(0)
    } finally {
      await temp.drop()
    }
  }, 120_000)
})
