import { useTranslation } from 'react-i18next'
import type { TemplateTree } from '../api/templates'
import { outline } from '../domain/outline'
import { controlPointCount, writeErrorMessage } from '../domain/templates'
import { TypeToDeleteModal } from './TypeToDeleteModal'

/**
 * 刪除問卷範本 (#31): typed as 「刪除 <編號>」 (TypeToDeleteModal). The database checks the 編號 again and decides whether
 * the template was ever used (Q87).
 */
export function DeleteTemplateModal({
  tpl,
  onDelete,
  onDeleted,
  onClose,
}: {
  tpl: TemplateTree
  /** Called with the template's 編號, which the database compares once more. */
  onDelete: (confirmCode: string) => Promise<unknown>
  onDeleted: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <TypeToDeleteModal
      title={t('templates.deleteTemplate.title', { code: tpl.code, name: tpl.name })}
      warning={t('templates.deleteTemplate.onlyUnused')}
      details={t('templates.deleteTemplate.contents', { sections: outline(tpl.template_section).length, points: controlPointCount(tpl) })}
      code={tpl.code}
      onDelete={() => onDelete(tpl.code)}
      onDeleted={onDeleted}
      onClose={onClose}
      // 22023 (編號不符) keeps the default 「畫面已過期」: the page sends the 編號 it shows, so a mismatch
      // means the 編號 was changed elsewhere, not that the phrase was mistyped.
      describeError={(e) => writeErrorMessage(t, e, { '23503': 'templates.deleteTemplate.inUse' })}
      testId="delete-template"
    />
  )
}
