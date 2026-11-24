import { InfoCircleOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Flex, Tooltip } from 'antd'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import type { TemplateSummary } from '../api/templates'
import { AppShell } from '../components/AppShell'
import { ComponentGroups, ToolbarRow } from '../components/ComponentGroups'
import { InactiveSwitch } from '../components/InactiveSwitch'
import { LastModifiedCell } from '../components/LastModified'
import { NextLaunchNote } from '../components/NextLaunchNote'
import { PageHeader } from '../components/PageHeader'
import { PlantPicker } from '../components/PlantPicker'
import { TemplateHeaderModal } from '../components/TemplateEditModals'
import { TemplateStatusTag, TemplateUsageTag } from '../components/TemplateStatusTag'
import { useFillToBottom } from '../components/useFillToBottom'
import { readsSettings } from '../domain/access'
import { errorText } from '../domain/errors'
import { listLoading } from '../domain/lists'
import { NO_PLANT, plantOptions, rowsOfPlant, sameContentIndex, viewAfterPlantChange } from '../domain/plantChoice'
import { applicablePlantsLabel, visibleTemplates } from '../domain/templates'
import { useSettingsRights } from '../hooks/useMyAuditRole'
import { usePlantChoice } from '../hooks/usePlantChoice'
import { usePlants } from '../hooks/usePlants'
import { useUrlParam } from '../hooks/useUrlParam'
import { useCreateTemplate, useTemplates } from '../hooks/useTemplates'
import { CARD_BODY_STYLE, LIST_CARD_STYLE, palette } from '../theme'

/**
 * Column widths in px (the first and last include the card's padding, Q108); 名稱 takes what is left. Wide enough for
 * the longest values on one line (LH-05.2-組裝, 啟用／停用, 未使用／已使用, and 內容相同的廠區 folded
 * as 「CF、FF、FQ、GH 等 15 廠」), so every row is one line high (#120); 最後修改 is two small lines, as wide as its
 * time (2026-11-18 14:05, #201). Together they fit a 1440px screen without scrolling.
 */
const COLUMN_WIDTH = { code: 150, count: 72, status: 88, usage: 100, plants: 226, updatedAt: 140 }

/** 內容相同的廠區 beyond this many fold into 「…等 n 廠」 (#120); the whole list is in the tooltip. */
const SAME_CONTENT_SHOWN = 4

/**
 * 範本管理 (#3, #10): the list. Only 稽核管理者 get rows back; others see an empty table (RLS).
 * 停用 templates are hidden unless the switch is on (#31); the choice lives in the URL so it survives
 * opening a template and coming back. Tabs across the top choose 全部 or one 組成要素; the table lists its
 * templates (#62, #66). Each plant has its own templates (Q111), so a 廠區 is chosen first (#84, B2): the
 * tabs then count and list only that plant's templates, and 「內容相同的廠區」 shows which other plants have the same
 * questions. With no plants in the 廠區主檔 the list is not split and shows 適用廠區 instead. 方向 A (#120): the 廠區
 * are a pale band at the top of the list's card, the 停用 switch at the right end of the tabs' row.
 *
 * No 年度 (Q137 (2)): the list is always the templates themselves, edited for the next launch; what a past year issued
 * is in 自評表紀錄, as the line under the title says.
 */
export function TemplateListPage() {
  const { t } = useTranslation()
  const templates = useTemplates()
  const rights = useSettingsRights()
  const create = useCreateTemplate()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [inactive, setInactive] = useUrlParam('inactive')
  const showInactive = inactive === '1'
  const fill = useFillToBottom<HTMLDivElement>()
  const plants = usePlants()
  const rows = templates.data ?? []
  const loading = listLoading(templates) || plants.isLoading
  const options = plantOptions(plants.data ?? [], rows, t('plants.noPlant'))
  const [plant, choosePlant] = usePlantChoice(options, !loading)
  const plantRows = plant === null ? rows : rowsOfPlant(rows, plant)
  const shown = visibleTemplates(plantRows, showInactive)
  const inactiveCount = plantRows.filter((r) => r.status === 'inactive').length
  const chosenPlant = options.find((o) => o.key === plant)
  const sameContent = useMemo(() => sameContentIndex(rows), [rows])
  // Only 稽核主管, 系統維護員 and 稽核人員 get any rows (RLS), so only they get the switch.
  const inactiveSwitch = readsSettings(rights.role) && (
    <InactiveSwitch checked={showInactive} onChange={(on) => setInactive(on ? '1' : null)} label={t('templates.showInactive', { count: inactiveCount })} />
  )

  return (
    <AppShell>
      <PageHeader
        title={t('templates.title')}
        extra={
          // Buttons are shown for tidiness; the database refuses anyone else's writes. A 稽核人員 sees 自評單位 (to add
          // one) and adds templates for the plants he runs (Q144).
          readsSettings(rights.role) && (
            <>
              <Link to="/admin/assessing-units">
                <Button data-testid="nav-assessing-units">{t('templates.units.title')}</Button>
              </Link>
              {rights.canAdd && (
                <Button type="primary" onClick={() => setCreating(true)} data-testid="create-template">
                  {t('templates.create')}
                </Button>
              )}
            </>
          )
        }
      />
      {plants.isError && <Alert type="warning" showIcon title={t('plants.loadError', { error: errorText(plants.error) })} />}
      <NextLaunchNote subject={t('nextLaunch.questions')} />
      {/* One height whichever 組成要素 is chosen (#66). */}
      <Card ref={fill.ref} style={{ ...LIST_CARD_STYLE, ...fill.style }} styles={{ body: CARD_BODY_STYLE }}>
        {options.length > 0 && (
          <PlantPicker options={options} value={plant} onChange={(next) => choosePlant(next, viewAfterPlantChange(rowsOfPlant(rows, next)))} />
        )}
        {templates.isError ? (
          <>
            {inactiveSwitch && <ToolbarRow>{inactiveSwitch}</ToolbarRow>}
            <Alert type="warning" showIcon title={errorText(templates.error)} style={{ marginBlock: 16 }} />
          </>
        ) : (
          <ComponentGroups<TemplateSummary>
            testId="template-table"
            toolbar={inactiveSwitch}
            rows={shown}
            rowKey={(row) => row.id}
            componentOf={(row) => row.component}
            loading={loading}
            emptyText={t(plantRows.length ? 'templates.onlyInactive' : 'templates.empty')}
            groupEmptyText={t('templates.groupEmpty')}
            unclassifiedHint={t('templates.unclassifiedHint')}
            // Fixed widths, so switching plants never moves a column: with widths from the content, a plant whose
            // templates share content with many plants widened 「內容相同的廠區」 and squeezed 名稱 (#84).
            tableLayout="fixed"
            scrollX={COLUMN_WIDTH.code + 240 + COLUMN_WIDTH.count + COLUMN_WIDTH.status + COLUMN_WIDTH.usage + COLUMN_WIDTH.plants + COLUMN_WIDTH.updatedAt}
            columns={[
              { key: 'code', title: t('templates.code'), dataIndex: 'code', width: COLUMN_WIDTH.code },
              { key: 'name', title: t('templates.name'), render: (_, row) => <Link to={`/admin/templates/${row.id}`}>{row.name}</Link> },
              { key: 'count', title: t('templates.controlPointCount'), dataIndex: 'control_point_count', align: 'right', width: COLUMN_WIDTH.count },
              { key: 'status', title: t('templates.status'), render: (_, row) => <TemplateStatusTag status={row.status} />, width: COLUMN_WIDTH.status },
              { key: 'usage', title: t('templates.usage.title'), render: (_, row) => <TemplateUsageTag inUse={row.in_use} />, width: COLUMN_WIDTH.usage },
              chosenPlant
                ? {
                    key: 'same',
                    width: COLUMN_WIDTH.plants,
                    // One line whatever the language: what does not fit ends in 「…」 (the folded text has its tooltip).
                    ellipsis: { showTitle: false },
                    title: (
                      <Flex align="center" gap={6}>
                        {t('templates.sameContent')}
                        <Tooltip title={t('templates.sameContentHint')} styles={{ root: { maxWidth: 360 } }}>
                          <InfoCircleOutlined aria-label={t('templates.sameContentHint')} tabIndex={0} />
                        </Tooltip>
                      </Flex>
                    ),
                    render: (_, row) => <SameContent plants={sameContent(row, chosenPlant.key)} />,
                  }
                : { key: 'plants', title: t('templates.applicablePlants'), render: (_, row) => applicablePlantsLabel(t, row), width: COLUMN_WIDTH.plants },
              { key: 'updatedAt', title: t('templates.lastModified'), render: (_, row) => <LastModifiedCell row={row} />, width: COLUMN_WIDTH.updatedAt },
            ]}
          />
        )}
      </Card>
      {creating && (
        <TemplateHeaderModal
          limitToPlants={rights.runCodes}
          plant={plant === null || plant === NO_PLANT || (rights.runCodes && !rights.runCodes.includes(plant)) ? undefined : plant}
          onSave={async (values) => navigate(`/admin/templates/${await create.run(values)}/edit`)}
          onClose={() => setCreating(false)}
        />
      )}
    </AppShell>
  )
}

/**
 * 內容相同的其他廠區，代碼以頓號隔開；超過 SAME_CONTENT_SHOWN 個收成「CF、FF、FQ、GH 等 15 廠」，滑過或 Tab 到上面看
 * 全部（#120）；都沒有就寫「本廠獨有」。
 */
function SameContent({ plants }: { plants: string[] }) {
  const { t } = useTranslation()
  if (plants.length === 0) return <span style={{ color: palette.textTertiary }}>{t('templates.sameContentNone')}</span>
  const all = plants.join('、')
  if (plants.length <= SAME_CONTENT_SHOWN) return <span data-testid="same-content">{all}</span>
  return (
    <Tooltip title={all}>
      <span tabIndex={0} data-testid="same-content">
        {t('templates.sameContentMore', { codes: plants.slice(0, SAME_CONTENT_SHOWN).join('、'), count: plants.length })}
      </span>
    </Tooltip>
  )
}
