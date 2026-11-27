// 資料 API 接縫: 人員管理（工單 #58、Q98；系統維護員 #159、Q122）——放行名單、權限角色、檢視廠區與權限異動紀錄。
// Q153 起沒有檢視者角色：檢視廠區是一般使用者的選填設定，原本用檢視者的測試改成「一般使用者＋檢視廠區」，預期看到的資料相同。
// Q150 起只有系統維護員放行（加入、移除）與設定角色、檢視廠區、備註；稽核主管只指定廠區管理員，名單與異動紀錄唯讀。
// 每次執行用自己的工號（RUN 開頭），結束時移出放行名單；權限異動紀錄只新增、刪不掉，所以留著。
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { readAssessmentPdfSource } from '../../src/api/assessmentPdfQuery'
import { selectAssessmentRecords, selectRecordScope } from '../../src/api/recordsQuery'
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
  /** 一般使用者＋檢視廠區 (Q153)，以及一起加入的稽核人員 */
  plantHead: `${RUN}V`,
  withHead: `${RUN}W`,
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
    const maint = await loginAs(EMP.maint, '維')
    const added = await maint.rpc('add_access_members', {
      p_people: [person(EMP.batch1), person(EMP.chief), { ...person(EMP.batch2), emp_id: ` ${EMP.batch2.toLowerCase()}` }, person(EMP.batch1)],
      p_role: 'signer',
      p_viewer_plant_ids: [],
      p_note: '第二批',
    })
    expect(added.error).toBeNull()
    expect(added.data).toEqual({ added: [EMP.batch1, EMP.batch2], skipped: [EMP.chief] })
    // 稽核主管照樣讀得到名單（Q150：唯讀）。
    const chief = await loginAs(EMP.chief, '甲')
    const members = ok(await chief.from('access_member').select('emp_id,name,factory_code,audit_role,note,added_by_emp_id,added_by_name')
      .in('emp_id', [EMP.batch1, EMP.batch2]).order('emp_id'))
    expect(members).toEqual([EMP.batch1, EMP.batch2].map((id) => ({
      emp_id: id, name: `${id}姓名`, factory_code: 'FQ', audit_role: 'signer', note: '第二批', added_by_emp_id: EMP.maint, added_by_name: '維',
    })))
  })

  it('refuses a 一般使用者 everything (42501), and nobody writes the list or 稽核角色 directly', async () => {
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

describe('只有系統維護員放行與設定角色（Q150，修訂 Q122 (3)）', () => {
  it('a 稽核主管 cannot add, remove, or change anyone’s role, 檢視廠區 or note, whatever the role (42501 maintainer_only)', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    const add = (role: string, viewerPlants: string[] = []) =>
      chief.rpc('add_access_members', { p_people: [person(EMP.outsider)], p_role: role, p_viewer_plant_ids: viewerPlants, p_note: null })
    const update = (empId: string, role: string, note: string | null = null, viewerPlants: string[] = []) =>
      chief.rpc('update_access_member', { p_emp_id: empId, p_role: role, p_viewer_plant_ids: viewerPlants, p_note: note })
    for (const [what, call] of [
      ['add as 一般使用者', add('signer')],
      ['add as 一般使用者 with 檢視廠區', add('signer', [ID.plant1!])],
      ['add as 稽核人員', add('audit_staff')],
      ['add as 稽核管理者', add('audit_admin')],
      ['add as 系統維護員', add('system_maintainer')],
      ['promote a 一般使用者', update(EMP.batch1, 'audit_admin', '第二批')],
      ['make a 一般使用者 a 系統維護員', update(EMP.batch1, 'system_maintainer', '第二批')],
      ['edit a 一般使用者’s note', update(EMP.batch1, 'signer', '改備註')],
      ['clear a 一般使用者’s note', update(EMP.batch1, 'signer', null)],
      ['give a 一般使用者 檢視廠區', update(EMP.batch1, 'signer', '第二批', [ID.plant1!])],
      ['edit a 稽核主管’s note', update(EMP.chief, 'audit_admin', 'x')],
      ['demote a 系統維護員', update(EMP.maint, 'signer')],
      ['demote themselves', update(EMP.chief, 'signer')],
      ['remove a 一般使用者', chief.rpc('remove_access_member', { p_emp_id: EMP.batch1 })],
      ['remove a 稽核主管', chief.rpc('remove_access_member', { p_emp_id: EMP.chief })],
      ['remove a 系統維護員', chief.rpc('remove_access_member', { p_emp_id: EMP.maint })],
    ] as const) {
      const { error } = await call
      expect([error?.code, error?.hint], what).toEqual(['42501', 'maintainer_only'])
    }
    const members = ok(await chief.from('access_member').select('emp_id,audit_role,viewer_plant_ids,note').in('emp_id', [EMP.outsider, EMP.batch1, EMP.newcomer, EMP.maint]).order('emp_id'))
    expect(members).toEqual([
      { emp_id: EMP.newcomer, audit_role: 'audit_staff', viewer_plant_ids: [], note: '新任稽核' },
      { emp_id: EMP.batch1, audit_role: 'signer', viewer_plant_ids: [], note: '第二批' },
      { emp_id: EMP.maint, audit_role: 'system_maintainer', viewer_plant_ids: [], note: null },
    ])
  })

  it('a 稽核主管 still names who runs a plant: in the edit dialog with role, 檢視廠區 and note as they are, and from the plant grid', async () => {
    const maint = await loginAs(EMP.maint, '維')
    // 升 是有檢視廠區的一般使用者（Q153；之前是檢視者，稽核主管不能替他指定廠區管理員）。
    ok(await maint.rpc('add_access_members', { p_people: [person(EMP.promoted, '升')], p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: '廠長' }))
    const chief = await loginAs(EMP.chief, '甲')
    const coordinatorPlants = async () =>
      (ok(await chief.from('access_member').select('coordinator_plant_ids').eq('emp_id', EMP.promoted).single()) as { coordinator_plant_ids: string[] }).coordinator_plant_ids
    // 角色、檢視廠區、備註照原樣送（備註前後空白不算改）：只改負責廠區，不必是系統維護員。
    ok(await chief.rpc('update_access_member', {
      p_emp_id: EMP.promoted, p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: ' 廠長 ', p_coordinator_assign: [ID.plant1], p_coordinator_unassign: [],
    }))
    expect(await coordinatorPlants()).toEqual([ID.plant1])
    ok(await chief.rpc('update_access_member', {
      p_emp_id: EMP.promoted, p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: '廠長', p_coordinator_assign: [], p_coordinator_unassign: [ID.plant1],
    }))
    expect(await coordinatorPlants()).toEqual([])
    // 同一個對話框裡連角色或檢視廠區一起改就擋下（檢視廠區沒照原樣送也算改，Q153），負責廠區也不動。
    for (const [role, viewerPlants] of [['audit_staff', []], ['signer', []]] as const) {
      const refused = await chief.rpc('update_access_member', {
        p_emp_id: EMP.promoted, p_role: role, p_viewer_plant_ids: viewerPlants, p_note: '廠長', p_coordinator_assign: [ID.plant1], p_coordinator_unassign: [],
      })
      expect([refused.error?.code, refused.error?.hint], role).toEqual(['42501', 'maintainer_only'])
      expect(await coordinatorPlants()).toEqual([])
    }
    // 廠區方格的指定、卸任照舊。
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant1, p_emp_id: EMP.promoted }))
    expect(await coordinatorPlants()).toEqual([ID.plant1])
    ok(await chief.rpc('remove_plant_coordinator', { p_plant_id: ID.plant1 }))
    expect(ok(await chief.from('access_member').select('audit_role,viewer_plant_ids,note').eq('emp_id', EMP.promoted).single()))
      .toEqual({ audit_role: 'signer', viewer_plant_ids: [ID.plant1], note: '廠長' })
    // 異動紀錄照樣讀得到（唯讀）。
    const actions = (ok(await chief.from('access_change_log').select('action').eq('target_emp_id', EMP.promoted).order('id')) as { action: string }[]).map((r) => r.action)
    expect(actions).toEqual(['added', 'coordinator_assigned', 'coordinator_removed', 'coordinator_assigned', 'coordinator_removed'])
    ok(await maint.rpc('remove_access_member', { p_emp_id: EMP.promoted }))
  })

  it('a 系統維護員 sets any role, 系統維護員 included, and sees everyone on the list', async () => {
    const maint = await loginAs(EMP.maint, '維')
    ok(await maint.rpc('add_access_members', { p_people: [person(EMP.promoted, '升')], p_role: 'system_maintainer', p_viewer_plant_ids: [], p_note: null }))
    // 稽核主管 is not set here: it hands the role over from the previous holder, which the shared database's other tests lean on
    // (see 換稽核主管 below, rolled back).
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.promoted, p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null }))
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.promoted, p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: null }))
    const seen = ok(await maint.from('access_member').select('emp_id,audit_role').in('emp_id', [EMP.chief, EMP.maint, EMP.promoted]).order('emp_id'))
    expect(seen).toEqual([
      { emp_id: EMP.chief, audit_role: 'audit_admin' },
      { emp_id: EMP.promoted, audit_role: 'signer' },
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
  it('a 系統維護員 sets, edits and removes a 稽核人員; a 稽核主管 no longer does (Q150)', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    const maint = await loginAs(EMP.maint, '維')
    const refused = (r: { error: { code?: string; hint?: string } | null }) => [r.error?.code, r.error?.hint]
    expect(refused(await chief.rpc('add_access_members', { p_people: [person(EMP.staff, '稽')], p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: '稽核室' })))
      .toEqual(['42501', 'maintainer_only'])
    ok(await maint.rpc('add_access_members', { p_people: [person(EMP.staff, '稽')], p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: '稽核室' }))
    expect(refused(await chief.rpc('update_access_member', { p_emp_id: EMP.staff, p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: '改備註' })))
      .toEqual(['42501', 'maintainer_only'])
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.staff, p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: '改備註' }))
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.staff, p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: null }))
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.staff, p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null }))
    expect(ok(await chief.from('access_member').select('audit_role,viewer_plant_ids').eq('emp_id', EMP.staff).single()))
      .toEqual({ audit_role: 'audit_staff', viewer_plant_ids: [] })
    expect(refused(await chief.rpc('remove_access_member', { p_emp_id: EMP.staff }))).toEqual(['42501', 'maintainer_only'])
    ok(await maint.rpc('remove_access_member', { p_emp_id: EMP.staff }))
    ok(await maint.rpc('add_access_members', { p_people: [person(EMP.staff, '稽')], p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null }))
  })

  it('a 稽核人員 manages no one, and sees only what a 一般使用者 does until a plant is his', async () => {
    const staff = await loginAs(EMP.staff, '稽')
    for (const [fn, args] of [
      ['add_access_members', { p_people: [person(EMP.outsider)], p_role: 'signer', p_viewer_plant_ids: [], p_note: null }],
      ['update_access_member', { p_emp_id: EMP.batch1, p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: null }],
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
    const maint = await loginAs(EMP.maint, '維')
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.staff, p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
    expect(ok(await chief.from('access_member').select('audit_role,coordinator_plant_ids').eq('emp_id', EMP.staff).single()))
      .toEqual({ audit_role: 'signer', coordinator_plant_ids: [ID.plant1] })
    ok(await chief.rpc('remove_plant_coordinator', { p_plant_id: ID.plant1 }))
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.staff, p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: null }))
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

describe('修改與移除（系統維護員，Q150）', () => {
  it('changes role, 檢視廠區 and note together; any role but 一般使用者 has no 檢視廠區 (Q153)', async () => {
    const maint = await loginAs(EMP.maint, '維')
    const batch1 = async () => ok(await maint.from('access_member').select('audit_role,viewer_plant_ids,note').eq('emp_id', EMP.batch1).single())
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.batch1, p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: '廠長' }))
    expect(await batch1()).toEqual({ audit_role: 'signer', viewer_plant_ids: [ID.plant1], note: '廠長' })

    // 換成別的角色：就算照樣送檢視廠區也清空。
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.batch1, p_role: 'audit_staff', p_viewer_plant_ids: [ID.plant1], p_note: '' }))
    expect(await batch1()).toEqual({ audit_role: 'audit_staff', viewer_plant_ids: [], note: null })
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.batch1, p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
    expect(await batch1()).toEqual({ audit_role: 'signer', viewer_plant_ids: [], note: null })
  })

  it('only takes 檢視廠區 from the plant master', async () => {
    const maint = await loginAs(EMP.maint, '維')
    const r = await maint.rpc('update_access_member', {
      p_emp_id: EMP.batch1, p_role: 'signer', p_viewer_plant_ids: ['00000000-0000-4000-8000-000000000000'], p_note: null,
    })
    expect(r.error?.code).toBe('23503')
  })

  it('removing takes the person off the list, back to 簽核人 with no 檢視廠區, keeps employee_ref, and the next exchange is refused', async () => {
    const maint = await loginAs(EMP.maint, '維')
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.batch2, p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: null }))
    ok(await maint.rpc('remove_access_member', { p_emp_id: EMP.batch2 }))

    expect(ok(await maint.from('access_member').select('emp_id').eq('emp_id', EMP.batch2))).toEqual([])
    expect(ok(await admin.from('employee_ref').select('audit_role,viewer_plant_ids,name').eq('emp_id', EMP.batch2).single()))
      .toEqual({ audit_role: 'signer', viewer_plant_ids: [], name: `${EMP.batch2}姓名` })
    // The next renewal asks exactly this (exchange/core.test.ts covers what a "no" does).
    expect(await depsFor(EMP.batch2, EMP.batch2).csa.isAdmitted(EMP.batch2)).toBe(false)
    expect((await maint.rpc('remove_access_member', { p_emp_id: EMP.batch2 })).error?.code).toBe('P0002')
  })
})

describe('取消檢視者角色，檢視廠區改成一般使用者的選填設定（Q153）', () => {
  const refusal = (r: { error: { code?: string; hint?: string } | null }) => [r.error?.code, r.error?.hint]
  const memberOf = async (empId: string) =>
    ok(await (await loginAs(EMP.chief, '甲')).from('access_member').select('audit_role,viewer_plant_ids,coordinator_plant_ids').eq('emp_id', empId).maybeSingle())

  it('refuses the 檢視者 role wherever it is set (22023 viewer_retired), and adds nobody', async () => {
    const maint = await loginAs(EMP.maint, '維')
    expect(refusal(await maint.rpc('add_access_members', { p_people: [person(EMP.plantHead, '廠長')], p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: null })))
      .toEqual(['22023', 'viewer_retired'])
    expect(ok(await maint.from('access_member').select('emp_id').eq('emp_id', EMP.plantHead))).toEqual([])
    expect(refusal(await maint.rpc('update_access_member', { p_emp_id: EMP.batch1, p_role: 'viewer', p_viewer_plant_ids: [ID.plant1], p_note: null })))
      .toEqual(['22023', 'viewer_retired'])
    expect(await memberOf(EMP.batch1)).toMatchObject({ audit_role: 'signer', viewer_plant_ids: [] })
    // The 部署指令 and db:set-role write the table directly: refused there too.
    const direct = await withSuperuser((sql) =>
      sql.query(`update public.employee_ref set audit_role = 'viewer' where emp_id = $1`, [EMP.batch1]).then(() => null, (e: { code?: string; hint?: string }) => [e.code, e.hint]))
    expect(direct).toEqual(['22023', 'viewer_retired'])
  })

  it('a 系統維護員 adds a 一般使用者 with 檢視廠區 or without; for any other role the 檢視廠區 sent are dropped', async () => {
    const maint = await loginAs(EMP.maint, '維')
    ok(await maint.rpc('add_access_members', { p_people: [person(EMP.plantHead, '廠長')], p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: '廠長' }))
    expect(await memberOf(EMP.plantHead)).toEqual({ audit_role: 'signer', viewer_plant_ids: [ID.plant1], coordinator_plant_ids: [] })
    ok(await maint.rpc('add_access_members', { p_people: [person(EMP.withHead, '稽二')], p_role: 'audit_staff', p_viewer_plant_ids: [ID.plant1], p_note: null }))
    expect(await memberOf(EMP.withHead)).toEqual({ audit_role: 'audit_staff', viewer_plant_ids: [], coordinator_plant_ids: [] })
    // The same on an edit that keeps the role: a 稽核人員 is not given 檢視廠區.
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.withHead, p_role: 'audit_staff', p_viewer_plant_ids: [ID.plant1], p_note: null }))
    expect(await memberOf(EMP.withHead)).toMatchObject({ audit_role: 'audit_staff', viewer_plant_ids: [] })
    ok(await maint.rpc('remove_access_member', { p_emp_id: EMP.withHead }))
  })

  it('a 稽核主管 cannot give, change or clear a 一般使用者’s 檢視廠區 (42501 maintainer_only); a 系統維護員 can', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    const maint = await loginAs(EMP.maint, '維')
    const set = (by: typeof chief, empId: string, plants: string[], note: string | null) =>
      by.rpc('update_access_member', { p_emp_id: empId, p_role: 'signer', p_viewer_plant_ids: plants, p_note: note })
    // 沒有檢視廠區的人：稽核主管不能替他設。
    expect(refusal(await set(chief, EMP.batch1, [ID.plant1!], null))).toEqual(['42501', 'maintainer_only'])
    expect(await memberOf(EMP.batch1)).toMatchObject({ viewer_plant_ids: [] })
    // 已經有的人：稽核主管不能清掉。
    expect(refusal(await set(chief, EMP.plantHead, [], '廠長'))).toEqual(['42501', 'maintainer_only'])
    expect(await memberOf(EMP.plantHead)).toMatchObject({ viewer_plant_ids: [ID.plant1] })
    // 系統維護員可以清掉、再設回來（選填：留空也行）。
    ok(await set(maint, EMP.plantHead, [], '廠長'))
    expect(await memberOf(EMP.plantHead)).toMatchObject({ audit_role: 'signer', viewer_plant_ids: [] })
    ok(await set(maint, EMP.plantHead, [ID.plant1!], '廠長'))
    expect(await memberOf(EMP.plantHead)).toMatchObject({ audit_role: 'signer', viewer_plant_ids: [ID.plant1] })
  })

  it('a 一般使用者 holds 檢視廠區 and runs a plant at once: a 稽核主管 names him 廠區管理員, the 檢視廠區 untouched', async () => {
    const chief = await loginAs(EMP.chief, '甲')
    // From the plant grid, then from 廠區權限 (role, 檢視廠區 and note sent back as they are).
    ok(await chief.rpc('set_plant_coordinator', { p_plant_id: ID.plant1, p_emp_id: EMP.plantHead }))
    expect(await memberOf(EMP.plantHead)).toEqual({ audit_role: 'signer', viewer_plant_ids: [ID.plant1], coordinator_plant_ids: [ID.plant1] })
    ok(await chief.rpc('update_access_member', {
      p_emp_id: EMP.plantHead, p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: '廠長', p_coordinator_assign: [], p_coordinator_unassign: [ID.plant1],
    }))
    expect(await memberOf(EMP.plantHead)).toEqual({ audit_role: 'signer', viewer_plant_ids: [ID.plant1], coordinator_plant_ids: [] })
    ok(await (await loginAs(EMP.maint, '維')).rpc('remove_access_member', { p_emp_id: EMP.plantHead }))
    expect(await memberOf(EMP.plantHead)).toBeNull()
  })
})

describe('至少留一位稽核管理者與一位系統維護員', () => {
  /**
   * In one transaction that is rolled back: everyone else with `role` on the list is demoted (the shared test database
   * may have several), so `last` is the last one; then `attempt` runs as `who` (a signed-in 工號, service_role or the
   * superuser). Returns the SQLSTATE it failed with and its hint, if any, or null.
   *
   * The other test files add 稽核主管 and 系統維護員 to the list while this runs (Q150: every one that lets people in is
   * a 系統維護員), and one committed between the demotion and the attempt would be another holder. So the transaction
   * first holds both tables against writes (share mode); it waits only briefly for that, steps aside when it cannot have
   * them (55P03, so it never deadlocks a file mid-write) and tries again.
   */
  async function asLast(
    role: 'audit_admin' | 'system_maintainer',
    last: string,
    who: string,
    attempt: string,
    params: unknown[] = [],
  ): Promise<string | null> {
    for (let tries = 0; ; tries++) {
      const result = await asLastOnce(role, last, who, attempt, params)
      if (result !== 'busy' || tries >= 50) return result
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  async function asLastOnce(
    role: 'audit_admin' | 'system_maintainer',
    last: string,
    who: string,
    attempt: string,
    params: unknown[],
  ): Promise<string | null> {
    return withSuperuser(async (sql) => {
      await sql.query('begin')
      try {
        try {
          await sql.query("set local lock_timeout = '200ms'")
          await sql.query('lock table public.access_allowlist, public.employee_ref in share mode')
          await sql.query('set local lock_timeout = 0')
        } catch (e) {
          if ((e as { code?: string }).code === '55P03') return 'busy'
          throw e
        }
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

  /**
   * truncate takes the whole table, and with cascade plant_coordinator too; the other test files writing 關卡 meanwhile
   * read the 放行名單 after plant_coordinator (Q150's require_listed_signer), so waiting for those locks could deadlock
   * them. It waits only briefly, steps aside when it cannot have them (55P03) and tries again. Returns the SQLSTATE.
   */
  async function truncateRefusal(): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      const code = await withSuperuser(async (sql) => {
        await sql.query('begin')
        try {
          await sql.query("set local lock_timeout = '100ms'")
          await sql.query('truncate public.access_allowlist cascade')
          return null
        } catch (e) {
          return (e as { code?: string }).code ?? 'unknown'
        } finally {
          await sql.query('rollback')
        }
      })
      if (code !== '55P03' || attempt >= 50) return code
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('nor can service_role or the 部署指令 change the tables directly', async () => {
    const demote = `update public.employee_ref set audit_role = 'signer' where emp_id = $1`
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
    expect(await truncateRefusal()).toBe('42501')
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
    const maint = await loginAs(EMP.maint, '維')
    ok(await maint.rpc('add_access_members', { p_people: [person(EMP.logged, '丁')], p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: '廠長' }))
    // 換成稽核人員：角色一筆，檢視廠區跟著清空也一筆（Q153）。
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.logged, p_role: 'audit_staff', p_viewer_plant_ids: [], p_note: '廠長' }))
    ok(await maint.rpc('update_access_member', { p_emp_id: EMP.logged, p_role: 'signer', p_viewer_plant_ids: [], p_note: '已調職' }))
    ok(await maint.rpc('remove_access_member', { p_emp_id: EMP.logged }))

    const by = { actor_emp_id: EMP.maint, actor_name: '維', target_emp_id: EMP.logged, target_name: '丁' }
    expect(await logOf(EMP.logged)).toEqual([
      { ...by, action: 'added', before: null, after: { role: 'signer', viewer_plants: [FACTORY_1], note: '廠長' } },
      { ...by, action: 'role', before: 'signer', after: 'audit_staff' },
      { ...by, action: 'viewer_plants', before: [FACTORY_1], after: [] },
      { ...by, action: 'role', before: 'audit_staff', after: 'signer' },
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
    // From 只有系統維護員放行與設定角色: the 系統維護員 moved 升 through the roles.
    const expected = [
      [EMP.maint, 'system_maintainer', 'audit_staff'],
      [EMP.maint, 'audit_staff', 'signer'],
      [EMP.maint, 'signer', 'system_maintainer'],
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
    expect((await logOf(EMP.logged)).length).toBe(6)

    const signer = await loginAs(EMP.outsider, EMP.outsider)
    expect(ok(await signer.from('access_change_log').select('id'))).toEqual([])
    expect((await signer.from('access_change_log').insert({ target_emp_id: EMP.outsider, action: 'added' })).error?.code).toBe('42501')
    expect((await restClient(async () => null).from('access_change_log').select('id')).error?.code).toBe('42501')
    expect((await admin.from('access_change_log').insert({ target_emp_id: EMP.outsider, action: 'added' })).error?.code).toBe('42501')
  })

  it('is 人員異動 only: 分派 rows written before Q149 stay in the table but nobody reads them', async () => {
    const shown = (await logOf(EMP.logged)).length
    await withSuperuser((sql) => sql.query(
      `insert into public.access_change_log (target_emp_id, action, after) values ($1, 'step_assigned', '{}'), ($1, 'route_step_reassigned', '{}')`,
      [EMP.logged],
    ))
    expect((await logOf(EMP.logged)).length).toBe(shown)
    const kept = await withSuperuser(async (sql) => (await sql.query(
      `select count(*)::int as n from public.access_change_log where target_emp_id = $1 and action in ('step_assigned', 'route_step_reassigned')`,
      [EMP.logged],
    )).rows[0].n)
    expect(kept).toBeGreaterThanOrEqual(2)
  })
})

describe('最後登入', () => {
  it('is empty until the first exchange and moves with every successful one', async () => {
    ok(await (await loginAs(EMP.maint, '維')).rpc('add_access_members', { p_people: [person(EMP.lastLogin)], p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
    const chief = await loginAs(EMP.chief, '甲')
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

describe('檢視廠區與移除的提醒（發起一個測試年度）', () => {
  /** tests/db/helpers.ts 檔尾的年度區間表：19000 是這支。 */
  const YEAR = 19000 + Math.floor(Math.random() * 1000)
  const FACTORY_2 = `${RUN}P2`
  const UNIT = `${RUN}資材`
  const CODE = `${RUN}t`
  /** viewer：有檢視廠區（廠區 1）的一般使用者（Q153；之前是檢視者）。 */
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
    // 有檢視廠區的人在廠區 2 的流程上是第一關的簽核人：照簽核人的規則看得到、簽得了那一張。
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
    // 流程上的人排進關卡前就在放行名單上（makeRoute，Q150），系統維護員替他設檢視廠區（角色照舊是一般使用者，Q153）。
    ok(await (await loginAs(EMP.maint, '維')).rpc('update_access_member', {
      p_emp_id: SIGNER.viewer, p_role: 'signer', p_viewer_plant_ids: [ID.plant1], p_note: null,
    }))
  })

  afterAll(async () => {
    await admin.from('annual_cycle').delete().eq('year', YEAR)
    for (const p of [ID.plant1, ID.plant2]) if (p) await admin.from('approval_route').delete().eq('plant_id', p)
    if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
    await admin.from('plant').delete().eq('factory_code', FACTORY_2)
    await admin.from('assessing_unit').delete().eq('name', UNIT)
  })

  it('a 一般使用者 with 檢視廠區 reads every 自評表 of those plants (page and PDF), the others only by the 簽核人 rule', async () => {
    const viewer = await loginAs(SIGNER.viewer, '庚')
    const own = await readAssessmentPdfSource(viewer, ASSESSMENT[1])
    expect(own?.assessment.id).toBe(ASSESSMENT[1])
    expect(own?.assessment.assessment_step.map((s) => s.name).sort()).toEqual(['自行檢查人員－資材', '部門主管－資材', '台北稽核人員', '稽核主管'].sort())
    // 廠區 2 不是他的檢視廠區，但他是那一張目前關卡的簽核人。
    expect((await readAssessmentPdfSource(viewer, ASSESSMENT[2]))?.assessment.id).toBe(ASSESSMENT[2])

    const notYet = await loginAs(SIGNER.manager, '丙')
    expect(await readAssessmentPdfSource(notYet, ASSESSMENT[1])).toBeNull()
    // 沒有檢視廠區的一般使用者只看得到自己關卡的那一張：乙在廠區 1 的流程上，廠區 2 的看不到。
    const checker = await loginAs(SIGNER.checker, '乙')
    expect(ok(await checker.from('assessment').select('id').in('id', [ASSESSMENT[1], ASSESSMENT[2]]))).toEqual([{ id: ASSESSMENT[1] }])
    expect(ok(await viewer.from('assessment').select('id').in('id', [ASSESSMENT[1], ASSESSMENT[2]]))).toHaveLength(2)
  })

  it('歷年自評表 gives a 一般使用者 with 檢視廠區 those plants as their scope, one without it none', async () => {
    const scopeOf = async (who: string, name: string) => ok(await selectRecordScope(await loginAs(who, name)))
    expect(await scopeOf(SIGNER.viewer, '庚')).toEqual({ all_plants: false, plant_ids: [ID.plant1] })
    expect(await scopeOf(SIGNER.checker, '乙')).toEqual({ all_plants: false, plant_ids: [] })
    const mine = async (who: string, name: string) =>
      (ok(await selectAssessmentRecords(await loginAs(who, name))) as { assessment_id: string }[]).map((r) => r.assessment_id).filter((id) => id === ASSESSMENT[1] || id === ASSESSMENT[2]).sort()
    expect(await mine(SIGNER.viewer, '庚')).toEqual([ASSESSMENT[1], ASSESSMENT[2]].sort())
    expect(await mine(SIGNER.checker, '乙')).toEqual([ASSESSMENT[1]])
  })

  it('a 一般使用者 with 檢視廠區 reads the answers of those plants before the unit submits, unlike a later 簽核人 (Q116 (9))', async () => {
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

  it('進度追蹤 shows a 一般使用者 with 檢視廠區 only those plants, even where they also sign; one without it none', async () => {
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
    // The 檢視廠區 test above saved an answer on 廠區 1, before that unit submitted.
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

  it('檢視廠區 let no one answer, submit, approve or return a 自評表 they only view', async () => {
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
    const maint = await loginAs(EMP.maint, '維')
    const viewer = await loginAs(SIGNER.viewer, '庚')
    ok(await maint.rpc('update_access_member', { p_emp_id: SIGNER.viewer, p_role: 'signer', p_viewer_plant_ids: [ID.plant1, ID.plant2], p_note: null }))
    expect(ok(await selectTracking(viewer, YEAR)).map((r) => r.factory_code)).toEqual([FACTORY_1, FACTORY_2])
    ok(await maint.rpc('update_access_member', { p_emp_id: SIGNER.viewer, p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
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

  it('refuses to remove someone still on a route or on an unsigned 關卡 of a 自評表 in progress (23514 still_assigned), and removes them once replaced (Q150)', async () => {
    const maint = await loginAs(EMP.maint, '維')
    const chief = await loginAs(EMP.chief, '甲')
    const onRoute = `${RUN}Q`
    const onForm = `${RUN}R`
    ok(await maint.rpc('add_access_members', { p_people: [person(onRoute, '流程上'), person(onForm, '表上')], p_role: 'signer', p_viewer_plant_ids: [], p_note: null }))
    const remove = async (who: string) => {
      const { error } = await maint.rpc('remove_access_member', { p_emp_id: who })
      return error ? [error.code, error.hint] : null
    }

    // 流程上的一關（工號照 OMS 給的小寫存，比對不分大小寫）。
    const routeStep = ok(await admin.from('route_step').select('id').eq('route_id', routeId).eq('name', '部門主管－資材').single()) as { id: string }
    ok(await chief.rpc('assign_route_signer', { p_route_step_id: routeStep.id, p_emp_id: onRoute.toLowerCase() }))
    expect(await remove(onRoute)).toEqual(['23514', 'still_assigned'])
    expect(ok(await chief.rpc('access_removal_impact', { p_emp_id: onRoute }))).toHaveLength(1)
    ok(await chief.rpc('assign_route_signer', { p_route_step_id: routeStep.id, p_emp_id: SIGNER.manager }))

    // 簽核中自評表還沒簽的一關（直接寫，不連帶寫回流程）。
    const formStep = ok(await admin.from('assessment_step').select('id').eq('assessment_id', ASSESSMENT[2]).eq('position', 2).single()) as { id: string }
    ok(await admin.from('assessment_step').update({ signer_emp_id: onForm }).eq('id', formStep.id))
    expect(await remove(onForm)).toEqual(['23514', 'still_assigned'])
    ok(await admin.from('assessment_step').update({ signer_emp_id: SIGNER.manager }).eq('id', formStep.id))

    // 換掉之後就能移除；一個 稽核主管 照樣不能移（maintainer_only 先擋）。
    expect(await remove(onRoute)).toBeNull()
    const byChief = await chief.rpc('remove_access_member', { p_emp_id: onForm })
    expect([byChief.error?.code, byChief.error?.hint]).toEqual(['42501', 'maintainer_only'])
    expect(await remove(onForm)).toBeNull()
    expect(ok(await maint.from('access_member').select('emp_id').in('emp_id', [onRoute, onForm]))).toEqual([])
  })
})

describe('選人時問誰在放行名單上（listed_emp_ids，Q150）', () => {
  const listed = async (client: ReturnType<typeof restClient>, ids: string[]) => {
    const { data, error } = await client.rpc('listed_emp_ids', { p_emp_ids: ids })
    if (error) return error.code
    return (data as string[]).sort()
  }
  const asked = () => [EMP.chief.toLowerCase(), ` ${EMP.maint} `, EMP.outsider, `${RUN}NOBODY`, '']

  it('answers, in upper case, only the 工號 asked that are on the list, to whoever may look people up', async () => {
    expect(await listed(await loginAs(EMP.chief, '甲'), asked())).toEqual([EMP.chief, EMP.maint].sort())
    expect(await listed(await loginAs(EMP.maint, '維'), asked())).toEqual([EMP.chief, EMP.maint].sort())
    expect(await listed(await loginAs(EMP.maint, '維'), [])).toEqual([])
  })

  it('answers nothing to someone with no people_lookup_limit, and refuses anyone not signed in', async () => {
    const signer = await loginAs(EMP.outsider, EMP.outsider)
    expect((await signer.rpc('people_lookup_limit')).data).toBe(0)
    expect(await listed(signer, asked())).toEqual([])
    expect(await listed(restClient(async () => null), asked())).toBe('42501')
  })
})

describe('上線時補進放行名單（migration 20261220000000，Q150）', () => {
  it('adds everyone on a route and on an in-progress 自評表, in capitals, with the note and one 加入 each by no operator; not those only on closed forms, nor touching those already listed', async ({ skip }) => {
    const temp = await migratedDb('csa_q150_backfill', { before: '20261220000000' })
    if (!temp) return skip()
    const { db } = temp
    try {
      const id = async (sql: string, params: unknown[] = []): Promise<string> => (await db.query(`${sql} returning id`, params)).rows[0].id
      // 範本、流程、自評表直接寫入（關掉觸發器與外鍵），只在這個暫時的資料庫；放行名單照常寫，才有異動紀錄。
      await db.query(`insert into public.access_allowlist (emp_id, note) values ('LISTED1', '原本的備註')`)
      await db.query('set session_replication_role = replica')
      const plant = await id(`insert into public.plant (factory_code, name, company_id) values ('P1', '一廠', gen_random_uuid())`)
      const template = await id(`insert into public.questionnaire_template (code, name, layout, component) values ('T-01', '範本', 'control_activity', 'control_activities')`)
      const route = await id(`insert into public.approval_route (template_id, plant_id) values ($1, $2)`, [template, plant])
      await db.query(
        `insert into public.route_step (route_id, position, name, step_group, signer_emp_id) values
           ($1, 1, '自行檢查人員', 'plant', 'route1'), ($1, 2, '部門主管', 'plant', 'LISTED1'), ($1, 3, '廠區經理人', 'plant', null)`,
        [route],
      )
      const cycle = await id(`insert into public.annual_cycle (year, due_date) values (2025, '2099-12-31')`)
      for (const [status, signer] of [['in_progress', 'FORM1'], ['closed', 'CLOSED1']] as const) {
        const form = await id(
          `insert into public.assessment (cycle_id, plant_id, template_id, template_code, template_name, template_layout, status)
           values ($1, $2, gen_random_uuid(), 'T-01', '範本', 'control_activity', $3)`,
          [cycle, plant, status],
        )
        await db.query(`insert into public.assessment_step (assessment_id, position, name, step_group, signer_emp_id) values ($1, 1, '自行檢查人員', 'plant', $2)`, [form, signer])
      }
      await db.query('set session_replication_role = origin')

      await temp.migrateRest()

      const listed = (await db.query(`select emp_id, note from public.access_allowlist order by emp_id`)).rows
      expect(listed).toEqual([
        { emp_id: 'FORM1', note: '分派帶入（Q150 上線時已在流程上）' },
        { emp_id: 'LISTED1', note: '原本的備註' },
        { emp_id: 'ROUTE1', note: '分派帶入（Q150 上線時已在流程上）' },
      ])
      const logged = (await db.query(`select target_emp_id, actor_emp_id from public.access_change_log where action = 'added' and target_emp_id <> 'LISTED1' order by 1`)).rows
      expect(logged).toEqual([{ target_emp_id: 'FORM1', actor_emp_id: null }, { target_emp_id: 'ROUTE1', actor_emp_id: null }])
    } finally {
      await temp.drop()
    }
  })
})
