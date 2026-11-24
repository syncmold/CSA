// 呈現用純函式 (技術選型 §5): errors as text for the pages.

/**
 * An error as one line for the page: a thrown Error, a PostgREST error (a plain object with
 * `message`, which `String()` turns into 「[object Object]」) or anything else.
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const text = (error as { message?: unknown } | null)?.message
  return typeof text === 'string' ? text : String(error)
}
