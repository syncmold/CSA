import { TeamOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Flex, Input, Select, Table, Typography } from 'antd'
import dayjs from 'dayjs'
import type { TFunction } from 'i18next'
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ADMIN_EMP_ID } from '../../exchange/adminAccount'
import { CHANGE_LOG_LIMIT, type AccessMember, type AccessSettings, type ChangeLogRow } from '../api/access'
import type { ChangeAction } from '../api/accessModel'
import type { AuditRole } from '../api/employee'
import type { Plant } from '../api/plants'
import { useAuth } from '../auth/AuthContext'
import { AccessGuide, IdentityTag } from '../components/AccessGuide'
import { AddMembersModal, EditMemberModal, PlantRightsModal, RemoveMemberModal } from '../components/AccessModals'
import { AppShell } from '../components/AppShell'
import { EdgeTabs } from '../components/EdgeTabs'
import { PageHeader } from '../components/PageHeader'
import { PlantCoordinators } from '../components/PlantCoordinators'
import { NO_WRAP } from '../components/tableColumns'
import { useFillToBottom } from '../components/useFillToBottom'
import { useWriteToast } from '../components/useWriteToast'
import {
  accessWriteError, admitsPeople, assignableRoles, AUDIT_ROLES, CHANGE_ACTIONS, changeText, filterLog, filterMembers, mayEditPlantRights, personLabel, plantText,
} from '../domain/access'
import { errorText } from '../domain/errors'
import { listLoading } from '../domain/lists'
import { useAccessEditing, useAccessMembers, useChangeLog } from '../hooks/useAccess'
import { useExchangeStatus } from '../hooks/useExchangeStatus'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useMyAuditRole } from '../hooks/useMyAuditRole'
import { usePlants } from '../hooks/usePlants'
import { ACCESS_CARD_BODY, ACCESS_CARD_STYLE, CARD_BODY_STYLE, LINK_BUTTON, LIST_CARD_STYLE, palette, textSize } from '../theme'

const at = (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm')

/** A tab's toolbar (方向 A, #127): across the card, a line under it. */
const TOOLBAR_STYLE: CSSProperties = { paddingBlock: 12, borderBottom: `1px solid ${palette.border}` }
/** What follows a tab's table (方向 A, #127): across the card, a line over it (the table's last row draws none). */
const AFTER_TABLE_STYLE: CSSProperties = { paddingBlock: '12px 16px', borderTop: `1px solid ${palette.border}` }

/** From this width the two cards of 人員 sit side by side and fill the window, each list scrolling on its own (#215). */
const SIDE_BY_SIDE = '(min-width: 900px)'
/** The right-hand card's width. */
const PLANTS_WIDTH = 430
/** Below this the cards stop shrinking with the window and the page scrolls instead. */
const MIN_CARDS_HEIGHT = 420
/** Stacked, the page scrolls again and each card stops at this, its list scrolling inside it. */
const STACKED_HEIGHT: CSSProperties = { maxHeight: '75vh' }
/** Side by side or stacked, the 人員 table's least width; narrower, it scrolls sideways inside its card. */
const TABLE_MIN_WIDTH = 720

/**
 * 權限管理 (#58, Q98; three tabs since Q117): 人員 (the 放行名單 with each person's role and plants, and each plant's
 * 廠區管理員), 異動紀錄, and 權限說明. Not hidden behind a front-end role check (same as the other /admin pages):
 * anyone else gets empty lists from RLS and refused writes. #215: the tabs sit on the page; 人員 is two cards side by
 * side, the other two one card each.
 */
export function AccessPage() {
  const { t } = useTranslation('access')
  // Same switch the login page reads: with 放行全開 (Q62) the list admits nobody extra and refuses nobody.
  const exchangeStatus = useExchangeStatus()
  const plants = usePlants()
  // Both lists name plants, so they wait for the plant master instead of showing ids meanwhile; without it they show ids.
  const master = plants.isError ? [] : plants.data

  return (
    <AppShell>
      {/* No grey line under the title (使用者 2026-11-23): the lists get the room; 權限說明 says what the page is for. */}
      <PageHeader title={t('title')} />
      {exchangeStatus.data?.accessAll && <Alert type="warning" showIcon title={t('accessAllWarning')} data-testid="access-all-warning" />}
      {plants.isError && <Alert type="warning" showIcon title={errorText(plants.error)} />}
      <EdgeTabs
        items={[
          { key: 'members', label: t('tabs.members'), children: <MembersTab master={master} /> },
          { key: 'log', label: t('tabs.log'), children: <TabCard><ChangeLogTab master={master} /></TabCard> },
          { key: 'guide', label: t('tabs.guide'), children: <TabCard><AccessGuide /></TabCard> },
        ]}
      />
    </AppShell>
  )
}

/** 異動紀錄 and 權限說明: one card under the tabs, its tables running to its edges (方向 A, #127). */
function TabCard({ children }: { children: ReactNode }) {
  return (
    <Card style={{ ...LIST_CARD_STYLE, marginTop: 12 }} styles={{ body: CARD_BODY_STYLE }}>
      {children}
    </Card>
  )
}

type Dialog = { kind: 'add' } | { kind: 'edit' | 'rights' | 'remove'; member: AccessMember } | null

/** `master` is the plant master, undefined while it loads. */
function MembersTab({ master }: { master: Plant[] | undefined }) {
  const { t } = useTranslation('access')
  const { session } = useAuth()
  const members = useAccessMembers()
  const plants = master ?? []
  const loading = listLoading(members) || !master
  const edit = useAccessEditing()
  const { holder, messageApi } = useWriteToast((e) => accessWriteError(t, e))
  // Who may give which role and edit whom (Q122 (3)): for showing and hiding only, the database decides.
  const myRole = useMyAuditRole().data
  const roles = assignableRoles(myRole)
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<AuditRole | null>(null)
  /** Only those who see this plant's 自評表: its 檢視者, its 廠區管理員, every 稽核主管 and 系統維護員. */
  const [plantId, setPlantId] = useState<string | null>(null)
  /** The person whose plants alone the right-hand card shows: picked by name here or in its 管理員 filter. */
  const [focus, setFocus] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const sideBySide = useMediaQuery(SIDE_BY_SIDE)
  const fill = useFillToBottom<HTMLDivElement>()
  const height = sideBySide ? Math.max(MIN_CARDS_HEIGHT, fill.style.minHeight ?? 0) : undefined
  const all = useMemo(() => members.data ?? [], [members.data])
  const shown = useMemo(() => filterMembers(all, { query, identity: role, plantId }), [all, query, role, plantId])
  const saveSettings = async (member: AccessMember, settings: AccessSettings) => {
    await edit.update.run(member.emp_id, settings)
    messageApi.success(t('saved'))
  }

  const peopleCard = (
    <Card
      style={{ ...ACCESS_CARD_STYLE, ...(height ? { height } : STACKED_HEIGHT) }}
      styles={{ body: ACCESS_CARD_BODY }}
      data-testid="access-people"
    >
      {/* One row (使用者 2026-11-23: the heads took room from the lists): the title and count, the search and the role, 加入人員. */}
      <Flex align="center" gap="8px 12px" wrap style={{ padding: '10px 20px' }}>
        <Flex align="baseline" gap={8} style={{ flex: 'none' }}>
          <Typography.Title level={4} style={{ margin: 0, fontSize: textSize(16) }}>
            <TeamOutlined style={{ color: palette.primary, marginInlineEnd: 8 }} />
            {t('people.title')}
          </Typography.Title>
          {members.data && <Typography.Text type="secondary">{t('count', { count: all.length })}</Typography.Text>}
        </Flex>
        <Input allowClear placeholder={t('search')} onChange={(e) => setQuery(e.target.value)} style={{ flex: '1 1 160px', minWidth: 0 }} data-testid="access-search" />
        <Select<AuditRole | null>
          value={role}
          onChange={setRole}
          style={{ width: 140 }}
          data-testid="access-role-filter"
          options={[{ value: null, label: t('allRoles') }, ...AUDIT_ROLES.map((r) => ({ value: r, label: t(`role.${r}`) }))]}
        />
        <Select<string | null>
          value={plantId}
          onChange={setPlantId}
          style={{ width: 170 }}
          showSearch
          optionFilterProp="label"
          popupMatchSelectWidth={false}
          data-testid="access-plant-filter"
          options={[{ value: null, label: t('allPlants') }, ...plants.map((p) => ({ value: p.id, label: plantText(p) }))]}
        />
        {/* Only a 系統維護員 lets people in (Q150); waits for the role, which decides the roles the dialog offers. */}
        {admitsPeople(myRole) && (
          <Button type="primary" onClick={() => setDialog({ kind: 'add' })} data-testid="access-add">
            {t('add')}
          </Button>
        )}
      </Flex>
      {members.isError ? (
        <Alert type="warning" showIcon title={errorText(members.error)} style={{ margin: '0 20px 16px' }} />
      ) : (
        <div
          className="csa-access-scroll"
          style={{ flex: 1, minHeight: 0, overflow: 'auto', borderTop: `1px solid ${palette.border}`, '--csa-focus-bg': palette.selectedBg } as CSSProperties}
        >
          <Table<AccessMember>
            data-testid="access-members"
            rowKey="emp_id"
            size="small"
            loading={loading}
            dataSource={master ? shown : []}
            pagination={false}
            style={{ minWidth: TABLE_MIN_WIDTH }}
            locale={{ emptyText: loading ? null : t('empty') }}
            rowClassName={(m) => (m.emp_id === focus ? 'csa-access-focus' : '')}
            onRow={(m) => ({ 'data-testid': `access-member-${m.emp_id}` }) as object}
            columns={[
              { title: t('column.plant'), dataIndex: 'factory_code', width: 80, render: (v: string | null) => <Typography.Text strong>{v ?? '—'}</Typography.Text> },
              {
                title: t('column.empId'),
                dataIndex: 'emp_id',
                width: 110,
                sorter: (a, b) => a.emp_id.localeCompare(b.emp_id),
                defaultSortOrder: 'ascend',
              },
              {
                title: t('column.name'),
                key: 'name',
                sorter: (a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'zh-Hant'),
                render: (_, m) => (
                  <Flex vertical>
                    <span>
                      <Button
                        size="small"
                        type="link"
                        style={{ ...LINK_BUTTON, color: palette.text, fontSize: 'inherit' }}
                        onClick={() => setFocus(focus === m.emp_id ? null : m.emp_id)}
                        aria-pressed={focus === m.emp_id}
                        data-testid="access-member-name"
                      >
                        {m.name ?? <Typography.Text type="secondary">{t('unknownName')}</Typography.Text>}
                      </Button>
                    </span>
                    {m.note && <Typography.Text type="secondary" style={{ fontSize: textSize(12) }}>{m.note}</Typography.Text>}
                  </Flex>
                ),
              },
              {
                title: t('column.role'),
                key: 'role',
                width: 130,
                render: (_, m) => <IdentityTag identity={m.audit_role} testId="access-member-role">{t(`role.${m.audit_role}`)}</IdentityTag>,
              },
              {
                title: t('column.plantRights'),
                key: 'rights',
                width: 110,
                render: (_, m) =>
                  mayEditPlantRights(myRole, m) && (
                    <Button size="small" onClick={() => setDialog({ kind: 'rights', member: m })} data-testid="access-plant-rights">
                      {t('plantRights')}
                    </Button>
                  ),
              },
              {
                title: t('column.lastLogin'),
                dataIndex: 'last_login_at',
                width: 160,
                // One line, also when the scrollbar takes its width from the table.
                onCell: () => ({ style: { whiteSpace: 'nowrap' } }),
                sorter: (a, b) => (a.last_login_at ?? '').localeCompare(b.last_login_at ?? ''),
                render: (v: string | null) => (v ? at(v) : <Typography.Text type="secondary">{t('neverLoggedIn')}</Typography.Text>),
              },
              {
                title: t('column.actions'),
                key: 'actions',
                width: 70,
                // Only for a 系統維護員: a 稽核主管 sees the people but sets no role, 檢視廠區 or 備註 (Q150). 移除 is in 編輯 (#215).
                render: (_, m) =>
                  admitsPeople(myRole) && (
                    <Button size="small" type="link" style={LINK_BUTTON} onClick={() => setDialog({ kind: 'edit', member: m })} data-testid="access-edit">
                      {t('edit')}
                    </Button>
                  ),
              },
            ]}
          />
        </div>
      )}
      <Flex justify="space-between" gap={12} style={{ padding: '10px 20px', borderTop: `1px solid ${palette.border}`, color: palette.textTertiary, fontSize: textSize(13) }}>
        <span>{t('people.footHint')}</span>
        {members.data && master && <span>{t('people.shown', { shown: shown.length, count: all.length })}</span>}
      </Flex>
    </Card>
  )

  return (
    <Flex vertical style={{ marginTop: 12 }}>
      {holder}
      <div
        ref={fill.ref}
        style={{ display: 'grid', gridTemplateColumns: sideBySide ? `minmax(0, 1fr) ${PLANTS_WIDTH}px` : 'minmax(0, 1fr)', gap: 20, alignItems: 'start' }}
      >
        {peopleCard}
        {members.data && master ? (
          <PlantCoordinators
            plants={plants}
            members={members.data}
            focus={focus}
            onFocus={setFocus}
            style={height ? { height } : STACKED_HEIGHT}
            onSet={async (plant, member) => {
              await edit.setCoordinator.run(plant.id, member.emp_id)
              messageApi.success(t('coordinator.saved', { name: personLabel(member.emp_id, member.name), plant: plantText(plant) }))
            }}
            onRemove={async (plant) => {
              await edit.removeCoordinator.run(plant.id)
              messageApi.success(t('coordinator.removed', { plant: plantText(plant) }))
            }}
          />
        ) : (
          <Card loading style={height ? { height } : undefined} />
        )}
      </div>
      {dialog?.kind === 'add' && (
        <AddMembersModal
          roles={roles}
          plants={plants}
          members={all}
          onAdd={async (people, settings) => {
            const result = await edit.add.run(people, settings)
            const skipped = result.skipped.length ? t('skipped', { count: result.skipped.length, ids: result.skipped.join('、') }) : ''
            messageApi.success(t('added', { added: result.added.length }) + skipped)
            return result
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EditMemberModal
          roles={roles}
          member={dialog.member}
          plants={plants}
          created={{
            added: t('source.added', {
              at: dayjs(dialog.member.added_at).format('YYYY-MM-DD'),
              by: operatorText(t, dialog.member.added_by_emp_id, dialog.member.added_by_name ?? dialog.member.added_by_emp_id ?? ''),
            }),
            lastLogin: dialog.member.last_login_at ? at(dialog.member.last_login_at) : t('neverLoggedIn'),
          }}
          onSave={(settings) => saveSettings(dialog.member, settings)}
          onRemove={() => setDialog({ kind: 'remove', member: dialog.member })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rights' && (
        <PlantRightsModal
          member={dialog.member}
          members={all}
          plants={plants}
          onSave={(settings) => saveSettings(dialog.member, settings)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'remove' && (
        <RemoveMemberModal
          member={dialog.member}
          plants={plants}
          isSelf={dialog.member.emp_id === session?.employee.emp_id}
          onRemove={async () => {
            await edit.remove.run(dialog.member.emp_id)
            if (focus === dialog.member.emp_id) setFocus(null)
            messageApi.success(t('removed', { name: personLabel(dialog.member.emp_id, dialog.member.name) }))
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </Flex>
  )
}

function ChangeLogTab({ master }: { master: Plant[] | undefined }) {
  const { t } = useTranslation('access')
  const log = useChangeLog()
  const plants = master ?? []
  const loading = listLoading(log) || !master
  const [query, setQuery] = useState('')
  const [action, setAction] = useState<ChangeAction | null>(null)
  const shown = useMemo(() => filterLog(log.data ?? [], { query, action }), [log.data, query, action])

  return log.isError ? (
    <Alert type="warning" showIcon title={errorText(log.error)} style={{ marginBlock: 16 }} />
  ) : (
    <Flex vertical>
      <Flex className="csa-edge-row" gap="10px 16px" wrap align="center" style={TOOLBAR_STYLE}>
        <Input.Search allowClear placeholder={t('log.search')} onChange={(e) => setQuery(e.target.value)} style={{ width: 220 }} data-testid="access-log-search" />
        <Select<ChangeAction | null>
          value={action}
          onChange={setAction}
          style={{ width: 180 }}
          data-testid="access-log-action"
          options={[{ value: null, label: t('log.allActions') }, ...CHANGE_ACTIONS.map((a) => ({ value: a, label: t(`log.action.${a}`) }))]}
        />
        <Typography.Text type="secondary">{t('log.limit', { count: CHANGE_LOG_LIMIT })}</Typography.Text>
      </Flex>
      <Table<ChangeLogRow>
        className="csa-edge-table csa-edge-bottom"
        data-testid="access-log"
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={master ? shown : []}
        pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
        locale={{ emptyText: loading ? null : t('log.empty') }}
        columns={[
          { title: t('log.time'), dataIndex: 'changed_at', render: at, ...NO_WRAP },
          {
            title: t('log.actor'),
            key: 'actor',
            ...NO_WRAP,
            render: (_, r) =>
              r.actor_emp_id ? (
                operatorText(t, r.actor_emp_id, personLabel(r.actor_emp_id, r.actor_name))
              ) : (
                <Typography.Text type="secondary">{t('byCommand')}</Typography.Text>
              ),
          },
          { title: t('log.target'), key: 'target', ...NO_WRAP, render: (_, r) => personLabel(r.target_emp_id, r.target_name) },
          {
            title: t('log.content'),
            key: 'content',
            render: (_, r) => {
              const c = changeText(r, t, plants)
              return (
                <span data-testid="access-log-content">
                  <Typography.Text strong>{c.action}</Typography.Text>
                  {'　'}
                  {c.before && c.after ? `${c.before} → ${c.after}` : c.before || c.after}
                </span>
              )
            },
          },
        ]}
      />
      <Typography.Text className="csa-edge-row" type="secondary" style={AFTER_TABLE_STYLE}>{t('log.footnote')}</Typography.Text>
    </Flex>
  )
}

/**
 * Who made a change, as 加入者 and the log's 操作者 show it: `person` for an employee, 管理員帳號 for the 管理員帳號
 * (#161, which has no name of its own), 部署指令 when there is no 工號 (the command or db:set-role).
 */
function operatorText(t: TFunction<'access'>, empId: string | null, person: string): string {
  if (empId === ADMIN_EMP_ID) return t('byAdminAccount')
  return empId ? person : t('byCommand')
}
