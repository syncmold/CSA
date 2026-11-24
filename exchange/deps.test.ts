import { describe, expect, it } from 'vitest'
import { depsFromEnv, readExchangeEnv } from './deps'

// The exchange asks OMS who is signing in through OMS's own `oms_my_access` (Q133 (5)(12)), with the person's token.

const ROW = { emp_id: 'SSA78', name: '測試', factory_code: 'SY', active: true, systems: ['OMS'] }

function depsAnswering(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  const env = readExchangeEnv({
    VITE_OMS_URL: 'http://oms.test',
    VITE_OMS_ANON_KEY: 'anon',
    CSA_REST_URL: 'http://rest.test',
    CSA_JWT_SECRET: 'x'.repeat(32),
    CSA_ACCESS_ALL: 'true',
  })
  return { deps: depsFromEnv(env, fetchImpl), calls }
}

describe('getAccess', () => {
  it("POSTs to OMS's oms_my_access with the person's own token and answers their row", async () => {
    const { deps, calls } = depsAnswering(200, [ROW])
    expect(await deps.oms.getAccess('user-token')).toEqual(ROW)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://oms.test/rest/v1/rpc/oms_my_access')
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: '{}' })
    expect(calls[0]!.init.headers).toMatchObject({ apikey: 'anon', Authorization: 'Bearer user-token' })
  })

  it('is null when OMS has no row for them', async () => {
    expect(await depsAnswering(200, []).deps.oms.getAccess('user-token')).toBeNull()
  })

  it('throws when OMS fails, so the exchange answers 502 and a renewal keeps the session', async () => {
    await expect(depsAnswering(503, { message: 'down' }).deps.oms.getAccess('user-token')).rejects.toThrow('HTTP 503')
  })
})
