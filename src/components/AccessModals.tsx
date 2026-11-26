import {
  Alert, Button, Checkbox, Collapse, Descriptions, Flex, Form, Input, List, Modal, Radio, Select, Space, Spin, Tag, Typography, type ButtonProps,
} from 'antd'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AccessMember, AccessSettings, AddResult } from '../api/access'
import type { AuditRole } from '../api/employee'
import type { Plant } from '../api/plants'
import type { PickerRow } from '../../exchange/core'
import {
  accessWriteError, defaultViewerPlants, groupImpact, linksTaipeiAudit, mayRunPlant, parseEmpIds, personLabel, planAdd, plantChanges, plantLabelById, plantText,
  takeovers,
} from '../domain/access'
import { palette, textSize } from '../theme'
import { errorText } from '../domain/errors'
import { useDebounced } from '../hooks/useDebounced'
import { useRemovalImpact } from '../hooks/useAccess'
import { PeopleLookupError } from '../api/people'
import { usePeopleLookup } from '../hooks/useEmployeeSearch'
import { FormModal } from './TemplateEditModals'

interface SettingsValues {
  role: AuditRole
  viewer_plant_ids?: string[]
  note?: string
}

const toSettings = (v: SettingsValues): AccessSettings => ({
  role: v.role,
  viewerPlantIds: v.role === 'viewer' ? (v.viewer_plant_ids ?? []) : [],
  note: (v.note ?? '').trim(),
})

/**
 * 角色 (the `roles` the signed-in person may give, with what each may do), 檢視廠區 (only for 檢視者) and 備註: shared
 * by 加入 and 編輯. 編輯 asks for 檢視廠區 only when it makes someone a 檢視者 (`askViewerPlants`): a 檢視者's plants are
 * changed in 廠區權限 (#215). For a 系統維護員, who runs no plant, 編輯 says what they step down from (`stepsDown`).
 */
function SettingsFields({
  roles,
  plants,
  defaultPlants,
  stepsDown,
  askViewerPlants = true,
  batchSize = 1,
}: {
  roles: readonly AuditRole[]
  plants: Plant[]
  defaultPlants: string[]
  stepsDown?: ReactNode
  askViewerPlants?: boolean
  /** 加入 only: how many people this batch adds, since there is exactly one 稽核主管 (#187). */
  batchSize?: number
}) {
  const { t } = useTranslation('access')
  const form = Form.useFormInstance<SettingsValues>()
  const role = Form.useWatch('role', form)
  // Q98 (6): a 檢視者 starts with their own OMS 廠區 — also when the OMS lookup answers after 檢視者 was picked.
  const defaultKey = defaultPlants.join(',')
  useEffect(() => {
    if (role === 'viewer' && defaultPlants.length && !(form.getFieldValue('viewer_plant_ids') ?? []).length) {
      form.setFieldValue('viewer_plant_ids', defaultPlants)
    }
  }, [role, defaultKey, form]) // defaultKey stands for defaultPlants, a new array every render
  return (
    <>
      <Form.Item name="role" label={t('form.role')} rules={[{ required: true }]}>
        <Radio.Group data-testid="access-role">
          <Space direction="vertical">
            {roles.map((r) => (
              <Radio key={r} value={r} data-testid={`access-role-${r}`}>
                {t(`role.${r}`)}
                <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>
                  {t(`roleHint.${r}`)}
                </Typography.Text>
              </Radio>
            ))}
          </Space>
        </Radio.Group>
      </Form.Item>
      {role === 'audit_admin' && batchSize > 1 && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} data-testid="access-single-admin" title={t('errors.singleAdmin')} />
      )}
      {role === 'viewer' && askViewerPlants && (
        <Form.Item
          name="viewer_plant_ids"
          label={t('form.viewerPlants')}
          extra={t('form.viewerPlantsHint')}
          rules={[{ required: true, type: 'array', min: 1, message: t('form.viewerPlantsRequired') }]}
        >
          <Select
            mode="multiple"
            data-testid="access-viewer-plants"
            optionFilterProp="label"
            options={plants.map((p) => ({ value: p.id, label: plantText(p) }))}
          />
        </Form.Item>
      )}
      {role === 'system_maintainer' && stepsDown}
      <Form.Item name="note" label={t('form.note')}>
        <Input placeholder={t('form.notePlaceholder')} maxLength={200} data-testid="access-note" />
      </Form.Item>
    </>
  )
}

/**
 * 加入 (Q98 (3)): paste several complete 工號; each shows its OMS 姓名 and 廠區, or why it will not be added (#218: asked
 * of OMS through the CSA backend, which only answers people who manage people). One role,
 * 檢視廠區 and 備註 for the whole batch. Mount only while open.
 */
export function AddMembersModal({
  roles,
  plants,
  members,
  onAdd,
  onClose,
}: {
  /** The roles the signed-in person may give (assignableRoles). */
  roles: readonly AuditRole[]
  plants: Plant[]
  members: AccessMember[]
  onAdd: (people: PickerRow[], settings: AccessSettings) => Promise<AddResult>
  onClose: () => void
}) {
  const { t } = useTranslation('access')
  const [text, setText] = useState('')
  const typed = useMemo(() => parseEmpIds(text), [text])
  // Each 工號 asked counts against OMS's daily limit: wait long enough to finish typing or pasting.
  const empIds = useDebounced(typed, 600)
  const picker = usePeopleLookup(empIds)
  const plan = useMemo(() => (picker.data ? planAdd(empIds, picker.data, members) : []), [empIds, picker.data, members])
  const lookupError = picker.error instanceof PeopleLookupError
    ? t([`plan.lookupErrors.${picker.error.message}`, 'plan.lookupErrors.other'], { code: picker.error.message })
    : errorText(picker.error)
  /** The list below is still for an earlier text, or OMS has not answered yet. */
  const catchingUp = typed.join(',') !== empIds.join(',') || (empIds.length > 0 && picker.isFetching)
  const toAdd = plan.flatMap((p) => (p.status === 'add' ? [p.person] : []))
  const defaultPlants = defaultViewerPlants(toAdd, plants)

  return (
    <FormModal<SettingsValues>
      title={t('addTitle')}
      testId="access-add-modal"
      okText={t('addOk', { count: toAdd.length })}
      initialValues={{ role: 'signer' }}
      errorOverrides={(e) => accessWriteError(t, e)}
      onSave={async (v) => {
        if (catchingUp) throw new Error(t('plan.stillLooking'))
        if (!toAdd.length) throw new Error(t('plan.nothingToAdd'))
        // There is exactly one 稽核主管 (#187); the database refuses a batch of them too.
        if (v.role === 'audit_admin' && toAdd.length > 1) throw new Error(t('errors.singleAdmin'))
        await onAdd(toAdd, toSettings(v))
      }}
      onClose={onClose}
    >
      <Form.Item label={t('form.empIds')} required extra={t('form.batchShared')}>
        <Input.TextArea
          autoSize={{ minRows: 2, maxRows: 6 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('form.empIdsPlaceholder')}
          data-testid="access-emp-ids"
        />
      </Form.Item>
      {empIds.length > 0 &&
        (picker.isError ? (
          <Alert type="error" showIcon title={t('plan.lookupFailed', { message: lookupError })} style={{ marginBottom: 16 }} data-testid="access-lookup-error" />
        ) : picker.isLoading ? (
          <Spin size="small" tip={t('plan.looking')} style={{ display: 'block', marginBottom: 16 }} />
        ) : (
          <List
            size="small"
            bordered
            style={{ marginBottom: 16 }}
            data-testid="access-add-plan"
            dataSource={plan}
            renderItem={(p) => (
              <List.Item data-testid={`access-plan-${p.empId}`}>
                <Space wrap>
                  <Typography.Text strong>{p.empId}</Typography.Text>
                  {'person' in p && p.person && (
                    <span>
                      {p.person.name} <Tag>{p.person.factory_code}</Tag>
                    </span>
                  )}
                  <Typography.Text type={p.status === 'add' ? 'success' : p.status === 'already_listed' ? 'secondary' : 'danger'}>
                    {t(`plan.${p.status}`)}
                  </Typography.Text>
                  {p.status === 'add' && p.noCsa && <Typography.Text type="warning">{t('plan.noCsa')}</Typography.Text>}
                </Space>
              </List.Item>
            )}
          />
        ))}
      <SettingsFields roles={roles} plants={plants} defaultPlants={defaultPlants} batchSize={toAdd.length} />
    </FormModal>
  )
}

/**
 * 編輯 one person's 角色 and 備註 (#215: their plants are in 廠區權限), with 建立資訊 folded away and 從名單移除 at the
 * foot. Mount only while open.
 */
export function EditMemberModal({
  roles,
  member,
  plants,
  created,
  onSave,
  onRemove,
  onClose,
}: {
  /** The roles the signed-in person may give (assignableRoles). */
  roles: readonly AuditRole[]
  member: AccessMember
  plants: Plant[]
  /** 加入名單 and 最後登入, in the page's words. */
  created: { added: string; lastLogin: string }
  onSave: (settings: AccessSettings) => Promise<unknown>
  /** Opens 移除 (RemoveMemberModal) in this dialog's place. */
  onRemove: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('access')
  const wasViewer = member.audit_role === 'viewer'
  return (
    <FormModal<SettingsValues>
      title={t('editTitle', { name: personLabel(member.emp_id, member.name) })}
      testId="access-edit-modal"
      initialValues={{ role: member.audit_role, viewer_plant_ids: member.viewer_plant_ids, note: member.note ?? '' }}
      errorOverrides={(e) => accessWriteError(t, e)}
      footerStart={
        <Button type="link" danger style={{ paddingInline: 0 }} onClick={onRemove} data-testid="access-remove">
          {t('removeFromList')}
        </Button>
      }
      onSave={(v) => {
        const settings = toSettings(v)
        // Still a 檢視者: the dialog does not ask for the plants, which stay as they are.
        return onSave(wasViewer && v.role === 'viewer' ? { ...settings, viewerPlantIds: member.viewer_plant_ids } : settings)
      }}
      onClose={onClose}
    >
      <SettingsFields
        roles={roles}
        plants={plants}
        askViewerPlants={!wasViewer}
        defaultPlants={member.factory_code ? defaultViewerPlants([{ factory_code: member.factory_code }], plants) : []}
        stepsDown={
          member.coordinator_plant_ids.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              data-testid="access-maintainer-steps-down"
              title={t('form.maintainerStepsDown', { plants: member.coordinator_plant_ids.map((id) => plantLabelById(id, plants)).join('、') })}
            />
          )
        }
      />
      <Collapse
        ghost
        size="small"
        data-testid="access-created"
        items={[
          {
            key: 'created',
            label: t('created.title'),
            children: (
              <Descriptions size="small" column={1}>
                <Descriptions.Item label={t('created.added')}>{created.added}</Descriptions.Item>
                <Descriptions.Item label={t('created.lastLogin')}>{created.lastLogin}</Descriptions.Item>
              </Descriptions>
            ),
          },
        ]}
      />
    </FormModal>
  )
}

interface PlantRightsValues {
  plant_ids: string[]
}

/**
 * 廠區權限 (#215): one person's plants, by role. A 檢視者 picks the plants they view (at least one); anyone else who may
 * run a plant picks the plants they run as 廠區管理員, a plant someone else runs being handed over on save; a 系統維護員
 * sees every plant and runs none, so the boxes are all ticked and fixed. A 檢視者 who also runs a plant has it set from
 * the plant's cell on the right. Mount only while open.
 */
export function PlantRightsModal({
  member,
  members,
  plants,
  onSave,
  onClose,
}: {
  member: AccessMember
  /** Everyone on the list, to say who runs each plant now. */
  members: AccessMember[]
  plants: Plant[]
  onSave: (settings: AccessSettings) => Promise<unknown>
  onClose: () => void
}) {
  const { t } = useTranslation('access')
  const mode: 'view' | 'run' | 'fixed' = member.audit_role === 'viewer' ? 'view' : mayRunPlant(member) ? 'run' : 'fixed'
  const before = mode === 'view' ? member.viewer_plant_ids : member.coordinator_plant_ids
  const header = (
    <Flex justify="space-between" wrap gap="4px 12px" style={{ paddingBottom: 10, marginBottom: 12, borderBottom: `1px solid ${palette.border}` }}>
      <Typography.Text strong>{personLabel(member.emp_id, member.name)}</Typography.Text>
      <Typography.Text type="secondary">
        {t('rights.who', { plant: member.factory_code ?? '—', role: t(`role.${member.audit_role}`) })}
      </Typography.Text>
    </Flex>
  )

  if (mode === 'fixed') {
    return (
      <Modal
        open
        title={t('rights.title')}
        onCancel={onClose}
        width={640}
        data-testid="access-rights-modal"
        footer={<Button onClick={onClose}>{t('rights.close')}</Button>}
      >
        {header}
        <Alert type="info" showIcon style={{ marginBottom: 12 }} title={t('rights.fixed')} data-testid="access-rights-mode" />
        <PlantBoxes plants={plants} value={plants.map((p) => p.id)} disabled />
      </Modal>
    )
  }

  return (
    <FormModal<PlantRightsValues>
      title={t('rights.title')}
      testId="access-rights-modal"
      initialValues={{ plant_ids: before }}
      errorOverrides={(e) => accessWriteError(t, e)}
      onSave={async ({ plant_ids }) => {
        const chosen = plants.map((p) => p.id).filter((id) => plant_ids.includes(id))
        const base = { role: member.audit_role, note: member.note ?? '' }
        if (mode === 'view') {
          if (chosen.length === before.length && chosen.every((id) => before.includes(id))) return
          return onSave({ ...base, viewerPlantIds: chosen })
        }
        const changes = plantChanges(member.coordinator_plant_ids, chosen)
        if (changes) return onSave({ ...base, viewerPlantIds: member.viewer_plant_ids, coordinatorChanges: changes })
      }}
      onClose={onClose}
    >
      {header}
      <Alert type="info" showIcon style={{ marginBottom: 12 }} title={t(mode === 'view' ? 'rights.view' : 'rights.run')} data-testid="access-rights-mode" />
      {mode === 'view' && member.coordinator_plant_ids.length > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="access-rights-viewer-runs"
          title={t('rights.viewerRuns', { plants: member.coordinator_plant_ids.map((id) => plantLabelById(id, plants)).join('、') })}
        />
      )}
      <Form.Item
        name="plant_ids"
        style={{ marginBottom: 0 }}
        rules={mode === 'view' ? [{ required: true, type: 'array', min: 1, message: t('form.viewerPlantsRequired') }] : []}
      >
        <PlantBoxes plants={plants} runBy={mode === 'run' ? { member, members } : undefined} />
      </Form.Item>
      {mode === 'run' && <RunNotes member={member} members={members} plants={plants} />}
    </FormModal>
  )
}

/**
 * The plant boxes of 廠區權限: 全部廠區 and 清除選取, two columns, then how many are ticked. With `runBy`, a plant
 * someone else runs says who. A form control (value, onChange) or, `disabled`, a fixed picture.
 */
function PlantBoxes({
  plants,
  value = [],
  onChange,
  disabled,
  runBy,
}: {
  plants: Plant[]
  value?: string[]
  onChange?: (ids: string[]) => void
  disabled?: boolean
  runBy?: { member: AccessMember; members: AccessMember[] }
}) {
  const { t } = useTranslation('access')
  const all = plants.length > 0 && plants.every((p) => value.includes(p.id))
  const runner = (plantId: string) => runBy?.members.find((m) => m.emp_id !== runBy.member.emp_id && m.coordinator_plant_ids.includes(plantId))
  return (
    <Flex vertical gap={6}>
      <Flex justify="space-between" align="center">
        <Checkbox
          checked={all}
          indeterminate={!all && value.length > 0}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.checked ? plants.map((p) => p.id) : [])}
          data-testid="access-rights-all"
        >
          {t('rights.all', { count: plants.length })}
        </Checkbox>
        {!disabled && (
          <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => onChange?.([])} data-testid="access-rights-clear">
            {t('rights.clear')}
          </Button>
        )}
      </Flex>
      <Checkbox.Group value={value} onChange={(v) => onChange?.(v as string[])} disabled={disabled} style={{ display: 'block' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '6px 20px' }}>
          {plants.map((p) => {
            const other = runner(p.id)
            return (
              <Checkbox key={p.id} value={p.id} data-testid={`access-rights-${p.factory_code}`}>
                <span style={{ fontWeight: 600, color: disabled ? undefined : palette.primary }}>{p.factory_code}</span> {p.name}
                {other && (
                  <Typography.Text type="secondary" style={{ marginInlineStart: 6, fontSize: textSize(12) }}>
                    {t('rights.runBy', { name: other.name ?? other.emp_id })}
                  </Typography.Text>
                )}
              </Checkbox>
            )
          })}
        </div>
      </Checkbox.Group>
      <Typography.Text type="secondary" style={{ marginTop: 4 }} data-testid="access-rights-count">
        {t('rights.count', { count: value.length, total: plants.length })}
      </Typography.Text>
    </Flex>
  )
}

/** Under 廠區權限's boxes when they are the plants someone runs: who steps down, and a Taipei 稽核人員 step left unlinked. */
function RunNotes({ member, members, plants }: { member: AccessMember; members: AccessMember[]; plants: Plant[] }) {
  const { t } = useTranslation('access')
  const form = Form.useFormInstance<PlantRightsValues>()
  const chosen = Form.useWatch('plant_ids', form) ?? []
  const handed = takeovers(member.emp_id, chosen, members)
  const added = chosen.filter((id) => !member.coordinator_plant_ids.includes(id))
  return (
    <Flex vertical gap={8} style={{ marginTop: 12 }}>
      {added.length > 0 && !linksTaipeiAudit(member.audit_role) && (
        <Alert type="info" showIcon data-testid="access-coordinator-not-linked" title={t('coordinator.notLinked')} />
      )}
      {handed.map((h) => (
        <Alert
          key={h.plantId}
          type="warning"
          showIcon
          data-testid="access-coordinator-takeover"
          title={t('form.takeover', { plant: plantLabelById(h.plantId, plants), from: personLabel(h.from.emp_id, h.from.name), to: personLabel(member.emp_id, member.name) })}
        />
      ))}
    </Flex>
  )
}

/**
 * 移除 (Q98 (5)): first lists the 關卡 the person is still on, so the 稽核主管 can replace them first; does not
 * block. Mount only while open.
 */
export function RemoveMemberModal({
  member,
  plants,
  isSelf,
  onRemove,
  onClose,
}: {
  member: AccessMember
  /** To name the plants they run, which are left with no 廠區負責人. */
  plants: Plant[]
  isSelf: boolean
  onRemove: () => Promise<unknown>
  onClose: () => void
}) {
  const { t } = useTranslation('access')
  const impact = useRemovalImpact(member.emp_id)
  const groups = groupImpact(impact.data ?? [])
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = personLabel(member.emp_id, member.name)

  return (
    <Modal
      open
      title={t('removeTitle', { name })}
      okText={t('removeOk')}
      // Someone still on a 關卡 is not removed until replaced there (Q150): the database refuses it too (still_assigned).
      okButtonProps={{ danger: true, disabled: impact.isLoading || !groups.empty, 'data-testid': 'access-remove-ok' } as ButtonProps}
      confirmLoading={removing}
      onOk={async () => {
        setRemoving(true)
        setError(null)
        try {
          await onRemove()
          onClose()
        } catch (e) {
          setError(accessWriteError(t, e))
        } finally {
          setRemoving(false)
        }
      }}
      onCancel={onClose}
      width={640}
      data-testid="access-remove-modal"
    >
      <Typography.Paragraph>{t('removeIntro')}</Typography.Paragraph>
      {isSelf && <Alert type="warning" showIcon title={t('removeSelf')} style={{ marginBottom: 12 }} />}
      {member.coordinator_plant_ids.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="access-remove-plants"
          title={t('removePlants', { plants: member.coordinator_plant_ids.map((id) => plantLabelById(id, plants)).join('、') })}
        />
      )}
      {impact.isLoading ? (
        <Spin size="small" tip={t('impactLoading')} />
      ) : impact.isError ? (
        <Alert type="warning" showIcon title={errorText(impact.error)} />
      ) : groups.empty ? (
        <Typography.Text type="secondary" data-testid="access-impact-none">
          {t('impactNone')}
        </Typography.Text>
      ) : (
        <div data-testid="access-impact">
          <Alert type="error" showIcon title={t('impactWarning')} style={{ marginBottom: 12 }} />
          {(['current', 'later', 'route'] as const).map(
            (kind) =>
              groups[kind].length > 0 && (
                <div key={kind} style={{ marginBottom: 8 }}>
                  <Typography.Text strong>{t(`impact.${kind}`)}</Typography.Text>
                  <ul style={{ margin: '4px 0', paddingInlineStart: 20 }} data-testid={`access-impact-${kind}`}>
                    {groups[kind].map((r) => (
                      <li key={`${r.assessment_id ?? r.route_id}-${r.step_position}`}>
                        {t(kind === 'route' ? 'impactRouteStep' : 'impactStep', {
                          year: r.year,
                          template: `${r.template_code} ${r.template_name}`,
                          plant: `${r.factory_code} ${r.plant_name}`,
                          position: r.step_position,
                          step: r.step_name,
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              ),
          )}
        </div>
      )}
      {error && <Alert type="error" showIcon title={error} style={{ marginTop: 12 }} />}
    </Modal>
  )
}
