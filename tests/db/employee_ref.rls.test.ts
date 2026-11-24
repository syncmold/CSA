// 資料 API 接縫: RLS on employee_ref, exercised through the real exchange →
// CSA session token → PostgREST path (helpers.ts).
import { beforeAll, describe, expect, it } from 'vitest'
import { exchange } from '../../exchange/core'
import { admin, depsFor, exchangeAs, loginAs, promoteToAuditAdmin, requirePostgrest, restClient } from './helpers'

const RUN = `t${Date.now().toString(36)}`
const EMP = { signer: `${RUN}A`, other: `${RUN}B`, admin: `${RUN}C` }

beforeAll(async () => {
  await requirePostgrest()
  // Two signers and one 稽核管理者, written through the exchange like a real login.
  for (const [id, name] of [[EMP.signer, '甲'], [EMP.other, '乙'], [EMP.admin, '丙']] as const) {
    const r = await exchangeAs(id, name)
    if (!r.ok) throw new Error(`seed exchange failed for ${id}: ${r.error}`)
  }
  await promoteToAuditAdmin(EMP.admin)
})

describe('employee_ref RLS', () => {
  it('an employee sees only their own row', async () => {
    const me = await loginAs(EMP.signer, '甲')
    const { data, error } = await me.from('employee_ref').select('emp_id,name,factory_code,audit_role')
    expect(error).toBeNull()
    expect(data).toEqual([{ emp_id: EMP.signer, name: '甲', factory_code: 'FQ', audit_role: 'signer' }])
  })

  it('a 稽核管理者 sees every employee', async () => {
    const me = await loginAs(EMP.admin, '丙')
    const { data, error } = await me.from('employee_ref').select('emp_id').in('emp_id', Object.values(EMP))
    expect(error).toBeNull()
    expect(data?.map((r) => r.emp_id).sort()).toEqual(Object.values(EMP).sort())
  })

  it('an anonymous request gets nothing', async () => {
    const anon = restClient(async () => null)
    const { data, error } = await anon.from('employee_ref').select('emp_id')
    expect(data ?? []).toEqual([])
    expect(error?.code).toBe('42501')
  })

  it('an employee cannot promote themselves', async () => {
    const me = await loginAs(EMP.signer, '甲')
    const { error } = await me.from('employee_ref').update({ audit_role: 'audit_admin' }).eq('emp_id', EMP.signer)
    expect(error?.code).toBe('42501')
    const { data } = await admin.from('employee_ref').select('audit_role').eq('emp_id', EMP.signer).single()
    expect(data?.audit_role).toBe('signer')
  })

  it('a repeated login refreshes name and plant but keeps the audit role', async () => {
    const renamed = await exchangeAs(EMP.admin, '丙（改名）')
    expect(renamed.ok).toBe(true)
    const { data } = await admin.from('employee_ref').select('name,audit_role').eq('emp_id', EMP.admin).single()
    expect(data).toEqual({ name: '丙（改名）', audit_role: 'audit_admin' })
  })

  it('a login whose OMS row has no name or 廠區 still gets in, and keeps the 廠區 and name CSA already has, in the session too (#218)', async () => {
    const deps = depsFor(EMP.signer, '甲')
    const before = await admin.from('employee_ref').select('last_login_at').eq('emp_id', EMP.signer).single()
    const result = await exchange('fake-oms-token', {
      ...deps,
      oms: {
        ...deps.oms,
        getAccess: async () => ({ emp_id: EMP.signer, name: null, factory_code: null, active: true, systems: [] }),
      },
    })
    // The session carries what CSA kept too, so the home page still shows the 廠區.
    expect(result).toMatchObject({ ok: true, employee: { emp_id: EMP.signer, name: '甲', factory_code: 'FQ' } })
    const { data } = await admin.from('employee_ref').select('name,factory_code,last_login_at').eq('emp_id', EMP.signer).single()
    expect(data).toMatchObject({ name: '甲', factory_code: 'FQ' })
    expect(data?.last_login_at).not.toBe(before.data?.last_login_at)
  })
})
