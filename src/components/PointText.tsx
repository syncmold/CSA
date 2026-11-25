import { Tag } from 'antd'
import { useTranslation } from 'react-i18next'
import { INK, POINT_TEXT_STYLE } from '../theme'

/**
 * A control point's text as on paper (Q126), with 「反向題」 after it when it is one (Q148), in 範本管理 and on the 答題頁
 * alike. The tag is orange, 方向 A's 提醒 (#118): the question asks for 改善措施／補充說明 on 「是」 rather than 「否」.
 */
export function PointText({ text, isReverse }: { text: string; isReverse: boolean }) {
  const { t } = useTranslation()
  return (
    <span style={POINT_TEXT_STYLE}>
      {text}
      {isReverse && (
        <Tag
          style={{ marginInlineStart: 8, marginInlineEnd: 0, color: INK.orange.color, background: INK.orange.background, borderColor: INK.orange.border }}
          data-testid="reverse-tag"
        >
          {t('templates.reverseTag')}
        </Tag>
      )}
    </span>
  )
}
