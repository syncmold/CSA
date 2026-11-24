import { expect, test, type Page } from '@playwright/test'
import { EMPLOYEE, storedSession } from './support/mockSession'

// The CSA token lasts an hour and the 45-minute renewal is a browser timer, which stands still while the computer
// sleeps. A request must wait for the renewal instead of going out with the expired token (PostgREST answers
// 「JWT expired」), and coming back to the page renews by itself. Every /rest/v1 answer is made up here and only the
// token that works gets one.

const EXPIRED = 'expired-token'
const WORKING = 'working-token'
const EXPIRED_SESSION = JSON.stringify(storedSession(EXPIRED, -60_000))

/** Longer than the query's one retry waits, so a request that does not wait for the renewal fails for good. */
const RENEWAL_TAKES_MS = 2500

const answerWith = (token: string) => ({
  status: 200,
  json: { csa_token: token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), employee: EMPLOYEE },
})

async function mockServer(page: Page, renewal: { status: number; json: object }) {
  await page.route('**/rest/v1/**', (route) => {
    if (route.request().headers().authorization !== `Bearer ${WORKING}`) {
      return route.fulfill({ status: 401, json: { code: 'PGRST303', message: 'JWT expired' } })
    }
    if (new URL(route.request().url()).pathname.endsWith('/employee_ref')) return route.fulfill({ json: [{ audit_role: 'audit_admin' }] })
    return route.fulfill({ json: [] })
  })
  await page.route('**/csa/dev-login', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, RENEWAL_TAKES_MS))
    await route.fulfill(renewal)
  })
}

/** Puts the session in place for the first load only, so the app's own sign-out or renewal is not undone. */
async function startWith(page: Page, session: string) {
  await page.addInitScript((s) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    sessionStorage.setItem('csa.session', s)
  }, session)
}

const storedToken = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('csa.session')!).csa.token)
const greeting = (page: Page) => page.getByRole('heading', { name: new RegExp(EMPLOYEE.name) })

test('opening the page with an expired token waits for the renewal', async ({ page }) => {
  await mockServer(page, answerWith(WORKING))
  await startWith(page, EXPIRED_SESSION)

  await page.goto('/')
  await expect(greeting(page)).toBeVisible()
  await expect.poll(() => storedToken(page), { timeout: 10_000 }).toBe(WORKING)
  await page.waitForLoadState('networkidle')
  await expect(page.getByText('JWT expired')).toHaveCount(0)
})

test('the first request after the computer slept waits for the renewal', async ({ page }) => {
  await mockServer(page, answerWith(WORKING))
  await startWith(page, JSON.stringify(storedSession(WORKING, 3_600_000)))
  await page.goto('/')
  await expect(greeting(page)).toBeVisible()

  // Asleep past the hour: the timer did not fire, so the page still holds a token that has run out.
  await page.evaluate((s) => sessionStorage.setItem('csa.session', s), EXPIRED_SESSION)
  await page.getByRole('link', { name: '範本管理' }).click()

  await expect(page.getByText('沒有可檢視的問卷範本')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('JWT expired')).toHaveCount(0)
})

test('coming back to the page renews a token about to run out, before anything is clicked', async ({ page }) => {
  await mockServer(page, answerWith('renewed-on-return'))
  await page.clock.install()
  await startWith(page, JSON.stringify(storedSession(WORKING, 6 * 60_000)))
  await page.goto('/')
  await expect(greeting(page)).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(await storedToken(page)).toBe(WORKING)

  await page.clock.fastForward('02:00')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))

  await expect.poll(() => storedToken(page), { timeout: 10_000 }).toBe('renewed-on-return')
})

test('a renewal that is refused goes back to the login page', async ({ page }) => {
  await mockServer(page, { status: 403, json: { error: 'not_authorized' } })
  await startWith(page, EXPIRED_SESSION)

  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/, { timeout: 10_000 })
  await expect(page.getByText('JWT expired')).toHaveCount(0)
})

test('a renewal that cannot reach the exchange goes back to the login page once the token has expired', async ({ page }) => {
  await mockServer(page, { status: 500, json: {} })
  await startWith(page, EXPIRED_SESSION)

  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/, { timeout: 10_000 })
  await expect(page.getByText('JWT expired')).toHaveCount(0)
})
