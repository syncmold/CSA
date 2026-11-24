import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addBranch,
  createRoute,
  createStep,
  deleteBranch,
  deleteRoute,
  deleteStep,
  fetchRoute,
  fetchRoutes,
  reorderSteps,
  updateStep,
  type RouteTree,
  type NewStepInput,
} from '../api/approvalRoutes'
import { applyOrder } from '../domain/templates'
import { useWrite } from './useWrite'

const LIST = ['approval-routes']

export function useApprovalRoutes() {
  return useQuery({ queryKey: LIST, queryFn: fetchRoutes })
}

export function useApprovalRoute(id: string | undefined) {
  return useQuery({
    queryKey: ['approval-routes', id],
    queryFn: () => fetchRoute(id!),
    enabled: !!id,
  })
}

export function useCreateRoute() {
  return useWrite(createRoute, [LIST])
}

/**
 * The 流程編輯器 edits of one route. Every edit can change the 發起檢查 and the step count shown in the
 * list, so each refreshes every route query (the list key is a prefix of the single-route keys). A reorder shows the new order at once and the refetch replaces it
 * with the database's (or puts it back when the write was refused).
 */
export function useRouteEditing(routeId: string) {
  const queryClient = useQueryClient()

  return {
    createStep: useWrite(
      (input: NewStepInput, beforePosition: number | null, branchUnitId: string | null = null) => createStep(routeId, input, beforePosition, branchUnitId),
      [LIST],
    ),
    updateStep: useWrite(updateStep, [LIST]),
    deleteStep: useWrite(deleteStep, [LIST]),
    reorderSteps: useWrite((ids: string[]) => {
      queryClient.setQueryData<RouteTree | null>(['approval-routes', routeId], (current) =>
        current ? { ...current, route_step: applyOrder(current.route_step, ids) } : current,
      )
      return reorderSteps(routeId, ids)
    }, [LIST]),
    addBranch: useWrite((unitId: string) => addBranch(routeId, unitId), [LIST]),
    deleteBranch: useWrite((unitId: string) => deleteBranch(routeId, unitId), [LIST]),
    /**
     * `confirmCode` is the 範本編號. The caller leaves the page afterwards, so a success refreshes the list alone
     * (refetching the deleted route would only come back empty); a refusal refreshes this route.
     */
    remove: useWrite(
      (confirmCode: string) =>
        deleteRoute(routeId, confirmCode).then(
          () => void queryClient.invalidateQueries({ queryKey: LIST, exact: true }),
          (error: unknown) => {
            void queryClient.invalidateQueries({ queryKey: ['approval-routes', routeId] })
            throw error
          },
        ),
      [],
    ),
  }
}
