// npm run db:migrate — apply supabase/migrations/*.sql in filename order to the
// CSA database, once each, tracked in csa_meta.schema_migrations.
// Same files the Supabase CLI applies in CI; this script just removes the
// Docker requirement (Q76).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { required } from './env.mjs'

const MIGRATIONS_DIR = 'supabase/migrations'

const dbUrl = new URL(required('CSA_DB_URL'))
const adminUrl = new URL(required('CSA_DB_ADMIN_URL'))
adminUrl.pathname = dbUrl.pathname // superuser, but on the CSA database

const client = new pg.Client({ connectionString: adminUrl.toString() })
// Migrations report data that needs a person's decision with `raise notice` (e.g. routes a rename stranded); only
// those are shown, not the bookkeeping below ("schema already exists, skipping").
let applying = null
client.on('notice', (n) => {
  if (applying) console.log(`  ${applying}: ${n.message}`)
})
await client.connect()

await client.query('create schema if not exists csa_meta')
await client.query(`
  create table if not exists csa_meta.schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )`)

const applied = new Set((await client.query('select version from csa_meta.schema_migrations')).rows.map((r) => r.version))
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()

let count = 0
for (const file of files) {
  const version = file.replace(/\.sql$/, '')
  if (applied.has(version)) continue
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
  await client.query('begin')
  try {
    applying = file
    await client.query(sql)
    applying = null
    await client.query('insert into csa_meta.schema_migrations (version) values ($1)', [version])
    await client.query('commit')
    console.log(`applied ${file}`)
    count++
  } catch (error) {
    await client.query('rollback')
    console.error(`failed in ${file}:`, error.message)
    await client.end()
    process.exit(1)
  }
}
// A running PostgREST caches the schema; tell it to reload so new tables are served without a restart.
if (count > 0) await client.query("notify pgrst, 'reload schema'")
await client.end()
console.log(count === 0 ? 'already up to date' : `applied ${count} migration(s)`)
