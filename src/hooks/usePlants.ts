import { useQuery } from '@tanstack/react-query'
import { fetchPlants } from '../api/plants'

export function usePlants() {
  return useQuery({ queryKey: ['plants'], queryFn: fetchPlants, staleTime: 5 * 60_000 })
}
