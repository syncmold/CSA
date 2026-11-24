// Code split off the main bundle (the PDF and Excel exporters) is fetched by a hashed file name. After a deploy the
// files a tab opened earlier asks for are gone, so the import fails ("Failed to fetch dynamically imported module").
// Reloading the page gets the new build; the next click works (Q135 (3)).

const RELOADED_AT = 'csa.chunkReloadAt'
/** A second failure this soon after reloading is not a stale tab, so it is reported instead of reloading again. */
export const RELOAD_GAP_MS = 30_000
/** If the page is still here this long after asking to reload, the click reports the error after all. */
const RELOAD_WAIT_MS = 10_000

export interface ReloadingPage {
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  /** False while offline (a reload would land on the browser's offline page) or while edits are not yet 暫存. */
  mayReload: () => boolean
  reload: () => void
  now: () => number
}

let unsavedWork = false

/** The 答題 sheet says whether it holds edits not yet 暫存; a failed import then reports instead of reloading them away. */
export function holdReloadsWhile(unsaved: boolean): void {
  unsavedWork = unsaved
}

const browserPage = (): ReloadingPage => {
  let storage: ReloadingPage['storage'] = null
  try {
    storage = window.sessionStorage
  } catch {
    // Storage blocked: without it a reload loop cannot be ruled out, so the error is reported instead.
  }
  return {
    storage,
    mayReload: () => navigator.onLine !== false && !unsavedWork,
    reload: () => window.location.reload(),
    now: Date.now,
  }
}

/** Reloads once, unless it may not, just did, or cannot remember that it did; true when it reloads. */
function reloadForNewBuild(page: ReloadingPage): boolean {
  try {
    if (!page.storage || !page.mayReload()) return false
    const last = Number(page.storage.getItem(RELOADED_AT))
    if (last && page.now() - last < RELOAD_GAP_MS) return false
    page.storage.setItem(RELOADED_AT, String(page.now()))
  } catch {
    return false
  }
  page.reload()
  return true
}

/**
 * Runs a code-split import. When it fails, reloads the page once (see above) and keeps the click waiting for the
 * page to go, so no error flashes; otherwise the error goes to the caller as before.
 */
export async function loadChunk<T>(load: () => Promise<T>, page: () => ReloadingPage = browserPage): Promise<T> {
  try {
    return await load()
  } catch (error) {
    if (!reloadForNewBuild(page())) throw error
    return new Promise<T>((_, reject) => setTimeout(() => reject(error), RELOAD_WAIT_MS))
  }
}
