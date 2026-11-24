import { Alert, ConfigProvider, Flex, Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TemplateComponent } from '../api/templates'
import { ALL_VIEW, componentKey, groupByComponent, pickView, rowsOfView, type ComponentView } from '../domain/templates'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useUrlParam } from '../hooks/useUrlParam'
import { palette } from '../theme'
import { EdgeTabs, TabLabel } from './EdgeTabs'

/**
 * Under the grey 廠區 band the table's header is white like its rows, so grey and white do not take turns down the card
 * (方向 A, #120, 使用者 2026-11-10); a darker line under it (global.css's .csa-plain-head), the same as under the tabs
 * above, sets it off instead.
 */
const TABLE_THEME = { components: { Table: { headerBg: palette.surface } } }
const PLAIN_HEAD_LINE = { '--csa-head-line': palette.controlBorder } as CSSProperties
/** Wide enough for the toolbar beside the tabs (antd's md, as global.css's narrow-screen rules). */
const TOOLBAR_BESIDE_TABS = '(min-width: 768px)'

/**
 * 範本管理 and 流程編輯器 by 組成要素 (#66, Q106): 全部, then the five 組成要素 of 處理準則第 6 條 in order (未分類 last,
 * only when some row has none), each with its count, and the table of the chosen one's rows, under tabs across the
 * top (OPEN-5: the menu down the left that the 主管 tried is gone, 使用者 2026-11-10). 方向 A (#120, #121): small tabs
 * across the whole card, `toolbar` (e.g. the 停用 switch) at the right end of their row (above it on a narrow screen,
 * where the tabs need the width); the tabs and the table each run to the card's edges, one line between them.
 *
 * The choice is `?component=` in the URL, so opening a row and coming back returns to it; without one, the first
 * 組成要素 that has rows (never 全部), written into the URL once the rows are in so it does not move when the rows
 * change (e.g. the 停用 switch). While loading there is only the spinner; when there is nothing to list at all,
 * `emptyText` (it says why).
 */
export function ComponentGroups<T extends object>({
  rows,
  rowKey,
  componentOf,
  columns,
  loading,
  emptyText,
  groupEmptyText,
  unclassifiedHint,
  scrollX,
  testId,
  toolbar,
  tableLayout,
}: {
  rows: readonly T[]
  rowKey: (row: T) => string
  componentOf: (row: T) => TemplateComponent | null
  columns: ColumnsType<T>
  loading: boolean
  emptyText: string
  groupEmptyText: string
  /** Shown above the 未分類 rows: what to do about them on this page. */
  unclassifiedHint: string
  scrollX?: number
  testId: string
  toolbar?: ReactNode
  /** 'fixed' keeps every column where its width puts it whatever the rows hold (範本管理 by plant, #84). */
  tableLayout?: 'fixed'
}) {
  const { t } = useTranslation()
  const wide = useMediaQuery(TOOLBAR_BESIDE_TABS)
  const [requested, setRequested] = useUrlParam('component')
  const groups = groupByComponent(rows, componentOf)
  const chosen = pickView(groups, requested)
  // Nothing is chosen until the rows are in, so the highlight does not jump once they arrive.
  const active = loading ? '' : chosen
  const views: { key: ComponentView; count: number }[] = [
    { key: ALL_VIEW, count: rows.length },
    ...groups.map((g) => ({ key: componentKey(g.component), count: g.rows.length })),
  ]
  const viewName = (key: ComponentView) => (key === ALL_VIEW ? t('templates.allView') : t(`templates.componentHeadings.${key}`))

  // Pin the default (or a choice the list no longer has) in the URL once there is something to choose from.
  useEffect(() => {
    if (!loading && rows.length && requested !== chosen) setRequested(chosen)
  }, [loading, rows.length, requested, chosen, setRequested])

  const toolbarItems = (
    <Flex align="center" gap={12} wrap>
      {toolbar}
    </Flex>
  )
  const hint = !loading && chosen === 'unclassified' && <Alert type="info" showIcon title={unclassifiedHint} style={{ marginBottom: 12 }} />
  const viewRows = rowsOfView(groups, chosen)
  const table = (
    <Table<T>
      data-testid={testId}
      size="small"
      rowKey={rowKey}
      loading={loading}
      dataSource={viewRows}
      pagination={false}
      scroll={scrollX ? { x: scrollX } : undefined}
      tableLayout={tableLayout}
      // antd draws the empty hint under the spinner too; while loading there is nothing to say yet.
      locale={{ emptyText: loading ? null : rows.length ? groupEmptyText : emptyText }}
      columns={columns}
    />
  )

  return (
    <>
      {toolbar && !wide && <ToolbarRow>{toolbarItems}</ToolbarRow>}
      <EdgeTabs
        extra={toolbar && wide && <div style={{ marginInlineStart: 24 }}>{toolbarItems}</div>}
        activeKey={active}
        onChange={setRequested}
        items={views.map((v) => ({ key: v.key, label: <TabLabel name={viewName(v.key)} count={loading ? undefined : v.count} /> }))}
        data-testid={`${testId}-components`}
      />
      {hint && <div style={{ paddingTop: 12 }}>{hint}</div>}
      <div className="csa-edge-table csa-edge-bottom csa-plain-head" style={PLAIN_HEAD_LINE}>
        <ConfigProvider theme={TABLE_THEME}>{table}</ConfigProvider>
      </div>
    </>
  )
}

/**
 * A row of controls at the top of a list's card (方向 A, #120), across the card with a line under it (global.css's
 * csa-edge-row): the toolbar on a narrow screen, and where a page puts it when the list cannot load.
 */
export function ToolbarRow({ children }: { children: ReactNode }) {
  return (
    <div className="csa-edge-row" style={{ paddingBlock: 12, borderBottom: `1px solid ${palette.border}` }}>
      {children}
    </div>
  )
}
