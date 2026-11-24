// Types for rebuild.mjs (a plain Node script, so its tests can import it).
import type { Client } from 'pg'

export interface RouteStepDef {
  name: string
  group: 'plant' | 'audit_review'
  editableUnit: string | null
  branchUnit?: string
  signer?: string | null
  link?: 'taipei_auditor' | 'audit_chief'
}
export interface RouteDef {
  kind: 'route'
  templateCode: string
  factoryCode: string
  steps: RouteStepDef[]
}
export const SEED_TEMPLATES: string[]
export function templateDefinitions(): { file: string; text: string; def: { code: string; [key: string]: unknown } }[]
export interface RouteShape {
  branchManager: string | null
  merged: string[]
  audit: ('subsidiary' | 'taipei_auditor' | 'audit_chief')[]
}
export function routeShapes(): Record<string, RouteShape & { word: { plant: string[]; audit: string[] } }>
export function routeDefinition(
  templateCode: string,
  factoryCode: string,
  units: string[],
  signers: { taipei: string | null; chief: string },
  shape: RouteShape,
): RouteDef
export function rebuildTemplates(
  client: Client,
  definitions: ReturnType<typeof templateDefinitions>,
  options?: { dryRun?: boolean; overwriteEdits?: boolean; log?: (message: string) => void },
): Promise<unknown>
