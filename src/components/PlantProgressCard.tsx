import { ArrowRightOutlined } from '@ant-design/icons'
import { Alert, Card, Empty, Flex, Spin } from 'antd'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TrackingRow } from '../api/tracking'
import { Link } from 'react-router'
import { errorText } from '../domain/errors'
import { plantsProgress, type StageCounts } from '../domain/home'
import { plantOptionLabel } from '../domain/tracking'
import { useLatestTracking } from '../hooks/useTracking'
import { TAB_ROW_HEIGHT } from './MyAssessmentsCard'
import { CARD_STYLE, INK, palette, STAGE_FILL, textSize } from '../theme'

/** The legend's order. */
const STAGES = ['filling', 'signing', 'closed'] as const
/** A bar fills from the left with what is done: 結案, then 簽核中, then 填寫中. */
const BAR_STAGES = ['closed', 'signing', 'filling'] as const
/** How many overdue 範本編號 are named under the count before「…」. */
const NAMED_OVERDUE = 4
const PART_LINE = `1px solid ${palette.rowLine}`

/**
 * 各廠填單進度 (Q115 (4)), for 稽核管理者 and 檢視者 only: the newest 年度's 自評表 counted as 結案 out of all and by
 * stage (填寫中／簽核中／結案), a bar per 廠區 and how many are past the 截止日 and still being filled in. The rows are
 * 追蹤總覽's (view tracking_assessment, the same reach), so the card links there. 方向 A (#129): the count as a number
 * rather than a ring, the stages orange, blue and green.
 */
export function PlantProgressCard() {
  const { t } = useTranslation('home')
  const tracking = useLatestTracking()

  return (
    <Card
      title={tracking.year === null ? t('plants.titleNoYear') : t('plants.title', { year: tracking.year })}
      style={CARD_STYLE}
      // As tall as 我的自評表's tab row beside it.
      styles={{ header: { paddingInline: 'var(--csa-card-pad)', minHeight: TAB_ROW_HEIGHT }, body: { padding: '0 var(--csa-card-pad)' } }}
      data-testid="plant-progress"
      extra={
        <Link to="/admin/tracking" data-testid="plant-progress-link">
          {t('plants.toTracking')} <ArrowRightOutlined />
        </Link>
      }
    >
      {tracking.isPending ? (
        <Padded>
          <Spin />
        </Padded>
      ) : tracking.error ? (
        <Padded>
          <Alert type="warning" showIcon title={errorText(tracking.error)} />
        </Padded>
      ) : tracking.rows.length === 0 ? (
        <Padded>
          <Empty description={t('plants.empty')} />
        </Padded>
      ) : (
        <PlantsProgressBody rows={tracking.rows} />
      )}
    </Card>
  )
}

function Padded({ children }: { children: ReactNode }) {
  return <div style={{ paddingBlock: 'var(--csa-card-pad)' }}>{children}</div>
}

function PlantsProgressBody({ rows }: { rows: readonly TrackingRow[] }) {
  const { t } = useTranslation('home')
  const progress = plantsProgress(rows)
  const { total, overdueFilling } = progress
  // Each 廠區 has its own copy of a 範本編號, so the 廠別代碼 goes with it.
  const named = overdueFilling.slice(0, NAMED_OVERDUE).map((r) => `${r.factory_code} ${r.template_code}`).join('、')
  const tabular: CSSProperties = { fontVariantNumeric: 'tabular-nums' }
  return (
    <div style={{ fontSize: textSize(13), color: palette.textSecondary }}>
      <Flex wrap align="baseline" gap="4px 20px" className="csa-edge-row" style={{ paddingBlock: 10, borderBottom: PART_LINE }}>
        <span data-testid="plant-progress-closed">
          <span style={{ ...tabular, fontSize: textSize(20), fontWeight: 600, color: palette.text }}>{total.closed}</span>
          {t('plants.ofTotalClosed', { total: total.total })}
        </span>
        {STAGES.map((stage) => (
          <Flex key={stage} align="center" gap={6}>
            <Swatch color={STAGE_FILL[stage]} />
            {t(`plants.${stage}`)}
            <span style={tabular} data-testid={`plant-progress-${stage}`}>
              {total[stage]}
            </span>
          </Flex>
        ))}
      </Flex>
      {/* One grid for every row, so the count column is as wide as the widest「26／26」and never wraps at a larger font. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '34px 96px minmax(0, 1fr) auto',
          gridAutoRows: 27,
          alignItems: 'center',
          columnGap: 8,
          paddingBlock: 6,
        }}
      >
        {progress.plants.map((plant) => (
          <div key={plant.id} style={{ display: 'contents' }} data-testid="plant-progress-row">
            <b style={{ fontWeight: 600, color: palette.text }}>{plant.factory_code}</b>
            <span title={plantOptionLabel(plant)} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {plant.name}
            </span>
            <StageBar counts={plant} label={t('plants.plantAria', { plant: plantOptionLabel(plant), closed: plant.closed, total: plant.total })} />
            <span style={{ ...tabular, textAlign: 'end', whiteSpace: 'nowrap', color: palette.text }}>
              {plant.closed}／{plant.total}
            </span>
          </div>
        ))}
      </div>
      <div
        className="csa-edge-row"
        style={{ borderTop: PART_LINE, paddingBlock: 8, color: overdueFilling.length ? INK.red.color : palette.textTertiary }}
        data-testid="plant-progress-overdue"
      >
        {overdueFilling.length
          ? `${t('plants.overdueFilling', { count: overdueFilling.length })}（${named}${overdueFilling.length > NAMED_OVERDUE ? '…' : ''}）`
          : t('plants.noOverdue')}
      </div>
    </div>
  )
}

/** One 廠區's 自評表 as a bar: 結案, 簽核中, 填寫中 side by side from the left, each as wide as its share. */
function StageBar({ counts, label }: { counts: StageCounts; label: string }) {
  return (
    <span role="img" aria-label={label} style={{ display: 'flex', height: 8, overflow: 'hidden', background: STAGE_FILL.track }}>
      {BAR_STAGES.map((stage) =>
        counts[stage] ? <span key={stage} style={{ width: `${(counts[stage] / counts.total) * 100}%`, background: STAGE_FILL[stage] }} /> : null,
      )}
    </span>
  )
}

function Swatch({ color }: { color: string }) {
  return <span aria-hidden style={{ width: 10, height: 10, background: color, flex: 'none' }} />
}
