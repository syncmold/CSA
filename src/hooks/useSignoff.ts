import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { approveStep, fetchSignoffs, returnAssessment } from '../api/signoff'

/** The 簽核歷程 of one 自評表. Its key sits under ['assessment', id], so refreshing the 自評表 refreshes it too. */
export function useSignoffHistory(assessmentId: string | undefined) {
  return useQuery({
    queryKey: ['assessment', assessmentId, 'signoffs'],
    queryFn: () => fetchSignoffs(assessmentId!),
    enabled: !!assessmentId,
  })
}

/** 核准 and 退回 for one 自評表. Either one refreshes the 自評表 (and its history), 我的待簽 and 我參與的自評表. */
export function useSignoffActions(assessmentId: string) {
  const queryClient = useQueryClient()
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['assessment', assessmentId] }),
      queryClient.invalidateQueries({ queryKey: ['my-tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['my-assessments'] }),
    ])

  const approve = useMutation({
    mutationFn: ({ stepPosition, comment }: { stepPosition: number; comment: string }) => approveStep(assessmentId, stepPosition, comment),
    onSuccess: refresh,
  })
  const returnToStep = useMutation({
    mutationFn: ({ stepPosition, toPosition, reason }: { stepPosition: number; toPosition: number; reason: string }) =>
      returnAssessment(assessmentId, stepPosition, toPosition, reason),
    onSuccess: refresh,
  })

  return { approve, returnToStep }
}
