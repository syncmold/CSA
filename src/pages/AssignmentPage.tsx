import { Alert, Card, Col, Empty, Flex, Row, Select, Spin, Typography } from 'antd'
import dayjs from 'dayjs'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { PickerRow } from '../../exchange/core'
import type { AssignableStep, AssignmentForm, AssignmentRoute } from '../api/assignment'
import { AppShell } from '../components/AppShell'
import { AssignmentBranchCard, StepSigner, type AssignContext } from '../components/AssignmentBranchCard'
import { AssignmentSheetActions, importSummaryText, type ImportSummary } from '../components/AssignmentSheetActions'
import { Field } from '../components/Field'
import { PageHeader } from '../components/PageHeader'
import { useWriteToast } from '../components/useWriteToast'
import { ChoiceBar } from '../components/ChoiceBar'
import { actsAsAuditAdmin, readsSettings } from '../domain/access'
import {
  assignmentLayout,
  assignmentWriteError,
  assignmentYears,
  missingSteps,
  parseAssignmentYear,
  pickAssignmentYear,
  type AssignmentYear,
} from '../domain/assignment'
import { formSheetEntry, routeSheetEntry } from '../domain/assignmentSheet'
import { errorText } from '../domain/errors'
import { plantLabel } from '../domain/plantChoice'
import { nextLaunchYear } from '../domain/years'
import { formatSigner, nameInBranch } from '../domain/signoff'
import { useAssignablePlants, useAssignmentForms, useAssignmentRoutes, useAssignRouteStep, useAssignStep } from '../hooks/useAssignment'
import type { PickNote } from '../components/PlantEmployeeSelect'
import { useEmployees } from '../hooks/useEmployeeSearch'
import { useMyAuditRole } from '../hooks/useMyAuditRole'
import { usePlantChoice } from '../hooks/usePlantChoice'
import { useUrlParam } from '../hooks/useUrlParam'
import { INK, palette, textSize } from '../theme'

type Tab = 'todo' | 'all'

/** Side padding of the two cards (方向 A, #126, as the mockup): the list's rows and the detail's contents. */
const PAD = { list: 14, detail: 16 }

/**
 * A row of the list on the left: a 簽核流程 (下次發出) or an issued 自評表, with its 關卡 and where to open it (null: not
 * for this person).
 */
interface Entry {
  id: string
  template_code: string
  template_name: string
  steps: AssignableStep[]
  open: { to: string; label: string } | null
}

/**
 * 分派填寫人 (#101, Q116 (5)(7); Q147): a plant's 簽核流程 (下次發出) or its 自評表 of one 年度 on the left, the chosen
 * one's 分流 and 廠區經理人 on the right. Choosing a person is the save.
 *
 * 下次發出 (Q147, the default while the plant has routes a launch would issue): 分派 before the forms go out, by a 稽核主管
 * or the plant's 廠區管理員; the launch copies the routes' people onto the 自評表 and refuses while any 關卡 has nobody. An
 * issued 年度: only a 稽核主管 (or 系統維護員) replaces anyone, and the route follows for next year; a 廠區管理員 sees who
 * is on the forms as plain text.
 *
 * As with the other /admin pages the role decides only what is offered: the database decides what anyone sees and
 * writes, and hands anyone else an empty page. The 年度 and 廠區 sit in a bar under the title, as the 年度 bar of 範本管理
 * does (使用者 2026-11-13: at the right of the heading they went unnoticed), with the 截止日.
 */
export function AssignmentPage() {
  const { t } = useTranslation('assignment')
  const role = useMyAuditRole()
  const isChief = actsAsAuditAdmin(role.data)
  const plants = useAssignablePlants(isChief)
  const plantRows = plants.data ?? []
  const options = plantRows.map((p) => ({ key: p.factory_code, code: p.factory_code, name: p.name }))
  const [plant, choosePlant] = usePlantChoice(options, plants.isSuccess)
  const chosenPlant = plantRows.find((p) => p.factory_code === plant)
  const chosenOption = options.find((o) => o.key === plant)
  const forms = useAssignmentForms(chosenPlant?.id)
  const routes = useAssignmentRoutes(chosenPlant)
  const [yearParam, setYearParam] = useUrlParam('year')
  const allForms = forms.data ?? []
  const allRoutes = routes.data ?? []
  const loaded = forms.isSuccess && routes.isSuccess
  const year = loaded ? pickAssignmentYear(allForms, parseAssignmentYear(yearParam), allRoutes.length > 0) : null
  const next = year === 'next'
  const yearForms = next ? [] : allForms.filter((f) => f.annual_cycle.year === year)
  const choices: AssignmentYear[] = [...(allRoutes.length ? ['next' as const] : []), ...assignmentYears(allForms)]
  const due = yearForms[0]?.annual_cycle.due_date
  const pickPlant = options.length > 1
  const pickYear = choices.length > 1
  // Before the launch whoever has the plant here assigns (its 廠區管理員, or a 稽核主管); once the forms are out only a
  // 稽核主管 replaces anyone (Q147).
  const canChange = next || isChief
  const yearLabel = (y: AssignmentYear) => (y === 'next' ? t('next') : String(y))
  // The 年度 a 分派表 names: on 下次發出 the one the next launch is expected to be for this plant (the 年度 after its newest
  // issued one, else this year), so a file made before a launch, as the ones sent to the plants, imports to the routes.
  const sheetYear = typeof year === 'number' ? year : nextLaunchYear(assignmentYears(allForms), dayjs().year())
  // The banner after 匯入分派表 belongs to the plant and 年度 it was imported to.
  const [imported, setImported] = useState<{ at: string; summary: ImportSummary } | null>(null)
  const here = `${plant}:${year}`

  const entries: Entry[] = next
    ? allRoutes.map((r) => routeEntry(r, readsSettings(role.data) ? t('openRoute') : null))
    : yearForms.map((f) => formEntry(f, t('open')))

  return (
    <AppShell>
      <PageHeader title={t('title')} />
      {chosenOption && (
        // Under the title, as the 年度 bar of 範本管理, 簽核流程 and 年度發起 (使用者 2026-11-13). Both are always named:
        // a menu where there is a choice, plain text where there is one.
        <ChoiceBar
          label={t('choice')}
          testId="assignment-choice"
          noteTestId="assignment-choice-note"
          note={next ? t('choiceNote.next') : due && t(`choiceNote.${choiceNoteKey(pickYear, pickPlant)}`, { due })}
          actions={
            // 下載／匯入分派表 (#180): on 下次發出 the routes' people, imported by whoever 分派s there (Q147 (6)); on an
            // issued 年度 its forms', imported only by a 稽核主管.
            chosenPlant && entries.length > 0 && year !== null && (
              <AssignmentSheetActions
                plant={{ factoryCode: chosenPlant.factory_code, plantName: chosenPlant.name, next, year: sheetYear }}
                entries={next ? allRoutes.map(routeSheetEntry) : yearForms.map(formSheetEntry)}
                canImport={canChange}
                onImported={(summary) => setImported({ at: here, summary })}
              />
            )
          }
        >
          <Field label={t('year')}>
            {year !== null && pickYear ? (
              <Select
                value={year}
                onChange={(y: AssignmentYear) => setYearParam(String(y))}
                options={choices.map((y) => ({ value: y, label: yearLabel(y) }))}
                popupMatchSelectWidth={false}
                aria-label={t('year')}
                data-testid="assignment-year"
              />
            ) : (
              <strong style={{ color: palette.text }} data-testid="assignment-year">
                {year !== null && yearLabel(year)}
              </strong>
            )}
          </Field>
          <Field label={t('common:plants.pickerLabel')}>
            {pickPlant ? (
              <Select
                value={plant}
                onChange={(p: string) => choosePlant(p, (params) => params.delete('year'))}
                options={options.map((o) => ({ value: o.key, label: plantLabel(o) }))}
                showSearch={{ optionFilterProp: 'label' }}
                popupMatchSelectWidth={false}
                aria-label={t('common:plants.pickerLabel')}
                style={{ minWidth: 200 }}
                data-testid="assignment-plant"
              />
            ) : (
              <strong style={{ color: palette.text }} data-testid="assignment-plant">
                {plantLabel(chosenOption)}
              </strong>
            )}
          </Field>
        </ChoiceBar>
      )}
      {imported?.at === here && chosenPlant && (
        <Alert
          type="success"
          showIcon
          closable={{ onClose: () => setImported(null) }}
          title={importSummaryText(t, imported.summary, chosenPlant.factory_code)}
          data-testid="assignment-imported"
        />
      )}
      {forms.isError || routes.isError ? (
        <Alert type="warning" showIcon title={errorText(forms.error ?? routes.error)} />
      ) : plants.isSuccess && (options.length === 0 || (loaded && entries.length === 0)) ? (
        <Empty description={<span data-testid="assignment-empty">{t('empty')}</span>} />
      ) : chosenPlant && loaded ? (
        <EntriesAndBranches
          key={`${chosenPlant.id}:${year}`}
          entries={entries}
          heading={t(next ? 'routes' : 'forms')}
          factoryCode={chosenPlant.factory_code}
          onRoute={next}
          canChange={canChange}
        />
      ) : (
        <Spin />
      )}
    </AppShell>
  )
}

const routeEntry = (r: AssignmentRoute, openLabel: string | null): Entry => ({
  id: r.id,
  template_code: r.template_code,
  template_name: r.template_name,
  steps: r.route_step,
  open: openLabel ? { to: `/admin/flows/${r.id}`, label: openLabel } : null,
})

const formEntry = (f: AssignmentForm, openLabel: string): Entry => ({
  id: f.id,
  template_code: f.template_code,
  template_name: f.template_name,
  steps: f.assessment_step,
  open: { to: `/assessments/${f.id}`, label: openLabel },
})

/** Which of the 年度 and 廠區 can be changed, for the line in the bar: the 截止日, and what changing them does. */
function choiceNoteKey(pickYear: boolean, pickPlant: boolean): 'both' | 'year' | 'plant' | 'none' {
  if (pickYear && pickPlant) return 'both'
  if (pickYear) return 'year'
  return pickPlant ? 'plant' : 'none'
}

/**
 * The list of 簽核流程 or 自評表 (待分派 first when there are any) and the chosen one. Re-mounted per plant and 年度.
 * `onRoute`: the entries are routes (下次發出), assigned with assign_route_signer.
 */
function EntriesAndBranches({
  entries,
  heading,
  factoryCode,
  onRoute,
  canChange,
}: {
  entries: Entry[]
  heading: string
  factoryCode: string
  onRoute: boolean
  canChange: boolean
}) {
  const { t } = useTranslation('assignment')
  const todo = entries.filter((e) => missingSteps(e.steps) > 0)
  const [chosenTab, setTab] = useState<Tab>(todo.length ? 'todo' : 'all')
  const [chosenId, setChosenId] = useState<string | null>(null)
  // 全部分派好了，待分派這一頁空了，就看全部。
  const tab = chosenTab === 'todo' && todo.length === 0 ? 'all' : chosenTab
  const listed = tab === 'todo' ? todo : entries
  const chosen = entries.find((e) => e.id === chosenId) ?? listed[0]
  return (
    <Row gutter={[14, 14]} align="top">
      <Col xs={24} xl={7}>
        <Card style={{ overflow: 'hidden' }} styles={{ body: { padding: 0 } }}>
          {/*
            The heading and the two tabs share one row, underlined like 範本管理's (#120), and wrap rather than fold
            into 「⋯」 when the column is narrow (English at 1200px); the rows run to the card's edges.
          */}
          <Flex wrap align="center" gap="0 20px" style={{ paddingInline: PAD.list, borderBottom: `1px solid ${palette.border}` }}>
            <Typography.Title level={3} style={{ margin: 0, fontSize: textSize(14), fontWeight: 600 }}>
              {heading}
            </Typography.Title>
            <TabButton on={tab === 'todo'} onClick={() => setTab('todo')} testId="assignment-tab-todo">
              {t('tabs.todo', { count: todo.length })}
            </TabButton>
            <TabButton on={tab === 'all'} onClick={() => setTab('all')} testId="assignment-tab-all">
              {t('tabs.all', { count: entries.length })}
            </TabButton>
          </Flex>
          <Flex vertical data-testid="assignment-forms">
            {listed.map((entry, i) => (
              <EntryRow key={entry.id} entry={entry} chosen={entry.id === chosen?.id} last={i === listed.length - 1} onChoose={() => setChosenId(entry.id)} />
            ))}
          </Flex>
        </Card>
      </Col>
      <Col xs={24} xl={17}>
        {chosen && <EntryDetail entry={chosen} factoryCode={factoryCode} onRoute={onRoute} canChange={canChange} />}
      </Col>
    </Row>
  )
}

/** 待分派 or 全部: purple and underlined when chosen, as the mockup's tabs. */
function TabButton({ on, onClick, testId, children }: { on: boolean; onClick: () => void; testId: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      data-testid={testId}
      style={{
        padding: '10px 0 8px', border: 'none', borderBottom: `2px solid ${on ? palette.primary : 'transparent'}`, background: 'transparent',
        cursor: 'pointer', font: 'inherit', fontSize: textSize(13), fontWeight: on ? 600 : undefined, color: on ? palette.primary : palette.textSecondary,
      }}
    >
      {children}
    </button>
  )
}

/**
 * A route or 自評表 in the list, one line (~38px): its code and name, cut with … when too long (whole on hover), and
 * 差 n 關 in orange (待處理) or 已分派 in green on the right.
 */
function EntryRow({ entry, chosen, last, onChoose }: { entry: Entry; chosen: boolean; last: boolean; onChoose: () => void }) {
  const { t } = useTranslation('assignment')
  const missing = missingSteps(entry.steps)
  const [ink, status] = missing > 0 ? [INK.orange, t('missing', { count: missing })] : [INK.green, t('allAssigned')]
  return (
    <button
      type="button"
      onClick={onChoose}
      aria-pressed={chosen}
      data-testid={`assignment-form-${entry.template_code}`}
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, width: '100%', padding: `8px ${PAD.list}px`, textAlign: 'start',
        border: 'none', borderBottom: last ? 'none' : `1px solid ${palette.rowLine}`, cursor: 'pointer', font: 'inherit', color: palette.text,
        background: chosen ? palette.selectedBg : palette.surface,
      }}
    >
      <span
        style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={`${entry.template_code} ${entry.template_name}`}
      >
        <span style={{ fontSize: textSize(12), color: palette.textTertiary, fontVariantNumeric: 'tabular-nums', marginInlineEnd: 8 }}>{entry.template_code}</span>
        {entry.template_name}
      </span>
      <span style={{ flex: 'none', fontSize: textSize(12), color: ink.color }}>{status}</span>
    </button>
  )
}

/**
 * The 分流 cards: four to a row, each a quarter of the width whatever the count (auto-fill keeps the empty tracks);
 * fewer to a row once a quarter is under 170px (a name with its 工號 still fits), one on a phone.
 */
const BRANCH_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, max(170px, calc((100% - 3 * 12px) / 4))), 1fr))',
  gap: 12,
  alignItems: 'start',
}

/** What the detail says above the 分流: how 分派 works here, or that only a 稽核主管 replaces anyone once the forms are out. */
const hintKey = (onRoute: boolean, canChange: boolean) => (onRoute ? 'hintNext' : canChange ? 'hint' : 'hintReadOnly')

function EntryDetail({ entry, factoryCode, onRoute, canChange }: { entry: Entry; factoryCode: string; onRoute: boolean; canChange: boolean }) {
  const { t } = useTranslation('assignment')
  const { branches, merged } = assignmentLayout(entry.steps)
  const assignRoute = useAssignRouteStep()
  const assignIssued = useAssignStep()
  const { holder, withToast, messageApi } = useWriteToast((error) => assignmentWriteError(t, error, !onRoute))
  const people = useEmployees(entry.steps.flatMap((s) => s.signer_emp_id ?? []))

  const context: AssignContext = {
    factoryCode,
    canChange,
    person: (empId) => formatSigner(people.data?.get(empId)?.name, empId),
    onAssign: async (step: AssignableStep, row: PickerRow, notes: PickNote[]) => {
      const assigned = await withToast((onRoute ? assignRoute : assignIssued).run(step.id, row.emp_id, row.name))
      // What OMS pointed out about them (or that it could not be asked): said once they are on the 關卡.
      const person = formatSigner(row.name, row.emp_id)
      if (assigned) for (const note of notes) void messageApi.warning(t(`picker.assigned.${note}`, { person, plant: factoryCode, home: row.factory_code }), 8)
      return assigned
    },
  }

  return (
    <Card
      size="small"
      title={`${entry.template_code} ${entry.template_name}`}
      extra={
        entry.open && (
          <Link to={entry.open.to} style={{ fontSize: textSize(13) }} data-testid="assignment-open">
            {entry.open.label}
          </Link>
        )
      }
      styles={{ header: { paddingInline: PAD.detail }, body: { padding: `10px ${PAD.detail}px 14px` } }}
      data-testid="assignment-detail"
    >
      {holder}
      <Flex vertical gap={12}>
        <Typography.Text style={{ color: palette.textTertiary, fontSize: textSize(13) }} data-testid="assignment-hint">
          {t(hintKey(onRoute, canChange))}
        </Typography.Text>
        <div style={BRANCH_GRID}>
          {branches.map((branch) => (
            <AssignmentBranchCard key={branch.unit} branch={branch} context={context} />
          ))}
        </div>
        {/* 廠區經理人 after the 分流 meet: its name on the left, the person or the picker on the right. */}
        {merged.map((step) => (
          <Flex
            key={step.id}
            wrap
            justify="space-between"
            align="center"
            gap="8px 16px"
            style={{ padding: '8px 12px', border: `1px solid ${palette.border}`, borderRadius: palette.radius, fontSize: textSize(13) }}
            data-testid="assign-merged"
          >
            <span style={{ color: palette.textSecondary }}>{nameInBranch(step)}</span>
            <div style={{ flex: '0 1 280px', minWidth: 220 }}>
              <StepSigner step={step} context={context} />
            </div>
          </Flex>
        ))}
        {canChange && <Typography.Text style={{ color: palette.textTertiary, fontSize: textSize(13) }}>{t('footnote', { plant: factoryCode })}</Typography.Text>}
      </Flex>
    </Card>
  )
}
