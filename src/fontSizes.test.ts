// 畫面字級一律經過 theme.ts 的 textSize（Q108）：寫死的字級不會跟著 FONT_STEP 一起放大。PDF 是紙本字級，不在此限。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'pdf' ? [] : files(path)
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('font sizes', () => {
  it('go through textSize everywhere on screen, so FONT_STEP moves them all', () => {
    const literal = /fontSize:\s*\d|fontSize=\{\s*\d|font-size\s*:/
    const offenders = files(SRC).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .map((line, i) => ({ line, at: `${relative(SRC, path)}:${i + 1}` }))
        .filter(({ line }) => literal.test(line))
        .map(({ at, line }) => `${at}  ${line.trim()}`),
    )
    expect(offenders).toEqual([])
  })
})
