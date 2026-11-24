// 範本與簽核流程照定義檔重建（#207 步驟 4，Q138）：測試環境換成真實資料時用。
//
//   npm run templates:rebuild [-- --dry-run]          本機 .env 的資料庫（演練用）
//   npm run deploy -- test rebuild --yes [--dry-run]  demo 環境（部署指令先完整備份，只能從 main 跑）
//
// 在一個交易裡依序做，任何一步失敗整個退回：
//   1. 刪掉全部年度作業（連帶全部自評表與它們的答案、簽核紀錄；使用者決定 2025、2026 都刪）。
//   2. 刪掉全部簽核流程。
//   3. 定義檔有的範本整份刪掉，照定義檔重寫（draft_template，寫成停用）。FQ-02 是種子 migration、有內控依據，不刪、
//      不改內容，只重建流程。
//   4. 每份範本 × 適用廠區建一條流程（draft_route；它只寫給停用的範本，所以 FQ-02 先改停用），照 Word 原檔簽核欄的
//      形狀（route-shapes.json，npm run templates:signatures 產生，Q143）：範本用到的每個自評單位一條分流（依單位第一次
//      出現的順序）「自行檢查人員 →（原檔的部門主管）」，匯流後是原檔廠區端的其他職稱，再接稽核室的子公司擔當稽核（不存
//      人，發出後由廠區管理員分派）→ 台北稽核人員 → 稽核主管（原檔有的才建）。台北稽核人員、稽核主管的簽核人是連動的人
//      （linked_signer）；要建卻沒有連動的人（廠區沒有廠區管理員、稽核主管不是剛好一位）或廠區不存在時，這個組合不建，
//      列在結果裡。
//   5. 範本改成啟用（重建前就是停用的照舊停用），列出發起檢查沒過的流程、還有待指定單位分流的範本。
// 放行名單、角色、廠區管理員、自評單位清單、內控文件都不動。--dry-run 做完全部再退回，只看結果。重跑會得到一樣的結果。
//
// 防護（Q141）：測試環境換成真實資料後，稽核人員會直接在畫面上改範本與流程（補待指定單位、改單位），之後正式版要讀這份
// 資料。所以只要有人在畫面上改過範本或流程（最後修改人有值：rebuild 自己寫入的沒有修改人），或已經發出過自評表，就拒絕，
// 列出是哪些；確定要蓋掉才加 overwriteEdits（部署指令 --overwrite-edits）。
import pg from 'pg'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** 種子 migration 建的範本：不在定義檔裡、有內控依據，只重建流程（#3、#9）。 */
export const SEED_TEMPLATES = ['FQ-02']

/** 每份範本照原檔簽核欄的流程形狀（scripts/templates/route-shapes.json）。 */
export function routeShapes() {
  return JSON.parse(readFileSync(join(REPO, 'scripts', 'templates', 'route-shapes.json'), 'utf8')).shapes
}

/** supabase/drafts/templates 的範本定義檔（原文字串＋解析結果），依路徑排序。 */
export function templateDefinitions() {
  const dir = join(REPO, 'supabase', 'drafts', 'templates')
  return readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8')
      return { file, text, def: JSON.parse(text) }
    })
}

/**
 * 一份範本的流程定義（draft_route 的形狀，見 docs/對話寫入草稿操作說明.md），照原檔簽核欄的形狀（routeShapes）：每個單位
 * 一條分流，匯流後是原檔廠區端的其他職稱與稽核室關卡。
 */
export function routeDefinition(templateCode, factoryCode, units, signers, shape) {
  const audit = {
    subsidiary: { name: '子公司擔當稽核', group: 'audit_review', signer: null, editableUnit: null },
    taipei_auditor: { name: '台北稽核人員', group: 'audit_review', signer: signers.taipei, editableUnit: null, link: 'taipei_auditor' },
    audit_chief: { name: '稽核主管', group: 'audit_review', signer: signers.chief, editableUnit: null, link: 'audit_chief' },
  }
  return {
    kind: 'route',
    templateCode,
    factoryCode,
    steps: [
      ...units.flatMap((unit) => [
        { name: `自行檢查人員－${unit}`, group: 'plant', editableUnit: unit },
        ...(shape.branchManager ? [{ name: `${shape.branchManager}－${unit}`, group: 'plant', editableUnit: null, branchUnit: unit }] : []),
      ]),
      ...shape.merged.map((name) => ({ name, group: 'plant', editableUnit: null })),
      ...shape.audit.map((kind) => audit[kind]),
    ],
  }
}

const count = async (c, sql) => (await c.query(sql)).rows[0].n

/** 在 `client`（超級使用者連線）上重建；回傳前後的數字與沒建流程、沒過發起檢查的組合。 */
export async function rebuildTemplates(client, definitions, { dryRun = false, overwriteEdits = false, log = console.log } = {}) {
  const codes = definitions.map((d) => d.def.code)
  const allCodes = [...codes, ...SEED_TEMPLATES]
  await client.query('begin')
  try {
    // 擋住同時進行的發起、改流程、改範本：要嘛等這裡做完，要嘛這裡等它們做完；讀取照常。
    await client.query(
      'lock table public.annual_cycle, public.assessment, public.approval_route, public.questionnaire_template in exclusive mode',
    )
    const before = {
      cycles: await count(client, 'select count(*)::int as n from public.annual_cycle'),
      assessments: await count(client, 'select count(*)::int as n from public.assessment'),
      routes: await count(client, 'select count(*)::int as n from public.approval_route'),
      templates: await count(client, 'select count(*)::int as n from public.questionnaire_template'),
      allowlist: await count(client, 'select count(*)::int as n from public.access_allowlist'),
      coordinators: await count(client, 'select count(*)::int as n from public.plant_coordinator'),
    }
    log(`  現況：年度作業 ${before.cycles}、自評表 ${before.assessments}、流程 ${before.routes}、範本 ${before.templates}`)
    const editedTemplates = (await client.query(
      'select code from public.questionnaire_template where updated_by is not null order by code')).rows.map((r) => r.code)
    const editedRoutes = (await client.query(
      `select q.code || ' × ' || p.factory_code as combo from public.approval_route ar
       join public.questionnaire_template q on q.id = ar.template_id join public.plant p on p.id = ar.plant_id
       where ar.updated_by is not null order by 1`)).rows.map((r) => r.combo)
    if ((editedTemplates.length || editedRoutes.length || before.assessments) && !overwriteEdits) {
      const list = (xs) => `${xs.slice(0, 20).join('、')}${xs.length > 20 ? ` 等 ${xs.length} 個` : ''}`
      throw new Error([
        '有人在畫面上改過範本或流程、或已經發出自評表，重建會把它們蓋掉或刪掉，停下來（Q141）：',
        editedTemplates.length ? `  改過的範本 ${editedTemplates.length} 份：${list(editedTemplates)}` : null,
        editedRoutes.length ? `  改過的流程 ${editedRoutes.length} 條：${list(editedRoutes)}` : null,
        before.assessments ? `  自評表 ${before.assessments} 張` : null,
        '  確定要蓋掉，部署指令加 --overwrite-edits（本機 templates:rebuild 加 --overwrite-edits）。',
      ].filter(Boolean).join('\n'))
    }

    // 種子範本要在走對話寫入之前改停用：走對話寫入的交易只能改這個交易新建的資料（guard_draft_path）。
    const seeds = (await client.query('select code from public.questionnaire_template where code = any($1)', [SEED_TEMPLATES])).rows.map((r) => r.code)
    // 重建前已經停用的範本（稽核主管停掉的）重建後照舊停用；其餘（含新的）改啟用。
    const wasInactive = new Set((await client.query(
      `select code from public.questionnaire_template where code = any($1) and status = 'inactive'`, [allCodes])).rows.map((r) => r.code))
    await client.query('delete from public.annual_cycle')
    await client.query('delete from public.approval_route')
    await client.query(`update public.questionnaire_template set status = 'inactive' where code = any($1)`, [seeds])
    const deleted = (await client.query('delete from public.questionnaire_template where code = any($1)', [codes])).rowCount
    log(`  刪除年度作業 ${before.cycles}（自評表 ${before.assessments}）、流程 ${before.routes}、範本 ${deleted}`)

    for (const { text } of definitions) await client.query('select public.draft_template($1::jsonb)', [text])
    log(`  照定義檔寫入範本 ${definitions.length} 份${seeds.length ? `，保留 ${seeds.join('、')}` : ''}`)

    // 每份範本的自評單位（依章節、控制要點、單位的順序第一次出現）與適用廠區。
    const { rows } = await client.query(
      `select q.code, u.name as unit
       from public.questionnaire_template q
       join public.template_section s on s.template_id = q.id
       join public.control_point cp on cp.section_id = s.id
       join public.control_point_unit cpu on cpu.control_point_id = cp.id
       join public.assessing_unit u on u.id = cpu.assessing_unit_id
       where q.code = any($1)
       order by q.code, s.position, cp.position, cpu.position`,
      [allCodes],
    )
    const units = new Map()
    for (const r of rows) units.set(r.code, [...new Set([...(units.get(r.code) ?? []), r.unit])])
    const combos = (await client.query(
      `select q.code, tp.factory_code, p.id as plant_id,
              public.linked_signer('taipei_auditor', p.id) as taipei, public.audit_chief_emp_id() as chief
       from public.questionnaire_template q
       join public.template_plant tp on tp.template_id = q.id
       left join public.plant p on p.factory_code = tp.factory_code
       where q.code = any($1)
       order by q.code, tp.factory_code`,
      [allCodes],
    )).rows
    const shapes = routeShapes()
    const skipped = []
    let built = 0
    for (const c of combos) {
      const shape = shapes[c.code]
      const reason = !shape ? 'route-shapes.json 沒有這份範本（執行 npm run templates:signatures）'
        : !c.plant_id ? '廠區主檔沒有這個廠區'
        : !units.get(c.code)?.length ? '範本沒有自評單位'
        : shape.audit.includes('taipei_auditor') && !c.taipei ? '台北稽核人員不連動（這一廠沒有是稽核人員或稽核主管的廠區管理員）'
        : !c.chief ? '稽核主管不是剛好一位'
        : null
      if (reason) {
        skipped.push({ code: c.code, plant: c.factory_code, reason })
        continue
      }
      const def = routeDefinition(c.code, c.factory_code, units.get(c.code), { taipei: c.taipei, chief: c.chief }, shape)
      await client.query('select public.draft_route($1::jsonb)', [JSON.stringify(def)])
      built++
    }
    const noPlant = (await client.query(
      `select q.code from public.questionnaire_template q
       where q.code = any($1) and not q.all_plants and not exists (select 1 from public.template_plant tp where tp.template_id = q.id)`,
      [allCodes],
    )).rows.map((r) => r.code)
    for (const code of noPlant) skipped.push({ code, plant: null, reason: '範本沒有適用廠區' })
    const allPlants = (await client.query(
      `select code from public.questionnaire_template where code = any($1) and all_plants order by code`, [allCodes])).rows.map((r) => r.code)
    for (const code of allPlants) skipped.push({ code, plant: null, reason: '所有廠區適用的範本不自動建流程，請在簽核流程逐廠新增' })
    log(`  建流程 ${built} 條${skipped.length ? `，${skipped.length} 個組合沒建（見下方）` : ''}`)

    // 走完對話寫入，清掉這個交易的標記，才能把範本改成啟用（同 guard_draft_path 的說明：標記只多加限制）。
    await client.query(`select set_config('csa.draft_path', '', true), set_config('csa.draft_new', '', true)`)
    const activate = allCodes.filter((code) => !wasInactive.has(code))
    await client.query(`update public.questionnaire_template set status = 'active' where code = any($1)`, [activate])
    const pendingUnits = [...units].filter(([, us]) => us.includes('待指定單位')).map(([code]) => code).sort()

    const notReady = (await client.query(
      `select q.code, p.factory_code as plant, public.launch_check(ar) as check
       from public.approval_route ar
       join public.questionnaire_template q on q.id = ar.template_id
       join public.plant p on p.id = ar.plant_id
       where not coalesce((public.launch_check(ar) ->> 'ready')::boolean, false)
       order by 1, 2`,
    )).rows
    const after = {
      cycles: await count(client, 'select count(*)::int as n from public.annual_cycle'),
      assessments: await count(client, 'select count(*)::int as n from public.assessment'),
      routes: await count(client, 'select count(*)::int as n from public.approval_route'),
      templates: await count(client, 'select count(*)::int as n from public.questionnaire_template'),
      active: await count(client, `select count(*)::int as n from public.questionnaire_template where status = 'active'`),
      allowlist: await count(client, 'select count(*)::int as n from public.access_allowlist'),
      coordinators: await count(client, 'select count(*)::int as n from public.plant_coordinator'),
      tbaPoints: await count(client,
        `select count(*)::int as n from public.control_point_unit cpu join public.assessing_unit u on u.id = cpu.assessing_unit_id
         where u.name = '待指定單位'`),
    }
    if (after.allowlist !== before.allowlist || after.coordinators !== before.coordinators) {
      throw new Error(`放行名單或廠區管理員的筆數變了（${before.allowlist}→${after.allowlist}、${before.coordinators}→${after.coordinators}），退回`)
    }
    log(`  結果：範本 ${after.templates}（啟用 ${after.active}）、流程 ${after.routes}、自評表 ${after.assessments}、仍是待指定單位的控制要點 ${after.tbaPoints}`)
    for (const s of skipped) log(`  ⚠ 沒建流程：${s.code}${s.plant ? ` × ${s.plant}` : ''}：${s.reason}`)
    for (const r of notReady) log(`  ⚠ 發起檢查沒過：${r.code} × ${r.plant}：${JSON.stringify(r.check)}`)
    if (wasInactive.size) log(`  照舊停用 ${wasInactive.size} 份：${[...wasInactive].sort().join('、')}`)
    if (pendingUnits.length) log(`  還有「待指定單位」分流的範本 ${pendingUnits.length} 份（單位確認後改定義檔或在簽核流程修改）：${pendingUnits.join('、')}`)

    if (dryRun) {
      await client.query('rollback')
      log('  --dry-run：全部退回，資料庫沒有改')
    } else {
      await client.query('commit')
    }
    return { before, after, built, skipped, notReady, pendingUnits }
  } catch (e) {
    await client.query('rollback')
    throw e
  }
}

// 本機：npm run templates:rebuild [-- --dry-run]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { required } = await import('../db/env.mjs')
  const dbUrl = new URL(required('CSA_DB_URL'))
  const adminUrl = new URL(required('CSA_DB_ADMIN_URL'))
  adminUrl.pathname = dbUrl.pathname
  const client = new pg.Client({ connectionString: adminUrl.toString() })
  await client.connect()
  try {
    await rebuildTemplates(client, templateDefinitions(), {
      dryRun: process.argv.includes('--dry-run'),
      overwriteEdits: process.argv.includes('--overwrite-edits'),
    })
  } finally {
    await client.end()
  }
}
