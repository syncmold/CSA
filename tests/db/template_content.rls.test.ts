// 資料 API 接縫: 範本管理先選廠區的兩個計算欄位（工單 #84，Q111）——題數與內容指紋。以稽核管理者的 CSA session
// 走 PostgREST 讀；service_role 只用來準備與清理。每次執行建立自己的範本與自評單位，結束時清掉。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, insertRow, loginAs, makeTemplate, ok, promoteToAuditAdmin, requirePostgrest, restClient, withSuperuser, type TemplateSections } from './helpers'

// 資料庫測試檔案並行執行：前綴與隨機尾巴避免和其他檔案的工號、編號撞在一起。
const RUN = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A` }
const FACTORY = `${RUN}P`.toUpperCase()
const UNIT = { a: `${RUN}甲單位`, b: `${RUN}乙單位` }
const ID: Record<string, string> = {}

const SELECT = 'code,control_point_count,content_fingerprint'

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.boss, '丙')
  await promoteToAuditAdmin(EMP.boss)
  ID.a = (await insertRow('assessing_unit', { name: UNIT.a })).id
  ID.b = (await insertRow('assessing_unit', { name: UNIT.b })).id
  const content = (second: string | string[]): TemplateSections => [
    ['甲章', [['第一題？', ID.a!], ['第二題？', second]]],
    ['乙章', [['第三題？', ID.a!]]],
  ]
  await makeTemplate(`${RUN}-GT-07`, 'control_activity', FACTORY, content(ID.a!))
  await makeTemplate(`${RUN}-TC-07`, 'control_activity', FACTORY, content(ID.a!))
  await makeTemplate(`${RUN}-LH-07`, 'control_activity', FACTORY, content([ID.a!, ID.b!]))
  await makeTemplate(`${RUN}-SY-07`, 'control_activity', FACTORY, [
    ['甲章', [['第一題？', ID.a!], ['第二題？', ID.a!], ['第三題？', ID.a!]]],
  ])
  await makeTemplate(`${RUN}-KS-07`, 'control_activity', FACTORY, [])
  await makeTemplate(`${RUN}-KH-07`, 'control_activity', FACTORY, [])
})

afterAll(async () => {
  await admin.from('questionnaire_template').delete().like('code', `${RUN}-%`)
  await admin.from('assessing_unit').delete().in('name', Object.values(UNIT))
})

describe('範本管理的題數與內容指紋 (#84)', () => {
  it('counts control points, a multi-unit one once', async () => {
    const boss = await loginAs(EMP.boss, '丙')
    const rows = ok(await boss.from('questionnaire_template').select(SELECT).like('code', `${RUN}-%`).order('code'))
    expect(rows.map((r) => [r.code, r.control_point_count])).toEqual([
      [`${RUN}-GT-07`, 3],
      [`${RUN}-KH-07`, 0],
      [`${RUN}-KS-07`, 0],
      [`${RUN}-LH-07`, 3],
      [`${RUN}-SY-07`, 3],
      [`${RUN}-TC-07`, 3],
    ])
  })

  it('gives the same fingerprint only to the same sections, control points and units, in order', async () => {
    const boss = await loginAs(EMP.boss, '丙')
    const rows = ok(await boss.from('questionnaire_template').select(SELECT).like('code', `${RUN}-%`))
    const fp = Object.fromEntries(rows.map((r) => [r.code.slice(RUN.length + 1), r.content_fingerprint]))
    expect(fp['GT-07']).toBe(fp['TC-07']) // 編號不同、內容相同
    expect(fp['LH-07']).not.toBe(fp['GT-07']) // 第二題多一個自評單位
    expect(fp['SY-07']).not.toBe(fp['GT-07']) // 同樣的題目，章節分法不同
    // 還沒有內容的範本沒有指紋，空範本之間不算相同。
    expect([fp['KS-07'], fp['KH-07']]).toEqual([null, null])
  })

  it('is computed on every read, so editing a template changes it and undoing the edit restores it', async () => {
    const boss = await loginAs(EMP.boss, '丙')
    const read = async () =>
      Object.fromEntries(
        ok(await boss.from('questionnaire_template').select(SELECT).in('code', [`${RUN}-GT-07`, `${RUN}-TC-07`])).map((r) => [
          r.code.slice(RUN.length + 1),
          r.content_fingerprint,
        ]),
      )
    /** GT-07 的第一題文字從 from 改成 to（測試準備，以超級使用者直接改）。 */
    const retext = (from: string, to: string) =>
      withSuperuser((db) =>
        db.query(
          `update public.control_point cp set text = $3
           from public.template_section s join public.questionnaire_template t on t.id = s.template_id
           where cp.section_id = s.id and t.code = $1 and cp.text = $2`,
          [`${RUN}-GT-07`, from, to],
        ),
      )
    const before = await read()
    expect(before['GT-07']).toBe(before['TC-07'])
    await retext('第一題？', '第一題（改）？')
    const changed = await read()
    expect(changed['GT-07']).not.toBe(changed['TC-07'])
    await retext('第一題（改）？', '第一題？')
    const restored = await read()
    expect(restored['GT-07']).toBe(restored['TC-07'])
  })

  it('is not readable without a CSA session', async () => {
    const { data } = await restClient(async () => null).from('questionnaire_template').select(SELECT).like('code', `${RUN}-%`)
    expect(data ?? []).toEqual([])
  })
})
