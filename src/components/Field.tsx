import type { ReactNode } from 'react'
import { palette } from '../theme'

/**
 * A field in a toolbar with its name on the left (方向 A, #128): 追蹤總覽's, 分派填寫人's and 年度發起's filters. A `label`
 * element when its control is a plain input, so clicking the name focuses it.
 */
export function Field({ label, as: Tag = 'div', children }: { label: string; as?: 'div' | 'label'; children: ReactNode }) {
  return (
    <Tag style={{ display: 'flex', alignItems: 'center', gap: 8, color: palette.textSecondary, whiteSpace: 'nowrap' }}>
      {label}
      {children}
    </Tag>
  )
}
