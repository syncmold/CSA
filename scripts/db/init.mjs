// npm run db:init — create the CSA database, the PostgREST login role and the 草稿途徑 login role (csa_drafter, Q90).
// Idempotent: safe to rerun. Needs a superuser connection (CSA_DB_ADMIN_URL).
import pg from 'pg'
import { required } from './env.mjs'

const adminUrl = required('CSA_DB_ADMIN_URL')
const dbUrl = new URL(required('CSA_DB_URL'))
const dbName = dbUrl.pathname.replace(/^\//, '')
const authenticatorUser = decodeURIComponent(dbUrl.username)
const authenticatorPassword = decodeURIComponent(dbUrl.password)

if (!dbName || !authenticatorUser || !authenticatorPassword) {
  console.error('CSA_DB_URL must look like postgres://authenticator:<password>@host:5432/<database>')
  process.exit(1)
}

const admin = new pg.Client({ connectionString: adminUrl })
await admin.connect()

const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [dbName])
if (rowCount === 0) {
  await admin.query(`create database ${admin.escapeIdentifier(dbName)}`)
  console.log(`created database ${dbName}`)
} else {
  console.log(`database ${dbName} already exists`)
}

const role = await admin.query('select 1 from pg_roles where rolname = $1', [authenticatorUser])
if (role.rowCount === 0) {
  await admin.query(`create role ${admin.escapeIdentifier(authenticatorUser)} login noinherit password ${admin.escapeLiteral(authenticatorPassword)}`)
  console.log(`created role ${authenticatorUser}`)
} else {
  await admin.query(`alter role ${admin.escapeIdentifier(authenticatorUser)} with login noinherit password ${admin.escapeLiteral(authenticatorPassword)}`)
  console.log(`role ${authenticatorUser} already exists; password synced from CSA_DB_URL`)
}
// 草稿途徑 (Q90)：csa_drafter 只能執行草稿函式（權限在 migration 裡給）；這裡只負責它能以 CSA_DRAFTER_PASSWORD 登入。
// 角色是整個 Postgres 共用的，每個 worktree 的 .env 都用同一個密碼即可。
const drafterUser = 'csa_drafter'
const drafterPassword = required('CSA_DRAFTER_PASSWORD')
const drafterRole = await admin.query('select 1 from pg_roles where rolname = $1', [drafterUser])
const drafterAttrs = `login noinherit password ${admin.escapeLiteral(drafterPassword)}`
await admin.query(
  drafterRole.rowCount === 0
    ? `create role ${admin.escapeIdentifier(drafterUser)} ${drafterAttrs}`
    : `alter role ${admin.escapeIdentifier(drafterUser)} with ${drafterAttrs}`,
)
console.log(drafterRole.rowCount === 0 ? `created role ${drafterUser}` : `role ${drafterUser} already exists; password synced from CSA_DRAFTER_PASSWORD`)
await admin.end()
console.log('db:init done. Next: npm run db:migrate')
