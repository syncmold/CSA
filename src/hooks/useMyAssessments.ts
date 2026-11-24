import { useQuery } from '@tanstack/react-query'
import { fetchMyAssessments, fetchMyPastClosedCount } from '../api/myAssessments'

export function useMyAssessments(empId: string | undefined) {
  return useQuery({
    queryKey: ['my-assessments', empId],
    queryFn: fetchMyAssessments,
    enabled: !!empId,
  })
}

/** 首頁's line under 我參與的: how many 往年已結案 are no longer listed there (Q124 (1)). */
export function useMyPastClosedCount(empId: string | undefined) {
  return useQuery({ queryKey: ['my-assessments', empId, 'past-closed'], queryFn: fetchMyPastClosedCount, enabled: !!empId })
}
