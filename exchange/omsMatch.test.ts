import { describe, expect, it } from 'vitest'
import { omsMatchDepsFromEnv, readExchangeEnv } from './deps'
import {
  answerOf,
  bearer,
  CHANNEL_BATCH,
  channelMatcher,
  MAX_PEOPLE,
  omsMatch,
  omsMatchResponse,
  OmsChannelError,
  type ChannelRow,
  type OmsMatchAnswer,
  type OmsMatchDeps,
  type OmsMatcher,
} from './omsMatch'
import { omsChannel } from './omsChannel'

// OMS 比對 (#180, Q130 (3)④): the CSA backend asks OMS's CSA 專用查詢通道, for one 廠區, about a batch of 工號.
// Made-up 工號 and 廠區.

const ok = (csa = true): OmsMatchAnswer => ({ status: 'matched', csa })
const asked: { factoryCode: string; empIds: readonly string[] }[] = []
const matcher: OmsMatcher = {
  match: async (factoryCode, empIds) => {
    asked.push({ factoryCode, empIds })
    return new Map<string, OmsMatchAnswer>([['FQ0031', { status: 'other_plant', csa: true }], ['SY1352', { status: 'departed', csa: false }], ['SY2211', ok(false)]])
  },
}
const deps = (allowed: boolean | null, csaRequired = false): OmsMatchDeps => ({ canAssignPlant: async () => allowed, matcher, csaRequired })

describe('omsMatch', () => {
  it('asks each 工號 once, for the 廠區 given; one OMS does not know is 不在 OMS', async () => {
    asked.length = 0
    const result = await omsMatch('token', { factory_code: 'SY', emp_ids: ['SY2211', ' SY2211 ', 'FQ0031', 'SY1352', 'SY13650', ''] }, deps(true))
    expect(asked).toEqual([{ factoryCode: 'SY', empIds: ['SY2211', 'FQ0031', 'SY1352', 'SY13650'] }])
    expect(result).toEqual({
      ok: true,
      csaRequired: false,
      results: [
        { emp_id: 'SY2211', status: 'matched', csa: false },
        { emp_id: 'FQ0031', status: 'other_plant', csa: true },
        { emp_id: 'SY1352', status: 'departed', csa: false },
        { emp_id: 'SY13650', status: 'not_found', csa: false },
      ],
    })
  })

  it('refuses whoever the database says may not assign this 廠區, and anyone without a CSA session', async () => {
    asked.length = 0
    expect(await omsMatch('token', { factory_code: 'SY', emp_ids: ['SY2211'] }, deps(false))).toEqual({ ok: false, status: 403, error: 'not_allowed' })
    expect(await omsMatch('expired', { factory_code: 'SY', emp_ids: ['SY2211'] }, deps(null))).toEqual({ ok: false, status: 401, error: 'not_signed_in' })
    expect(await omsMatch('', { factory_code: 'SY', emp_ids: ['SY2211'] }, deps(true))).toEqual({ ok: false, status: 401, error: 'not_signed_in' })
    expect(asked).toEqual([])
  })

  it('refuses a malformed or oversized batch', async () => {
    const bad = { ok: false, status: 400, error: 'invalid_request' }
    expect(await omsMatch('token', { emp_ids: ['SY2211'] }, deps(true))).toEqual(bad)
    expect(await omsMatch('token', { factory_code: 'SY', emp_ids: [1] }, deps(true))).toEqual(bad)
    const many = Array.from({ length: MAX_PEOPLE + 1 }, (_, i) => `SY${i}`)
    expect(await omsMatch('token', { factory_code: 'SY', emp_ids: many }, deps(true))).toEqual(bad)
  })

  it('answers over HTTP the same way from the Vite middleware and the Edge Function, saying whether CSA is required', async () => {
    const body = async () => ({ factory_code: 'SY', emp_ids: ['SY2211'] })
    expect(await omsMatchResponse('Bearer token', body, deps(true, true))).toEqual({
      status: 200, body: { results: [{ emp_id: 'SY2211', status: 'matched', csa: false }], csa_required: true },
    })
    expect(await omsMatchResponse('Bearer token', body, deps(false))).toEqual({ status: 403, body: { error: 'not_allowed' } })
    expect(await omsMatchResponse('Bearer token', () => Promise.reject(new SyntaxError('bad')), deps(true))).toEqual({ status: 400, body: { error: 'invalid json' } })
    const broken: OmsMatchDeps = { canAssignPlant: async () => { throw new Error('database down') }, matcher, csaRequired: false }
    expect(await omsMatchResponse('Bearer token', body, broken)).toEqual({ status: 502, body: { error: 'oms_match_failed' } })
    const limited: OmsMatchDeps = { ...deps(true), matcher: { match: () => Promise.reject(new OmsChannelError('oms_rate_limited')) } }
    expect(await omsMatchResponse('Bearer token', body, limited)).toEqual({ status: 502, body: { error: 'oms_rate_limited' } })
  })

  it('reads the bearer token of an Authorization header', () => {
    expect(bearer('Bearer abc.def')).toBe('abc.def')
    expect(bearer(undefined)).toBe('')
  })
})

/** A row as OMS's channel sends it (its reply of 2026-11-23), 在職 at SY with CSA ticked unless told otherwise. */
const row = (asked: string, over: Partial<ChannelRow> = {}): ChannelRow => ({
  asked, found: true, emp_id: asked.trim().toUpperCase(), status: '在職', factory_code: 'SY', posting_factory: null, concurrent_factories: [],
  name: '王小明', has_account: true, account_active: true, csa: true, ...over,
})
const nobody = (asked: string): ChannelRow => ({
  asked, found: false, emp_id: null, status: null, factory_code: null, posting_factory: null, concurrent_factories: null,
  name: null, has_account: null, account_active: null, csa: null,
})

describe('answerOf: one OMS row for one 廠區 (Q130 (4))', () => {
  it('is 對得上 when the 廠區 is their 主檔, 派駐 or 兼管 廠區, and 廠區不同 otherwise', () => {
    expect(answerOf(row('A'), 'SY')).toEqual(ok())
    expect(answerOf(row('A', { factory_code: 'FQ', posting_factory: 'SY' }), 'SY')).toEqual(ok())
    expect(answerOf(row('A', { factory_code: 'FQ', concurrent_factories: ['GT', 'SY'] }), 'SY')).toEqual(ok())
    expect(answerOf(row('A', { factory_code: 'FQ' }), 'SY')).toEqual({ status: 'other_plant', csa: true })
    expect(answerOf(row('A', { factory_code: 'FQ' }), 'OTHER')).toEqual(ok()) // 其他廠區 has nobody of its own (Q139)
  })

  it('says 不在 OMS, 已離職, 留停 and 轉調 apart; any other status OMS adds counts as 已離職', () => {
    expect(answerOf(nobody('A'), 'SY')).toEqual({ status: 'not_found', csa: false })
    expect(answerOf(row('A', { status: '離職' }), 'SY')).toEqual({ status: 'departed', csa: false })
    expect(answerOf(row('A', { status: '留停' }), 'SY')).toEqual({ status: 'on_leave', csa: false })
    expect(answerOf(row('A', { status: '轉調' }), 'SY')).toEqual({ status: 'transferred', csa: false })
    expect(answerOf(row('A', { status: '退休' }), 'SY')).toEqual({ status: 'departed', csa: false })
    expect(answerOf(row('A', { status: ' 在職 ' }), 'SY')).toEqual(ok())
  })

  it('lets someone use CSA only when CSA is ticked and their SyncHub account exists and is active', () => {
    expect(answerOf(row('A', { csa: false }), 'SY')).toEqual(ok(false))
    expect(answerOf(row('A', { has_account: false, account_active: null }), 'SY')).toEqual(ok(false))
    expect(answerOf(row('A', { account_active: false }), 'SY')).toEqual(ok(false))
  })
})

describe('channelMatcher: OMS’s CSA 專用查詢通道', () => {
  const URL_ = 'http://oms.test/functions/v1/csa-channel'

  /** A fake channel: answers each batch from `people`, in the order asked, and records what it was sent. */
  function channel(people: Record<string, Partial<ChannelRow> | null>, reply?: (batch: string[]) => Response) {
    const calls: { headers: Record<string, string>; ids: string[] }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(url).toBe(URL_)
      const ids = (JSON.parse(String(init.body)) as { emp_ids: string[] }).emp_ids
      calls.push({ headers: init.headers as Record<string, string>, ids })
      if (reply) return reply(ids)
      const rows = ids.map((id) => (people[id] === undefined || people[id] === null ? nobody(id) : row(id, people[id]!)))
      return new Response(JSON.stringify({ ok: true, count: rows.length, rows }), { status: 200 })
    }) as typeof fetch
    return { calls, fetchImpl }
  }

  it('sends each distinct 工號 once in upper case with the key, and answers keyed as asked', async () => {
    const { calls, fetchImpl } = channel({ SY2211: {}, FQ0031: { factory_code: 'FQ' }, SY1352: { status: '離職' } })
    const tooLong = 'S'.repeat(41) // OMS refuses a whole batch with one this long
    const answers = await channelMatcher(omsChannel(URL_, 'secret', fetchImpl)).match('SY', ['SY2211', 'sy2211', 'FQ0031', 'SY1352', 'SSA79', '王小明', tooLong])
    expect(answers).toEqual(new Map<string, OmsMatchAnswer>([
      ['SY2211', ok()], ['sy2211', ok()], ['FQ0031', { status: 'other_plant', csa: true }], ['SY1352', { status: 'departed', csa: false }],
      ['SSA79', { status: 'not_found', csa: false }], [tooLong, { status: 'not_found', csa: false }],
      ['王小明', { status: 'not_found', csa: false }], // no 工號 at all: not even asked
    ]))
    expect(calls).toEqual([{ headers: { 'x-channel-code': 'secret', 'Content-Type': 'application/json' }, ids: ['SY2211', 'FQ0031', 'SY1352', 'SSA79'] }])
  })

  it('keeps the names of those 在職 in CSA, and answers all the same when that fails', async () => {
    const { fetchImpl } = channel({ SY2211: { name: '李大華' }, SY1352: { status: '離職', name: '離職的人' } })
    const kept: { emp_id: string; name: string }[][] = []
    const matcher = channelMatcher(omsChannel(URL_, 'secret', fetchImpl), async (people) => void kept.push(people))
    expect((await matcher.match('SY', ['SY2211', 'SY1352', 'SSA79'])).get('SY2211')).toEqual(ok())
    expect(kept).toEqual([[{ emp_id: 'SY2211', name: '李大華' }]])
    const failing = channelMatcher(omsChannel(URL_, 'secret', fetchImpl), () => Promise.reject(new Error('database down')))
    expect((await failing.match('SY', ['SY2211'])).get('SY2211')).toEqual(ok())
  })

  it(`asks at most ${CHANNEL_BATCH} at a time, OMS's limit`, async () => {
    const { calls, fetchImpl } = channel({})
    const many = Array.from({ length: CHANNEL_BATCH * 2 + 1 }, (_, i) => `SY${i}`)
    expect((await channelMatcher(omsChannel(URL_, 'secret', fetchImpl)).match('SY', many)).size).toBe(many.length)
    expect(calls.map((c) => c.ids.length)).toEqual([CHANNEL_BATCH, CHANNEL_BATCH, 1])
  })

  it('fails whole, without answering for anyone, when the key is missing or OMS does not answer properly', async () => {
    const fail = async (matcher: OmsMatcher) => (await matcher.match('SY', ['SY2211']).catch((e: OmsChannelError) => e)) as OmsChannelError
    expect((await fail(channelMatcher(omsChannel(URL_, '', channel({}).fetchImpl)))).code).toBe('oms_not_configured')
    expect((await fail(channelMatcher(omsChannel('', 'secret', channel({}).fetchImpl)))).code).toBe('oms_not_configured')
    const limited = channel({}, () => new Response(JSON.stringify({ ok: false, error: 'rate_limited', max_per_24h: 5000 }), { status: 429 }))
    expect((await fail(channelMatcher(omsChannel(URL_, 'secret', limited.fetchImpl)))).code).toBe('oms_rate_limited')
    const refused = channel({}, () => new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 }))
    expect((await fail(channelMatcher(omsChannel(URL_, 'wrong', refused.fetchImpl)))).code).toBe('oms_key_rejected')
    const down = channel({}, () => new Response(JSON.stringify({ ok: false, error: 'read_failed' }), { status: 500 }))
    expect((await fail(channelMatcher(omsChannel(URL_, 'secret', down.fetchImpl)))).code).toBe('oms_match_failed')
    const swapped = channel({}, (ids) => new Response(JSON.stringify({ ok: true, count: ids.length, rows: ids.map((_, n) => row(ids[ids.length - 1 - n]!)) }), { status: 200 }))
    expect((await channelMatcher(omsChannel(URL_, 'secret', swapped.fetchImpl)).match('SY', ['SY1', 'SY2']).catch((e: OmsChannelError) => e) as OmsChannelError).code).toBe('oms_match_failed')
    const short = channel({}, () => new Response(JSON.stringify({ ok: true, count: 0, rows: [] }), { status: 200 }))
    expect((await fail(channelMatcher(omsChannel(URL_, 'secret', short.fetchImpl)))).code).toBe('oms_match_failed')
  })

  it('is built from the settings: the channel on the OMS project, its key, and CSA_REQUIRE_OMS_AUTH', async () => {
    const { calls, fetchImpl } = channel({ SY2211: { csa: false } })
    const env = readExchangeEnv({ VITE_OMS_URL: 'http://oms.test/', OMS_CHANNEL_KEY: 'secret', CSA_REST_URL: 'http://rest.test/', CSA_JWT_SECRET: 'x'.repeat(32) })
    const real = omsMatchDepsFromEnv(env, fetchImpl)
    expect(real.csaRequired).toBe(false)
    expect(await real.matcher.match('SY', ['SY2211'])).toEqual(new Map([['SY2211', ok(false)]]))
    expect(calls).toHaveLength(1)
    const required = readExchangeEnv({ CSA_REST_URL: 'http://rest.test/', CSA_JWT_SECRET: 'x'.repeat(32), CSA_REQUIRE_OMS_AUTH: 'TRUE' })
    expect(omsMatchDepsFromEnv(required, fetchImpl).csaRequired).toBe(true)
  })

  it("asks the CSA database whether the caller may assign, with the caller's own token", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const auth = (init.headers as Record<string, string>).Authorization
      if (auth === 'Bearer bad') return new Response('{}', { status: 401 })
      return new Response(JSON.stringify(auth === 'Bearer coordinator'), { status: 200 })
    }) as typeof fetch
    const env = readExchangeEnv({ CSA_REST_URL: 'http://rest.test/', CSA_REST_APIKEY: 'anon', CSA_JWT_SECRET: 'x'.repeat(32) })
    const real = omsMatchDepsFromEnv(env, fetchImpl)
    expect(await real.canAssignPlant('coordinator', 'SY')).toBe(true)
    expect(await real.canAssignPlant('someone', 'SY')).toBe(false)
    expect(await real.canAssignPlant('bad', 'SY')).toBeNull()
    expect(calls[0]!.url).toBe('http://rest.test/rpc/can_assign_plant')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ p_factory_code: 'SY' })
    expect(calls[0]!.init.headers).toMatchObject({ apikey: 'anon' })
  })
})
