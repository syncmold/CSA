// npm run dev:all — one command: migrations, PostgREST, Vite.
import { spawn, spawnSync } from 'node:child_process'
import { startPostgrest } from './postgrest.mjs'

const migrate = spawnSync(process.execPath, ['scripts/db/migrate.mjs'], { stdio: 'inherit' })
if (migrate.status !== 0) process.exit(migrate.status ?? 1)

const postgrest = startPostgrest()
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' })

const stop = () => {
  postgrest.kill()
  vite.kill()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
vite.on('exit', (code) => {
  postgrest.kill()
  process.exit(code ?? 0)
})
