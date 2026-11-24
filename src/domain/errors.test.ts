import { describe, expect, it } from 'vitest'
import { errorText } from './errors'

describe('errorText', () => {
  it('shows a PostgREST error’s message, not 「[object Object]」', () => {
    expect(errorText({ code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null })).toBe(
      'canceling statement due to statement timeout',
    )
  })

  it('shows a thrown Error’s message and anything else as text', () => {
    expect(errorText(new Error('network down'))).toBe('network down')
    expect(errorText('plain')).toBe('plain')
    expect(errorText(null)).toBe('null')
  })
})
