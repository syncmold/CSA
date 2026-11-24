import type { ReactNode } from 'react'
import { INK, type Ink } from '../theme'

/**
 * A status in 方向 A (#118, #120): a dot and the words in the colour of their meaning, no pill around them. The words
 * always say it, so the colour is never the only sign. `strong` for the one that matters most in its row (狀態).
 */
export function InkDot({ ink, strong, children }: { ink: Ink; strong?: boolean; children: ReactNode }) {
  const { color } = INK[ink]
  return (
    <span style={{ color, fontWeight: strong ? 500 : undefined, whiteSpace: 'nowrap' }}>
      <span aria-hidden style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginInlineEnd: 6, verticalAlign: 1 }} />
      {children}
    </span>
  )
}

/** A symbol before words (✓, !), for the eye only: the words say it (#118: never colour alone). */
export function SymbolMark({ children, gap = 6 }: { children: string; gap?: number }) {
  return (
    <span aria-hidden style={{ marginInlineEnd: gap }}>
      {children}
    </span>
  )
}

/** As InkDot with a symbol for the dot (簽核流程's 發起檢查, #121): 「✓ 通過」, 「! 尚未通過」. */
export function InkMark({ ink, mark, children }: { ink: Ink; mark: string; children: ReactNode }) {
  return (
    <span style={{ color: INK[ink].color, fontWeight: 500, whiteSpace: 'nowrap' }}>
      <SymbolMark gap={4}>{mark}</SymbolMark>
      {children}
    </span>
  )
}
