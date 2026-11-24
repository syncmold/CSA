// 放行名單 (Q97, #56): CSA's own access list, asked by the exchange through is_admitted as service_role.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, depsFor, exchangeAs, loginAs, ok, promoteToAuditAdmin, requirePostgrest, restClient } from './helpers'

const RUN = `T${Date.now().toString(36).toUpperCase()}`
const EMP = { listed: `${RUN}A`, unlisted: `${RUN}B`, admin: `${RUN}C` }

beforeAll(async () => {
  await requirePostgrest()
  for (const id of Object.values(EMP)) {
    const r = await exchangeAs(id, id)
    if (!r.ok) throw new Error(`seed exchange failed for ${id}: ${r.error}`)
  }
  await promoteToAuditAdmin(EMP.admin)
  ok(await admin.from('access_allowlist').insert({ emp_id: EMP.listed, note: 'test' }))
})

afterAll(async () => {
  await admin.from('access_allowlist').delete().in('emp_id', Object.values(EMP))
})

describe('放行名單', () => {
  it('the exchange admits a listed 工號, whatever its case or spacing, and nobody else', async () => {
    const deps = depsFor(EMP.listed, EMP.listed)
    expect(await deps.csa.isAdmitted(EMP.listed)).toBe(true)
    expect(await deps.csa.isAdmitted(` ${EMP.listed.toLowerCase()} `)).toBe(true)
    expect(await deps.csa.isAdmitted(EMP.unlisted)).toBe(false)
  })

  it('stores 工號 upper-case and trimmed only', async () => {
    const { error } = await admin.from('access_allowlist').insert({ emp_id: ` ${EMP.unlisted.toLowerCase()}` })
    expect(error?.code).toBe('23514')
  })

  it('a signed-in employee cannot ask is_admitted or change the list', async () => {
    const me = await loginAs(EMP.unlisted, EMP.unlisted)
    const asked = await me.rpc('is_admitted', { p_emp_id: EMP.listed })
    expect(asked.error?.code).toBe('42501')
    const { error } = await me.from('access_allowlist').insert({ emp_id: EMP.unlisted })
    expect(error?.code).toBe('42501')
  })

  it('an anonymous request can neither ask nor read', async () => {
    const anon = restClient(async () => null)
    expect((await anon.rpc('is_admitted', { p_emp_id: EMP.listed })).error?.code).toBe('42501')
    expect((await anon.from('access_allowlist').select('emp_id')).error?.code).toBe('42501')
  })

  it('a 稽核管理者 can read the list; a signer sees nothing', async () => {
    const chief = await loginAs(EMP.admin, EMP.admin)
    const seen = ok(await chief.from('access_allowlist').select('emp_id').in('emp_id', Object.values(EMP)))
    expect(seen).toEqual([{ emp_id: EMP.listed }])
    const signer = await loginAs(EMP.unlisted, EMP.unlisted)
    expect(ok(await signer.from('access_allowlist').select('emp_id'))).toEqual([])
  })
})
