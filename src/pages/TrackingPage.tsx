import { DownloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, ConfigProvider, Empty, Flex, message, Radio, Select, Spin } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppShell } from '../components/AppShell'
import { Field } from '../components/Field'
import { PageHeader } from '../components/PageHeader'
import { TrackingHeatmap } from '../components/TrackingHeatmap'
import { TrackingQueueList } from '../components/TrackingQueueList'
import { TrackingSummaryCards } from '../components/TrackingSummaryCards'
import { errorText } from '../domain/errors'
import {
  companyOptionLabel, companyOptions, NO_FILTER, onlyPlants, plantOptionLabel, plantOptions, trackingMatrix, trackingSheets, trackingSummary,
  type StatusFilter, type TrackingData, type TrackingFilter,
} from '../domain/tracking'
import { useLaunchedCycles } from '../hooks/useLaunch'
import { useExportablePlants } from '../hooks/useMyAuditRole'
import { useTracking } from '../hooks/useTracking'
import { useUrlParam } from '../hooks/useUrlParam'
import { loadChunk } from '../loadChunk'
import { CARD_BODY_STYLE, CARD_STYLE, palette } from '../theme'

const STATUSES: StatusFilter[] = ['all', 'in_progress', 'closed']
const NO_DATA: TrackingData = { rows: [], templates: [] }

type TrackingView = 'heatmap' | 'queue'
const VIEWS: TrackingView[] = ['heatmap', 'queue']

/** The two views as one bordered pair, the open one in the selected item's pale purple (the mockup's). */
const VIEW_SWITCH_THEME = { components: { Radio: { colorPrimary: palette.selectedText, buttonCheckedBg: palette.selectedBg } } }

/**
 * 追蹤總覽 (#14): the 廠區 × 問卷範本 matrix of one 年度, with each 自評表's current 關卡, signer and 停留天數.
 * The rows and the day counts come from the database (view tracking_assessment, Q95), which gives them to
 * 稽核管理者, 檢視者 and 廠區負責人 for their plants (Q98 (6), Q117 (3)); like the other /admin pages there is no
 * front-end role check, anyone else sees an empty page. 匯出 Excel holds only the plants one may export: those a
 * 稽核人員 runs, but none a 廠區端 廠區管理員 or a 檢視者 only runs (access exportablePlants, #187).
 * Two views of the same matrix (Q105), chosen in the header and kept in the address (?view=queue): 熱度矩陣 and
 * 待處理優先. The filters, the counts above and 匯出 Excel are shared, and the Excel is built from that matrix
 * whichever view is open (domain/tracking), with 控制作業 expanded however the 熱度矩陣 shows it (#86).
 * 方向 A (#128): the counts one strip, the filters a row of labelled dropdowns along the card's top.
 */
export function TrackingPage() {
  const { t } = useTranslation('tracking')
  const [notify, notifyHolder] = message.useMessage()
  // The launched 年度, newest first; shared with 年度發起, so a launch there refreshes this list too.
  const cycles = useLaunchedCycles()
  const years = (cycles.data ?? []).map((c) => c.year)
  const [chosenYear, setChosenYear] = useState<number | null>(null)
  const year = chosenYear ?? years[0] ?? null
  const tracking = useTracking(year)
  const [filter, setFilter] = useState<TrackingFilter>(NO_FILTER)
  const [exporting, setExporting] = useState(false)
  const exportable = useExportablePlants()
  const [viewParam, setView] = useUrlParam('view')
  const view: TrackingView = viewParam === 'queue' ? 'queue' : 'heatmap'
  // 控制作業 opened form by form (#86), kept in the address like the view.
  const [controls, setControls] = useUrlParam('controls')
  const controlsOpen = controls === 'open'

  const data = tracking.data ?? NO_DATA
  const rows = data.rows
  const matrix = trackingMatrix(data, filter)
  const summary = trackingSummary(matrix)
  // The Excel holds only the plants this person may export, under the same filters (a 檢視者 who also runs a plant
  // sees it here but does not export it; a 稽核人員 exports the plants they run, #187).
  const exported = trackingMatrix(onlyPlants(data, exportable), filter)
  const companies = companyOptions(rows)
  const plants = plantOptions(rows, filter.companyId)

  const chooseCompany = (companyId: string | null) => {
    const kept = new Set(plantOptions(rows, companyId).map((p) => p.id))
    setFilter({ ...filter, companyId, plantIds: filter.plantIds.filter((id) => kept.has(id)) })
  }

  const exportExcel = async () => {
    if (year === null) return
    setExporting(true)
    try {
      // Loaded on first export, like the PDF engine, so the Excel writer stays out of the main bundle.
      const { downloadTrackingWorkbook } = await loadChunk(() => import('../excel/trackingWorkbook'))
      await downloadTrackingWorkbook(
        trackingSheets(exported, t),
        { overview: t('excel.overviewSheet'), detail: t('excel.detailSheet') },
        t('fileName', { year }),
      )
    } catch (error) {
      void notify.error(t('exportFailed', { message: errorText(error) }))
    } finally {
      setExporting(false)
    }
  }

  const loading = cycles.isPending || (year !== null && tracking.isPending)
  const error = cycles.error ?? tracking.error
  const due = cycles.data?.find((c) => c.year === year)?.due_date
  const showData = !error && !loading && matrix.plants.length > 0

  return (
    <AppShell>
      {notifyHolder}
      <PageHeader
        title={t('title')}
        subtitle={year !== null && due ? t('subtitle', { year, due }) : undefined}
        extra={
          <ConfigProvider theme={VIEW_SWITCH_THEME}>
            <Radio.Group
              data-testid="tracking-view"
              optionType="button"
              value={view}
              options={VIEWS.map((v) => ({ value: v, label: t(`views.${v}`) }))}
              onChange={(e) => setView(e.target.value === 'queue' ? 'queue' : null)}
            />
          </ConfigProvider>
        }
      />
      {showData && <TrackingSummaryCards summary={summary} />}
      <Card style={CARD_STYLE} styles={{ body: CARD_BODY_STYLE }}>
        <Flex className="csa-edge-row" gap="10px 20px" wrap align="center" style={{ paddingBlock: 12, borderBottom: `1px solid ${palette.border}` }}>
          <Field label={t('filters.year')}>
            <Select
              data-testid="tracking-year"
              aria-label={t('filters.year')}
              style={{ width: 110 }}
              showSearch
              value={year ?? undefined}
              options={years.map((y) => ({ value: y, label: String(y) }))}
              onChange={(y: number) => {
                setChosenYear(y)
                setFilter(NO_FILTER)
              }}
            />
          </Field>
          <Field label={t('filters.company')}>
            <Select
              data-testid="tracking-company"
              aria-label={t('filters.company')}
              style={{ width: 220 }}
              popupMatchSelectWidth={false}
              allowClear
              showSearch={{ optionFilterProp: 'label' }}
              placeholder={t('filters.allCompanies')}
              value={filter.companyId ?? undefined}
              options={companies.map((c) => ({ value: c.id, label: companyOptionLabel(c) }))}
              onChange={(id?: string) => chooseCompany(id ?? null)}
            />
          </Field>
          <Field label={t('filters.plant')}>
            <Select
              data-testid="tracking-plant"
              aria-label={t('filters.plant')}
              style={{ minWidth: 200 }}
              mode="multiple"
              allowClear
              placeholder={t('filters.allPlants')}
              value={filter.plantIds}
              options={plants.map((p) => ({ value: p.id, label: plantOptionLabel(p) }))}
              showSearch={{ optionFilterProp: 'label' }}
              onChange={(plantIds: string[]) => setFilter({ ...filter, plantIds })}
            />
          </Field>
          <Field label={t('filters.status')}>
            <Select<StatusFilter>
              data-testid="tracking-status"
              aria-label={t('filters.status')}
              style={{ width: 110 }}
              value={filter.status}
              options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
              onChange={(status) => setFilter({ ...filter, status })}
            />
          </Field>
          {exported.plants.length > 0 && (
            <Button data-testid="tracking-export" icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportExcel()} style={{ marginInlineStart: 'auto' }}>
              {t('export')}
            </Button>
          )}
        </Flex>
        {error ? (
          <Alert type="warning" showIcon title={error.message} style={{ marginBlock: 16 }} />
        ) : loading ? (
          <Flex justify="center" style={{ padding: 24 }}>
            <Spin />
          </Flex>
        ) : year === null ? (
          <Empty description={t('noYears')} style={{ marginBlock: 24 }} />
        ) : matrix.plants.length === 0 ? (
          <Empty description={t('empty')} style={{ marginBlock: 24 }} />
        ) : view === 'queue' ? (
          <TrackingQueueList key={JSON.stringify([year, filter])} matrix={matrix} />
        ) : (
          <TrackingHeatmap matrix={matrix} expanded={controlsOpen} onToggleExpanded={() => setControls(controlsOpen ? null : 'open')} />
        )}
      </Card>
    </AppShell>
  )
}
