// 資料 API 接縫: 範本的組成要素（工單 #62，Q101）。寫入以稽核管理者的 CSA session 走 PostgREST 的
// create_template／update_template；不走畫面的寫入（種子）以超級使用者直接 insert 代表。對話寫入的組成要素在
// draft_path.test.ts（csa_drafter 的密碼只在那裡設，兩個檔案並行設會互相衝突）。
// 每次執行建立自己的範本，結束時全部清掉；不動真實範本。
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, loginAs, ok, promoteToAuditAdmin, requirePostgrest, withSuperuser } from './helpers'

// 資料庫測試檔案並行執行：前綴與隨機尾巴避免和其他檔案的工號、編號撞在一起。
const RUN = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const EMP = { boss: `${RUN}A` }

let boss: SupabaseClient

type Component = 'control_environment' | 'risk_assessment' | 'control_activities' | 'information_communication' | 'monitoring'

function create(code: string, component: Component | null) {
  return boss.rpc('create_template', {
    p_code: code, p_name: '組成要素測試', p_component: component, p_all_plants: true,
  })
}

async function header(code: string) {
  return ok(await admin.from('questionnaire_template').select('layout,component').eq('code', code).single<{ layout: string; component: Component | null }>())
}

function update(id: string, code: string, component?: Component) {
  return boss.rpc('update_template', {
    p_template_id: id, p_code: code, p_name: '組成要素測試', p_status: 'active', p_all_plants: true,
    ...(component ? { p_component: component } : {}),
  })
}

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.boss, '丙')
  await promoteToAuditAdmin(EMP.boss)
  boss = await loginAs(EMP.boss, '丙')
})

afterAll(async () => {
  await admin.from('questionnaire_template').delete().like('code', `%${RUN}%`)
})

describe('組成要素: 新增範本', () => {
  it('derives the 版型 from the 組成要素 (Q101(6))', async () => {
    ok(await create(`${RUN}01`, 'control_activities'))
    ok(await create(`${RUN}E1`, 'risk_assessment'))
    expect(await header(`${RUN}01`)).toEqual({ layout: 'control_activity', component: 'control_activities' })
    expect(await header(`${RUN}E1`)).toEqual({ layout: 'element', component: 'risk_assessment' })
  })

  it('refuses a new template without a 組成要素', async () => {
    expect((await create(`${RUN}E0`, null)).error?.code).toBe('23514')
  })

  it('fills it on writes that bypass the screen: 控制活動類 always 控制作業, 要素類 from an A–D code, else 未分類', async () => {
    const rows = await withSuperuser(async (sql) =>
      (
        await sql.query(
          `insert into public.questionnaire_template (code, name, layout)
           values ($1, 'x', 'element'), ($2, 'x', 'element'), ($3, 'x', 'element'),
                  ($4, 'x', 'control_activity'), ($5, 'x', 'element')
           returning code, component`,
          [`C-${RUN}`, `D.${RUN}`, `AB${RUN}`, `${RUN}15`, `QX-B.${RUN}`],
        )
      ).rows,
    )
    // 「AB…」不是 A：開頭字母後面緊接英文字母就不推定。廠區前綴（「QX-B」，Q111）先跳過。
    expect(rows).toEqual([
      { code: `C-${RUN}`, component: 'information_communication' },
      { code: `D.${RUN}`, component: 'monitoring' },
      { code: `AB${RUN}`, component: null },
      { code: `${RUN}15`, component: 'control_activities' },
      { code: `QX-B.${RUN}`, component: 'risk_assessment' },
    ])
  })
})

describe('組成要素: 修改範本抬頭', () => {
  it('moves a template among the four non-控制作業 components, and leaves it alone when none is sent', async () => {
    const id = ok(await create(`${RUN}E3`, 'control_environment')) as string
    ok(await update(id, `${RUN}E3`, 'information_communication'))
    expect((await header(`${RUN}E3`)).component).toBe('information_communication')
    ok(await update(id, `${RUN}E3`))
    expect((await header(`${RUN}E3`)).component).toBe('information_communication')
  })

  it('refuses a move between 控制作業 and the others, either way, and says why', async () => {
    const element = ok(await create(`${RUN}E4`, 'monitoring')) as string
    const control = ok(await create(`${RUN}02`, 'control_activities')) as string
    for (const result of [await update(element, `${RUN}E4`, 'control_activities'), await update(control, `${RUN}02`, 'risk_assessment')]) {
      expect(result.error?.code).toBe('23514')
      expect(result.error?.message).toContain('控制作業')
    }
    expect(await header(`${RUN}E4`)).toEqual({ layout: 'element', component: 'monitoring' })
    expect(await header(`${RUN}02`)).toEqual({ layout: 'control_activity', component: 'control_activities' })
  })
})
