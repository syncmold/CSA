import { useQuery } from '@tanstack/react-query'
import { createAssessingUnit, deleteAssessingUnit, fetchAssessingUnits, renameAssessingUnit } from '../api/assessingUnits'
import { useWrite } from './useWrite'

const UNITS = ['assessing-units']

export function useAssessingUnits() {
  return useQuery({ queryKey: UNITS, queryFn: fetchAssessingUnits })
}

/** 自評單位清單 edits. A rename also shows on every template page, so templates refresh too. */
export function useAssessingUnitEditing() {
  return {
    create: useWrite(createAssessingUnit, [UNITS]),
    rename: useWrite(renameAssessingUnit, [UNITS, ['templates']]),
    remove: useWrite(deleteAssessingUnit, [UNITS]),
  }
}
