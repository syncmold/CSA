import { useLayoutEffect, useRef, useState } from 'react'

/**
 * An element's width as it changes. It is measured before the first paint, so what is laid out by it never shows
 * another layout first; attach `ref` to something that is there from the first render.
 */
export function useElementWidth<E extends HTMLElement>() {
  const ref = useRef<E>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setWidth(el.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { ref, width }
}
