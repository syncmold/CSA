import { describe, expect, it } from 'vitest'
import enAnswering from '../locales/en/answering.json'
import zhTWAnswering from '../locales/zh-TW/answering.json'
import { toWriteError, WriteError } from './writeError'

describe('toWriteError', () => {
  it('turns the database codes the 答題 page explains into its few outcomes', () => {
    const reason = (code: string) => toWriteError({ code, message: '' }).reason
    expect(reason('42501')).toBe('forbidden')
    expect(reason('23514')).toBe('invalid')
    expect(reason('22P02')).toBe('invalid')
    // An answer without its 自評單位 from a tab opened before #46, or a control point × 自評單位 that is gone.
    expect(reason('23502')).toBe('stale')
    expect(reason('23503')).toBe('stale')
    expect(reason('08006')).toBe('other')
  })

  it('has a message in every language for every outcome the page translates', () => {
    const reasons: WriteError['reason'][] = ['forbidden', 'invalid', 'stale']
    for (const errors of [zhTWAnswering.errors, enAnswering.errors]) {
      expect(reasons.filter((r) => !(r in errors))).toEqual([])
    }
  })
})
