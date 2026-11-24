import { Alert, Button, Card, Flex, Form, Input, Typography } from 'antd'
import { useState, type CSSProperties } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Navigate, useNavigate } from 'react-router'
import { ADMIN_EMAIL } from '../../exchange/adminAccount'
import { useAuth } from '../auth/AuthContext'
import { LoginCard } from '../components/LoginCard'
import { env } from '../env'
import { useExchangeStatus } from '../hooks/useExchangeStatus'
import { INK, palette, textSize } from '../theme'

interface LoginFormValues {
  account: string
  password: string
}

/** The card's two faces (#161): employees by 工號 or Email, and 🔑 管理員登入 for OMS's 系統管理帳號. */
type Face = 'employee' | 'admin'

export function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { session, login, loginAs } = useAuth()
  const [face, setFace] = useState<Face>('employee')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [mustChange, setMustChange] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [devEmpId, setDevEmpId] = useState('')
  const [devErrorKey, setDevErrorKey] = useState<string | null>(null)
  const [devSubmitting, setDevSubmitting] = useState(false)

  const exchangeStatus = useExchangeStatus()

  if (session) return <Navigate to="/" replace />

  // The exchange tells the 管理員帳號 from an employee by the Email OMS verified, so either face signs in the same way;
  // an employee using the 管理員 face is still just an employee. Switching faces drops the other face's messages.
  const switchTo = (next: Face) => {
    setFace(next)
    setErrorKey(null)
    setMustChange(false)
  }

  // Both faces answer a missing field the way OMS answers a wrong one.
  const required = [{ required: true, message: t('login.error.invalidCredentials') }]

  const onFinish = async (values: LoginFormValues) => {
    setSubmitting(true)
    setErrorKey(null)
    setMustChange(false)
    try {
      const outcome = await login(values.account, values.password)
      if (outcome.kind === 'ok') navigate('/', { replace: true })
      else if (outcome.kind === 'mustChange') setMustChange(true)
      else setErrorKey(outcome.messageKey)
    } finally {
      setSubmitting(false)
    }
  }

  // Q82 開發期直接登入: the server asks OMS's channel, which answers in OMS's own spelling whatever the case typed.
  const onDevLogin = async () => {
    const empId = devEmpId.trim()
    if (!empId) return
    setDevSubmitting(true)
    setDevErrorKey(null)
    try {
      const outcome = await loginAs(empId)
      if (outcome.kind === 'ok') navigate('/', { replace: true })
      else if (outcome.kind === 'error') setDevErrorKey(outcome.messageKey)
    } finally {
      setDevSubmitting(false)
    }
  }

  return (
    <LoginCard>
      {exchangeStatus.data?.accessAll && (
        <Alert type="warning" showIcon title={t('login.devAccessAll')} style={{ marginBottom: 16 }} />
      )}

      {face === 'admin' && (
        <div data-testid="admin-face" style={{ marginBottom: 12 }}>
          <Typography.Title level={2} style={{ margin: 0, fontSize: textSize(14), lineHeight: 1.5 }}>
            {t('login.admin.title')}
          </Typography.Title>
          <Typography.Text style={{ fontSize: textSize(11), color: palette.textTertiary }}>{t('login.admin.subtitle')}</Typography.Text>
        </div>
      )}

      {mustChange ? (
        // Orange, as 方向 A marks what waits on you (a reminder), like the 開發期 notices.
        <Alert
          type="warning"
          showIcon
          data-testid="must-change"
          title={t('login.mustChange.title')}
          description={t('login.mustChange.body')}
          action={
            <Button type="primary" href={env.synchubUrl} target="_blank" rel="noreferrer">
              {t('login.mustChange.go')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {/* Above the fields and in red words, as on the other SyncHub systems' cards (Q123, mockup ③). */}
      {errorKey ? (
        <Alert
          type="error"
          data-testid="login-error"
          title={<span style={{ color: INK.red.color }}>{t(errorKey)}</span>}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Form<LoginFormValues>
        key={face}
        layout="vertical"
        onFinish={onFinish}
        requiredMark={false}
        initialValues={face === 'admin' ? { account: ADMIN_EMAIL } : undefined}
      >
        {face === 'admin' ? (
          <Form.Item name="account" label={t('login.admin.email')} rules={required}>
            <Input autoComplete="username" />
          </Form.Item>
        ) : (
          // No 姓名／廠區 hint under the 工號 (Q133 (5)): OMS no longer lets anyone look people up before signing in.
          <Form.Item name="account" label={t('login.account')} rules={required}>
            <Input autoComplete="username" placeholder={t('login.accountPlaceholder')} />
          </Form.Item>
        )}
        <Form.Item
          name="password"
          label={t('login.password')}
          rules={required}
        >
          {/* The Email is already there on the 管理員 face, so the password is where typing starts. */}
          <Input.Password autoComplete="current-password" autoFocus={face === 'admin'} />
        </Form.Item>

        <Button
          type="primary"
          htmlType="submit"
          size="large"
          block
          loading={submitting}
          data-testid="login-submit"
          style={{ fontWeight: 700 }}
        >
          {t('login.submit')}
        </Button>
      </Form>

      {face === 'admin' ? (
        <div style={FACE_LINK}>
          <Typography.Link data-testid="employee-login-link" onClick={() => switchTo('employee')}>
            {t('login.admin.back')}
          </Typography.Link>
        </div>
      ) : (
        <>
          <Typography.Paragraph
            data-testid="login-help"
            style={{ margin: '14px 0 0', textAlign: 'center', lineHeight: 1.75, fontSize: textSize(11), color: palette.textTertiary }}
          >
            <Trans i18nKey="login.help" components={{ b: <strong style={{ color: palette.textSecondary }} />, br: <br /> }} />
          </Typography.Paragraph>
          <div style={FACE_LINK}>
            <Typography.Link data-testid="admin-login-link" onClick={() => switchTo('admin')}>
              {t('login.admin.link')}
            </Typography.Link>
          </div>
        </>
      )}

      {face === 'employee' && exchangeStatus.data?.devLogin && (
        // An orange edge, as 方向 A marks a reminder; the title wraps rather than cut off at phone width in English.
        <Card
          size="small"
          title={t('login.devLogin.title')}
          style={{ marginTop: 16, borderColor: INK.orange.border }}
          styles={{ title: { whiteSpace: 'normal' } }}
          data-testid="dev-login"
        >
          <Alert type="warning" showIcon title={t('login.devLogin.hint')} style={{ marginBottom: 12 }} />
          <Flex gap={8}>
            <Input
              value={devEmpId}
              placeholder={t('login.devLogin.empId')}
              onChange={(event) => setDevEmpId(event.target.value)}
              onPressEnter={() => void onDevLogin()}
              data-testid="dev-login-emp"
            />
            <Button onClick={() => void onDevLogin()} loading={devSubmitting} data-testid="dev-login-submit">
              {t('login.devLogin.submit')}
            </Button>
          </Flex>
          {devErrorKey ? (
            <Typography.Text type="danger" data-testid="dev-login-error" style={{ display: 'block', marginTop: 8 }}>
              {t(devErrorKey)}
            </Typography.Text>
          ) : null}
        </Card>
      )}
    </LoginCard>
  )
}

/** The link that turns the card to the other face, centred under the face's last line. */
const FACE_LINK: CSSProperties = { marginTop: 10, textAlign: 'center', fontSize: textSize(11) }
