import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'

/**
 * One write as a mutation: `run(...args)` resolves with the write's result or rejects with the
 * database's refusal. Afterwards the `refresh` queries refetch in the background; callers do not
 * wait for them, so a modal can close as soon as the write itself is done.
 */
export function useWrite<A extends unknown[], R>(write: (...args: A) => Promise<R>, refresh: QueryKey[]) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (args: A) => write(...args),
    onSettled: () => {
      for (const queryKey of refresh) void queryClient.invalidateQueries({ queryKey })
    },
  })
  return { run: (...args: A) => mutation.mutateAsync(args), isPending: mutation.isPending }
}
