import { Flex } from 'antd'
import type { ReactNode } from 'react'
import { INK, palette, textSize } from '../theme'

/**
 * The bar under a page's title holding what the page shows (#173): its menus, then a line on what they mean. Pale
 * purple, or grey for a launched year. 年度發起's 年度 bar (YearBar) and 分派填寫人's 年度 and 廠區.
 */
export function ChoiceBar({
  launched = false,
  label,
  note,
  testId,
  noteTestId,
  actions,
  children,
}: {
  /** 年度發起 on a launched year (a top-up): grey instead of pale purple. */
  launched?: boolean
  label: string
  note: ReactNode
  testId: string
  noteTestId: string
  /** Buttons at the bar's right end, after the note (分派填寫人's 下載／匯入分派表, #180). */
  actions?: ReactNode
  children: ReactNode
}) {
  const tone = launched
    ? { background: INK.grey.background, border: INK.grey.border, color: palette.textSecondary }
    : { background: palette.selectedBg, border: palette.selectedBorder, color: palette.selectedText }
  return (
    <Flex
      align="center"
      gap="6px 14px"
      wrap
      role="group"
      aria-label={label}
      style={{ padding: '8px 14px', borderRadius: palette.radius, border: `1px solid ${tone.border}`, background: tone.background, fontSize: textSize(13) }}
      data-testid={testId}
      data-launched={launched}
    >
      {children}
      <span style={{ color: tone.color, flex: '1 1 320px' }} data-testid={noteTestId}>
        {note}
      </span>
      {actions}
    </Flex>
  )
}
