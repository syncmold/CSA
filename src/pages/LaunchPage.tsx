import { Alert, Button, Card, ConfigProvider, DatePicker, Flex, Modal, Select, Spin, Table } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { DepartedSigner, LaunchCandidate } from '../api/launch'
import { AppShell } from '../components/AppShell'
import { EdgeTabs, TabLabel } from '../components/EdgeTabs'
import { Field } from '../components/Field'
import { InkDot } from '../components/InkDot'
import { PageHeader } from '../components/PageHeader'
import { YearBar } from '../components/YearBar'
import { actsAsAuditAdmin } from '../domain/access'
import { errorText } from '../domain/errors'
import { assignmentPath } from '../domain/assignment'
import {
  candidateKey,
  candidateProblem,
  departedFix,
  departedLabel,
  filterScope,
  isLaunched,
  isYearFull,
  launchRefusal,
  launchScope,
  launchSelection,
  plantLabel,
  byPlantOrder,
  plantOptions,
  STATUS_FILTERS,
  toCombos,
  uncheckAfter,
  type StatusFilter,
} from '../domain/launch'
import { launchProblems } from '../domain/routes'
import { writeErrorMessage } from '../domain/templates'
import { useLaunchCandidates, useLaunchCycle, useLaunchedCycles } from '../hooks/useLaunch'
import { useMyAuditRole } from '../hooks/useMyAuditRole'
import { usePlants } from '../hooks/usePlants'
import { useYearChoice } from '../hooks/useYearChoice'
import { NO_WRAP } from '../components/tableColumns'
import { CARD_BODY_STYLE, LIST_CARD_STYLE, palette, textSize } from '../theme'

/** Words that explain rather than say: the hint, the kept 截止日's note, the launched years, the count, what a route lacks. */
const MUTED: CSSProperties = { color: palette.textTertiary, fontSize: textSize(13) }
/** A 簽核流程 cell that takes the column's width without asking for more, so its row stays one line. */
const ONE_LINE_CELL: CSSProperties = { width: 0, minWidth: '100%', whiteSpace: 'nowrap' }
const NO_SHRINK: CSSProperties = { flexShrink: 0 }
/** Takes what is left of the line, at least 120px, else starts the next line. */
const ELLIPSIS: CSSProperties = { flex: '1 1 120px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }
/** What blocks the launch, set off from the table above it. */
const NOTE_STYLE: CSSProperties = { marginTop: 12 }
/**
 * Ticked rows stay white, as in the mockup: every combination starts ticked, so a tint would cover the whole list and
 * mark nothing.
 */
const TABLE_THEME = { components: { Table: { rowSelectedBg: palette.surface, rowSelectedHoverBg: palette.rowHoverBg } } }

/** A launch's outcome; a refusal for people who have left (Q147 (4)) names them under the text. */
type Outcome = { type: 'success' | 'warning' | 'error'; text: string; year: number; departed?: DepartedSigner[] }

/** The words of a first launch and of a top-up (Q119): the button, the confirmation and the outcome. */
const WORDING = {
  launch: { button: 'launch', title: 'confirmTitle', body: 'confirmBody', ok: 'confirmOk', done: 'done', doneUnchecked: 'doneUnchecked' },
  topUp: {
    button: 'topUp', title: 'confirmTopUpTitle', body: 'confirmTopUpBody', ok: 'confirmTopUpOk', done: 'topUpDone', doneUnchecked: 'topUpDoneUnchecked',
  },
} as const

/**
 * 年度發起 (#12): pick the year, 截止日 and 廠區, uncheck the 範本 × 廠區 combinations to leave out, launch. A year
 * that already has its 年度作業 can be topped up with the combinations not launched yet, keeping its 截止日 (Q119).
 * Every rule (which combinations exist, which routes can be launched, each combination once a year, who may launch)
 * is the database's (Q89); the page shows its answers and sends the checked combinations it shows.
 * Only 稽核管理者 get candidates back; anyone else sees an empty list (RLS), like the other /admin pages.
 *
 * 年度 (#175): the menu is on the next year to launch unless another was chosen; a launched year is topped up. A launch
 * refreshes the years (useLaunchCycle), so the menu gains the next one. 範本管理 and 簽核流程 have no 年度 (Q137 (2)):
 * launching freezes their current contents into each 自評表, and later edits only reach the next launch and top-ups.
 */
export function LaunchPage() {
  // common too: writeErrorMessage falls back to the shared templates.errors.generic message.
  const { t } = useTranslation(['launch', 'common'])
  const candidates = useLaunchCandidates()
  const cycles = useLaunchedCycles()
  const launch = useLaunchCycle()
  // For tidiness only: the 已發起 counts are RLS-filtered, so for anyone else they would be wrong.
  const role = useMyAuditRole()
  const [modal, modalHolder] = Modal.useModal()
  const { choice, choose, years } = useYearChoice()
  const [chosenDue, setChosenDue] = useState<Dayjs | null>(null)
  const [plants, setPlants] = useState<string[]>([])
  const [status, setStatus] = useState<StatusFilter>('all')
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  // 廠區照廠區主檔的順序（SyncHub 的順序），和其他頁面的廠區選單一致；範本列也依這個順序，同一廠區內照範本編號。
  const plantOrder = (usePlants().data ?? []).map((p) => p.id)
  const rows = byPlantOrder(candidates.data ?? [], plantOrder)
  // After a launch the page stays on its year to show the outcome, though the menu's default moves on to the next. Kept
  // here, not in the URL, so the other pages (and this one, opened again) still start on the next year (#175).
  const [launchedYear, setLaunchedYear] = useState<number | null>(null)
  const shown =
    choice && launchedYear !== null
      ? { ...choice, year: launchedYear, launched: choice.options.some((o) => o.year === launchedYear && o.launched) }
      : choice
  const year = shown?.year ?? null
  const existing = cycles.data?.find((c) => c.year === year)
  // One 截止日 a year: a top-up keeps the year's.
  const due = existing ? dayjs(existing.due_date) : chosenDue
  const full = isYearFull(rows, year)
  const { visible, selectable, picked, blocked, counts } = launchSelection(rows, { plants, status, unchecked, year })
  const wording = WORDING[existing ? 'topUp' : 'launch']
  // While a launch refreshes the lists, the rows it just issued may still look selectable, or the year not yet launched.
  const refreshing = candidates.isFetching || cycles.isFetching
  // Without the launched years the page cannot tell a top-up (its 截止日 kept) from a first launch.
  const ready =
    year !== null && cycles.data !== undefined && due !== null && !full && picked.length > 0 && blocked.length === 0 && !refreshing

  const confirmLaunch = () => {
    if (!ready) return
    const dueDate = due.format('YYYY-MM-DD')
    const combos = toCombos(picked)
    const issuedPerPlant = launchScope(t, picked, plantOrder)
    void modal.confirm({
      title: t(wording.title, { year }),
      content: (
        <Flex vertical gap={4} data-testid="launch-confirm">
          <span>{t('confirmScope', { scope: issuedPerPlant })}</span>
          <span>{t(wording.body, { count: combos.length, due: dueDate, year })}</span>
        </Flex>
      ),
      okText: t(wording.ok),
      cancelText: t('cancel'),
      onOk: async () => {
        // Keep the screen on this year: once launched the default moves on to the next and would hide the outcome.
        setLaunchedYear(year)
        try {
          const result = await launch.run(year, dueDate, combos)
          setOutcome(
            result.ok
              ? {
                  // Launched without OMS (Q147 (4)): nobody was checked for having left, so it reads as a warning.
                  type: result.checked ? 'success' : 'warning',
                  year,
                  text: t(WORDING[result.top_up ? 'topUp' : 'launch'][result.checked ? 'done' : 'doneUnchecked'], {
                    year, count: result.assessments, scope: issuedPerPlant, due: result.due_date,
                  }),
                }
              : { type: 'error', year, text: launchRefusal(t, year, result), ...(result.error === 'departed_signers' ? { departed: result.departed } : {}) },
          )
        } catch (error) {
          setOutcome({ type: 'error', year, text: writeErrorMessage(t, error, { '42501': 'launch:forbidden' }) })
        }
      },
    })
  }

  // Where the chosen year stands, under the title (使用者 2026-11-10: in the card it crowded the list). The outcome of
  // launching this year already says what it launched.
  const yearNote =
    outcome && outcome.year === year ? (
      <Alert
        type={outcome.type}
        showIcon
        title={outcome.text}
        description={outcome.departed && <DepartedList departed={outcome.departed} />}
        data-testid="launch-outcome"
      />
    ) : full && existing ? (
      <Alert type="warning" showIcon title={t('yearFull', { year, due: existing.due_date })} data-testid="year-full" />
    ) : (
      existing && (
        <Alert
          type="info"
          showIcon
          title={t('alreadyLaunched', { year, count: existing.assessments, due: existing.due_date })}
          data-testid="already-launched"
        />
      )
    )

  return (
    <AppShell>
      {modalHolder}
      {/*
        The hint right after the title on its line, and where the year stands under both (使用者 2026-11-10): the
        year's note reads before the card, as wide as its words.
      */}
      <Flex vertical align="flex-start" gap={8}>
        <Flex align="baseline" gap="4px 16px" wrap>
          <PageHeader title={t('title')} />
          <span style={MUTED}>{t('hint')}</span>
        </Flex>
        {years.isError && <Alert type="warning" showIcon title={t('common:years.loadError', { error: errorText(years.error) })} />}
        {shown ? (
          <YearBar
            choice={shown}
            onChange={(next) => {
              // Another year is another launch: nothing picked for this one carries over.
              setLaunchedYear(null)
              choose(next)
              setOutcome(null)
              setChosenDue(null)
              setUnchecked(new Set())
            }}
            // A launched year is topped up here: say what a top-up issues (使用者 2026-11-12). Whether it was
            // launched is read as the 截止日 is, from its 年度作業.
            note={t(existing ? 'topUpNote' : 'nextNote', { year: shown.year })}
          />
        ) : (
          !years.isError && <Spin size="small" />
        )}
        {yearNote}
      </Flex>
      {/* overflow clip instead of hidden: still clips the corners, but is no scroll box, so the bottom bar can stick. */}
      <Card style={{ ...LIST_CARD_STYLE, overflow: 'clip' }} styles={{ body: CARD_BODY_STYLE }}>
        {/*
          The toolbar: 截止日 and 廠區 on the left, the years already launched on the right (the 年度 is the menu above). 20px apart rather than
          the mockup's 24, as on 追蹤總覽, so a top-up year's fields still fit on one line at 1440px. Its own line only when the
          狀態 tabs right below, which draw theirs, are not shown.
        */}
        <Flex
          className="csa-edge-row"
          gap="12px 20px"
          wrap
          align="center"
          style={{ paddingBlock: 12, borderBottom: candidates.isError ? `1px solid ${palette.border}` : undefined }}
        >
          {existing ? (
            <Field label={t('dueDate')}>
              {/* The note may wrap on a phone; the date itself stays whole. */}
              <span data-testid="launch-due-kept" style={{ whiteSpace: 'normal' }}>
                <span style={{ color: palette.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{existing.due_date}</span>
                <span style={MUTED}>{t('dueKept', { year })}</span>
              </span>
            </Field>
          ) : (
            <Field as="label" label={t('dueDate')}>
              <DatePicker
                value={chosenDue}
                onChange={(v) => setChosenDue(v)}
                disabledDate={(d) => d.isBefore(dayjs(), 'day')}
                status={chosenDue ? undefined : 'warning'}
                placeholder={t('required')}
                data-testid="launch-due"
              />
            </Field>
          )}
          <Field label={t('plantFilter')}>
            <Select
              data-testid="launch-plants"
              aria-label={t('plantFilter')}
              style={{ minWidth: 240 }}
              mode="multiple"
              allowClear
              placeholder={t('allPlants')}
              value={plants}
              options={plantOptions(rows, plantOrder).map((p) => ({ value: p.plant_id, label: plantLabel(p) }))}
              showSearch={{ optionFilterProp: 'label' }}
              onChange={(ids: string[]) => {
                setPlants(ids)
                // A new scope is a new launch: the last one's outcome would hide what this year already has.
                setOutcome(null)
              }}
            />
          </Field>
          {actsAsAuditAdmin(role.data) && (
            <span data-testid="launched-years" style={{ ...MUTED, marginInlineStart: 'auto' }}>
              {cycles.data?.length
                ? t('launched') + cycles.data.map((c) => t('launchedItem', { year: c.year, count: c.assessments })).join(t('listSeparator'))
                : t('noneLaunched')}
            </span>
          )}
        </Flex>

        {/*
          Which combinations to show (使用者 2026-11-10), as tabs right above the table so they are seen: 可發起 alone, so
          全選 and 發起 leave out those whose route is not ready without unchecking them one by one. Like the 廠區, what a
          tab hides is not launched; each counts the chosen 廠區' combinations.
        */}
        {!candidates.isError && (
          <EdgeTabs
            data-testid="launch-status"
            activeKey={status}
            onChange={(key) => {
              setStatus(key as StatusFilter)
              setOutcome(null)
            }}
            // No count before the list is in: 0 would read as nothing to launch.
            items={STATUS_FILTERS.map((s) => ({ key: s, label: <TabLabel name={t(`status.${s}`)} count={candidates.isPending ? undefined : counts[s]} /> }))}
          />
        )}
        {candidates.isError ? (
          <Alert type="warning" showIcon title={errorText(candidates.error)} style={{ marginBlock: 12 }} />
        ) : (
          <ConfigProvider theme={TABLE_THEME}>
            <Table<LaunchCandidate>
              className="csa-edge-table"
              data-testid="launch-table"
              size="small"
              rowKey={candidateKey}
              loading={candidates.isPending}
              dataSource={visible}
              pagination={false}
              scroll={{ x: 760 }}
              locale={{ emptyText: t(rows.length ? 'emptyFiltered' : 'empty') }}
              // A combination launched this year is done with: its row in grey.
              onRow={(c) => (isLaunched(c, year) ? { style: { color: palette.textTertiary } } : {})}
              rowSelection={{
                selectedRowKeys: picked.map(candidateKey),
                getCheckboxProps: (c) => ({ disabled: isLaunched(c, year) }),
                onChange: (keys) => setUnchecked(uncheckAfter(unchecked, selectable, keys)),
              }}
              columns={[
                // 範本 and 廠區 take only their text's width; the rest goes to 簽核流程, so its problems stay on one line.
                {
                  title: t('template'),
                  key: 'template',
                  ...NO_WRAP,
                  render: (_, c) => t('templateLabel', { code: c.template_code, name: c.template_name }),
                },
                { title: t('plant'), key: 'plant', ...NO_WRAP, render: (_, c) => plantLabel(c) },
                { title: t('route'), key: 'route', render: (_, c) => <RouteCell candidate={c} launched={isLaunched(c, year)} /> },
              ]}
            />
          </ConfigProvider>
        )}

        {blocked.length > 0 && <Alert type="error" showIcon title={t('blocked', { count: blocked.length })} style={NOTE_STYLE} data-testid="launch-blocked" />}
        {/*
          The bottom bar: how many are ticked, and the button that launches them. It stays at the foot of the window while
          the list scrolls (user 2026-11-19: a year's list is a few hundred rows), and settles under the list at its end.
        */}
        <Flex
          className="csa-edge-row"
          justify="flex-end"
          align="center"
          gap={12}
          wrap
          style={{
            marginTop: 12,
            paddingBlock: 12,
            borderTop: `1px solid ${palette.border}`,
            position: 'sticky',
            bottom: 0,
            zIndex: 3,
            background: palette.surface,
          }}
          data-testid="launch-bar"
        >
          <span data-testid="launch-count" style={MUTED}>
            {t('selectedCount', { scope: filterScope(t, rows, plants, status, plantOrder), selected: picked.length, total: selectable.length })}
          </span>
          <Button type="primary" disabled={!ready} loading={launch.isPending} onClick={confirmLaunch} data-testid="launch-submit">
            {t(wording.button, { year: year ?? '', count: picked.length })}
          </Button>
        </Flex>
      </Card>
    </AppShell>
  )
}

/** Who on the routes has left (Q147 (4)), each with where to replace them: 分派填寫人, or 權限管理 for a 連動關卡. */
function DepartedList({ departed }: { departed: DepartedSigner[] }) {
  const { t } = useTranslation('launch')
  return (
    <ul style={{ margin: 0, paddingInlineStart: 18 }} data-testid="launch-departed">
      {departed.map((d) => {
        const fix = departedFix(d)
        return (
          <li key={`${d.step_id}:${d.emp_id}`}>
            {departedLabel(t, d)}
            <Link to={fix.to} style={{ marginInlineStart: 12 }}>
              {t(fix.label)} →
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * How each kind of problem is shown: its colour (red: nothing to launch with; orange: a route to finish or 分派), and
 * where to go to fix it. 還沒分派 (Q147) goes to the plant's 下次發出 on 分派填寫人.
 */
const PROBLEM_VIEW = {
  no_route: { ink: 'red', label: 'noRoute', fix: 'toFlows', to: () => '/admin/flows' },
  not_ready: { ink: 'orange', label: 'notReady', fix: 'fixRoute', to: (c: LaunchCandidate) => `/admin/flows/${c.route_id}` },
  unassigned: { ink: 'orange', label: 'unassigned', fix: 'toAssign', to: (c: LaunchCandidate) => assignmentPath(c.factory_code, 'next') },
  no_coordinator: { ink: 'orange', label: 'noCoordinator', fix: 'toAccess', to: () => '/admin/access' },
} as const

/** Whether the combination was launched this year or its route can be launched; if neither, why and where to fix it. */
function RouteCell({ candidate, launched }: { candidate: LaunchCandidate; launched: boolean }) {
  const { t } = useTranslation('launch')
  if (launched) {
    return (
      <span data-testid="candidate-launched">
        <InkDot ink="grey">{t('launchedTag')}</InkDot>
      </span>
    )
  }
  const problem = candidateProblem(candidate)
  if (problem === null) {
    return (
      <Flex gap={16} align="center" wrap data-testid="candidate-ready">
        <InkDot ink="green">{t('canLaunch')}</InkDot>
        {t('stepCount', { count: candidate.step_count })}
      </Flex>
    )
  }
  const view = PROBLEM_VIEW[problem]
  // A route with other faults besides 關卡 nobody is 分派 to: fixed in the 流程編輯器, and 分派 too.
  const alsoAssign = problem === 'not_ready' && !!candidate.launch_check?.unassigned_steps.length
  // 還沒分派 is said by its tag and link alone, without naming each 關卡; the route's other faults are still spelled out.
  const routeFaults = candidate.launch_check && !candidate.launch_check.ready
    ? launchProblems(t, { ...candidate.launch_check, unassigned_steps: [] })
    : []
  // One line per row: the cell does not widen the table (width 0, min 100%), and the faults are cut with … and shown
  // whole on hover. Only a column too narrow for the links themselves wraps.
  return (
    <Flex gap="0 16px" align="baseline" wrap style={ONE_LINE_CELL} data-testid={`candidate-${problem}`}>
      <InkDot ink={view.ink}>{t(view.label)}</InkDot>
      <Link to={view.to(candidate)} style={NO_SHRINK}>{t(view.fix)} →</Link>
      {alsoAssign && <Link to={PROBLEM_VIEW.unassigned.to(candidate)} style={NO_SHRINK}>{t(PROBLEM_VIEW.unassigned.fix)} →</Link>}
      {routeFaults.length > 0 && (
        <span style={{ ...MUTED, ...ELLIPSIS }} title={routeFaults.join(' ')}>{routeFaults.join(' ')}</span>
      )}
    </Flex>
  )
}
