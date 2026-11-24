// Start PostgREST for the CSA database with a config generated from .env.
// Used by `npm run db:start` (PostgREST alone) and `npm run dev:all`.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { optional, required } from './env.mjs'

/** PG_BIN_DIR from .env, else the newest C:\Program Files\PostgreSQL\<ver>\bin, else nothing. */
function postgresBinDir() {
  const configured = optional('PG_BIN_DIR', '')
  if (configured) return configured
  if (process.platform !== 'win32') return ''
  const root = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PostgreSQL')
  if (!existsSync(root)) return ''
  const versions = readdirSync(root).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a))
  const bin = versions.length ? join(root, versions[0], 'bin') : ''
  return bin && existsSync(bin) ? bin : ''
}

export function startPostgrest() {
  const bin = required('POSTGREST_BIN')
  const dbUrl = required('CSA_DB_URL')
  const secret = required('CSA_JWT_SECRET')
  const rest = new URL(optional('CSA_REST_URL', 'http://127.0.0.1:3000'))

  // PostgREST reads PGRST_* variables, so the secret never touches the disk.
  const env = {
    ...process.env,
    PGRST_DB_URI: dbUrl,
    PGRST_DB_SCHEMAS: 'public',
    PGRST_DB_ANON_ROLE: 'anon',
    PGRST_JWT_SECRET: secret,
    PGRST_SERVER_HOST: rest.hostname,
    PGRST_SERVER_PORT: String(rest.port || 3000),
    PGRST_LOG_LEVEL: 'warn',
    // The Windows build of PostgREST loads libpq.dll from PostgreSQL's bin folder,
    // which the installer does not put on PATH. Prepend it for the child only.
    PATH: [postgresBinDir(), process.env.PATH].filter(Boolean).join(delimiter),
  }
  const child = spawn(bin, [], { stdio: 'inherit', env })
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`PostgREST exited with code ${code}`)
  })
  console.log(`PostgREST → ${rest.origin}`)
  return child
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const child = startPostgrest()
  process.on('SIGINT', () => child.kill())
}
