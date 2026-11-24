import { Card, Flex, Typography } from 'antd'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { env } from '../env'
import groupLogoUrl from '../assets/syncmold-logo.jpg'
import { INK, palette, textSize } from '../theme'
import { LanguageSwitcher } from './LanguageSwitcher'

/** The same in every language, as on the other SyncHub systems' cards (Q123 (1)). */
const SUBTITLE = 'Control Self-Assessment · SyncHub'
const OFFICE = 'DIGITAL TRANSFORMATION OFFICE · 2026'

/**
 * The 登入 card laid out like the other SyncHub systems' (GHG's, Q123): the language buttons, the brand (集團 Logo,
 * 系統名稱, 系統版本, the 環境 label) and the way back to SyncHub stay put, and `children` is the face between them,
 * so a second face (🔑 管理員登入, #161) only swaps what goes in the middle. The page keeps its gradient and the
 * purple (Q121): the gradient is the one exception to 方向 A's no gradients (使用者 2026-11-09).
 */
export function LoginCard({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <Flex vertical align="center" justify="center" style={{ minHeight: '100vh', padding: 16, background: palette.loginBackground }}>
      <Card style={{ width: '100%', maxWidth: 420 }} styles={{ body: { padding: '16px 28px 18px' } }}>
        {/* On its own line, so on a narrow phone it never sits over the Logo, and its buttons stay on one line (#137). */}
        <Flex justify="flex-end">
          <LanguageSwitcher />
        </Flex>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <img src={groupLogoUrl} alt={t('login.logoAlt')} style={{ height: 58 }} />
          {/* Purple, as in the mockup the user approved (2026-11-11): beside the gradient, the one place purple is
              not a button, a selection or a link. */}
          <Typography.Title
            level={1}
            style={{ margin: '10px 0 0', fontSize: textSize(19), lineHeight: 1.4, color: palette.primary }}
          >
            {t('login.systemName')}
          </Typography.Title>
          <Typography.Text style={{ display: 'block', marginTop: 4, fontSize: textSize(11), color: palette.textTertiary }}>
            {SUBTITLE}
          </Typography.Text>
          <Typography.Text data-testid="system-version" style={{ display: 'block', marginTop: 2, fontSize: textSize(10), color: palette.loginVersion }}>
            {env.commit
              ? t('login.version', { version: env.version, commit: env.commit })
              : t('login.versionNoCommit', { version: env.version })}
          </Typography.Text>
          {env.envLabel && (
            // Orange, as 方向 A marks what to watch out for: this is not the real system.
            <Typography.Text
              data-testid="env-label"
              style={{
                display: 'inline-block',
                marginTop: 8,
                padding: '1px 8px',
                borderRadius: palette.radius,
                fontSize: textSize(10),
                color: INK.orange.color,
                background: INK.orange.background,
              }}
            >
              {env.envLabel}
            </Typography.Text>
          )}
        </div>

        {children}

        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${palette.rowLine}`, textAlign: 'center' }}>
          <Typography.Link href={env.synchubUrl} data-testid="back-to-synchub" style={{ color: palette.textTertiary }}>
            {t('login.backToSyncHub')}
          </Typography.Link>
          {/* Decoration, like the other systems' cards: a screen reader skips it. */}
          <div aria-hidden style={{ marginTop: 10, fontSize: textSize(8), letterSpacing: 2, color: palette.loginOffice }}>
            {OFFICE}
          </div>
        </div>
      </Card>
    </Flex>
  )
}
