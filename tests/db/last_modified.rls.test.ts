// 範本與簽核流程的「最後修改」＝時間＋修改人（#201，Q137 (3)）：範本的抬頭、章節、控制要點、自評單位，流程的任何關卡，
// 每一次寫入都記下時間與修改人的工號，計算欄位 updated_by_name 從員工參照取姓名。以兩位稽核管理者的 CSA session 走
// PostgREST 輪流改，看每次是不是換成最後那一位；service_role 只用來準備與清理。種子與轉換類 migration 不更新（在自己的
// 資料庫試，暫停觸發器是 DDL，會鎖住共用資料庫的範本表）；發起進行中改範本內容照舊要等（Q89）。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LastModifiedFields } from '../../src/domain/lastModified'
import {
  admin, beginAs, directDb, insertRow, loginAs, loginAsAdminAccount, makeTemplate, migratedDb, ok, promoteToAuditAdmin, requirePostgrest,
  stillWaiting,
} from './helpers'

// 資料庫測試檔案並行執行：前綴與隨機尾巴避免和其他檔案的工號、編號撞在一起。
const RUN = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { a: `${RUN}A`, b: `${RUN}B` }
const NAME = { a: '甲改', b: '乙改' }
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = { one: `${RUN}甲單位`, two: `${RUN}乙單位` }
const ID = { company: '', plant: '', template: '', one: '', two: '', route: '' }

let a: SupabaseClient
let b: SupabaseClient

const LAST_MODIFIED = 'updated_at,updated_by,updated_by_name'

async function templateModified(): Promise<LastModifiedFields> {
  return ok(await a.from('questionnaire_template').select(LAST_MODIFIED).eq('id', ID.template).single<LastModifiedFields>())
}

async function routeModified(): Promise<LastModifiedFields> {
  return ok(await a.from('approval_route').select(LAST_MODIFIED).eq('id', ID.route).single<LastModifiedFields>())
}

/**
 * Runs `write` (a PostgREST call, whose error fails the test, or a direct-SQL one) and answers the 最後修改 `read` gives
 * after it, checking that the time moved on.
 */
async function afterWrite(
  read: () => Promise<LastModifiedFields>,
  write: () => PromiseLike<{ data: unknown; error: unknown } | void>,
): Promise<LastModifiedFields> {
  const before = await read()
  const result = await write()
  if (result) ok(result)
  const after = await read()
  expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before.updated_at))
  return after
}

const afterTemplateWrite = (write: Parameters<typeof afterWrite>[1]) => afterWrite(templateModified, write)
const afterRouteWrite = (write: Parameters<typeof afterWrite>[1]) => afterWrite(routeModified, write)

const byA = { updated_by: EMP.a, updated_by_name: NAME.a }
const byB = { updated_by: EMP.b, updated_by_name: NAME.b }

async function sectionIds(): Promise<string[]> {
  const rows = ok(await a.from('template_section').select('id').eq('template_id', ID.template).order('position')) as { id: string }[]
  return rows.map((r) => r.id)
}

async function controlPointIds(): Promise<string[]> {
  const rows = ok(
    await a.from('control_point').select('id,template_section!inner(template_id,position),position')
      .eq('template_section.template_id', ID.template),
  ) as unknown as { id: string; position: number; template_section: { position: number } }[]
  return rows.sort((x, y) => x.template_section.position - y.template_section.position || x.position - y.position).map((r) => r.id)
}

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.a, NAME.a)
  await loginAs(EMP.b, NAME.b)
  await promoteToAuditAdmin(EMP.a)
  await promoteToAuditAdmin(EMP.b)
  a = await loginAs(EMP.a, NAME.a)
  b = await loginAs(EMP.b, NAME.b)

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  ID.one = (await insertRow('assessing_unit', { name: UNIT.one })).id
  ID.two = (await insertRow('assessing_unit', { name: UNIT.two })).id
  ID.template = await makeTemplate(`${RUN}-T`, 'control_activity', FACTORY, [
    ['甲章', [['第一題？', ID.one], ['第二題？', ID.one]]],
    ['乙章', [['第三題？', ID.one]]],
  ])
})

afterAll(async () => {
  ok(await admin.from('approval_route').delete().eq('plant_id', ID.plant))
  ok(await admin.from('questionnaire_template').delete().like('code', `${RUN}-%`))
  ok(await admin.from('plant').delete().eq('factory_code', FACTORY))
  ok(await admin.from('company').delete().eq('id', ID.company))
  ok(await admin.from('assessing_unit').delete().in('name', Object.values(UNIT)))
})

describe('範本的最後修改（#201）', () => {
  it('leaves 修改人 empty on a template written by setup (service_role has no 工號)', async () => {
    expect(await templateModified()).toMatchObject({ updated_by: null, updated_by_name: null })
  })

  it('records whoever edits the header last', async () => {
    const after = await afterTemplateWrite(() =>
      a.rpc('update_template', {
        p_template_id: ID.template, p_code: `${RUN}-T`, p_name: `${RUN} 改名`, p_status: 'active',
        p_all_plants: false, p_factory_codes: [FACTORY], p_component: null,
      }),
    )
    expect(after).toMatchObject(byA)
  })

  it('counts a section rename and a section reorder as a change', async () => {
    const [first, second] = await sectionIds()
    expect(await afterTemplateWrite(() => b.from('template_section').update({ name: '甲章（改）' }).eq('id', first!))).toMatchObject(byB)
    expect(
      await afterTemplateWrite(() => a.rpc('reorder_template_sections', { p_template_id: ID.template, p_section_ids: [second, first] })),
    ).toMatchObject(byA)
  })

  it('counts a control point edit, a new one and a deleted one as a change', async () => {
    const [cp] = await controlPointIds()
    expect(
      await afterTemplateWrite(() =>
        b.rpc('update_control_point', { p_control_point_id: cp, p_text: '第三題（改）？', p_unit_ids: [ID.one], p_code: null }),
      ),
    ).toMatchObject(byB)
    const [section] = await sectionIds()
    expect(
      await afterTemplateWrite(() =>
        a.rpc('create_control_point', { p_section_id: section, p_text: '新的一題？', p_unit_ids: [ID.one], p_code: null }),
      ),
    ).toMatchObject(byA)
    expect(await afterTemplateWrite(() => b.from('control_point').delete().eq('id', cp!))).toMatchObject(byB)
  })

  it('counts a change to a control point’s 自評單位 alone as a change', async ({ skip }) => {
    // API 只能經 update_control_point 寫單位（那也會寫控制要點那一列）；這裡以 A 的身分直接改單位表，驗單位表自己的觸發器。
    const sql = await directDb()
    if (!sql) return skip()
    const [cp] = await controlPointIds()
    try {
      const after = await afterTemplateWrite(async () => {
        await beginAs(sql, EMP.a)
        await sql.query('reset role')
        await sql.query('update public.control_point_unit set assessing_unit_id = $1 where control_point_id = $2', [ID.two, cp])
        await sql.query('commit')
      })
      expect(after).toMatchObject(byA)
    } finally {
      await sql.end()
    }
  })

  it('records the 管理員帳號 as admin, which the page shows as 管理員帳號 (it has no name in 員工參照)', async () => {
    const account = await loginAsAdminAccount()
    const [first] = await sectionIds()
    const after = await afterTemplateWrite(() => account.from('template_section').update({ name: '甲章（管理員改）' }).eq('id', first!).select('id'))
    expect(after).toMatchObject({ updated_by: 'admin', updated_by_name: null })
  })

  it('still holds a content edit while a launch holds the template FOR SHARE (Q89)', async ({ skip }) => {
    const [launching, editing] = [await directDb(), await directDb()]
    if (!launching || !editing) {
      await launching?.end()
      await editing?.end()
      return skip()
    }
    try {
      await launching.query('begin')
      await launching.query('select 1 from public.questionnaire_template where id = $1 for share', [ID.template])
      await beginAs(editing, EMP.a)
      const pending = editing.query("update public.template_section set name = name || '（等）' where template_id = $1", [ID.template])
      expect(await stillWaiting(pending)).toBe(true)
      await launching.query('commit')
      await pending
      await editing.query('rollback')
    } finally {
      await launching.end()
      await editing.end()
    }
  })
})

describe('簽核流程的最後修改（#201）', () => {
  it('records the creator of a new route', async () => {
    const route = ok(await a.from('approval_route').insert({ template_id: ID.template, plant_id: ID.plant }).select('id').single()) as { id: string }
    ID.route = route.id
    // 姓名要另外讀：新增那一句的 RETURNING 裡，計算欄位還看不到這一列（它比對表上的值）。
    expect(await routeModified()).toMatchObject(byA)
  })

  it('records whoever adds, edits or deletes a step last', async () => {
    let stepId = ''
    expect(
      await afterRouteWrite(async () => {
        const result = await b.rpc('insert_route_step', {
          p_route_id: ID.route, p_name: `自行檢查人員－${UNIT.one}`, p_step_group: 'plant', p_signer_emp_id: null,
          p_editable_unit_id: ID.one, p_before_position: null, p_link: null,
        })
        stepId = result.data as string
        return result
      }),
    ).toMatchObject(byB)
    expect(await afterRouteWrite(() => a.from('route_step').update({ name: '自行檢查人員（改）' }).eq('id', stepId))).toMatchObject(byA)
    expect(await afterRouteWrite(() => b.from('route_step').delete().eq('id', stepId))).toMatchObject(byB)
  })
})

describe('種子與轉換類 migration 不更新最後修改（#201）', () => {
  it('keeps the time and 修改人 while the touch trigger is paused, and names only the real 修改人', { timeout: 120_000 }, async ({ skip }) => {
    const own = await migratedDb('csa_last_modified')
    if (!own) return skip()
    const { db, drop } = own
    try {
      // 種子：沒有工號的連線新增範本與章節。
      const { rows: [t] } = await db.query(
        `insert into public.questionnaire_template (code, name, layout, status, all_plants)
         values ('LM-01', '最後修改', 'element', 'active', true) returning id`,
      )
      await db.query("insert into public.template_section (template_id, position, name) values ($1, 1, '甲章')", [t.id])
      const read = async () =>
        (await db.query(
          'select updated_at::text, updated_by, public.updated_by_name(t) as name from public.questionnaire_template t where id = $1',
          [t.id],
        )).rows[0] as { updated_at: string; updated_by: string | null; name: string | null }
      const seeded = await read()
      expect(seeded).toMatchObject({ updated_by: null, name: null })

      // 轉換：暫停觸發器，即使連線帶著工號，改抬頭與章節都不更新。
      await db.query('begin')
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ app_metadata: { emp_id: 'ZZCONVERT' } })])
      await db.query('alter table public.questionnaire_template disable trigger questionnaire_template_touch_updated_at')
      await db.query("update public.questionnaire_template set name = '最後修改（轉換）' where id = $1", [t.id])
      await db.query("update public.template_section set name = '甲章（轉換）' where template_id = $1", [t.id])
      await db.query('alter table public.questionnaire_template enable trigger questionnaire_template_touch_updated_at')
      await db.query('commit')
      expect(await read()).toEqual(seeded)

      // 平常的寫入會記；員工參照裡沒有這個工號，姓名查不到（畫面改顯示工號）。
      await db.query('begin')
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ app_metadata: { emp_id: 'ZZNOREF' } })])
      await db.query("update public.template_section set name = '甲章（再改）' where template_id = $1", [t.id])
      await db.query('commit')
      expect(await read()).toMatchObject({ updated_by: 'ZZNOREF', name: null })

      // 有姓名的修改人；拿別的工號套在這一列上查，查不到（不能藉它查任意工號的姓名）。
      await db.query("insert into public.employee_ref (emp_id, name) values ('ZZNOREF', '某某'), ('ZZOTHER', '別人')")
      expect(await read()).toMatchObject({ updated_by: 'ZZNOREF', name: '某某' })
      const { rows: [forged] } = await db.query(
        `select public.updated_by_name(jsonb_populate_record(t, '{"updated_by":"ZZOTHER"}')) as name from public.questionnaire_template t where id = $1`,
        [t.id],
      )
      expect(forged.name).toBeNull()
    } finally {
      await drop()
    }
  })
})
