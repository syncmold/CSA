import { jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'
import { ADMIN_EMAIL } from './adminAccount'
import { devLoginAs, exchange, type ExchangeDeps, type EmployeeRef } from './core'
import { OmsChannelError, type ChannelRow, type OmsChannel } from './omsChannel'

// 本機換證 (OPEN-2 / OPEN-4 暫行做法): an OMS access token goes in, an CSA
// session token signed with the CSA project's JWT secret comes out, carrying
// emp_id in app_metadata so RLS can use it.

const SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'
const NOW = new Date('2026-10-14T08:00:00Z')

/** OMS's channel answering for one made-up person (#218); any other 工號 is not found. */
function channelOf(person: Partial<ChannelRow> = {}): OmsChannel {
  return async (ids) =>
    new Map(
      ids.map((id) => {
        const asked = id.trim().toUpperCase()
        const row: ChannelRow = {
          asked, found: true, emp_id: 'FQ0123', status: '在職', factory_code: 'FQ', posting_factory: null, concurrent_factories: [],
          name: '王小明', has_account: true, account_active: true, csa: true, ...person,
        }
        return [asked, asked === row.emp_id?.toUpperCase() ? row : { ...row, found: false, emp_id: null, status: null, name: null, factory_code: null }]
      }),
    )
}

function fakeDeps(
  overrides: Partial<ExchangeDeps['oms']> = {},
  config: Partial<ExchangeDeps['config']> = {},
  allowlist: string[] = [],
) {
  const recorded: EmployeeRef[] = []
  /** CSA's 員工參照 as record_login keeps it: a missing 姓名 or 廠區 leaves the old one. */
  const kept = new Map<string, EmployeeRef>()
  const deps: ExchangeDeps = {
    oms: {
      getUser: async (token) => (token === 'good-oms-token' ? { id: 'uuid-1', email: 'fq0123@id.syncmold.com.tw' } : null),
      getProfile: async () => ({ emp_id: 'FQ0123', name: '王小明', active: true, role: 'viewer' }),
      channel: channelOf(),
      ...overrides,
    },
    csa: {
      recordEmployee: async (ref) => {
        recorded.push(ref)
        const before = kept.get(ref.emp_id)
        const now = { emp_id: ref.emp_id, name: ref.name ?? before?.name ?? null, factory_code: ref.factory_code ?? before?.factory_code ?? null }
        kept.set(ref.emp_id, now)
        return { name: now.name, factory_code: now.factory_code }
      },
      isAdmitted: async (empId) => allowlist.includes(empId),
    },
    config: { accessAll: true, jwtSecret: SECRET, tokenTtlSeconds: 3600, devLogin: false, ...config },
    now: () => NOW,
  }
  return { deps, recorded }
}

describe('exchange', () => {
  it('turns a valid OMS token into an CSA session token carrying emp_id', async () => {
    const { deps } = fakeDeps()
    const result = await exchange('good-oms-token', deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Verify against the same fixed clock the exchange signed with, or this test expires an hour after NOW.
    const { payload } = await jwtVerify(result.csaToken, new TextEncoder().encode(SECRET), { currentDate: NOW })
    expect(payload.sub).toBe('uuid-1')
    expect(payload.role).toBe('authenticated')
    expect(payload.app_metadata).toMatchObject({ emp_id: 'FQ0123', name: '王小明', factory_code: 'FQ' })
    expect(payload.exp).toBe(Math.floor(NOW.getTime() / 1000) + 3600)
    expect(result.employee).toEqual({ emp_id: 'FQ0123', name: '王小明', factory_code: 'FQ' })
  })

  it('records the employee reference in CSA after a successful exchange', async () => {
    const { deps, recorded } = fakeDeps()
    await exchange('good-oms-token', deps)
    expect(recorded).toEqual([{ emp_id: 'FQ0123', name: '王小明', factory_code: 'FQ' }])
  })

  it('rejects an invalid OMS token with 401', async () => {
    const { deps, recorded } = fakeDeps()
    expect(await exchange('bad-token', deps)).toEqual({ ok: false, status: 401, error: 'oms_token_invalid' })
    expect(recorded).toEqual([])
  })

  it('blocks a disabled OMS account', async () => {
    const { deps } = fakeDeps({
      getProfile: async () => ({ emp_id: 'FQ0123', name: '王小明', active: false, role: 'viewer' }),
    })
    expect(await exchange('good-oms-token', deps)).toEqual({ ok: false, status: 403, error: 'account_disabled' })
  })

  it('blocks an account with no OMS profile', async () => {
    const { deps } = fakeDeps({ getProfile: async () => null })
    expect(await exchange('good-oms-token', deps)).toEqual({ ok: false, status: 403, error: 'profile_not_found' })
  })

  it('with 全開 off, only emp_ids on CSA 自己的放行名單 get in (Q97)', async () => {
    const blocked = fakeDeps({}, { accessAll: false }, ['SH0001'])
    expect(await exchange('good-oms-token', blocked.deps)).toEqual({ ok: false, status: 403, error: 'not_authorized' })
    expect(blocked.recorded).toEqual([])

    const allowed = fakeDeps({}, { accessAll: false }, ['SH0001', 'FQ0123'])
    expect((await exchange('good-oms-token', allowed.deps)).ok).toBe(true)
  })

  it('with 全開 on, does not consult the 放行名單', async () => {
    const { deps } = fakeDeps()
    deps.csa.isAdmitted = async () => {
      throw new Error('must not be asked')
    }
    expect((await exchange('good-oms-token', deps)).ok).toBe(true)
  })

  it("takes 姓名 and 廠區 from OMS's 主檔 through the channel, asked once for the profile's 工號 (#218)", async () => {
    const asked: string[][] = []
    const { deps, recorded } = fakeDeps({
      getProfile: async () => ({ emp_id: 'FQ0123', name: 'Wang', active: true, role: 'viewer' }),
      channel: async (ids) => (asked.push([...ids]), channelOf({ name: '王小明', factory_code: 'SY' })(ids)),
    })
    const result = await exchange('good-oms-token', deps)
    expect(asked).toEqual([['FQ0123']])
    expect(result.ok && result.employee).toEqual({ emp_id: 'FQ0123', name: '王小明', factory_code: 'SY' })
    expect(recorded).toEqual([{ emp_id: 'FQ0123', name: '王小明', factory_code: 'SY' }])
  })

  it('a renewal does not ask the channel: the session carries the 姓名 and 廠區 CSA kept at sign-in (Q133 (6))', async () => {
    let asked = 0
    const { deps } = fakeDeps({ channel: async (ids) => (asked++, channelOf({ name: '王小明', factory_code: 'SY' })(ids)) })
    await exchange('good-oms-token', deps)
    const renewed = await exchange('good-oms-token', deps, { renewal: true })
    expect(asked).toBe(1)
    if (!renewed.ok) throw new Error(renewed.error)
    expect(renewed.employee).toEqual({ emp_id: 'FQ0123', name: '王小明', factory_code: 'SY' })
    const { payload } = await jwtVerify(renewed.csaToken, new TextEncoder().encode(SECRET), { currentDate: NOW })
    expect(payload.app_metadata).toMatchObject({ factory_code: 'SY' })
  })

  it('a sign-in the channel cannot answer keeps the 廠區 CSA already has, in the session too', async () => {
    let failing = false
    const { deps } = fakeDeps({
      channel: async (ids) => {
        if (failing) throw new OmsChannelError('oms_rate_limited')
        return channelOf({ factory_code: 'SY' })(ids)
      },
    })
    await exchange('good-oms-token', deps)
    failing = true
    expect(await exchange('good-oms-token', deps)).toMatchObject({ ok: true, employee: { factory_code: 'SY' } })
  })

  it('still signs in when OMS does not know the 工號 or the channel cannot answer: the profile name, no 廠區', async () => {
    const unknown = fakeDeps({ channel: channelOf({ emp_id: 'SOMEONE-ELSE' }) })
    expect(await exchange('good-oms-token', unknown.deps)).toMatchObject({ ok: true, employee: { emp_id: 'FQ0123', name: '王小明', factory_code: null } })

    for (const code of ['oms_not_configured', 'oms_rate_limited', 'oms_match_failed'] as const) {
      const failing = fakeDeps({
        getProfile: async () => ({ emp_id: 'FQ0123', name: 'Wang', active: true, role: 'viewer' }),
        channel: async () => {
          throw new OmsChannelError(code)
        },
      })
      const result = await exchange('good-oms-token', failing.deps)
      expect(result, code).toMatchObject({ ok: true, employee: { emp_id: 'FQ0123', name: 'Wang', factory_code: null } })
      expect(failing.recorded, code).toEqual([{ emp_id: 'FQ0123', name: 'Wang', factory_code: null }])
    }
  })
})

// 管理員帳號 (Q122 (5), #161): OMS's 系統管理帳號 has no 工號 there; it is known by its Email, as GHG does.
describe('the 管理員帳號', () => {
  /** OMS's real row for it (2026-11-11): no 工號, role admin. */
  const adminAccount = (overrides: Partial<ExchangeDeps['oms']> = {}) => ({
    getUser: async () => ({ id: 'uuid-admin', email: ADMIN_EMAIL }),
    getProfile: async () => ({ emp_id: null, name: 'DTO', active: true, role: 'admin' }),
    channel: async () => {
      throw new Error('not an employee: must not be looked up')
    },
    ...overrides,
  })

  it('gets in with no 工號 and off the 放行名單, its session marked admin_account, and writes no employee_ref', async () => {
    const { deps, recorded } = fakeDeps(adminAccount(), { accessAll: false }, [])
    deps.csa.isAdmitted = async () => {
      throw new Error('must not be asked')
    }
    const result = await exchange('good-oms-token', deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { payload } = await jwtVerify(result.csaToken, new TextEncoder().encode(SECRET), { currentDate: NOW })
    expect(payload.sub).toBe('uuid-admin')
    expect(payload.app_metadata).toEqual({
      emp_id: 'admin', name: '管理員帳號', factory_code: null, oms_role: 'admin', source: 'oms', admin_account: true,
    })
    expect(result.employee).toEqual({ emp_id: 'admin', name: '管理員帳號', factory_code: null })
    expect(recorded).toEqual([])
  })

  it('is known by the Email OMS verified, whatever its case', async () => {
    const { deps } = fakeDeps(adminAccount({ getUser: async () => ({ id: 'uuid-admin', email: 'Admin@ID.syncmold.com.tw' }) }))
    expect(await exchange('good-oms-token', deps)).toMatchObject({ ok: true, employee: { emp_id: 'admin' } })
  })

  it('is still blocked when OMS disables it or has no profile for it', async () => {
    const disabled = fakeDeps(adminAccount({ getProfile: async () => ({ emp_id: null, name: 'DTO', active: false, role: 'admin' }) }))
    expect(await exchange('good-oms-token', disabled.deps)).toEqual({ ok: false, status: 403, error: 'account_disabled' })
    const missing = fakeDeps(adminAccount({ getProfile: async () => null }))
    expect(await exchange('good-oms-token', missing.deps)).toEqual({ ok: false, status: 403, error: 'profile_not_found' })
  })

  it('an employee signing in from the 管理員 face is just an employee: the 放行名單 applies and no admin_account', async () => {
    const blocked = fakeDeps({}, { accessAll: false }, [])
    expect(await exchange('good-oms-token', blocked.deps)).toEqual({ ok: false, status: 403, error: 'not_authorized' })
    const allowed = fakeDeps({}, { accessAll: false }, ['FQ0123'])
    const result = await exchange('good-oms-token', allowed.deps)
    if (!result.ok) throw new Error(result.error)
    const { payload } = await jwtVerify(result.csaToken, new TextEncoder().encode(SECRET), { currentDate: NOW })
    expect(payload.app_metadata).not.toHaveProperty('admin_account')
  })

  it('a 工號 of "admin" from OMS does not make anyone the 管理員帳號', async () => {
    const { deps } = fakeDeps({ getProfile: async () => ({ emp_id: 'admin', name: '某人', active: true, role: 'viewer' }) }, { accessAll: false }, [])
    expect(await exchange('good-oms-token', deps)).toEqual({ ok: false, status: 403, error: 'not_authorized' })
  })
})

// 開發期直接登入 (Q82): no password, a 工號 OMS has as 在職 (asked through the channel, #218), off unless config.devLogin.
describe('devLoginAs', () => {
  it('is refused with 404 when dev login is off, whatever the 工號', async () => {
    const { deps, recorded } = fakeDeps()
    expect(await devLoginAs('FQ0123', deps)).toEqual({ ok: false, status: 404, error: 'dev_login_disabled' })
    expect(recorded).toEqual([])
  })

  it('mints a CSA session for a 工號 OMS has as 在職, marked source=dev, and records the employee', async () => {
    const { deps, recorded } = fakeDeps({}, { devLogin: true })
    // Typed in lower case: what is stored is OMS's spelling.
    const result = await devLoginAs(' fq0123 ', deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { payload } = await jwtVerify(result.csaToken, new TextEncoder().encode(SECRET), { currentDate: NOW })
    expect(payload.role).toBe('authenticated')
    expect(payload.app_metadata).toMatchObject({ emp_id: 'FQ0123', name: '王小明', factory_code: 'FQ', source: 'dev' })
    expect(payload.sub).toMatch(/^[0-9a-f-]{36}$/)
    expect(recorded[0]).toEqual({ emp_id: 'FQ0123', name: '王小明', factory_code: 'FQ' })

    // The same 工號 always gets the same `sub`, so two dev sessions are the same person to the database.
    const again = await devLoginAs('FQ0123', deps)
    const { payload: second } = await jwtVerify(again.ok ? again.csaToken : '', new TextEncoder().encode(SECRET), { currentDate: NOW })
    expect(second.sub).toBe(payload.sub)
  })

  it('says OMS could not be asked when the channel has no key or no answer, rather than that the person is missing', async () => {
    for (const code of ['oms_not_configured', 'oms_key_rejected', 'oms_rate_limited', 'oms_match_failed'] as const) {
      const { deps, recorded } = fakeDeps({ channel: async () => { throw new OmsChannelError(code) } }, { devLogin: true })
      expect(await devLoginAs('FQ0123', deps), code).toEqual({ ok: false, status: 502, error: 'oms_unavailable' })
      expect(recorded).toEqual([])
    }
  })

  it('refuses a 工號 OMS does not have, one not 在職, and an empty one', async () => {
    const { deps, recorded } = fakeDeps({}, { devLogin: true })
    expect(await devLoginAs('ZZ9999', deps)).toEqual({ ok: false, status: 403, error: 'profile_not_found' })
    expect(await devLoginAs('   ', deps)).toEqual({ ok: false, status: 403, error: 'profile_not_found' })
    for (const status of ['離職', '留停', '轉調']) {
      const gone = fakeDeps({ channel: channelOf({ status }) }, { devLogin: true })
      expect(await devLoginAs('FQ0123', gone.deps), status).toEqual({ ok: false, status: 403, error: 'profile_not_found' })
    }
    expect(recorded).toEqual([])
  })
})
