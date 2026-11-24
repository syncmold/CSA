import { describe, expect, it } from 'vitest'
import { notEmployed } from './employment'

describe('notEmployed', () => {
  it('keeps only whoever OMS says is 在職', () => {
    expect(notEmployed([{ asked: 'FQ1021', status: 'active' }, { asked: 'FQ1008', status: 'active' }])).toEqual([])
  })

  it('counts 離職, 留停, 轉調 and unknown 工號 as not employed, as they were asked', () => {
    expect(notEmployed([
      { asked: 'FQ1021', status: 'departed' },
      { asked: 'FQ1008', status: 'on_leave' },
      { asked: 'FQ1009', status: 'transferred' },
      { asked: 'FQ1010', status: 'not_found' },
      { asked: 'FQ1011', status: 'active' },
    ])).toEqual(['FQ1021', 'FQ1008', 'FQ1009', 'FQ1010'])
  })
})
