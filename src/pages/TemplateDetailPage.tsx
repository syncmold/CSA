import { HolderOutlined } from '@ant-design/icons'
import { Alert, Breadcrumb, Button, Card, Checkbox, Flex, Popconfirm, Spin, Table, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useState, type HTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'
import type { ControlPointRow, TemplateSectionRow, TemplateTree } from '../api/templates'
import { AppShell } from '../components/AppShell'
import { DeleteTemplateModal } from '../components/DeleteTemplateModal'
import { EditModeControls } from '../components/EditModeControls'
import type { InfoItem } from '../components/InfoStrip'
import { LastModifiedLine } from '../components/LastModified'
import { NextLaunchNote } from '../components/NextLaunchNote'
import { PageHeader } from '../components/PageHeader'
import { PointText } from '../components/PointText'
import { ControlPointModal, SectionModal, TemplateHeaderModal } from '../components/TemplateEditModals'
import { TemplateStatusTag, TemplateUsageTag } from '../components/TemplateStatusTag'
import { greyHandle, useDragReorder } from '../components/useDragReorder'
import { useWriteToast } from '../components/useWriteToast'
import { unitRows, type UnitRow } from '../domain/answering'
import { errorText } from '../domain/errors'
import {
  cardTitle,
  deepestLevelAfter,
  headsSubsections,
  isSubheading,
  moveWithSubsections,
  numberColumnWidth,
  outline,
  outlineRows,
  pointNumbers,
  type OutlineCard,
  type OutlinePart,
  type ShownPoint,
  type ShownSection,
  type SubheadingRow,
} from '../domain/outline'
import { ownPlantOf } from '../domain/plantChoice'
import { routeFor } from '../domain/routes'
import { applicablePlantsLabel, componentKey, controlPointCount, listPathFor, shownSections } from '../domain/templates'
import { useApprovalRoutes } from '../hooks/useApprovalRoutes'
import { useAssessingUnits } from '../hooks/useAssessingUnits'
import { useSettingsRights } from '../hooks/useMyAuditRole'
import { usePlants } from '../hooks/usePlants'
import { useTemplateEditing, useTemplateTree } from '../hooks/useTemplates'
import { NO_WRAP } from '../components/tableColumns'
import { CARD_BODY_STYLE, CARD_STYLE, LINK_BUTTON, NOTE_BOX, palette, subheadingNameStyle, subheadingStyle, TABLE_MIN_WIDTH, textSize } from '../theme'

type Dialog =
  | { kind: 'header' }
  | { kind: 'deleteTemplate' }
  | { kind: 'addSection' }
  | { kind: 'editSection'; section: TemplateSectionRow }
  | { kind: 'addPoint'; section: TemplateSectionRow }
  | { kind: 'editPoint'; point: ControlPointRow }

type Editing = ReturnType<typeof useTemplateEditing>

type DragProps<K extends 'handleProps' | 'itemProps'> = ReturnType<ReturnType<typeof useDragReorder>[K]>

/**
 * 範本管理 (#3 read, #10 edit): one template's header, sections and control points in paper order.
 * Opened from the list it is read-only; the editing controls are only at `/edit`, behind 「修改」, so
 * looking at a template cannot change it by accident (#66). Only 稽核管理者 and 系統維護員 get the template back from
 * RLS at all, and only the 稽核管理者 gets 修改; issued 自評表 are not affected by edits because they carry their own
 * snapshot (ADR-0004).
 *
 * No 年度 (Q137 (2)): the page is always the template itself; the questions a past year issued are in that year's 自評表,
 * found in 自評表紀錄, as the line under the title says.
 */
export function TemplateDetailPage({ editing: editPage = false }: { editing?: boolean }) {
  const { t } = useTranslation()
  const rights = useSettingsRights()
  const { id = '' } = useParams<{ id: string }>()
  const tree = useTemplateTree(id)
  // 稽核主管 and 系統維護員 change templates (Q129), a 稽核人員 those of the plants he runs (Q144); anyone else gets no 修改,
  // and /edit shows the read-only page.
  const canEdit = tree.data ? rights.canEditTemplate(tree.data) : false
  const editing = editPage && canEdit
  // 「看簽核流程 →」 (#174): the route of this 範本 on its 廠區.
  const routes = useApprovalRoutes()
  const ownPlant = tree.data ? ownPlantOf(tree.data) : undefined
  const plants = usePlants()
  const plantId = plants.data?.find((p) => p.factory_code === ownPlant)?.id
  const route = plantId ? routeFor(routes.data ?? [], id, plantId) : undefined
  const routeLink = route && (
    <Link to={`/admin/flows/${route.id}`} data-testid="to-route">
      {t('templates.toRoute')}
    </Link>
  )
  const edit = useTemplateEditing(id)
  // Warm the cache the 控制要點 modal reads, so its 自評單位 select shows a name and not an id on first open.
  useAssessingUnits()
  const { holder, withToast } = useWriteToast()
  const [dialog, setDialog] = useState<Dialog | null>(null)

  const tpl = tree.data
  const sections = tpl?.template_section ?? []
  const sectionDrag = useDragReorder(
    sections.map((s) => s.id),
    // A section moves with its 分段 (Q125).
    (ids) => void withToast(edit.reorderSections.run(moveWithSubsections(sections, ids))),
  )

  const body = (() => {
    if (tree.isPending) return <Spin />
    if (tree.isError) return <Alert type="warning" showIcon title={errorText(tree.error)} />
    if (!tpl) return <Alert type="info" showIcon title={t('templates.notFound')} />

    const totalPoints = controlPointCount(tpl)
    const cards = outline(sections)

    return (
      <>
        <PageHeader
          title={`${tpl.code} ${tpl.name}`}
          titleTestId="template-heading"
          extra={
            <>
              {routeLink}
              {canEdit && (
                <EditModeControls editing={editing} viewPath={`/admin/templates/${id}`}>
                  <Button onClick={() => setDialog({ kind: 'header' })} data-testid="edit-header">
                    {t('templates.editHeader')}
                  </Button>
                  {/* A used template can only be deactivated (Q87); the database refuses its deletion anyway. */}
                  <Tooltip title={tpl.in_use ? t('templates.deleteTemplate.inUseHint') : undefined}>
                    <Button
                      danger
                      disabled={tpl.in_use}
                      onClick={() => setDialog({ kind: 'deleteTemplate' })}
                      data-testid="delete-template"
                    >
                      {t('templates.deleteTemplate.button')}
                    </Button>
                  </Tooltip>
                </EditModeControls>
              )}
            </>
          }
        />
        <NextLaunchNote subject={t('nextLaunch.questions')} />
        <Card styles={{ body: { padding: '12px 16px' } }} data-testid="template-info">
          <InfoList
            items={[
              { key: 'code', label: t('templates.code'), children: tpl.code },
              { key: 'component', label: t('templates.component'), children: t(`templates.components.${componentKey(tpl.component)}`) },
              { key: 'status', label: t('templates.status'), children: <TemplateStatusTag status={tpl.status} /> },
              { key: 'usage', label: t('templates.usage.title'), children: <TemplateUsageTag inUse={tpl.in_use} /> },
              { key: 'plants', label: t('templates.applicablePlants'), children: applicablePlantsLabel(t, tpl) },
              {
                key: 'size',
                label: t('templates.size'),
                // 章 counts the cards (第一層): SY-A has 5 on paper, not its 30 章節 rows (Q125).
                children: t('templates.sizeValue', { sections: cards.length, points: totalPoints }),
              },
              { key: 'lastModified', label: t('templates.lastModified'), children: <LastModifiedLine row={tpl} />, fullRow: true },
            ]}
          />
        </Card>
        {/* What editing does to issued 自評表 is the line under the title (Q137 (2)); the edit page adds how to reorder. */}
        {editing && (
          <div style={{ ...NOTE_BOX, color: palette.textSecondary }} role="note" data-testid="drag-note">
            {t('templates.dragHint')}
          </div>
        )}
        {editing
          ? cards.flatMap((card) => {
              const numbers = pointNumbers(card, (s) => s.control_point)
              return card.parts.map((part, i) => (
                <SectionCard
                  key={part.section.id}
                  part={part}
                  label={part.section.code ?? (i === 0 ? `${card.number}.` : '')}
                  hasSubsections={headsSubsections(card, i)}
                  numbers={numbers}
                  handleProps={sectionDrag.handleProps(part.section.id)}
                  itemProps={sectionDrag.itemProps(part.section.id)}
                  onEdit={() => setDialog({ kind: 'editSection', section: part.section })}
                  onDelete={() => withToast(edit.deleteSection.run(part.section.id))}
                  onAddPoint={() => setDialog({ kind: 'addPoint', section: part.section })}
                  onEditPoint={(point) => setDialog({ kind: 'editPoint', point })}
                  onToggleReverse={(point, isReverse) => withToast(edit.setControlPointReverse.run(point.id, isReverse))}
                  onDeletePoint={(point) => withToast(edit.deleteControlPoint.run(point.id))}
                  onReorderPoints={(ids) => void withToast(edit.reorderControlPoints.run(part.section.id, ids))}
                />
              ))
            })
          : outline(shownSections(sections)).map((card) => <TemplateCard key={card.parts[0]!.section.id} card={card} />)}
        {editing && (
          <Button type="dashed" block onClick={() => setDialog({ kind: 'addSection' })} data-testid="add-section">
            {t('templates.addSection')}
          </Button>
        )}
        {dialog && <DialogFor dialog={dialog} tpl={tpl} edit={edit} limitToPlants={rights.runCodes} onClose={() => setDialog(null)} />}
      </>
    )
  })()

  const heading = tpl && `${tpl.code} ${tpl.name}`
  return (
    <AppShell>
      {holder}
      <Breadcrumb items={[{ title: <Link to={tpl ? listPathFor('/admin/templates', tpl.component, ownPlantOf(tpl)) : '/admin/templates'}>{t('templates.title')}</Link> }, { title: heading ?? '…' }]} />
      {body}
    </AppShell>
  )
}

/** One label and value of the header; `fullRow` gives it a row of its own (see InfoList). */
type InfoListItem = InfoItem & { fullRow?: boolean }

/**
 * The template's header as labels and values (方向 A, #122): as many columns of them as fit, one on a phone. The labels
 * share one width so the values line up down each column; a longer English label pushes its value along. A `fullRow`
 * item has a row of its own after the others, for a value one column cannot hold on one line (最後修改, #201).
 */
function InfoList({ items }: { items: InfoListItem[] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '6px 24px', margin: 0, fontSize: textSize(13) }}>
      {items.map((item) => (
        <Flex key={item.key} gap={10} style={item.fullRow ? { gridColumn: '1 / -1' } : undefined}>
          <dt style={{ flex: 'none', minWidth: 72, color: palette.textTertiary }}>{item.label}</dt>
          <dd style={{ margin: 0, minWidth: 0 }}>{item.children}</dd>
        </Flex>
      ))}
    </dl>
  )
}

/** The open modal; a refusal from `run` stays inside the modal (FormModal shows it). */
function DialogFor({
  dialog,
  tpl,
  edit,
  limitToPlants,
  onClose,
}: {
  dialog: Dialog
  tpl: TemplateTree
  edit: Editing
  /** A 稽核人員's plants (Q144); null for those not limited to plants. */
  limitToPlants: readonly string[] | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  switch (dialog.kind) {
    case 'header':
      return (
        <TemplateHeaderModal
          limitToPlants={limitToPlants}
          initial={{
            code: tpl.code,
            name: tpl.name,
            layout: tpl.layout,
            component: tpl.component,
            status: tpl.status,
            all_plants: tpl.all_plants,
            factory_codes: tpl.template_plant.map((p) => p.factory_code),
          }}
          // The edit form always has a 狀態; only a new template has none (it starts 啟用).
          onSave={(header) => edit.updateHeader.run({ ...header, status: header.status ?? tpl.status })}
          onClose={onClose}
        />
      )
    case 'deleteTemplate':
      return (
        <DeleteTemplateModal
          tpl={tpl}
          onDelete={edit.deleteTemplate.run}
          onDeleted={() => navigate(listPathFor('/admin/templates', tpl.component, ownPlantOf(tpl)), { replace: true })}
          onClose={onClose}
        />
      )
    case 'addSection':
      return <SectionModal maxLevel={levelAfter(tpl.template_section.at(-1))} onSave={edit.createSection.run} onClose={onClose} />
    case 'editSection': {
      const { section } = dialog
      return (
        <SectionModal
          initial={{ name: section.name, level: section.level, code: section.code }}
          maxLevel={levelAfter(tpl.template_section.find((s) => s.position === section.position - 1))}
          onSave={(input) => edit.updateSection.run(section.id, input)}
          onClose={onClose}
        />
      )
    }
    case 'addPoint':
      return <ControlPointModal layout={tpl.layout} onSave={(input) => edit.createControlPoint.run(dialog.section.id, input)} onClose={onClose} />
    case 'editPoint':
      return (
        <ControlPointModal
          layout={tpl.layout}
          initial={{
            code: dialog.point.code,
            text: dialog.point.text,
            assessing_unit_ids: dialog.point.control_point_unit.map((u) => u.assessing_unit_id),
            is_reverse: dialog.point.is_reverse,
          }}
          onSave={(input) => edit.updateControlPoint.run(dialog.point.id, input)}
          onClose={onClose}
        />
      )
  }
}

/** The deepest 層級 a section placed after `previous` may take (Q125). */
function levelAfter(previous: TemplateSectionRow | undefined): number {
  return deepestLevelAfter(previous?.level ?? 0)
}

type CardRow = UnitRow<ShownPoint> | SubheadingRow<ShownSection>

/**
 * A control point's number, text and buttons span its 自評單位 rows (the paper's merged cell). The last one's merged
 * cells sit in the first of its rows, which csa-edge-bottom does not reach, so they drop the line on the card's edge.
 */
function mergedCell(lastPoint: string | undefined) {
  return (row: UnitRow<{ id: string }>) => ({
    rowSpan: row.span,
    style: row.point.id === lastPoint ? { borderBottom: 'none' } : undefined,
  })
}

const unitRowsOf = (section: TemplateSectionRow) => unitRows(section.control_point, (p) => p.control_point_unit.map((u) => u.assessing_unit.name))

/**
 * One card as the template reads (#166, the approved mockup): its 第一層 as the title, its own control points, then
 * each 第二／三層 as a 分段列 with the control points under it. # is the paper's 題號, or the place in the card.
 */
function TemplateCard({ card }: { card: OutlineCard<ShownSection> }) {
  const { t } = useTranslation()
  const numbers = pointNumbers(card, (s) => s.points)
  const rows: CardRow[] = outlineRows(card, (s) => unitRows(s.points, (p) => p.units))
  const merged = mergedCell(card.parts.at(-1)?.section.points.at(-1)?.id)
  const headingStyle = (row: SubheadingRow<ShownSection>) => subheadingStyle(row.subheading.level)

  const columns: ColumnsType<CardRow> = [
    {
      title: '#',
      key: 'number',
      width: numberColumnWidth([...numbers.values(), ...card.parts.map((p) => p.section.code)], 50),
      align: 'right',
      onCell: (row) => (isSubheading(row) ? { style: headingStyle(row) } : merged(row)),
      render: (_: unknown, row) => (isSubheading(row) ? row.subheading.section.code : numbers.get(row.point.id)),
    },
    {
      title: t('templates.controlPoint'),
      key: 'text',
      // A 分段列's name runs over the 自評單位 column; a 第三層's sits further in.
      onCell: (row) => (isSubheading(row) ? { colSpan: 2, style: subheadingNameStyle(row.subheading.level) } : merged(row)),
      render: (_: unknown, row) => (isSubheading(row) ? row.subheading.section.name : <PointText text={row.point.text} isReverse={row.point.is_reverse} />),
    },
    // Both layouts: 要素類 may carry 自評單位 too (Q83(3), #46).
    {
      title: t('templates.assessingUnit'),
      key: 'unit',
      ...NO_WRAP,
      onCell: (row) => (isSubheading(row) ? { colSpan: 0 } : NO_WRAP.onCell()),
      render: (_: unknown, row) => (isSubheading(row) ? null : (row.unit ?? '—')),
    },
  ]

  return (
    <Card style={CARD_STYLE} styles={{ body: CARD_BODY_STYLE }} data-testid="template-section">
      <div className="csa-edge-row" style={{ paddingBlock: 10, borderBottom: `1px solid ${palette.border}` }}>
        <Typography.Title level={3} style={{ margin: 0, fontSize: textSize(14), fontWeight: 600, lineHeight: 1.5 }}>
          {cardTitle(card)}
        </Typography.Title>
      </div>
      <Table<CardRow>
        className="csa-edge-table csa-edge-bottom"
        rowKey="key"
        size="small"
        pagination={false}
        // On a phone the table scrolls sideways in its card rather than squeezing 控制要點 to a word a line (#122's mockup).
        scroll={{ x: TABLE_MIN_WIDTH }}
        dataSource={rows}
        locale={{ emptyText: t('templates.sectionEmpty') }}
        onRow={(row) => ({ 'data-testid': isSubheading(row) ? 'template-subheading' : 'control-point-row' }) as HTMLAttributes<HTMLElement>}
        columns={columns}
      />
    </Card>
  )
}

/**
 * One 章節 while editing (#10): draggable among the sections, with its own draggable list of 控制要點. Every 章節 is a
 * card of its own here, set in by its 層級 and labelled with its 題號, so each can be edited, moved and deleted; the
 * control points carry the numbers the template shows (Q125).
 */
function SectionCard({
  part,
  label,
  hasSubsections,
  numbers,
  handleProps,
  itemProps,
  onEdit,
  onDelete,
  onAddPoint,
  onEditPoint,
  onToggleReverse,
  onDeletePoint,
  onReorderPoints,
}: {
  part: OutlinePart<TemplateSectionRow>
  /** What goes before the name: the 題號, the card's number on a 第一層 without one, else nothing. */
  label: string
  /** Heads the 分段 after it: it cannot be deleted before them, and without control points of its own it only heads them. */
  hasSubsections: boolean
  numbers: ReadonlyMap<string, string>
  handleProps: DragProps<'handleProps'>
  itemProps: DragProps<'itemProps'>
  onEdit: () => void
  onDelete: () => void
  onAddPoint: () => void
  onEditPoint: (point: ControlPointRow) => void
  /** 反向題目's tick box (Q148): saved at once, as dragging is; resolves false when the write was refused. */
  onToggleReverse: (point: ControlPointRow, isReverse: boolean) => Promise<boolean>
  onDeletePoint: (point: ControlPointRow) => void
  onReorderPoints: (ids: string[]) => void
}) {
  const { t } = useTranslation()
  const { section, level } = part
  const headingOnly = hasSubsections && section.control_point.length === 0
  const pointDrag = useDragReorder(
    section.control_point.map((p) => p.id),
    onReorderPoints,
  )
  const merged = { onCell: mergedCell(section.control_point.at(-1)?.id) }
  const reverse = useReverseTicks(section.control_point, onToggleReverse)

  const columns: ColumnsType<UnitRow<ControlPointRow>> = [
    {
      key: 'drag',
      width: 32,
      ...merged,
      render: (_: unknown, row) => (
        <HolderOutlined {...greyHandle(pointDrag.handleProps(row.point.id))} aria-label={t('templates.dragHandle')} data-testid="point-handle" />
      ),
    },
    { title: '#', key: 'number', width: numberColumnWidth(numbers.values(), 50), align: 'right', ...merged, render: (_: unknown, row) => numbers.get(row.point.id) },
    {
      title: t('templates.controlPoint'),
      key: 'text',
      ...merged,
      render: (_: unknown, row) => <PointText text={row.point.text} isReverse={row.point.is_reverse} />,
    },
    // Both layouts: 要素類 may carry 自評單位 too (Q83(3), #46).
    { title: t('templates.assessingUnit'), key: 'unit', ...NO_WRAP, render: (_: unknown, row) => row.unit ?? '—' },
    {
      key: 'reverse',
      title: t('templates.reverse'),
      width: 96,
      align: 'center',
      ...merged,
      render: (_: unknown, row) => (
        <Checkbox
          checked={reverse.checked(row.point)}
          disabled={reverse.saving(row.point)}
          onChange={(e) => reverse.toggle(row.point, e.target.checked)}
          aria-label={t('templates.reverseLabel', { section: section.name, number: numbers.get(row.point.id) })}
          data-testid="reverse-checkbox"
        />
      ),
    },
    {
      key: 'actions',
      title: t('templates.units.actions'),
      width: 100,
      ...merged,
      render: (_: unknown, row) => (
        <Flex gap={12}>
          <Button type="link" size="small" style={LINK_BUTTON} onClick={() => onEditPoint(row.point)} aria-label={t('templates.editControlPoint')}>
            {t('templates.edit')}
          </Button>
          <Popconfirm title={t('templates.deleteControlPointConfirm')} onConfirm={() => onDeletePoint(row.point)}>
            <Button type="link" size="small" danger style={LINK_BUTTON}>
              {t('templates.delete')}
            </Button>
          </Popconfirm>
        </Flex>
      ),
    },
  ]

  return (
    <Card
      {...itemProps}
      // The drag's own style (a dashed outline where it would drop, faded while dragged) over the card's; a 分段 is set
      // in under its card (Q125).
      style={{ ...CARD_STYLE, marginInlineStart: (level - 1) * 24, ...itemProps.style }}
      styles={{ body: CARD_BODY_STYLE }}
      data-testid="template-section"
      data-level={level}
    >
      {/* The heading in the card's body rather than antd's title, so on a phone the links wrap under it instead of cutting it short. */}
      <Flex
        className="csa-edge-row"
        align="center"
        justify="space-between"
        wrap
        gap="8px 16px"
        style={{ paddingBlock: 10, borderBottom: `1px solid ${palette.border}`, ...(level > 1 ? subheadingStyle(level) : {}) }}
      >
        <Flex align="center" gap={8}>
          <HolderOutlined {...greyHandle(handleProps)} aria-label={t('templates.dragHandle')} data-testid="section-handle" />
          <Typography.Title level={3} style={{ margin: 0, fontSize: textSize(14), fontWeight: 600, lineHeight: 1.5 }}>
            {label && `${label} `}
            {section.name}
          </Typography.Title>
          {level > 1 && <Typography.Text type="secondary">{t(`templates.sectionLevels.${level}`)}</Typography.Text>}
        </Flex>
        <Flex gap={14} wrap>
          <Button type="link" style={LINK_BUTTON} onClick={onAddPoint} data-testid="add-control-point">
            {t('templates.addControlPoint')}
          </Button>
          <Button type="link" style={LINK_BUTTON} onClick={onEdit}>
            {t('templates.renameSection')}
          </Button>
          {hasSubsections ? (
            // Deleting it would hand its 分段 to the card before; they go (or move) first.
            <Tooltip title={t('templates.deleteSubsectionsFirst')}>
              <Button type="link" danger disabled style={LINK_BUTTON} data-testid="delete-section">
                {t('templates.delete')}
              </Button>
            </Tooltip>
          ) : (
            <Popconfirm title={t('templates.deleteSectionConfirm', { count: section.control_point.length })} onConfirm={onDelete}>
              <Button type="link" danger style={LINK_BUTTON} data-testid="delete-section">
                {t('templates.delete')}
              </Button>
            </Popconfirm>
          )}
        </Flex>
      </Flex>
      {headingOnly ? (
        <Typography.Text type="secondary" className="csa-edge-row" style={{ display: 'block', paddingBlock: 8 }} data-testid="heading-only">
          {t('templates.headingOnly')}
        </Typography.Text>
      ) : (
        <Table<UnitRow<ControlPointRow>>
          className="csa-edge-table csa-edge-bottom"
          rowKey="key"
          size="small"
          pagination={false}
          scroll={{ x: TABLE_MIN_WIDTH }}
          dataSource={unitRowsOf(section)}
          locale={{ emptyText: t('templates.sectionEmpty') }}
          // Every row of a control point drags and drops it as a whole, with all its 自評單位 (#46).
          onRow={(row) => ({ ...pointDrag.itemProps(row.point.id), 'data-testid': 'control-point-row' }) as HTMLAttributes<HTMLElement>}
          columns={columns}
        />
      )}
    </Card>
  )
}

/**
 * 反向題目's tick boxes (Q148): a tick shows at once and the box waits until the template read back has it (or the write
 * was refused, which puts it back), so a second click never sends the value the page has not caught up with yet.
 */
function useReverseTicks(points: readonly ControlPointRow[], save: (point: ControlPointRow, isReverse: boolean) => Promise<boolean>) {
  const [wanted, setWanted] = useState<ReadonlyMap<string, boolean>>(new Map())
  const drop = (id: string) =>
    setWanted((m) => {
      const next = new Map(m)
      next.delete(id)
      return next
    })
  // Done once the data agrees; a point that is gone needs no tick either.
  useEffect(() => {
    const now = new Map(points.map((p) => [p.id, p.is_reverse]))
    setWanted((m) => {
      const left = [...m].filter(([id, value]) => now.has(id) && now.get(id) !== value)
      return left.length === m.size ? m : new Map(left)
    })
  }, [points])
  return {
    checked: (p: ControlPointRow) => wanted.get(p.id) ?? p.is_reverse,
    saving: (p: ControlPointRow) => wanted.has(p.id),
    toggle: (p: ControlPointRow, isReverse: boolean) => {
      setWanted((m) => new Map(m).set(p.id, isReverse))
      void save(p, isReverse).then((ok) => ok || drop(p.id))
    },
  }
}
