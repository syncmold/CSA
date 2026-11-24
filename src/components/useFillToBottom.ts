import { useLayoutEffect, useRef, useState } from 'react'
import { CONTENT_PADDING } from './AppShell'

/**
 * Stretches an element down to the bottom of the window, keeping the page's own bottom padding, so a list
 * card keeps one height whichever group it shows (#66). It measures where the element really starts, so a
 * wrapped page title or a different header height does not matter; a longer list still grows the page.
 */
export function useFillToBottom<E extends HTMLElement>() {
  const ref = useRef<E>(null)
  const [minHeight, setMinHeight] = useState<number>()

  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current
      if (!el) return
      const top = el.getBoundingClientRect().top + window.scrollY
      setMinHeight(Math.max(0, window.innerHeight - top - CONTENT_PADDING))
    }
    measure()
    window.addEventListener('resize', measure)
    // Something above that shows up later (a warning, a wrapped heading) moves the element down without a resize. The
    // next frame, so the height this sets does not resize the body inside the same observation (a ResizeObserver loop).
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(document.body)
    return () => {
      window.removeEventListener('resize', measure)
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  return { ref, style: { minHeight } }
}
