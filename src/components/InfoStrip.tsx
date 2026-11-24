import type { ReactNode } from 'react'
import { palette, textSize } from '../theme'

export interface InfoItem {
  key: string
  label: string
  children: ReactNode
}

/**
 * Facts as one line of label and value pairs under a page's title (方向 A, #131), the labels grey and the values in
 * the text colour, wrapping onto more lines when the screen is narrow.
 */
export function InfoStrip({ items, testId }: { items: InfoItem[]; testId?: string }) {
  return (
    <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 28px', margin: 0, fontSize: textSize(13) }} data-testid={testId}>
      {items.map((item) => (
        <div key={item.key} style={{ display: 'flex', gap: 6, minWidth: 0 }}>
          <dt style={{ flexShrink: 0, color: palette.textTertiary }}>{item.label}</dt>
          <dd style={{ margin: 0, color: palette.text, fontVariantNumeric: 'tabular-nums' }}>{item.children}</dd>
        </div>
      ))}
    </dl>
  )
}
