import { Button } from 'antd'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { palette, textSize } from '../theme'

/**
 * 查看／修改 (#66, Q103): a 範本 or 簽核流程 opens read-only from its list, so looking cannot change anything by
 * accident. 「修改」 shows `${viewPath}/edit`, where the editing controls (`children`) are, under 修改中;
 * 「完成修改」 shows the read-only page again. Both replace the current history entry instead of adding one,
 * so the browser's 上一頁 always goes back to the list — never to a mode the user already left, nor to an item
 * that was just deleted (the user's choice, option 1). 方向 A (#122): the buttons have no icons and 修改中 is words in
 * the selected item's purple.
 */
export function EditModeControls({ editing, viewPath, children }: { editing: boolean; viewPath: string; children?: ReactNode }) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  if (!editing) {
    return (
      <Button onClick={() => navigate(`${viewPath}/edit`, { replace: true })} data-testid="start-editing">
        {t('editMode.start')}
      </Button>
    )
  }
  return (
    <>
      <span style={{ color: palette.selectedText, fontSize: textSize(13), fontWeight: 500 }} data-testid="editing-badge">
        {t('editMode.badge')}
      </span>
      {children}
      <Button type="primary" onClick={() => navigate(viewPath, { replace: true })} data-testid="finish-editing">
        {t('editMode.finish')}
      </Button>
    </>
  )
}
