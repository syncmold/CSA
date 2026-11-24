import { useQuery } from '@tanstack/react-query'
import { fetchExchangeStatus } from '../api/exchange'

/** The exchange's 開發期 switches (放行全開 Q62, 直接登入 Q82); they do not change while the page is open. */
export function useExchangeStatus() {
  return useQuery({ queryKey: ['exchange-status'], queryFn: fetchExchangeStatus, staleTime: Infinity })
}
