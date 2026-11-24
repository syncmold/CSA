// 資料 API 接縫: 首頁「我參與的自評表」（工單 #37）。
// 每次執行建立自己的公司、廠區、自評單位、兩份範本與簽核流程，發起兩個年度作業，結束時全部清掉。
// 同一個檔案裡的測試依序執行：主要那一張（年度 YEAR、範本 a）從第 1 關一路簽、退回、換人到結案。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { selectEveryAssessmentOfMine } from '../../src/api/myAssessmentsQuery'
import { launchAssigned, admin, insertRow, loginAs, makeRoute, makeTemplate, ok, planNodes, promoteToAuditAdmin, requirePostgrest, withSuperuser, type PlanNode } from './helpers'

const RUN = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = {
  checker: `${RUN}B`,
  manager: `${RUN}C`,
  auditor: `${RUN}E`,
  adminSigner: `${RUN}G`,
  chief: `${RUN}F`,
  replacement: `${RUN}H`,
  auditAdmin: `${RUN}A`,
  outsider: `${RUN}D`,
}
const YEAR = 14000 + Math.floor(Math.random() * 999)
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = `${RUN}資材`
const CODE_A = `${RUN}a`
const CODE_B = `${RUN}b`

const ID: Record<string, string> = {}
/** 自評表 id，依「年度/範本」 */
const ASSESSMENT: Record<string, string> = {}
/** 主要那一張：年度 YEAR、範本 a */
let MAIN = ''

const as = (who: string) => loginAs(who, who)

/**
 * 用頁面同一個查詢讀清單（含排序），但不切掉往年已結案的：首頁只留當期（Q124 (1)）看的是全庫最新年度，其他測試檔
 * 並行發起的年度比這裡大，所以首頁的切法在 records.rls.test.ts 測。測試帳號都是這次執行專用的，所以清單裡只會有
 * 這個檔案發出的自評表；給 ids 就只留這幾張。
 */
async function listOf(who: string, ids?: string[]) {
  const rows = ok(await selectEveryAssessmentOfMine(await as(who)))
  return ids ? rows.filter((r) => ids.includes(r.assessment_id)) : rows
}
const idsOf = async (who: string, ids?: string[]) => (await listOf(who, ids)).map((r) => r.assessment_id)
const seesMain = async (who: string) => (await idsOf(who, [MAIN])).length === 1
/** 首頁「我的自評表」用的欄位（Q115）：我的部分、階段、我的填寫進度。 */
async function partOf(who: string) {
  const [row] = await listOf(who, [MAIN])
  return row && { my_part: row.my_part, stage: row.stage, my_answered: row.my_answered, my_question_count: row.my_question_count, my_started: row.my_started }
}

async function launch(year: number) {
  const launched = await launchAssigned(await as(EMP.auditAdmin), {
    p_year: year, p_due_date: `2099-12-31`,
    p_combos: [{ template_id: ID.templateA, plant_id: ID.plant }, { template_id: ID.templateB, plant_id: ID.plant }],
  })
  if (launched.error || !launched.data?.ok) throw new Error(`launch: ${JSON.stringify(launched)}`)
  const rows = ok(await admin.from('assessment').select('id,template_code').eq('cycle_id', launched.data.cycle_id))
  for (const r of rows as { id: string; template_code: string }[]) ASSESSMENT[`${year}/${r.template_code === CODE_A ? 'a' : 'b'}`] = r.id
}

/** 自行檢查人員答完並送出。 */
async function answerAndSubmit(assessmentId: string) {
  const me = await as(EMP.checker)
  const point = ok(await admin.from('assessment_control_point').select('id').eq('assessment_id', assessmentId).single()) as { id: string }
  const saved = await me.rpc('save_assessment_answers', {
    p_assessment_id: assessmentId,
    p_answers: [{ control_point_id: point.id, assessing_unit_name: UNIT, design: 'has_rule', execution: 'yes', satisfaction: 'satisfied', improvement: null }],
    p_conclusions: [{ assessing_unit_name: UNIT, conclusion: 'satisfied' }],
  })
  expect(saved.error).toBeNull()
  expect(ok(await me.rpc('submit_assessment_step', { p_assessment_id: assessmentId }))).toMatchObject({ ok: true })
}

async function approveAs(who: string, assessmentId: string) {
  const result = await (await as(who)).rpc('approve_assessment_step', { p_assessment_id: assessmentId })
  expect(result.error).toBeNull()
  expect(result.data).toMatchObject({ ok: true })
}

beforeAll(async () => {
  await requirePostgrest()
  for (const who of Object.values(EMP)) await as(who)
  await promoteToAuditAdmin(EMP.auditAdmin)
  await promoteToAuditAdmin(EMP.adminSigner)

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id
  ID.unit = (await insertRow('assessing_unit', { name: UNIT })).id
  ID.templateA = await makeTemplate(CODE_A, 'control_activity', FACTORY, [['第一章', [['p1', ID.unit]]]])
  ID.templateB = await makeTemplate(CODE_B, 'control_activity', FACTORY, [['第一章', [['p1', ID.unit]]]])
  // 範本 a 五關：自行檢查人員 → 部門主管 → 子公司擔當稽核 → 台北稽核人員（稽核管理者）→ 稽核主管
  await makeRoute(ID.templateA, ID.plant, [
    { name: '自行檢查人員－資材', group: 'plant', signer: EMP.checker, unitId: ID.unit },
    { name: '部門主管－資材', group: 'plant', signer: EMP.manager, unitId: null },
    { name: '子公司擔當稽核', group: 'audit_review', signer: EMP.auditor, unitId: null },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.adminSigner, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
  ])
  // 範本 b 三關，用來簽到結案排序
  await makeRoute(ID.templateB, ID.plant, [
    { name: '自行檢查人員－資材', group: 'plant', signer: EMP.checker, unitId: ID.unit },
    { name: '台北稽核人員', group: 'audit_review', signer: EMP.chief, unitId: null },
    { name: '稽核主管', group: 'audit_review', signer: EMP.chief, unitId: null },
  ])
  await launch(YEAR)
  await launch(YEAR + 1)
  MAIN = ASSESSMENT[`${YEAR}/a`]!
})

afterAll(async () => {
  await admin.from('annual_cycle').delete().in('year', [YEAR, YEAR + 1])
  await admin.from('approval_route').delete().eq('plant_id', ID.plant)
  for (const t of [ID.templateA, ID.templateB]) if (t) await admin.from('questionnaire_template').delete().eq('id', t)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().eq('name', UNIT)
})

describe('簽到第 N 關', () => {
  it('lists it for the signers of 關卡 1..N and not for the ones whose turn has not come', async () => {
    expect([await seesMain(EMP.checker), await seesMain(EMP.manager), await seesMain(EMP.auditor), await seesMain(EMP.chief)])
      .toEqual([true, false, false, false])
    // 輪到自行檢查人員答題：待填寫，進度只數他這關的自評單位（一題）；截止日 2099 年還很遠
    expect(await partOf(EMP.checker)).toEqual({ my_part: 'fill', stage: 'filling', my_answered: 0, my_question_count: 1, my_started: false })
    expect((await listOf(EMP.checker, [MAIN]))[0]!.due_in_days).toBeGreaterThan(365)
    // 只填了一欄就暫存：還沒有一題算答完，但已經動過（繼續填寫）
    const point = ok(await admin.from('assessment_control_point').select('id').eq('assessment_id', MAIN).single()) as { id: string }
    const saved = await (await as(EMP.checker)).rpc('save_assessment_answers', {
      p_assessment_id: MAIN,
      p_answers: [{ control_point_id: point.id, assessing_unit_name: UNIT, design: null, execution: 'yes', satisfaction: null, improvement: null }],
      p_conclusions: [],
    })
    expect(saved.error).toBeNull()
    expect(await partOf(EMP.checker)).toEqual({ my_part: 'fill', stage: 'filling', my_answered: 0, my_question_count: 1, my_started: true })

    await answerAndSubmit(MAIN)
    expect([await seesMain(EMP.checker), await seesMain(EMP.manager), await seesMain(EMP.auditor), await seesMain(EMP.chief)])
      .toEqual([true, true, false, false])
    // 送出後：答題的人那部分完成、不再數題；部門主管這關只簽核
    expect(await partOf(EMP.checker)).toEqual({ my_part: 'done', stage: 'signing', my_answered: null, my_question_count: null, my_started: null })
    expect(await partOf(EMP.manager)).toEqual({ my_part: 'sign', stage: 'signing', my_answered: null, my_question_count: null, my_started: null })

    await approveAs(EMP.manager, MAIN)
    expect([await seesMain(EMP.checker), await seesMain(EMP.manager), await seesMain(EMP.auditor), await seesMain(EMP.chief)])
      .toEqual([true, true, true, false])
  })
})

describe('不在流程裡的人與稽核管理者', () => {
  it('is empty for someone on no route at all', async () => {
    expect(await listOf(EMP.outsider)).toEqual([])
  })

  it('lists nothing for a 稽核管理者 who is on no route, though they can read every 自評表', async () => {
    const auditAdmin = await as(EMP.auditAdmin)
    expect(ok(await auditAdmin.from('assessment').select('id').eq('id', MAIN))).toHaveLength(1)
    expect(await listOf(EMP.auditAdmin)).toEqual([])
  })

  it('lists a 自評表 for a 稽核管理者 on its route even before their 關卡 comes (Q91)', async () => {
    expect(ok(await admin.from('assessment').select('current_step_position').eq('id', MAIN).single()))
      .toEqual({ current_step_position: 3 })
    expect(await seesMain(EMP.adminSigner)).toBe(true)
    expect((await partOf(EMP.adminSigner))?.my_part).toBe('upcoming')
  })
})

describe('退回', () => {
  it('keeps listing it for signers who signed a later 關卡 and are still on the route', async () => {
    const returned = await (await as(EMP.auditor)).rpc('return_assessment', {
      p_assessment_id: MAIN, p_to_position: 1, p_reason: '請補充說明',
    })
    expect(returned.data).toMatchObject({ ok: true })

    const [row] = await listOf(EMP.manager, [MAIN])
    expect(row).toMatchObject({ status: 'in_progress', current_step_position: 1, current_step_name: '自行檢查人員－資材' })
    expect([await seesMain(EMP.checker), await seesMain(EMP.manager), await seesMain(EMP.auditor), await seesMain(EMP.chief)])
      .toEqual([true, true, true, false])
    // 退回第 1 關：又輪到答題（已答的保留），簽過第 2 關的部門主管變成還沒輪到
    expect(await partOf(EMP.checker)).toEqual({ my_part: 'fill', stage: 'filling', my_answered: 1, my_question_count: 1, my_started: true })
    expect((await partOf(EMP.manager))?.my_part).toBe('upcoming')
  })
})

describe('換人', () => {
  // #13 之前沒有換人函式：以 service_role 直接改關卡的簽核人模擬。#13 完成後改呼叫換人函式。
  it('drops it from the list of the signer who was replaced, even though they signed it', async () => {
    expect(await seesMain(EMP.manager)).toBe(true)
    ok(await admin.from('assessment_step').update({ signer_emp_id: EMP.replacement }).eq('assessment_id', MAIN).eq('position', 2))

    expect(await seesMain(EMP.manager)).toBe(false)
    // 換上來的人還沒輪到、也沒簽過（目前在第 1 關）
    expect(await seesMain(EMP.replacement)).toBe(false)
  })
})

describe('結案', () => {
  it('lists it as 結案 for every signer still on the route, and still not for the replaced one', async () => {
    await answerAndSubmit(MAIN)
    for (const who of [EMP.replacement, EMP.auditor, EMP.adminSigner, EMP.chief]) await approveAs(who, MAIN)

    for (const who of [EMP.checker, EMP.replacement, EMP.auditor, EMP.adminSigner, EMP.chief]) {
      expect(await listOf(who, [MAIN])).toEqual([{
        assessment_id: MAIN, year: YEAR, due_date: '2099-12-31', template_code: CODE_A, template_name: `${CODE_A} 範本`,
        factory_code: FACTORY, plant_name: `${RUN}廠`, status: 'closed', current_step_position: 5, current_step_name: '稽核主管',
        stage: 'closed', due_in_days: expect.any(Number), my_part: 'done', my_answered: null, my_question_count: null, my_started: null,
      }])
    }
    expect(await seesMain(EMP.manager)).toBe(false)
  })
})

describe('排序', () => {
  it('puts 簽核中 before 結案, and the newer 年度 first within each', async () => {
    const closeB = ASSESSMENT[`${YEAR + 1}/b`]!
    await answerAndSubmit(closeB)
    await approveAs(EMP.chief, closeB) // 台北稽核人員
    await approveAs(EMP.chief, closeB) // 稽核主管

    // 簽核中：YEAR+1/a、YEAR/b；結案：YEAR+1/b、YEAR/a（主要那一張）
    expect(await idsOf(EMP.checker)).toEqual([ASSESSMENT[`${YEAR + 1}/a`], ASSESSMENT[`${YEAR}/b`], closeB, MAIN])
  })
})

describe('效能（#44）', () => {
  // 在一個交易裡另發 CYCLES 個年度作業、共 TOTAL 張自評表（各 STEPS 關），其中 MINE 張的第 1 關是 perfSigner；
  // 量完就 rollback，不留資料。以 perfSigner 身分 EXPLAIN ANALYZE 兩個 view，數 RLS 的可見集合實際檢查幾列：
  // 只能落在自己參與的那幾張自評表與它們的關卡上（至多 MINE × (1 + STEPS) 列），不能隨全庫的自評表張數，
  // 也不能隨年度作業、廠區的數目增加（planner 若把它們放在外層逐列重跑，檢查次數會乘上它們的列數）。可見集合本身
  // 每個查詢只算一次（20261115000000），但 view 裡每一列還要算階段、我的關卡與填寫進度，從全庫出發一樣會慢。
  // 範本用這個檔案的兩份，不在交易裡新增：寫範本表會和其他測試檔對範本表的 DDL（template_delete）互鎖。
  const CYCLES = 10
  const TEMPLATES = 2
  const TOTAL = 2000
  const MINE = 6
  const STEPS = 5
  /** 這個檔案的年度區間是 14000–14999（tests/db/helpers.ts）；YEAR、YEAR + 1 已被前面的測試用掉。 */
  const RANGE_END = 14999
  const FIRST_YEAR = YEAR + 1 + CYCLES <= RANGE_END ? YEAR + 2 : YEAR - CYCLES
  const LAST_YEAR = FIRST_YEAR + CYCLES - 1
  const HASHED_CHECK = 'hashed SubPlan'

  /**
   * 計畫裡以可見集合過濾的節點（policy 的 x in (select …) 是 hashed SubPlan）。RLS 的條件出現在 Filter 以外的地方
   * （例如 Join Filter）就數不準，直接失敗，不讓測試默默通過。
   */
  function visibilityNodes(node: PlanNode): PlanNode[] {
    const elsewhere = Object.entries(node)
      .filter(([key, value]) => key !== 'Filter' && key !== 'Plans' && JSON.stringify(value).includes(HASHED_CHECK))
      .map(([key]) => key)
    if (elsewhere.length > 0) throw new Error(`${HASHED_CHECK} in ${elsewhere.join(', ')}: count those checks too`)
    const here = node.Filter?.includes(HASHED_CHECK) ? [node] : []
    return [...here, ...(node.Plans ?? []).flatMap(visibilityNodes)]
  }

  /**
   * 一個節點檢查了幾列：通過的＋被濾掉的，乘上執行次數。EXPLAIN 的列數是每次執行的平均、四捨五入成整數，
   * 所以只是近似；執行次數是精確的，另外限制它不超過 MINE，誤差就有上限（一個節點至多差 MINE 列）。
   */
  const checksOf = (node: PlanNode) => (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops']

  it('checks visibility only on the signer’s own 自評表 and their 關卡, however many there are', async () => {
    const perfSigner = `${RUN}Z`
    await withSuperuser(async (sql) => {
      await sql.query('begin')
      try {
        const inserted = await sql.query<{ id: string }>(
          `with co as (insert into company (name) values ($1 || '效能公司') returning id),
                pl as (insert into plant (factory_code, name, company_id)
                       select upper($1) || 'PF' || g, $1 || '廠' || g, co.id from co, generate_series(1, $3::int) g returning id),
                tp as (select id, code from questionnaire_template where id = any($4::uuid[])),
                cy as (insert into annual_cycle (year, due_date)
                       select y, '2099-12-31' from generate_series($2::int, $5::int) y returning id)
           insert into assessment (cycle_id, plant_id, template_id, template_code, template_name, template_layout)
           select cy.id, pl.id, tp.id, tp.code, '效能範本', 'control_activity'
           from cy, pl, tp
           returning id`,
          [RUN, FIRST_YEAR, TOTAL / CYCLES / TEMPLATES, [ID.templateA, ID.templateB], LAST_YEAR],
        )
        const seeded = inserted.rows.map((r) => r.id)
        // 匯流後一條直線的關卡（沒有分流），每張停在第 1 + rn % STEPS 關、之前的已完成；停在第 3 關之後的結案。
        // 關卡要在結案前建好（結案後不能再改關卡）
        await sql.query(
          `insert into assessment_step (assessment_id, position, name, step_group, signer_emp_id, state)
           select a.id, g, '關卡' || g, 'plant', case when g = 1 and a.rn <= $2 then $3 else $4 || g end,
                  case when a.at > 3 or g < a.at then 'done' when g = a.at then 'current' else 'pending' end::step_state
           from (select id, rn, 1 + (rn % $5::int)::int as at
                 from (select id, row_number() over (order by id) as rn from unnest($1::uuid[]) id) n) a,
                generate_series(1, $5::int) g`,
          [seeded, MINE, perfSigner, `${RUN}S`, STEPS],
        )
        await sql.query(
          `update assessment a set status = 'closed'
           where a.id = any($1::uuid[]) and not exists (select 1 from assessment_step s where s.assessment_id = a.id and s.state <> 'done')`,
          [seeded],
        )
        // 統計值跟著這批資料：表的統計值若還是幾乎空的（例如本機剛跑完端對端測試、autovacuum 剛分析過），planner 會以為
        // 整表掃描比較快，量到的是過時統計值下的計畫。正式資料庫的統計值由 autovacuum 跟著資料量更新。rollback 時一起還原。
        await sql.query('analyze public.assessment, public.assessment_step, public.annual_cycle, public.plant')

        // 第 1 關都看得到；輪到 perfSigner 的是還停在第 1 關、簽核中的那幾張
        const myTurn = Number((await sql.query(
          `select count(*) from assessment a join assessment_step s on s.assessment_id = a.id and s.position = 1
           where a.id = any($1::uuid[]) and s.signer_emp_id = $2 and s.state = 'current' and a.status = 'in_progress'`,
          [seeded, perfSigner],
        )).rows[0].count)

        await sql.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ role: 'authenticated', app_metadata: { emp_id: perfSigner } }),
        ])
        await sql.query('set local role authenticated')
        // 不加條件（首頁的查法），以及加上年度條件：後者給 planner 從年度作業、廠區掃全部自評表的路，也不能走
        for (const [view, expected] of [['my_assessment', MINE], ['my_pending_assessment', myTurn]] as const) {
          for (const where of ['', 'where year between $1 and $2']) {
            const query = `select * from public.${view} ${where}`
            const params = where ? [FIRST_YEAR, LAST_YEAR] : []
            expect((await sql.query(query, params)).rows, query).toHaveLength(expected)
            const explained = await sql.query(`explain (analyze, format json) ${query}`, params)
            const plan = (explained.rows[0]['QUERY PLAN'] as [{ Plan: PlanNode }])[0].Plan
            const nodes = visibilityNodes(plan)
            expect(nodes.length, query).toBeGreaterThan(0)
            expect(Math.max(...planNodes(plan).filter((n) => n['Subplan Name']).map((n) => n['Actual Loops'])), query).toBe(1)
            expect(Math.max(...nodes.map((n) => n['Actual Loops'])), query).toBeLessThanOrEqual(MINE)
            expect(nodes.reduce((sum, n) => sum + checksOf(n), 0), query).toBeLessThanOrEqual(MINE * (1 + STEPS))
          }
        }
      } finally {
        await sql.query('rollback')
      }
    })
  })
})

