// Node adapter for the exchange core: exposes request handlers the Vite dev
// server mounts at /csa/exchange and /csa/dev-login. The demo environments run
// the same core in a Supabase Edge Function instead (web.ts, Q97).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { devLoginAs, exchange, type ExchangeDeps, type ExchangeResult } from './core'
import { omsMatchResponse, type OmsMatchDeps } from './omsMatch.ts'
import { omsPeopleResponse, type OmsPeopleDeps } from './omsPeople.ts'

// Settings → deps live in deps.ts so the Edge Function (web.ts) can share them; re-exported for existing importers.
export { DEV_DEFAULT_JWT_SECRET, depsFromEnv, mintServiceToken, omsMatchDepsFromEnv, omsPeopleDepsFromEnv, readExchangeEnv, type ExchangeEnv } from './deps.ts'

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function sendExchangeResult(res: ServerResponse, result: ExchangeResult) {
  if (!result.ok) return sendJson(res, result.status, { error: result.error })
  return sendJson(res, 200, { csa_token: result.csaToken, expires_at: result.expiresAt, employee: result.employee, csa_enabled: result.csaEnabled })
}

/** POST handler taking one string field from the JSON body; 400 on bad JSON or a missing field. */
function postStringField(field: string, run: (value: string, res: ServerResponse) => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
    let value = ''
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      value = typeof body[field] === 'string' ? (body[field] as string) : ''
    } catch {
      return sendJson(res, 400, { error: 'invalid json' })
    }
    if (!value) return sendJson(res, 400, { error: `missing ${field}` })
    try {
      await run(value, res)
    } catch (error) {
      console.error('[csa-exchange]', error)
      return sendJson(res, 502, { error: 'exchange_failed' })
    }
  }
}

/** HTTP handler: POST { oms_token } → { csa_token, expires_at, employee, csa_enabled } or { error }. */
export function createExchangeHandler(deps: ExchangeDeps) {
  const post = postStringField('oms_token', async (omsToken, res) => sendExchangeResult(res, await exchange(omsToken, deps)))
  return async (req: IncomingMessage, res: ServerResponse) => {
    // GET reports the admission mode so the login page can warn when 放行全開 is on,
    // and whether 開發期直接登入 (Q82) is available, so it can offer it; csa_required is CSA_REQUIRE_OMS_AUTH, as web.ts.
    if (req.method === 'GET') return sendJson(res, 200, { access_all: deps.config.accessAll, dev_login: deps.config.devLogin, csa_required: deps.config.csaRequired })
    return post(req, res)
  }
}

/** HTTP handler (Q82): POST { emp_id } → the same shape as the exchange; 404 unless CSA_DEV_LOGIN=true. */
export function createDevLoginHandler(deps: ExchangeDeps) {
  return postStringField('emp_id', async (empId, res) => sendExchangeResult(res, await devLoginAs(empId, deps)))
}

/** HTTP handler (#180): POST { factory_code, emp_ids } with the caller's CSA token → { results } or { error }. */
export function createOmsMatchHandler(deps: OmsMatchDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
    const { status, body } = await omsMatchResponse(req.headers.authorization, () => readJsonBody(req), deps)
    return sendJson(res, status, body)
  }
}

/** HTTP handler (#218): POST { emp_ids } with the caller's CSA token → { people } or { error }. */
export function createOmsPeopleHandler(deps: OmsPeopleDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
    const { status, body } = await omsPeopleResponse(req.headers.authorization, () => readJsonBody(req), deps)
    return sendJson(res, status, body)
  }
}
