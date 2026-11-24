import { useTranslation } from 'react-i18next'
import { LAST_MODIFIED_GAP, modifiedAt, modifiedBy, type LastModifiedFields } from '../domain/lastModified'
import { palette, textSize } from '../theme'

/**
 * A list's 最後修改 cell (#201, Q137 (3)), the same on 範本管理 and 簽核流程: the time over the 修改人, a size below the
 * table's text and faint (the time in textTertiary, the 修改人 a step paler), so it stays out of the way of the row.
 */
export function LastModifiedCell({ row }: { row: LastModifiedFields }) {
  const who = useModifiedBy(row)
  return (
    <span style={{ display: 'block', fontSize: textSize(12), lineHeight: 1.4, color: palette.textTertiary }} data-testid="last-modified">
      <span style={{ display: 'block' }}>{modifiedAt(row)}</span>
      <span style={{ display: 'block', color: palette.dashed }}>{who}</span>
    </span>
  )
}

/**
 * The 範本明細 header's 最後修改 (#201): one line, the time, two full-width spaces, the 修改人. The
 * header gives it a row of its own, so it fits; on a screen too narrow even for that it breaks between the two, never
 * inside either.
 */
export function LastModifiedLine({ row }: { row: LastModifiedFields }) {
  const who = useModifiedBy(row)
  return (
    <span data-testid="last-modified-line">
      <span style={{ whiteSpace: 'nowrap' }}>{modifiedAt(row)}</span>
      {LAST_MODIFIED_GAP}
      <span style={{ whiteSpace: 'nowrap' }}>{who}</span>
    </span>
  )
}

/** The 修改人 as shown: the 管理員帳號 by the 權限異動紀錄's own words for it. */
function useModifiedBy(row: LastModifiedFields): string {
  const { t } = useTranslation('access')
  return modifiedBy(row, t('byAdminAccount'))
}
