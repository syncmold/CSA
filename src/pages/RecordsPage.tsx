import { DownOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons'
import type { TFunction } from 'i18next'
import { Alert, Button, Card, ConfigProvider, Empty, Flex, Input, message, Select, Spin, Table, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { AssessmentRecord, RecordScope } from '../api/records'
import { useAuth } from '../auth/AuthContext'
import { AppShell } from '../components/AppShell'
import { EdgeTabs, TabLabel } from '../components/EdgeTabs'
import { ExportPdfButton } from '../components/ExportPdfButton'
import { Field } from '../components/Field'
import { InkDot } from '../components/InkDot'
import { PageHeader } from '../components/PageHeader'
import { NO_WRAP } from '../components/tableColumns'
import { errorText } from '../domain/errors'
import {
  allGroupKeys, defaultOpenKeys, filterRecords, NO_RECORD_FILTER, RECORD_STATUS_TABS, recordGroups, recordReach, recordYears, statusCounts, withStatus,
  type PlantGroup, type RecordFilter, type RecordStatusTab, type StatusTally, type YearGroup,
} from '../domain/records'
import { companyOptionLabel, companyOptions, plantOptionLabel, plantOptions, taipeiDate } from '../domain/tracking'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { usePlants } from '../hooks/usePlants'
import { useAssessmentRecords, useRecordScope } from '../hooks/useRecords'
import { CARD_BODY_STYLE, CARD_STYLE, INK, palette, textSize } from '../theme'

/** Below this the list turns into cards and the filters into two rows (Q124 (2)). */
const PHONE = '(max-width: 767px)'
/** The plants the label names one by one; more are counted, the names in its tooltip. */
const NAMED_PLANTS = 3
/** Right under the tabs the table's header row is square, not rounded (as 首頁's). */
const SQUARE_HEADER_THEME = { components: { Table: { headerBorderRadius: 0 } } }
const MUTED = { color: palette.textTertiary }

type Notify = ReturnType<typeof message.useMessage>[0]

/** What the list draws, top to bottom: a 年度's heading, a 廠區's heading, or a 自評表 of an open 廠區. */
type RecordLine = { kind: 'year'; group: YearGroup } | { kind: 'plant'; group: PlantGroup } | { kind: 'record'; record: AssessmentRecord }

/** The open groups as lines: a folded 年度 hides its 廠區, a folded 廠區 its 自評表. */
function recordLines(groups: YearGroup[], open: Set<string>): RecordLine[] {
  return groups.flatMap((year): RecordLine[] => [
    { kind: 'year', group: year },
    ...(open.has(year.key)
      ? year.plants.flatMap((plant): RecordLine[] => [
          { kind: 'plant', group: plant },
          ...(open.has(plant.key) ? plant.records.map((record): RecordLine => ({ kind: 'record', record })) : []),
        ])
      : []),
  ])
}

/** A heading opens or folds what is under it. */
interface Folding {
  open: Set<string>
  toggle: (key: string) => void
}

/**
 * 自評表紀錄 (#164, Q124 (2)): every 自評表 one can see, of every 年度, to open or export as PDF. Which ones is the
 * database's reading rule (view assessment_record), as on every other page, and the label beside the title says it in
 * words (使用者: 需要解釋就代表不夠直覺): every plant, the plants one views or runs, or one's own. The filters and the
 * 狀態 tabs (as 年度發起's, Q120) only narrow what is there. The list runs by 年度, newest first, and within it by 廠區,
 * both folding (使用者 2026-11-11, option 乙, in place of pages of 50): at first only the newest 年度 is open, its 廠區
 * folded; a list narrowed to some 廠區 or 範本 opens in full. Changing a filter or tab starts from that again.
 */
export function RecordsPage() {
  const { t } = useTranslation('records')
  const [notify, notifyHolder] = message.useMessage()
  const { session } = useAuth()
  const records = useAssessmentRecords()
  const scope = useRecordScope(session?.employee.emp_id)
  const phone = useMediaQuery(PHONE)
  const [filter, setFilterState] = useState<RecordFilter>(NO_RECORD_FILTER)
  const [tab, setTabState] = useState<RecordStatusTab>('all')
  /** null: as defaultOpenKeys has it, until the first click. */
  const [opened, setOpened] = useState<Set<string> | null>(null)

  const rows = records.data ?? []
  const filtered = filterRecords(rows, filter)
  const counts = statusCounts(filtered)
  const shown = withStatus(filtered, tab)
  const groups = recordGroups(shown)
  const open = opened ?? defaultOpenKeys(groups, filter)
  const folding: Folding = {
    open,
    toggle: (key) => {
      const next = new Set(open)
      if (!next.delete(key)) next.add(key)
      setOpened(next)
    },
  }
  const lines = recordLines(groups, open)
  const plants = plantOptions(rows, filter.companyId)

  // Another list opens as at first.
  const setFilter = (next: RecordFilter) => {
    setFilterState(next)
    setOpened(null)
  }
  const setTab = (next: RecordStatusTab) => {
    setTabState(next)
    setOpened(null)
  }
  const chooseCompany = (companyId: string | null) => {
    const kept = new Set(plantOptions(rows, companyId).map((p) => p.id))
    setFilter({ ...filter, companyId, plantIds: filter.plantIds.filter((id) => kept.has(id)) })
  }

  const year = (
    <Select
      data-testid="records-year"
      aria-label={t('filters.year')}
      style={{ width: phone ? '100%' : 120 }}
      allowClear
      placeholder={t('filters.allYears')}
      value={filter.year ?? undefined}
      options={recordYears(rows).map((y) => ({ value: y, label: String(y) }))}
      onChange={(y?: number) => setFilter({ ...filter, year: y ?? null })}
    />
  )
  const company = (
    <Select
      data-testid="records-company"
      aria-label={t('filters.company')}
      style={{ width: phone ? '100%' : 220 }}
      popupMatchSelectWidth={false}
      allowClear
      showSearch={{ optionFilterProp: 'label' }}
      placeholder={t('filters.allCompanies')}
      value={filter.companyId ?? undefined}
      options={companyOptions(rows).map((c) => ({ value: c.id, label: companyOptionLabel(c) }))}
      onChange={(id?: string) => chooseCompany(id ?? null)}
    />
  )
  const plant = (
    <Select
      data-testid="records-plant"
      aria-label={t('filters.plant')}
      style={phone ? { width: '100%' } : { minWidth: 200 }}
      mode="multiple"
      maxTagCount={phone ? 'responsive' : undefined}
      allowClear
      placeholder={t('filters.allPlants')}
      value={filter.plantIds}
      options={plants.map((p) => ({ value: p.id, label: plantOptionLabel(p) }))}
      showSearch={{ optionFilterProp: 'label' }}
      onChange={(plantIds: string[]) => setFilter({ ...filter, plantIds })}
    />
  )
  const template = (
    <Input
      data-testid="records-template"
      aria-label={t('filters.template')}
      style={{ width: phone ? '100%' : 240 }}
      allowClear
      prefix={<SearchOutlined style={MUTED} />}
      placeholder={t(phone ? 'filters.templatePlaceholderPhone' : 'filters.templatePlaceholder')}
      value={filter.template}
      onChange={(e) => setFilter({ ...filter, template: e.target.value })}
    />
  )

  const foldAll = groups.length > 0 && (
    <Flex gap={4}>
      <Button type="link" size="small" data-testid="records-expand-all" onClick={() => setOpened(new Set(allGroupKeys(groups)))}>
        {t('expandAll')}
      </Button>
      <Button type="link" size="small" data-testid="records-collapse-all" onClick={() => setOpened(new Set())}>
        {t('collapseAll')}
      </Button>
    </Flex>
  )

  const body = records.isPending ? (
    <Flex justify="center" style={{ padding: 24 }}>
      <Spin />
    </Flex>
  ) : records.isError ? (
    <Alert type="warning" showIcon title={errorText(records.error)} style={{ marginBlock: 16 }} />
  ) : shown.length === 0 ? (
    <Empty description={<span data-testid="records-empty">{t(rows.length ? 'emptyFiltered' : 'empty')}</span>} style={{ marginBlock: 24 }} />
  ) : phone ? (
    <RecordCards lines={lines} folding={folding} notify={notify} />
  ) : (
    <RecordTable lines={lines} folding={folding} notify={notify} />
  )

  return (
    <AppShell>
      {notifyHolder}
      <PageHeader
        title={
          <Flex component="span" align="center" gap="4px 10px" wrap>
            {t('title')}
            {scope.data && <ScopeLabel scope={scope.data} rows={rows} />}
          </Flex>
        }
        subtitle={t('subtitle')}
      />
      <Card style={CARD_STYLE} styles={{ body: CARD_BODY_STYLE }}>
        {/* On a phone two rows of two, without names: the placeholders say what each is. */}
        {phone ? (
          <Flex className="csa-edge-row" vertical gap={8} style={{ paddingBlock: 12 }}>
            {[[year, company], [plant, template]].map((pair, i) => (
              <Flex key={i} gap={8} align="center">
                {pair.map((control, j) => (
                  <div key={j} style={{ flex: 1, minWidth: 0 }}>
                    {control}
                  </div>
                ))}
              </Flex>
            ))}
          </Flex>
        ) : (
          <Flex className="csa-edge-row" gap="10px 20px" wrap align="center" style={{ paddingBlock: 12, borderBottom: `1px solid ${palette.border}` }}>
            <Field label={t('filters.year')}>{year}</Field>
            <Field label={t('filters.company')}>{company}</Field>
            <Field label={t('filters.plant')}>{plant}</Field>
            <Field label={t('filters.template')}>{template}</Field>
          </Flex>
        )}
        <EdgeTabs
          data-testid="records-status"
          activeKey={tab}
          onChange={(key) => setTab(key as RecordStatusTab)}
          extra={!phone && foldAll}
          // No count before the list is in: 0 would read as none.
          items={RECORD_STATUS_TABS.map((s) => ({
            key: s,
            label: <TabLabel name={t(`status.${s}`)} count={records.isSuccess ? counts[s] : undefined} testId={`records-tab-${s}`} />,
          }))}
        />
        {/* On a phone the tabs take the row's whole width, so these go under it. */}
        {phone && foldAll && (
          <Flex justify="flex-end" style={{ paddingTop: 8 }}>
            {foldAll}
          </Flex>
        )}
        {body}
      </Card>
    </AppShell>
  )
}

/** The reach beside the title, in the blue of 範圍受限 (INK.blue): every plant, the plants by name, or one's own. */
function ScopeLabel({ scope, rows }: { scope: RecordScope; rows: AssessmentRecord[] }) {
  const { t } = useTranslation('records')
  const plants = usePlants()
  const reach = recordReach(scope, plants.data ?? [], rows)
  // The plants' names come with the plant list; until then the label waits rather than read 「0 個廠區」.
  if (reach.kind === 'plants' && !plants.data) return null
  let text: string
  /** Every plant's name, for the tooltip when the label only counts them. */
  let tooltipNames: string | undefined
  if (reach.kind === 'all') text = t('scope.all')
  else if (reach.kind === 'own') text = t('scope.own')
  else {
    const names = reach.plants.map(plantOptionLabel)
    const shownNames = names.length > NAMED_PLANTS ? t('scope.plantCount', { count: names.length }) : names.join(t('scope.separator'))
    if (names.length > NAMED_PLANTS) tooltipNames = names.join(t('scope.separator'))
    text = t(reach.alsoOwn ? 'scope.plantsAndOwn' : 'scope.plants', { plants: shownNames })
  }
  const label = (
    <span
      data-testid="records-scope"
      style={{
        fontSize: textSize(14), fontWeight: 500, lineHeight: 1.6, color: INK.blue.color, background: INK.blue.background,
        border: `1px solid ${INK.blue.border}`, borderRadius: 4, padding: '0 8px',
      }}
    >
      {text}
    </span>
  )
  return tooltipNames ? <Tooltip title={tooltipNames}>{label}</Tooltip> : label
}

function StatusInk({ record }: { record: AssessmentRecord }) {
  const { t } = useTranslation('records')
  return <InkDot ink={record.status === 'closed' ? 'green' : 'blue'}>{t(`status.${record.status}`)}</InkDot>
}

function AssessmentLink({ record }: { record: AssessmentRecord }) {
  const { t } = useTranslation('records')
  return (
    <Link to={`/assessments/${record.assessment_id}`} data-testid="record-assessment">
      {t('assessment', { code: record.template_code, name: record.template_name })}
    </Link>
  )
}

/** 「簽核中 73・已結案 31」 for a 年度 (the parts there are), 「已結案 9」 for a 廠區 (the mockup's). */
function tallyText(t: TFunction<'records'>, tally: StatusTally, closedOnly: boolean): string {
  const parts = closedOnly
    ? [t('meta.closed', { count: tally.closed })]
    : [...(tally.inProgress ? [t('meta.inProgress', { count: tally.inProgress })] : []), ...(tally.closed ? [t('meta.closed', { count: tally.closed })] : [])]
  return parts.join(t('meta.separator'))
}

/**
 * A 年度's or a 廠區's heading: one button across the row, its arrow saying whether it is open, its count and its
 * 簽核中／已結案 after it.
 */
function GroupHeading({ line, folding }: { line: Extract<RecordLine, { kind: 'year' | 'plant' }>; folding: Folding }) {
  const { t } = useTranslation('records')
  const { group } = line
  const isOpen = folding.open.has(group.key)
  const year = line.kind === 'year'
  const name = year
    ? t('yearHeading', { year: line.group.year, count: group.count })
    : t('plantHeading', { code: line.group.factoryCode, name: line.group.plantName, count: group.count })
  return (
    <button
      type="button"
      aria-expanded={isOpen}
      data-testid={year ? 'record-year' : 'record-plant'}
      onClick={() => folding.toggle(group.key)}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', width: '100%', padding: 0, border: 'none', background: 'none',
        cursor: 'pointer', textAlign: 'start', font: 'inherit', color: 'inherit', paddingInlineStart: year ? 0 : PLANT_INDENT,
      }}
    >
      <span aria-hidden style={{ width: 12, fontSize: textSize(10), color: palette.textTertiary }}>{isOpen ? <DownOutlined /> : <RightOutlined />}</span>
      <span data-testid="record-group-name">{name}</span>
      <span style={{ ...MUTED, fontWeight: 400 }}>{tallyText(t, group, !year)}</span>
    </button>
  )
}

/** How far a 廠區's heading sits in from its 年度's, and its 自評表 from its heading (the arrow's width and gap). */
const PLANT_INDENT = 20
const RECORD_INDENT = PLANT_INDENT + 20

const HEADING_CELL = {
  year: { style: { background: palette.bg, fontWeight: 600, color: palette.textSecondary, fontSize: textSize(13) } },
  plant: { style: { background: palette.tableHeaderBg + '80', fontWeight: 500, color: palette.textSecondary, fontSize: textSize(13) } },
}

function RecordTable({ lines, folding, notify }: { lines: RecordLine[]; folding: Folding; notify: Notify }) {
  const { t } = useTranslation('records')
  const recordCell = (render: (r: AssessmentRecord) => ReactNode) => (_: unknown, line: RecordLine) => (line.kind === 'record' ? render(line.record) : null)
  /** A short column (NO_WRAP) that a heading row leaves out: the heading's first cell spans every column. */
  const short = { ...NO_WRAP, onCell: (line: RecordLine) => ({ ...NO_WRAP.onCell(), ...(line.kind === 'record' ? {} : { colSpan: 0 }) }) }
  const columns: ColumnsType<RecordLine> = [
    {
      title: t('columns.assessment'),
      key: 'assessment',
      onCell: (line) => (line.kind === 'record' ? {} : { colSpan: 4, ...HEADING_CELL[line.kind] }),
      render: (_, line) =>
        line.kind === 'record' ? (
          <span style={{ paddingInlineStart: RECORD_INDENT }}>
            <AssessmentLink record={line.record} />
          </span>
        ) : (
          <GroupHeading line={line} folding={folding} />
        ),
    },
    { title: t('columns.status'), key: 'status', ...short, render: recordCell((r) => <StatusInk record={r} />) },
    {
      title: t('columns.closedAt'),
      key: 'closedAt',
      ...short,
      render: recordCell((r) => (
        <span style={{ fontVariantNumeric: 'tabular-nums', ...(r.closed_at ? {} : MUTED) }} data-testid="record-closed-at">
          {r.closed_at ? taipeiDate(r.closed_at) : '—'}
        </span>
      )),
    },
    { title: t('columns.pdf'), key: 'pdf', ...short, render: recordCell((r) => <ExportPdfButton assessmentId={r.assessment_id} notify={notify} />) },
  ]
  return (
    <ConfigProvider theme={SQUARE_HEADER_THEME}>
      <Table<RecordLine>
        className="csa-edge-table"
        data-testid="records-table"
        size="small"
        rowKey={(line) => (line.kind === 'record' ? line.record.assessment_id : line.group.key)}
        dataSource={lines}
        columns={columns}
        pagination={false}
        scroll={{ x: 640 }}
      />
    </ConfigProvider>
  )
}

/** On a phone each 自評表 is a card under its 年度's and 廠區's headings: its name and 狀態, then its 結案日 and PDF. */
function RecordCards({ lines, folding, notify }: { lines: RecordLine[]; folding: Folding; notify: Notify }) {
  const { t } = useTranslation('records')
  return (
    <Flex vertical gap={8} data-testid="records-cards" style={{ paddingBlock: 12 }}>
      {lines.map((line) =>
        line.kind !== 'record' ? (
          <div
            key={line.group.key}
            style={{ marginTop: line.kind === 'year' ? 4 : 0, fontSize: textSize(13), color: palette.textSecondary, fontWeight: line.kind === 'year' ? 600 : 500 }}
          >
            <GroupHeading line={line} folding={folding} />
          </div>
        ) : (
          <div key={line.record.assessment_id} data-testid="record-card" style={{ border: `1px solid ${palette.border}`, borderRadius: 6, padding: 12 }}>
            <Flex justify="space-between" align="flex-start" gap={8}>
              <AssessmentLink record={line.record} />
              <StatusInk record={line.record} />
            </Flex>
            <Flex justify="space-between" align="center" gap={8} style={{ marginTop: 6 }}>
              <span style={{ ...MUTED, fontSize: textSize(13), whiteSpace: 'nowrap' }}>
                {line.record.closed_at && t('closedOn', { date: taipeiDate(line.record.closed_at) })}
              </span>
              <ExportPdfButton assessmentId={line.record.assessment_id} notify={notify} />
            </Flex>
          </div>
        ),
      )}
    </Flex>
  )
}
