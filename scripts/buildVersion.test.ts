import { describe, expect, it } from 'vitest'
import { buildCommit } from './buildVersion'

const SHA = '545d3b5e1f0c2a9b8d7e6f5a4b3c2d1e0f9a8b7c'

describe('buildCommit', () => {
  it('uses the local git HEAD, cut to 7 characters (deploy builds on the main checkout)', () => {
    expect(buildCommit({}, () => `${SHA}\n`)).toBe('545d3b5')
  })

  it('prefers the commit Vercel built from', () => {
    expect(buildCommit({ VERCEL_GIT_COMMIT_SHA: SHA }, () => 'ffffffffff')).toBe('545d3b5')
  })

  it('is empty when there is no git to ask', () => {
    expect(
      buildCommit({ VERCEL_GIT_COMMIT_SHA: '' }, () => {
        throw new Error('not a git repository')
      }),
    ).toBe('')
  })
})
