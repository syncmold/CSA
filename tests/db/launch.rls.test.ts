// 資料 API 接縫: 年度發起畫面（工單 #12；同一年度補發 #115、Q119）。發起畫面的組合清單 `launch_candidates` 與發起 `launch_annual_cycle`，
// 都以稽核管理者的 CSA session 走 PostgREST；service_role 只用來準備與清理。
// 每次執行建立自己的公司、兩個廠區、兩份範本（只適用這兩個廠區）與自評單位，結束時全部清掉。
// 兩份範本都適用兩個廠區，所以「不給組合＝全部」會帶到別的測試檔與種子的資料；斷言只看自己建的組合，
// 整批發起則一律指定組合。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LaunchCandidate } from '../../src/api/launch'
import { launchAssigned, admin, beginAs, directDb, insertRow, listPeople, loginAs, makeRoute, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest, stillWaiting, unlistPeople } from './helpers'

const RUN = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A`, first: `${RUN}B`, manager: `${RUN}C`, outsider: `${RUN}D` }
const YEAR = 12000 + Math.floor(Math.random() * 990) // 會用到 YEAR … YEAR + 9
const DUE = '2099-12-31'
const FACTORY = { ready: `${RUN}P`.toUpperCase(), bare: `${RUN}Q`.toUpperCase() }
const UNIT = { a: `${RUN}甲單位`, b: `${RUN}乙單位` }
const CODE = { full: `${RUN}x`, partial: `${RUN}y` }

const ID: Record<string, string> = {}
let boss: SupabaseClient

/** 這次自己建的組合，`範本編號@廠區代碼` → 那一列。 */
async function ownCandidates(client: SupabaseClient) {
  const rows = ok(await client.rpc('launch_candidates')) as LaunchCandidate[]
  const own = rows.filter((r) => r.template_code === CODE.full || r.template_code === CODE.partial)
  return Object.fromEntries(own.map((r) => [`${r.template_code}@${r.factory_code}`, r]))
}

const combo = (template: string, plant: string) => ({ template_id: ID[template]!, plant_id: ID[plant]! })

beforeAll(async () => {
  await requirePostgrest()
  for (const [who, name] of [[EMP.boss, '丙'], [EMP.first, '甲'], [EMP.manager, '乙'], [EMP.outsider, '丁']] as const) {
    await loginAs(who, name)
  }
  await promoteToAuditAdmin(EMP.boss)
  boss = await loginAs(EMP.boss, '丙')

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.ready = (await insertRow('plant', { factory_code: FACTORY.ready, name: `${RUN}廠`, company_id: ID.company })).id
  ID.bare = (await insertRow('plant', { factory_code: FACTORY.bare, name: `${RUN}空廠`, company_id: ID.company })).id
  for (const [key, name] of Object.entries(UNIT)) ID[key] = (await insertRow('assessing_unit', { name })).id

  // 兩份範本都用甲、乙兩個單位，都適用兩個廠區
  const sections = (): [string, [string, string][]][] => [['第一章', [['要點一', ID.a!], ['要點二', ID.b!]]]]
  ID.full = await makeTemplate(CODE.full, 'control_activity', FACTORY.ready, sections())
  ID.partial = await makeTemplate(CODE.partial, 'control_activity', FACTORY.ready, sections())
  for (const t of [ID.full, ID.partial]) await insertRow('template_plant', { template_id: t, factory_code: FACTORY.bare })

  // full × ready：通過發起檢查；partial × ready：有流程但沒有關卡涵蓋乙單位；bare 廠區沒有任何流程
  ID.fullRoute = await makeRoute(ID.full, ID.ready, [
    { name: '自行檢查人員－甲單位', group: 'plant', signer: EMP.first, unitId: ID.a! },
    { name: '自行檢查人員－乙單位', group: 'plant', signer: EMP.first, unitId: ID.b! },
    { name: '部門主管', group: 'plant', signer: EMP.manager, unitId: null },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.boss, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.boss, unitId: null },
  ])
  ID.partialRoute = await makeRoute(ID.partial, ID.ready, [
    { name: '自行檢查人員－甲單位', group: 'plant', signer: EMP.first, unitId: ID.a! },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.boss, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.boss, unitId: null },
  ])

  // 廠區要有廠區負責人才能發起
  await listPeople(EMP.manager) // 也許已經因為排在流程上而在名單上（makeRoute，Q150）
  await insertRow('plant_coordinator', { plant_id: ID.ready, emp_id: EMP.manager.toUpperCase() })
})

afterAll(async () => {
  await admin.from('plant_coordinator').delete().eq('plant_id', ID.ready)
  await unlistPeople(RUN)
  await admin.from('annual_cycle').delete().gte('year', YEAR).lte('year', YEAR + 9)
  await admin.from('approval_route').delete().in('plant_id', [ID.ready, ID.bare].filter(Boolean))
  await admin.from('questionnaire_template').delete().in('code', Object.values(CODE))
  await admin.from('plant').delete().in('factory_code', Object.values(FACTORY))
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().in('name', Object.values(UNIT))
})

describe('發起畫面的組合清單 launch_candidates', () => {
  it('lists every 啟用範本 × 適用廠區 with whether its route can be launched', async () => {
    const own = await ownCandidates(boss)
    expect(Object.keys(own).sort()).toEqual(
      [`${CODE.full}@${FACTORY.bare}`, `${CODE.full}@${FACTORY.ready}`, `${CODE.partial}@${FACTORY.bare}`, `${CODE.partial}@${FACTORY.ready}`].sort(),
    )
    expect(own[`${CODE.full}@${FACTORY.ready}`]).toMatchObject({
      template_id: ID.full, template_name: `${CODE.full} 範本`,
      plant_id: ID.ready, plant_name: `${RUN}廠`, route_id: ID.fullRoute, step_count: 5, problem: null, launched_years: [],
    })
    expect(own[`${CODE.full}@${FACTORY.ready}`]).not.toHaveProperty('template_version') // 範本沒有版本（Q137 (4)）
    expect(own[`${CODE.full}@${FACTORY.bare}`]).toMatchObject({ route_id: null, step_count: 0, problem: 'no_route', launch_check: null })
    expect(own[`${CODE.partial}@${FACTORY.ready}`]).toMatchObject({
      problem: 'not_ready',
      launch_check: { ready: false, missing_units: [{ name: UNIT.b }] },
    })
  })

  it('shows nothing to someone who is not a 稽核管理者', async () => {
    const outsider = await loginAs(EMP.outsider, '丁')
    expect(await ownCandidates(outsider)).toEqual({})
  })
})

describe('發起 launch_annual_cycle', () => {
  it('refuses the whole launch, listing combinations without a route or whose route fails the 發起檢查', async () => {
    const result = ok(await launchAssigned(boss, {
      p_year: YEAR,
      p_due_date: DUE,
      p_combos: [combo('full', 'ready'), combo('partial', 'ready'), combo('full', 'bare')],
    }))
    expect(result).toEqual({
      ok: false,
      error: 'missing_route',
      missing: [
        expect.objectContaining({ template_code: CODE.full, factory_code: FACTORY.bare, problem: 'no_route' }),
        expect.objectContaining({
          template_code: CODE.partial, factory_code: FACTORY.ready, problem: 'not_ready',
          launch_check: expect.objectContaining({ missing_units: [expect.objectContaining({ name: UNIT.b })] }),
        }),
      ],
    })
    expect(ok(await admin.from('annual_cycle').select('id').eq('year', YEAR))).toEqual([]) // 整批拒絕＝什麼都沒建
  })

  it('issues 自評表 only for the checked combinations, and the 第 1 關 signer finds it under 我的待簽', async () => {
    // 缺流程與不通過的組合都取消勾選，只發 full × ready
    const result = ok(await launchAssigned(boss, { p_year: YEAR, p_due_date: DUE, p_combos: [combo('full', 'ready')] }))
    expect(result).toMatchObject({ ok: true, cycle_id: expect.any(String), assessments: 1 })
    const cycleId = (result as { cycle_id: string }).cycle_id
    const issued = ok(await admin.from('assessment').select('id,template_id,plant_id').eq('cycle_id', cycleId))
    expect(issued).toEqual([{ id: expect.any(String), template_id: ID.full, plant_id: ID.ready }])

    const pending = async (who: string, name: string) =>
      ok(await (await loginAs(who, name)).from('my_pending_assessment').select('assessment_id,step_position,year').eq('year', YEAR))
    expect(await pending(EMP.first, '甲')).toEqual([{ assessment_id: issued[0]!.id, step_position: 1, year: YEAR }])
    expect(await pending(EMP.manager, '乙')).toEqual([]) // 還沒輪到

    // 發起畫面列出已發起的年度與張數（與 src/api/launch.ts 的 fetchLaunchedCycles 同一個 select）
    expect(ok(await boss.from('annual_cycle').select('year,due_date,assessment(count)').eq('year', YEAR))).toEqual([
      { year: YEAR, due_date: DUE, assessment: [{ count: 1 }] },
    ])
  })

  it('marks the launched combination with its year, and refuses to launch it again that year', async () => {
    expect((await ownCandidates(boss))[`${CODE.full}@${FACTORY.ready}`]).toMatchObject({ launched_years: [YEAR] })
    expect((await ownCandidates(boss))[`${CODE.partial}@${FACTORY.ready}`]).toMatchObject({ launched_years: [] })

    // 已發過的組合混在別的組合裡也整批拒絕，回那些組合
    const again = ok(await launchAssigned(boss, {
      p_year: YEAR, p_due_date: DUE, p_combos: [combo('full', 'ready'), combo('partial', 'ready')],
    }))
    expect(again).toEqual({
      ok: false,
      error: 'already_launched',
      launched: [expect.objectContaining({ template_code: CODE.full, factory_code: FACTORY.ready, launched_years: [YEAR] })],
    })
    expect(ok(await admin.from('assessment').select('id,annual_cycle!inner(year)').eq('annual_cycle.year', YEAR))).toHaveLength(1)
  })

  it('tops up the same year once another route is completed: same 年度作業, its 截止日 kept', async () => {
    // 在第 2 關（稽核主管）之前補上乙單位的自行檢查關卡，流程隨即通過發起檢查
    ok(await boss.rpc('insert_route_step', {
      p_route_id: ID.partialRoute, p_name: '自行檢查人員－乙單位', p_step_group: 'plant',
      p_signer_emp_id: EMP.first, p_editable_unit_id: ID.b, p_before_position: 2,
    }))
    expect((await ownCandidates(boss))[`${CODE.partial}@${FACTORY.ready}`]).toMatchObject({ problem: null })
    const [cycle] = ok(await admin.from('annual_cycle').select('id').eq('year', YEAR)) as { id: string }[]

    // 截止日一年一個：補發時送來的截止日不用
    const result = ok(await launchAssigned(boss, { p_year: YEAR, p_due_date: '2099-01-31', p_combos: [combo('partial', 'ready')] }))
    expect(result).toMatchObject({ ok: true, top_up: true, cycle_id: cycle!.id, due_date: DUE, assessments: 1 })
    expect(ok(await admin.from('annual_cycle').select('id,due_date').eq('year', YEAR))).toEqual([{ id: cycle!.id, due_date: DUE }])
    expect(ok(await boss.from('annual_cycle').select('year,assessment(count)').eq('year', YEAR))).toEqual([
      { year: YEAR, assessment: [{ count: 2 }] },
    ])
  })

  it('takes only the combinations not yet launched that year when none are given (the script)', async () => {
    // 不給組合會帶到別的測試檔與種子的組合，所以只看自己的：兩個可發的組合這年都發過了，
    // 剩下缺流程的整批拒絕，清單裡沒有已發過的組合。
    const result = ok(await launchAssigned(boss, { p_year: YEAR, p_due_date: DUE })) as { error: string; missing?: LaunchCandidate[] }
    expect(result.error).toBe('missing_route')
    const listed = (result.missing ?? []).map((m) => `${m.template_code}@${m.factory_code}`)
    expect(listed).toContain(`${CODE.full}@${FACTORY.bare}`)
    expect(listed).not.toContain(`${CODE.full}@${FACTORY.ready}`)
    expect(listed).not.toContain(`${CODE.partial}@${FACTORY.ready}`)
  })
})

describe('同一年度同時發起兩次', () => {
  /** Launches `first` and, before it commits, `second` in another transaction (combos as 範本×廠區 keys of ID); answers both. */
  async function race(year: number, first: string[], second: string[]): Promise<[unknown, unknown] | null> {
    // 需要同時開兩個交易，PostgREST 做不到，所以直接連 Postgres；沒設 CSA_DB_URL 或 CSA_DB_ADMIN_URL、或連不到時跳過
    const [early, late] = [await directDb(), await directDb()]
    if (!early || !late) return null
    try {
      const launch = (c: import('pg').Client, combos: string[]) =>
        c.query('select public.launch_annual_cycle($1, $2::date, $3::jsonb) as r', [
          year, DUE, JSON.stringify(combos.map((key) => combo(...(key.split('×') as [string, string])))),
        ])
      await beginAs(early, EMP.boss)
      await beginAs(late, EMP.boss)
      const earlyResult = (await launch(early, first)).rows[0].r
      const waiting = launch(late, second)
      expect(await stillWaiting(waiting)).toBe(true) // 同一年度的發起排隊
      await early.query('commit')
      const lateResult = (await waiting).rows[0].r
      await late.query('commit')
      return [earlyResult, lateResult]
    } finally {
      await early.end()
      await late.end()
    }
  }

  it('answers already_launched to the later of two top-ups of the same combination, not an exception', async ({ skip }) => {
    ok(await launchAssigned(boss, { p_year: YEAR + 2, p_due_date: DUE, p_combos: [combo('full', 'ready')] }))
    const results = await race(YEAR + 2, ['partial×ready'], ['partial×ready'])
    if (!results) return skip()
    expect(results[0]).toMatchObject({ ok: true, top_up: true, assessments: 1 })
    expect(results[1]).toEqual({
      ok: false, error: 'already_launched',
      launched: [expect.objectContaining({ template_code: CODE.partial, factory_code: FACTORY.ready })],
    })
    expect(ok(await admin.from('assessment').select('id,annual_cycle!inner(year)').eq('annual_cycle.year', YEAR + 2))).toHaveLength(2)
  })

  it('puts two first launches of a new year with different combinations into the same 年度作業', async ({ skip }) => {
    const results = await race(YEAR + 5, ['full×ready'], ['partial×ready'])
    if (!results) return skip()
    const [early, late] = results as { ok: boolean; top_up: boolean; cycle_id: string }[]
    expect(early).toMatchObject({ ok: true, top_up: false })
    expect(late).toMatchObject({ ok: true, top_up: true, cycle_id: early!.cycle_id })
  })
})

describe('發起與修改流程、範本同時進行', () => {
  /**
   * Launches full × ready for `year` in one transaction and, before it commits, runs `edit` in another;
   * answers whether the edit had to wait for the launch. The edit is rolled back afterwards.
   */
  async function editWaitsForLaunch(year: number, edit: (sql: import('pg').Client) => Promise<unknown>): Promise<boolean | null> {
    const [launching, editing] = [await directDb(), await directDb()]
    if (!launching || !editing) return null
    try {
      await beginAs(launching, EMP.boss)
      await beginAs(editing, EMP.boss)
      const launched = await launching.query('select public.launch_annual_cycle($1, $2::date, $3::jsonb) as r', [
        year, DUE, JSON.stringify([combo('full', 'ready')]),
      ])
      expect(launched.rows[0].r).toMatchObject({ ok: true })
      const pending = edit(editing)
      const waited = await stillWaiting(pending)
      await launching.query('commit')
      await pending
      await editing.query('rollback')
      return waited
    } finally {
      await launching.end()
      await editing.end()
    }
  }

  it('holds edits to the launched routes until the launch commits, so the checked route is the one copied', async ({ skip }) => {
    // 改關卡會更新流程那一列
    const waited = await editWaitsForLaunch(YEAR + 3, (sql) =>
      // 有連動標記的關卡不能改（#189），改其他關卡
      sql.query("update public.route_step set name = name || '（改）' where route_id = $1 and link is null", [ID.fullRoute]),
    )
    if (waited === null) return skip() // 沒設或連不到直接的 Postgres
    expect(waited).toBe(true)
  })

  it('holds edits to the control points of the launched templates until the launch commits (Q89)', async ({ skip }) => {
    // 把控制要點換成流程沒涵蓋的單位：若在檢查與複製之間提交，就會發出沒人能答的自評表。
    // 自評單位在 control_point_unit (#46)，API 只能經 update_control_point 寫它，而那會先在 control_point 那一列等；
    // 這裡改用資料庫擁有者直接改單位表，驗的是單位表自己的鎖範本觸發器。
    const waited = await editWaitsForLaunch(YEAR + 4, async (sql) => {
      await sql.query('reset role')
      return sql.query(
        'update public.control_point_unit set assessing_unit_id = $1 where control_point_id in ' +
          '(select cp.id from public.control_point cp join public.template_section s on s.id = cp.section_id where s.template_id = $2)',
        [ID.a, ID.full],
      )
    })
    if (waited === null) return skip()
    expect(waited).toBe(true)
  })
})
