import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-tw'
import 'dayjs/locale/en'
import zhTW from '../locales/zh-TW/common.json'
import en from '../locales/en/common.json'
import zhTWAnswering from '../locales/zh-TW/answering.json'
import enAnswering from '../locales/en/answering.json'
import zhTWSignoff from '../locales/zh-TW/signoff.json'
import enSignoff from '../locales/en/signoff.json'
import zhTWFlows from '../locales/zh-TW/flows.json'
import enFlows from '../locales/en/flows.json'
import zhTWLaunch from '../locales/zh-TW/launch.json'
import enLaunch from '../locales/en/launch.json'
import zhTWPdf from '../locales/zh-TW/pdf.json'
import enPdf from '../locales/en/pdf.json'
import zhTWHome from '../locales/zh-TW/home.json'
import enHome from '../locales/en/home.json'
import zhTWTracking from '../locales/zh-TW/tracking.json'
import enTracking from '../locales/en/tracking.json'
import zhTWAccess from '../locales/zh-TW/access.json'
import enAccess from '../locales/en/access.json'
import zhTWAssignment from '../locales/zh-TW/assignment.json'
import enAssignment from '../locales/en/assignment.json'
import zhTWRecords from '../locales/zh-TW/records.json'
import enRecords from '../locales/en/records.json'
import { chooseLanguage, DEFAULT_LANGUAGE, type Language } from './chooseLanguage'

export const LANGUAGE_STORAGE_KEY = 'csa.language'

export function readStoredLanguage(): string | null {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY)
  } catch {
    return null
  }
}

function persistLanguage(language: Language) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    /* private mode or blocked storage: the choice just does not persist */
  }
}

const DAYJS_LOCALE: Record<Language, string> = { 'zh-TW': 'zh-tw', en: 'en' }

export function applyLanguage(language: Language) {
  void i18n.changeLanguage(language)
  dayjs.locale(DAYJS_LOCALE[language])
  document.documentElement.lang = language === 'zh-TW' ? 'zh-Hant' : language
  persistLanguage(language)
}

void i18n.use(initReactI18next).init({
  resources: {
    'zh-TW': { common: zhTW, answering: zhTWAnswering },
    en: { common: en, answering: enAnswering },
  },
  lng: chooseLanguage({ stored: readStoredLanguage(), factoryCode: null }),
  fallbackLng: DEFAULT_LANGUAGE,
  defaultNS: 'common',
  interpolation: { escapeValue: false },
})
dayjs.locale(DAYJS_LOCALE[i18n.language as Language] ?? 'zh-tw')

// 核准、退回與簽核歷程 (#6)
i18n.addResourceBundle('zh-TW', 'signoff', zhTWSignoff)
i18n.addResourceBundle('en', 'signoff', enSignoff)

// 流程編輯器 (#11) 的介面文字
i18n.addResourceBundle('zh-TW', 'flows', zhTWFlows)
i18n.addResourceBundle('en', 'flows', enFlows)

// 年度發起 (#12) 的介面文字（含導覽列連結）
i18n.addResourceBundle('zh-TW', 'launch', zhTWLaunch)
i18n.addResourceBundle('en', 'launch', enLaunch)

// 匯出 PDF (#7) 的介面文字；PDF 本身是繁中正本 (Q20)，不隨介面語言
i18n.addResourceBundle('zh-TW', 'pdf', zhTWPdf)
i18n.addResourceBundle('en', 'pdf', enPdf)

// 首頁「我參與的自評表」(#37)
i18n.addResourceBundle('zh-TW', 'home', zhTWHome)
i18n.addResourceBundle('en', 'home', enHome)

// 追蹤總覽 (#14)
i18n.addResourceBundle('zh-TW', 'tracking', zhTWTracking)
i18n.addResourceBundle('en', 'tracking', enTracking)

// 權限管理 (#58)
i18n.addResourceBundle('zh-TW', 'access', zhTWAccess)
i18n.addResourceBundle('en', 'access', enAccess)

// 自評表紀錄 (#164)
i18n.addResourceBundle('zh-TW', 'records', zhTWRecords)
i18n.addResourceBundle('en', 'records', enRecords)

// 分派填寫人 (#101)
i18n.addResourceBundle('zh-TW', 'assignment', zhTWAssignment)
i18n.addResourceBundle('en', 'assignment', enAssignment)

export default i18n
