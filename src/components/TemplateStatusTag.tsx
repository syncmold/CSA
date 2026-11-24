import { useTranslation } from 'react-i18next'
import type { TemplateStatus } from '../api/templates'
import type { Ink } from '../theme'
import { InkDot } from './InkDot'

/** 啟用／停用 in the colours of their meaning (#118): 啟用 green, 停用 grey. */
const STATUS_INKS: Record<TemplateStatus, Ink> = { active: 'green', inactive: 'grey' }

/** 啟用／停用 as a dot and the words (方向 A, #120), shared by the template list and detail pages. */
export function TemplateStatusTag({ status }: { status: TemplateStatus }) {
  const { t } = useTranslation()
  return (
    <InkDot ink={STATUS_INKS[status]} strong>
      {t(`templates.statuses.${status}`)}
    </InkDot>
  )
}

/** 已使用 (has a 自評表 or a 簽核流程: deactivate only) or 未使用 (can be deleted), on both pages (#31); as TemplateStatusTag. */
export function TemplateUsageTag({ inUse }: { inUse: boolean }) {
  const { t } = useTranslation()
  return <InkDot ink={inUse ? 'blue' : 'grey'}>{t(inUse ? 'templates.usage.inUse' : 'templates.usage.unused')}</InkDot>
}
