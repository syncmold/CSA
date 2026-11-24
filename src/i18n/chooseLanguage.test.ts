import { describe, expect, it } from 'vitest'
import { chooseLanguage } from './chooseLanguage'

// Q19: manually chosen → inferred from the user's 廠區 code → 繁中.
// This ticket ships zh-TW and en; other codes fall back until #16 adds them.
describe('chooseLanguage', () => {
  it('prefers the language the user picked', () => {
    expect(chooseLanguage({ stored: 'en', factoryCode: 'FQ' })).toBe('en')
  })

  it('ignores a stored language that is not shipped', () => {
    expect(chooseLanguage({ stored: 'fr', factoryCode: 'FQ' })).toBe('zh-TW')
  })

  it('falls back to 繁中 for a Taiwanese or unknown 廠區', () => {
    expect(chooseLanguage({ stored: null, factoryCode: 'TP' })).toBe('zh-TW')
    expect(chooseLanguage({ stored: null, factoryCode: null })).toBe('zh-TW')
  })

  it('falls back to 繁中 for a 廠區 whose language is not shipped yet', () => {
    expect(chooseLanguage({ stored: null, factoryCode: 'VN' })).toBe('zh-TW')
  })
})
