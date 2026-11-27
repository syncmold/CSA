import { useQuery } from '@tanstack/react-query'
import { fetchMyRunPlantIds, fetchRunsAPlant } from '../api/access'
import { fetchMyAuditRole, fetchMyViewerPlantIds } from '../api/employee'
import { actsAsAuditAdmin, canEditRoute, canEditTemplate, exportablePlants, mayAddSettings, mayViewPlants, seesTracking, type TemplateScope } from '../domain/access'
import { usePlants } from './usePlants'
import { useAuth } from '../auth/AuthContext'

/**
 * 稽核角色 of the signed-in employee, for showing/hiding navigation only.
 * The database enforces the real permission (ADR-0001); a wrong guess here just shows an empty page.
 */
export function useMyAuditRole() {
  const { session } = useAuth()
  const empId = session?.employee.emp_id
  return useQuery({
    queryKey: ['my-audit-role', empId],
    queryFn: () => fetchMyAuditRole(empId!),
    enabled: !!empId,
    staleTime: 5 * 60_000,
  })
}

/** Whether the signed-in employee runs any plant as 廠區負責人; keyed under the role's key so 權限管理 refreshes both. */
export function useRunsAPlant() {
  const { session } = useAuth()
  const empId = session?.employee.emp_id
  return useQuery({
    queryKey: ['my-audit-role', 'runs-a-plant', empId],
    queryFn: () => fetchRunsAPlant(empId!),
    enabled: !!empId,
    staleTime: 5 * 60_000,
  })
}

/**
 * The signed-in employee's own 檢視廠區 (Q153): asked only for a 一般使用者, the one role that may have any. Keyed under
 * the role's key so 人員管理 refreshes it too.
 */
function useMyViewerPlantIds() {
  const { session } = useAuth()
  const empId = session?.employee.emp_id
  const role = useMyAuditRole()
  return useQuery({
    queryKey: ['my-audit-role', 'viewer-plants', empId],
    queryFn: () => fetchMyViewerPlantIds(empId!),
    enabled: !!empId && mayViewPlants(role.data),
    staleTime: 5 * 60_000,
  })
}

/**
 * Whether the signed-in employee sees 進度追蹤 (and 我的待辦's 各廠填單進度): a 稽核主管 or 系統維護員, a 一般使用者 with
 * 檢視廠區 (Q153), or anyone who runs a plant (Q117 (3)). For showing and hiding only; `isLoading` until the answers are in.
 */
export function useSeesTracking() {
  const role = useMyAuditRole()
  const runsAPlant = useRunsAPlant()
  const viewerPlants = useMyViewerPlantIds()
  return {
    sees: seesTracking(role.data, runsAPlant.data ?? false, (viewerPlants.data ?? []).length > 0),
    isLoading: role.isLoading || runsAPlant.isLoading || viewerPlants.isLoading,
  }
}

/** Whether the signed-in employee gets 分派填寫人 (#101): a 稽核管理者, or anyone who runs a plant. For showing and hiding only. */
export function useAssignsSigners(): boolean {
  const role = useMyAuditRole()
  const runsAPlant = useRunsAPlant()
  return actsAsAuditAdmin(role.data) || runsAPlant.data === true
}

/**
 * The plants the signed-in employee may export from 追蹤總覽 (exportablePlants); none while loading. Keyed under the
 * role's key so 權限管理 refreshes it too.
 */
export function useExportablePlants(): 'all' | string[] {
  const { session } = useAuth()
  const empId = session?.employee.emp_id
  const role = useMyAuditRole()
  const viewerPlants = useMyViewerPlantIds()
  const runPlants = useQuery({
    queryKey: ['my-audit-role', 'run-plants', empId],
    queryFn: () => fetchMyRunPlantIds(empId!),
    enabled: !!empId && role.data === 'audit_staff',
    staleTime: 5 * 60_000,
  })
  return exportablePlants(role.data, viewerPlants.data ?? [], runPlants.data ?? [])
}

/**
 * What the signed-in employee may change among 範本, 簽核流程 and 自評單位 (Q144): everything for a 稽核主管 and 系統維護員, the
 * plants he runs for a 稽核人員. For showing and hiding only; the database decides. `runCodes` is null for those who
 * are not limited to plants, and the 廠區代碼 a 稽核人員 may pick for a new 範本 otherwise.
 */
export function useSettingsRights() {
  const { session } = useAuth()
  const empId = session?.employee.emp_id
  const role = useMyAuditRole()
  const plants = usePlants()
  const runPlants = useQuery({
    queryKey: ['my-audit-role', 'run-plants', empId],
    queryFn: () => fetchMyRunPlantIds(empId!),
    enabled: !!empId && role.data === 'audit_staff',
    staleTime: 5 * 60_000,
  })
  const runPlantIds = role.data === 'audit_staff' ? (runPlants.data ?? []) : []
  const runCodes = (plants.data ?? []).filter((p) => runPlantIds.includes(p.id)).map((p) => p.factory_code)
  return {
    role: role.data,
    canAdd: mayAddSettings(role.data, runPlantIds),
    /** 稽核主管 and 系統維護員 only: 自評單位 may be renamed and deleted, and a 範本 may apply to all plants. */
    isAdmin: actsAsAuditAdmin(role.data),
    runCodes: role.data === 'audit_staff' ? runCodes : null,
    runPlantIds: role.data === 'audit_staff' ? runPlantIds : null,
    canEditTemplate: (tpl: TemplateScope) => canEditTemplate(role.data, runCodes, tpl),
    canEditRoute: (plantId: string) => canEditRoute(role.data, runPlantIds, plantId),
  }
}
