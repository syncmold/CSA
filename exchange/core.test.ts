import { jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'
import { ADMIN_EMAIL } from './adminAccount'
import { devLoginAs, exchange, type ExchangeDeps, type EmployeeRef, type OmsAccess } from './core'
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
      getAccess: async () => ({ emp_id: 'FQ0123', name: '王小明', factory_code: 'FQ', active: true, systems: ['OMS'] }),
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
    config: { accessAll: true, jwtSecret: SECRET, tokenTtlSeconds: 3600, devLogin: false, csaRequired: false, ...config },
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
      getAccess: async () => ({ emp_id: 'FQ0123', name: '王小明', factory_code: 'FQ', active: false, systems: [] }),
    })
    expect(await exchange('good-oms-token', deps)).toEqual({ ok: false, status: 403, error: 'account_disabled' })
  })

  it('blocks an account OMS answers no oms_my_access row for', async () => {
    const { deps } = fakeDeps({ getAccess: async () => null })
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

  it("takes 姓名 and 主檔廠區 from OMS's oms_my_access row and never asks the channel (Q133 (5))", async () => {
    const { deps, recorded } = fakeDeps({
      getAccess: async () => ({ emp_id: 'FQ0123', name: '王小明', factory_code: 'SY', active: true, systems: ['OMS'] }),
      channel: async () => {
        throw new Error('the channel is not asked at sign-in')
      },
    })
    const result = await exchange('good-oms-token', deps)
    expect(result.ok && result.employee).toEqual({ emp_id: 'FQ0123', name: '王小明', factory_code: 'SY' })
    expect(recorded).toEqual([{ emp_id: 'FQ0123', name: '王小明', factory_code: 'SY' }])
  })

  it('a row OMS leaves without 姓名 or 廠區 keeps what CSA already has, in the session too', async () => {
    let row: OmsAccess = { emp_id: 'FQ0123', name: '王小明', factory_code: 'SY', active: true, systems: [] }
    const { deps, recorded } = fakeDeps({ getAccess: async () => row })
    await exchange('good-oms-token', deps)
    row = { ...row, name: ' ', factory_code: null }
    const again = await exchange('good-oms-token', deps)
    if (!again.ok) throw new Error(again.error)
    expect(again.employee).toEqual({ emp_id: 'FQ0123', name: '王小明', factory_code: 'SY' })
    const { payload } = await jwtVerify(again.csaToken, new TextEncoder().encode(SECRET), { currentDate: NOW })
    expect(payload.app_metadata).toMatchObject({ name: '王小明', factory_code: 'SY' })
    expect(recorded[1]).toEqual({ emp_id: 'FQ0123', name: null, factory_code: null })
  })
})

/** OMS's oms_my_access answering these 系統代號 for the person signing in. */
const accessWith = (systems: unknown, more: Partial<OmsAccess> = {}) => ({
  getAccess: async (): Promise<OmsAccess> => ({ emp_id: 'FQ0123', name: '王小明', factory_code: 'FQ', active: true, systems: systems as OmsAccess['systems'], ...more }),
})

describe('with CSA_REQUIRE_OMS_AUTH on, the CSA tick on the OMS 授權頁 decides who signs in (Q133 (2)(4))', () => {
  it('refuses someone OMS has not ticked CSA for, on the 放行名單 or not, 全開 or not, and records nothing', async () => {
    for (const accessAll of [true, false]) {
      const { deps, recorded } = fakeDeps(accessWith(['OMS']), { csaRequired: true, accessAll }, ['FQ0123'])
      expect(await exchange('good-oms-token', deps)).toEqual({ ok: false, status: 403, error: 'csa_not_enabled' })
      expect(recorded).toEqual([])
    }
  })

  it('lets in someone OMS has ticked CSA for without asking the 放行名單, which only carries roles now', async () => {
    const { deps, recorded } = fakeDeps(accessWith(['OMS', 'CSA']), { csaRequired: true, accessAll: false }, [])
    deps.csa.isAdmitted = async () => {
      throw new Error('must not be asked')
    }
    const result = await exchange('good-oms-token', deps)
    expect(result).toMatchObject({ ok: true, csaEnabled: true })
    expect(recorded).toEqual([{ emp_id: 'FQ0123', name: '王小明', factory_code: 'FQ' }])
  })

  it('reads the 系統代號 loosely (case, spaces, a list or one delimited text), and anything else is no tick, never an error', async () => {
    for (const systems of [['csa'], [' CSA '], ['SOP', 'Csa'], 'OMS,CSA', 'oms; csa']) {
      expect((await exchange('good-oms-token', fakeDeps(accessWith(systems), { csaRequired: true }).deps)).ok).toBe(true)
    }
    for (const systems of [null, undefined, [], ['CSA2'], ['OMS-CSA'], 'OMSCSA', { CSA: true }, 7, [null, 3]]) {
      const refused = await exchange('good-oms-token', fakeDeps(accessWith(systems), { csaRequired: true }).deps)
      expect(refused).toEqual({ ok: false, status: 403, error: 'csa_not_enabled' })
    }
  })

  it('still says a disabled account is disabled, ticked or not', async () => {
    const { deps } = fakeDeps(accessWith(['CSA'], { active: false }), { csaRequired: true })
    expect(await exchange('good-oms-token', deps)).toEqual({ ok: false, status: 403, error: 'account_disabled' })
  })
})

describe('with CSA_REQUIRE_OMS_AUTH off', () => {
  it('the 放行名單 decides as before, and the tick only rides along in the answer so an environment can be checked first', async () => {
    const unticked = await exchange('good-oms-token', fakeDeps(accessWith([]), { accessAll: false }, ['FQ0123']).deps)
    expect(unticked).toMatchObject({ ok: true, csaEnabled: false })
    const ticked = await exchange('good-oms-token', fakeDeps(accessWith(['CSA']), { accessAll: false }, ['FQ0123']).deps)
    expect(ticked).toMatchObject({ ok: true, csaEnabled: true })
    expect(await exchange('good-oms-token', fakeDeps(accessWith(['CSA']), { accessAll: false }, []).deps)).toEqual({ ok: false, status: 403, error: 'not_authorized' })
  })
})

// 管理員帳號 (Q122 (5), #161): OMS's 系統管理帳號 has no 工號 there; it is known by its Email, as GHG does.
describe('the 管理員帳號', () => {
  /** OMS's row for it: no 工號 (its oms_my_access answer is not seen yet, only its synchub_profiles row of 2026-11-11). */
  const adminAccount = (overrides: Partial<ExchangeDeps['oms']> = {}) => ({
    getUser: async () => ({ id: 'uuid-admin', email: ADMIN_EMAIL }),
    getAccess: async () => ({ emp_id: null, name: 'DTO', factory_code: null, active: true, systems: ['OMS'] }),
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
      emp_id: 'admin', name: '管理員帳號', factory_code: null, source: 'oms', admin_account: true,
    })
    expect(result.employee).toEqual({ emp_id: 'admin', name: '管理員帳號', factory_code: null })
    expect(recorded).toEqual([])
  })

  it('is not asked for the 系統代號 with CSA_REQUIRE_OMS_AUTH on: OMS ticks systems for employees (待 OMS 確認, Q133 (2))', async () => {
    const { deps } = fakeDeps(adminAccount(), { csaRequired: true, accessAll: false }, [])
    expect((await exchange('good-oms-token', deps)).ok).toBe(true)
  })

  it('is known by the Email OMS verified, whatever its case', async () => {
    const { deps } = fakeDeps(adminAccount({ getUser: async () => ({ id: 'uuid-admin', email: 'Admin@ID.syncmold.com.tw' }) }))
    expect(await exchange('good-oms-token', deps)).toMatchObject({ ok: true, employee: { emp_id: 'admin' } })
  })

  it('is still blocked when OMS disables it or answers no oms_my_access row for it', async () => {
    const disabled = fakeDeps(adminAccount({ getAccess: async () => ({ emp_id: null, name: 'DTO', factory_code: null, active: false, systems: [] }) }))
    expect(await exchange('good-oms-token', disabled.deps)).toEqual({ ok: false, status: 403, error: 'account_disabled' })
    const missing = fakeDeps(adminAccount({ getAccess: async () => null }))
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
    const { deps } = fakeDeps({ getAccess: async () => ({ emp_id: 'admin', name: '某人', factory_code: 'FQ', active: true, systems: [] }) }, { accessAll: false }, [])
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

describe('devLoginAs with CSA_REQUIRE_OMS_AUTH on', () => {
  it("asks the same of a 工號 as of a password: the channel's answer about the CSA tick", async () => {
    const unticked = fakeDeps({ channel: channelOf({ csa: false }) }, { devLogin: true, csaRequired: true })
    expect(await devLoginAs('FQ0123', unticked.deps)).toEqual({ ok: false, status: 403, error: 'csa_not_enabled' })
    expect(unticked.recorded).toEqual([])
    expect(await devLoginAs('FQ0123', fakeDeps({}, { devLogin: true, csaRequired: true }).deps)).toMatchObject({ ok: true, csaEnabled: true })
    // Off, the tick is not asked.
    expect((await devLoginAs('FQ0123', fakeDeps({ channel: channelOf({ csa: false }) }, { devLogin: true }).deps)).ok).toBe(true)
  })
})
