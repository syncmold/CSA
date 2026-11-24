import { Form, Input, Select } from 'antd'
import { useTranslation } from 'react-i18next'
import type { RouteStepRow, StepInput } from '../api/approvalRoutes'
import { branchInsertOptions, routeWriteError } from '../domain/routes'
import { FormModal } from './TemplateEditModals'

type BranchStepValues = { name: string; after: number }

/**
 * 多加一關 in a 分流, or 修改 one of its steps (Q116 (2)): its name, and for a new step which step of the 分流 it goes
 * after (by default right before the 部門主管, which stays last). The step's 群組 and 可編輯範圍 never change here: a 分流
 * step is 廠區端, and only its 自行檢查人員 answers. Mount it only while open.
 */
export function BranchStepModal({
  unitName,
  branch,
  stepCount,
  step,
  onSave,
  onClose,
}: {
  unitName: string
  /** The 分流's steps in order. */
  branch: readonly RouteStepRow[]
  /** How many steps the whole route has, to tell 「排最後」 from a position. */
  stepCount: number
  /** Absent when adding. */
  step?: RouteStepRow
  onSave: (input: StepInput, beforePosition: number | null) => Promise<unknown>
  onClose: () => void
}) {
  const { t } = useTranslation('flows')
  const options = branchInsertOptions(branch, stepCount)
  const requiredText = [{ required: true, whitespace: true, message: t('required') }]

  return (
    <FormModal<BranchStepValues>
      title={step ? t('editStep') : t('addBranchStepTitle', { unit: unitName })}
      initialValues={step ? { name: step.name } : { after: Math.max(options.length - 1, 0) }}
      onSave={(v) =>
        onSave(
          {
            name: v.name.trim(),
            step_group: 'plant',
            // Who is 分派 there stays (Q147: chosen on 分派填寫人); a new step starts with nobody.
            signer_emp_id: step?.signer_emp_id ?? null,
            editable_unit_id: step?.editable_unit_id ?? null,
          },
          step ? null : (options[v.after]?.before ?? null),
        )
      }
      onClose={onClose}
      errorOverrides={(e) => routeWriteError(t, e)}
      testId="branch-step-modal"
    >
      <Form.Item name="name" label={t('stepName')} rules={requiredText}>
        <Input placeholder={t('branchStepNamePlaceholder')} autoFocus data-testid="step-name" />
      </Form.Item>
      {!step && (
        <Form.Item name="after" label={t('placeAfter')}>
          <Select
            options={options.map((o, i) => ({ value: i, label: t('afterStep', { name: o.after.name }) }))}
            style={{ width: 360 }}
            data-testid="step-after"
          />
        </Form.Item>
      )}
    </FormModal>
  )
}
