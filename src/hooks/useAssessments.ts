import { useQuery } from '@tanstack/react-query'
import { fetchAssessment } from '../api/assessments'

export function useAssessment(id: string | undefined) {
  return useQuery({
    queryKey: ['assessment', id],
    queryFn: () => fetchAssessment(id!),
    enabled: !!id,
  })
}
