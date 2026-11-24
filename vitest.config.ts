import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

// Two projects: `unit` runs anywhere; `db` needs PostgREST in front of the CSA
// database (`npm run db:start`); CI runs it on plain Postgres and on a Supabase stack.
export default defineConfig(({ mode }) => ({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'exchange/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          // 共用的資料庫永遠不只一位稽核主管，稽核主管關卡不會在並行的測試檔之間連動（#190）。
          globalSetup: ['tests/db/globalSetup.ts'],
          testTimeout: 20_000,
          // Same .env the dev server uses (CSA_REST_URL, CSA_JWT_SECRET, VITE_SUPABASE_ANON_KEY).
          env: loadEnv(mode, process.cwd(), ''),
        },
      },
    ],
  },
}))
