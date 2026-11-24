import { ExportOutlined, LogoutOutlined, UpOutlined } from '@ant-design/icons'
import { Button, Flex, Popover } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import { env } from '../env'
import { useMyAuditRole } from '../hooks/useMyAuditRole'
import { INK, palette, textSize } from '../theme'
import { LanguageSwitcher } from './LanguageSwitcher'

const AVATAR = 32
/** One line, cut with an ellipsis: the English role names are longer than the menu's foot (#117). */
const ONE_LINE = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const

/**
 * The side menu's foot (Q114 (7), the user's choice B): who is signed in, as one row (`compact`, the folded menu:
 * the avatar alone). Clicking it opens the language, 回 SyncHub and 登出 above it, like an account menu.
 */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const { logout, session } = useAuth()
  const role = useMyAuditRole()
  const [open, setOpen] = useState(false)
  const employee = session?.employee
  const roleName = role.data ? t(`access:role.${role.data}`) : null
  const name = employee ? `${employee.name ?? employee.emp_id}（${employee.emp_id}）` : ''
  const avatar = (
    <span
      aria-hidden
      style={{ width: AVATAR, height: AVATAR, flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center', background: INK.grey.background, color: palette.textSecondary, fontWeight: 600, fontSize: textSize(13) }}
    >
      {(employee?.name ?? employee?.emp_id ?? '').slice(0, 1)}
    </span>
  )
  const item = { justifyContent: 'flex-start', paddingInline: 8 } as const

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement={compact ? 'rightBottom' : 'topLeft'}
      arrow={false}
      content={
        // At least the width the Chinese menu always had; wider when English needs it, so 「Language」 stays on one
        // line beside the switcher (#117; the switcher keeps its own buttons on one line, #137).
        <Flex vertical gap={2} style={{ minWidth: 200 }}>
          <Flex
            justify="space-between"
            align="center"
            gap={12}
            style={{ padding: '4px 8px', color: palette.textTertiary, whiteSpace: 'nowrap' }}
          >
            {t('app.language')}
            <LanguageSwitcher />
          </Flex>
          <Button type="text" block icon={<ExportOutlined />} href={env.synchubUrl} style={item} data-testid="back-to-synchub">
            {t('app.backToSyncHub')}
          </Button>
          <Button type="text" block danger icon={<LogoutOutlined />} onClick={logout} style={item} data-testid="logout">
            {t('app.logout')}
          </Button>
        </Flex>
      }
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={compact ? t('app.accountMenu', { name }) : undefined}
        data-testid="account-menu"
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: compact ? undefined : '100%', padding: compact ? 4 : '6px 8px',
          border: 'none', borderRadius: palette.radius, background: open ? palette.selectedBg : 'transparent',
          cursor: 'pointer', textAlign: 'start', font: 'inherit',
        }}
      >
        {avatar}
        {!compact && (
          <>
            <span style={{ flex: 1, minWidth: 0, fontSize: textSize(12), color: palette.textTertiary }} data-testid="signed-in-as">
              <span style={{ display: 'block', color: palette.text, fontWeight: 500 }}>{name}</span>
              {roleName && (
                <span style={ONE_LINE} title={roleName}>
                  {roleName}
                </span>
              )}
            </span>
            <UpOutlined style={{ fontSize: textSize(10), color: palette.textTertiary }} />
          </>
        )}
      </button>
    </Popover>
  )
}
