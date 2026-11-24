import { Button, Flex } from 'antd'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { AssignmentTodo, Vacancy } from '../api/assignment'
import { assignmentPath } from '../domain/assignment'
import { stepLabel } from '../domain/signoff'
import { useAssignmentTodo } from '../hooks/useAssignment'
import { INK, palette, textSize } from '../theme'

/** A 部門主管 who leaves can empty many 自評表 at once, so the list stops here and the rest is a count. */
const LISTED_VACANCIES = 5

/** The 從缺 關卡 under a plant's reminder (#102). */
function VacancyList({ vacancies }: { vacancies: Vacancy[] }) {
  const { t } = useTranslation('assignment')
  if (vacancies.length === 0) return null
  const more = vacancies.length - LISTED_VACANCIES
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', color: palette.textSecondary }} data-testid="assignment-vacancies">
      {vacancies.slice(0, LISTED_VACANCIES).map((v) => (
        <li key={`${v.template_code}:${v.branch_unit_name}:${v.name}`}>
          {t('vacancy', { template: v.template_code, step: stepLabel(v), person: v.vacated_name ?? v.vacated_emp_id })}
        </li>
      ))}
      {more > 0 && <li>{t('moreVacancies', { more })}</li>}
    </ul>
  )
}

/** The 從缺 among an old 自評表's waiting 關卡 (#102); a route's 關卡 have none. */
const vacanciesOf = (row: AssignmentTodo): Vacancy[] =>
  row.pending.flatMap((p) => (p.vacated_emp_id ? [{ ...p, vacated_emp_id: p.vacated_emp_id, vacated_name: p.vacated_name ?? null }] : []))

/** Where the reminder leads: the plant on 分派填寫人, on 下次發出 for its routes or the 年度 of an old 自評表 (Q147). */
const assignmentLink = (row: AssignmentTodo) => assignmentPath(row.factory_code, row.year ?? 'next')

/**
 * 首頁's 待分派 reminder (#101, Q147): for a 廠區管理員, a line per plant whose 簽核流程 still have 關卡 without a 簽核人
 * (the forms cannot go out until they do); for a 稽核主管, a line per plant and 年度 with 自評表 issued before Q147 that
 * still wait, with whichever 關卡 are 從缺 under it. Each leads to 分派填寫人 and is gone once everything is assigned.
 * 方向 A (#129): a pale orange bar (提醒).
 */
export function AssignmentReminder() {
  const { t } = useTranslation('assignment')
  const todo = useAssignmentTodo()

  return (todo.data ?? []).map((row) => (
    <Flex
      key={`${row.kind}:${row.plant_id}:${row.year}`}
      wrap
      align="center"
      justify="space-between"
      gap="8px 16px"
      style={{ background: INK.orange.background, border: `1px solid ${INK.orange.border}`, borderRadius: palette.radius, padding: '10px 14px', fontSize: textSize(13) }}
      data-testid="assignment-reminder"
    >
      <Flex vertical gap={2}>
        <span style={{ fontWeight: 500 }}>
          {t(row.kind === 'route' ? 'reminderRoutes' : 'reminder', { plant: `${row.factory_code} ${row.plant_name}`, year: row.year, count: row.forms })}
        </span>
        <VacancyList vacancies={vacanciesOf(row)} />
      </Flex>
      <Link to={assignmentLink(row)} data-testid="assignment-reminder-link">
        <Button type="primary" tabIndex={-1}>{t('toAssign')}</Button>
      </Link>
    </Flex>
  ))
}
