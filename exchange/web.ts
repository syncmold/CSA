// Fetch-API adapter for the exchange core (Q97, #56): the demo environments run it as a Supabase Edge Function
// (supabase/functions/csa-exchange), called cross-origin from the GitHub Pages site. Same contract as the Vite
// middleware in node.ts, except that 開發期直接登入 (Q82) does not exist here at all: GET always reports it off.
import { exchange, type ExchangeDeps } from './core.ts'
import { omsMatchResponse, type OmsMatchDeps } from './omsMatch.ts'
import { omsPeopleResponse, type OmsPeopleDeps } from './omsPeople.ts'

export interface WebExchangeOptions {
  /** Origins allowed to call (the site's own origin, e.g. https://csa.example.com). Others get no CORS headers. */
  allowedOrigins: string[]
}

/**
 * `matchDeps` serves POST …/oms-match (#180), the OMS 比對 of 匯入分派表, and `peopleDeps` POST …/oms-people (#218),
 * 用工號查人, on the same function.
 */
export function createWebExchangeHandler(deps: ExchangeDeps, options: WebExchangeOptions, matchDeps: OmsMatchDeps, peopleDeps: OmsPeopleDeps) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get('Origin')
    const cors: Record<string, string> =
      origin && options.allowedOrigins.includes(origin)
        ? {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
            'Access-Control-Max-Age': '600',
            Vary: 'Origin',
          }
        : { Vary: 'Origin' }
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    // The login page asks whether 放行全開 is on (to warn) and whether dev login is offered (never, here).
    if (req.method === 'GET') return json(200, { access_all: deps.config.accessAll, dev_login: false })
    if (req.method !== 'POST') return json(405, { error: 'POST only' })

    if (new URL(req.url).pathname.endsWith('/oms-match')) {
      const { status, body } = await omsMatchResponse(req.headers.get('Authorization'), () => req.json(), matchDeps)
      return json(status, body)
    }
    if (new URL(req.url).pathname.endsWith('/oms-people')) {
      const { status, body } = await omsPeopleResponse(req.headers.get('Authorization'), () => req.json(), peopleDeps)
      return json(status, body)
    }

    let omsToken = ''
    try {
      const body = (await req.json()) as Record<string, unknown>
      omsToken = typeof body.oms_token === 'string' ? body.oms_token : ''
    } catch {
      return json(400, { error: 'invalid json' })
    }
    if (!omsToken) return json(400, { error: 'missing oms_token' })

    try {
      const result = await exchange(omsToken, deps)
      if (!result.ok) return json(result.status, { error: result.error })
      return json(200, { csa_token: result.csaToken, expires_at: result.expiresAt, employee: result.employee })
    } catch (error) {
      console.error('[csa-exchange]', error)
      return json(502, { error: 'exchange_failed' })
    }
  }
}
