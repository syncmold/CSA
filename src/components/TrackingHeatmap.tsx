import { CaretRightOutlined, CheckOutlined } from '@ant-design/icons'
import { Button, Dropdown, Flex } from 'antd'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import {
  cellLines, cellRows, closedCount, columnHeader, columnLabel, daysAtStep, dwellLabel, heatLevel, plantLabel, singleAssessment, templateLabel,
  type HeatLevel, type TrackingCell, type TrackingColumn, type TrackingMatrix,
} from '../domain/tracking'
import { HEAT_SHADES, palette, textSize } from '../theme'

/** The card's padding (TrackingPage): the first and last columns keep it, so the table runs to the card's edges. */
const CARD_PAD = 'var(--csa-card-pad)'
const CELL: CSSProperties = {
  display: 'block', boxSizing: 'border-box', width: '100%', maxWidth: 220, height: 28, margin: '0 auto', lineHeight: '28px',
  textAlign: 'center', fontSize: textSize(13), fontVariantNumeric: 'tabular-nums', textDecoration: 'none', whiteSpace: 'nowrap',
}
/**
 * Column widths, fixed (#128) so 控制作業's 22 forms fit beside the other 組成要素 in a 1440 screen's card (1,100 of
 * its 1,120px): a wider card shares out the rest, a narrower one scrolls, its 廠區 column staying put. The 廠區 and
 * 已結案 widths include the card's padding.
 */
const WIDTH = { plant: 150, component: 52, controls: 56, controlsFolded: 80, form: 28, closed: 70 } as const
const MUTED: CSSProperties = { color: palette.textTertiary, fontWeight: 400 }
const HEAD: CSSProperties = { padding: '6px 2px', fontWeight: 600, lineHeight: 1.3, textAlign: 'center', overflowWrap: 'anywhere' }
/**
 * A form's header: two sizes smaller, two characters to a line (twoLines breaks it, nothing else may), a faint rule
 * between neighbours so the names stay apart.
 */
const FORM_HEAD: CSSProperties = {
  ...HEAD, paddingInline: 0, fontSize: textSize(11), lineHeight: 1.25, whiteSpace: 'nowrap', overflowWrap: 'normal',
  borderLeft: `1px solid ${palette.rowLine}`,
}
/** The 廠區 column: a long name takes a second line, which the row's height holds. */
const PLANT: CSSProperties = {
  position: 'sticky', left: 0, zIndex: 1, textAlign: 'left', lineHeight: 1.25, overflowWrap: 'anywhere', padding: `0 8px 0 ${CARD_PAD}`,
}
/**
 * Row lines go on the cells, not the rows, in a table of separate borders: collapsed borders stay behind when the
 * sticky 廠區 column scrolls over them.
 */
const ROW_CELL: CSSProperties = { borderTop: `1px solid ${palette.rowLine}` }
/** The lines either side of 控制作業 and its forms, so they read as one group. */
const GROUP_EDGE = `1px solid ${palette.border}`

export interface TrackingHeatmapProps {
  matrix: TrackingMatrix
  /** 控制作業 shown form by form (#86); folded, it is one column. */
  expanded: boolean
  onToggleExpanded: () => void
}

/**
 * 熱度矩陣 (#86): 廠區 × 組成要素, 控制作業 one column of 「已結案／張數」 that opens into a column per form. A cell of one
 * 自評表 shows only its 停留天數 (a tick once 結案); several show 已結案／張數. Shaded by the thresholds, framed where
 * not yet launched, a dash where the 廠區 has no such 範本. The full text of a cell, the one the Excel 總覽 gets
 * (cellLines), is its title and accessible name, and the headers' titles are the Excel headers, so the screen
 * (expanded) and the export still come from one source. #128: a plain table to the card's edges, the legend strip
 * above it; opened, 控制作業 heads a group over 合計 and its forms, the other 組成要素 spanning both header rows.
 */
export function TrackingHeatmap({ matrix, expanded, onToggleExpanded }: TrackingHeatmapProps) {
  const { t } = useTranslation('tracking')
  const legend: { level: HeatLevel; label: string }[] = [
    { level: 'closed', label: t('heat.closed') },
    { level: 'short', label: t('heat.inProgress', { dwell: dwellLabel('short', t) }) },
    { level: 'long', label: dwellLabel('long', t) },
    { level: 'veryLong', label: dwellLabel('veryLong', t) },
    { level: 'not_launched', label: t('cell.notLaunched') },
    { level: 'not_applicable', label: t('cell.notApplicable') },
  ]
  const shown = matrix.columns.flatMap((c, i) => (expanded || c.kind !== 'form' ? [{ column: c, i }] : []))
  const forms = shown.filter(({ column }) => column.kind === 'form')
  const grouped = forms.length > 0
  const lastForm = forms.at(-1)?.column.key
  /** The group's edges: before 控制作業's total, after its last form (after the total itself while folded). */
  const groupEdge = (column: TrackingColumn): CSSProperties => ({
    ...(column.kind === 'controls' && { borderLeft: GROUP_EDGE }),
    ...((column.key === lastForm || (!grouped && column.kind === 'controls')) && { borderRight: GROUP_EDGE }),
  })
  const widths = [
    WIDTH.plant,
    ...shown.map(({ column }) => (column.kind === 'controls' ? (grouped ? WIDTH.controls : WIDTH.controlsFolded) : WIDTH[column.kind])),
    WIDTH.closed,
  ]
  // The header cells that span both header rows once 控制作業 heads a group.
  const headerRowSpan = grouped ? 2 : undefined
  return (
    <Flex vertical>
      <Flex
        className="csa-edge-row"
        gap="4px 18px"
        wrap
        align="center"
        style={{ paddingBlock: 8, borderBottom: ROW_CELL.borderTop, fontSize: textSize(12), color: palette.textSecondary }}
        data-testid="tracking-legend"
      >
        {legend.map(({ level, label }) => (
          <Flex key={level} align="center" gap={6}>
            <span aria-hidden style={{ ...CELL, ...HEAT_SHADES[level], width: 20, height: 14, margin: 0, lineHeight: '14px', fontSize: textSize(9) }}>
              <Mark level={level} />
            </span>
            {label}
          </Flex>
        ))}
        <span style={{ marginInlineStart: 'auto', color: palette.textTertiary }}>{t('heat.hint')}</span>
      </Flex>
      <div style={{ overflowX: 'auto', marginInline: `calc(-1 * ${CARD_PAD})` }}>
        <table
          data-testid="tracking-matrix"
          style={{
            width: '100%', minWidth: widths.reduce((a, b) => a + b, 0), tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0,
            fontSize: textSize(13), fontVariantNumeric: 'tabular-nums',
          }}
        >
          <colgroup>
            {widths.map((width, i) => (
              <col key={i} style={{ width }} />
            ))}
          </colgroup>
          <thead style={{ background: palette.tableHeaderBg, color: palette.textSecondary }}>
            <tr>
              <th scope="col" rowSpan={headerRowSpan} title={t('plantHeader')} data-testid="tracking-corner" style={{ ...HEAD, ...PLANT, background: palette.tableHeaderBg }}>
                {t('plantHeader')}
              </th>
              {shown.map(({ column }) =>
                column.kind === 'form' ? null : (
                  <ColumnHeader
                    key={column.key}
                    column={column}
                    expanded={expanded}
                    onToggle={onToggleExpanded}
                    rowSpan={column.kind === 'component' ? headerRowSpan : undefined}
                    colSpan={column.kind === 'controls' && grouped ? forms.length + 1 : undefined}
                    style={groupEdge(column)}
                  />
                ),
              )}
              <th scope="col" rowSpan={headerRowSpan} style={{ ...HEAD, paddingInlineEnd: CARD_PAD }}>
                {t('heat.closed')}
              </th>
            </tr>
            {grouped && (
              <tr>
                {/* 控制作業's total, its own column under the group; the group's header stands for it in the Excel. */}
                <th scope="col" style={{ ...FORM_HEAD, ...ROW_CELL, borderLeft: GROUP_EDGE }}>
                  {t('heat.controlsTotal')}
                </th>
                {forms.map(({ column }) => (
                  <ColumnHeader key={column.key} column={column} expanded={expanded} onToggle={onToggleExpanded} style={{ ...ROW_CELL, ...groupEdge(column) }} />
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {matrix.plants.map((p) => (
              <tr key={p.id} style={{ height: 38 }}>
                <th scope="row" title={plantLabel(p)} style={{ ...PLANT, ...ROW_CELL, fontWeight: 400, background: palette.surface }}>
                  <span style={{ fontWeight: 600 }}>{p.factory_code}</span>　{p.plant_name}
                </th>
                {shown.map(({ column, i }) => (
                  <td key={column.key} style={{ ...ROW_CELL, ...groupEdge(column), padding: column.kind === 'form' ? '2px 1px' : 2 }}>
                    <HeatCell cell={p.cells[i]!} narrow={column.kind === 'form'} testId={`tracking-cell-${p.factory_code}-${column.key}`} />
                  </td>
                ))}
                <td style={{ ...ROW_CELL, padding: `0 ${CARD_PAD} 0 8px`, textAlign: 'center', whiteSpace: 'nowrap', color: palette.textSecondary }}>
                  {t('heat.closedCount', { ...closedCount(p.rows) })}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ fontSize: textSize(12), ...MUTED }}>
              <th scope="row" style={{ ...PLANT, ...ROW_CELL, ...MUTED, background: palette.surface, paddingBlock: 6 }}>
                {t('heat.closed')}
              </th>
              {shown.map(({ column, i }) => {
                const count = closedCount(matrix.plants.flatMap((p) => cellRows(p.cells[i]!)))
                // A form's column is too narrow for the full-width slash: 「12/18」 a size smaller, wrapping after the slash
                // when it still does not fit (18 廠區), the full text its title.
                const narrow = column.kind === 'form'
                return (
                  <td
                    key={column.key}
                    title={narrow ? t('cell.closedShare', { ...count }) : undefined}
                    style={{ ...ROW_CELL, ...groupEdge(column), textAlign: 'center', padding: '6px 0', whiteSpace: narrow ? 'normal' : 'nowrap', ...(narrow && { fontSize: textSize(11) }) }}
                  >
                    {t(narrow ? 'heat.closedCountNarrow' : 'heat.closedCount', { ...count })}
                  </td>
                )
              })}
              <td style={ROW_CELL} />
            </tr>
          </tfoot>
        </table>
      </div>
    </Flex>
  )
}

/**
 * A header in two lines where one would not fit its column: Chinese split in the middle (資訊與／溝通, 電腦／化), up to
 * `perLine` characters kept on one line; anything else wraps by itself.
 */
function twoLines(text: string, perLine: number): ReactNode {
  if (text.length <= perLine || !/^[㐀-鿿]+$/.test(text)) return text
  const half = Math.ceil(text.length / 2)
  return (
    <>
      {text.slice(0, half)}
      <br />
      {text.slice(half)}
    </>
  )
}

/** The symbol a level always carries besides its colour, in the legend: a tick for 結案, a dash for 不適用. */
function Mark({ level }: { level: HeatLevel }) {
  if (level === 'closed') return <CheckOutlined />
  if (level === 'not_applicable') return '—'
  return null
}

/**
 * A column header: its title is the Excel header; 三、控制作業 is the button that opens and folds its forms (opened, it
 * heads their group). A 組成要素 keeps up to three characters to a line, a form two.
 */
function ColumnHeader({ column, expanded, onToggle, rowSpan, colSpan, style }: {
  column: TrackingColumn
  expanded: boolean
  onToggle: () => void
  rowSpan?: number
  colSpan?: number
  style?: CSSProperties
}) {
  const { t } = useTranslation('tracking')
  const label = columnLabel(column, t)
  const testId = `tracking-col-${column.key}`
  if (column.kind !== 'controls') {
    const form = column.kind === 'form'
    return (
      <th scope="col" rowSpan={rowSpan} title={label} data-testid={testId} style={{ ...(form ? FORM_HEAD : HEAD), ...style }}>
        {twoLines(columnHeader(column, t), form ? 2 : 3)}
      </th>
    )
  }
  return (
    <th scope={colSpan ? 'colgroup' : 'col'} colSpan={colSpan} title={label} data-testid={testId} style={{ ...HEAD, paddingBlock: 4, ...style }}>
      <Button
        type="text"
        size="small"
        data-testid="tracking-expand-controls"
        aria-expanded={expanded}
        onClick={onToggle}
        iconPlacement="end"
        icon={<CaretRightOutlined aria-hidden style={{ fontSize: textSize(10), transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform 0.15s' }} />}
        style={{
          color: palette.selectedText, fontWeight: 'inherit', fontSize: 'inherit', paddingInline: 6,
          background: expanded ? palette.selectedBg : undefined,
        }}
      >
        {columnHeader(column, t)}
      </Button>
    </th>
  )
}

/**
 * One cell, its full text the title and the accessible name. One 自評表: the 停留天數 (or a tick), a link to it.
 * Several: 已結案／張數, a menu to choose which to open; 控制作業's total: the same, for reading only.
 */
function HeatCell({ cell, narrow, testId }: {
  cell: TrackingCell
  /** In a form's narrow column: a size smaller and a half-width slash, so 「1/2」 fits. */
  narrow: boolean
  testId: string
}) {
  const { t } = useTranslation('tracking')
  const navigate = useNavigate()
  const text = cellLines(cell, t).join('\n')
  const level = heatLevel(cell)
  const style = { ...CELL, ...HEAT_SHADES[level], ...(narrow && { fontSize: textSize(12) }) }
  const only = singleAssessment(cell)
  if (only) {
    return (
      <Link data-testid={testId} to={`/assessments/${only.assessment_id}`} title={text} aria-label={text} style={style}>
        {only.status === 'closed' ? <CheckOutlined aria-hidden /> : daysAtStep(only)}
      </Link>
    )
  }
  if (cell.kind !== 'assessments') {
    return text ? (
      <span data-testid={testId} title={text} role="img" aria-label={text} style={style}>
        <Mark level={level} />
      </span>
    ) : (
      <span data-testid={testId} style={style} />
    )
  }
  const share = t(narrow ? 'heat.closedCountNarrow' : 'heat.closedCount', { ...closedCount(cell.rows) })
  if (cell.total) {
    return (
      <span data-testid={testId} title={text} role="img" aria-label={text} style={style}>
        {share}
      </span>
    )
  }
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: cell.rows.map((r) => ({
          key: r.assessment_id,
          label: (
            <span data-testid={`tracking-pick-${r.template_code}`}>
              {templateLabel(r)}
              <span style={{ ...MUTED, marginInlineStart: 8 }}>{r.status === 'closed' ? t('cell.closed') : t('cell.days', { count: daysAtStep(r) })}</span>
            </span>
          ),
        })),
        onClick: ({ key }) => void navigate(`/assessments/${key}`),
      }}
    >
      <button type="button" data-testid={testId} title={text} aria-label={text} aria-haspopup="menu" style={{ ...style, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
        {share}
      </button>
    </Dropdown>
  )
}
