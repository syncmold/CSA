import { HolderOutlined } from '@ant-design/icons'
import { Alert, Breadcrumb, Button, Card, Flex, Popconfirm, Spin, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'
import type { RouteStepRow, StepInput } from '../api/approvalRoutes'
import { AppShell } from '../components/AppShell'
import { EditModeControls } from '../components/EditModeControls'
import { InkDot, SymbolMark } from '../components/InkDot'
import { NextLaunchNote } from '../components/NextLaunchNote'
import { PageHeader } from '../components/PageHeader'
import { RouteBranchCard } from '../components/RouteBranchCard'
import { BranchStepModal } from '../components/RouteBranchModals'
import { RouteStepModal } from '../components/RouteStepModal'
import { TypeToDeleteModal } from '../components/TypeToDeleteModal'
import { greyHandle, useDragReorder } from '../components/useDragReorder'
import { useWriteToast } from '../components/useWriteToast'
import { assignmentPath } from '../domain/assignment'
import { errorText } from '../domain/errors'
import { launchProblems, type Branch, linkedSignerText, mergeWaitsFor, reorderMerged, routeLayout, routeWriteError, signerLabel } from '../domain/routes'
import { listPathFor } from '../domain/templates'
import { useApprovalRoute, useRouteEditing } from '../hooks/useApprovalRoutes'
import { useEmployees } from '../hooks/useEmployeeSearch'
import { useSettingsRights } from '../hooks/useMyAuditRole'
import { CARD_BODY_STYLE, CARD_STYLE, INK, LINK_BUTTON, NOTE_BOX, palette, TABLE_MIN_WIDTH, textSize } from '../theme'
import { NO_WRAP } from '../components/tableColumns'

/** 群組 and 簽核人 on one line each, yet sharing the table's width with 關卡名稱 rather than squeezed to the right, as the mockup. */
const SPREAD = { onHeaderCell: NO_WRAP.onHeaderCell, onCell: NO_WRAP.onCell }

type Dialog =
  | { kind: 'add' }
  | { kind: 'edit'; step: RouteStepRow }
  | { kind: 'addBranchStep'; branch: Branch }
  | { kind: 'editBranchStep'; branch: Branch; step: RouteStepRow }
  | { kind: 'deleteRoute' }

/**
 * 流程編輯器 (#11, 分流 #98): one 簽核流程's 分流 (a card per 自評單位 the template uses, Q116) and its 匯流後
 * steps in order, and its 發起檢查. A route has no 狀態 (Q137 (6)): it is the only one of its 範本 × 廠區, edited
 * directly, and the 發起檢查 shown here decides whether the 年度發起 may tick it. Opened from the list it is read-only;
 * editing and 刪除 (typed, as a template's) are only at `/edit`, behind 「修改」 (#66). Only 稽核主管 and 系統維護員
 * get the route back from RLS at all, and only they get 修改; issued 自評表 carry their own copy of the steps (ADR-0004).
 *
 * No 年度 (Q137 (2)): the page is always the route itself; a past year's 關卡 are in that year's 自評表, found in
 * 自評表紀錄, as the line under the title says.
 */
export function RouteEditorPage({ editing: editPage = false }: { editing?: boolean }) {
  const { t } = useTranslation('flows')
  const rights = useSettingsRights()
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const route = useApprovalRoute(id)
  // 稽核主管 and 系統維護員 change routes (Q129), a 稽核人員 those of the plants he runs (Q144); anyone else gets no 修改,
  // and /edit shows the read-only page.
  const canEdit = route.data ? rights.canEditRoute(route.data.plant.id) : false
  const editing = editPage && canEdit
  const edit = useRouteEditing(id)
  // One-click writes (delete a step, drag…): a refusal becomes a toast.
  const { holder, withToast } = useWriteToast((error) => routeWriteError(t, error))
  const [dialog, setDialog] = useState<Dialog | null>(null)

  const approvalRoute = route.data
  const steps = approvalRoute?.route_step ?? []
  const { branches, merged } = routeLayout(approvalRoute?.branch_units ?? [], steps)
  const signers = useEmployees(steps.flatMap((s) => s.signer_emp_id ?? []))
  // Only the 匯流後 steps are dragged; each 分流 keeps its order (Q116 (2)).
  const drag = useDragReorder(
    merged.map((s) => s.id),
    (ids) => void withToast(edit.reorderSteps.run(reorderMerged(steps, ids))),
  )

  const person = (empId: string) => {
    const who = signers.data?.get(empId)
    if (who) return signerLabel(who)
    return (
      <span>
        {empId}
        {signers.isSuccess && (
          <>
            {' '}
            <InkDot ink="red">{t('signerUnknown')}</InkDot>
          </>
        )}
      </span>
    )
  }

  const signer = (empId: string | null, link: RouteStepRow['link'] = null, linkedNow = false) => {
    // 連動關卡 (#189): who signs now, and whose 簽核人 it follows (「SSA78＝廠區管理員（自動）」); nobody sets it here.
    // While it is not linked (#190) the same place says why, and the 簽核人 is chosen here like any 稽核室 step.
    if (link) {
      return (
        <span data-testid="step-linked-signer">
          {empId && person(empId)}
          {linkedNow ? linkedSignerText(t, link, true) : <Typography.Text type="secondary">{linkedSignerText(t, link, false)}</Typography.Text>}
        </span>
      )
    }
    // Everyone else is 分派 on 分派填寫人 before the launch (Q147), the one place a 廠區管理員 assigns too, so every
    // 分派 is in the 異動紀錄: here only who it is, or that nobody is yet and where to go.
    if (!empId) {
      return (
        <span data-testid="step-unassigned">
          <InkDot ink="orange">{t('signerUnassigned')}</InkDot>
          {approvalRoute && (
            <Link to={assignmentPath(approvalRoute.plant.factory_code, 'next')} style={{ marginInlineStart: 12 }} data-testid="to-assignment">
              {t('toAssignment')} →
            </Link>
          )}
        </span>
      )
    }
    return person(empId)
  }

  const body = (() => {
    if (route.isPending) return <Spin />
    if (route.isError) return <Alert type="warning" showIcon title={errorText(route.error)} />
    if (!approvalRoute) return <Alert type="info" showIcon title={t('notFound')} />
    const { template, plant } = approvalRoute
    const problems = launchProblems(t, approvalRoute.launch_check)

    // The 匯流後 steps are numbered among themselves: their route positions come after every 分流 step.
    const columns: ColumnsType<RouteStepRow> = [
      { title: '#', key: 'n', align: 'right', ...NO_WRAP, render: (_: unknown, _row, i) => i + 1 },
      {
        title: t('stepName'),
        dataIndex: 'name',
        render: (name: string, row) => (
          <>
            {name}
            {row.link && (
              <Tag style={{ marginInlineStart: 8 }} data-testid="step-linked-tag">
                {t('linkedTag')}
              </Tag>
            )}
          </>
        ),
      },
      { title: t('group'), dataIndex: 'step_group', ...SPREAD, render: (g: RouteStepRow['step_group']) => t(`groups.${g}`) },
      { title: t('signer'), key: 'signer', ...SPREAD, render: (_: unknown, row) => signer(row.signer_emp_id, row.link, row.linked_now) },
    ]
    // Edit mode adds the drag handle in front and the 修改／刪除 links behind (#66).
    const editingColumns: ColumnsType<RouteStepRow> = [
      {
        key: 'drag',
        width: 32,
        render: (_: unknown, row) => (
          <HolderOutlined {...greyHandle(drag.handleProps(row.id))} aria-label={t('dragHandle')} data-testid="step-handle" />
        ),
      },
      ...columns,
      {
        key: 'actions',
        title: t('actions'),
        width: 100,
        // A 連動關卡 is read-only while linked: no 修改 or 刪除, the database refuses both. While it is not (#190), 修改 picks
        // its 簽核人; still no 刪除.
        render: (_: unknown, row) =>
          row.link && row.linked_now ? (
            <Tooltip title={t('linkedActionTip')}>
              <span style={{ color: palette.textTertiary }} data-testid="step-linked-action">
                {t('linkedAction')}
              </span>
            </Tooltip>
          ) : row.link ? (
            <Button type="link" size="small" style={LINK_BUTTON} onClick={() => setDialog({ kind: 'edit', step: row })} aria-label={t('editStep')}>
              {t('editLink')}
            </Button>
          ) : (
            <Flex gap={12}>
              <Button type="link" size="small" style={LINK_BUTTON} onClick={() => setDialog({ kind: 'edit', step: row })} aria-label={t('editStep')}>
                {t('editLink')}
              </Button>
              <Popconfirm title={t('deleteStepConfirm')} onConfirm={() => withToast(edit.deleteStep.run(row.id))}>
                <Button type="link" size="small" danger style={LINK_BUTTON}>
                  {t('delete')}
                </Button>
              </Popconfirm>
            </Flex>
          ),
      },
    ]

    return (
      <>
        <PageHeader
          title={`${template.code} ${template.name} × ${plant.factory_code} ${plant.name}`}
          titleTestId="route-heading"
          extra={
            <>
              <Link to={`/admin/templates/${template.id}`} data-testid="to-questions">
                {t('toQuestions')}
              </Link>
              {canEdit && (
                <EditModeControls editing={editing} viewPath={`/admin/flows/${id}`}>
                  <Button danger onClick={() => setDialog({ kind: 'deleteRoute' })} data-testid="delete-route">
                    {t('delete')}
                  </Button>
              </EditModeControls>
              )}
            </>
          }
        />
        <NextLaunchNote subject={t('common:nextLaunch.routes')} />
        <CheckNote problems={problems} />
        {/* Only editing changes anything, so only the edit page explains what editing does. */}
        {editing && (
          <div style={{ ...NOTE_BOX, color: palette.textSecondary }} role="note">
            {t('editNote')}
          </div>
        )}

        <Card style={CARD_STYLE} styles={{ body: CARD_BODY_STYLE }}>
          <SectionHeading title={t('branchesTitle')} hint={t('branchesHint')} />
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, paddingBlock: 14 }}
            data-testid="route-branches"
          >
            {branches.map((branch) => (
              <RouteBranchCard
                key={branch.unit.id}
                branch={branch}
                editing={editing}
                signer={(step) => signer(step.signer_emp_id)}
                onAddStep={() => setDialog({ kind: 'addBranchStep', branch })}
                onEditStep={(step) => setDialog({ kind: 'editBranchStep', branch, step })}
                onDeleteStep={(step) => withToast(edit.deleteStep.run(step.id))}
                onSetUp={() => withToast(edit.addBranch.run(branch.unit.id))}
                onDeleteBranch={() => withToast(edit.deleteBranch.run(branch.unit.id))}
              />
            ))}
          </div>
          <MergeBand units={mergeWaitsFor(branches)} />
        </Card>

        <Card style={CARD_STYLE} styles={{ body: CARD_BODY_STYLE }}>
          <SectionHeading title={t('mergedTitle')} hint={editing ? t('dragHint') : t('mergedHint')} />
          <Table<RouteStepRow>
            className="csa-edge-table csa-edge-bottom"
            data-testid="route-steps"
            rowKey="id"
            size="small"
            pagination={false}
            // On a phone the table scrolls sideways in its card rather than squeezing its columns, as the mockup.
            scroll={{ x: TABLE_MIN_WIDTH }}
            dataSource={merged}
            locale={{ emptyText: t('noSteps') }}
            onRow={(row) => (editing ? drag.itemProps(row.id) : {})}
            columns={editing ? editingColumns : columns}
          />
          {editing && (
            <div className="csa-edge-row" style={{ paddingBlock: 10, borderTop: `1px solid ${palette.rowLine}` }}>
              <Button type="dashed" block onClick={() => setDialog({ kind: 'add' })} data-testid="add-step">
                {t('addMergedStep')}
              </Button>
            </div>
          )}
        </Card>
        {dialog?.kind === 'add' && <RouteStepModal steps={merged} onSave={edit.createStep.run} onClose={() => setDialog(null)} />}
        {dialog?.kind === 'edit' && (
          <RouteStepModal
            initial={stepInput(dialog.step)}
            link={dialog.step.link}
            steps={merged}
            onSave={(input) => edit.updateStep.run(dialog.step.id, input)}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'addBranchStep' && (
          <BranchStepModal
            unitName={dialog.branch.unit.name}
            branch={dialog.branch.steps}
            stepCount={steps.length}
            onSave={(input, before) => edit.createStep.run(input, before, dialog.branch.unit.id)}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'editBranchStep' && (
          <BranchStepModal
            unitName={dialog.branch.unit.name}
            branch={dialog.branch.steps}
            stepCount={steps.length}
            step={dialog.step}
            onSave={(input) => edit.updateStep.run(dialog.step.id, input)}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'deleteRoute' && (
          <TypeToDeleteModal
            title={t('deleteRoute.title', { code: template.code, plant: plant.factory_code })}
            warning={t('deleteRoute.warning')}
            details={t('deleteRoute.contents', { count: steps.length })}
            code={template.code}
            onDelete={() => edit.remove.run(template.code)}
            onDeleted={() => navigate(listPathFor('/admin/flows', template.component, plant.factory_code), { replace: true })}
            onClose={() => setDialog(null)}
            describeError={(error) => routeWriteError(t, error)}
            testId="delete-route"
          />
        )}
      </>
    )
  })()

  return (
    <AppShell>
      {holder}
      <Breadcrumb
        items={[
          { title: <Link to={approvalRoute ? listPathFor('/admin/flows', approvalRoute.template.component, approvalRoute.plant.factory_code) : '/admin/flows'}>{t('title')}</Link> },
          { title: approvalRoute ? `${approvalRoute.template.code} × ${approvalRoute.plant.factory_code}` : '…' },
        ]}
      />
      {body}
    </AppShell>
  )
}

function stepInput(step: RouteStepRow): StepInput {
  return { name: step.name, step_group: step.step_group, signer_emp_id: step.signer_emp_id, editable_unit_id: step.editable_unit_id }
}

/** A section card's heading row: its title, and under it what the section is (方向 A, #123). */
function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="csa-edge-row" style={{ paddingBlock: 10, borderBottom: `1px solid ${palette.border}` }}>
      <Typography.Title level={3} style={{ margin: 0, fontSize: textSize(14), fontWeight: 600, lineHeight: 1.5 }}>
        {title}
      </Typography.Title>
      <div style={{ color: palette.textTertiary, fontSize: textSize(13) }}>{hint}</div>
    </div>
  )
}

/**
 * Between the 分流 and the 匯流後 steps: which units the 匯流 waits for, on a dashed line through a diamond (the 匯流's
 * sign, kept in 方向 A as a meaningful drawing).
 */
function MergeBand({ units }: { units: string[] }) {
  const { t } = useTranslation('flows')
  const line = { flex: 1, minWidth: 16, borderTop: `1px dashed ${palette.dashed}` }
  return (
    <Flex align="center" gap={12} style={{ padding: '4px 0 14px', color: palette.textSecondary, fontSize: textSize(13) }} data-testid="merge-band">
      <span aria-hidden style={line} />
      <svg width={28} height={28} viewBox="0 0 28 28" aria-hidden style={{ flex: 'none' }}>
        <path d="M14 1l13 13-13 13L1 14z" fill={palette.selectedBg} stroke={palette.primary} strokeWidth={1.5} />
      </svg>
      <span style={{ textAlign: 'center' }}>
        {units.length ? t('mergeBand', { units: units.join('、'), count: units.length }) : t('mergeBandNone')}
      </span>
      <span aria-hidden style={line} />
    </Flex>
  )
}

/**
 * The live 發起檢查: the same function the 年度發起 runs, read as a computed column. In 方向 A (#123) a white box
 * with 「✓ 發起檢查通過。」 in green; otherwise what is missing on orange: work still to do before it can be launched.
 */
function CheckNote({ problems }: { problems: string[] }) {
  const { t } = useTranslation('flows')
  // role="alert" as antd's Alert had, so a change after an edit is still read out.
  if (!problems.length)
    return (
      <div style={{ ...NOTE_BOX, color: INK.green.color }} role="alert" data-testid="route-check">
        <SymbolMark>✓</SymbolMark>
        {t('ready')}
      </div>
    )
  const ink = INK.orange
  // The whole `border`, not just its colour: React would clear a lone borderColor, and the shorthand's colour with it,
  // once the check passes on the same box.
  return (
    <div style={{ ...NOTE_BOX, background: ink.background, border: `1px solid ${ink.border}` }} role="alert" data-testid="route-check">
      <div style={{ color: ink.color, fontWeight: 500 }}>
        <SymbolMark>!</SymbolMark>
        {t('notReady')}
      </div>
      <ProblemList problems={problems} />
    </div>
  )
}

function ProblemList({ problems, testId }: { problems: string[]; testId?: string }) {
  return (
    <ul style={{ paddingInlineStart: 20, margin: 0 }} data-testid={testId}>
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  )
}
