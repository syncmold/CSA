// 資料 API 接縫: 權限管理（工單 #58、Q98；系統維護員 #159、Q122）——放行名單、權限角色、檢視者與權限異動紀錄。
// 每次執行用自己的工號（RUN 開頭），結束時移出放行名單；權限異動紀錄只新增、刪不掉，所以留著。
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { readAssessmentPdfSource } from '../../src/api/assessmentPdfQuery'
import { selectTracking } from '../../src/api/trackingQuery'
import {
  launchAssigned, admin, depsFor, insertRow, loginAs, makeRoute, makeTemplate, migratedDb, ok, promoteToAuditAdmin, promoteToSystemMaintainer,
  requirePostgrest, restClient, withSuperuser,
} from './helpers'

const RUN = `M${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
const EMP = {
  chief: `${RUN}A`,
  newcomer: `${RUN}B`,
  batch1: `${RUN}C`,
  batch2: `${RUN}D`,
  outsider: `${RUN}E`,
  logged: `${RUN}F`,
  byCommand: `${RUN}G`,
  lastLogin: `${RUN}H`,
  /** 系統維護員 (Q122) */
  maint: `${RUN}S`,
  promoted: `${RUN}I`,
  /** 稽核人員 (#187) */
  staff: `${RUN}J`,
}

const FACTORY_1 = `${RUN}P1`
const ID: Record<string, string> = {}

/** What the page sends for each pasted 工號 OMS's channel found (#218). */
const person = (empId: string, name = `${empId}姓名`, factoryCode = 'FQ') => ({ emp_id: empId, name, factory_code: factoryCode })

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.chief, '甲')
  await promoteToAuditAdmin(EMP.chief)
  ok(await admin.from('access_allowlist').insert({ emp_id: EMP.chief }))
  await loginAs(EMP.maint, '維')
  await promoteToSystemMaintainer(EMP.maint)
  ok(await admin.from('access_allowlist').insert({ emp_id: EMP.maint }))
  ID.company = (await insertRow('company', { name: `${RUN}公司` })).id
  ID.plant1 = (await insertRow('plant', { factory_code: FACTORY_1, name: `${RUN}一廠`, company_id: ID.company })).id
})

afterAll(async () => {
  // One at a time: the database keeps at least one 稽核管理者 and one 系統維護員 on the list, which may be this run's
  // own (then they stay).
  const listed = ok(await admin.from('access_allowlist').select('emp_id').like('emp_id', `${RUN}%`)) as { emp_id: string }[]
  for (const { emp_id } of listed) await admin.from('access_allowlist').delete().eq('emp_id', emp_id)
  await admin.from('plant').delete().in('factory_code', [FACTORY_1])
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
})

describe('加入', () => {
  it('a 系統維護員 adds someone who never signed in as 稽核人員, and their first login already has the role', async () => {
    const maint = await loginAs(EMP.maint, '維')
    const added = await maint.rpc('add_access_members', {
      p_people: [person(EMP.newcomer, '新人')],
      p_role: 'audit_staff',
      p_viewer_plant_ids: [],
      p_note: '新任稽核',
    })
    expect(added.error).toBeNull()
    expect(added.data).toEqual({ added: [EMP.newcomer], skipped: [] })

    const newcomer = await loginAs(EMP.newcomer, '新人（OMS）')
    const me = ok(await newcomer.from('employee_ref').select('audit_role,name').eq('emp_id', EMP.newcomer).single())
    expect(me).toEqual({ audit_role: 'audit_staff', name: '新人（OMS）' })
  })

  it('adds a pasted batch once each, skipping 工號 already on the list, all with the same role and note', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    const added = await chief.rpc('add_access_members', {
      p_people: [person(EMP.batch1), person(EMP.chief), { ...person(EMP.batch2), emp_id: ` ${EMP.batch2.toLowerCase()}` }, person(EMP.batch1)],
      p_role: 'signer',
      p_viewer_plant_ids: [],
      p_note: '第二批',
    })
    expect(added.error).toBeNull()
    expect(added.data).toEqual({ added: [EMP.batch1, EMP.batch2], skipped: [EMP.chief] })
    const members = ok(await chief.from('access_member').select('emp_id,name,factory_code,audit_role,note,added_by_emp_id,added_by_name')
      .in('emp_id', [EMP.batch1, EMP.batch2]).order('emp_id'))
    expect(members).toEqual([EMP.batch1, EMP.batch2].map((id) => ({
      emp_id: id, name: `${id}姓名`, factory_code: 'FQ', audit_role: 'signer', note: '第二批', added_by_emp_id: EMP.chief, added_by_name: '甲',
    })))
  })

  it('refuses anyone but a 稽核管理者 (42501), and nobody writes the list or 稽核角色 directly', async () => {
    const signer = await loginAs(EMP.batch1, EMP.batch1)
    for (const [fn, args] of [
      ['add_access_members', { p_people: [person(EMP.outsider)], p_role: 'audit_admin', p_viewer_plant_ids: [], p_note: null }],
      ['update_access_member', { p_emp_id: EMP.batch1, p_role: 'audit_admin', p_viewer_plant_ids: [], p_note: null }],
      ['remove_access_member', { p_emp_id: EMP.chief }],
      ['access_removal_impact', { p_emp_id: EMP.chief }],
    ] as const) {
      expect((await signer.rpc(fn, args)).error?.code, fn).toBe('42501')
    }
    expect(ok(await signer.from('access_member').select('emp_id'))).toEqual([])
    const chief = await loginAs(EMP.chief, '甲')
    expect((await chief.from('employee_ref').update({ audit_role: 'signer' }).eq('emp_id', EMP.batch1)).error?.code).toBe('42501')
    expect((await chief.from('access_allowlist').insert({ emp_id: EMP.outsider })).error?.code).toBe('42501')
    // The triggers' helpers read past employee_ref's RLS; nobody calls them over /rpc.
    expect((await signer.rpc('access_snapshot', { p_emp_id: EMP.chief, p_note: null })).error?.code).toBe('42501')
    expect((await signer.rpc('viewer_plant_codes', { p_plant_ids: [] })).error?.code).toBe('42501')
  })
})

describe('稽核管理者只管一般使用者與檢視者（Q122 (3)）', () => {
  it('a 稽核管理者 cannot make anyone a 稽核管理者 or 系統維護員, nor change or remove those who are one (42501)', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    const add = (role: string) => chief.rpc('add_access_members', { p_people: [person(EMP.outsider)], p_role: role, p_viewer_plant_ids: [], p_note: null })
    const update = (empId: string, role: string, note: string | null = null) =>
      chief.rpc('update_access_member', { p_emp_id: empId, p_role: role, p_viewer_plant_ids: role === 'viewer' ? [ID.plant1] : [], p_note: note })
    for (const [what, call] of [
      ['add as 稽核管理者', add('audit_admin')],
      ['add as 系統維護員', add('system_maintainer')],
      ['promote a 一般使用者', update(EMP.batch1, 'audit_admin')],
      ['make a 一般使用者 a 系統維護員', update(EMP.batch1, 'system_maintainer')],
      ['edit a 稽核主管’s note', update(EMP.chief, 'audit_admin', 'x')],
      ['demote a 系統維護員', update(EMP.maint, 'viewer')],
      ['demote themselves', update(EMP.chief, 'signer')],
      ['remove a 稽核主管', chief.rpc('remove_access_member', { p_emp_id: EMP.chief })],
      ['remove a 系統維護員', chief.rpc('remove_access_member', { p_emp_id: EMP.maint })],
    ] as const) {
      const { error } = await call
      expect([error?.code, error?.hint], what).toEqual(['42501', 'maintainer_only'])
    }
    const members = ok(await chief.from('access_member').select('emp_id,audit_role,note').in('emp_id', [EMP.outsider, EMP.batch1, EMP.newcomer, EMP.maint]).order('emp_id'))
    expect(members).toEqual([
      { emp_id: EMP.newcomer, audit_role: 'audit_staff', note: '新任稽核' },
      { emp_id: EMP.batch1, audit_role: 'signer', note: '第二批' },
      { emp_id: EMP.maint, audit_role: 'system_maintainer', note: null },
    ])
  })

  it('a 稽核管理者 still adds, edits and removes 一般使用者 and 檢視者', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    ok(await chief.rpc('add_access_members', { p_people: [person(EMP.promoted, '升')], p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: null }))
    ok(await chief.rpc('update_access_member', { p_emp_id: EMP.promoted, p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
    ok(await chief.rpc('remove_access_member', { p_emp_id: EMP.promoted }))
    expect(ok(await chief.from('access_member').select('emp_id').eq('emp_id', EMP.promoted))).toEqual([])
  })

  it('a 系統維護員 sets any role, 系統維護員 included, and sees everyone on the list', async () => {
    const maint = await loginAs(EMP.maint, '維')
    ok(await maint.rpc('add_access_members', { p_people: [person(EMP.promoted, '升')], p_role: 'system_maintainer', p_viewer_plant_ids: [], p_note: null }))
    // 稽核主管 is not set here: it hands the role over from the previous holder, which the shared database's other tests lean on
    // (see 換稽核主管 below, rolled back).
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.promoted, p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null }))
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.promoted, p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: null }))
    const seen = ok(await maint.from('access_member').select('emp_id,audit_role').in('emp_id', [EMP.chief, EMP.maint, EMP.promoted]).order('emp_id'))
    expect(seen).toEqual([
      { emp_id: EMP.chief, audit_role: 'audit_admin' },
      { emp_id: EMP.promoted, audit_role: 'viewer' },
      { emp_id: EMP.maint, audit_role: 'system_maintainer' },
    ])
  })

  it('a 系統維護員 cannot run a plant: assigning one is refused, and becoming one steps down from the plants', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    const refused = await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant1, p_emp_id: EMP.maint })
    expect([refused.error?.code, refused.error?.hint]).toEqual(['23514', 'maintainer_not_coordinator'])

    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant1, p_emp_id: EMP.promoted }))
    const maint = await loginAs(EMP.maint, '維')
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.promoted, p_role: 'system_maintainer', p_viewer_plant_ids: [], p_note: null }))
    expect(ok(await maint.from('access_member').select('coordinator_plant_ids').eq('emp_id', EMP.promoted).single()))
      .toEqual({ coordinator_plant_ids: [] })
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.promoted, p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
  })
})

describe('稽核人員（#187）', () => {
  it('a 稽核主管 and a 系統維護員 both set, edit and remove a 稽核人員', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    ok(await chief.rpc('add_access_members', { p_people: [person(EMP.staff, '稽')], p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: '稽核室' }))
    ok(await chief.rpc('update_access_member', { p_emp_id: EMP.staff, p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: '改備註' }))
    const maint = await loginAs(EMP.maint, '維')
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.staff, p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: null }))
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.staff, p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null }))
    expect(ok(await chief.from('access_member').select('audit_role,viewer_plant_ids').eq('emp_id', EMP.staff).single()))
      .toEqual({ audit_role: 'audit_staff', viewer_plant_ids: [] })
    ok(await chief.rpc('remove_access_member', { p_emp_id: EMP.staff }))
    ok(await maint.rpc('add_access_members', { p_people: [person(EMP.staff, '稽')], p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null }))
  })

  it('a 稽核人員 manages no one, and sees only what a 一般使用者 does until a plant is his', async () => {
    const staff = await loginAs(EMP.staff, '稽')
    for (const [fn, args] of [
      ['add_access_members', { p_people: [person(EMP.outsider)], p_role: 'signer', p_viewer_plant_ids: [], p_note: null }],
      ['update_access_member', { p_emp_id: EMP.batch1, p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: null }],
      ['remove_access_member', { p_emp_id: EMP.batch1 }],
      ['set_plant_coordinator', { p_plant_id: ID.plant1, p_emp_id: EMP.staff }],
    ] as const) {
      expect((await staff.rpc(fn, args)).error?.code, fn).toBe('42501')
    }
    expect(ok(await staff.from('access_member').select('emp_id'))).toEqual([])
    expect(ok(await staff.from('access_change_log').select('id'))).toEqual([])
    expect(ok(await staff.from('plant_coordinator').select('plant_id'))).toEqual([])
  })

  it('becomes 廠區管理員 like anyone else, and keeps the plant when no longer a 稽核人員 (it does not follow the role)', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant1, p_emp_id: EMP.staff }))
    const staff = await loginAs(EMP.staff, '稽')
    expect(ok(await staff.from('plant_coordinator').select('plant_id').eq('emp_id', EMP.staff))).toEqual([{ plant_id: ID.plant1 }])
    ok(await chief.rpc('update_access_member', { p_emp_id: EMP.staff, p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
    expect(ok(await chief.from('access_member').select('audit_role,coordinator_plant_ids').eq('emp_id', EMP.staff).single()))
      .toEqual({ audit_role: 'signer', coordinator_plant_ids: [ID.plant1] })
    ok(await chief.rpc('remove_plant_coordinator', { p_plant_id: ID.plant1 }))
    ok(await chief.rpc('update_access_member', { p_emp_id: EMP.staff, p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null }))
  })
})

describe('換稽核主管（#187：稽核主管剛好一位）', () => {
  type Sql = pg.Client
  interface Tx {
    sql: Sql
    /** Run what follows as this 工號, signed in (RLS and the functions see it), until `asSuperuser`. */
    as: (who: string) => Promise<void>
    asSuperuser: () => Promise<void>
    /** The rows the 權限異動紀錄 got since this transaction began. */
    log: (targets: string[]) => Promise<{ target_emp_id: string; action: string; before: unknown; after: unknown }[]>
  }
  /**
   * 換稽核主管 is database-wide: it demotes the one before, and the 稽核主管 關卡 of every route and 自評表 follow the new
   * one (#190). In the shared database that would demote, rewrite and lock what the other test files are using, so these
   * run in a database of their own, where EMP.chief is the only 稽核主管, each test in a transaction rolled back at the end.
   */
  let temp: Awaited<ReturnType<typeof migratedDb>> = null
  beforeAll(async () => {
    temp = await migratedDb('csa_handover')
    if (!temp) return
    await temp.db.query(
      `insert into public.employee_ref (emp_id, name, audit_role) values ($1, '甲', 'audit_admin'), ($2, '維', 'system_maintainer'),
         ($3, $3 || '姓名', 'signer'), ($4, $4 || '姓名', 'signer')`,
      [EMP.chief, EMP.maint, EMP.batch1, EMP.batch2],
    )
    // 同共用資料庫裡「加入」那一段之後的樣子：第二批的兩位是一般使用者，備註「第二批」。
    await temp.db.query(
      `insert into public.access_allowlist (emp_id, note) values ($1, null), ($2, null), ($3, '第二批'), ($4, '第二批')`,
      [EMP.chief, EMP.maint, EMP.batch1, EMP.batch2],
    )
  }, 120_000)
  afterAll(() => temp?.drop())

  async function inRollback<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    const sql = temp!.db
    await sql.query('begin')
    try {
      const { rows } = await sql.query('select coalesce(max(id), 0) as since from public.access_change_log')
      return await run({
        sql,
        as: async (who) => {
          await sql.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'authenticated', app_metadata: { emp_id: who } })])
          await sql.query('set local role authenticated')
        },
        asSuperuser: async () => {
          await sql.query('reset role')
        },
        log: async (targets) =>
          (await sql.query(
            `select target_emp_id, action, before, after from public.access_change_log where id > $1 and target_emp_id = any($2) order by id`,
            [rows[0].since, targets],
          )).rows,
      })
    } finally {
      await sql.query('rollback')
    }
  }
  const rolesOf = async (sql: Sql, ids: string[]) =>
    Object.fromEntries((await sql.query('select emp_id, audit_role from public.employee_ref where emp_id = any($1)', [ids])).rows.map((r) => [r.emp_id, r.audit_role]))

  it('adding a new 稽核主管 demotes the one before to 一般使用者 and logs one 換稽核主管 on the new one, the old one named inside', async ({ skip }) => {
    if (!temp) skip()
    await inRollback(async ({ sql, as, asSuperuser, log }) => {
      await as(EMP.maint)
      await sql.query(`select public.add_access_members($1::jsonb, 'audit_admin', '{}', null)`, [JSON.stringify([person(EMP.outsider, '新主管')])])
      await asSuperuser()
      expect(await rolesOf(sql, [EMP.chief, EMP.outsider])).toEqual({ [EMP.chief]: 'signer', [EMP.outsider]: 'audit_admin' })
      const rows = await log([EMP.chief, EMP.outsider])
      expect(rows.map((r) => [r.target_emp_id, r.action])).toEqual([[EMP.outsider, 'added'], [EMP.outsider, 'audit_admin_replaced']])
      expect(rows[1]).toMatchObject({ before: { emp_id: EMP.chief, name: '甲' }, after: 'audit_admin' })
    })
  })

  it('promoting someone already on the list does the same: the old one steps down quietly, and the new one gets one 換稽核主管 row, no 角色 row', async ({ skip }) => {
    if (!temp) skip()
    await inRollback(async ({ sql, as, asSuperuser, log }) => {
      await as(EMP.maint)
      await sql.query(`select public.update_access_member($1, 'audit_admin', '{}', '第二批')`, [EMP.batch1])
      await asSuperuser()
      expect(await rolesOf(sql, [EMP.chief, EMP.batch1])).toEqual({ [EMP.chief]: 'signer', [EMP.batch1]: 'audit_admin' })
      const rows = await log([EMP.chief, EMP.batch1])
      expect(rows.map((r) => [r.target_emp_id, r.action])).toEqual([[EMP.batch1, 'audit_admin_replaced']])
      expect(rows[0]).toMatchObject({ before: { emp_id: EMP.chief }, after: 'audit_admin' })
    })
  })

  it('with no 稽核主管 before (a new environment), the first one set on the page gets the plain 角色 row and no 接任稽核主管', async ({ skip }) => {
    if (!temp) skip()
    await inRollback(async ({ sql, as, asSuperuser, log }) => {
      // Triggers off for a moment (superuser) to leave the database with no 稽核主管 at all; rolled back below.
      await sql.query('set local session_replication_role = replica')
      await sql.query(`update public.employee_ref set audit_role = 'signer' where emp_id = $1`, [EMP.chief])
      await sql.query('set local session_replication_role = origin')
      await as(EMP.maint)
      await sql.query(`select public.update_access_member($1, 'audit_admin', '{}', '第二批')`, [EMP.batch1])
      await asSuperuser()
      expect(await rolesOf(sql, [EMP.chief, EMP.batch1])).toEqual({ [EMP.chief]: 'signer', [EMP.batch1]: 'audit_admin' })
      const rows = await log([EMP.batch1])
      expect(rows.map((r) => [r.action, r.before, r.after])).toEqual([['role', 'signer', 'audit_admin']])
    })
  })

  it('the one who stepped down is a 一般使用者 on the list, and may be set again later, which demotes the other way round', async ({ skip }) => {
    if (!temp) skip()
    await inRollback(async ({ sql, as, asSuperuser }) => {
      await as(EMP.maint)
      await sql.query(`select public.update_access_member($1, 'audit_admin', '{}', null)`, [EMP.batch1])
      await sql.query(`select public.update_access_member($1, 'audit_admin', '{}', null)`, [EMP.chief])
      await asSuperuser()
      expect(await rolesOf(sql, [EMP.chief, EMP.batch1])).toEqual({ [EMP.chief]: 'audit_admin', [EMP.batch1]: 'signer' })
      const { rows } = await sql.query('select emp_id from public.access_allowlist where emp_id = any($1) order by emp_id', [[EMP.chief, EMP.batch1]])
      expect(rows.map((r) => r.emp_id)).toEqual([EMP.chief, EMP.batch1])
    })
  })

  it('names every former 稽核主管 when the database had several (the test environment today)', async ({ skip }) => {
    if (!temp) skip()
    await inRollback(async ({ sql, as, asSuperuser, log }) => {
      await sql.query(`update public.employee_ref set audit_role = 'audit_admin' where emp_id = $1`, [EMP.batch1])
      await as(EMP.maint)
      await sql.query(`select public.update_access_member($1, 'audit_admin', '{}', null)`, [EMP.batch2])
      await asSuperuser()
      expect(await rolesOf(sql, [EMP.chief, EMP.batch1, EMP.batch2])).toEqual({ [EMP.chief]: 'signer', [EMP.batch1]: 'signer', [EMP.batch2]: 'audit_admin' })
      const replaced = (await log([EMP.batch2])).find((r) => r.action === 'audit_admin_replaced')
      expect(replaced?.before).toMatchObject({ emp_id: EMP.chief, others: [{ emp_id: EMP.batch1 }] })
    })
  })

  it('editing the note of a 稽核主管 who is already one demotes nobody, even when the database has several', async ({ skip }) => {
    if (!temp) skip()
    await inRollback(async ({ sql, as, asSuperuser }) => {
      await sql.query(`update public.employee_ref set audit_role = 'audit_admin' where emp_id = $1`, [EMP.batch1])
      await as(EMP.maint)
      await sql.query(`select public.update_access_member($1, 'audit_admin', '{}', '只改備註')`, [EMP.chief])
      await asSuperuser()
      expect(await rolesOf(sql, [EMP.chief, EMP.batch1])).toEqual({ [EMP.chief]: 'audit_admin', [EMP.batch1]: 'audit_admin' })
    })
  })

  it('refuses two new 稽核主管 in one batch (22023, single_audit_admin), and only a 系統維護員 may set one at all', async ({ skip }) => {
    if (!temp) skip()
    await inRollback(async ({ sql, as }) => {
      await as(EMP.maint)
      await expect(
        sql.query(`select public.add_access_members($1::jsonb, 'audit_admin', '{}', null)`, [JSON.stringify([person(EMP.outsider), person(EMP.byCommand)])]),
      ).rejects.toMatchObject({ code: '22023', hint: 'single_audit_admin' })
    })
    await inRollback(async ({ sql, as }) => {
      await as(EMP.chief)
      await expect(sql.query(`select public.update_access_member($1, 'audit_admin', '{}', null)`, [EMP.batch1]))
        .rejects.toMatchObject({ code: '42501', hint: 'maintainer_only' })
    })
  })
})

describe('修改與移除', () => {
  it('changes role, 檢視廠區 and note together; any role but 檢視者 has no 檢視廠區', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    ok(await chief.rpc('update_access_member', { p_emp_id: EMP.batch1, p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: '廠長' }))
    expect(ok(await chief.from('access_member').select('audit_role,viewer_plant_ids,note').eq('emp_id', EMP.batch1).single()))
      .toEqual({ audit_role: 'viewer', viewer_plant_ids: [ID.plant1], note: '廠長' })

    ok(await chief.rpc('update_access_member', { p_emp_id: EMP.batch1, p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: '' }))
    expect(ok(await chief.from('access_member').select('audit_role,viewer_plant_ids,note').eq('emp_id', EMP.batch1).single()))
      .toEqual({ audit_role: 'signer', viewer_plant_ids: [], note: null })
  })

  it('only takes 檢視廠區 from the plant master', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    const r = await chief.rpc('update_access_member', {
      p_emp_id: EMP.batch1, p_role: 'viewer', p_viewer_plant_ids: ['00000000-0000-4000-8000-000000000000'], p_note: null,
    })
    expect(r.error?.code).toBe('23503')
  })

  it('removing takes the person off the list, back to 簽核人 with no 檢視廠區, keeps employee_ref, and the next exchange is refused', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    ok(await chief.rpc('update_access_member', { p_emp_id: EMP.batch2, p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: null }))
    ok(await chief.rpc('remove_access_member', { p_emp_id: EMP.batch2 }))

    expect(ok(await chief.from('access_member').select('emp_id').eq('emp_id', EMP.batch2))).toEqual([])
    expect(ok(await admin.from('employee_ref').select('audit_role,viewer_plant_ids,name').eq('emp_id', EMP.batch2).single()))
      .toEqual({ audit_role: 'signer', viewer_plant_ids: [], name: `${EMP.batch2}姓名` })
    // The next renewal asks exactly this (exchange/core.test.ts covers what a "no" does).
    expect(await depsFor(EMP.batch2, EMP.batch2).csa.isAdmitted(EMP.batch2)).toBe(false)
    expect((await chief.rpc('remove_access_member', { p_emp_id: EMP.batch2 })).error?.code).toBe('P0002')
  })
})

describe('至少留一位稽核管理者與一位系統維護員', () => {
  /**
   * In one transaction that is rolled back: everyone else with `role` on the list is demoted (the shared test database
   * may have several), so `last` is the last one; then `attempt` runs as `who` (a signed-in 工號, service_role or the
   * superuser). Returns the SQLSTATE it failed with and its hint, if any, or null.
   */
  async function asLast(
    role: 'audit_admin' | 'system_maintainer',
    last: string,
    who: string,
    attempt: string,
    params: unknown[] = [],
  ): Promise<string | null> {
    return withSuperuser(async (sql) => {
      await sql.query('begin')
      try {
        await sql.query(
          `update public.employee_ref set audit_role = 'signer'
            where audit_role = $2 and emp_id <> $1 and emp_id in (select emp_id from public.access_allowlist)`,
          [last, role],
        )
        if (who === 'service_role') {
          await sql.query('set local role service_role')
        } else if (who !== 'superuser') {
          await sql.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'authenticated', app_metadata: { emp_id: who } })])
          await sql.query('set local role authenticated')
        }
        await sql.query(attempt, params)
        return null
      } catch (e) {
        const { code, hint } = e as { code?: string; hint?: string }
        return [code ?? 'unknown', hint].filter(Boolean).join(' ')
      } finally {
        await sql.query('rollback')
      }
    })
  }
  const lastAdmin = (who: string, attempt: string, params: unknown[] = []) => asLast('audit_admin', EMP.chief, who, attempt, params)
  const lastMaint = (who: string, attempt: string, params: unknown[] = []) => asLast('system_maintainer', EMP.maint, who, attempt, params)

  it('the last 稽核管理者 cannot be demoted or removed, even by a 系統維護員', async () => {
    expect(await lastAdmin(EMP.maint, `select public.update_access_member($1, 'signer', '{}', null)`, [EMP.chief])).toBe('23514 last_audit_admin')
    expect(await lastAdmin(EMP.maint, `select public.update_access_member($1, 'system_maintainer', '{}', null)`, [EMP.chief])).toBe('23514 last_audit_admin')
    expect(await lastAdmin(EMP.maint, `select public.remove_access_member($1)`, [EMP.chief])).toBe('23514 last_audit_admin')
    expect(await lastAdmin(EMP.maint, `select public.update_access_member($1, 'audit_admin', '{}', '仍是稽核管理者')`, [EMP.chief])).toBeNull()
  })

  it('the last 系統維護員 can neither demote nor remove themselves', async () => {
    expect(await lastMaint(EMP.maint, `select public.update_access_member($1, 'audit_admin', '{}', null)`, [EMP.maint])).toBe('23514 last_system_maintainer')
    expect(await lastMaint(EMP.maint, `select public.remove_access_member($1)`, [EMP.maint])).toBe('23514 last_system_maintainer')
    expect(await lastMaint(EMP.maint, `select public.update_access_member($1, 'system_maintainer', '{}', '仍是我')`, [EMP.maint])).toBeNull()
  })

  it('nor can service_role or the 部署指令 change the tables directly', async () => {
    const demote = `update public.employee_ref set audit_role = 'viewer' where emp_id = $1`
    const unlist = `delete from public.access_allowlist where emp_id = $1`
    const forget = `delete from public.employee_ref where emp_id = $1`
    for (const who of ['service_role', 'superuser']) {
      for (const [last, check, hint] of [
        [EMP.chief, lastAdmin, 'last_audit_admin'],
        [EMP.maint, lastMaint, 'last_system_maintainer'],
      ] as const) {
        for (const attempt of [demote, unlist, forget]) expect(await check(who, attempt, [last]), `${who}: ${attempt}`).toBe(`23514 ${hint}`)
      }
    }
    // Row triggers guard the rule and write the log, so nothing may skip them or re-key a row.
    expect(await lastAdmin('superuser', 'truncate public.access_allowlist cascade')).toBe('42501')
    expect(await lastAdmin('superuser', `update public.access_allowlist set emp_id = 'X' || emp_id where emp_id = $1`, [EMP.chief])).toBe('42501')
  })

  it('a database with no 系統維護員 on the list still gets its first one, as db:set-role and deploy allow --maintainer do', async () => {
    const listed = await withSuperuser(async (sql) => {
      await sql.query('begin')
      try {
        // Triggers off for a moment (superuser) to clear every 系統維護員 the shared database has; rolled back below.
        await sql.query('set local session_replication_role = replica')
        await sql.query(`update public.employee_ref set audit_role = 'signer' where audit_role = 'system_maintainer'`)
        await sql.query('set local session_replication_role = origin')
        await sql.query(
          `insert into public.employee_ref (emp_id, audit_role) values ($1, 'system_maintainer')
           on conflict (emp_id) do update set audit_role = 'system_maintainer'`,
          [EMP.outsider],
        )
        await sql.query('insert into public.access_allowlist (emp_id) values ($1) on conflict do nothing', [EMP.outsider])
        const { rows } = await sql.query(
          `select e.emp_id from public.employee_ref e join public.access_allowlist a using (emp_id) where e.audit_role = 'system_maintainer'`,
        )
        return rows.map((r) => r.emp_id)
      } finally {
        await sql.query('rollback')
      }
    })
    expect(listed).toEqual([EMP.outsider])
  })

  it('with another one on the list, one may step down', async () => {
    const maint = await loginAs(EMP.maint, '維')
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.batch1, p_role: 'system_maintainer', p_viewer_plant_ids: [], p_note: null }))
    const second = await loginAs(EMP.batch1, EMP.batch1)
    ok(await second.rpc('update_access_member', { p_emp_id: EMP.batch1, p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
    expect(ok(await maint.from('access_member').select('audit_role').eq('emp_id', EMP.batch1).single())).toEqual({ audit_role: 'signer' })
  })
})


describe('權限異動紀錄', () => {
  interface LogRow {
    actor_emp_id: string | null
    actor_name: string | null
    target_emp_id: string
    target_name: string | null
    action: string
    before: unknown
    after: unknown
  }
  const COLUMNS = 'actor_emp_id,actor_name,target_emp_id,target_name,action,before,after'
  async function logOf(target: string): Promise<LogRow[]> {
    const chief = await loginAs(EMP.chief, '甲')
    return ok(await chief.from('access_change_log').select(COLUMNS).eq('target_emp_id', target).order('id')) as LogRow[]
  }

  it('records 加入, each changed field and 移除 made on the page, with who did it', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    ok(await chief.rpc('add_access_members', { p_people: [person(EMP.logged, '丁')], p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: '廠長' }))
    ok(await chief.rpc('update_access_member', { p_emp_id: EMP.logged, p_role: 'signer', p_viewer_plant_ids: [], p_note: '廠長' }))
    ok(await chief.rpc('update_access_member', { p_emp_id: EMP.logged, p_role: 'signer', p_viewer_plant_ids: [], p_note: '已調職' }))
    ok(await chief.rpc('remove_access_member', { p_emp_id: EMP.logged }))

    const by = { actor_emp_id: EMP.chief, actor_name: '甲', target_emp_id: EMP.logged, target_name: '丁' }
    expect(await logOf(EMP.logged)).toEqual([
      { ...by, action: 'added', before: null, after: { role: 'viewer', viewer_plants: [FACTORY_1], note: '廠長' } },
      { ...by, action: 'role', before: 'viewer', after: 'signer' },
      { ...by, action: 'viewer_plants', before: [FACTORY_1], after: [] },
      { ...by, action: 'note', before: '廠長', after: '已調職' },
      { ...by, action: 'removed', before: { role: 'signer', viewer_plants: [], note: '已調職' }, after: null },
    ])
  })

  it('records what the 部署指令 and db:set-role do, with no operator, but not a login refreshing name and 廠區', async () => {
    await withSuperuser(async (sql) => {
      await sql.query('insert into public.access_allowlist (emp_id, note) values ($1, $2)', [EMP.byCommand, 'demo'])
      await sql.query(`insert into public.employee_ref (emp_id, audit_role) values ($1, 'audit_admin')`, [EMP.byCommand])
    })
    await loginAs(EMP.byCommand, '戊')
    await loginAs(EMP.byCommand, '戊（改名）')

    const byCommand = { actor_emp_id: null, actor_name: null, target_emp_id: EMP.byCommand }
    expect(await logOf(EMP.byCommand)).toEqual([
      { ...byCommand, target_name: null, action: 'added', before: null, after: { role: 'signer', viewer_plants: [], note: 'demo' } },
      { ...byCommand, target_name: null, action: 'role', before: 'signer', after: 'audit_admin' },
    ])
  })

  it('records every role change a 系統維護員 makes, and both 稽核管理者 and 系統維護員 read it', async () => {
    const roles = (rows: LogRow[]) => rows.filter((r) => r.action === 'role').map((r) => [r.actor_emp_id, r.before, r.after])
    // From 稽核管理者只管一般使用者與檢視者: the 系統維護員 moved 升 through every role.
    const expected = [
      [EMP.maint, 'system_maintainer', 'audit_staff'],
      [EMP.maint, 'audit_staff', 'viewer'],
      [EMP.maint, 'viewer', 'system_maintainer'],
      [EMP.maint, 'system_maintainer', 'signer'],
    ]
    expect(roles(await logOf(EMP.promoted)).slice(-4)).toEqual(expected)
    const maint = await loginAs(EMP.maint, '維')
    const seen = ok(await maint.from('access_change_log').select(COLUMNS).eq('target_emp_id', EMP.promoted).order('id')) as LogRow[]
    expect(roles(seen).slice(-4)).toEqual(expected)
  })

  it('cannot be changed or deleted by anyone, and only a 稽核管理者 or 系統維護員 reads it', async () => {
    for (const attempt of [
      'update public.access_change_log set after = null where target_emp_id = $1',
      'delete from public.access_change_log where target_emp_id = $1',
    ]) {
      const code = await withSuperuser((sql) => sql.query(attempt, [EMP.logged]).then(() => null, (e: { code?: string }) => e.code))
      expect(code, attempt).toBe('42501')
    }
    const truncated = await withSuperuser((sql) => sql.query('truncate public.access_change_log').then(() => null, (e: { code?: string }) => e.code))
    expect(truncated).toBe('42501')
    expect((await logOf(EMP.logged)).length).toBe(5)

    const signer = await loginAs(EMP.outsider, EMP.outsider)
    expect(ok(await signer.from('access_change_log').select('id'))).toEqual([])
    expect((await signer.from('access_change_log').insert({ target_emp_id: EMP.outsider, action: 'added' })).error?.code).toBe('42501')
    expect((await restClient(async () => null).from('access_change_log').select('id')).error?.code).toBe('42501')
    expect((await admin.from('access_change_log').insert({ target_emp_id: EMP.outsider, action: 'added' })).error?.code).toBe('42501')
  })
})

describe('最後登入', () => {
  it('is empty until the first exchange and moves with every successful one', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    ok(await chief.rpc('add_access_members', { p_people: [person(EMP.lastLogin)], p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
    const lastLogin = async () =>
      (ok(await chief.from('access_member').select('last_login_at').eq('emp_id', EMP.lastLogin).single()) as { last_login_at: string | null }).last_login_at
    expect(await lastLogin()).toBeNull()

    await loginAs(EMP.lastLogin, '己')
    const first = await lastLogin()
    expect(first).not.toBeNull()
    expect(Math.abs(Date.now() - Date.parse(first!))).toBeLessThan(60_000)

    await loginAs(EMP.lastLogin, '己')
    expect(Date.parse((await lastLogin())!)).toBeGreaterThan(Date.parse(first!))
  })
})

describe('檢視者與移除的提醒（發起一個測試年度）', () => {
  /** tests/db/helpers.ts 檔尾的年度區間表：19000 是這支。 */
  const YEAR = 19000 + Math.floor(Math.random() * 1000)
  const FACTORY_2 = `${RUN}P2`
  const UNIT = `${RUN}資材`
  const CODE = `${RUN}t`
  const SIGNER = { checker: `${RUN}J`, manager: `${RUN}K`, viewer: `${RUN}L` }
  /** 自評表 id，依廠區 1／2 */
  const ASSESSMENT: Record<1 | 2, string> = { 1: '', 2: '' }
  let routeId = ''

  beforeAll(async () => {
    for (const [who, name] of [[SIGNER.checker, '乙'], [SIGNER.manager, '丙'], [SIGNER.viewer, '庚']] as const) await loginAs(who, name)
    ID.plant2 = (await insertRow('plant', { factory_code: FACTORY_2, name: `${RUN}二廠`, company_id: ID.company })).id
    ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
    ID.template = await makeTemplate(CODE, 'control_activity', FACTORY_1, [['第一章', [['p1', ID.unit]]]])
    await insertRow('template_plant', { template_id: ID.template, factory_code: FACTORY_2 })
    routeId = await makeRoute(ID.template!, ID.plant1!, [
      { name: '自行檢查人員－資材', group: 'plant', signer: SIGNER.checker, unitId: ID.unit },
      { name: '部門主管－資材', group: 'plant', signer: SIGNER.manager, unitId: null },
      { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
      { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
    ])
    // 檢視者在廠區 2 的流程上是第一關的簽核人：照簽核人的規則看得到、簽得了那一張。
    await makeRoute(ID.template!, ID.plant2!, [
      { name: '自行檢查人員－資材', group: 'plant', signer: SIGNER.viewer, unitId: ID.unit },
      { name: '部門主管－資材', group: 'plant', signer: SIGNER.manager, unitId: null },
      { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
      { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
    ])
    const chief = await loginAs(EMP.chief, '甲')
    const launched = await launchAssigned(chief, {
      p_year: YEAR, p_due_date: '2099-12-31',
      p_combos: [{ template_id: ID.template, plant_id: ID.plant1 }, { template_id: ID.template, plant_id: ID.plant2 }],
    })
    if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
    for (const r of ok(await admin.from('assessment').select('id,plant_id').eq('cycle_id', launched.data.cycle_id)) as { id: string; plant_id: string }[]) {
      ASSESSMENT[r.plant_id === ID.plant1 ? 1 : 2] = r.id
    }
    ok(await chief.rpc('add_access_members', {
      p_people: [person(SIGNER.viewer, '庚')], p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: null,
    }))
  })

  afterAll(async () => {
    await admin.from('annual_cycle').delete().eq('year', YEAR)
    for (const p of [ID.plant1, ID.plant2]) if (p) await admin.from('approval_route').delete().eq('plant_id', p)
    if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
    await admin.from('plant').delete().eq('factory_code', FACTORY_2)
    await admin.from('assessing_unit').delete().eq('name', UNIT)
  })

  it('a 檢視者 reads every 自評表 of the 檢視廠區 (page and PDF), the others only by the 簽核人 rule', async () => {
    const viewer = await loginAs(SIGNER.viewer, '庚')
    const own = await readAssessmentPdfSource(viewer, ASSESSMENT[1])
    expect(own?.assessment.id).toBe(ASSESSMENT[1])
    expect(own?.assessment.assessment_step.map((s) => s.name).sort()).toEqual(['自行檢查人員－資材', '部門主管－資材', '台北稽核人員', '稽核主管'].sort())
    // 廠區 2 不是他的檢視廠區，但他是那一張目前關卡的簽核人。
    expect((await readAssessmentPdfSource(viewer, ASSESSMENT[2]))?.assessment.id).toBe(ASSESSMENT[2])

    const notYet = await loginAs(SIGNER.manager, '丙')
    expect(await readAssessmentPdfSource(notYet, ASSESSMENT[1])).toBeNull()
  })

  it('a 檢視者 reads the answers of the 檢視廠區 before the unit submits, unlike a later 簽核人 (Q116 (9))', async () => {
    const point = ok(await admin.from('assessment_control_point').select('id').eq('assessment_id', ASSESSMENT[1]).single()) as { id: string }
    ok(await (await loginAs(SIGNER.checker, '乙')).rpc('save_assessment_answers', {
      p_assessment_id: ASSESSMENT[1],
      p_answers: [{ control_point_id: point.id, assessing_unit_name: UNIT, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
      p_conclusions: [{ assessing_unit_name: UNIT, conclusion: 'satisfied' }],
    }))
    const units = async (who: string, name: string) => {
      const client = await loginAs(who, name)
      const read = (table: string) => client.from(table).select('assessing_unit_name').eq('assessment_id', ASSESSMENT[1])
      return [ok(await read('assessment_answer')), ok(await read('assessment_conclusion'))].map((rows) => rows?.length)
    }
    expect(await units(SIGNER.viewer, '庚')).toEqual([1, 1])
    expect(await units(SIGNER.manager, '丙')).toEqual([0, 0])
  })

  it('追蹤總覽 shows a 檢視者 only the 檢視廠區, even where they also sign', async () => {
    const viewer = await loginAs(SIGNER.viewer, '庚')
    const rows = ok(await selectTracking(viewer, YEAR))
    expect(rows.map((r) => [r.factory_code, r.current_signer_emp_id, r.current_signer_name])).toEqual([[FACTORY_1, SIGNER.checker, '乙']])
    const signer = await loginAs(SIGNER.checker, '乙')
    expect(ok(await selectTracking(signer, YEAR))).toEqual([])
  })

  it('a 系統維護員 reads every 自評表, answer, 追蹤總覽 row, template and route, and changes them as a 稽核管理者 does (Q129)', async () => {
    const maint = await loginAs(EMP.maint, '維')
    expect((await readAssessmentPdfSource(maint, ASSESSMENT[1]))?.assessment.id).toBe(ASSESSMENT[1])
    expect(ok(await maint.from('assessment').select('id').in('id', [ASSESSMENT[1], ASSESSMENT[2]]))).toHaveLength(2)
    // The 檢視者 test above saved an answer on 廠區 1, before that unit submitted.
    expect(ok(await maint.from('assessment_answer').select('assessing_unit_name').eq('assessment_id', ASSESSMENT[1]))).toHaveLength(1)
    expect(ok(await selectTracking(maint, YEAR)).map((r) => r.factory_code)).toEqual([FACTORY_1, FACTORY_2])
    expect(ok(await maint.from('questionnaire_template').select('id').eq('id', ID.template))).toEqual([{ id: ID.template }])
    expect(ok(await maint.from('approval_route').select('id').eq('id', routeId))).toEqual([{ id: routeId }])

    // The 稽核管理者's writes pass (here renaming the 範本, then back).
    const t = ok(await admin.from('questionnaire_template').select('code,name,status,all_plants,component').eq('id', ID.template).single()) as {
      code: string; name: string; status: string; all_plants: boolean; component: string | null
    }
    const rename = (name: string) => maint.rpc('update_template', {
      p_template_id: ID.template, p_code: t.code, p_name: name, p_status: t.status, p_all_plants: t.all_plants,
      p_factory_codes: [FACTORY_1], p_component: t.component,
    })
    ok(await rename('改名'))
    expect(ok(await admin.from('questionnaire_template').select('name').eq('id', ID.template).single())).toEqual({ name: '改名' })
    ok(await rename(t.name))

    // 換人 too: the 系統維護員 puts themselves on 廠區 1's second 關卡, then hands it back.
    const step = ok(await admin.from('assessment_step').select('id,signer_emp_id').eq('assessment_id', ASSESSMENT[1]).eq('position', 2).single()) as {
      id: string; signer_emp_id: string
    }
    ok(await maint.rpc('assign_step_signer', { p_step_id: step.id, p_emp_id: EMP.maint }))
    expect(ok(await admin.from('assessment_step').select('signer_emp_id').eq('id', step.id).single())).toEqual({ signer_emp_id: EMP.maint })
    ok(await maint.rpc('assign_step_signer', { p_step_id: step.id, p_emp_id: step.signer_emp_id }))

    // Still no signing for someone else: answering stays with the 關卡's own 簽核人, as for a 稽核管理者.
    const point = ok(await admin.from('assessment_control_point').select('id').eq('assessment_id', ASSESSMENT[1]).single()) as { id: string }
    const saved = await maint.rpc('save_assessment_answers', {
      p_assessment_id: ASSESSMENT[1],
      p_answers: [{ control_point_id: point.id, assessing_unit_name: UNIT, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
      p_conclusions: [],
    })
    expect(saved.error?.code).toBe('42501')
  })

  it('a 檢視者 cannot answer, submit, approve or return a 自評表 they only view', async () => {
    const viewer = await loginAs(SIGNER.viewer, '庚')
    const point = ok(await admin.from('assessment_control_point').select('id').eq('assessment_id', ASSESSMENT[1]).single()) as { id: string }
    const saved = await viewer.rpc('save_assessment_answers', {
      p_assessment_id: ASSESSMENT[1],
      p_answers: [{ control_point_id: point.id, assessing_unit_name: UNIT, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
      p_conclusions: [],
    })
    expect(saved.error?.code).toBe('42501')
    expect((await viewer.rpc('submit_assessment_step', { p_assessment_id: ASSESSMENT[1] })).error?.code).toBe('42501')
    expect((await viewer.rpc('approve_assessment_step', { p_assessment_id: ASSESSMENT[1], p_comment: null })).error?.code).toBe('42501')
    expect((await viewer.rpc('return_assessment', { p_assessment_id: ASSESSMENT[1], p_to_position: 1, p_reason: 'x' })).error?.code).toBe('42501')
    expect(ok(await admin.from('assessment').select('current_step_position').eq('id', ASSESSMENT[1]).single())).toEqual({ current_step_position: 1 })
  })

  it('a changed role or 檢視廠區 takes effect on the next request', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    const viewer = await loginAs(SIGNER.viewer, '庚')
    ok(await chief.rpc('update_access_member', { p_emp_id: SIGNER.viewer, p_role: 'viewer', p_viewer_plant_ids: [ID.plant1, ID.plant2], p_note: null }))
    expect(ok(await selectTracking(viewer, YEAR)).map((r) => r.factory_code)).toEqual([FACTORY_1, FACTORY_2])
    ok(await chief.rpc('update_access_member', { p_emp_id: SIGNER.viewer, p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
    expect(await readAssessmentPdfSource(viewer, ASSESSMENT[1])).toBeNull()
    expect(ok(await selectTracking(viewer, YEAR))).toEqual([])
  })

  it('lists, before removing someone, the 關卡 now and later on 自評表 in progress and on every route', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    const impact = async (who: string) => ok(await chief.rpc('access_removal_impact', { p_emp_id: who })) as Record<string, unknown>[]
    const ours = (rows: Record<string, unknown>[]) => rows.filter((r) => r.factory_code === FACTORY_1 || r.factory_code === FACTORY_2)
    // 流程上每一關都存簽核人（廠區端在發出前分派，Q147）。
    ok(await admin.from('route_step').update({ signer_emp_id: SIGNER.checker }).eq('route_id', routeId).eq('name', '稽核主管'))
    // 流程沒有狀態（Q137 (6)）：沒通過發起檢查的流程也列。
    const unready = await makeTemplate(`${CODE}2`, 'control_activity', FACTORY_1, [['第一章', [['p1', ID.unit!]]]])
    const unreadyRoute = await makeRoute(unready, ID.plant1!, [{ name: '子公司擔當稽核', group: 'audit_review', signer: SIGNER.checker, unitId: null }])
    onTestFinished(async () => {
      await admin.from('approval_route').delete().eq('id', unreadyRoute)
      await admin.from('questionnaire_template').delete().eq('id', unready)
    })
    expect(ours(await impact(SIGNER.checker)).map((r) => [r.kind, r.factory_code, r.step_position, r.step_name, r.assessment_id ?? r.route_id])).toEqual([
      ['current', FACTORY_1, 1, '自行檢查人員－資材', ASSESSMENT[1]],
      ['route', FACTORY_1, 1, '自行檢查人員－資材', routeId],
      ['route', FACTORY_1, 4, '稽核主管', routeId],
      ['route', FACTORY_1, 1, '子公司擔當稽核', unreadyRoute],
    ])
    expect(ours(await impact(SIGNER.manager)).map((r) => [r.kind, r.factory_code, r.step_position])).toEqual([
      ['later', FACTORY_1, 2], ['later', FACTORY_2, 2], ['route', FACTORY_1, 2], ['route', FACTORY_2, 2],
    ])
    expect(await impact(`${RUN}NOBODY`)).toEqual([])
  })
})
