import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRenewal, RENEWAL_INTERVAL_MS } from './renewal'

// Q66/Q71: like OMS, the session is renewed every 45 minutes while the tab is open.
describe('startRenewal', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('renews every 45 minutes', async () => {
    const renew = vi.fn(async () => {})
    startRenewal(renew)
    await vi.advanceTimersByTimeAsync(RENEWAL_INTERVAL_MS - 1)
    expect(renew).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(renew).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RENEWAL_INTERVAL_MS)
    expect(renew).toHaveBeenCalledTimes(2)
  })

  it('stops renewing once stopped', async () => {
    const renew = vi.fn(async () => {})
    const stop = startRenewal(renew)
    stop()
    await vi.advanceTimersByTimeAsync(RENEWAL_INTERVAL_MS * 3)
    expect(renew).not.toHaveBeenCalled()
  })

  it('reports a failed renewal instead of throwing from the timer', async () => {
    const onError = vi.fn()
    startRenewal(async () => { throw new Error('oms down') }, { onError })
    await vi.advanceTimersByTimeAsync(RENEWAL_INTERVAL_MS)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'oms down' }))
  })
})
