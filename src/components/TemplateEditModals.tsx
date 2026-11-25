import { ArrowDownOutlined, ArrowUpOutlined, HolderOutlined, PlusOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Divider, Flex, Form, Input, Modal, Radio, Select, Space, Switch, Typography } from 'antd'
import type { Rule } from 'antd/es/form'
import type { TFunction } from 'i18next'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ControlPointInput, SectionInput, TemplateHeaderInput, TemplateLayout, TemplateStatus } from '../api/templates'
import { componentChoices, moveId, unitRequired, writeErrorMessage } from '../domain/templates'
import { useAssessingUnitEditing, useAssessingUnits } from '../hooks/useAssessingUnits'
import { usePlants } from '../hooks/usePlants'
import { palette } from '../theme'
import { useDragReorder } from './useDragReorder'
import { describeWriteError, type DescribeError } from './useWriteToast'

const STATUSES: TemplateStatus[] = ['active', 'inactive']

/** A required text field: blank or spaces-only is refused before anything is sent. */
export function requiredText(t: TFunction): Rule[] {
  return [{ required: true, whitespace: true, message: t('templates.required') }]
}

/**
 * A modal with one antd form: OK submits, a failed save shows the database's refusal inside the
 * modal and keeps it open. Callers mount it only while open, so every opening starts fresh.
 * Shared by 範本管理 and the 流程編輯器 (#11).
 */
export function FormModal<V extends object>({
  title,
  initialValues,
  onSave,
  onClose,
  errorOverrides,
  children,
  testId,
  okText,
  footerStart,
}: {
  title: string
  initialValues: Partial<V>
  onSave: (values: V) => Promise<unknown>
  onClose: () => void
  errorOverrides?: DescribeError
  children: ReactNode
  testId: string
  /** Defaults to 儲存. */
  okText?: string
  /** Something at the left end of the footer, across from 取消 and 儲存 (權限管理's 從名單移除, #215). */
  footerStart?: ReactNode
}) {
  const { t } = useTranslation()
  const [form] = Form.useForm<V>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (values: V) => {
    setSaving(true)
    setError(null)
    try {
      await onSave(values)
      onClose()
    } catch (e) {
      setError(describeWriteError(t, e, errorOverrides))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={title}
      okText={okText ?? t('templates.save')}
      confirmLoading={saving}
      onOk={() => form.submit()}
      onCancel={onClose}
      width={640}
      data-testid={testId}
      footer={
        footerStart
          ? (_, { OkBtn, CancelBtn }) => (
              <Flex justify="space-between" align="center" gap={8}>
                {footerStart}
                <Flex gap={8}>
                  <CancelBtn />
                  <OkBtn />
                </Flex>
              </Flex>
            )
          : undefined
      }
    >
      <Form form={form} layout="vertical" initialValues={initialValues} onFinish={submit} requiredMark>
        {children}
      </Form>
      {error && <Alert type="error" showIcon title={error} />}
    </Modal>
  )
}

/**
 * 新增 or 編輯 the 範本抬頭 and 適用廠區. The 版型 is not shown (it is not an official term, #62): the
 * 組成要素 chosen on creation decides it in the database, so afterwards a template can move among the
 * four 組成要素 that share a 版型 but not to or from 控制作業.
 */
export function TemplateHeaderModal({
  initial,
  plant,
  limitToPlants,
  onSave,
  onClose,
}: {
  /** Absent when creating a new template; `layout` only decides which 組成要素 it may move to. */
  initial?: TemplateHeaderInput & { layout: TemplateLayout }
  /**
   * A 稽核人員's plants (Q144): the template may apply only to these, so there is no 全部廠區 switch and the 廠區代碼 are
   * chosen from them, not typed.
   */
  limitToPlants?: readonly string[] | null
  /** A new template made while a 廠區 is chosen applies to that plant only: each plant has its own (Q111). */
  plant?: string
  onSave: (values: TemplateHeaderInput) => Promise<unknown>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const plants = usePlants()
  const creating = !initial
  const { choices, hint } = componentChoices(initial?.layout)

  return (
    <FormModal<TemplateHeaderInput>
      title={t(creating ? 'templates.createTitle' : 'templates.editTitle')}
      initialValues={
        initial ?? {
          ...(plant
            ? { code: `${plant}-`, all_plants: false, factory_codes: [plant] }
            : limitToPlants
              ? { all_plants: false, factory_codes: limitToPlants.length === 1 ? [...limitToPlants] : [] }
              : { all_plants: true, factory_codes: [] }),
        }
      }
      // The database trims the header and normalizes the 廠區代碼 (Q83).
      onSave={(v) => onSave({ ...v, factory_codes: v.factory_codes ?? [] })}
      onClose={onClose}
      // In this form a 23514 can only be a move between 控制作業 and the other four (Q101(6)).
      errorOverrides={{ '23505': 'templates.errors.duplicateTemplate', '23514': 'templates.errors.componentLayout' }}
      testId="template-header-modal"
    >
      <Form.Item name="code" label={t('templates.code')} rules={requiredText(t)}>
        <Input placeholder="GT-07、FQ-01.1" />
      </Form.Item>
      <Form.Item name="name" label={t('templates.name')} rules={requiredText(t)}>
        <Input />
      </Form.Item>
      {choices.length === 1 ? (
        <>
          {/* Nothing to choose: show it as text, but keep the field so the form still sends it. */}
          <Form.Item name="component" hidden>
            <Input />
          </Form.Item>
          <Form.Item label={t('templates.component')} extra={t(`templates.${hint}`)}>
            {t(`templates.components.${choices[0]}`)}
          </Form.Item>
        </>
      ) : (
        <Form.Item
          name="component"
          label={t('templates.component')}
          rules={[{ required: true, message: t('templates.required') }]}
          extra={t(`templates.${hint}`)}
        >
          <Radio.Group
            options={choices.map((c) => ({ value: c, label: t(`templates.components.${c}`) }))}
            data-testid="template-component"
          />
        </Form.Item>
      )}
      {/* A new template is always 啟用 (Q137 (5)); 停用 is chosen later, on an edit. */}
      {!creating && (
        <Form.Item name="status" label={t('templates.status')} extra={t('templates.statusHint')}>
          <Radio.Group
            optionType="button"
            options={STATUSES.map((s) => ({ value: s, label: t(`templates.statuses.${s}`) }))}
            data-testid="template-status"
          />
        </Form.Item>
      )}
      {limitToPlants ? (
        <>
          <Form.Item name="all_plants" hidden valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            name="factory_codes"
            label={t('templates.applicablePlants')}
            extra={t('templates.limitedPlantsHint')}
            rules={[{ required: true, type: 'array', min: 1, message: t('templates.required') }]}
          >
            <Select
              mode="multiple"
              placeholder={t('templates.factoryCodesPlaceholder')}
              loading={plants.isPending}
              options={(plants.data ?? [])
                .filter((p) => limitToPlants.includes(p.factory_code))
                .map((p) => ({ value: p.factory_code, label: `${p.factory_code}　${p.name}` }))}
              data-testid="template-limited-plants"
            />
          </Form.Item>
        </>
      ) : (
        <>
          <Form.Item name="all_plants" label={t('templates.applicablePlants')} valuePropName="checked">
            <Switch checkedChildren={t('templates.allPlants')} unCheckedChildren={t('templates.somePlants')} />
          </Form.Item>
          <Form.Item noStyle dependencies={['all_plants']}>
            {({ getFieldValue }) =>
              !getFieldValue('all_plants') && (
                <Form.Item name="factory_codes" label={t('templates.factoryCodes')} extra={t('templates.factoryCodesHint')}>
                  <Select
                    mode="tags"
                    tokenSeparators={[',', '、', ' ']}
                    placeholder={t('templates.factoryCodesPlaceholder')}
                    loading={plants.isPending}
                    options={(plants.data ?? []).map((p) => ({ value: p.factory_code, label: `${p.factory_code}　${p.name}` }))}
                  />
                </Form.Item>
              )
            }
          </Form.Item>
        </>
      )}
    </FormModal>
  )
}

/** A 題號 field's value as stored: trimmed, and blank means none (the system numbers it, Q125). */
function codeOf(value: string | null | undefined): string | null {
  return value?.trim() || null
}

/**
 * 新增 or 修改 a 章節: its name, 層級 and the paper's 題號 (Q125). `maxLevel` is one deeper than the section before
 * it (1 for the first), so a section never skips a level.
 */
export function SectionModal({
  initial,
  maxLevel,
  onSave,
  onClose,
}: {
  initial?: SectionInput
  maxLevel: number
  onSave: (input: SectionInput) => Promise<unknown>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const levels = [1, 2, 3].filter((level) => level <= maxLevel)
  return (
    <FormModal<SectionInput>
      title={t(initial ? 'templates.renameSection' : 'templates.addSection')}
      initialValues={initial ?? { name: '', level: 1, code: null }}
      onSave={(v) => onSave({ name: v.name.trim(), level: v.level, code: codeOf(v.code) })}
      onClose={onClose}
      testId="section-modal"
    >
      <Form.Item name="name" label={t('templates.sectionName')} rules={requiredText(t)}>
        <Input autoFocus />
      </Form.Item>
      <Flex gap={16} wrap>
        <Form.Item name="level" label={t('templates.sectionLevel')} extra={t('templates.sectionLevelHint')} style={{ flex: '1 1 200px' }}>
          <Select options={levels.map((level) => ({ value: level, label: t(`templates.sectionLevels.${level}`) }))} data-testid="section-level" />
        </Form.Item>
        <Form.Item name="code" label={t('templates.itemCode')} extra={t('templates.codeHint')} style={{ flex: '1 1 160px' }}>
          <Input data-testid="section-code" />
        </Form.Item>
      </Flex>
    </FormModal>
  )
}

/** 新增 or 修改 a 控制要點: its text and its ordered 自評單位 (at least one for 控制活動類, any number for 要素類, #46). */
export function ControlPointModal({
  layout,
  initial,
  onSave,
  onClose,
}: {
  layout: TemplateLayout
  initial?: ControlPointInput
  onSave: (input: ControlPointInput) => Promise<unknown>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const units = useAssessingUnits()
  const required = unitRequired(layout)

  return (
    <FormModal<ControlPointInput>
      title={t(initial ? 'templates.editControlPoint' : 'templates.addControlPoint')}
      initialValues={initial ?? { code: null, text: '', assessing_unit_ids: [], is_reverse: false }}
      onSave={(v) =>
        onSave({ code: codeOf(v.code), text: v.text.trim(), assessing_unit_ids: v.assessing_unit_ids ?? [], is_reverse: v.is_reverse ?? false })
      }
      onClose={onClose}
      testId="control-point-modal"
    >
      <Form.Item name="code" label={t('templates.itemCode')} extra={t('templates.codeHint')}>
        <Input style={{ maxWidth: 200 }} data-testid="control-point-code" />
      </Form.Item>
      <Form.Item name="text" label={t('templates.controlPoint')} rules={requiredText(t)}>
        <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} autoFocus />
      </Form.Item>
      <Form.Item
        name="assessing_unit_ids"
        label={t('templates.assessingUnitsLabel')}
        rules={required ? [{ type: 'array', min: 1, required: true, message: t('templates.unitsRequired') }] : []}
        extra={required ? t('templates.unitsOrderHint') : `${t('templates.elementUnitHint')}${t('templates.unitsOrderHint')}`}
      >
        <UnitList names={new Map((units.data ?? []).map((u) => [u.id, u.name]))} loading={units.isPending} />
      </Form.Item>
      {/* Q148: the same setting as 範本管理's 反向題目 column. */}
      <Form.Item name="is_reverse" valuePropName="checked" extra={t('templates.reverseHint')} style={{ marginBottom: 0 }}>
        <Checkbox data-testid="control-point-reverse">{t('templates.reverse')}</Checkbox>
      </Form.Item>
    </FormModal>
  )
}

/**
 * A control point's 自評單位 in answering order: drag ⠿ or ↑↓ to reorder (the buttons also work from the keyboard),
 * 移除 to drop one, and the select below to add one (a unit the list lacks can be created there). A unit cannot be
 * chosen twice. `value`／`onChange` come from the surrounding Form.Item.
 */
function UnitList({
  value = [],
  onChange,
  names,
  loading,
}: {
  value?: string[]
  onChange?: (ids: string[]) => void
  names: ReadonlyMap<string, string>
  loading: boolean
}) {
  const { t } = useTranslation()
  const set = (ids: string[]) => onChange?.(ids)
  const drag = useDragReorder(value, set)
  const nameOf = (id: string) => names.get(id) ?? '…'
  /** ↑／↓ on the unit at `i`: the same move a drop onto the neighbour makes. */
  const step = (i: number, by: -1 | 1) => set(moveId(value, value[i]!, value[i + by]!))

  return (
    <Flex vertical gap={8}>
      <div style={{ border: `1px solid ${palette.border}`, borderRadius: 9, padding: '4px 10px' }} data-testid="unit-list">
        {value.length === 0 && <Typography.Text type="secondary">{t('templates.noUnitsYet')}</Typography.Text>}
        {value.map((id, i) => {
          const item = drag.itemProps(id)
          return (
            <Flex key={id} align="center" gap={8} {...item} style={{ padding: '4px 0', ...item.style }} data-testid="unit-list-item">
              <HolderOutlined {...drag.handleProps(id)} aria-label={t('templates.dragHandle')} />
              <Typography.Text type="secondary" style={{ width: 20, textAlign: 'right' }}>
                {i + 1}.
              </Typography.Text>
              <span style={{ flex: 1 }}>{nameOf(id)}</span>
              <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => step(i, -1)} aria-label={t('templates.moveUnitUp', { name: nameOf(id) })} />
              <Button
                size="small"
                type="text"
                icon={<ArrowDownOutlined />}
                disabled={i === value.length - 1}
                onClick={() => step(i, 1)}
                aria-label={t('templates.moveUnitDown', { name: nameOf(id) })}
              />
              <Button size="small" type="text" danger onClick={() => set(value.filter((x) => x !== id))} aria-label={t('templates.removeUnitLabel', { name: nameOf(id) })}>
                {t('templates.removeUnit')}
              </Button>
            </Flex>
          )
        })}
      </div>
      <UnitSelect
        value={null}
        onChange={(id) => id && !value.includes(id) && set([...value, id])}
        options={[...names].filter(([id]) => !value.includes(id)).map(([id, name]) => ({ value: id, label: name }))}
        loading={loading}
        allowClear={false}
        placeholder={t('templates.addUnitToPoint')}
      />
    </Flex>
  )
}

/**
 * The 自評單位 select of a control point, with "add a unit" at the bottom of its list: a missing unit
 * can be added without leaving the modal (and losing the text being typed); the new unit is then chosen.
 * `value`／`onChange` come from the surrounding Form.Item.
 */
function UnitSelect({
  value,
  onChange,
  options,
  loading,
  allowClear,
  placeholder,
}: {
  value?: string | null
  onChange?: (id: string | null) => void
  options: { value: string; label: string }[]
  loading: boolean
  allowClear: boolean
  placeholder?: string
}) {
  const { t } = useTranslation()
  const { create } = useAssessingUnitEditing()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setError(null)
    try {
      const unit = await create.run(trimmed)
      setName('')
      onChange?.(unit.id)
    } catch (e) {
      setError(writeErrorMessage(t, e, { '23505': 'templates.units.duplicate' }))
    }
  }

  return (
    <Select
      value={value ?? undefined}
      onChange={(id) => onChange?.(id ?? null)}
      showSearch={{ optionFilterProp: 'label' }}
      allowClear={allowClear}
      placeholder={placeholder ?? t('templates.chooseUnit')}
      loading={loading}
      options={options}
      style={{ width: 280 }}
      data-testid="unit-select"
      popupRender={(menu) => (
        <>
          {menu}
          <Divider style={{ margin: '8px 0' }} />
          <Space.Compact style={{ width: '100%', padding: '0 8px 4px' }}>
            <Input
              value={name}
              placeholder={t('templates.units.placeholder')}
              onChange={(e) => setName(e.target.value)}
              // Keep the keys for this input: the select would otherwise treat them as its own search.
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') void add()
              }}
              data-testid="unit-select-new"
            />
            <Button icon={<PlusOutlined />} loading={create.isPending} onClick={() => void add()}>
              {t('templates.units.add')}
            </Button>
          </Space.Compact>
          {error && <Typography.Text type="danger" style={{ padding: '0 8px' }}>{error}</Typography.Text>}
        </>
      )}
    />
  )
}
