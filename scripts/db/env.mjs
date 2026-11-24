// Shared helpers for the database scripts: load .env and read settings.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

if (existsSync('.env')) process.loadEnvFile('.env')

export function required(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in (see README › 本機開發).`)
    process.exit(1)
  }
  return value
}

export function optional(name, fallback) {
  return process.env[name] ?? fallback
}

/** Where pg_dump and pg_restore are: PG_BIN_DIR in .env, else the newest PostgreSQL install on this Windows machine. */
export function pgBin() {
  if (process.env.PG_BIN_DIR) return process.env.PG_BIN_DIR
  const root = 'C:\\Program Files\\PostgreSQL'
  const versions = existsSync(root) ? readdirSync(root).filter((v) => /^\d+$/.test(v)).sort((a, b) => b - a) : []
  if (!versions.length) {
    console.error('找不到 pg_dump、pg_restore；請在 .env 設 PG_BIN_DIR')
    process.exit(1)
  }
  return join(root, versions[0], 'bin')
}
