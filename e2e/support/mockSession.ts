import type { Page } from '@playwright/test'

// For specs that make up every /rest/v1 answer themselves: a stored session for a 稽核管理者, so no database
// or sign-in is needed. The API mock decides what that person can see (employee_ref → audit_admin).

export const EMPLOYEE = { emp_id: 'ZZ0001', name: '測試稽核管理者', factory_code: 'SY' }

export function storedSession(token: string, msLeft: number) {
  return {
    oms: { accessToken: '', refreshToken: '', userId: '', email: '' },
    csa: { token, expiresAt: new Date(Date.now() + msLeft).toISOString() },
    employee: EMPLOYEE,
    issuedAt: new Date().toISOString(),
    devLogin: true,
  }
}

export async function signInAsAuditAdmin(page: Page) {
  const session = storedSession('not-checked-by-the-mocked-api', 3_600_000)
  await page.addInitScript((s) => sessionStorage.setItem('csa.session', s), JSON.stringify(session))
}
