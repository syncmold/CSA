import { describe, expect, it } from 'vitest'
import { searchBase } from './useUrlParam'

describe('searchBase', () => {
  const at = { pathname: '/admin/flows', search: '?plant=GT' }

  it('starts from the write still on its way, so two writes in one go keep both parameters (#85)', () => {
    expect(searchBase({ path: '/admin/flows', search: 'plant=GT&component=control_activities' }, at)).toBe('plant=GT&component=control_activities')
  })

  it('starts from the browser’s URL when nothing is on its way', () => {
    expect(searchBase(null, at)).toBe('?plant=GT')
  })

  it('ignores a write from another page', () => {
    expect(searchBase({ path: '/admin/templates', search: 'plant=TC&component=monitoring' }, at)).toBe('?plant=GT')
  })
})
