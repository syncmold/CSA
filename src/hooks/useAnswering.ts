import { useMutation, useQueryClient } from '@tanstack/react-query'
import { saveAnswers, submitStep, type AnswerPayload } from '../api/answers'

/** 暫存 and 送出 for one 自評表. A successful 送出 refreshes the 自評表, 我的待簽 and 我參與的自評表. */
export function useAnswering(assessmentId: string) {
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (payload: AnswerPayload) => saveAnswers(assessmentId, payload),
  })

  const submit = useMutation({
    mutationFn: (stepPosition: number) => submitStep(assessmentId, stepPosition),
    onSuccess: async (result) => {
      if (!result.ok) return
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['assessment', assessmentId] }),
        queryClient.invalidateQueries({ queryKey: ['my-tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['my-assessments'] }),
      ])
    },
  })

  return { save, submit }
}
