import { useQuery } from '@tanstack/react-query'
import { fetchAssessmentRecords, fetchRecordScope } from '../api/records'

/** 自評表紀錄's rows: every 自評表 the signed-in employee can see (Q124 (2)); fetched afresh when the page is opened. */
export function useAssessmentRecords() {
  return useQuery({ queryKey: ['assessment-records'], queryFn: fetchAssessmentRecords })
}

/** Which plants those cover, for the label beside the title; keyed under the role's key so 權限管理 refreshes it too. */
export function useRecordScope(empId: string | undefined) {
  return useQuery({ queryKey: ['my-audit-role', 'record-scope', empId], queryFn: fetchRecordScope, enabled: !!empId, staleTime: 5 * 60_000 })
}
