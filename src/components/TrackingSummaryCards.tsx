import { useTranslation } from 'react-i18next'
import { DWELL_THRESHOLDS, type TrackingSummary } from '../domain/tracking'
import { palette, textSize, TRACKING } from '../theme'

/**
 * The four counts above 追蹤總覽, of the matrix shown (the filters applied); both views share them. #128: one
 * strip of label over number, 已結案 and the long 停留 in their 熱度矩陣 colours (TRACKING); four across, wrapping on a
 * narrow screen (CSS alone, so it never redraws in another layout once mounted). Each count draws the line to its right
 * and below; the strip clips those at its own edges.
 */
export function TrackingSummaryCards({ summary }: { summary: TrackingSummary }) {
  const { t } = useTranslation('tracking')
  const size = t('kpi.total', { plants: summary.plants, templates: summary.templates })
  const tiles: { testId: string; value: number; label: string; color: string }[] = [
    {
      testId: 'tracking-kpi-total',
      value: summary.total,
      label: summary.notLaunched ? `${size} · ${t('kpi.notLaunched', { count: summary.notLaunched })}` : size,
      color: palette.text,
    },
    { testId: 'tracking-kpi-in-progress', value: summary.inProgress, label: t('kpi.inProgress'), color: palette.text },
    { testId: 'tracking-kpi-closed', value: summary.closed, label: t('kpi.closed', { percent: summary.closedPercent }), color: TRACKING.closed.text },
    {
      testId: 'tracking-kpi-long',
      value: summary.long,
      label: t('kpi.long', { ...DWELL_THRESHOLDS, veryLongCount: summary.veryLong }),
      color: TRACKING.veryLong.text,
    },
  ]
  return (
    <dl
      data-testid="tracking-summary"
      style={{
        display: 'flex', flexWrap: 'wrap', margin: 0, overflow: 'hidden',
        background: palette.surface, border: `1px solid ${palette.border}`, borderRadius: palette.radiusLG,
      }}
    >
      {tiles.map((tile) => (
        // A label that wraps pushes its number down: the numbers line up along the bottom.
        <div
          key={tile.testId}
          data-testid={tile.testId}
          style={{
            flex: '1 1 160px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '10px 20px',
            boxShadow: `1px 0 ${palette.border}, 0 1px ${palette.border}`,
          }}
        >
          <dt style={{ fontSize: textSize(13), color: palette.textTertiary }}>{tile.label}</dt>
          <dd style={{ margin: 0, fontSize: textSize(22), fontWeight: 600, lineHeight: 1.3, color: tile.color, fontVariantNumeric: 'tabular-nums' }}>{tile.value}</dd>
        </div>
      ))}
    </dl>
  )
}
