import { describe, expect, it } from 'vitest'
import { omsPeopleDepsFromEnv, readExchangeEnv } from './deps'
import { OmsChannelError, type ChannelRow, type OmsChannel } from './omsChannel'
import { MAX_LOOKUP, omsPeople, omsPeopleResponse, type OmsPeopleDeps } from './omsPeople'

// 用工號查人 (#218): the CSA backend asks OMS's channel about complete 工號 for someone who manages people. Made-up people.

const row = (asked: string, over: Partial<ChannelRow> = {}): ChannelRow => ({
  asked, found: true, emp_id: asked, status: '在職', factory_code: 'SY', posting_factory: null, concurrent_factories: [],
  name: '王小明', has_account: true, account_active: true, csa: true, ...over,
})

function fake(people: Record<string, Partial<ChannelRow>>, limit: number | null = 200) {
  const asked: string[][] = []
  const recorded: { emp_id: string; name: string }[][] = []
  const channel: OmsChannel = async (ids) => {
    asked.push([...ids])
    return new Map(ids.flatMap((id) => (people[id] ? [[id, row(id, people[id])] as const] : [[id, { ...row(id), found: false, name: null, status: null }] as const])))
  }
  const deps: OmsPeopleDeps = { lookupLimit: async () => limit, channel, recordPeople: async (p) => void recorded.push(p), csaRequired: false }
  return { deps, asked, recorded }
}

describe('omsPeople', () => {
  it('answers each distinct 工號 in upper case: name and 廠區 only for someone 在職, and keeps those names in CSA', async () => {
    const { deps, asked, recorded } = fake({
      SY0140: { name: '李大華' },
      FQ0031: { name: '陳小美', factory_code: 'FQ', csa: false },
      SY1352: { status: '離職', name: '已離職的人' },
      SY1400: { status: '留停', name: '留停的人' },
      SY1500: { status: '轉調', name: '舊工號' },
    })
    const result = await omsPeople('token', { emp_ids: ['sy0140', ' SY0140 ', 'FQ0031', 'SY1352', 'SY1400', 'SY1500', 'ZZ0000', ''] }, deps)
    expect(asked).toEqual([['SY0140', 'FQ0031', 'SY1352', 'SY1400', 'SY1500', 'ZZ0000']])
    expect(result).toEqual({
      ok: true,
      csaRequired: false,
      people: [
        { asked: 'SY0140', emp_id: 'SY0140', status: 'active', name: '李大華', factory_code: 'SY', csa: true, other_plant: false },
        { asked: 'FQ0031', emp_id: 'FQ0031', status: 'active', name: '陳小美', factory_code: 'FQ', csa: false, other_plant: false },
        // Not 在職: no name, no 廠區, whatever OMS sent.
        { asked: 'SY1352', emp_id: 'SY1352', status: 'departed', name: null, factory_code: null, csa: false, other_plant: false },
        { asked: 'SY1400', emp_id: 'SY1400', status: 'on_leave', name: null, factory_code: null, csa: false, other_plant: false },
        { asked: 'SY1500', emp_id: 'SY1500', status: 'transferred', name: null, factory_code: null, csa: false, other_plant: false },
        { asked: 'ZZ0000', emp_id: 'ZZ0000', status: 'not_found', name: null, factory_code: null, csa: false, other_plant: false },
      ],
    })
    expect(recorded).toEqual([[{ emp_id: 'SY0140', name: '李大華' }, { emp_id: 'FQ0031', name: '陳小美' }]])
  })

  it('refuses whoever the database says may not look people up, before asking OMS', async () => {
    for (const [token, allowed, expected] of [
      ['token', 0, { ok: false, status: 403, error: 'not_allowed' }],
      ['expired', null, { ok: false, status: 401, error: 'not_signed_in' }],
      ['', 200, { ok: false, status: 401, error: 'not_signed_in' }],
    ] as const) {
      const { deps, asked, recorded } = fake({ SY0140: {} }, allowed)
      expect(await omsPeople(token, { emp_ids: ['SY0140'] }, deps)).toEqual(expected)
      expect(asked).toEqual([])
      expect(recorded).toEqual([])
    }
  })

  it('refuses a malformed or oversized request, and records nothing when nobody is found', async () => {
    const { deps, recorded } = fake({})
    const bad = { ok: false, status: 400, error: 'invalid_request' }
    expect(await omsPeople('token', {}, deps)).toEqual(bad)
    expect(await omsPeople('token', { emp_ids: [1] }, deps)).toEqual(bad)
    expect(await omsPeople('token', { emp_ids: Array.from({ length: MAX_LOOKUP + 1 }, (_, i) => `SY${i}`) }, deps)).toEqual(bad)
    expect(await omsPeople('token', { emp_ids: ['ZZ0000'] }, deps)).toMatchObject({ ok: true, people: [{ status: 'not_found' }] })
    expect(recorded).toEqual([])
  })

  it('answers no more 工號 at once than the database allows the caller, without asking OMS', async () => {
    const { deps, asked } = fake({ SY0140: {}, SY0141: {} }, 1)
    expect(await omsPeople('token', { emp_ids: ['SY0140', 'SY0141'] }, deps)).toEqual({ ok: false, status: 400, error: 'too_many' })
    expect(asked).toEqual([])
    expect(await omsPeople('token', { emp_ids: ['SY0140', 'sy0140'] }, deps)).toMatchObject({ ok: true })
  })

  it('says who is of another 廠區 when asked for one (主檔, 派駐 and 兼管 all count), and whether CSA is required yet', async () => {
    const { deps } = fake({
      SY0140: {}, FQ0031: { factory_code: 'FQ' }, FQ0032: { factory_code: 'FQ', posting_factory: 'SY' }, FQ0033: { factory_code: 'FQ', concurrent_factories: ['GT', 'SY'] },
    })
    const ids = ['SY0140', 'FQ0031', 'FQ0032', 'FQ0033', 'ZZ0000']
    const other = async (body: object, d = deps) => {
      const result = await omsPeople('token', body, d)
      return result.ok ? result.people.map((p) => p.other_plant) : result
    }
    expect(await other({ emp_ids: ids, factory_code: 'SY' })).toEqual([false, true, false, false, false])
    expect(await other({ emp_ids: ids, factory_code: 'OTHER' })).toEqual([false, false, false, false, false]) // 其他廠區: anyone 在職 (Q139)
    expect(await other({ emp_ids: ids })).toEqual([false, false, false, false, false])
    expect(await other({ emp_ids: ids, factory_code: 7 })).toEqual({ ok: false, status: 400, error: 'invalid_request' })
    expect(await omsPeople('token', { emp_ids: ids }, { ...deps, csaRequired: true })).toMatchObject({ ok: true, csaRequired: true })
  })

  it('keeps the 工號 as OMS writes it, and still answers when the names cannot be kept', async () => {
    const { deps, recorded } = fake({ AB12: { emp_id: 'Ab12', name: '混寫' } })
    expect(await omsPeople('token', { emp_ids: ['ab12'] }, deps)).toMatchObject({ ok: true, people: [{ asked: 'AB12', emp_id: 'Ab12', name: '混寫' }] })
    expect(recorded).toEqual([[{ emp_id: 'Ab12', name: '混寫' }]])
    const broken: OmsPeopleDeps = { ...deps, recordPeople: () => Promise.reject(new Error('database down')) }
    expect(await omsPeople('token', { emp_ids: ['ab12'] }, broken)).toMatchObject({ ok: true, people: [{ emp_id: 'Ab12' }] })
  })

  it('answers over HTTP, with the reason when OMS cannot answer', async () => {
    const body = async () => ({ emp_ids: ['SY0140'] })
    const { deps } = fake({ SY0140: {} })
    expect(await omsPeopleResponse('Bearer token', body, deps)).toEqual({
      status: 200, body: { people: [{ asked: 'SY0140', emp_id: 'SY0140', status: 'active', name: '王小明', factory_code: 'SY', csa: true, other_plant: false }], csa_required: false },
    })
    expect(await omsPeopleResponse('Bearer token', () => Promise.reject(new SyntaxError('bad')), deps)).toEqual({ status: 400, body: { error: 'invalid json' } })
    const limited: OmsPeopleDeps = { ...deps, channel: () => Promise.reject(new OmsChannelError('oms_rate_limited')) }
    expect(await omsPeopleResponse('Bearer token', body, limited)).toEqual({ status: 502, body: { error: 'oms_rate_limited' } })
    const broken: OmsPeopleDeps = { ...deps, lookupLimit: () => Promise.reject(new Error('database down')) }
    expect(await omsPeopleResponse('Bearer token', body, broken)).toEqual({ status: 502, body: { error: 'lookup_failed' } })
  })

  it("asks the database with the caller's own token, and keeps names with a service token", async () => {
    const calls: { url: string; auth: string; body: unknown }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization ?? ''
      calls.push({ url, auth, body: JSON.parse(String(init.body)) })
      if (auth === 'Bearer bad') return new Response('{}', { status: 401 })
      return new Response(JSON.stringify(auth === 'Bearer manager' ? 200 : 0), { status: 200 })
    }) as typeof fetch
    const env = readExchangeEnv({ CSA_REST_URL: 'http://rest.test/', CSA_REST_APIKEY: 'anon', CSA_JWT_SECRET: 'x'.repeat(32) })
    const real = omsPeopleDepsFromEnv(env, fetchImpl)
    expect(await real.lookupLimit('manager')).toBe(200)
    expect(await real.lookupLimit('someone')).toBe(0)
    expect(await real.lookupLimit('bad')).toBeNull()
    expect(calls[0]).toEqual({ url: 'http://rest.test/rpc/people_lookup_limit', auth: 'Bearer manager', body: {} })
    await real.recordPeople([{ emp_id: 'SY0140', name: '李大華' }])
    const record = calls.at(-1)!
    expect(record.url).toBe('http://rest.test/rpc/record_people')
    expect(record.body).toEqual({ p_people: [{ emp_id: 'SY0140', name: '李大華' }] })
    expect(record.auth).not.toBe('Bearer manager')
    // No key in the settings: OMS is not asked at all.
    await expect(real.channel(['SY0140'])).rejects.toMatchObject({ code: 'oms_not_configured' })
  })
})
