import { Flex, Typography } from 'antd'
import type { ReactNode } from 'react'
import { palette, textSize } from '../theme'

/** A page's heading (方向 A, #119): the title, an optional grey line under it, and the page's actions on the right. */
export function PageHeader({
  title,
  subtitle,
  extra,
  titleTestId,
}: {
  title: ReactNode
  subtitle?: ReactNode
  extra?: ReactNode
  titleTestId?: string
}) {
  return (
    <Flex justify="space-between" align="center" gap={12} wrap>
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={2} style={{ margin: 0, fontSize: textSize(22), fontWeight: 600, lineHeight: 1.35 }} data-testid={titleTestId}>
          {title}
        </Typography.Title>
        {subtitle && (
          <Flex align="center" gap={10} wrap style={{ marginTop: 4, color: palette.textTertiary, fontSize: textSize(13) }}>
            {subtitle}
          </Flex>
        )}
      </div>
      {extra && (
        <Flex align="center" gap={8} wrap>
          {extra}
        </Flex>
      )}
    </Flex>
  )
}
