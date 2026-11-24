import { useTranslation } from 'react-i18next'
import type { AssessmentStatus } from '../api/assessments'
import type { Ink } from '../theme'
import { InkDot } from './InkDot'

/** 簽核中 is in progress (blue), 結案 done (green). */
const STATUS_INKS: Record<AssessmentStatus, Ink> = { in_progress: 'blue', closed: 'green' }

/** 簽核中／結案 of a 自評表 on its page: a dot and the words in the colour of their meaning (方向 A, #131). */
export function AssessmentStatusTag({ status }: { status: AssessmentStatus }) {
  const { t } = useTranslation()
  return (
    <InkDot ink={STATUS_INKS[status]} strong>
      {t(`assessments.statuses.${status}`)}
    </InkDot>
  )
}
