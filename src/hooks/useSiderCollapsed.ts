import { useState } from 'react'

/** Whether the side menu is folded to its icons (wide screens); each browser remembers its own choice. */
const STORAGE_KEY = 'csa.siderCollapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function useSiderCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const choose = (next: boolean) => {
    setCollapsed(next)
    try {
      if (next) localStorage.setItem(STORAGE_KEY, '1')
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      // A browser that refuses storage just forgets the choice next time.
    }
  }
  return [collapsed, choose]
}
