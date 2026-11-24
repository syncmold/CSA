import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp, ConfigProvider } from 'antd'
import enUS from 'antd/locale/en_US'
import zhTW from 'antd/locale/zh_TW'
import { useTranslation } from 'react-i18next'
import { RouterProvider } from 'react-router'
import { AuthProvider } from './auth/AuthContext'
import { router } from './router'
import { antdTheme } from './theme'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

const ANTD_LOCALES = { 'zh-TW': zhTW, en: enUS } as const

export function App() {
  const { i18n } = useTranslation()
  const antdLocale = ANTD_LOCALES[i18n.language as keyof typeof ANTD_LOCALES] ?? zhTW

  return (
    <QueryClientProvider client={queryClient}>
      {/* A two-character button reads 新增, not antd's spaced-out 新 增 (#124, as the mockups write them). */}
      <ConfigProvider locale={antdLocale} theme={antdTheme} button={{ autoInsertSpace: false }}>
        {/* antd's App carries the theme's type and text colour to plain elements too. */}
        <AntApp>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  )
}
