import { Alert, Button, Card, ConfigProvider, Empty, Spin, Table, Tabs } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import type { MyAssessment } from '../api/myAssessmentsQuery'
import { errorText } from '../domain/errors'
import { dueLevel, firstTab, isMyTurn, MY_TABS, myStatus, myTabs, showsFillProgress, todoAction, type MyStatus, type MyTab } from '../domain/home'
import { useMyAssessments, useMyPastClosedCount } from '../hooks/useMyAssessments'
import { CARD_BODY_STYLE, CARD_STYLE, INK, palette, textSize } from '../theme'
import { TabLabel } from './EdgeTabs'
import { NO_WRAP } from './tableColumns'

/** 我參與的 lists this 年度's and the unfinished, 結案 included, so it pages; 待處理 is short. */
const ALL_PAGE_SIZE = 10
/** Each status in its meaning's colour (#118), as words. */
const STATUS_INK: Record<MyStatus, string> = { my_turn: INK.orange.color, upcoming: INK.grey.color, done: INK.blue.color, closed: INK.green.color }
/** Right under the tabs the table's header row is square, not rounded (使用者 2026-10-30). */
const SQUARE_HEADER_THEME = { components: { Table: { headerBorderRadius: 0 } } }
/** The tab row's height, its line included; 各廠填單進度's heading beside it is as tall. */
export const TAB_ROW_HEIGHT = 48

/**
 * 我的自評表 (Q115): one card for everyone, its tabs 待處理 and 我參與的. Whether a 自評表 waits for the employee to fill
 * in or to sign, the questions answered and the days to the 截止日 come from the database (view my_assessment); the
 * 關卡 are not shown, a 自行檢查人員 only fills in their own part. Opens on 待處理, or 我參與的 when nothing waits.
 * 我參與的 holds the latest 年度 and anything not yet 結案 (the database's on_home, Q124 (1)); a line under it leads
 * to 自評表紀錄 for the 往年已結案.
 * 方向 A (#129): underlined tabs beside the heading, the 截止日's warning and the statuses as coloured words.
 */
export function MyAssessmentsCard({ empId }: { empId: string | undefined }) {
  const { t } = useTranslation('home')
  const assessments = useMyAssessments(empId)
  const pastClosed = useMyPastClosedCount(empId)
  const [chosen, setChosen] = useState<MyTab | null>(null)
  const tabs = myTabs(assessments.data ?? [])
  const tab = chosen ?? firstTab(tabs)
  const columns = useColumns(tab, tab === 'todo' && showsFillProgress(tabs.todo))
  const heading = <span style={{ marginInlineEnd: 24, fontSize: textSize(15), fontWeight: 600, color: palette.text }}>{t('mine.title')}</span>

  const body = assessments.isPending ? (
    <Padded>
      <Spin />
    </Padded>
  ) : assessments.isError ? (
    <Padded>
      <Alert type="warning" showIcon title={errorText(assessments.error)} />
    </Padded>
  ) : tabs[tab].length === 0 ? (
    <Padded>
      <Empty description={<span data-testid={`my-${tab}-empty`}>{t(`mine.empty.${tab}`)}</span>} />
    </Padded>
  ) : (
    <ConfigProvider theme={SQUARE_HEADER_THEME}>
      <Table<MyAssessment>
        className="csa-edge-table csa-edge-bottom"
        data-testid={`my-${tab}`}
        rowKey="assessment_id"
        size="small"
        // A phone scrolls the table sideways rather than squeezing 自評表 to a few characters a line.
        scroll={{ x: 600 }}
        pagination={
          tab === 'all' ? { pageSize: ALL_PAGE_SIZE, hideOnSinglePage: true, showSizeChanger: false, style: { marginInline: 'var(--csa-card-pad)' } } : false
        }
        dataSource={tabs[tab]}
        columns={columns}
      />
    </ConfigProvider>
  )

  return (
    <Card style={CARD_STYLE} styles={{ body: CARD_BODY_STYLE }} data-testid="my-assessments-card">
      {assessments.isSuccess ? (
        // The heading shares the tab row; the underline sits on the row's line, which runs across the card.
        <Tabs
          activeKey={tab}
          onChange={(key) => setChosen(key as MyTab)}
          tabBarGutter={24}
          tabBarStyle={{ marginBottom: 0 }}
          classNames={{ header: 'csa-edge-row' }}
          tabBarExtraContent={{ left: heading }}
          items={MY_TABS.map((key) => ({
            key,
            label: <TabLabel name={t(`mine.tabs.${key}`)} count={tabs[key].length} testId={`my-tab-${key}`} />,
            // Only the open tab draws its list, inside its own panel.
            children: key === tab && (
              <>
                {body}
                {key === 'all' && <PastClosedLine count={pastClosed.data ?? 0} />}
              </>
            ),
          }))}
        />
      ) : (
        <>
          <div
            className="csa-edge-row"
            style={{ display: 'flex', alignItems: 'center', boxSizing: 'border-box', minHeight: TAB_ROW_HEIGHT, borderBottom: `1px solid ${palette.border}` }}
          >
            {heading}
          </div>
          {body}
        </>
      )}
    </Card>
  )
}

/** Under 我參與的: where the 往年已結案 went (Q124 (1)); nothing when there are none. */
function PastClosedLine({ count }: { count: number }) {
  const { t } = useTranslation('home')
  if (count === 0) return null
  return (
    <div className="csa-edge-row" style={{ paddingBlock: 12, borderTop: `1px solid ${palette.rowLine}`, fontSize: textSize(13) }}>
      <Link to="/records" data-testid="my-past-closed">
        {t('mine.pastClosed', { count })}
      </Link>
    </div>
  )
}

function Padded({ children }: { children: ReactNode }) {
  return <div style={{ paddingBlock: 'var(--csa-card-pad)' }}>{children}</div>
}

/** `withProgress`: 我的填寫進度 has a column, only when 待處理 has something to fill in. */
function useColumns(tab: MyTab, withProgress: boolean): ColumnsType<MyAssessment> {
  const { t } = useTranslation(['home', 'common'])
  const navigate = useNavigate()
  const first: ColumnsType<MyAssessment>[number] =
    tab === 'all'
      ? {
          title: t('mine.status'),
          key: 'status',
          ...NO_WRAP,
          render: (_, a) => {
            const status = myStatus(a)
            return <span style={{ color: STATUS_INK[status] }}>{t(`mine.statuses.${status}`)}</span>
          },
        }
      : {
          title: t('mine.action'),
          key: 'action',
          ...NO_WRAP,
          // The button tells filling in (primary: the longer job) from signing.
          render: (_, a) => {
            const action = todoAction(a)
            return (
              <Button type={action === 'sign' ? 'default' : 'primary'} size="small" data-testid="my-action" onClick={() => navigate(`/assessments/${a.assessment_id}`)}>
                {t(`mine.actions.${action}`)}
              </Button>
            )
          },
        }
  return [
    first,
    {
      title: t('mine.assessment'),
      key: 'assessment',
      render: (_, a) => {
        const heading = t('mine.heading', { year: a.year, plant: a.plant_name, code: a.template_code, name: a.template_name })
        // 尚未輪到我 and not yet visible (Q152): its 抬頭 only, opened once their 關卡 comes.
        return a.can_open ? (
          <Link to={`/assessments/${a.assessment_id}`} data-testid="my-assessment">
            {heading}
          </Link>
        ) : (
          <span title={t('mine.notOpenYet')} data-testid="my-assessment-unopened">
            {heading}
          </span>
        )
      },
    },
    {
      title: t('common:assessments.dueDate'),
      key: 'due',
      ...NO_WRAP,
      render: (_, a) => <DueDate assessment={a} />,
    },
    // A row to sign has no questions of the employee's, so its cell stays empty.
    ...(withProgress
      ? [{ title: t('mine.progress'), key: 'progress', ...NO_WRAP, render: (_: unknown, a: MyAssessment) => a.my_part === 'fill' && <FillProgress assessment={a} /> }]
      : []),
  ]
}

/** The 截止日, followed by 逾期 (red) or how close it is (orange) while the employee still has something to do on it. */
function DueDate({ assessment: a }: { assessment: MyAssessment }) {
  const { t } = useTranslation('home')
  const level = isMyTurn(a) ? dueLevel(a.due_in_days) : null
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {a.due_date}
      {level === 'overdue' && (
        <span style={{ marginInlineStart: 8, color: INK.red.color }} data-testid="due-overdue">
          {t('mine.overdue', { count: -a.due_in_days })}
        </span>
      )}
      {level === 'soon' && (
        <span style={{ marginInlineStart: 8, color: INK.orange.color }} data-testid="due-soon">
          {a.due_in_days === 0 ? t('mine.dueToday') : t('mine.dueIn', { count: a.due_in_days })}
        </span>
      )}
    </span>
  )
}

function FillProgress({ assessment: a }: { assessment: MyAssessment }) {
  const { t } = useTranslation('home')
  return (
    <span style={{ color: palette.textSecondary, fontVariantNumeric: 'tabular-nums' }} data-testid="my-progress">
      {a.my_started ? t('mine.answered', { answered: a.my_answered ?? 0, total: a.my_question_count ?? 0 }) : t('mine.notStarted')}
    </span>
  )
}
