import { Alert, Breadcrumb, Button, Card, Flex, Form, Input, Popconfirm, Table, Typography } from 'antd'
import type { ColumnType } from 'antd/es/table'
import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { AssessingUnit } from '../api/assessingUnits'
import { AppShell } from '../components/AppShell'
import { PageHeader } from '../components/PageHeader'
import { requiredText } from '../components/TemplateEditModals'
import { useWriteToast } from '../components/useWriteToast'
import { errorText } from '../domain/errors'
import { listLoading } from '../domain/lists'
import { useAssessingUnitEditing, useAssessingUnits } from '../hooks/useAssessingUnits'
import { useSettingsRights } from '../hooks/useMyAuditRole'
import { CARD_BODY_STYLE, CARD_STYLE, palette } from '../theme'

const UNIT_ERRORS = { '23505': 'templates.units.duplicate', '23503': 'templates.units.inUse' }

/**
 * The card (方向 A, #124): narrower than the page. The add row (csa-edge-row) and the table (csa-edge-table) run to its
 * edges (global.css); the table ends the card (csa-edge-bottom).
 */
const UNITS_CARD_STYLE: CSSProperties = { ...CARD_STYLE, maxWidth: 720 }

/** 自評單位清單 (#10): group-wide list the control points pick from. 稽核管理者 only (RLS). 方向 A (#124). */
export function AssessingUnitsPage() {
  const { t } = useTranslation()
  const units = useAssessingUnits()
  const loading = listLoading(units)
  const edit = useAssessingUnitEditing()
  // The list is shared by every plant, so a 稽核人員 only adds to it; renaming and deleting are the 稽核主管's (Q144).
  const rights = useSettingsRights()
  const { holder, withToast } = useWriteToast(UNIT_ERRORS)
  const [form] = Form.useForm<{ name: string }>()
  // The row whose name is being edited in place: the 修改 link opens it, saving or Esc closes it.
  const [renaming, setRenaming] = useState<string | null>(null)
  // Back to its 修改 link after Enter or Esc, as antd does for its own pencil; a click elsewhere keeps its focus. Looked
  // up once the row has redrawn.
  const refocus = (id: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-rename="${id}"]`)?.focus())

  const actionsColumn: ColumnType<AssessingUnit> = {
    key: 'actions',
    title: t('templates.units.actions'),
    width: 110,
    render: (_, row) => (
      <Flex gap={12}>
        <Button type="link" size="small" style={{ padding: 0 }} data-rename={row.id} onClick={() => setRenaming(row.id)}>
          {t('templates.edit')}
        </Button>
        <Popconfirm title={t('templates.units.deleteConfirm', { name: row.name })} onConfirm={() => withToast(edit.remove.run(row.id))}>
          <Button type="link" size="small" danger style={{ padding: 0 }}>
            {t('templates.delete')}
          </Button>
        </Popconfirm>
      </Flex>
    ),
  }

  return (
    <AppShell>
      {holder}
      <Breadcrumb items={[{ title: <Link to="/admin/templates">{t('templates.title')}</Link> }, { title: t('templates.units.title') }]} />
      <PageHeader title={t('templates.units.title')} subtitle={t('templates.units.hint')} />
      <Card style={UNITS_CARD_STYLE} styles={{ body: CARD_BODY_STYLE }}>
        {rights.canAdd && (
          <Form
            form={form}
            onFinish={async ({ name }) => {
              // Clear without resetFields, which remounts the input and drops focus: ready for the next one.
              if (await withToast(edit.create.run(name.trim()))) form.setFieldValue('name', '')
            }}
            className="csa-edge-row"
            // Divided from the table by the card's own line colour, as the mockup draws it.
            style={{ paddingBlock: 12, borderBottom: `1px solid ${palette.border}` }}
          >
            <Flex gap={8} align="flex-start">
              <Form.Item name="name" rules={requiredText(t)} style={{ flex: 1, minWidth: 0, margin: 0 }}>
                <Input placeholder={t('templates.units.placeholder')} aria-label={t('templates.units.name')} data-testid="new-unit-name" />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={edit.create.isPending} data-testid="add-unit">
                {t('templates.units.add')}
              </Button>
            </Flex>
          </Form>
        )}
        {units.isError ? (
          <Alert type="warning" showIcon title={errorText(units.error)} style={{ marginBlock: 16 }} />
        ) : (
          <Table<AssessingUnit>
            className="csa-edge-table csa-edge-bottom"
            data-testid="unit-table"
            rowKey="id"
            size="small"
            pagination={false}
            loading={loading}
            dataSource={units.data ?? []}
            // antd draws the empty hint under the spinner too; while loading there is nothing to say yet.
            locale={{ emptyText: loading ? null : t('templates.units.empty') }}
            columns={[
              {
                title: t('templates.units.name'),
                dataIndex: 'name',
                render: (name: string, row) => (
                  <Typography.Text
                    editable={{
                      editing: renaming === row.id,
                      // Opened from the 修改 link only, so no pencil.
                      triggerType: [],
                      onChange: (next) => {
                        setRenaming(null)
                        if (next.trim() && next.trim() !== name) void withToast(edit.rename.run(row.id, next.trim()))
                      },
                      onEnd: () => refocus(row.id),
                      onCancel: () => {
                        setRenaming(null)
                        refocus(row.id)
                      },
                    }}
                  >
                    {name}
                  </Typography.Text>
                ),
              },
              ...(rights.isAdmin ? [actionsColumn] : []),
            ]}
          />
        )}
      </Card>
    </AppShell>
  )
}
