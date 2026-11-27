import { Col, Row } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import { AppShell } from '../components/AppShell'
import { AssignmentReminder } from '../components/AssignmentReminder'
import { MyAssessmentsCard } from '../components/MyAssessmentsCard'
import { PageHeader } from '../components/PageHeader'
import { PlantProgressCard } from '../components/PlantProgressCard'
import { useSeesTracking } from '../hooks/useMyAuditRole'

/**
 * 首頁 (Q115): 我的自評表 for everyone; whoever sees 追蹤總覽 (稽核管理者, a 一般使用者 with 檢視廠區, 廠區負責人, Q117 (3), Q153) also gets
 * 各廠填單進度 beside it, about 3:2, and a 廠區負責人 with something to assign a reminder above them (#101). Like the menu, the role only decides what is shown; the database decides what each card's rows are.
 * 方向 A (#129).
 */
export function HomePage() {
  const { t } = useTranslation()
  const { session } = useAuth()
  const employee = session?.employee
  const tracking = useSeesTracking()
  const progress = tracking.sees

  const greeting = employee?.factory_code
    ? t('home.greeting', { name: employee.name ?? employee.emp_id, factory: employee.factory_code })
    : t('home.greetingNoFactory', { name: employee?.name ?? employee?.emp_id ?? '' })

  return (
    <AppShell>
      <PageHeader title={greeting} titleTestId="greeting" />
      <AssignmentReminder />
      {/* Laid out once the role is known, so a 稽核管理者's card does not start full width and then shrink. */}
      {!tracking.isLoading && (
        // Each card as tall as its own rows, as the mockup draws them.
        <Row gutter={[16, 16]} align="top" data-testid="home-cards">
          <Col xs={24} xl={progress ? 14 : 24}>
            <MyAssessmentsCard empId={employee?.emp_id} />
          </Col>
          {progress && (
            <Col xs={24} xl={10}>
              <PlantProgressCard />
            </Col>
          )}
        </Row>
      )}
    </AppShell>
  )
}
