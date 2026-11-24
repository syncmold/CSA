// 呈現用純函式 shared by the list pages (技術選型 §5).

/** The parts of a TanStack Query result that decide whether a list is still loading. */
export interface ListQueryState {
  isPending: boolean
  isFetching: boolean
  data?: readonly unknown[]
}

/**
 * A list shows its spinner, not its 「沒有可檢視的…」 hint, until it knows it is empty: while the first
 * fetch is under way, and while an empty list kept from earlier is fetched again (e.g. the list was
 * opened before `db:set-role` made this person a 稽核管理者; RLS gave them no rows then).
 * A list that already has rows keeps showing them while it refreshes.
 */
export function listLoading(query: ListQueryState): boolean {
  return query.isPending || (query.isFetching && !query.data?.length)
}
