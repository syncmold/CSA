import { useEffect, useRef, useState } from 'react'
import { pickPlant, type PlantOption } from '../domain/plantChoice'
import { useSearchWriter } from './useUrlParam'

/** Shared by 範本管理 and 簽核流程: a plant chosen on one page is the plant on the other (#84, #85). */
const STORAGE_KEY = 'csa.plant'

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function remember(plant: string) {
  try {
    localStorage.setItem(STORAGE_KEY, plant)
  } catch {
    // A browser that refuses storage just forgets the choice on the other page.
  }
}

/**
 * The chosen 廠區 of a list page (#84, B2): `?plant=` in the URL, so opening a row and coming back returns to it;
 * without one, the plant this browser showed last on either list page, else the first. Once the options are in it is
 * written into the URL and remembered, so it does not move when the rows change. null while there are no options.
 * Choosing may change other URL parameters in the same write (`adjust`, e.g. clearing a tab the new plant has nothing
 * in), seeing the URL as it is then.
 */
export function usePlantChoice(
  options: readonly PlantOption[],
  ready: boolean,
): [string | null, (plant: string, adjust?: (params: URLSearchParams) => void) => void] {
  const [params, writeParams] = useSearchWriter()
  const requested = params.get('plant')
  // Read once: later choices go to the URL, which wins anyway.
  const [lastChosen] = useState(remembered)
  const chosen = pickPlant(options, requested, lastChosen)
  const write = (plant: string, adjust?: (params: URLSearchParams) => void) =>
    writeParams((next) => {
      next.set('plant', plant)
      adjust?.(next)
    })
  const choose = (plant: string, adjust?: (params: URLSearchParams) => void) => {
    write(plant, adjust)
    remember(plant)
  }
  // The plant this page put into the URL itself (the remembered one or the first): not a choice to remember, or a plant
  // only 範本管理 offers (未指定廠區) would be overwritten by just opening 簽核流程.
  const pinned = useRef<string | null>(null)

  useEffect(() => {
    if (!ready || chosen === null) return
    if (requested !== chosen) {
      pinned.current = chosen
      write(chosen)
    } else if (pinned.current !== chosen) {
      // A plant the URL brought (e.g. a 簽核流程's breadcrumb, #85) is the one shown, so the other page opens on it too.
      remember(chosen)
    }
    // write is rebuilt each render; the pin only depends on what is chosen.
  }, [ready, chosen, requested])

  return [ready ? chosen : null, choose]
}
