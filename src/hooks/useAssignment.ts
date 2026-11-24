import { useMutation, useQuery } from '@tanstack/react-query'
import { assignRouteStep, assignStep, fetchAssignmentForms, fetchAssignmentRoutes, fetchAssignmentTodo, fetchMyPlants } from '../api/assignment'
import type { Plant } from '../api/plants'
import { importAssignment, importRouteAssignment, matchWithOms } from '../api/assignmentImport'
import { useAuth } from '../auth/AuthContext'
import { useAssignsSigners } from './useMyAuditRole'
import { usePlants } from './usePlants'
import { PLANT_PEOPLE } from './useEmployeeSearch'
import { useWrite } from './useWrite'

const FORMS = ['assignment', 'forms']
const ROUTES = ['assignment', 'routes']
const TODO = ['assignment', 'todo']
/**
 * What else a 分派 changes: the 流程編輯器 shows the routes' 簽核人 and the 發起檢查, 年度發起 whether each route can go
 * out (Q147: everyone 分派 first).
 */
const ROUTE_VIEWS = [['approval-routes'], ['launch-candidates']]

/** The plants the signed-in employee assigns for: all of them for a 稽核管理者, otherwise the ones they run. */
export function useAssignablePlants(isAuditAdmin: boolean) {
  const { session } = useAuth()
  const empId = session?.employee.emp_id
  const all = usePlants()
  const mine = useQuery({
    queryKey: ['assignment', 'plants', empId],
    queryFn: () => fetchMyPlants(empId!),
    enabled: !!empId && !isAuditAdmin,
  })
  return isAuditAdmin ? all : mine
}

export function useAssignmentForms(plantId: string | undefined) {
  return useQuery({
    queryKey: [...FORMS, plantId],
    queryFn: () => fetchAssignmentForms(plantId!),
    enabled: !!plantId,
  })
}

/** A plant's 簽核流程 on 分派填寫人's 下次發出 (Q147). */
export function useAssignmentRoutes(plant: Pick<Plant, 'id' | 'factory_code'> | undefined) {
  return useQuery({
    queryKey: [...ROUTES, plant?.id],
    queryFn: () => fetchAssignmentRoutes(plant!),
    enabled: !!plant,
  })
}

/** 分派 on a 簽核流程 before the launch (Q147). */
export function useAssignRouteStep() {
  return useWrite(assignRouteStep, [ROUTES, TODO, [...PLANT_PEOPLE], ...ROUTE_VIEWS])
}

/** What is left to assign (Q147): a 廠區管理員's 簽核流程, a 稽核主管's old 自評表. Not asked for anyone else. */
export function useAssignmentTodo() {
  const assigns = useAssignsSigners()
  return useQuery({ queryKey: TODO, queryFn: fetchAssignmentTodo, enabled: assigns, staleTime: 60_000 })
}

export function useAssignStep() {
  // Whoever was just assigned belongs on the plant's picker list, for the pickers already on the page too. A 換人 after
  // the launch is written back to the route as well (Q147).
  return useWrite(assignStep, [FORMS, ROUTES, TODO, [...PLANT_PEOPLE], ...ROUTE_VIEWS])
}

/** 匯入分派表's 第 4 項 (#180): the CSA backend asks OMS about a file's 工號 for one 廠區. Reads, writes nothing. */
export function useOmsMatch() {
  const mutation = useMutation({
    mutationFn: ({ factoryCode, empIds }: { factoryCode: string; empIds: readonly string[] }) => matchWithOms(factoryCode, empIds),
  })
  return (factoryCode: string, empIds: readonly string[]) => mutation.mutateAsync({ factoryCode, empIds })
}

/** 確認匯入 of a 分派表 (#180) on an issued 年度: one write for the whole file, then the list and the 待分派 count refetch. */
export function useImportAssignment() {
  return useWrite(importAssignment, [FORMS, ROUTES, TODO, [...PLANT_PEOPLE], ...ROUTE_VIEWS])
}

/** 確認匯入 of a 分派表 on 下次發出 (Q147): one write onto the 簽核流程, then what a 分派 there changes refetches. */
export function useImportRouteAssignment() {
  return useWrite(importRouteAssignment, [ROUTES, TODO, [...PLANT_PEOPLE], ...ROUTE_VIEWS])
}
