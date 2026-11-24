import { useEffect } from 'react'
import { useLocation, useSearchParams } from 'react-router'

/** A query string written but maybe not yet in the location, and the page it was written on. */
export interface PendingSearch {
  path: string
  search: string
}

/**
 * What a write starts from (#85). React Router hands every setter the URL of the render it was made in, so two writes
 * in one go (the 組成要素 tab and the 廠區 being pinned in the same commit) would each start from the old URL and the
 * later one would drop the earlier one's parameter. A write starts from the last one still on its way, if it was on
 * this page, else from the browser's own URL.
 */
export function searchBase(pending: PendingSearch | null, location: { pathname: string; search: string }): string {
  return pending && pending.path === location.pathname ? pending.search : location.search
}

let pending: PendingSearch | null = null

/**
 * Changes some parameters of the URL, keeping the others, and replaces the history entry instead of adding one.
 * `change` edits the parameters in place.
 */
export function useSearchWriter(): [URLSearchParams, (change: (params: URLSearchParams) => void) => void] {
  const [params, setParams] = useSearchParams()
  const { search } = useLocation()
  // Once a render shows the last write, the browser's URL is current again.
  useEffect(() => {
    if (pending && pending.path === window.location.pathname && pending.search === new URLSearchParams(search).toString()) pending = null
  }, [search])
  const write = (change: (params: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchBase(pending, window.location))
    change(next)
    // A write that leaves the URL as it is moves no location, so nothing would ever clear it.
    const unchanged = next.toString() === new URLSearchParams(window.location.search).toString()
    pending = unchanged ? null : { path: window.location.pathname, search: next.toString() }
    setParams(next, { replace: true })
  }
  return [params, write]
}

/**
 * One choice kept in the URL (a list's filter or group), so it survives opening an item and coming back.
 * Setting it keeps the other parameters and replaces the history entry instead of adding one; null removes it.
 */
export function useUrlParam(name: string): [string | null, (value: string | null) => void] {
  const [params, write] = useSearchWriter()
  const set = (value: string | null) =>
    write((next) => {
      if (value === null) next.delete(name)
      else next.set(name, value)
    })
  return [params.get(name), set]
}
