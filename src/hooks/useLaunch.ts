import { useQuery } from '@tanstack/react-query'
import { fetchLaunchCandidates, fetchLaunchedCycles, launchCycle } from '../api/launch'
import { LAUNCHED_YEARS } from './useYearChoice'
import { useWrite } from './useWrite'

const CANDIDATES = ['launch-candidates']
const CYCLES = ['annual-cycles']

export function useLaunchCandidates() {
  return useQuery({ queryKey: CANDIDATES, queryFn: fetchLaunchCandidates })
}

export function useLaunchedCycles() {
  return useQuery({ queryKey: CYCLES, queryFn: fetchLaunchedCycles })
}

/**
 * A launch (accepted or refused) refreshes the candidates, whose routes may have changed meanwhile, the
 * launched years, and 我的待簽: the 稽核管理者 may be the 第 1 關 signer of some of the new 自評表.
 */
export function useLaunchCycle() {
  // The 年度 menu (#175) gains the next year, and the launched one turns to a top-up.
  return useWrite(launchCycle, [CANDIDATES, CYCLES, ['my-tasks'], LAUNCHED_YEARS])
}
