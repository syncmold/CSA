// 匯出 PDF (#7): what the PDF is made from, read fresh at the moment of export so a mid-route export shows the
// 自評表 as it stands. The query itself is in assessmentPdfQuery.ts, shared with tests/db.
import { readAssessmentPdfSource, type AssessmentPdfSource } from './assessmentPdfQuery'
import { supabase } from './supabase'

export type { AssessmentPdfSource }

/** Null when RLS hides the 自評表 (or it does not exist). */
export function fetchAssessmentPdfSource(id: string): Promise<AssessmentPdfSource | null> {
  return readAssessmentPdfSource(supabase, id)
}
