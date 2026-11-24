import { expect, test, type Locator, type Page } from '@playwright/test'
import { expectLanguageButtonsOnOneLine } from './support/languageSwitcher'

// Smoke test for the login page (ticket #2). It talks to the real OMS project read-only for a wrong password. No OMS
// credentials are needed.

const OMS_HOST = 'drfqoraijhzvvllncbei.supabase.co'

function watchOmsTraffic(page: Page) {
  const writes: string[] = []
  const emailTables: string[] = []
  page.on('request', (req) => {
    const url = new URL(req.url())
    if (url.host !== OMS_HOST) return
    const isAuthToken = url.pathname === '/auth/v1/token'
    if (req.method() !== 'GET' && req.method() !== 'OPTIONS' && !isAuthToken) writes.push(`${req.method()} ${url.pathname}`)
    if (/\/rest\/v1\/(system_access|employees)(\?|$)/.test(url.pathname + url.search)) emailTables.push(url.pathname)
  })
  return { writes, emailTables }
}

const ZH_NAME = '📋 CSA 內控自評簽核系統'
const EN_NAME = '📋 CSA Internal Control Sign-off System'

test('shows the login page in 繁中 by default', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: ZH_NAME })).toBeVisible()
  await expect(page.getByLabel('工號或 Email')).toBeVisible()
  await expect(page.getByLabel('密碼')).toBeVisible()
})

test('the card reads top to bottom like the other SyncHub systems’ cards (Q123)', async ({ page }) => {
  await page.goto('/login')
  const top = async (locator: Locator) => {
    const box = await locator.boundingBox()
    if (!box) throw new Error(`not on screen: ${locator}`)
    return box.y
  }
  const order = [
    page.getByTestId('language-switcher'),
    page.getByRole('img', { name: '集團 Logo' }),
    page.getByRole('heading', { name: ZH_NAME }),
    page.getByText('Control Self-Assessment · SyncHub'),
    page.getByTestId('system-version'),
    page.getByLabel('工號或 Email'),
    page.getByLabel('密碼'),
    page.getByTestId('login-submit'),
    page.getByTestId('login-help'),
    page.getByTestId('back-to-synchub'),
    page.getByText('DIGITAL TRANSFORMATION OFFICE · 2026'),
  ]
  const tops = await Promise.all(order.map(top))
  expect(tops).toEqual([...tops].sort((a, b) => a - b))
  // package.json's version and the commit the dev server started on (Q123 (4)).
  await expect(page.getByTestId('system-version')).toHaveText(/^系統版本 v\d+\.\d+\.\d+（[0-9a-f]{7}）$/)
  await expect(page.getByTestId('login-help')).toContainText('請洽系統維護員開通 CSA')
  await expect(page.getByTestId('back-to-synchub')).toHaveText('← 回 SyncHub 信錦智匯')
})

test('switching to English sticks across a reload', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('language-switcher').getByText('English').click()
  await expect(page.getByRole('heading', { name: EN_NAME })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: EN_NAME })).toBeVisible()
})

test('the language buttons stay on one line on a narrow phone, in both languages (#137)', async ({ page }) => {
  // On a narrow phone the switcher used to sit squeezed beside the title and wrapped; it now has its own line.
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/login')
  for (const [language, heading] of [['English', EN_NAME], ['繁中', ZH_NAME]] as const) {
    await page.getByTestId('language-switcher').getByText(language, { exact: true }).click()
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    await expectLanguageButtonsOnOneLine(page)
    // Kept whole, the switcher still fits: the page does not scroll sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  }
})

test('a wrong password shows the OMS wording and never writes to OMS', async ({ page }) => {
  const traffic = watchOmsTraffic(page)
  await page.goto('/login')
  await page.getByLabel('工號或 Email').fill('ZZ9999')
  await page.getByLabel('密碼').fill('definitely-wrong')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-error')).toHaveText('帳號或密碼錯誤')
  expect(traffic.writes).toEqual([])
  expect(traffic.emailTables).toEqual([])
})

// Q133 (5), #218: OMS no longer lets anyone look people up before signing in, so the page shows no 姓名／廠區 under
// the 工號 and asks OMS nothing while it is typed.
test('typing a 工號 shows no employee hint and reads nothing from OMS', async ({ page }) => {
  const reads: string[] = []
  page.on('request', (req) => {
    const url = new URL(req.url())
    if (url.host === OMS_HOST && url.pathname.startsWith('/rest/v1/')) reads.push(url.pathname)
  })
  await page.goto('/login')
  await page.getByLabel('工號或 Email').fill('ZZ0042')
  // Longer than the old lookup's debounce, so a lookup would have gone out by now.
  await page.waitForTimeout(800)
  await expect(page.getByTestId('employee-hint')).toHaveCount(0)
  expect(reads).toEqual([])
})

// 🔑 管理員登入 (#161, Q122 (5)): the same card turns to a face for OMS's 系統管理帳號 and back.
test('🔑 管理員登入 turns the card to the 管理員 face, with the Email filled in, and back', async ({ page }) => {
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/login')
    await page.getByTestId('admin-login-link').click()
    const face = page.getByTestId('admin-face')
    await expect(face).toContainText('🔑 管理員登入')
    await expect(face).toContainText('系統管理帳號專用，不屬於任何員工')
    await expect(page.getByLabel('Email')).toHaveValue('admin@id.syncmold.com.tw')
    await expect(page.getByLabel('密碼')).toBeFocused()
    // No 工號 hint, help text or 開發期直接登入 on this face.
    for (const absent of ['employee-hint', 'login-help', 'admin-login-link', 'dev-login']) await expect(page.getByTestId(absent), absent).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}`).toBeLessThanOrEqual(width)

    await page.getByTestId('employee-login-link').click()
    await expect(page.getByTestId('admin-face')).toHaveCount(0)
    await expect(page.getByLabel('工號或 Email')).toHaveValue('')
    await expect(page.getByTestId('login-help')).toBeVisible()
  }
})

test('a wrong password on the 管理員 face shows the same wording as the employee face', async ({ page }) => {
  // OMS answers for itself, so the real 系統管理帳號 never gets a wrong password from a test.
  let asked = ''
  await page.route(`https://${OMS_HOST}/auth/v1/token**`, (route) => {
    asked = (route.request().postDataJSON() as { email: string }).email
    return route.fulfill({ status: 400, json: { error: 'invalid_grant', error_description: 'Invalid login credentials' } })
  })
  await page.goto('/login')
  await page.getByTestId('admin-login-link').click()
  await page.getByLabel('密碼').fill('definitely-wrong')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-error')).toHaveText('帳號或密碼錯誤')
  expect(asked).toBe('admin@id.syncmold.com.tw')
  // Back on the employee face, the 管理員 face's error is gone.
  await page.getByTestId('employee-login-link').click()
  await expect(page.getByTestId('login-error')).toHaveCount(0)
})
