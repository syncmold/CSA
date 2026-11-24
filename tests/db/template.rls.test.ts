// 資料 API 接縫: 問卷範本 / 章節 / 控制要點 / 自評單位 的 RLS（工單 #3）。
// 預期值取自「02~控制活動~採購及付款循環」Word 原檔（人工逐列數過），不是從種子或轉檔程式算出來的。
// 紙本 53 列，其中驗收作業第 1、2 列是同一題被拆成兩列（原檔漏字），種子接回一題 → 52 題（2026-10-14 決定）。
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { loginAs, promoteToAuditAdmin, requirePostgrest, restClient } from './helpers'

const RUN = `t${Date.now().toString(36)}`
const EMP = { signer: `${RUN}A`, admin: `${RUN}C` }

/** 02 的章節與每章控制要點數，依紙本順序。 */
const SECTIONS_OF_02 = [
  ['供應商管理作業', 4],
  ['請、採購作業(適用於各請、採購類型)', 9],
  ['到貨追蹤作業', 2],
  ['驗收作業(適用於各請、採購類型)', 11],
  ['應付帳款作業', 5],
  ['付款作業', 10],
  ['預支(暫付款)作業', 6],
  ['現金支出作業', 5],
] as const

const TREE =
  'code,name,layout,status,all_plants,' +
  'template_section(position,name,control_point(position,text,control_point_unit(position,assessing_unit(name))))'

interface TemplateTreeRow {
  code: string
  name: string
  layout: string
  status: string
  all_plants: boolean
  template_section: {
    position: number
    name: string
    control_point: { position: number; text: string; control_point_unit: { position: number; assessing_unit: { name: string } }[] }[]
  }[]
}

/** 控制要點的自評單位名稱，依作答順序 (#46)。 */
const unitNames = (p: TemplateTreeRow['template_section'][number]['control_point'][number]) =>
  [...p.control_point_unit].sort((a, b) => a.position - b.position).map((u) => u.assessing_unit.name)

async function fetchTemplate02(client: SupabaseClient) {
  return client.from('questionnaire_template').select(TREE).eq('code', 'FQ-02').returns<TemplateTreeRow[]>()
}

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.signer, '甲')
  await loginAs(EMP.admin, '丙')
  await promoteToAuditAdmin(EMP.admin)
})

describe('範本管理 RLS: FQ-02 採購及付款循環', () => {
  it('a 稽核管理者 sees the template header', async () => {
    const me = await loginAs(EMP.admin, '丙')
    const { data, error } = await me
      .from('questionnaire_template')
      .select('code,name,layout,status,all_plants,template_plant(factory_code)')
      .eq('code', 'FQ-02')
    expect(error).toBeNull()
    // 種子是「所有廠區適用」的 02；每廠一份範本之後改成 FQ-02、只適用福清（20261103000000，Q111）。
    // 發起相關的測試執行期間會暫時加上自己的測試廠區，所以只確認有福清。
    expect(data).toEqual([
      {
        code: 'FQ-02', name: '採購及付款循環', layout: 'control_activity', status: 'active', all_plants: false,
        template_plant: expect.arrayContaining([{ factory_code: 'FQ' }]),
      },
    ])
  })

  it('a 稽核管理者 sees all 8 sections and their control points in paper order', async () => {
    const me = await loginAs(EMP.admin, '丙')
    const { data, error } = await fetchTemplate02(me)
    expect(error).toBeNull()
    const sections = [...(data?.[0]?.template_section ?? [])].sort((a, b) => a.position - b.position)
    expect(sections.map((s) => [s.name, s.control_point.length])).toEqual(SECTIONS_OF_02.map(([n, c]) => [n, c]))
    for (const s of sections) {
      const positions = s.control_point.map((c) => c.position).sort((a, b) => a - b)
      expect(positions).toEqual(positions.map((_, i) => i + 1)) // 每章從 1 連續編號
    }
  })

  it('every control point shows its 自評單位 (資材 26, 品保 3, 財務 23)', async () => {
    const me = await loginAs(EMP.admin, '丙')
    const { data, error } = await fetchTemplate02(me)
    expect(error).toBeNull()
    const points = (data?.[0]?.template_section ?? []).flatMap((s) => s.control_point)
    const perUnit: Record<string, number> = {}
    for (const p of points) {
      expect({ text: p.text, units: unitNames(p).length }).toEqual({ text: p.text, units: 1 }) // 02 每題一個自評單位
      perUnit[unitNames(p)[0]!] = (perUnit[unitNames(p)[0]!] ?? 0) + 1
    }
    expect(perUnit).toEqual({ 資材單位: 26, 品保單位: 3, 財會單位: 23 })

    // 抽查四個控制要點（第一個、接回的那一個、品保單位的一個、最後一個）
    const unitOf = (text: string) => unitNames(points.find((p) => p.text === text)!)[0]
    expect(unitOf('倉庫單位是否依據經核准之採購訂單數量、品名、規格等核對廠商之送貨單以為數量暫收之基礎？')).toBe('資材單位')
    expect(unitOf('原物料或託外加工品是否由兩家以上之廠商供應，以避免因單獨交易而造成獨佔供應，當異常事故發生時，而致供應斷絕之危機？')).toBe('資材單位')
    expect(unitOf('是否確依進料檢驗規範所定之程序辦理檢驗？')).toBe('品保單位')
    expect(unitOf('是否不定期抽點現金，以確保帳款相符？')).toBe('財會單位')
  })

  it('a 稽核管理者 sees the group-wide 自評單位 list', async () => {
    const me = await loginAs(EMP.admin, '丙')
    const { data, error } = await me.from('assessing_unit').select('name').in('name', ['資材單位', '品保單位', '財會單位'])
    expect(error).toBeNull()
    expect(data?.map((u) => u.name).sort()).toEqual(['品保單位', '財會單位', '資材單位'])
  })

  it('a signer who is not 稽核管理者 sees no template data at all', async () => {
    const me = await loginAs(EMP.signer, '甲')
    for (const table of ['questionnaire_template', 'template_section', 'control_point', 'control_point_unit', 'assessing_unit', 'template_plant']) {
      const { data, error } = await me.from(table).select('*')
      expect({ table, error, rows: data }).toEqual({ table, error: null, rows: [] })
    }
  })

  it('an anonymous request is refused', async () => {
    const anon = restClient(async () => null)
    const { error } = await anon.from('questionnaire_template').select('code')
    expect(error?.code).toBe('42501')
  })

  // 稽核管理者的寫入在 #10 開放，見 template_edit.rls.test.ts；這裡只確認其他人仍然改不到 02。
  it('a signer who is not 稽核管理者 cannot change 02 through the API', async () => {
    const me = await loginAs(EMP.signer, '甲')
    const insert = await me.from('assessing_unit').insert({ name: `${RUN}單位` })
    expect(insert.error?.code).toBe('42501')
    await me.from('questionnaire_template').update({ name: '被改了' }).eq('code', 'FQ-02')
    await me.from('control_point').delete().not('id', 'is', null)
    const boss = await loginAs(EMP.admin, '丙')
    const { data } = await fetchTemplate02(boss)
    expect(data?.[0]?.name).toBe('採購及付款循環')
    expect(data?.[0]?.template_section.flatMap((s) => s.control_point)).toHaveLength(52)
  })
})
