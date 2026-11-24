import { ConfigProvider, Flex, Tabs, type TabsProps } from 'antd'
import type { ReactNode } from 'react'
import { palette, textSize } from '../theme'

/**
 * EdgeTabs' sizes over the theme's tabs (antd merges a nested theme into the one around it): smaller words, wider gaps,
 * and one line under the row in the edge of a control.
 */
const EDGE_TABS_THEME = {
  components: {
    Tabs: {
      horizontalItemPadding: '10px 0 8px',
      horizontalItemGutter: 24,
      horizontalMargin: '0',
      titleFontSize: textSize(13),
      itemColor: palette.textSecondary,
      // As the line under 範本管理's table header (ComponentGroups), as the user asked (2026-11-10).
      colorBorderSecondary: palette.controlBorder,
    },
  },
}

/** A gap as wide as the card's padding (global.css's --csa-card-pad), at each end of the tab row. */
const CARD_PAD_GAP = <span style={{ display: 'block', width: 'var(--csa-card-pad)' }} />

/**
 * Small tabs across the top of a card (方向 A, #120): the chosen one purple with a 2px line under it, one thin line under
 * the row, which runs to the card's edges (global.css's csa-edge-tabs): 範本管理's and 簽核流程's 組成要素
 * (ComponentGroups), 年度發起's 狀態 and 權限管理's three tabs. The tabs keep the card's padding through a gap at each end
 * of the row, and `extra` sits at its right end; both as antd's own extra content, so antd counts them when folding tabs
 * into 「⋯」.
 */
export function EdgeTabs({ extra, ...props }: Omit<TabsProps, 'className' | 'tabBarExtraContent'> & { extra?: ReactNode }) {
  return (
    <ConfigProvider theme={EDGE_TABS_THEME}>
      <Tabs
        {...props}
        className="csa-edge-tabs"
        tabBarExtraContent={{
          left: CARD_PAD_GAP,
          right: extra ? (
            <Flex align="center">
              {extra}
              {CARD_PAD_GAP}
            </Flex>
          ) : (
            CARD_PAD_GAP
          ),
        }}
      />
    </ConfigProvider>
  )
}

/** A tab's name and its count, in the same colour (方向 A, #120). No count while the list is still loading. */
export function TabLabel({ name, count, testId }: { name: ReactNode; count?: number; testId?: string }) {
  return (
    <span data-testid={testId}>
      {name}
      {count !== undefined && (
        <span style={{ marginInlineStart: 6, fontVariantNumeric: 'tabular-nums' }} data-testid={testId && `${testId}-count`}>
          {count}
        </span>
      )}
    </span>
  )
}
