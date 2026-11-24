import { describe, expect, it, vi } from 'vitest'
import { loadChunk, RELOAD_GAP_MS, type ReloadingPage } from './loadChunk'

function fakePage(now: number, stored: Record<string, string> = {}) {
  const page: ReloadingPage & { reloads: number } = {
    reloads: 0,
    storage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => void (stored[k] = v) },
    mayReload: () => true,
    reload: () => void page.reloads++,
    now: () => now,
  }
  return page
}

const stale = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'))

describe('loadChunk', () => {
  it('returns the module when the import works', async () => {
    const page = fakePage(1_000)
    await expect(loadChunk(() => Promise.resolve('module'), () => page)).resolves.toBe('module')
    expect(page.reloads).toBe(0)
  })

  it('reloads once when a tab opened before a deploy asks for a file that is gone, and keeps the click pending', async () => {
    const page = fakePage(1_000)
    const settled = vi.fn()
    void loadChunk(stale, () => page).then(settled, settled)
    await new Promise((r) => setTimeout(r, 0))
    expect(page.reloads).toBe(1)
    expect(settled).not.toHaveBeenCalled()
  })

  it('reports the error instead of reloading again right after a reload', async () => {
    const stored: Record<string, string> = {}
    void loadChunk(stale, () => fakePage(1_000, stored))
    await new Promise((r) => setTimeout(r, 0))
    const again = fakePage(1_000 + RELOAD_GAP_MS - 1, stored)
    await expect(loadChunk(stale, () => again)).rejects.toThrow('dynamically imported module')
    expect(again.reloads).toBe(0)
  })

  it('reloads again once the last reload is long past', async () => {
    const page = fakePage(1_000 + RELOAD_GAP_MS, { 'csa.chunkReloadAt': '1000' })
    void loadChunk(stale, () => page)
    await new Promise((r) => setTimeout(r, 0))
    expect(page.reloads).toBe(1)
  })

  it('reports the error when the browser blocks storage, since a reload loop could not be stopped', async () => {
    const page = { ...fakePage(1_000), storage: null }
    await expect(loadChunk(stale, () => page)).rejects.toThrow()
  })

  it('reports the error instead of reloading while offline or while answers are not yet 暫存', async () => {
    const page = { ...fakePage(1_000), mayReload: () => false }
    await expect(loadChunk(stale, () => page)).rejects.toThrow('dynamically imported module')
    expect(page.reloads).toBe(0)
  })

  it('reports the error after all when the page is still there long after asking to reload', async () => {
    vi.useFakeTimers()
    try {
      const failed = expect(loadChunk(stale, () => fakePage(1_000))).rejects.toThrow('dynamically imported module')
      await vi.advanceTimersByTimeAsync(10_000)
      await failed
    } finally {
      vi.useRealTimers()
    }
  })
})
