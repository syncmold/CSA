import { useQuery } from '@tanstack/react-query'
import { fetchMyTasks } from '../api/myTasks'

/** `staleTime`: how old the list may be before a new mount refetches it (default: always refetch). */
export function useMyTasks(empId: string | undefined, staleTime = 0) {
  return useQuery({
    queryKey: ['my-tasks', empId],
    queryFn: fetchMyTasks,
    enabled: !!empId,
    staleTime,
  })
}
