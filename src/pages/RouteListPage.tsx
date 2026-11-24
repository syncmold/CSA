import { Alert, Button, Card, Form, Modal, Select, Tooltip, Typography } from 'antd'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import type { RouteSummary } from '../api/approvalRoutes'
import type { TemplateSummary } from '../api/templates'
import { AppShell } from '../components/AppShell'
import { ComponentGroups } from '../components/ComponentGroups'
import { LastModifiedCell } from '../components/LastModified'
import { InkMark } from '../components/InkDot'
import { NextLaunchNote } from '../components/NextLaunchNote'
import { PageHeader } from '../components/PageHeader'
import { PlantPicker } from '../components/PlantPicker'
import { useFillToBottom } from '../components/useFillToBottom'
import { errorText } from '../domain/errors'
import { listLoading } from '../domain/lists'
import { appliesTo, plantOptions, viewAfterPlantChange } from '../domain/plantChoice'
import { launchProblems, routesOfPlant, routeWriteError, sortRoutes } from '../domain/routes'
import { componentKey, groupByComponent } from '../domain/templates'
import { useApprovalRoutes, useCreateRoute } from '../hooks/useApprovalRoutes'
import { useSettingsRights } from '../hooks/useMyAuditRole'
import { usePlantChoice } from '../hooks/usePlantChoice'
import { usePlants } from '../hooks/usePlants'
import { useTemplates } from '../hooks/useTemplates'
import { CARD_BODY_STYLE, LIST_CARD_STYLE } from '../theme'

/**
 * Column widths in px (the last includes the card's padding, Q108); 循環 takes what is left. Wide enough for the
 * longest values on one line (LH-05.2-組裝, 21 關, ! 尚未通過, 2026-10-29 12:59); 最後修改 is two
 * small lines, the time over the 修改人, as on 範本管理 (#201).
 */
const COLUMN_WIDTH = { code: 140, plant: 200, steps: 80, check: 130, updatedAt: 140 }

/**
 * 流程編輯器 (#11): the 簽核流程 under tabs for 全部 and their 範本's 組成要素, the table listing the chosen tab's routes
 * (#62, #66). Only 稽核管理者 get rows back; others see the empty hint (RLS). As on 範本管理 (#84) the 廠區 buttons come
 * first, the same buttons and the same choice (#85, C3); the tabs then count and list only that plant's routes. With
 * no plants in the 廠區主檔 the list is not split and shows a 廠區 column instead. Who signs in what order is for the
 * route's own page: the list stays plain enough to find a route at a glance (使用者 2026-10-29). 方向 A (#121) as
 * 範本管理 (#120): the 廠區 are a pale band at the top of the list's card.
 *
 * No 狀態 (Q137 (6)): each 範本 × 廠區 has one route, edited directly; the 發起檢查 column says whether the 年度發起 may
 * launch it.
 *
 * No 年度 (Q137 (2)): the list is always the routes themselves, edited for the next launch; a past year's 關卡 are in
 * that year's 自評表, found in 自評表紀錄, as the line under the title says.
 */
export function RouteListPage() {
  const { t } = useTranslation('flows')
  const routes = useApprovalRoutes()
  const rights = useSettingsRights()
  const plants = usePlants()
  const [creating, setCreating] = useState(false)
  const loading = listLoading(routes) || plants.isLoading
  const fill = useFillToBottom<HTMLDivElement>()
  const rows = useMemo(() => sortRoutes(routes.data ?? []), [routes.data])
  // Every route's 廠區 is one of the 廠區主檔, so the buttons are exactly its plants, as on 範本管理.
  const options = plantOptions(plants.data ?? [], [], t('common:plants.noPlant'))
  const [plant, choosePlant] = usePlantChoice(options, !loading)
  const plantRows = plant === null ? rows : routesOfPlant(rows, plant)
  const chosenPlant = options.find((o) => o.key === plant)
  const changePlant = (next: string) =>
    choosePlant(next, viewAfterPlantChange(routesOfPlant(rows, next).map((r) => ({ component: r.template.component }))))
  // Shown only when the list is not split by plant; never while loading, so the columns do not change once it is chosen.
  const plantColumn = !chosenPlant && !loading

  return (
    <AppShell>
      <PageHeader
        title={t('title')}
        extra={
          // Shown to 稽核主管, 系統維護員 and a 稽核人員 who runs a plant (Q144) only for tidiness; the database refuses
          // anyone else's writes.
          rights.canAdd && (
            <Button type="primary" onClick={() => setCreating(true)} data-testid="create-route">
              {t('create')}
            </Button>
          )
        }
      />
      {plants.isError && <Alert type="warning" showIcon title={t('common:plants.loadError', { error: errorText(plants.error) })} />}
      <NextLaunchNote subject={t('common:nextLaunch.routes')} />
      {/* One height whichever 組成要素 is chosen (#66). */}
      <Card ref={fill.ref} style={{ ...LIST_CARD_STYLE, ...fill.style }} styles={{ body: CARD_BODY_STYLE }}>
        {options.length > 0 && <PlantPicker options={options} value={plant} onChange={changePlant} />}
        {routes.isError ? (
          <Alert type="warning" showIcon title={errorText(routes.error)} style={{ marginBlock: 16 }} />
        ) : (
          <ComponentGroups<RouteSummary>
            testId="route-table"
            rows={plantRows}
            rowKey={(row) => row.id}
            componentOf={(row) => row.template.component}
            loading={loading}
            emptyText={t(!rows.length ? 'empty' : 'plantEmpty')}
            groupEmptyText={t('groupEmpty')}
            unclassifiedHint={t('unclassifiedHint')}
            // Fixed widths, so switching plants never moves a column (as on 範本管理, #84).
            tableLayout="fixed"
            scrollX={240 + COLUMN_WIDTH.code + (plantColumn ? COLUMN_WIDTH.plant : 0) + COLUMN_WIDTH.steps + COLUMN_WIDTH.check + COLUMN_WIDTH.updatedAt}
            columns={[
              { key: 'cycle', title: t('cycle'), render: (_, row) => <Link to={`/admin/flows/${row.id}`}>{row.template.name}</Link> },
              { key: 'code', title: t('templateCode'), width: COLUMN_WIDTH.code, render: (_, row) => row.template.code },
              ...(plantColumn ? [{ key: 'plant', title: t('plant'), width: COLUMN_WIDTH.plant, render: (_: unknown, row: RouteSummary) => `${row.plant.factory_code} ${row.plant.name}` }] : []),
              { key: 'steps', title: t('steps'), width: COLUMN_WIDTH.steps, align: 'right', render: (_, row) => t('stepCount', { count: row.step_count }) },
              { key: 'check', title: t('check'), width: COLUMN_WIDTH.check, render: (_, row) => <CheckCell route={row} /> },
              { key: 'updatedAt', title: t('updatedAt'), width: COLUMN_WIDTH.updatedAt, render: (_, row) => <LastModifiedCell row={row} /> },
            ]}
          />
        )}
      </Card>
      {creating && <CreateRouteModal plant={plant ?? undefined} limitToPlantIds={rights.runPlantIds} onClose={() => setCreating(false)} />}
    </AppShell>
  )
}

/** 發起檢查 in 方向 A (#121): a green 「✓ 通過」, or an orange 「! 尚未通過」 whose tooltip lists what is missing. */
function CheckCell({ route }: { route: RouteSummary }) {
  const { t } = useTranslation('flows')
  if (route.launch_check.ready)
    return (
      <InkMark ink="green" mark="✓">
        {t('passed')}
      </InkMark>
    )
  return (
    <Tooltip title={launchProblems(t, route.launch_check).join(' ')}>
      <span tabIndex={0} data-testid="route-check-problem">
        <InkMark ink="orange" mark="!">
          {t('notPassed')}
        </InkMark>
      </span>
    </Tooltip>
  )
}

/**
 * 新增流程: choose the 範本, then one of the 廠區 it applies to that has no route yet (one per 範本 × 廠區, Q137 (6)); a 範本
 * whose every 廠區 has one is not offered. `plant` is the 廠區 chosen on the list (#85): choosing a 範本 that applies to it
 * fills it in.
 */
function CreateRouteModal({ plant, limitToPlantIds, onClose }: { plant?: string; limitToPlantIds: readonly string[] | null; onClose: () => void }) {
  const { t } = useTranslation('flows')
  const navigate = useNavigate()
  const templates = useTemplates()
  const plants = usePlants()
  const routes = useApprovalRoutes()
  const create = useCreateRoute()
  const [form] = Form.useForm<{ templateId: string; plantId: string }>()
  const templateId = Form.useWatch('templateId', form)
  const [error, setError] = useState<string | null>(null)

  const templateOf = (id: string | undefined) => templates.data?.find((tpl) => tpl.id === id)
  const taken = useMemo(() => new Set((routes.data ?? []).map((r) => `${r.template.id}|${r.plant.id}`)), [routes.data])
  const applicableTo = (tpl: TemplateSummary | undefined) =>
    // A 稽核人員 makes routes for the plants he runs only (Q144).
    (plants.data ?? []).filter(
      (p) => tpl && appliesTo(tpl, p.factory_code) && !taken.has(`${tpl.id}|${p.id}`) && (!limitToPlantIds || limitToPlantIds.includes(p.id)),
    )
  const template = templateOf(templateId)
  const applicable = applicableTo(template)

  const submit = async (v: { templateId: string; plantId: string }) => {
    setError(null)
    try {
      navigate(`/admin/flows/${await create.run(v.templateId, v.plantId)}/edit`)
    } catch (e) {
      setError(routeWriteError(t, e))
    }
  }

  return (
    <Modal
      open
      title={t('createTitle')}
      okText={t('save')}
      confirmLoading={create.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      data-testid="create-route-modal"
    >
      <Typography.Paragraph type="secondary">{t('createHint')}</Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        onValuesChange={(changed: { templateId?: string }) => {
          if (!changed.templateId) return
          form.setFieldValue('plantId', applicableTo(templateOf(changed.templateId)).find((p) => p.factory_code === plant)?.id)
        }}
        requiredMark
      >
        <Form.Item name="templateId" label={t('template')} rules={[{ required: true, message: t('required') }]}>
          <Select
            showSearch={{ optionFilterProp: 'label' }}
            loading={templates.isPending || routes.isPending}
            // Grouped like the lists (#62); a 組成要素 with no template is left out of the dropdown.
            options={groupByComponent((templates.data ?? []).filter((tpl) => applicableTo(tpl).length), (tpl) => tpl.component)
              .filter((g) => g.rows.length)
              .map((g) => ({
                label: t(`common:templates.componentHeadings.${componentKey(g.component)}`),
                options: g.rows.map((tpl) => ({ value: tpl.id, label: `${tpl.code} ${tpl.name}` })),
              }))}
            data-testid="route-template"
          />
        </Form.Item>
        <Form.Item name="plantId" label={t('plant')} rules={[{ required: true, message: t('required') }]} extra={t('plantHint')}>
          <Select
            disabled={!template}
            placeholder={template ? undefined : t('choosePlantFirst')}
            loading={plants.isPending}
            options={applicable.map((p) => ({ value: p.id, label: `${p.factory_code} ${p.name}` }))}
            data-testid="route-plant"
          />
        </Form.Item>
      </Form>
      {error && <Alert type="error" showIcon title={error} />}
    </Modal>
  )
}
