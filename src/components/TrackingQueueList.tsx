import { CaretDownOutlined, CaretRightOutlined } from '@ant-design/icons'
import { Button, Flex, Table } from 'antd'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  closedCount, currentStepLabel, daysAtStep, DWELL_THRESHOLDS, dwellLevel, plantLabel, signerLabel, templateLabel, taipeiDate, trackingQueue,
  type PlantQueue, type QueueItem, type TrackingMatrix,
} from '../domain/tracking'
import { HEAT_SHADES, palette, textSize, TRACKING } from '../theme'
import { NO_WRAP } from './tableColumns'

/** How many of a 廠區 show before 「再顯示 n 張」. */
const PREVIEW_ROWS = 10
const ROW_LINE = `1px solid ${palette.rowLine}`
/** A link-like button that sits inline in text (再顯示 n 張, 展開／收起). */
const INLINE_LINK = { height: 'auto', padding: 0 } as const

/**
 * 待處理優先 (Q105): the 自評表 of the matrix grouped by 廠區 (the matrix order), each 廠區's 進行中 ones longest 停留
 * first and its 已結案 ones folded under them. Every 廠區 starts folded, its heading's counts the overview. Same
 * rows as the 熱度矩陣, the same filters applied; the page remounts it when the filters or the 年度 change, so the
 * 廠區 fold again. 方向 A (#128): headings and tables to the card's edges, 再顯示 and the 已結案 fold on one line under
 * the table.
 */
export function TrackingQueueList({ matrix }: { matrix: TrackingMatrix }) {
  const { t } = useTranslation('tracking')
  const queue = trackingQueue(matrix)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const [closedOpen, setClosedOpen] = useState<Record<string, boolean>>({})

  const columns = [
    {
      title: t('queue.columns.days'),
      key: 'days',
      width: 110,
      render: (_: unknown, item: QueueItem) => <DaysChip days={daysAtStep(item.row)} />,
    },
    { title: t('queue.columns.assessment'), key: 'assessment', render: (_: unknown, item: QueueItem) => <AssessmentLink item={item} /> },
    {
      title: t('queue.columns.step'),
      key: 'step',
      ...NO_WRAP,
      // Only the 關卡 it waits at, no 第 n／m 關 or bar (user decision 2026-11-04, #99): the 分流 make the numbers meaningless.
      render: (_: unknown, item: QueueItem) => currentStepLabel(item.row),
    },
    { title: t('queue.columns.signer'), key: 'signer', ...NO_WRAP, render: (_: unknown, item: QueueItem) => signerLabel(item.row, t) },
    { title: t('queue.columns.due'), key: 'due', ...NO_WRAP, render: (_: unknown, item: QueueItem) => item.row.due_date },
  ]

  return (
    <Flex vertical data-testid="tracking-queue">
      {queue.plants.map((p) => {
        const id = p.plant.id
        const code = p.plant.factory_code
        const shown = showAll[id] ? p.inProgress : p.inProgress.slice(0, PREVIEW_ROWS)
        const closedShown = !!closedOpen[id] && p.closed.length > 0
        const more = p.inProgress.length - shown.length
        return (
          <section key={id} data-testid={`tracking-plant-${code}`}>
            <Fold
              open={!!open[id]}
              onToggle={() => setOpen({ ...open, [id]: !open[id] })}
              label={
                <span title={plantLabel(p.plant)}>
                  <span style={{ fontWeight: 600 }}>{code}</span>　{p.plant.plant_name}
                </span>
              }
              end={<PlantCounts queue={p} />}
            />
            {open[id] && (
              <>
                {shown.length > 0 && (
                  <Table<QueueItem> className="csa-edge-table" rowKey={(item) => item.row.assessment_id} size="small" pagination={false} scroll={{ x: 'max-content' }} dataSource={shown} columns={columns} />
                )}
                {(more > 0 || p.closed.length > 0) && (
                  <Flex className="csa-edge-row" justify="space-between" wrap gap="4px 16px" style={{ paddingBlock: 8, borderBottom: ROW_LINE, fontSize: textSize(13) }}>
                    {more > 0 ? (
                      <Button type="link" data-testid={`tracking-plant-${code}-more`} onClick={() => setShowAll({ ...showAll, [id]: true })} style={INLINE_LINK}>
                        {t('queue.more', { count: more })}
                      </Button>
                    ) : (
                      <span />
                    )}
                    {p.closed.length > 0 && (
                      <span data-testid={`tracking-plant-${code}-closed`} style={{ color: palette.textTertiary }}>
                        {t('queue.closed', { count: p.closed.length })}
                        {'　'}
                        <Button type="link" aria-expanded={closedShown} onClick={() => setClosedOpen({ ...closedOpen, [id]: !closedOpen[id] })} style={INLINE_LINK}>
                          {closedShown ? t('queue.collapse') : t('queue.expand')}
                        </Button>
                      </span>
                    )}
                  </Flex>
                )}
                {closedShown && (
                  <Table<QueueItem>
                    className="csa-edge-table"
                    rowKey={(item) => item.row.assessment_id}
                    size="small"
                    pagination={false}
                    dataSource={p.closed}
                    columns={[
                      { title: t('queue.columns.assessment'), key: 'assessment', render: (_, item) => <AssessmentLink item={item} /> },
                      { title: t('queue.columns.closedAt'), key: 'closedAt', ...NO_WRAP, render: (_, item) => (item.row.closed_at ? taipeiDate(item.row.closed_at) : '') },
                    ]}
                  />
                )}
              </>
            )}
          </section>
        )
      })}
    </Flex>
  )
}

/**
 * 「進行中 11 · ≥ 7 天 5（≥ 14 天 1）· 已結案 5／16」 on a 廠區's heading, always all three; the 停留 part rose when any
 * has stayed long (only that part: 已結案 is not something waiting).
 */
function PlantCounts({ queue }: { queue: PlantQueue }) {
  const { t } = useTranslation('tracking')
  const parts: ReactNode[] = [
    t('queue.inProgress', { count: queue.inProgress.length }),
    <span key="long" style={queue.long > 0 ? { color: TRACKING.veryLong.text } : undefined}>
      {t('queue.long', { ...DWELL_THRESHOLDS, count: queue.long, veryLongCount: queue.veryLong })}
    </span>,
    t('queue.closedShare', { ...closedCount(queue.plant.rows) }),
  ]
  return (
    <span
      style={{
        display: 'inline-flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, fontSize: textSize(13), fontWeight: 400,
        fontVariantNumeric: 'tabular-nums', color: palette.textSecondary,
      }}
    >
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && '· '}
          {part}
        </span>
      ))}
    </span>
  )
}

/** A 廠區's heading, which opens and closes it; open, it is tinted and ruled off from its table. */
function Fold({ open, onToggle, label, end }: { open: boolean; onToggle: () => void; label: ReactNode; end: ReactNode }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="csa-edge-row"
      style={{
        display: 'flex', width: 'calc(100% + 2 * var(--csa-card-pad))', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center',
        gap: '4px 16px', paddingBlock: 9, border: 0, borderBottom: open ? `1px solid ${palette.border}` : ROW_LINE,
        background: open ? palette.bg : 'transparent', font: 'inherit', color: palette.text, cursor: 'pointer', textAlign: 'left',
      }}
    >
      {/* Spans, not antd Flex (a div), since a button may hold only phrasing content. */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
        {open ? <CaretDownOutlined aria-hidden /> : <CaretRightOutlined aria-hidden />}
        {label}
      </span>
      {end}
    </button>
  )
}

/** 「範本」 linked to the 自評表 (its 廠區 is the heading above). */
function AssessmentLink({ item }: { item: QueueItem }) {
  return (
    <Link to={`/assessments/${item.row.assessment_id}`} data-testid={`tracking-queue-${item.plant.factory_code}-${item.row.template_code}`}>
      {templateLabel(item.row)}
    </Link>
  )
}

/** The 停留天數, shaded like its 熱度矩陣 cell. */
function DaysChip({ days }: { days: number }) {
  return (
    <span
      style={{
        ...HEAT_SHADES[dwellLevel(days)], display: 'inline-block', minWidth: 34, padding: '0 6px', boxSizing: 'border-box', textAlign: 'center',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {days}
    </span>
  )
}
