import { useQuery } from '@tanstack/react-query'
import {
  addAccessMembers, fetchAccessMembers, fetchChangeLog, fetchRemovalImpact, removeAccessMember, removePlantCoordinator, setPlantCoordinator,
  updateAccessMember,
} from '../api/access'
import { useWrite } from './useWrite'

const ACCESS = ['access']
const MEMBERS = [...ACCESS, 'members']
const LOG = [...ACCESS, 'log']

export function useAccessMembers() {
  return useQuery({ queryKey: MEMBERS, queryFn: fetchAccessMembers })
}

export function useChangeLog() {
  return useQuery({ queryKey: LOG, queryFn: fetchChangeLog })
}

export function useRemovalImpact(empId: string) {
  return useQuery({ queryKey: [...ACCESS, 'impact', empId], queryFn: () => fetchRemovalImpact(empId), staleTime: 0 })
}

/**
 * Every change refreshes the list and the 異動紀錄, and the signed-in person's own role and plants: a 稽核管理者 may
 * change themselves, and the menu follows.
 */
export function useAccessEditing() {
  const refresh = [ACCESS, ['my-audit-role']]
  return {
    add: useWrite(addAccessMembers, refresh),
    update: useWrite(updateAccessMember, refresh),
    remove: useWrite(removeAccessMember, refresh),
    setCoordinator: useWrite(setPlantCoordinator, refresh),
    removeCoordinator: useWrite(removePlantCoordinator, refresh),
  }
}
