// 在職 as OMS's channel says it (#218, Q133 (10)), for the 發出前離職檢查 (Q147 (4)). Only 在職 people can sign: someone
// 離職, 留停, 轉調 or not known to OMS at all is someone the 稽核主管 has to replace on the route before the launch.
import type { Employment } from '../../exchange/omsChannel'

/** The 工號 that are not 在職, as they were asked (each answer's `asked`: trimmed, upper case). */
export function notEmployed(people: readonly { asked: string; status: Employment }[]): string[] {
  return people.filter((p) => p.status !== 'active').map((p) => p.asked)
}
