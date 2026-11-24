// 匯出 PDF (#7): what the PDF is made from. Kept apart from assessmentPdf.ts (which goes through the browser
// client) and given the client, so tests/db reads it exactly as the page does, signed in as each 簽核人.
// Who may read it is RLS's call, as for the page (ADR-0001).
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Assessment } from './assessments'
import { ASSESSMENT_COMPANY, ASSESSMENT_TREE, SIGNOFF_COLUMNS } from './assessmentQuery'
import type { Signoff } from './signoffModel'

export interface AssessmentPdfSource {
  /** As stored; the PDF puts sections, control points and 關卡 in order itself. */
  assessment: Assessment
  /** The whole 簽核歷程, voided sign-offs included. */
  signoffs: Signoff[]
  company: { name: string; logo_path: string | null }
}

type Company = AssessmentPdfSource['company']

/** One read of the 自評表 with its company, one of its 簽核歷程; null when RLS hides it (or it does not exist). */
export async function readAssessmentPdfSource(client: SupabaseClient, id: string): Promise<AssessmentPdfSource | null> {
  const [row, signoffs] = await Promise.all([
    client
      .from('assessment')
      .select(`${ASSESSMENT_TREE},${ASSESSMENT_COMPANY}`)
      .eq('id', id)
      .maybeSingle<Assessment & { pdf_company: { company: Company } }>(),
    client.from('assessment_signoff').select(SIGNOFF_COLUMNS).eq('assessment_id', id).order('signed_at').order('serial_no'),
  ])
  if (row.error) throw row.error
  if (signoffs.error) throw signoffs.error
  if (!row.data) return null
  const { pdf_company, ...assessment } = row.data
  return { assessment, signoffs: signoffs.data as unknown as Signoff[], company: pdf_company.company }
}
