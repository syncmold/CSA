import { describe, expect, it } from 'vitest'
import { nextLaunchYear, pickYear, yearOptions } from './years'

describe('nextLaunchYear', () => {
  it('is the newest launched year + 1', () => {
    expect(nextLaunchYear([2025, 2027, 2026], 2026)).toBe(2028)
  })

  it('is this year when nothing was ever launched', () => {
    expect(nextLaunchYear([], 2026)).toBe(2026)
  })
})

describe('yearOptions', () => {
  it('lists the next year to launch first, then the launched years newest first', () => {
    expect(yearOptions([2025, 2027, 2026], 2026)).toEqual([
      { year: 2028, launched: false },
      { year: 2027, launched: true },
      { year: 2026, launched: true },
      { year: 2025, launched: true },
    ])
  })

  it('offers only this year before the first launch', () => {
    expect(yearOptions([], 2026)).toEqual([{ year: 2026, launched: false }])
  })
})

describe('pickYear', () => {
  const options = yearOptions([2025, 2026], 2026)

  it('takes the URL first, then the remembered year, then the next year to launch', () => {
    expect(pickYear(options, '2025', '2026')).toBe(2025)
    expect(pickYear(options, null, '2026')).toBe(2026)
    expect(pickYear(options, null, null)).toBe(2027)
  })

  it('passes over a year that is not among the options', () => {
    expect(pickYear(options, '1999', '2026')).toBe(2026)
    expect(pickYear(options, 'abc', '2030')).toBe(2027)
  })

  it('has nothing to pick before the years load', () => {
    expect(pickYear([], '2026', null)).toBeNull()
  })
})
