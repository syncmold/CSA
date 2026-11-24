import { Alert, Flex, Input, Modal, Typography } from 'antd'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { confirmPhraseMatches } from '../domain/templates'

/**
 * A delete that has to be typed (Q87 (4), also 簽核流程 Q137 (6)): 刪除 is enabled only once the 稽核主管 has typed
 * the phrase, e.g. 「刪除 FQ-02」. The phrase is shown only as the input's placeholder, which cannot be selected, and
 * pasting or dropping text is refused, so it has to be read and typed (the placeholder comes back whenever the box is
 * empty again). The database checks the 編號 once more; its refusal stays inside the modal.
 */
export function TypeToDeleteModal({
  title,
  warning,
  details,
  code,
  onDelete,
  onDeleted,
  onClose,
  describeError,
  testId,
}: {
  title: string
  warning: string
  details: ReactNode
  /** The 編號 to type after 「刪除」 (common:typeToDelete.phrase), e.g. FQ-02 → 「刪除 FQ-02」. */
  code: string
  onDelete: () => Promise<unknown>
  onDeleted: () => void
  onClose: () => void
  describeError: (error: unknown) => string
  /** `<testId>-modal` on the modal, `<testId>-code` on the input. */
  testId: string
}) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const phrase = t('typeToDelete.phrase', { code })
  const matches = confirmPhraseMatches(typed, phrase)

  const submit = async () => {
    if (!matches || deleting) return
    setDeleting(true)
    setError(null)
    try {
      await onDelete()
      onDeleted()
    } catch (e) {
      setError(describeError(e))
      setDeleting(false)
    }
  }

  return (
    <Modal
      open
      title={title}
      okText={t('typeToDelete.delete')}
      okButtonProps={{ danger: true, disabled: !matches }}
      confirmLoading={deleting}
      onOk={submit}
      onCancel={onClose}
      data-testid={`${testId}-modal`}
    >
      <Flex vertical gap={8}>
        <Alert type="warning" showIcon title={warning} />
        <Typography.Paragraph style={{ margin: 0 }}>{details}</Typography.Paragraph>
        <Typography.Text>{t('typeToDelete.typePhrase')}</Typography.Text>
        <Input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onPressEnter={submit}
          onPaste={(e) => e.preventDefault()}
          onDrop={(e) => e.preventDefault()}
          placeholder={phrase}
          status={typed && !matches ? 'error' : undefined}
          aria-label={t('typeToDelete.typePhrase')}
          data-testid={`${testId}-code`}
        />
        {error && <Alert type="error" showIcon title={error} />}
      </Flex>
    </Modal>
  )
}
