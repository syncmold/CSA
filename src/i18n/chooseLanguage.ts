/** Interface languages shipped so far (#16 adds zh-CN, vi, th). */
export const SUPPORTED_LANGUAGES = ['zh-TW', 'en'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]

export const DEFAULT_LANGUAGE: Language = 'zh-TW'

/**
 * 廠區 code prefix → language, used only when the user has not chosen one.
 * Which OMS plant codes map to 簡中 is not decided yet; #16 fills this in.
 */
const FACTORY_LANGUAGE: Record<string, string> = {
  VN: 'vi',
  TH: 'th',
}

function isSupported(value: string | null | undefined): value is Language {
  return !!value && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

/** Q19 order: the user's stored choice → inferred from 廠區 → 繁中. */
export function chooseLanguage(input: { stored: string | null; factoryCode: string | null }): Language {
  if (isSupported(input.stored)) return input.stored
  const prefix = input.factoryCode?.split('-')[0]?.toUpperCase() ?? ''
  const inferred = FACTORY_LANGUAGE[prefix]
  return isSupported(inferred) ? inferred : DEFAULT_LANGUAGE
}
