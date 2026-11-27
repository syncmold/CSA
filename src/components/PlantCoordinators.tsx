import { BankOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Flex, Input, Modal, Popconfirm, Select, Typography, type ButtonProps } from 'antd'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AccessMember } from '../api/access'
import type { Plant } from '../api/plants'
import { accessWriteError, linksTaipeiAudit, mayRunPlant, personLabel, plantById, plantRoster, plantText, type PlantRoster } from '../domain/access'
import { ACCESS_CARD_BODY, ACCESS_CARD_STYLE, INK, palette, PLANT_STRIPE_BG, textSize } from '../theme'

/** One cell; its background, hover and focus come from global.css (.csa-plant-cell). */
/** Cells to a row: every other row is pale grey (使用者 2026-11-23, as the cells before #215). */
const CELLS_PER_ROW = 2

const CELL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
  padding: '4px 10px',
  border: `1px solid ${palette.border}`,
  borderRadius: palette.radius,
  color: palette.text,
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  '--csa-plant-cell-hover': palette.selectedBg,
  '--csa-plant-cell-focus': palette.primary,
} as CSSProperties

/** A line that never wraps: what does not fit ends in 「…」. */
const ONE_LINE: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const CODE_STYLE: CSSProperties = {
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  paddingInline: 5,
  borderRadius: palette.radius,
  background: palette.tableHeaderBg,
  fontWeight: 700,
  fontSize: textSize(12),
  lineHeight: '20px',
}

/**
 * 廠區管理員 (Q116 (5), Q117), the right-hand card of 權限管理's 人員 tab (#215): a pale orange head, a search and a
 * 管理員 filter side by side, then one cell per plant of the master, two to a row, each with the plant over who runs it
 * (or 未指定 in orange). Only the cells scroll; the card takes the height it is given. Clicking a cell assigns, replaces
 * or removes its 廠區管理員. `focus` is the person whose plants alone are shown (picked here or by a name on the left).
 */
export function PlantCoordinators({
  plants,
  members,
  focus,
  onFocus,
  onSet,
  onRemove,
  style,
}: {
  plants: Plant[]
  members: AccessMember[]
  focus: string | null
  onFocus: (empId: string | null) => void
  onSet: (plant: Plant, member: AccessMember) => Promise<unknown>
  onRemove: (plant: Plant) => Promise<unknown>
  style?: CSSProperties
}) {
  const { t } = useTranslation('access')
  const roster = plantRoster(plants, members)
  const missing = roster.filter((r) => !r.coordinator).length
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<PlantRoster | null>(null)
  const focused = members.find((m) => m.emp_id === focus) ?? null
  // Whoever runs a plant, and the person picked on the left even if they run none, so the filter can show them.
  const runners = members.filter((m) => m.coordinator_plant_ids.length > 0 || m.emp_id === focus)
  const q = query.trim().toLowerCase()
  const shown = roster.filter(
    (r) =>
      (!focused || focused.coordinator_plant_ids.includes(r.plant.id)) &&
      (!q || plantText(r.plant).toLowerCase().includes(q)),
  )

  return (
    <Card
      style={{ ...ACCESS_CARD_STYLE, ...style }}
      styles={{ body: ACCESS_CARD_BODY }}
      data-testid="access-plants"
    >
      {/* One line, as tall as the 人員權限 head beside it (使用者 2026-11-23: the heads took room from the lists). */}
      <Flex
        align="center"
        gap={8}
        wrap
        style={{ minHeight: 52, padding: '0 18px', background: INK.orange.background, borderBottom: `1px solid ${INK.orange.border}` }}
      >
        <Typography.Title level={4} style={{ margin: 0, fontSize: textSize(16) }}>
          <BankOutlined style={{ color: INK.orange.color, marginInlineEnd: 8 }} />
          {t('plants.title')}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t('plants.summary', { count: roster.length })}
          {missing > 0 && (
            <>
              {'，'}
              <span style={{ color: INK.orange.color }}>{t('plants.missing', { count: missing })}</span>
            </>
          )}
        </Typography.Text>
      </Flex>
      {/* The search a little wider than the filter, so its placeholder fits. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 6fr) minmax(0, 5fr)', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${palette.border}` }}>
        <Input allowClear placeholder={t('plants.search')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="access-plant-search" />
        <Select<string | null>
          value={focus}
          onChange={onFocus}
          data-testid="access-plant-owner-filter"
          popupMatchSelectWidth={false}
          options={[
            { value: null, label: t('plants.allOwners') },
            ...runners.map((m) => ({ value: m.emp_id, label: t('plants.owner', { name: m.name ?? m.emp_id, count: m.coordinator_plant_ids.length }) })),
          ]}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 14px' }} data-testid="access-plant-cells">
        {shown.length ? (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${CELLS_PER_ROW}, minmax(0, 1fr))`, gap: 6 }}>
            {shown.map((r, i) => (
              <PlantCell key={r.plant.id} roster={r} striped={Math.floor(i / CELLS_PER_ROW) % 2 === 1} onClick={() => setOpen(r)} />
            ))}
          </div>
        ) : (
          <Typography.Text type="secondary" style={{ display: 'block', textAlign: 'center', paddingBlock: 20 }} data-testid="access-plant-empty">
            {focused ? t('plants.noneRun', { name: focused.name ?? focused.emp_id }) : t('plants.noMatch')}
          </Typography.Text>
        )}
      </div>
      {open && (
        <CoordinatorModal roster={open} members={members} plants={plants} onSet={onSet} onRemove={onRemove} onClose={() => setOpen(null)} />
      )}
    </Card>
  )
}

/**
 * A plant over who runs it; its full name and who has it among their 檢視廠區 (Q153) in the tooltip. Each line stays one line: a long code or name ends in
 * 「…」 rather than stretching the cell (使用者 2026-11-23).
 */
/** `striped`: on a row of cells drawn pale grey. */
function PlantCell({ roster: { plant, coordinator, viewers }, striped, onClick }: { roster: PlantRoster; striped: boolean; onClick: () => void }) {
  const { t } = useTranslation('access')
  const viewerText = t('plants.viewers', { names: viewers.length ? viewers.map((v) => v.name ?? v.emp_id).join('、') : '—' })
  return (
    <button
      type="button"
      className="csa-plant-cell"
      onClick={onClick}
      title={`${plantText(plant)}\n${viewerText}\n${t('plants.clickHint')}`}
      data-testid={`access-plant-${plant.factory_code}`}
      style={{ ...CELL_STYLE, '--csa-plant-cell-bg': striped ? PLANT_STRIPE_BG : palette.surface } as CSSProperties}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ ...CODE_STYLE, background: striped ? palette.surface : palette.tableHeaderBg }}>{plant.factory_code}</span>
        <span style={{ ...ONE_LINE, flex: '1 1 0', fontSize: textSize(12), lineHeight: '20px', color: palette.textSecondary }}>{plant.name}</span>
      </span>
      <span style={{ ...ONE_LINE, color: coordinator ? undefined : INK.orange.color, lineHeight: '20px' }} data-testid="access-plant-coordinator">
        {coordinator ? (coordinator.name ?? coordinator.emp_id) : t('plants.none')}
      </span>
    </button>
  )
}

/** 指定／更換／移除 one plant's 廠區負責人. Picks from the 放行名單, this plant's own people first. Mount only while open. */
function CoordinatorModal({
  roster: { plant, coordinator },
  members,
  plants,
  onSet,
  onRemove,
  onClose,
}: {
  roster: PlantRoster
  members: AccessMember[]
  plants: Plant[]
  onSet: (plant: Plant, member: AccessMember) => Promise<unknown>
  onRemove: (plant: Plant) => Promise<unknown>
  onClose: () => void
}) {
  const { t } = useTranslation('access')
  const [picked, setPicked] = useState<string | null>(coordinator?.emp_id ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = members.find((m) => m.emp_id === picked) ?? null
  const replacing = !!coordinator && !!chosen && chosen.emp_id !== coordinator.emp_id

  const runs = (m: AccessMember) => m.coordinator_plant_ids.flatMap((id) => plantById(id, plants)?.factory_code ?? [])
  const option = (m: AccessMember) => {
    const label = personLabel(m.emp_id, m.name)
    const others = runs(m)
    return {
      value: m.emp_id,
      label,
      search: `${m.emp_id} ${m.name ?? ''}`,
      title: label,
      render: (
        <span>
          {label}
          {others.length > 0 && (
            <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>{t('coordinator.runs', { plants: others.join('、') })}</Typography.Text>
          )}
        </span>
      ),
    }
  }
  // A 系統維護員 runs no plant: they already assign at every plant (Q129); the database refuses one too.
  // 稽核人員 and the 稽核主管 come first (#187, Q140): they are who runs a plant for the audit office, and their plant links the
  // Taipei 稽核人員 step of its routes. Anyone else may run it too, but then that step is not linked.
  const candidates = members.filter(mayRunPlant)
  const staff = candidates.filter((m) => linksTaipeiAudit(m.audit_role))
  const rest = candidates.filter((m) => !linksTaipeiAudit(m.audit_role))
  const own = rest.filter((m) => m.factory_code === plant.factory_code)
  const others = rest.filter((m) => m.factory_code !== plant.factory_code)
  const notLinked = !!chosen && chosen.emp_id !== coordinator?.emp_id && !linksTaipeiAudit(chosen.audit_role)
  // 稽核主管當廠區管理員：台北稽核人員也連動他，兩關同一人（Q140）。
  const chiefBoth = !!chosen && chosen.emp_id !== coordinator?.emp_id && chosen.audit_role === 'audit_admin'

  const act = async (write: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await write()
      onClose()
    } catch (e) {
      setError(accessWriteError(t, e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title={t(coordinator ? 'coordinator.replaceTitle' : 'coordinator.assignTitle', { plant: plantText(plant) })}
      onCancel={onClose}
      data-testid="access-coordinator-modal"
      footer={
        <Flex justify="space-between" gap={8}>
          <span>
            {coordinator && (
              <Popconfirm
                title={t('coordinator.removeConfirm', { plant: plantText(plant), name: personLabel(coordinator.emp_id, coordinator.name) })}
                onConfirm={() => act(() => onRemove(plant))}
                okButtonProps={{ danger: true, 'data-testid': 'access-coordinator-remove-ok' } as ButtonProps}
              >
                <Button danger disabled={busy} data-testid="access-coordinator-remove">{t('coordinator.remove')}</Button>
              </Popconfirm>
            )}
          </span>
          <Flex gap={8}>
            <Button onClick={onClose}>{t('coordinator.cancel')}</Button>
            <Button
              type="primary"
              loading={busy}
              disabled={!chosen || chosen.emp_id === coordinator?.emp_id}
              onClick={() => chosen && act(() => onSet(plant, chosen))}
              data-testid="access-coordinator-ok"
            >
              {t(coordinator ? 'coordinator.replaceOk' : 'coordinator.assignOk')}
            </Button>
          </Flex>
        </Flex>
      }
    >
      <Flex vertical gap={12}>
        <Flex vertical gap={4}>
          <Typography.Text type="secondary">{t('coordinator.pick')}</Typography.Text>
          <Select<string>
            showSearch
            value={picked ?? undefined}
            onChange={setPicked}
            placeholder={t('coordinator.pickPlaceholder')}
            optionFilterProp="search"
            optionRender={(o) => (o.data as { render?: ReactNode }).render ?? o.label}
            options={[
              { label: t('coordinator.staffGroup'), options: staff.map(option) },
              { label: t('coordinator.samePlant', { code: plant.factory_code }), options: own.map(option) },
              { label: t('coordinator.otherPlants'), options: others.map(option) },
            ].filter((g) => g.options.length)}
            data-testid="access-coordinator-pick"
          />
        </Flex>
        {notLinked && <Alert type="info" showIcon title={t('coordinator.notLinked')} data-testid="access-coordinator-not-linked" />}
        {chiefBoth && <Alert type="info" showIcon title={t('coordinator.chiefBoth')} data-testid="access-coordinator-chief-both" />}
        {replacing && (
          <Alert
            type="warning"
            showIcon
            title={t('coordinator.replaceWarning', { name: personLabel(coordinator.emp_id, coordinator.name), plant: plantText(plant) })}
          />
        )}
        {error && <Alert type="error" showIcon title={error} />}
      </Flex>
    </Modal>
  )
}
