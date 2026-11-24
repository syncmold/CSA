import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import {
  createDevLoginHandler, createExchangeHandler, createOmsMatchHandler, createOmsPeopleHandler, depsFromEnv, omsMatchDepsFromEnv, omsPeopleDepsFromEnv,
  readExchangeEnv,
} from './exchange/node'
import packageJson from './package.json'
import { buildCommit } from './scripts/buildVersion'

/**
 * Mounts 本機換證 (and, when CSA_DEV_LOGIN=true, 開發期直接登入) on the dev server so no extra process is needed, and the
 * OMS 比對 of 匯入分派表 (#180) under the exchange, where the Edge Function serves it too.
 */
function exchangeDevMiddleware(env: Record<string, string>): Plugin {
  return {
    name: 'csa-exchange-dev-middleware',
    configureServer(server) {
      const settings = readExchangeEnv(env)
      const deps = depsFromEnv(settings)
      const exchange = createExchangeHandler(deps)
      const devLogin = createDevLoginHandler(deps)
      const omsMatch = createOmsMatchHandler(omsMatchDepsFromEnv(settings))
      const omsPeople = createOmsPeopleHandler(omsPeopleDepsFromEnv(settings))
      // Before /csa/exchange, which would otherwise take these paths as its own.
      server.middlewares.use('/csa/exchange/oms-match', (req, res) => void omsMatch(req, res))
      server.middlewares.use('/csa/exchange/oms-people', (req, res) => void omsPeople(req, res))
      server.middlewares.use('/csa/exchange', (req, res) => void exchange(req, res))
      server.middlewares.use('/csa/dev-login', (req, res) => void devLogin(req, res))
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const restUrl = env.CSA_REST_URL ?? 'http://127.0.0.1:3000'
  return {
    // A site served from a GitHub Pages project path sets VITE_BASE (e.g. /csa/); a developer PC and a root domain use /.
    base: env.VITE_BASE || '/',
    plugins: [react(), exchangeDevMiddleware(env)],
    // The 系統版本 on the 登入 card (Q123 (4)), fixed when the build (or the dev server) starts.
    define: {
      'import.meta.env.VITE_CSA_VERSION': JSON.stringify(packageJson.version),
      'import.meta.env.VITE_CSA_COMMIT': JSON.stringify(
        buildCommit(process.env, () =>
          execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
        ),
      ),
    },
    server: {
      // Bind to IPv4 explicitly: on Windows "localhost" can resolve to ::1 only,
      // which makes http://127.0.0.1:5173 (README, Playwright) unreachable.
      host: '127.0.0.1',
      // CSA_WEB_PORT lets a second worktree run its own Vite beside this one (README › 平行開發).
      port: Number(env.CSA_WEB_PORT) || 5173,
      strictPort: true,
      // supabase-js always calls <origin>/rest/v1/...; in development the dev
      // server forwards that to PostgREST, in production the reverse proxy does.
      proxy: {
        '/rest/v1': { target: restUrl, changeOrigin: true, rewrite: (path) => path.replace(/^\/rest\/v1/, '') },
      },
    },
  }
})
