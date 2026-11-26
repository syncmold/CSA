import { DownloadOutlined, UploadOutlined } from '@ant-design/icons'
import type { TFunction } from 'i18next'
import { Alert, Button, Checkbox, Flex, Modal, Spin, Table, Typography } from 'antd'
import { useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { OmsMatchError } from '../api/assignmentImport'
import { assignmentWriteError } from '../domain/assignment'
import {
  assignmentSheet,
  checkSheet,
  importPlan,
  lacksCsa, unlisted,
  OTHER_PLANT_WARNING_SHARE,
  type FileClaim,
  type ImportPlan,
  type OmsAnswer,
  type OmsStatus,
  type PagePlant,
  type SheetCheck,
  type SheetEntry,
} from '../domain/assignmentSheet'
import { errorText } from '../domain/errors'
import { useImportAssignment, useImportRouteAssignment, useOmsMatch } from '../hooks/useAssignment'
import { loadChunk } from '../loadChunk'
import { INK, palette, textSize, type Ink } from '../theme'

/** What the page's banner says after 確認匯入. */
export interface ImportSummary {
  fileName: string
  written: number
  skipped: number
  counts: Record<OmsStatus, number>
  /** People OMS has not let use CSA yet; written unless csaRequired (Q133 (4)). */
  noCsa: number
  /** People not on the 放行名單: never written (Q150). */
  notListed: number
  csaRequired: boolean
  bulkConfirmed: boolean
  /** Rows left out: 自評表 not issued yet (an import after they are writes them), or on 下次發出 範本 not issued here. */
  notIssued: number
  /** Imported to 下次發出 (the 簽核流程). */
  next: boolean
}

interface Review {
  fileName: string
  check: SheetCheck
  /** The OMS answer for 第 4 項, once 第 1～3 項 passed: still asking, the plan, or why it failed. */
  oms?: { state: 'pending' } | { state: 'done'; plan: ImportPlan } | { state: 'failed'; message: string }
}

const loadWorkbook = () => loadChunk(() => import('../excel/assignmentWorkbook'))

/**
 * 下載分派表／匯入分派表 (#180, Q130; Q147 (6)) in the 年度 and 廠區 bar: the plant's 簽核流程 (`plant.next`, 下次發出)
 * or its 自評表 of the 年度 as an .xlsx, and an uploaded one checked (第 1～3 項 here, 第 4 項 by OMS through the CSA
 * backend) and previewed before anything is written. 下載 for whoever the page shows a plant to; 匯入 only with
 * `canImport`: on 下次發出 a 稽核主管 or the plant's 廠區管理員 (written to the routes by assign_route_signer), once the
 * forms are out only a 稽核主管 (assign_step_signer, which writes the route too). The database decides either way.
 */
export function AssignmentSheetActions({
  plant,
  entries,
  canImport,
  onImported,
}: {
  plant: PagePlant
  entries: SheetEntry[]
  canImport: boolean
  onImported: (summary: ImportSummary) => void
}) {
  const { t } = useTranslation('assignment')
  const input = useRef<HTMLInputElement>(null)
  const [downloading, setDownloading] = useState(false)
  const [review, setReview] = useState<Review | null>(null)
  const matchWithOms = useOmsMatch()
  // Which upload the preview shows: an OMS answer for an earlier one, or for one closed meanwhile, is dropped.
  const current = useRef(0)
  const show = (next: Review | null) => {
    current.current++
    setReview(next)
  }

  const download = async () => {
    setDownloading(true)
    try {
      const { downloadAssignmentWorkbook } = await loadWorkbook()
      await downloadAssignmentWorkbook(assignmentSheet(plant, plant.year, entries, new Date(), plant.next))
    } finally {
      setDownloading(false)
    }
  }

  const upload = async (file: File) => {
    let check: SheetCheck
    try {
      const { readWorkbook } = await loadWorkbook()
      check = checkSheet(await readWorkbook(file), plant, entries)
    } catch {
      // Not an .xlsx at all: nothing in it says which plant it is for.
      check = { stop: 1, claim: { title: null, system: null } }
    }
    const fileName = file.name
    if (check.stop !== null) return show({ fileName, check })
    show({ fileName, check, oms: { state: 'pending' } })
    const asked = current.current
    let oms: Review['oms']
    try {
      const { answers, csaRequired } = check.people.length
        ? await matchWithOms(plant.factoryCode, check.people)
        : { answers: new Map<string, OmsAnswer>(), csaRequired: false }
      oms = { state: 'done', plan: importPlan(check.cells, answers, csaRequired) }
    } catch (error) {
      const message = error instanceof OmsMatchError ? t([`sheet.omsErrors.${error.message}`, 'sheet.omsErrors.other'], { code: error.message }) : errorText(error)
      oms = { state: 'failed', message }
    }
    if (current.current === asked) setReview({ fileName, check, oms })
  }

  return (
    <Flex gap={8} wrap>
      <Button icon={<DownloadOutlined />} loading={downloading} onClick={() => void download()} data-testid="assignment-download">
        {t('sheet.download')}
      </Button>
      {canImport && (
        <Button type="primary" icon={<UploadOutlined />} onClick={() => input.current?.click()} data-testid="assignment-import">
          {t('sheet.import')}
        </Button>
      )}
      <input
        ref={input}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        hidden
        data-testid="assignment-import-file"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = '' // the same file again after fixing it
          if (file) void upload(file)
        }}
      />
      {review && (
        <ImportReview
          review={review}
          plant={plant}
          onRedownload={() => void download()}
          onClose={() => show(null)}
          onImported={(summary) => {
            show(null)
            onImported(summary)
          }}
        />
      )}
    </Flex>
  )
}

function ImportReview({
  review,
  plant,
  onRedownload,
  onClose,
  onImported,
}: {
  review: Review
  plant: PagePlant
  onRedownload: () => void
  onClose: () => void
  onImported: (summary: ImportSummary) => void
}) {
  const { t } = useTranslation('assignment')
  const writeForms = useImportAssignment()
  const writeRoutes = useImportRouteAssignment()
  const write = plant.next ? writeRoutes : writeForms
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { check, oms } = review
  const plan = oms?.state === 'done' ? oms.plan : null
  const stopped = check.stop !== null
  const ready = plan !== null && (!plan.bulkWarning || confirmed)

  const confirm = async () => {
    if (!plan) return
    setError(null)
    try {
      const { written, skipped } = await write.run(plan.writes)
      const notIssued = check.stop === null ? check.notIssued.length : 0
      onImported({
        fileName: review.fileName, written, skipped, counts: plan.counts, noCsa: plan.noCsa, notListed: plan.notListed, csaRequired: plan.csaRequired, bulkConfirmed: plan.bulkWarning, notIssued,
        next: plant.next === true,
      })
    } catch (e) {
      setError(assignmentWriteError(t, e, !plant.next))
    }
  }

  return (
    <Modal
      open
      width={920}
      title={
        <Flex wrap justify="space-between" align="baseline" gap="4px 12px" style={{ paddingInlineEnd: 28 }}>
          <span>{t('sheet.review.title')}</span>
          <span style={{ fontWeight: 400, fontSize: textSize(13), color: palette.textTertiary }}>
            {t(k(plant, 'sheet.review.file'), { file: review.fileName, plant: plantName(plant), year: plant.year })}
          </span>
        </Flex>
      }
      onCancel={onClose}
      footer={
        <Flex wrap justify="space-between" align="center" gap={10}>
          <span style={{ color: palette.textTertiary, fontSize: textSize(13), textAlign: 'start', flex: '1 1 300px' }} data-testid="import-foot">
            {stopped ? t('sheet.review.footStopped', { plant: plant.factoryCode }) : t(k(plant, 'sheet.review.foot'))}
          </span>
          <Flex gap={8}>
            <Button onClick={onClose} data-testid="import-close">
              {stopped ? t('sheet.review.close') : t('sheet.review.cancel')}
            </Button>
            {(check.stop === 2 || check.stop === 3) && (
              <Button onClick={onRedownload} data-testid="import-redownload">
                {t('sheet.review.redownload')}
              </Button>
            )}
            {!stopped && (
              <Button type="primary" disabled={!ready} loading={write.isPending} onClick={() => void confirm()} data-testid="import-confirm">
                {t('sheet.review.confirm')}
              </Button>
            )}
          </Flex>
        </Flex>
      }
      data-testid="import-review"
    >
      <Flex vertical gap={12}>
        <Checks review={review} plant={plant} />
        {check.stop === null && check.notIssued.length > 0 && <NotIssuedBox rows={check.notIssued} plant={plant} />}
        {check.stop !== null && <StopBox check={check} plant={plant} />}
        {plan && check.stop === null && (
          <People plan={plan} plant={plant} confirmed={confirmed} onConfirm={setConfirmed} />
        )}
        {error && <Alert type="error" showIcon title={error} data-testid="import-error" />}
      </Flex>
    </Modal>
  )
}

const plantName = (plant: PagePlant) => `${plant.factoryCode} ${plant.plantName}`
/** The key of what is said differently on 下次發出 (the 簽核流程, Q147): the same key ending in Next. */
const k = (plant: PagePlant, key: string) => (plant.next ? `${key}Next` : key)
const claimText = (claim: { factoryCode: string; year: number }) => `${claim.factoryCode}｜${claim.year}`

type Mark = 'ok' | 'bad' | 'warn' | 'skip' | 'pending'
const MARK: Record<Mark, { icon: ReactNode; ink: Ink | null }> = {
  ok: { icon: '✓', ink: 'green' },
  bad: { icon: '✗', ink: 'red' },
  warn: { icon: '!', ink: 'orange' },
  skip: { icon: '–', ink: null },
  pending: { icon: <Spin size="small" />, ink: null },
}

/** The four checks in order, each passed, stopped at, not reached, or (第 4 項) waiting for OMS. */
function Checks({ review, plant }: { review: Review; plant: PagePlant }) {
  const { t } = useTranslation('assignment')
  const { check, oms } = review
  const vars = { plant: plant.factoryCode, year: plant.year }
  const rows: { mark: Mark; text: string }[] = [1, 2, 3].map((n) => {
    if (check.stop !== null && n > check.stop) return { mark: 'skip', text: t('sheet.checks.skipped') }
    if (check.stop === n) return { mark: 'bad', text: stopSummary(t, check, plant) }
    if (n === 3 && check.stop === null && check.notIssued.length) {
      return { mark: 'warn', text: t(k(plant, 'sheet.checks.ok3NotIssued'), { ...vars, count: check.rows, later: check.notIssued.length }) }
    }
    const key = `sheet.checks.ok${n}`
    return { mark: 'ok', text: t(n === 2 ? key : k(plant, key), { ...vars, count: check.stop === null ? check.rows : 0 }) }
  })
  if (check.stop !== null || !oms) rows.push({ mark: 'skip', text: t('sheet.checks.skipped') })
  else if (oms.state === 'pending') rows.push({ mark: 'pending', text: t('sheet.checks.asking') })
  else if (oms.state === 'failed') rows.push({ mark: 'bad', text: t('sheet.checks.omsFailed', { message: oms.message }) })
  else {
    const { people, counts, bulkWarning } = oms.plan
    const simple = people.filter(nothingToPointOut).length
    const rest = people.length - simple
    rows.push(
      bulkWarning
        ? { mark: 'warn', text: t('sheet.checks.bulk', { ...vars, count: counts.other_plant, total: people.length, percent: Math.round(OTHER_PLANT_WARNING_SHARE * 100) }) }
        : rest
          ? { mark: 'warn', text: t('sheet.checks.someToSee', { ok: simple, rest }) }
          : { mark: 'ok', text: people.length ? t('sheet.checks.allMatched', { count: people.length }) : t('sheet.checks.noPeople') },
    )
  }
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${palette.border}`, borderRadius: palette.radius }} data-testid="import-checks">
      {rows.map(({ mark, text }, i) => {
        const { icon, ink } = MARK[mark]
        const color = ink ? INK[ink].color : mark === 'skip' ? palette.dashed : palette.textSecondary
        return (
          <li
            key={i}
            data-testid={`import-check-${i + 1}`}
            data-mark={mark}
            style={{
              display: 'grid', gridTemplateColumns: '22px minmax(96px, 120px) 1fr', gap: 10, alignItems: 'baseline', padding: '7px 12px',
              borderBottom: i < 3 ? `1px solid ${palette.rowLine}` : undefined, fontSize: textSize(13.5),
            }}
          >
            <span style={{ fontWeight: 700, textAlign: 'center', color }}>{icon}</span>
            <span style={{ fontWeight: 500, color: mark === 'skip' ? color : palette.text }}>{`${i + 1}　${t(i === 2 ? k(plant, 'sheet.checks.name3') : `sheet.checks.name${i + 1}`)}`}</span>
            <span style={{ color: mark === 'ok' || mark === 'pending' ? palette.textSecondary : color }}>{text}</span>
          </li>
        )
      })}
    </ol>
  )
}

type T = TFunction

/** Whose file it claims to be: the 系統資料 if it has one, else row 1. */
const claimOf = (claim: FileClaim) => claim.system ?? claim.title

function stopSummary(t: T, check: Exclude<SheetCheck, { stop: null }>, plant: PagePlant): string {
  if (check.stop === 1) {
    const claim = claimOf(check.claim)
    return claim ? t(k(plant, 'sheet.checks.bad1'), { file: claimText(claim), plant: plant.factoryCode, year: plant.year }) : t('sheet.checks.notOurs')
  }
  if (check.stop === 2) return t('sheet.checks.bad2', { count: check.missing.length + check.unknown.length + check.unnamed.length + (check.expired ? 1 : 0) })
  return t(k(plant, 'sheet.checks.bad3'), { count: check.rows.length, plant: plant.factoryCode, year: plant.year })
}

/** Why the file stops, item by item, and what to do: 整份不匯入. */
function StopBox({ check, plant }: { check: Exclude<SheetCheck, { stop: null }>; plant: PagePlant }) {
  const { t } = useTranslation('assignment')
  const vars = { plant: plant.factoryCode, year: plant.year }
  let title: string
  let items: string[]
  let fix: string
  if (check.stop === 1) {
    const { title: row1, system } = check.claim
    const claim = claimOf(check.claim)
    if (!claim || !row1 || !system) {
      title = t('sheet.stop.notOursTitle')
      items = [t('sheet.stop.notOursItem')]
      fix = t('sheet.stop.notOursFix')
    } else {
      title = claim.factoryCode !== plant.factoryCode
        ? t('sheet.stop.otherPlantTitle', { file: claim.factoryCode, plant: plant.factoryCode })
        : t(k(plant, 'sheet.stop.otherYearTitle'), { file: claim.year, year: plant.year })
      items = claimText(row1) === claimText(system)
        ? [t('sheet.stop.fileBoth', { claim: claimText(system) })]
        : [t('sheet.stop.fileRow1', { claim: claimText(row1) }), t('sheet.stop.fileSystem', { claim: claimText(system) })]
      items.push(t(k(plant, 'sheet.stop.importingTo'), { plant: plantName(plant), year: plant.year }))
      fix = t('sheet.stop.otherFix', vars)
    }
  } else if (check.stop === 2) {
    title = t('sheet.stop.formatTitle')
    items = [
      ...check.missing.map((column) => t('sheet.stop.missing', { column })),
      ...check.unknown.map((column) => t('sheet.stop.unknown', { column })),
      ...check.unnamed.map((column) => t('sheet.stop.unnamed', { column })),
      ...(check.expired ? [t('sheet.stop.expired', { date: check.expired.generatedAt.slice(0, 10), codes: check.expired.codes.join('、') })] : []),
    ]
    fix = t('sheet.stop.formatFix')
  } else {
    title = t(k(plant, 'sheet.checks.bad3'), { ...vars, count: check.rows.length })
    items = check.rows.map((r) =>
      !r.label
        ? t('sheet.stop.rowNoCode', { row: r.row })
        : r.duplicateOf
          ? t('sheet.stop.rowRepeated', { row: r.row, label: r.label, first: r.duplicateOf })
          : t('sheet.stop.row', { row: r.row, label: r.label }),
    )
    fix = t('sheet.stop.rowsFix')
  }
  const ink = INK.red
  return (
    <Flex vertical gap={6} style={{ background: ink.background, border: `1px solid ${ink.border}`, borderRadius: palette.radius, padding: '10px 14px' }} data-testid="import-stop">
      <strong style={{ color: ink.color, fontSize: textSize(15) }}>{title}</strong>
      <ul style={{ margin: 0, paddingInlineStart: '1.3em', color: palette.text }}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <span style={{ color: palette.textSecondary }}>{fix}</span>
    </Flex>
  )
}

/**
 * Rows the file has that are left alone now: 自評表 not issued yet (importing the same file once they are writes them),
 * or on 下次發出 範本 the next launch does not issue to this plant.
 */
function NotIssuedBox({ rows, plant }: { rows: { row: number; label: string }[]; plant: PagePlant }) {
  const { t } = useTranslation('assignment')
  const ink = INK.orange
  return (
    <Flex vertical gap={6} style={{ background: ink.background, border: `1px solid ${ink.border}`, borderRadius: palette.radius, padding: '10px 14px' }} data-testid="import-not-issued">
      <strong style={{ color: ink.color, fontSize: textSize(15) }}>{t(k(plant, 'sheet.notIssued.title'), { count: rows.length, plant: plant.factoryCode })}</strong>
      <ul style={{ margin: 0, paddingInlineStart: '1.3em', color: palette.text }}>
        {rows.map((r) => (
          <li key={r.row}>{t('sheet.stop.row', { row: r.row, label: r.label })}</li>
        ))}
      </ul>
      <span style={{ color: palette.textSecondary }}>{t(k(plant, 'sheet.notIssued.text'))}</span>
    </Flex>
  )
}

type Filter = 'all' | OmsStatus | 'no_csa' | 'not_listed'
const STATUS_INK: Record<OmsStatus, Ink> = { matched: 'green', not_found: 'red', other_plant: 'orange', departed: 'red', on_leave: 'red', transferred: 'red' }
/** Always offered as a filter; the others only when someone has them. */
const ALWAYS: readonly Filter[] = ['all', 'matched', 'not_found', 'other_plant', 'departed']
const SOMETIMES: readonly Filter[] = ['on_leave', 'transferred', 'no_csa', 'not_listed']

/** 對得上 and allowed into CSA: nothing to point out, so they are only counted in 「其餘 N 人」. */
const nothingToPointOut = (p: OmsAnswer) => p.status === 'matched' && p.csa && p.listed !== false

/** A small coloured label: a status, or 未開通 CSA. */
function Tag({ ink, children }: { ink: Ink; children: ReactNode }) {
  const { border, background, color } = INK[ink]
  return (
    <span style={{ padding: '0 8px', borderRadius: 3, border: `1px solid ${border}`, background, color, fontSize: textSize(12.5), whiteSpace: 'nowrap' }}>
      {children}
    </span>
  )
}

/** 第 4 項's people: everyone with something to point out, one row each, then 「其餘 N 人」 who have not. */
function People({ plan, plant, confirmed, onConfirm }: { plan: ImportPlan; plant: PagePlant; confirmed: boolean; onConfirm: (on: boolean) => void }) {
  const { t } = useTranslation('assignment')
  const [filter, setFilter] = useState<Filter>('all')
  const vars = { plant: plant.factoryCode }
  const total = plan.people.length
  const simple = plan.people.filter(nothingToPointOut).length
  const noCsaInk: Ink = plan.csaRequired ? 'red' : 'orange'
  const countOf = (key: Filter) => (key === 'all' ? total : key === 'no_csa' ? plan.noCsa : key === 'not_listed' ? plan.notListed : plan.counts[key])
  const shows = (p: OmsAnswer) =>
    filter === 'all' || (filter === 'no_csa' ? lacksCsa(p) : filter === 'not_listed' ? unlisted(p) : filter === p.status)
  const listed = plan.people.filter((p) => !nothingToPointOut(p) && shows(p))
  const rows = [
    ...listed.map((p) => ({ key: p.empId, status: p.status, noCsa: lacksCsa(p), notListed: unlisted(p), empId: p.empId, cells: t('sheet.people.cells', { count: p.cells }) })),
    ...((filter === 'all' || filter === 'matched') && simple
      ? [{ key: '', status: 'matched' as const, noCsa: false, notListed: false, empId: t('sheet.people.rest', { count: simple }), cells: '' }]
      : []),
  ]
  return (
    <Flex vertical gap={12}>
      {plan.bulkWarning && (
        <Flex vertical gap={6} style={{ background: INK.orange.background, border: `1px solid ${INK.orange.border}`, borderRadius: palette.radius, padding: '10px 14px' }} data-testid="import-bulk">
          <strong style={{ color: INK.orange.color, fontSize: textSize(15) }}>{t('sheet.bulk.title', vars)}</strong>
          <span style={{ color: palette.textSecondary }}>
            {t('sheet.bulk.text', { ...vars, total, count: plan.counts.other_plant, percent: Math.round((plan.counts.other_plant / total) * 100) })}
          </span>
          <Checkbox checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} style={{ color: INK.orange.color, fontWeight: 500 }} data-testid="import-bulk-confirm">
            {t('sheet.bulk.confirm', vars)}
          </Checkbox>
        </Flex>
      )}
      <div>
        <Typography.Text strong style={{ fontSize: textSize(15) }}>{t('sheet.people.title', vars)}</Typography.Text>
        <Typography.Paragraph style={{ margin: 0, color: palette.textTertiary, fontSize: textSize(13) }}>
          {t('sheet.people.note', { count: total })}
        </Typography.Paragraph>
      </div>
      <Flex wrap gap={8} role="group" aria-label={t('sheet.people.filter')}>
        {[...ALWAYS, ...SOMETIMES.filter((key) => countOf(key) > 0)].map((key) => {
          const on = filter === key
          const ink = key === 'all' ? null : key === 'no_csa' ? noCsaInk : key === 'not_listed' ? 'red' : STATUS_INK[key]
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(key)}
              data-testid={`import-chip-${key}`}
              style={{
                display: 'inline-flex', gap: 6, alignItems: 'center', padding: '3px 12px', borderRadius: 14, cursor: 'pointer', font: 'inherit', fontSize: textSize(13.5),
                border: `1px solid ${on ? palette.selectedBorder : palette.border}`, background: on ? palette.selectedBg : palette.surface,
                color: on ? palette.selectedText : palette.textSecondary,
              }}
            >
              {key === 'all' ? t('sheet.people.all') : t(`sheet.status.${key}`)}
              <b style={{ color: ink ? INK[ink].color : palette.textTertiary, fontVariantNumeric: 'tabular-nums' }}>{countOf(key)}</b>
            </button>
          )
        })}
      </Flex>
      <Table
        size="small"
        pagination={false}
        rowKey="key"
        dataSource={rows}
        onRow={() => ({ 'data-testid': 'import-person' }) as HTMLAttributes<HTMLTableRowElement>}
        scroll={{ x: 760 }}
        data-testid="import-people"
        columns={[
          {
            key: 'status', width: 110,
            render: (_, r) => (
              <Flex vertical gap={3} align="flex-start">
                <Tag ink={STATUS_INK[r.status]}>{t(`sheet.status.${r.status}`)}</Tag>
                {r.noCsa && <Tag ink={noCsaInk}>{t('sheet.status.no_csa')}</Tag>}
                {r.notListed && <Tag ink="red">{t('sheet.status.not_listed')}</Tag>}
              </Flex>
            ),
          },
          { title: t('sheet.people.empId'), dataIndex: 'empId', width: 120, render: (v: string, r) => <span style={{ fontFamily: r.key ? 'ui-monospace, Consolas, monospace' : undefined, color: r.key ? undefined : palette.textTertiary }}>{v}</span> },
          { title: t('sheet.people.used'), dataIndex: 'cells', width: 90 },
          {
            title: t('sheet.people.oms', vars), key: 'oms',
            render: (_, r) =>
              [t(`sheet.people.says.${r.status}`, vars), ...(r.noCsa ? [t('sheet.people.says.no_csa')] : []), ...(r.notListed ? [t('sheet.people.says.not_listed')] : [])].join('；'),
          },
          {
            title: t('sheet.people.action'), key: 'action',
            render: (_, r) => (
              <span style={{ color: palette.textTertiary }}>
                {r.notListed
                  ? t('sheet.people.does.not_listed', vars)
                  : r.noCsa
                    ? t(plan.csaRequired ? 'sheet.people.does.no_csaRequired' : 'sheet.people.does.no_csa', vars)
                    : t(`sheet.people.does.${r.status}`, vars)}
              </span>
            ),
          },
        ]}
      />
    </Flex>
  )
}

/** The line after 確認匯入: what was written, who was left out and why, who was 廠區不同. */
export function importSummaryText(t: T, summary: ImportSummary, plant: string): string {
  const { counts } = summary
  return [
    t('sheet.done.written', { file: summary.fileName, count: summary.written }),
    counts.not_found + counts.departed ? t('sheet.done.left', { gone: counts.not_found, left: counts.departed }) : '',
    counts.on_leave ? t('sheet.done.onLeave', { count: counts.on_leave }) : '',
    counts.transferred ? t('sheet.done.transferred', { count: counts.transferred }) : '',
    summary.noCsa ? t(summary.csaRequired ? 'sheet.done.noCsaRequired' : 'sheet.done.noCsa', { count: summary.noCsa }) : '',
    summary.notListed ? t('sheet.done.notListed', { count: summary.notListed }) : '',
    counts.other_plant ? t(summary.bulkConfirmed ? 'sheet.done.otherPlantConfirmed' : 'sheet.done.otherPlant', { count: counts.other_plant, plant }) : '',
    summary.skipped ? t('sheet.done.skipped', { count: summary.skipped }) : '',
    summary.notIssued ? t(summary.next ? 'sheet.done.notIssuedNext' : 'sheet.done.notIssued', { count: summary.notIssued, plant }) : '',
  ].join('')
}
