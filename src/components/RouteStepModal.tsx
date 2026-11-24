import { Form, Input, Radio, Select, Spin, Typography } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ROUTE_LINKS, type NewStepInput, type RouteLink, type RouteStepRow, type StepGroup, type StepInput } from '../api/approvalRoutes'
import { bringIn } from '../domain/people'
import { routeWriteError, signerLabel } from '../domain/routes'
import { useEmployees, usePersonLookup } from '../hooks/useEmployeeSearch'
import { FormModal } from './TemplateEditModals'

const GROUPS: StepGroup[] = ['plant', 'audit_review']

/** 「加在最後」 in the position select; any other value is the position the new step goes before. */
const AT_END = 0

type StepValues = StepInput & { before: number; link: RouteLink | null }

/**
 * Where a new 匯流後 step goes by default, in the paper order: a 廠區端 step before the first 稽核室覆核 step; any other
 * 稽核室覆核 step before the 稽核主管, which stays last (#187, the 發起檢查 says so); the 稽核主管 itself at the end.
 */
function defaultBefore(group: StepGroup, steps: readonly RouteStepRow[], link: RouteLink | null = null): number {
  if (group === 'plant') return steps.find((s) => s.step_group === 'audit_review')?.position ?? AT_END
  if (link === 'audit_chief') return AT_END
  return steps.find((s) => s.link === 'audit_chief')?.position ?? AT_END
}

/**
 * 新增 or 修改 a 匯流後 關卡 (廠區經理人, 稽核室覆核): name, 群組, for 稽核室覆核 the 簽核人 (by 工號, checked with OMS; the
 * 廠區負責人 assigns 廠區端 ones once issued), and for a new step where it goes. A new 稽核室覆核 step can be a 連動
 * 關卡 (台北稽核人員 or 稽核主管, #189): it takes that name, cannot be edited afterwards, and a route has one of each.
 * 匯流後 steps are always read-only; the 自行檢查人員 are in the 分流 (RouteBranchModals).
 * A failed save shows the database's refusal inside the modal and keeps it open. Mount it only while open.
 */
export function RouteStepModal({
  initial,
  link: fixedLink = null,
  steps,
  onSave,
  onClose,
}: {
  /** Absent when adding a step. */
  initial?: StepInput
  /** Editing a 連動關卡 that is not linked right now (#190): only its 簽核人 can change. */
  link?: RouteLink | null
  /** The route's 匯流後 steps now, for the position select when adding. */
  steps: readonly RouteStepRow[]
  onSave: (input: NewStepInput, beforePosition: number | null) => Promise<unknown>
  onClose: () => void
}) {
  const { t } = useTranslation('flows')
  const adding = !initial

  return (
    <FormModal<StepValues>
      title={t(adding ? 'addStep' : 'editStep')}
      initialValues={initial ?? { step_group: 'plant', before: defaultBefore('plant', steps), link: null }}
      onSave={(v) =>
        onSave(
          {
            name: v.name.trim(),
            step_group: v.step_group,
            // 稽核室的一般關卡（子公司擔當稽核）可以留空，發出前在分派填寫人分派（Q143、Q147）。廠區端的簽核人不在這裡
            // 改（Q147：都在分派填寫人分派），修改關卡時留著原本的人。
            signer_emp_id: v.step_group === 'plant' ? (initial?.signer_emp_id ?? null) : (v.signer_emp_id ?? null),
            editable_unit_id: null,
            // Only a new step can be marked; the mark of an existing step is never sent.
            ...(adding && v.step_group === 'audit_review' && v.link ? { link: v.link } : {}),
          },
          v.before ? v.before : null,
        )
      }
      onClose={onClose}
      errorOverrides={(e) => routeWriteError(t, e)}
      testId="route-step-modal"
    >
      <StepFields adding={adding} steps={steps} fixedLink={adding ? null : fixedLink} />
    </FormModal>
  )
}

/** The fields inside the modal's form; switching the 群組 of a new step moves its default position. */
function StepFields({ adding, steps, fixedLink }: { adding: boolean; steps: readonly RouteStepRow[]; fixedLink: RouteLink | null }) {
  const { t } = useTranslation('flows')
  const form = Form.useFormInstance<StepValues>()
  const group = Form.useWatch('step_group', form)
  const link = Form.useWatch('link', form)
  const required = [{ required: true, message: t('required') }]
  const requiredText = [{ required: true, whitespace: true, message: t('required') }]

  const moveDefault = (nextGroup: StepGroup, nextLink: RouteLink | null) => {
    if (adding && !form.isFieldTouched('before')) form.setFieldValue('before', defaultBefore(nextGroup, steps, nextLink))
  }

  // A 連動 step is named after what it follows, so the name cannot drift from its meaning; dropping the 連動 drops that
  // name too, or an ordinary step would carry a 連動關卡's name.
  const changeLink = (next: RouteLink | null) => {
    if (next) form.setFieldValue('name', t(`links.${next}.name`))
    else if (link) form.setFieldValue('name', '')
    moveDefault(group, next)
  }

  const changeGroup = (next: StepGroup) => {
    if (next === 'plant' && link) {
      form.setFieldValue('link', null)
      form.setFieldValue('name', '')
    }
    moveDefault(next, next === 'plant' ? null : link)
  }
  const taken = (l: RouteLink) => steps.some((s) => s.link === l)

  return (
    <>
      <Form.Item name="name" label={t('stepName')} rules={requiredText}>
        <Input placeholder={t('stepNamePlaceholder')} autoFocus disabled={!!link || !!fixedLink} data-testid="step-name" />
      </Form.Item>
      <Form.Item name="step_group" label={t('group')}>
        <Radio.Group
          disabled={!!fixedLink}
          optionType="button"
          options={GROUPS.map((g) => ({ value: g, label: t(`groups.${g}`) }))}
          onChange={(e) => changeGroup(e.target.value as StepGroup)}
        />
      </Form.Item>
      {adding && group === 'audit_review' && (
        <Form.Item name="link" label={t('linkField')} extra={link ? t('linkHint') : undefined}>
          <Select
            options={[
              { value: null, label: t('linkNone') },
              ...ROUTE_LINKS.map((l) => ({ value: l, label: t(`links.${l}.option`), disabled: taken(l) })),
            ]}
            onChange={changeLink}
            style={{ width: 360 }}
            data-testid="step-link"
          />
        </Form.Item>
      )}
      {group === 'audit_review' && (
        <Form.Item
          name="signer_emp_id"
          label={t('signer')}
          rules={fixedLink || link ? required : []}
          extra={fixedLink ? t(`links.${fixedLink}.unlinkedHint`) : link ? t('signerHint') : t('signerOptionalHint')}
        >
          <SignerSelect />
        </Form.Item>
      )}
      {adding && steps.length > 0 && (
        <Form.Item name="before" label={t('position')}>
          <Select
            options={[
              { value: AT_END, label: t('atEnd') },
              ...steps.map((s, i) => ({ value: s.position, label: t('beforeStep', { position: i + 1, name: s.name }) })),
            ]}
            style={{ width: 360 }}
            data-testid="step-position"
          />
        </Form.Item>
      )}
    </>
  )
}

/**
 * 簽核人 picker (#218): type a complete 工號 and the CSA backend asks OMS who that is; only someone 在職 can be chosen.
 * No search by name: OMS's channel has none, and CSA's own list of names is not for browsing. The value is the 工號
 * (Q61); the chosen person's 姓名 stays visible as the label. `id`／`value`／`onChange` come from Form.Item (the id ties
 * the 簽核人 label to the input).
 */
function SignerSelect({ id, value, onChange }: { id?: string; value?: string | null; onChange?: (empId: string) => void }) {
  const { t } = useTranslation('flows')
  const [term, setTerm] = useState('')
  const found = usePersonLookup(term)
  const current = useEmployees(value ? [value] : [])
  // Whoever was found last keeps their label after being chosen, before CSA's own copy of the name is read.
  const [picked, setPicked] = useState<{ emp_id: string; name: string; factory_code: string | null } | null>(null)

  const person = found.person
  const verdict = person ? bringIn(person) : null
  const pickable = person && verdict?.ok ? { emp_id: person.emp_id, name: person.name ?? person.emp_id, factory_code: person.factory_code } : null
  // Not enabled for CSA in OMS yet: can still be chosen (Q130 (4)), and the option says so.
  const options = pickable ? [{ value: pickable.emp_id, label: person!.csa ? signerLabel(pickable) : `${signerLabel(pickable)}　${t('lookup.noCsa')}` }] : []
  const refusal = person && verdict && !verdict.ok ? t(`lookup.${verdict.reason}`, { empId: person.asked }) : null
  const chosen = value ? (picked?.emp_id === value ? picked : current.data?.get(value)) : undefined
  // The current signer keeps a readable label; at the end, so Enter picks the person just found.
  if (value && !options.some((o) => o.value === value)) {
    options.push({ value, label: chosen ? signerLabel(chosen) : value })
  }
  const nothing = found.searching ? (
    <Spin size="small" />
  ) : found.error ? (
    <Typography.Text type="danger">{t([`lookupErrors.${found.error}`, 'lookupErrors.other'], { code: found.error })}</Typography.Text>
  ) : refusal ? (
    <Typography.Text type="secondary">{refusal}</Typography.Text>
  ) : term.trim() ? (
    <Typography.Text type="secondary">{t('lookup.typeAll')}</Typography.Text>
  ) : null

  return (
    <Select
      id={id}
      value={value ?? undefined}
      onChange={(empId: string) => {
        if (pickable?.emp_id === empId) setPicked(pickable)
        onChange?.(empId)
      }}
      showSearch={{ filterOption: false, onSearch: setTerm }}
      placeholder={t('signerPlaceholder')}
      options={options}
      notFoundContent={nothing}
      style={{ width: 360 }}
      data-testid="signer-select"
    />
  )
}
