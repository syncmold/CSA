import { useCallback, useSyncExternalStore } from 'react'

/**
 * Whether a CSS media query matches now, kept current as the window changes. Read synchronously, so the first render
 * already has the right layout (antd's Grid.useBreakpoint reports nothing until after it).
 */
export function useMediaQuery(query: string): boolean {
  // One subscription per query, not one per render.
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}
