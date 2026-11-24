/** OMS renews its session every 45 minutes; CSA follows the same cadence (Q71). */
export const RENEWAL_INTERVAL_MS = 45 * 60 * 1000

export interface RenewalOptions {
  intervalMs?: number
  onError?: (error: unknown) => void
}

/**
 * Call `renew` on a fixed cadence until the returned stop function is called.
 * Errors are reported through `onError`, never thrown out of the timer.
 */
export function startRenewal(renew: () => Promise<void>, options: RenewalOptions = {}): () => void {
  const interval = options.intervalMs ?? RENEWAL_INTERVAL_MS
  const handle = setInterval(() => {
    renew().catch((error: unknown) => options.onError?.(error))
  }, interval)
  return () => clearInterval(handle)
}
