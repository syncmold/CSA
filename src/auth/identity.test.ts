import { describe, expect, it } from 'vitest'
import { resolveLoginEmail } from './identity'

// OMS rule (docs/OMS-Supabase-連線說明.md §2.1): input containing "@" is used
// as-is; otherwise the 工號 is lower-cased and suffixed with @id.syncmold.com.tw.
describe('resolveLoginEmail', () => {
  it('turns a 工號 into the synthesized OMS email', () => {
    expect(resolveLoginEmail('FQ0123')).toBe('fq0123@id.syncmold.com.tw')
  })

  it('keeps an email address as typed, trimmed and lower-cased', () => {
    expect(resolveLoginEmail('  Someone@Example.com ')).toBe('someone@example.com')
  })

  it('maps the admin account like any other username', () => {
    expect(resolveLoginEmail('admin')).toBe('admin@id.syncmold.com.tw')
  })

  it('returns null for blank input', () => {
    expect(resolveLoginEmail('   ')).toBeNull()
  })
})
