import { describe, expect, it } from 'vitest'
import type { LookedUpPerson } from '../api/people'
import { bringIn } from './people'

const person = (over: Partial<LookedUpPerson> = {}): LookedUpPerson => ({
  asked: 'SY0140', emp_id: 'SY0140', status: 'active', name: '李大華', factory_code: 'SY', csa: true, other_plant: false, csaRequired: false, ...over,
})

describe('bringIn', () => {
  it('brings in someone 在職, with nothing to point out when OMS has enabled CSA and they are of this 廠區', () => {
    expect(bringIn(person())).toEqual({ ok: true, reminders: [] })
    expect(bringIn(person({ name: null }))).toEqual({ ok: true, reminders: [] }) // 在職 without a name in OMS is still 在職
  })

  it('refuses whoever OMS does not have as 在職, and a 工號 nothing is known about', () => {
    for (const status of ['not_found', 'departed', 'on_leave', 'transferred'] as const) {
      expect(bringIn(person({ status, csa: false }))).toEqual({ ok: false, reason: status })
    }
    expect(bringIn(undefined)).toEqual({ ok: false, reason: 'not_found' })
    expect(bringIn(null)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('only points out CSA not being enabled until CSA_REQUIRE_OMS_AUTH is on, then refuses (Q133 (4))', () => {
    expect(bringIn(person({ csa: false }))).toEqual({ ok: true, reminders: ['no_csa'] })
    expect(bringIn(person({ csa: false, csaRequired: true }))).toEqual({ ok: false, reason: 'no_csa' })
    expect(bringIn(person({ csaRequired: true }))).toEqual({ ok: true, reminders: [] })
  })

  it('only ever points out another 廠區 (Q130 (4))', () => {
    expect(bringIn(person({ other_plant: true }))).toEqual({ ok: true, reminders: ['other_plant'] })
    expect(bringIn(person({ other_plant: true, csa: false }))).toEqual({ ok: true, reminders: ['no_csa', 'other_plant'] })
    expect(bringIn(person({ other_plant: true, csaRequired: true }))).toEqual({ ok: true, reminders: ['other_plant'] })
  })
})
