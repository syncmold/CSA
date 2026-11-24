// 換證 Edge Function for the demo environments (Q97, #56). The exchange core and its deps are the same files the
// Vite dev server uses; only the HTTP shell differs (exchange/web.ts). 開發期直接登入 is never served here, and
// 放行全開 is refused: the function only starts with CSA_ACCESS_ALL=false.
// Deployed with --no-verify-jwt: the caller presents an OMS token, which this project's gateway cannot verify.
import { depsFromEnv, omsMatchDepsFromEnv, omsPeopleDepsFromEnv, readExchangeEnv } from '../../../exchange/deps.ts'
import { createWebExchangeHandler } from '../../../exchange/web.ts'

const settings = Deno.env.toObject()
const env = readExchangeEnv({
  ...settings,
  // This project's own Data API; SUPABASE_URL and SUPABASE_ANON_KEY are provided by the platform.
  CSA_REST_URL: `${settings.SUPABASE_URL}/rest/v1`,
  CSA_REST_APIKEY: settings.SUPABASE_ANON_KEY,
  CSA_DEV_LOGIN: 'false',
})
if (env.CSA_ACCESS_ALL.trim().toLowerCase() !== 'false') {
  throw new Error('CSA_ACCESS_ALL must be false in a deployed environment (Q97)')
}

// …/csa-exchange/oms-match is the OMS 比對 of 匯入分派表 (#180) and …/oms-people 用工號查人 (#218); the caller's token is
// checked by the database for both.
const handler = createWebExchangeHandler(
  depsFromEnv(env),
  { allowedOrigins: (settings.CSA_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean) },
  omsMatchDepsFromEnv(env),
  omsPeopleDepsFromEnv(env),
)

Deno.serve(handler)
