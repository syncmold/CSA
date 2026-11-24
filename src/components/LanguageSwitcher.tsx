import { Radio } from 'antd'
import { useTranslation } from 'react-i18next'
import { applyLanguage } from '../i18n'
import { SUPPORTED_LANGUAGES, type Language } from '../i18n/chooseLanguage'

const LABELS: Record<Language, string> = { 'zh-TW': '繁中', en: 'English' }

/** Both buttons stay on one line wherever the switcher sits; squeezed, they wrapped under each other (#137). */
export function LanguageSwitcher() {
  const { i18n, t } = useTranslation()
  return (
    <span data-testid="language-switcher" aria-label={t('app.language')} style={{ whiteSpace: 'nowrap' }}>
      <Radio.Group
        size="small"
        optionType="button"
        value={i18n.language}
        onChange={(event) => applyLanguage(event.target.value as Language)}
        options={SUPPORTED_LANGUAGES.map((code) => ({ value: code, label: LABELS[code] }))}
      />
    </span>
  )
}
