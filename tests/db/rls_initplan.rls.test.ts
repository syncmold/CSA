// 權限規則裡「是不是稽核管理者」每個查詢只判斷一次（migration 20261108000000_rls_admin_check_once）。
// policy 直接寫 is_audit_admin() 時每讀一列就呼叫一次：範本管理清單在 demo 環境（293 份範本）因此超過 Supabase
// 8 秒的 statement_timeout。這裡擋下之後新增、沒有包成 (select …) 的 policy。讀取的 policy 也不呼叫以列內容為參數的函式
// （migration 20261115000000_rls_visible_sets）：自評表與答案改成每個查詢先算一次可見集合。
import { describe, expect, it } from 'vitest'
import { withSuperuser } from './helpers'

/** 不看列內容、同一個查詢裡結果不變的判斷：要寫成 (select public.xxx())，讓 Postgres 只算一次。 */
const PER_QUERY = ['is_audit_admin', 'is_system_maintainer', 'can_manage_access', 'can_read_all', 'current_audit_role', 'current_emp_id',
  // 稽核人員維護負責廠區（Q144）。
  'is_audit_staff', 'can_read_settings', 'can_add_assessing_unit', 'my_staff_plant_ids']

describe('RLS 的身分判斷每個查詢只算一次', () => {
  it('has no policy that calls the signed-in user’s role per row', async () => {
    const rows = await withSuperuser(async (sql) =>
      (
        await sql.query<{ policy: string; expr: string }>(
          `select tablename || '.' || policyname as policy, e.expr
           from pg_policies, unnest(array[qual, with_check]) as e(expr)
           where schemaname = 'public' and e.expr is not null`,
        )
      ).rows,
    )
    // pg_policies 把 (select f()) 印成「SELECT f() AS f」：前面不是 SELECT 的呼叫就是每列都算。名稱前面不能是字元或
    // 「.」，「SELECT public.f()」才不會從 f 那裡再比對一次。和 migration 20261108000000 的 pattern 相同。
    const perRow = new RegExp(`(?<!SELECT )(?<![\\w.])(public\\.)?(${PER_QUERY.join('|')})\\(\\)`)
    const offenders = rows.filter((r) => perRow.test(r.expr)).map((r) => `${r.policy}: ${r.expr}`)
    expect(rows.length).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })

  it('has no read policy that calls a function with the row’s columns', async () => {
    const { policies, functions } = await withSuperuser(async (sql) => ({
      policies: (
        await sql.query<{ policy: string; expr: string }>(
          `select tablename || '.' || policyname as policy, qual as expr
           from pg_policies where schemaname = 'public' and cmd = 'SELECT' and qual is not null`,
        )
      ).rows,
      functions: (
        await sql.query<{ name: string }>(
          `select distinct proname as name from pg_proc where pronamespace = 'public'::regnamespace and pronargs > 0`,
        )
      ).rows.map((r) => r.name),
    }))
    const perRow = new RegExp(`(?<![\\w.])(public\\.)?(${functions.join('|')})\\(`)
    expect(policies.filter((p) => perRow.test(p.expr)).map((p) => `${p.policy}: ${p.expr}`)).toEqual([])
    expect(policies.filter((p) => p.expr.includes('my_visible_assessment_ids')).length).toBe(8)
    expect(policies.filter((p) => p.expr.includes('my_visible_answer_units')).length).toBe(2)
  })
})
