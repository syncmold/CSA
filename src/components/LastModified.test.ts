import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { modifiedBy, type LastModifiedFields } from '../domain/lastModified'
import { palette } from '../theme'
import { LastModifiedCell, LastModifiedLine } from './LastModified'

const AT = '2026-11-18T06:05:00Z'
const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
const row = (by: string | null, name: string | null): LastModifiedFields => ({ updated_at: AT, updated_by: by, updated_by_name: name })

/** The list cell's lines as text, top to bottom. */
function lines(r: LastModifiedFields): string[] {
  const html = renderToStaticMarkup(createElement(LastModifiedCell, { row: r }))
  return [...html.matchAll(/<span style="display:block[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]!)
}

describe('最後修改 (#201)', () => {
  it('names the 修改人, else shows the 工號, else 「—」; the 管理員帳號 by its label', () => {
    expect(modifiedBy(row('SS140', '王小明'), '管理員帳號')).toBe('王小明')
    expect(modifiedBy(row('SS140', null), '管理員帳號')).toBe('SS140')
    expect(modifiedBy(row(null, null), '管理員帳號')).toBe('—')
    expect(modifiedBy(row('admin', null), '管理員帳號')).toBe('管理員帳號')
  })

  it('puts the time over the 修改人 in a list, the 修改人 a shade fainter', () => {
    const r = row('SS140', '王小明')
    const [time, who] = lines(r)
    expect(time).toMatch(TIME)
    expect(who).toBe('王小明')
    expect(lines(row(null, null))).toEqual([time, '—'])
    const html = renderToStaticMarkup(createElement(LastModifiedCell, { row: r }))
    expect(html).toContain(`color:${palette.textTertiary}`)
    expect(html).toContain(`color:${palette.dashed}`)
  })

  it('is one line in the 範本明細: the time, two full-width spaces, the 修改人, each never broken inside', () => {
    const html = renderToStaticMarkup(createElement(LastModifiedLine, { row: row(null, null) }))
    const [time, rest] = html.replace(/<[^>]+>/g, '').split('　　')
    expect(time).toMatch(TIME)
    expect(rest).toBe('—')
    expect(html.match(/white-space:nowrap/g)).toHaveLength(2)
  })
})
