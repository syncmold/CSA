// 對話寫入（工單 #15，ADR-0006）：Claude 經 csa_drafter 這個資料庫角色呼叫 draft_template／draft_route，把分析後的
// 問卷範本與簽核流程寫進資料庫。暫行做法（Q137 (7) ①）：只寫資料庫還沒有的範本編號（寫成停用，稽核主管在範本管理
// 檢查後啟用）與還沒有流程的範本 × 廠區；已有的擋下，請到範本管理／簽核流程直接修改。
// 途徑以直接連線（和 `npm run drafts:write` 同一個連線方式）測；結果以稽核管理者的 CSA session 走 PostgREST 看，
// service_role 只用來準備與清理。每次執行建立自己的範本編號、廠區與自評單位，結束時全部清掉。
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drafterConnectionString } from '../../scripts/drafts/connection.ts'
import type { LaunchCheck } from '../../src/api/approvalRoutes'
import { admin, insertRow, loginAs, ok, promoteToAuditAdmin, requirePostgrest, withSuperuser, listPeople, unlistPeople } from './helpers'

// 資料庫測試檔案並行執行：前綴與隨機尾巴避免和其他檔案的工號、範本編號撞在一起。
const RUN = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A`, signer: `${RUN}B` }
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = { a: `${RUN}資材單位`, b: `${RUN}品保單位` }

const ID: Record<string, string> = {}
/** 除了還沒分派（Q147），發起檢查都通過。 */
const OTHERWISE_READY = {
  no_steps: false, no_merge_steps: false, missing_units: [], unused_units: [], branch_first_step_not_editable: [], missing_links: [],
  audit_chief_not_last: false, pending_unit_points: 0,
}
let boss: SupabaseClient
let drafter: pg.Client

/** 一份控制活動類範本的定義，形狀和 supabase/drafts/templates/*.json 相同。 */
function templateDef(code: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'template',
    code,
    name: `${code} 測試循環`,
    layout: 'control_activity',
    allPlants: false,
    factoryCodes: [FACTORY],
    sections: [
      { name: '甲作業', controlPoints: [{ text: '一？', assessingUnits: [UNIT.a] }, { text: '二？', assessingUnits: [UNIT.b] }] },
      { name: '乙作業', controlPoints: [{ text: '三？', assessingUnits: [UNIT.a] }] },
    ],
    ...overrides,
  }
}

/** 以 csa_drafter 呼叫寫入函式；資料庫錯誤原樣丟出（帶 code 與 hint）。 */
async function draft(fn: 'draft_template' | 'draft_route', def: object) {
  const { rows } = await drafter.query(`select public.${fn}($1::jsonb) as result`, [JSON.stringify(def)])
  return rows[0].result as { ok: true; template_id?: string; route_id?: string; sections?: number; control_points?: number; steps?: number }
}

/** 稽核管理者在範本管理看到的：抬頭、適用廠區、依序的章節與控制要點（含依序的自評單位名稱）。 */
async function templateAsAdminSees(code: string) {
  const tpl = ok(
    await boss
      .from('questionnaire_template')
      .select('id, code, name, layout, status, all_plants, template_plant(factory_code), template_section(position, name, control_point(position, text, control_point_unit(position, assessing_unit(name))))')
      .eq('code', code)
      .single(),
  ) as {
    id: string; code: string; status: string; name: string; template_plant: { factory_code: string }[]
    template_section: { position: number; name: string; control_point: { position: number; text: string; control_point_unit: { position: number; assessing_unit: { name: string } }[] }[] }[]
  }
  return {
    ...tpl,
    plants: tpl.template_plant.map((p) => p.factory_code),
    sections: tpl.template_section
      .sort((x, y) => x.position - y.position)
      .map((s) => ({
        name: s.name,
        points: s.control_point
          .sort((x, y) => x.position - y.position)
          .map((p) => [p.text, p.control_point_unit.sort((x, y) => x.position - y.position).map((u) => u.assessing_unit.name)]),
      })),
  }
}

/** 流程的關卡名稱，依序。 */
async function stepNames(routeId: string) {
  return (ok(await boss.from('route_step').select('name').eq('route_id', routeId).order('position')) as { name: string }[]).map((s) => s.name)
}

beforeAll(async () => {
  await requirePostgrest()
  // 關卡上的人要先在放行名單上（Q150）
  await listPeople(...Object.values(EMP))
  await loginAs(EMP.boss, '丙')
  await promoteToAuditAdmin(EMP.boss)
  boss = await loginAs(EMP.boss, '丙')

  ID.company = (await insertRow('company', { name: `${RUN}測試公司` })).id
  ID.plant = (await insertRow('plant', { factory_code: FACTORY, name: `${RUN}廠`, company_id: ID.company })).id

  // 和 db:init 一樣讓 csa_drafter 能以 .env 的密碼登入（CI 的 Supabase 堆疊不跑 db:init）。
  const url = new URL(drafterConnectionString(process.env))
  await withSuperuser((sql) =>
    sql.query(`alter role ${sql.escapeIdentifier(url.username)} with login password ${sql.escapeLiteral(decodeURIComponent(url.password))}`),
  )
  drafter = new pg.Client({ connectionString: url.toString() })
  await drafter.connect()
})

afterAll(async () => {
  await unlistPeople(RUN)
  await drafter?.end()
  await admin.from('approval_route').delete().eq('plant_id', ID.plant ?? '')
  // The 組成要素 tests put a letter before RUN (E…, B-…) so the A–D inference has something to read.
  await admin.from('questionnaire_template').delete().like('code', `%${RUN}%`)
  await admin.from('plant').delete().eq('factory_code', FACTORY)
  if (ID.company) await admin.from('company').delete().eq('id', ID.company)
  await admin.from('assessing_unit').delete().like('name', `${RUN}%`)
})

describe('draft_template', () => {
  it('新編號寫成停用的範本，稽核主管在範本管理看得到章節、控制要點與適用廠區', async () => {
    const code = `${RUN}01`
    const result = await draft('draft_template', templateDef(code))
    expect(result).toEqual({ ok: true, template_id: expect.any(String), sections: 2, control_points: 3 })

    const tpl = await templateAsAdminSees(code)
    expect(tpl.id).toBe(result.template_id)
    expect(tpl.status).toBe('inactive') // 稽核主管檢查後在範本管理按「啟用」
    expect(tpl.plants).toEqual([FACTORY])
    expect(tpl.sections).toEqual([
      { name: '甲作業', points: [['一？', [UNIT.a]], ['二？', [UNIT.b]]] },
      { name: '乙作業', points: [['三？', [UNIT.a]]] },
    ])
  })

  it('一個控制要點可以帶多個自評單位，依定義的順序寫入（#46）', async () => {
    const code = `${RUN}12`
    await draft('draft_template', templateDef(code, { sections: [{ name: '物料標示', controlPoints: [{ text: '製程？', assessingUnits: [UNIT.b, UNIT.a] }] }] }))
    expect((await templateAsAdminSees(code)).sections).toEqual([{ name: '物料標示', points: [['製程？', [UNIT.b, UNIT.a]]] }])
  })
})

/** 等待 promise 失敗，回傳 Postgres 錯誤碼。 */
async function pgError(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(() => null, (e: { code?: string }) => e)
  expect(error, '預期資料庫拒絕').not.toBeNull()
  return error?.code
}

/** 以稽核管理者身分在範本管理把範本改成某個狀態（就是畫面上的「啟用」「停用」）。 */
async function setStatusAsAdmin(code: string, status: 'active' | 'inactive') {
  const tpl = await templateAsAdminSees(code)
  ok(
    await boss.rpc('update_template', {
      p_template_id: tpl.id, p_code: tpl.code, p_name: tpl.name, p_status: status, p_all_plants: false, p_factory_codes: tpl.plants,
    }),
  )
}

/**
 * 以超級使用者開一個標成對話寫入的交易，把 claimed 的 id 記成這個交易新建的（draft_path_claim，寫入函式自己會做的事），
 * 再執行 statement（模擬寫入函式寫錯）。回傳錯誤碼與 hint，成功是 null；一律 rollback。
 */
async function inDraftPathTransaction(statement: string, claimed: string[] = []) {
  return withSuperuser(async (sql) => {
    await sql.query('begin')
    try {
      await sql.query('select public.enter_draft_path()')
      for (const id of claimed) await sql.query('select public.draft_path_claim($1)', [id])
      return await sql.query(statement).then(
        () => null,
        (e: { code?: string; hint?: string }) => ({ code: e.code, hint: e.hint }),
      )
    } finally {
      await sql.query('rollback')
    }
  })
}

const DRAFT_ONLY = { code: '42501', hint: 'draft_only' }

describe('draft_template 的定義檢查', () => {
  it('章節名稱或控制要點文字是空白就整份拒絕（Claude 漏抓文字時不會多出空白題）', async () => {
    const blankSection = templateDef(`${RUN}11`, { sections: [{ name: '  ', controlPoints: [{ text: '一？', assessingUnits: [UNIT.a] }] }] })
    const blankPoint = templateDef(`${RUN}11`, { sections: [{ name: '甲作業', controlPoints: [{ text: '', assessingUnits: [UNIT.a] }] }] })
    expect(await pgError(draft('draft_template', blankSection))).toBe('23514')
    expect(await pgError(draft('draft_template', blankPoint))).toBe('23514')
    expect(ok(await boss.from('questionnaire_template').select('id').eq('code', `${RUN}11`))).toEqual([])
  })

  it('舊格式的單一 assessingUnit、同一題重複的單位、空白的單位名稱，整份拒絕（#46）', async () => {
    const legacy = templateDef(`${RUN}13`, { sections: [{ name: '甲作業', controlPoints: [{ text: '一？', assessingUnit: UNIT.a }] }] })
    const twice = templateDef(`${RUN}13`, { sections: [{ name: '甲作業', controlPoints: [{ text: '一？', assessingUnits: [UNIT.a, UNIT.a] }] }] })
    expect(await pgError(draft('draft_template', legacy))).toBe('22023')
    expect(await pgError(draft('draft_template', twice))).toBe('23505')
    const blank = templateDef(`${RUN}13`, { layout: 'element', sections: [{ name: '甲作業', controlPoints: [{ text: '一？', assessingUnits: ['  '] }] }] })
    expect(await pgError(draft('draft_template', blank))).toBe('23514')
    expect(ok(await boss.from('questionnaire_template').select('id').eq('code', `${RUN}13`))).toEqual([])
  })

  it('定義帶 status（不論哪一種）或 version 就拒絕，什麼都不寫（Q137）', async () => {
    const code = `${RUN}02`
    for (const status of ['active', 'inactive', 'draft']) {
      await expect(draft('draft_template', templateDef(code, { status })), status).rejects.toMatchObject({ code: '22023', hint: 'draft_only' })
    }
    await expect(draft('draft_template', templateDef(code, { version: 'v2026.10' }))).rejects.toMatchObject({ code: '22023', hint: 'no_version' })
    expect(ok(await boss.from('questionnaire_template').select('id').eq('code', code))).toEqual([])
  })
})

describe('draft_template 的組成要素（Q101(7)）', () => {
  /** 一份要素類的範本定義（一章一題，不掛自評單位）。 */
  const elementDraft = (code: string, extra: Record<string, unknown> = {}) => ({
    kind: 'template', code, name: `${code} 對話寫入`, layout: 'element', allPlants: true,
    sections: [{ name: '甲', controlPoints: [{ text: '一？' }] }],
    ...extra,
  })
  const componentOf = async (code: string) =>
    ok(await admin.from('questionnaire_template').select('component').eq('code', code).single<{ component: string | null }>()).component

  it('takes the component from the definition, over what an A–D code would give', async () => {
    await draft('draft_template', elementDraft(`E${RUN}`, { component: 'risk_assessment' }))
    expect(await componentOf(`E${RUN}`)).toBe('risk_assessment')
    await draft('draft_template', elementDraft(`D-${RUN}`, { component: 'control_environment' }))
    expect(await componentOf(`D-${RUN}`)).toBe('control_environment')
  })

  it('still infers it from an A–D code when the definition has none', async () => {
    await draft('draft_template', elementDraft(`B-${RUN}`))
    expect(await componentOf(`B-${RUN}`)).toBe('risk_assessment')
  })

  it('refuses an unknown component, or one that does not match the layout, and writes nothing', async () => {
    expect(await pgError(draft('draft_template', elementDraft(`X${RUN}`, { component: 'controls' })))).toBe('22023')
    expect(await pgError(draft('draft_template', elementDraft(`Y${RUN}`, { component: 'control_activities' })))).toBe('23514')
    expect(ok(await admin.from('questionnaire_template').select('id').in('code', [`X${RUN}`, `Y${RUN}`]))).toEqual([])
  })
})

describe('對話寫入只寫新的範本與流程，碰不到已有的（Q137 (7) ①）', () => {
  it('已有的編號不論啟用或停用、不論從哪裡建的都擋下，請到範本管理直接修改，內容不動', async () => {
    const code = `${RUN}03`
    await draft('draft_template', templateDef(code))
    const other = templateDef(code, { sections: [{ name: '丙作業', controlPoints: [{ text: '四？', assessingUnits: [UNIT.b] }] }] })
    for (const status of ['inactive', 'active'] as const) {
      await setStatusAsAdmin(code, status)
      const error = await drafter.query('select public.draft_template($1::jsonb)', [JSON.stringify(other)]).then(() => null, (e) => e)
      expect({ status, code: error?.code, hint: error?.hint }).toEqual({ status, code: '42501', hint: 'template_exists' })
      expect(error.message).toContain('請到範本管理直接修改')
      const tpl = await templateAsAdminSees(code)
      expect(tpl.status).toBe(status)
      expect(tpl.sections.map((s) => s.name)).toEqual(['甲作業', '乙作業'])
    }

    // 範本管理新增的也一樣（編號前後空白不算不同）
    const managed = ok(await boss.rpc('create_template', {
      p_code: `${RUN}14`, p_name: '範本管理建的', p_component: 'control_activities', p_all_plants: false, p_factory_codes: [],
    })) as string
    await expect(draft('draft_template', templateDef(` ${RUN}14 `))).rejects.toMatchObject({ code: '42501', hint: 'template_exists' })
    expect(ok(await boss.from('template_section').select('id').eq('template_id', managed))).toEqual([])
  })

  it('csa_drafter 不能直接寫表，也不能呼叫範本編輯、刪除流程等稽核主管的函式，或自己記下要寫的 id', async () => {
    const code = `${RUN}04`
    expect(
      await pgError(drafter.query(`insert into public.questionnaire_template (code, name, layout, status) values ($1, 'x', 'element', 'active')`, [code])),
    ).toBe('42501')
    const { template_id } = await draft('draft_template', templateDef(code))
    expect(await pgError(drafter.query(`update public.questionnaire_template set status = 'active' where id = $1`, [template_id]))).toBe('42501')
    expect(
      await pgError(drafter.query(`select public.update_template($1, $2, 'x', 'active', false, '{}')`, [template_id, code])),
    ).toBe('42501')
    expect(await pgError(drafter.query(`select public.delete_route(gen_random_uuid(), 'x')`))).toBe('42501')
    expect(await pgError(drafter.query(`select public.draft_path_claim($1)`, [template_id]))).toBe('42501')
    expect((await templateAsAdminSees(code)).status).toBe('inactive')
  })

  it('走對話寫入的交易只能寫這個交易記下的範本與它底下的資料，就算繞過寫入函式也改不到已有的範本', async () => {
    const code = `${RUN}05`
    const { template_id } = await draft('draft_template', templateDef(code))
    await setStatusAsAdmin(code, 'active')
    const sectionId = (ok(await boss.from('template_section').select('id').eq('template_id', template_id!).eq('position', 1).single()) as { id: string }).id
    const fresh = randomUUID()
    const insertFresh = `insert into public.questionnaire_template (id, code, name, layout) values ('${fresh}', '${RUN}06', 'x', 'control_activity');`

    // 記下的新範本：抬頭、章節、控制要點與它的自評單位、適用廠區都寫得進去，也能新增自評單位。
    expect(
      await inDraftPathTransaction(
        `${insertFresh}
         insert into public.template_section (template_id, name) values ('${fresh}', '甲');
         insert into public.control_point (section_id, text) select id, '一？' from public.template_section where template_id = '${fresh}';
         insert into public.assessing_unit (name) values ('${RUN}新單位');
         insert into public.control_point_unit (control_point_id, position, assessing_unit_id)
           select cp.id, 1, u.id from public.control_point cp join public.template_section s on s.id = cp.section_id, public.assessing_unit u
           where s.template_id = '${fresh}' and u.name = '${RUN}新單位';
         insert into public.template_plant (template_id, factory_code) values ('${fresh}', 'ZZ');
         update public.questionnaire_template set name = '改名' where id = '${fresh}';`,
        [fresh],
      ),
    ).toBeNull()

    const attempts = [
      // 沒記下的 id：連新範本都不行
      `insert into public.questionnaire_template (code, name, layout) values ('${RUN}06', 'x', 'element')`,
      `update public.questionnaire_template set name = '改名' where id = '${template_id}'`,
      `update public.template_section set name = '改名' where id = '${sectionId}'`,
      `delete from public.template_section where id = '${sectionId}'`,
      `insert into public.template_section (template_id, name) values ('${template_id}', '偷加')`,
      `insert into public.template_plant (template_id, factory_code) values ('${template_id}', 'ZZ')`,
      `insert into public.control_point (section_id, text) values ('${sectionId}', '新題')`,
      `insert into public.control_point_unit (control_point_id, position, assessing_unit_id)
         select cp.id, 9, u.id from public.control_point cp, public.assessing_unit u where cp.section_id = '${sectionId}' and u.name = '${UNIT.b}' limit 1`,
      `delete from public.control_point_unit where control_point_id in (select id from public.control_point where section_id = '${sectionId}')`,
      // 把已有範本的資料搬到記下的新範本底下，也算改到已有的範本。
      `${insertFresh} update public.template_section set template_id = '${fresh}' where id = '${sectionId}'`,
      `update public.assessing_unit set name = name || '改' where name = '${UNIT.a}'`,
      `delete from public.assessing_unit where name = '${UNIT.a}'`,
    ]
    for (const statement of attempts) expect(await inDraftPathTransaction(statement, [fresh]), statement).toEqual(DRAFT_ONLY)
    expect((await templateAsAdminSees(code)).sections[0]!.name).toBe('甲作業')
  })
})

describe('draft_route', () => {
  /**
   * 範本 07：兩個自評單位；廠區端每個單位一條分流（自行檢查人員，資材另有部門主管，Q116），最後是有連動標記的
   * 稽核室覆核。
   */
  const routeDef = (overrides: Record<string, unknown> = {}) => ({
    kind: 'route',
    templateCode: `${RUN}07`,
    factoryCode: FACTORY.toLowerCase(),
    steps: [
      { name: '自行檢查人員－資材單位', group: 'plant', signer: EMP.signer, editableUnit: UNIT.a },
      { name: '自行檢查人員－品保單位', group: 'plant', signer: EMP.signer, editableUnit: UNIT.b },
      { name: '部門主管－資材單位', group: 'plant', signer: EMP.boss, editableUnit: null, branchUnit: UNIT.a },
      { name: '台北稽核人員', group: 'audit_review', signer: EMP.boss, editableUnit: null, link: 'taipei_auditor' },
      { name: '稽核主管', group: 'audit_review', signer: EMP.boss, editableUnit: null, link: 'audit_chief' },
    ],
    ...overrides,
  })

  it('寫成新的流程，稽核主管在流程編輯器看得到關卡，發起檢查只差分派', async () => {
    await draft('draft_template', templateDef(`${RUN}07`))
    const result = await draft('draft_route', routeDef())
    expect(result).toEqual({ ok: true, route_id: expect.any(String), steps: 5 })

    const route = ok(
      await boss
        .from('approval_route')
        .select(
          'plant(factory_code), launch_check, route_step(position, name, step_group, signer_emp_id, ' +
            'assessing_unit!route_step_editable_unit_id_fkey(name), branch:assessing_unit!route_step_branch_unit_id_fkey(name))',
        )
        .eq('id', result.route_id!)
        .single(),
    ) as {
      plant: { factory_code: string }; launch_check: LaunchCheck
      route_step: {
        position: number; name: string; step_group: string; signer_emp_id: string | null
        assessing_unit: { name: string } | null; branch: { name: string } | null
      }[]
    }
    expect(route.plant.factory_code).toBe(FACTORY)
    // 每一關的分流：自行檢查人員跟著可編輯範圍，部門主管照定義的 branchUnit，稽核室在匯流後（Q116）；廠區端不設人名
    expect(route.route_step.sort((x, y) => x.position - y.position)
      .map((s) => [s.name, s.step_group, s.signer_emp_id, s.assessing_unit?.name ?? null, s.branch?.name ?? null])).toEqual([
      ['自行檢查人員－資材單位', 'plant', null, UNIT.a, UNIT.a],
      ['自行檢查人員－品保單位', 'plant', null, UNIT.b, UNIT.b],
      ['部門主管－資材單位', 'plant', null, null, UNIT.a],
      ['台北稽核人員', 'audit_review', EMP.boss, null, null],
      ['稽核主管', 'audit_review', EMP.boss, null, null],
    ])
    // 發起檢查只差廠區端還沒分派（草稿途徑不寫廠區端的人，發出前由稽核主管或廠區管理員分派，Q147）。
    expect(route.launch_check).toMatchObject(OTHERWISE_READY)
    expect(route.launch_check.unassigned_steps.map((s) => s.name)).toEqual(['自行檢查人員－資材單位', '部門主管－資材單位', '自行檢查人員－品保單位'])
  })

  it('範本 × 廠區已有流程就擋下，請到簽核流程直接修改，既有的關卡不動', async () => {
    await draft('draft_template', templateDef(`${RUN}15`))
    const { route_id } = await draft('draft_route', routeDef({ templateCode: `${RUN}15` }))
    const before = await stepNames(route_id!)
    const shorter = routeDef({ templateCode: `${RUN}15`, steps: [{ name: '自行檢查人員', group: 'plant', signer: EMP.signer, editableUnit: UNIT.a }] })
    const error = await drafter.query('select public.draft_route($1::jsonb)', [JSON.stringify(shorter)]).then(() => null, (e) => e)
    expect({ code: error?.code, hint: error?.hint }).toEqual({ code: '42501', hint: 'route_exists' })
    expect(error.message).toContain('請到簽核流程直接修改')
    expect(await stepNames(route_id!)).toEqual(before)

    // 在流程編輯器建的（還沒有關卡）也一樣
    await draft('draft_template', templateDef(`${RUN}16`))
    const tpl = await templateAsAdminSees(`${RUN}16`)
    const manual = ok(await boss.from('approval_route').insert({ template_id: tpl.id, plant_id: ID.plant }).select('id').single<{ id: string }>())
    await expect(draft('draft_route', routeDef({ templateCode: `${RUN}16` }))).rejects.toMatchObject({ code: '42501', hint: 'route_exists' })
    expect(await stepNames(manual.id)).toEqual([])
  })

  it('範本已啟用就擋下：流程沒有狀態，寫給啟用中的範本等於直接能發起，請到簽核流程新增（Q137 (7) ①）', async () => {
    await draft('draft_template', templateDef(`${RUN}21`))
    await setStatusAsAdmin(`${RUN}21`, 'active')
    const error = await drafter.query('select public.draft_route($1::jsonb)', [JSON.stringify(routeDef({ templateCode: `${RUN}21` }))]).then(() => null, (e) => e)
    expect({ code: error?.code, hint: error?.hint }).toEqual({ code: '42501', hint: 'template_active' })
    expect(error.message).toContain('請到簽核流程直接新增或修改')
    const tpl = await templateAsAdminSees(`${RUN}21`)
    expect(ok(await boss.from('approval_route').select('id').eq('template_id', tpl.id))).toEqual([])
  })

  it('定義帶 status 或 templateVersion、範本或廠區不存在、可編輯範圍或分流不是清單上的自評單位，都整份拒絕', async () => {
    await draft('draft_template', templateDef(`${RUN}08`))
    const before = ok(await boss.from('approval_route').select('id').eq('plant_id', ID.plant!)).length
    await expect(draft('draft_route', routeDef({ templateCode: `${RUN}08`, status: 'active' }))).rejects.toMatchObject({ code: '22023', hint: 'no_status' })
    await expect(draft('draft_route', routeDef({ templateCode: `${RUN}08`, templateVersion: 'v2026.10' }))).rejects.toMatchObject({ code: '22023', hint: 'no_version' })
    expect(await pgError(draft('draft_route', routeDef({ templateCode: `${RUN}沒有這份` })))).toBe('P0002')
    expect(await pgError(draft('draft_route', routeDef({ templateCode: `${RUN}08`, factoryCode: `${RUN}沒有這廠` })))).toBe('P0002')
    const steps = [{ name: '自行檢查人員', group: 'plant', signer: EMP.signer, editableUnit: `${RUN}打錯的單位` }]
    expect(await pgError(draft('draft_route', routeDef({ templateCode: `${RUN}08`, steps })))).toBe('P0002')
    const branchTypo = [{ name: '部門主管', group: 'plant', signer: EMP.signer, editableUnit: null, branchUnit: `${RUN}打錯的單位` }]
    expect(await pgError(draft('draft_route', routeDef({ templateCode: `${RUN}08`, steps: branchTypo })))).toBe('P0002')
    expect(ok(await boss.from('approval_route').select('id').eq('plant_id', ID.plant!)).length).toBe(before)
  })

  it('走對話寫入的交易只能寫這個交易記下的流程與它的關卡，改不到已有流程', async () => {
    await draft('draft_template', templateDef(`${RUN}09`))
    const { route_id } = await draft('draft_route', routeDef({ templateCode: `${RUN}09` }))
    await draft('draft_template', templateDef(`${RUN}17`))
    const other = await templateAsAdminSees(`${RUN}17`) // 還沒有流程的組合
    const fresh = randomUUID()
    const insertFresh = `insert into public.approval_route (id, template_id, plant_id) values ('${fresh}', '${other.id}', '${ID.plant}');`

    expect(
      await inDraftPathTransaction(
        `${insertFresh}
         insert into public.route_step (route_id, name, step_group, signer_emp_id) values ('${fresh}', '台北稽核人員', 'audit_review', '${EMP.boss}');
         update public.route_step set name = '稽核主管' where route_id = '${fresh}';`,
        [fresh],
      ),
    ).toBeNull()

    const attempts = [
      `insert into public.approval_route (template_id, plant_id) values ('${other.id}', '${ID.plant}')`,
      `update public.approval_route set updated_at = now() where id = '${route_id}'`,
      `delete from public.approval_route where id = '${route_id}'`,
      `update public.route_step set signer_emp_id = 'X' where route_id = '${route_id}'`,
      `delete from public.route_step where route_id = '${route_id}'`,
      `insert into public.route_step (route_id, name, step_group, signer_emp_id) values ('${route_id}', '多一關', 'audit_review', '${EMP.boss}')`,
      // 把已有流程的關卡搬到記下的新流程底下，也算改到已有的流程。
      `${insertFresh} update public.route_step set route_id = '${fresh}' where route_id = '${route_id}'`,
    ]
    for (const statement of attempts) expect(await inDraftPathTransaction(statement, [fresh]), statement).toEqual(DRAFT_ONLY)
    expect(await stepNames(route_id!)).toEqual(['自行檢查人員－資材單位', '自行檢查人員－品保單位', '部門主管－資材單位', '台北稽核人員', '稽核主管'])
  })

  it('多加一關也寫得進去（#98），發起檢查照樣只差分派', async () => {
    await draft('draft_template', templateDef(`${RUN}20`))
    const steps = [
      { name: '自行檢查人員－資材單位', group: 'plant', signer: EMP.signer, editableUnit: UNIT.a },
      { name: '課長', group: 'plant', signer: EMP.boss, editableUnit: null, branchUnit: UNIT.a },
      { name: '部門主管－資材單位', group: 'plant', signer: EMP.boss, editableUnit: null, branchUnit: UNIT.a },
      { name: '自行檢查人員－品保單位', group: 'plant', signer: EMP.signer, editableUnit: UNIT.b },
      { name: '部門主管－品保單位', group: 'plant', signer: EMP.boss, editableUnit: null, branchUnit: UNIT.b },
      { name: '台北稽核人員', group: 'audit_review', signer: EMP.boss, editableUnit: null, link: 'taipei_auditor' },
      { name: '稽核主管', group: 'audit_review', signer: EMP.boss, editableUnit: null, link: 'audit_chief' },
    ]
    const { route_id } = await draft('draft_route', routeDef({ templateCode: `${RUN}20`, steps }))
    const route = ok(await boss.from('approval_route').select('launch_check').eq('id', route_id!).single()) as { launch_check: LaunchCheck }
    expect(route.launch_check).toMatchObject(OTHERWISE_READY)
    const unitA = ok(await boss.from('assessing_unit').select('id').eq('name', UNIT.a).single()) as { id: string }
    const branchA = ok(await boss.from('route_step').select('name').eq('route_id', route_id!).eq('branch_unit_id', unitA.id).order('position')) as { name: string }[]
    expect(branchA.map((s) => s.name)).toEqual(['自行檢查人員－資材單位', '課長', '部門主管－資材單位'])
  })
})
