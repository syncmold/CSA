import { Affix, Alert, Button, Card, Flex, Form, Input, Modal, Select, Typography, type message } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssessmentView } from '../api/assessments'
import { WriteError } from '../api/writeError'
import { errorText } from '../domain/errors'
import { advanceMessageKey, mySignStep, returnTargets, stepLabel, stepLabelAt } from '../domain/signoff'
import { useSignoffActions } from '../hooks/useSignoff'

type Notify = ReturnType<typeof message.useMessage>[0]

/**
 * 核准／退回 (#6) for the signer of a 主管 or 稽核 關卡 whose turn it is. The page shows it only when the
 * database says so (`can_approve`); which 關卡 a return may target and what it voids is checked again there.
 * Someone whose turn it is in two 分流 at once signs them one after the other (mySignStep, Q116).
 */
export function SignoffPanel({ assessment: a, notify }: { assessment: AssessmentView; notify: Notify }) {
  const { t } = useTranslation('signoff')
  const { approve, returnToStep } = useSignoffActions(a.id)
  const [approving, setApproving] = useState(false)
  const [returning, setReturning] = useState(false)
  const [comment, setComment] = useState('')
  const [returnForm] = Form.useForm<{ toPosition: number; reason: string }>()

  const step = mySignStep(a)
  if (!step) return null
  const isLast = step.closes
  const earlierSteps = returnTargets(a, step)
  const labelAt = (position: number | null) => stepLabelAt(a.assessment_step, position) ?? ''

  const writeFailure = (error: unknown) =>
    error instanceof WriteError && error.reason === 'forbidden' ? t('errors.forbidden') : errorText(error)

  const onApprove = async () => {
    try {
      const result = await approve.mutateAsync({ stepPosition: step.position, comment })
      if (!result.ok) {
        void notify.error(t(`errors.${result.error}`))
        return
      }
      setApproving(false)
      void notify.success(
        result.closed ? t('closed') : t(advanceMessageKey('approved', a, result.current_step_position), { name: labelAt(result.current_step_position) }),
      )
    } catch (error) {
      void notify.error(writeFailure(error))
    }
  }

  const onReturn = async () => {
    let values: { toPosition: number; reason: string }
    try {
      values = await returnForm.validateFields()
    } catch {
      return // the form already shows which field is missing
    }
    try {
      const result = await returnToStep.mutateAsync({ stepPosition: step.position, ...values })
      if (!result.ok) {
        void notify.error(t(`errors.${result.error}`))
        return
      }
      setReturning(false)
      void notify.success(t('returned', { name: labelAt(values.toPosition), voided: result.voided }))
    } catch (error) {
      void notify.error(writeFailure(error))
    }
  }

  return (
    <>
      <Affix offsetBottom={0}>
        <Card size="small" data-testid="signoff-panel">
          <Flex gap={8} align="center" justify="space-between" wrap>
            <Typography.Text>{t('panelNote', { name: stepLabel(step) })}</Typography.Text>
            <Flex gap={8}>
              <Button danger disabled={earlierSteps.length === 0} onClick={() => setReturning(true)} data-testid="open-return">
                {t('return')}
              </Button>
              <Button
                type="primary"
                onClick={() => {
                  setComment('')
                  setApproving(true)
                }}
                data-testid="open-approve"
              >
                {t('approve')}
              </Button>
            </Flex>
          </Flex>
        </Card>
      </Affix>

      <Modal
        open={approving}
        title={t('approveTitle', { name: stepLabel(step) })}
        okText={t('approve')}
        onOk={onApprove}
        confirmLoading={approve.isPending}
        onCancel={() => setApproving(false)}
        destroyOnHidden
        okButtonProps={{ 'data-testid': 'confirm-approve' }}
      >
        <Flex vertical gap={12}>
          {isLast && <Alert type="warning" showIcon title={t('approveLastNote')} data-testid="approve-last-note" />}
          <Input.TextArea
            autoSize={{ minRows: 3 }}
            placeholder={t('comment')}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="approve-comment"
          />
        </Flex>
      </Modal>

      <Modal
        open={returning}
        title={t('returnTitle')}
        okText={t('return')}
        okButtonProps={{ danger: true, 'data-testid': 'confirm-return' }}
        onOk={onReturn}
        confirmLoading={returnToStep.isPending}
        onCancel={() => setReturning(false)}
        destroyOnHidden
      >
        <Flex vertical gap={12}>
          <Alert type="info" showIcon title={t('returnNote')} />
          <Form form={returnForm} layout="vertical" preserve={false}>
            <Form.Item name="toPosition" label={t('returnTo')} rules={[{ required: true, message: t('returnToRequired') }]}>
              <Select
                options={earlierSteps.map((s) => ({ value: s.position, label: stepLabel(s) }))}
                data-testid="return-target"
              />
            </Form.Item>
            <Form.Item
              name="reason"
              label={t('reason')}
              rules={[{ required: true, whitespace: true, message: t('reasonRequired') }]}
            >
              <Input.TextArea autoSize={{ minRows: 3 }} data-testid="return-reason" />
            </Form.Item>
          </Form>
        </Flex>
      </Modal>
    </>
  )
}
