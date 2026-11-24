import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

// Same .env as the dev server, so a worktree on another CSA_WEB_PORT tests its own Vite.
if (existsSync('.env')) process.loadEnvFile('.env')
const baseURL = `http://127.0.0.1:${process.env.CSA_WEB_PORT || 5173}`

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    locale: 'zh-TW',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
