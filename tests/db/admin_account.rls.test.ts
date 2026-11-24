// 資料 API 接縫: 管理員帳號（#161、Q122 (5)）——OMS 的系統管理帳號，以 Email 換證、session 帶 admin_account 標記；
// 權限同系統維護員，不受放行名單限制，任何身分都不能移除或降級。
// 每次執行用自己的工號（RUN 開頭），結束時移出放行名單；權限異動紀錄只新增、刪不掉，所以留著。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  admin, insertRow, loginAs, loginAsAdminAccount, ok, promoteToSystemMaintainer, requirePostgrest, restClient, withSuperuser,
} from './helpers'

const RUN = `K${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
const EMP = {
  maint: `${RUN}S`,
  newcomer: `${RUN}N`,
  signer: `${RUN}G`,
}
const ID: Record<string, string> = {}

beforeAll(async () => {
  await requirePostgrest()
  await loginAs(EMP.maint, '維')
  await promoteToSystemMaintainer(EMP.maint)
  ok(await admin.from('access_allowlist').insert({ emp_id: EMP.maint }))
  ID.template = (await insertRow('questionnaire_template', { code: `${RUN}-T`, name: `${RUN}-T 範本`, layout: 'element' })).id
})

afterAll(async () => {
  // One at a time: the database keeps at least one 系統維護員 on the list, which may be this run's own (then it stays).
  const listed = ok(await admin.from('access_allowlist').select('emp_id').like('emp_id', `${RUN}%`)) as { emp_id: string }[]
  for (const { emp_id } of listed) await admin.from('access_allowlist').delete().eq('emp_id', emp_id)
  if (ID.template) await admin.from('questionnaire_template').delete().eq('id', ID.template)
})

describe('管理員帳號登入', () => {
  it('is a 系統維護員 with no employee_ref row and off the 放行名單', async () => {
    const adminAccount = await loginAsAdminAccount()
    expect(ok(await adminAccount.rpc('current_audit_role'))).toBe('system_maintainer')
    expect(ok(await admin.from('employee_ref').select('emp_id').ilike('emp_id', 'admin'))).toEqual([])
    expect(ok(await admin.from('access_allowlist').select('emp_id').ilike('emp_id', 'admin'))).toEqual([])
  })

  it('anyone else reads their own role the same way, and a signed-out caller has none', async () => {
    expect(ok(await (await loginAs(EMP.maint, '維')).rpc('current_audit_role'))).toBe('system_maintainer')
    expect(ok(await (await loginAs(EMP.signer, '簽')).rpc('current_audit_role'))).toBe('signer')
    expect((await restClient(async () => null).rpc('current_audit_role')).data).toBeNull()
  })

  it('the 工號 admin without the session mark is nobody special', async () => {
    const role = await withSuperuser(async (sql) => {
      await sql.query('begin')
      try {
        await sql.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ role: 'authenticated', app_metadata: { emp_id: 'admin', admin_account: false } }),
        ])
        await sql.query('set local role authenticated')
        const { rows } = await sql.query('select public.current_audit_role() as role, public.is_system_maintainer() as maint')
        return rows[0]
      } finally {
        await sql.query('rollback')
      }
    })
    expect(role).toEqual({ role: null, maint: false })
  })
})

describe('管理員帳號的權限同系統維護員', () => {
  it('manages access, 系統維護員 included, and each change is logged with 工號 admin as the operator', async () => {
    const adminAccount = await loginAsAdminAccount()
    const added = await adminAccount.rpc('add_access_members', {
      p_people: [{ emp_id: EMP.newcomer, name: '新人', factory_code: 'FQ' }],
      p_role: 'viewer',
      p_viewer_plant_ids: [],
      p_note: null,
    })
    expect(added.error).toBeNull()
    ok(await adminAccount.rpc('update_access_member', { p_emp_id: EMP.newcomer, p_role: 'system_maintainer', p_viewer_plant_ids: [], p_note: null }))
    ok(await adminAccount.rpc('remove_access_member', { p_emp_id: EMP.newcomer }))
    expect(ok(await adminAccount.from('access_member').select('emp_id').eq('emp_id', EMP.maint))).toEqual([{ emp_id: EMP.maint }])

    const log = ok(
      await adminAccount.from('access_change_log').select('actor_emp_id,actor_name,action').eq('target_emp_id', EMP.newcomer).order('id'),
    )
    expect(log).toEqual([
      { actor_emp_id: 'admin', actor_name: null, action: 'added' },
      { actor_emp_id: 'admin', actor_name: null, action: 'role' },
      { actor_emp_id: 'admin', actor_name: null, action: 'removed' },
    ])
  })

  it('reads everything but changes nothing outside 權限管理 (Q122 (2))', async () => {
    const adminAccount = await loginAsAdminAccount()
    expect(ok(await adminAccount.from('questionnaire_template').select('id').eq('id', ID.template))).toEqual([{ id: ID.template }])
    expect((await adminAccount.from('questionnaire_template').update({ name: '改名' }).eq('id', ID.template)).error?.code).toBe('42501')
    expect(ok(await admin.from('questionnaire_template').select('name').eq('id', ID.template).single())).toEqual({ name: `${RUN}-T 範本` })
  })
})

describe('不能被移除或降級', () => {
  /** Run `attempt` as `who` (a 工號 signed in, service_role or the superuser) and roll back; the SQLSTATE and hint, or null. */
  async function attemptAs(who: string, attempt: string, params: unknown[] = []): Promise<string | null> {
    return withSuperuser(async (sql) => {
      await sql.query('begin')
      try {
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

  it('a 系統維護員 cannot put it on the list with a lesser role, nor give it one', async () => {
    const people = (empId: string) => JSON.stringify([{ emp_id: empId, name: null, factory_code: null }])
    for (const empId of ['admin', 'ADMIN', ' Admin ']) {
      expect(await attemptAs(EMP.maint, `select public.add_access_members($1::jsonb, 'signer', '{}', null)`, [people(empId)]), empId).toBe(
        '42501 admin_account',
      )
    }
    // It is on no list and has no role, so there is nothing to change or remove.
    expect(await attemptAs(EMP.maint, `select public.update_access_member('admin', 'signer', '{}', null)`)).not.toBeNull()
    expect(await attemptAs(EMP.maint, `select public.remove_access_member('admin')`)).toBe('P0002')
  })

  it('nor can service_role, the 部署指令 or db:set-role write its 工號 into either table', async () => {
    for (const who of ['service_role', 'superuser']) {
      for (const attempt of [
        `insert into public.access_allowlist (emp_id) values ('ADMIN')`,
        `insert into public.employee_ref (emp_id, audit_role) values ('admin', 'signer')`,
        `update public.employee_ref set emp_id = 'admin' where emp_id = $1`,
      ]) {
        const params = attempt.includes('$1') ? [EMP.signer] : []
        expect(await attemptAs(who, attempt, params), `${who}: ${attempt}`).toBe('42501 admin_account')
      }
    }
  })

  it('stays a 系統維護員 after every attempt', async () => {
    expect(ok(await (await loginAsAdminAccount()).rpc('current_audit_role'))).toBe('system_maintainer')
  })
})
