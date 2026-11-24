import { describe, expect, it } from 'vitest'
import { loginFailureKey } from './omsErrors'

// The login page shows the same wording as OMS: any 400/401 from
// /auth/v1/token is "帳號或密碼錯誤"; everything else is a connection problem.
describe('loginFailureKey', () => {
  it('maps OMS invalid credentials (400) to the generic wrong-password message', () => {
    expect(loginFailureKey({ status: 400, code: 'invalid_credentials' })).toBe(
      'login.error.invalidCredentials',
    )
  })

  it('maps 401 to the same wrong-password message', () => {
    expect(loginFailureKey({ status: 401 })).toBe('login.error.invalidCredentials')
  })

  it('maps a server error or no response to a connection message', () => {
    expect(loginFailureKey({ status: 503 })).toBe('login.error.network')
    expect(loginFailureKey({ status: 0 })).toBe('login.error.network')
  })
})
