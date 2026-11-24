// npm run db:restore -- <備份檔>
//
// 把資料庫還原成 npm run deploy -- <環境> backup 的備份（README「退回分流前的版本」，Q116 (12)）。demo 環境經部署指令執行
// （npm run deploy -- test restore <備份檔> --yes，會先再備份一次現況）。public、csa_meta 整個換掉，所以備份之後才有的資料表與
// 函式不會留著，資料與權限都回到備份當時；備份之後的資料會消失。還原在一個交易裡，失敗就停下來，這時資料庫是空的，要重跑。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { pgBin, required } from './env.mjs'

const file = process.argv[2]
if (!file || !existsSync(file)) {
  console.error('用法：npm run db:restore -- <備份檔>')
  process.exit(2)
}

// 動資料庫之前先確認讀得出來、有存權限：backups 裡有 0 位元組的失敗備份，早期的備份沒有權限，還原後 anon 什麼都能做。
const contents = spawnSync(join(pgBin(), 'pg_restore'), ['--list', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (contents.status !== 0 || !contents.stdout.includes(' ACL ')) {
  console.error(`${file} 不能用：讀不出來，或是沒有存權限的舊備份。資料庫沒有動。`)
  process.exit(1)
}

const dbUrl = new URL(required('CSA_DB_URL'))
const adminUrl = new URL(required('CSA_DB_ADMIN_URL'))
adminUrl.pathname = dbUrl.pathname // superuser, but on the CSA database (same as migrate.mjs)
// Node's pg calls encrypt-without-verifying 'no-verify', libpq calls it 'require' (see libpqDbUrl in deploy.mjs).
const libpqUrl = new URL(adminUrl)
if (libpqUrl.searchParams.get('sslmode') === 'no-verify') libpqUrl.searchParams.set('sslmode', 'require')

const client = new pg.Client({ connectionString: adminUrl.toString() })
await client.connect()
await client.query('drop schema if exists csa_meta cascade')
await client.query('drop schema public cascade')

const restored = spawnSync(
  join(pgBin(), 'pg_restore'),
  ['--no-owner', '--single-transaction', `--dbname=${libpqUrl}`, file],
  { stdio: 'inherit' },
)
if (restored.status !== 0) {
  await client.end()
  console.error('pg_restore 失敗：資料庫現在是空的，修好原因後重跑')
  process.exit(1)
}
// A running PostgREST caches the schema; tell it to reload (same as migrate.mjs).
await client.query("notify pgrst, 'reload schema'")
const applied = (await client.query('select count(*)::int as n, max(version) as last from csa_meta.schema_migrations')).rows[0]
await client.end()
console.log(`已還原 ${file}：${applied.n} 支 migration，最後一支 ${applied.last}`)
