import { Affix, Alert, Button, Card, Checkbox, Divider, Flex, Input, Popconfirm, Radio, Table, Typography, type message } from 'antd'
import type { ColumnsType, ColumnType } from 'antd/es/table'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { CONCLUSION_OPTIONS, EMPTY_ANSWER, type Answer, type Conclusion, type Violation, type ViolationRule } from '../api/answers'
import type { AssessmentSection, AssessmentView } from '../api/assessments'
import { WriteError } from '../api/writeError'
import {
  answerProgress,
  answerRows,
  assessingUnits,
  buildPayload,
  choiceFields,
  clearViolations,
  indexViolations,
  matrixHeader,
  nextUnanswered,
  showsUnitColumn,
  splitAnswerKey,
  unitOnlyRows,
  type AnswerRow,
  type ChoiceField,
} from '../domain/answering'
import { errorText } from '../domain/errors'
import { cardNumber, cardTitle, isSubheading, numberColumnWidth, outline, outlineRows, pointNumbers, type SubheadingRow } from '../domain/outline'
import { advanceMessageKey, myAnswerStep } from '../domain/signoff'
import { useAnswering } from '../hooks/useAnswering'
import { holdReloadsWhile } from '../loadChunk'
import { PointText } from './PointText'
import { CARD_HEADER_STYLE, CARD_STYLE, INK, palette, SHEET, subheadingNameStyle, subheadingStyle, textSize } from '../theme'

type Notify = ReturnType<typeof message.useMessage>[0]

/** Background of a row or 整體結論 the database reported as incomplete. */
const VIOLATION_STYLE = { background: INK.red.background } as const
/** Background of the rows the signed-in employee may answer, so they stand out among the read-only ones. */
const EDITABLE_STYLE = { background: SHEET.editableRow } as const
/** Header text keeps the line breaks the `headers` translations put between words. */
const HEADER_STYLE = { whiteSpace: 'pre-line' } as const
/** One tick-box column, narrow enough that a whole 控制活動類 row fits a laptop screen (the header carries the option). */
const OPTION_WIDTH = 52
/** An answerable option cell under the mouse (#133, global.css's `.csa-choice`): a step darker than the row. */
const CHOICE_STYLE = { '--csa-choice-hover': palette.selectedBg } as CSSProperties
/**
 * The line in front of 自評單位, of each block of options and after the last one (#140), the only upright lines of the
 * matrix (方向 A, #131): the control point text and the three 答題 blocks set apart by a thin line in the inputs' edge
 * grey, a step darker than the lines between rows.
 */
const BLOCK_EDGE = { borderInlineStart: `1px solid ${palette.controlBorder}` } as const
/**
 * The matrix runs to its card's edges (方向 A, #131) with the card's padding inside its outer cells: before the # and
 * after the last column (改善措施, or 要素類's last 滿意度 option; endsCard). Set on those columns rather than through
 * csa-edge-table, which pads whatever cell comes first or last in a row: on a control point's later 自評單位 rows (no #,
 * it is merged) and on the option header row that would be the 自評單位 cell and the first option's header.
 */
const CARD_START = { paddingInlineStart: 'var(--csa-card-pad)' } as const
const CARD_END = { paddingInlineEnd: 'var(--csa-card-pad)' } as const
/** The line above the matrix (方向 A, #131): which 自評單位 this employee answers, in the editable rows' purple. */
const EDITING_NOTE_STYLE: CSSProperties = {
  padding: '8px 14px',
  background: palette.selectedBg,
  border: `1px solid ${SHEET.noteBorder}`,
  borderRadius: palette.radius,
  color: SHEET.noteText,
}
/** The same line when nothing here is this employee's to answer: plain white. */
const READ_ONLY_NOTE_STYLE: CSSProperties = { ...EDITING_NOTE_STYLE, background: palette.surface, borderColor: palette.border, color: palette.textSecondary }
/** Room above 整體結論 when 到整體結論 brings it up: clear of the phone's top bar (52px). */
const CONCLUSIONS_MARGIN = 72
/** How long a row jumped to stays marked (#134): a purple frame and tint that fade out. */
const FLASH_MS = 2000

/**
 * 下一題未填's stop after the rows: the editable unit's 整體結論, while it has no 尚屬滿意／除下列事項外 chosen. Row keys are
 * control point ids (with a 自評單位), so they never equal it.
 */
const CONCLUSION_STOP = 'conclusion'

/** What a stop of 下一題未填 jumps to, if it is on screen (only one answer sheet is): a table row or the 整體結論. */
function stopElement(key: string, unit: string): HTMLElement | undefined {
  if (key === CONCLUSION_STOP) return [...document.querySelectorAll<HTMLElement>('[data-testid="conclusion"]')].find((el) => el.dataset.unit === unit)
  return [...document.querySelectorAll<HTMLElement>('tr[data-row-key]')].find((tr) => tr.dataset.rowKey === key)
}

/**
 * The first option of the row's first group with nothing ticked: focusing an option of an answered group would let the
 * arrow keys change that answer.
 */
function firstOpenOption(row: HTMLElement): HTMLInputElement | undefined {
  const options = [...row.querySelectorAll<HTMLInputElement>('input[type="radio"]:not(:disabled)')]
  return options.find((o) => !options.some((other) => other.name === o.name && other.checked))
}

/**
 * Scrolls a row or the 整體結論 to the middle of the window, clear of the bottom bar, and marks it for a moment.
 * 下一題未填 pressed from the keyboard also puts the keyboard on its first open option, so the arrow keys answer it right
 * away; after a click it does not, or Space and the arrow keys would tick options instead of scrolling the page.
 */
function jumpToStop(target: HTMLElement, { smooth, focus }: { smooth: boolean; focus: boolean }) {
  target.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
  if (focus) firstOpenOption(target)?.focus({ preventScroll: true })
  if (!(target instanceof HTMLTableRowElement)) {
    const frame = `2px solid ${palette.primary}`
    const marked = { backgroundColor: palette.selectedBg, outline: frame, outlineOffset: '6px' }
    target.animate([marked, { ...marked, offset: 0.6 }, { outline: '2px solid transparent', outlineOffset: '6px' }], { duration: FLASH_MS })
    return
  }
  const row = target
  // The cells paint over the row (the option cells and the fixed # are positioned), so each cell draws its part of the
  // frame and fades from the tint back to its own colour.
  const cells = [...row.children]
  cells.forEach((cell, i) => {
    const offsets = ['0 2px', '0 -2px', ...(i === 0 ? ['2px 0'] : []), ...(i === cells.length - 1 ? ['-2px 0'] : [])]
    const edges = (color: string) => offsets.map((offset) => `inset ${offset} ${color}`).join(', ')
    const marked = { backgroundColor: palette.selectedBg, boxShadow: edges(palette.primary) }
    cell.animate([marked, { ...marked, offset: 0.6 }, { boxShadow: edges('transparent') }], { duration: FLASH_MS })
  })
}

/**
 * The answers of one 自評表 (#5), laid out like the paper (#46): the options are column headers, every 自評單位 of a
 * control point answers on its own row, and the control point's number and text are merged over its rows. The
 * 自評單位 whose 自行檢查人員 關卡 is the signed-in employee's turn (`my_current_steps`) gets inputs, everything else is
 * read-only; someone at two units' 關卡 at once answers them one after the other (myAnswerStep, Q116). Messages go
 * through the page's `notify`, because a successful 送出 re-mounts this component on the next 關卡.
 */
export function AnswerSheet({ assessment: a, notify }: { assessment: AssessmentView; notify: Notify }) {
  const { t, i18n } = useTranslation('answering')
  const { t: tc } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const { save, submit } = useAnswering(a.id)
  const answerStep = myAnswerStep(a)
  const editableUnit = answerStep?.editable_unit_name ?? null
  const isControlActivity = a.template_layout === 'control_activity'

  const sections = useMemo(() => a.assessment_section.map((s) => ({ ...s, rows: answerRows(s.assessment_control_point) })), [a.assessment_section])
  // 只看我的題目 (#134): off on every visit, not remembered. Hiding rows changes nothing else: 已答, 下一題未填 and
  // 送出 go over the same rows either way.
  const [onlyMine, setOnlyMine] = useState(false)
  const shownSections = useMemo(
    () =>
      sections.map((s) => {
        if (!onlyMine || !editableUnit) return { ...s, total: s.rows.length, otherUnits: 0, folded: false }
        const { rows, otherUnits } = unitOnlyRows(s.assessment_control_point, editableUnit)
        return { ...s, rows, total: s.rows.length, otherUnits, folded: rows.length === 0 }
      }),
    [sections, onlyMine, editableUnit],
  )
  // 章節分層 (Q125): a card per 第一層, its 第二／三層 as 分段列 among the rows, the control points numbered over the card.
  const cards = useMemo(
    () =>
      outline(shownSections).map((card) => {
        const parts = card.parts.map((p) => p.section)
        const total = parts.reduce((n, s) => n + s.total, 0)
        return {
          key: parts[0]!.id,
          title: cardTitle(card),
          label: cardNumber(card),
          numbers: pointNumbers(card, (s) => s.assessment_control_point),
          headingCodes: parts.map((s) => s.code),
          rows: outlineRows(card, (s) => s.rows, { hideEmpty: onlyMine && !!editableUnit }),
          total,
          otherUnits: parts.reduce((n, s) => n + s.otherUnits, 0),
          folded: parts.every((s) => s.folded),
        }
      }),
    [shownSections, onlyMine, editableUnit],
  )
  // 送出's violations name a control point by the card and the number the page shows; a 原檔題號 says it all.
  const pointLabels = useMemo(
    () => new Map(cards.flatMap((card) => [...card.numbers].map(([id, number]) => [id, { section: card.label, number }] as const))),
    [cards],
  )
  const codedPoints = useMemo(
    () => new Set(a.assessment_section.flatMap((s) => s.assessment_control_point.filter((p) => p.code).map((p) => p.id))),
    [a.assessment_section],
  )
  // 反向題 (Q148): their 送出 messages name 「是」 where the others name 「否」.
  const reversePoints = useMemo(
    () => new Set(a.assessment_section.flatMap((s) => s.assessment_control_point.filter((p) => p.is_reverse).map((p) => p.id))),
    [a.assessment_section],
  )
  // What the database has now. The editable unit's inputs start from it once; the other units' rows keep showing it,
  // because other 分流 move on while this one is answered (Q116) and their answers appear once visible.
  const savedAnswers = useMemo<Record<string, Answer>>(
    () =>
      Object.fromEntries(
        sections.flatMap((s) =>
          s.rows.flatMap((r) => {
            const saved = r.point.assessment_control_point_unit.find((u) => u.assessing_unit_name === r.unit)?.assessment_answer
            return r.unit ? [[r.key, saved ?? EMPTY_ANSWER]] : []
          }),
        ),
      ),
    [sections],
  )
  const savedConclusions = useMemo<Record<string, Conclusion>>(
    () => Object.fromEntries(a.assessment_conclusion.map((c) => [c.assessing_unit_name, { conclusion: c.conclusion, exceptions: c.exceptions }])),
    [a.assessment_conclusion],
  )
  const [answers, setAnswers] = useState(savedAnswers)
  const [conclusions, setConclusions] = useState(savedConclusions)
  // Rows edited since the last 暫存: only these are sent, so another tab's newer answers are not overwritten.
  const [editedRows, setEditedRows] = useState<ReadonlySet<string>>(new Set())
  const [conclusionEdited, setConclusionEdited] = useState(false)
  const [violations, setViolations] = useState<Violation[]>([])
  const [submitRound, setSubmitRound] = useState(0)
  const violationsRef = useRef<HTMLDivElement>(null)
  const conclusionsRef = useRef<HTMLDivElement>(null)

  // The latest state for 暫存, which can run right after a text box commits on blur in the same click.
  const latest = useRef({ answers, conclusions, editedRows, conclusionEdited })
  latest.current = { answers, conclusions, editedRows, conclusionEdited }

  // Q135 (3): a failed 匯出 import must not reload away answers not yet 暫存.
  const unsaved = editedRows.size > 0 || conclusionEdited
  useEffect(() => {
    holdReloadsWhile(unsaved)
    return () => holdReloadsWhile(false)
  }, [unsaved])

  // Only the editable unit's rows can be edited, and the database reports violations of that unit only,
  // so the control point a row key names is the one whose violations an edit clears.
  const markRow = useCallback((key: string) => {
    setEditedRows((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
    setViolations((prev) => clearViolations(prev, { controlPointId: splitAnswerKey(key).control_point_id }))
  }, [])
  const setAnswer = useCallback(
    (key: string, patch: Partial<Answer>) => {
      setAnswers((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_ANSWER), ...patch } }))
      markRow(key)
    },
    [markRow],
  )
  const markConclusion = useCallback((unit: string) => {
    setConclusionEdited(true)
    setViolations((prev) => clearViolations(prev, { assessingUnitName: unit }))
  }, [])
  const setConclusion = useCallback(
    (unit: string, patch: Partial<Conclusion>) => {
      setConclusions((prev) => ({ ...prev, [unit]: { conclusion: null, exceptions: null, ...prev[unit], ...patch } }))
      markConclusion(unit)
    },
    [markConclusion],
  )
  const commitImprovement = useCallback((key: string, text: string) => setAnswer(key, { improvement: text }), [setAnswer])
  const commitExceptions = useCallback((unit: string, text: string) => setConclusion(unit, { exceptions: text }), [setConclusion])

  useEffect(() => {
    if (submitRound > 0) violationsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [submitRound])

  // 已答 a／b 題 (#134) counts the editable unit's rows, with the answers on screen (unsaved ones too), as 首頁 does;
  // 下一題未填 also stops at its 整體結論 until 尚屬滿意 or 除下列事項外 is chosen, and only then is everything ✓.
  const myRowKeys = useMemo(
    () => (editableUnit ? sections.flatMap((s) => s.rows.filter((r) => r.unit === editableUnit).map((r) => r.key)) : []),
    [sections, editableUnit],
  )
  const progress = useMemo(() => answerProgress(a.template_layout, myRowKeys, answers), [a.template_layout, myRowKeys, answers])
  const allAnswered = progress.unanswered.length === 0
  const conclusionOpen = !!editableUnit && !conclusions[editableUnit]?.conclusion
  const allDone = allAnswered && !conclusionOpen
  const stops = useMemo(() => [...myRowKeys, CONCLUSION_STOP], [myRowKeys])
  const openStops = useMemo(() => [...progress.unanswered, ...(conclusionOpen ? [CONCLUSION_STOP] : [])], [progress, conclusionOpen])
  // The stop 下一題未填 last went to; the next press goes on from there.
  const cursor = useRef<string | null>(null)
  const jumpTo = useCallback(
    (key: string, options: { smooth: boolean; focus: boolean }) => {
      const target = editableUnit ? stopElement(key, editableUnit) : undefined
      if (!target) return
      cursor.current = key
      jumpToStop(target, options)
    },
    [editableUnit],
  )
  // A click reports how many times the mouse was pressed; Enter or Space on the button reports 0.
  const onNext = (e: MouseEvent) => {
    const key = nextUnanswered(stops, openStops, cursor.current)
    if (key) jumpTo(key, { smooth: true, focus: e.detail === 0 })
    else conclusionsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  // Opening the sheet lands on its first open stop, or at the top when everything is answered. Once per mount: a 送出
  // that moves on to the employee's next 關卡 re-mounts the sheet.
  const jumpedOnOpen = useRef(false)
  useEffect(() => {
    if (jumpedOnOpen.current || !editableUnit) return
    jumpedOnOpen.current = true
    const first = openStops[0]
    if (first) jumpTo(first, { smooth: false, focus: false })
    else window.scrollTo({ top: 0 })
  }, [editableUnit, openStops, jumpTo])

  /** 暫存 what changed; afterwards a row stays marked only if it was edited again while saving. */
  const persist = async () => {
    const sent = latest.current
    const payload = buildPayload(
      sent.answers,
      sent.editedRows,
      editableUnit ? { unit: editableUnit, value: sent.conclusions[editableUnit], edited: sent.conclusionEdited } : null,
    )
    if (payload.answers.length === 0 && payload.conclusions.length === 0) return
    await save.mutateAsync(payload)
    const now = latest.current
    setEditedRows((prev) => new Set([...prev].filter((key) => now.answers[key] !== sent.answers[key])))
    if (editableUnit && now.conclusions[editableUnit] === sent.conclusions[editableUnit]) setConclusionEdited(false)
  }

  const writeFailure = (error: unknown) =>
    error instanceof WriteError && error.reason !== 'other' ? t(`errors.${error.reason}`) : errorText(error)

  const onSave = async () => {
    try {
      await persist()
      void notify.success(t('saved'))
    } catch (error) {
      void notify.error(writeFailure(error))
    }
  }

  const onSubmit = async () => {
    try {
      if (!answerStep) return
      await persist()
      const result = await submit.mutateAsync(answerStep.position)
      if (result.ok) {
        void notify.success(t(advanceMessageKey('submitted', a, result.current_step_position), { position: result.current_step_position }))
      } else if (result.error === 'incomplete') {
        setViolations(result.violations)
        setSubmitRound((n) => n + 1)
      } else {
        void notify.error(t(`errors.${result.error}`))
      }
    } catch (error) {
      void notify.error(writeFailure(error))
    }
  }

  const index = indexViolations(violations)
  const ruleText = useCallback(
    (rule: ViolationRule, isReverse = false) => {
      if (rule !== 'improvement_required') return t(`rules.${rule}`)
      // 要素類 calls the free-text column 補充說明, not 改善措施; a 反向題 asks for it on 「是」 (Q148).
      return t(`rules.${isControlActivity ? 'improvement_required' : 'remark_required'}${isReverse ? '_reverse' : ''}`)
    },
    [t, isControlActivity],
  )
  const violationPointText = (v: Extract<Violation, { kind: 'control_point' }>) => {
    const label = pointLabels.get(v.control_point_id)
    const rule = ruleText(v.rule, reversePoints.has(v.control_point_id))
    if (label && codedPoints.has(v.control_point_id)) return t('violationPointCode', { position: label.number, rule })
    return t('violationPoint', { section: label?.section ?? v.section_position, position: label?.number ?? v.position, rule })
  }
  const isEditable = (r: AnswerRow) => !!editableUnit && r.unit === editableUnit
  const answerOf = (r: AnswerRow) => (isEditable(r) ? answers : savedAnswers)[r.key]
  const brokenRules = (r: AnswerRow) => (isEditable(r) ? index.points.get(r.point.id) : undefined)
  const rowStyle = (r: AnswerRow): CSSProperties | undefined => (brokenRules(r) ? VIOLATION_STYLE : isEditable(r) ? EDITABLE_STYLE : undefined)
  const fields = useMemo(() => choiceFields(a.template_layout), [a.template_layout])
  const withUnitColumn = showsUnitColumn(a.template_layout, a)

  const columnsFor = (card: { label: string; numbers: ReadonlyMap<string, string>; headingCodes: (string | null)[] }): ColumnsType<AnswerRow> => {
    const numberOf = (r: AnswerRow) => card.numbers.get(r.point.id)
    /** The merged cells of a control point: the first of its rows spans the others, which render nothing. */
    const merged = { onCell: (r: AnswerRow) => ({ rowSpan: r.span }) }
    const unitCell = { onCell: (r: AnswerRow) => ({ style: rowStyle(r) }) }
    /**
     * A column with BLOCK_EDGE on its left (#140): its header, and its cells unless it is a group (a group has no cells
     * of its own; its first option draws the line below it).
     */
    const edgeBefore = <C extends ColumnType<AnswerRow>>(column: C): C => withCellStyle(column, BLOCK_EDGE)
    const freeText: ColumnType<AnswerRow> = {
      title: isControlActivity ? t('improvement') : t('remark'),
      key: 'improvement',
      width: isControlActivity ? 220 : 200,
      ...unitCell,
      render: (_, r) => (
        <Flex vertical gap={4}>
          {isEditable(r) ? (
            <CommitTextArea
              id={r.key}
              value={answerOf(r)?.improvement ?? null}
              minRows={1}
              label={t(r.unit ? 'freeTextLabel' : 'freeTextLabelNoUnit', {
                section: card.label,
                number: numberOf(r),
                unit: r.unit,
                field: isControlActivity ? t('improvement') : t('remark'),
              })}
              onTouch={markRow}
              onCommit={commitImprovement}
              testId="answer-improvement"
            />
          ) : (
            <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{answerOf(r)?.improvement}</Typography.Text>
          )}
          {brokenRules(r)?.map((rule) => (
            <Typography.Text key={rule} type="danger" data-testid="answer-violation">
              {ruleText(rule, r.point.is_reverse)}
            </Typography.Text>
          ))}
        </Flex>
      ),
    }
    const choiceGroup = (f: ChoiceField): ColumnType<AnswerRow> & { children: ColumnsType<AnswerRow> } => {
      // 要素類 paper titles its 是／否／不適用 group 評估結果 and puts 補充說明 under it.
      const title = !isControlActivity && f.field === 'execution' ? t('assessmentResult') : t(f.title)
      return edgeBefore({
        title: matrixHeader(t, language, `groups.${f.field}`, title),
        onHeaderCell: () => ({ style: { ...HEADER_STYLE, fontSize: textSize(12) } }),
        key: f.field,
        children: [
          ...f.options.map((option, i): ColumnType<AnswerRow> => {
            const column: ColumnType<AnswerRow> = {
              title: matrixHeader(t, language, `options.${option}`, t(`${f.group}.${option}`)),
              key: `${f.field}:${option}`,
              width: OPTION_WIDTH,
              align: 'center',
              // The paper prints these headers small and wrapped (有內控／規範); keep the column narrow the same way.
              onHeaderCell: () => ({ style: { ...HEADER_STYLE, fontSize: textSize(11), fontWeight: 500, lineHeight: 1.3, paddingInline: 4 } }),
              // On the row being answered, the option's label fills the cell (#133).
              onCell: (r) => ({ ...unitCell.onCell(r), className: 'csa-choice-cell' }),
              render: (_, r) => (
                <ChoiceRadio
                  rowKey={r.key}
                  field={f.field}
                  option={option}
                  checked={answerOf(r)?.[f.field] === option}
                  editable={isEditable(r)}
                  label={t(r.unit ? 'optionLabel' : 'optionLabelNoUnit', {
                    section: card.label,
                    number: numberOf(r),
                    unit: r.unit,
                    field: title,
                    option: t(`${f.group}.${option}`),
                  })}
                  onChange={setAnswer}
                />
              ),
            }
            return i === 0 ? edgeBefore(column) : column
          }),
          ...(!isControlActivity && f.field === 'execution' ? [freeText] : []),
        ],
      })
    }
    return endsCard([
      // 48: the card's 16px padding in front of it still leaves room for a two-digit number; wider for a long 題號.
      {
        title: '#',
        key: 'number',
        width: numberColumnWidth([...card.numbers.values(), ...card.headingCodes], 48),
        align: 'right',
        fixed: 'left',
        onHeaderCell: () => ({ style: CARD_START }),
        onCell: (r) => ({ rowSpan: r.span, style: CARD_START }),
        render: (_, r) => numberOf(r),
      },
      {
        title: tc('assessments.controlPoint'),
        key: 'text',
        ...merged,
        // 「反向題」 after the text (Q148), as in 範本管理; nothing else on the row changes.
        render: (_, r) => <PointText text={r.point.text} isReverse={r.point.is_reverse} />,
      },
      // A line before 自評單位 too, so a long control point's text does not run into the unit name (2026-11-11).
      ...(withUnitColumn
        ? [edgeBefore({ title: tc('assessments.assessingUnit'), key: 'unit', width: 88, ...unitCell, render: (_: unknown, r: AnswerRow) => r.unit ?? '—' })]
        : []),
      ...fields.map(choiceGroup),
      // 改善措施 closes the last block; 要素類's 補充說明 sits inside 評估結果, so its matrix ends at the card's edge.
      ...(isControlActivity ? [edgeBefore(freeText)] : []),
    ])
  }

  return (
    <>
      <div style={editableUnit ? EDITING_NOTE_STYLE : READ_ONLY_NOTE_STYLE} data-testid={editableUnit ? 'editing-note' : 'read-only-note'}>
        {editableUnit ? t('editingNote', { unit: editableUnit }) : tc('assessments.readOnlyNote')}
      </div>
      <div ref={violationsRef} style={{ scrollMarginTop: 16 }}>
        {violations.length > 0 && (
          <Alert
            type="error"
            showIcon
            title={t('violationsTitle', { count: violations.length })}
            description={
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {violations.map((v, i) => (
                  <li key={i}>
                    {v.kind === 'control_point'
                      ? violationPointText(v)
                      : t('violationConclusion', { unit: v.assessing_unit_name, rule: ruleText(v.rule) })}
                  </li>
                ))}
              </ul>
            }
            data-testid="violations"
          />
        )}
      </div>
      {cards.map((section) => (
        <Card
          key={section.key}
          title={section.title}
          extra={
            section.otherUnits > 0 &&
            !section.folded && (
              <Typography.Text type="secondary" data-testid="hidden-rows">
                {t('hiddenRows', { count: section.otherUnits })}
              </Typography.Text>
            )
          }
          size="small"
          style={CARD_STYLE}
          styles={{ header: CARD_HEADER_STYLE, body: { padding: 0 } }}
          data-testid="assessment-section"
        >
          {section.folded ? (
            <Typography.Text type="secondary" style={{ display: 'block', padding: '12px var(--csa-card-pad)' }} data-testid="section-folded">
              {t('sectionFolded', { count: section.total })}
            </Typography.Text>
          ) : (
            // Lines between the rows and before each block of options only (方向 A, #131), running to the card's edges.
            <Table<CardRow>
              className="csa-flush-bottom"
              rowKey="key"
              size="small"
              pagination={false}
              // Wide enough for every option column; narrower screens scroll the table, not the page (#35／#36 later).
              scroll={{ x: isControlActivity ? 1180 : 1000 }}
              dataSource={section.rows}
              columns={withSubheadings(columnsFor(section))}
              onRow={(r) =>
                (isSubheading(r)
                  ? { 'data-testid': 'answer-subheading' }
                  : {
                      'data-testid': 'control-point-row',
                      'data-unit': r.unit ?? '',
                      'data-editable': isEditable(r) ? 'true' : 'false',
                      'data-violation': brokenRules(r) ? 'true' : 'false',
                    }) as unknown as HTMLAttributes<HTMLElement>
              }
            />
          )}
        </Card>
      ))}
      <Card
        ref={conclusionsRef}
        title={t('conclusionTitle')}
        size="small"
        style={{ ...CARD_STYLE, scrollMarginTop: CONCLUSIONS_MARGIN }}
        styles={{ header: CARD_HEADER_STYLE, body: { padding: '12px var(--csa-card-pad)' } }}
        data-testid="conclusions"
      >
        <Flex vertical gap={16}>
          {assessingUnits(a).map((unit) => {
            const c = (unit === editableUnit ? conclusions : savedConclusions)[unit]
            const broken = index.conclusions.get(unit)
            return (
              <Flex
                key={unit}
                vertical
                gap={8}
                data-testid="conclusion"
                data-unit={unit}
                data-violation={broken ? 'true' : 'false'}
                style={broken ? { ...VIOLATION_STYLE, padding: 8 } : undefined}
              >
                {/* The unit and its 結論 on one line (方向 A, #131), the 說明 under them. */}
                <Flex wrap align="center" gap="8px 32px">
                  <Typography.Text style={{ fontWeight: 500 }}>{unit}</Typography.Text>
                  {unit === editableUnit ? (
                    <Radio.Group
                      value={c?.conclusion ?? null}
                      onChange={(e) => setConclusion(unit, { conclusion: e.target.value })}
                      options={CONCLUSION_OPTIONS.map((o) => ({ value: o, label: t(`conclusions.${o}`) }))}
                      data-testid="conclusion-choice"
                    />
                  ) : (
                    <span>{c?.conclusion ? t(`conclusions.${c.conclusion}`) : <Typography.Text type="secondary">{t('notAnswered')}</Typography.Text>}</span>
                  )}
                </Flex>
                {unit === editableUnit ? (
                  <CommitTextArea
                      id={unit}
                      value={c?.exceptions ?? null}
                      minRows={2}
                      placeholder={t('exceptions')}
                      label={t('exceptionsLabel', { unit })}
                      onTouch={markConclusion}
                      onCommit={commitExceptions}
                      testId="conclusion-exceptions"
                  />
                ) : (
                  c?.exceptions && <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{c.exceptions}</Typography.Text>
                )}
                {broken?.map((rule) => (
                  <Typography.Text key={rule} type="danger" data-testid="conclusion-violation">
                    {ruleText(rule)}
                  </Typography.Text>
                ))}
              </Flex>
            )
          })}
        </Flex>
      </Card>
      {editableUnit && (
        <Affix offsetBottom={0}>
          <Card size="small" data-testid="answer-bar">
            <Flex gap={8} align="center" wrap>
              <Checkbox checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} data-testid="only-mine">
                {t('onlyMine')}
              </Checkbox>
              <Divider orientation="vertical" />
              <Typography.Text
                type={allDone ? 'success' : undefined}
                style={{ fontVariantNumeric: 'tabular-nums' }}
                data-testid="answer-progress"
              >
                {allDone && '✓ '}
                {t('progress', { answered: progress.answered, total: progress.total })}
              </Typography.Text>
              {/* A plain button: on the bar only 送出 is purple (方向 A, #131). */}
              <Button onClick={onNext} data-testid="next-unanswered">
                {allAnswered ? t('toConclusion') : t('nextUnanswered')}
              </Button>
              <span style={{ flex: 1 }} />
              {(editedRows.size > 0 || conclusionEdited) && <Typography.Text type="warning">{t('unsaved')}</Typography.Text>}
              <Button onClick={onSave} loading={save.isPending && !submit.isPending} disabled={submit.isPending} data-testid="save-answers">
                {t('save')}
              </Button>
              <Popconfirm title={t('submitConfirm')} onConfirm={onSubmit}>
                <Button type="primary" loading={submit.isPending} disabled={save.isPending} data-testid="submit-answers">
                  {t('submit')}
                </Button>
              </Popconfirm>
            </Flex>
          </Card>
        </Affix>
      )}
    </>
  )
}

/**
 * One option of one row: a native radio button. On the row being answered a label around it fills the whole cell, so a
 * click anywhere in the cell picks the option and the cell lights up under the mouse (#133). The options of one field
 * on one row share a `name`, so the browser makes them one group: Tab reaches the group once and the arrow keys move
 * between its cells. The aria-label names the control point, the 自評單位, the field and the option, because the visible
 * header is far from the cell. Read-only rows show the same circles disabled and nothing more, so what another unit
 * ticked is visible at a glance. Memoized, so a click re-renders only the cells whose `checked` changes.
 */
const ChoiceRadio = memo(function ChoiceRadio({
  rowKey,
  field,
  option,
  checked,
  editable,
  label,
  onChange,
}: {
  rowKey: string
  field: ChoiceField['field']
  option: string
  checked: boolean
  editable: boolean
  label: string
  onChange: (key: string, patch: Partial<Answer>) => void
}) {
  const radio = (
    <input
      type="radio"
      name={`${rowKey}:${field}`}
      value={option}
      checked={checked}
      disabled={!editable}
      aria-label={label}
      onChange={() => onChange(rowKey, { [field]: option })}
      style={{ width: 16, height: 16, margin: 0, cursor: editable ? 'pointer' : 'default', accentColor: palette.primary }}
      data-testid={`answer-${field}`}
    />
  )
  return editable ? (
    <label className="csa-choice" style={CHOICE_STYLE}>
      {radio}
    </label>
  ) : (
    radio
  )
})

/**
 * Free text that keeps keystrokes to itself and hands the text to the sheet on blur (which a click on
 * 暫存／送出 triggers first), so typing does not re-render the whole sheet. `onTouch` marks the row edited.
 */
const CommitTextArea = memo(function CommitTextArea({
  id,
  value,
  minRows,
  placeholder,
  label,
  onTouch,
  onCommit,
  testId,
}: {
  id: string
  value: string | null
  minRows: number
  placeholder?: string
  label: string
  onTouch: (id: string) => void
  onCommit: (id: string, text: string) => void
  testId: string
}) {
  const [text, setText] = useState(value ?? '')
  return (
    <Input.TextArea
      autoSize={{ minRows }}
      placeholder={placeholder}
      aria-label={label}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        onTouch(id)
      }}
      onBlur={() => {
        if (text !== (value ?? '')) onCommit(id, text)
      }}
      data-testid={testId}
    />
  )
})

type CardRow = AnswerRow | SubheadingRow<AssessmentSection>

/**
 * The answer matrix's columns with 分段列 among the rows (Q125): a 分段列 puts its 題號 under # and its name across every
 * other column; its other cells are spanned over. The control point rows render as before.
 */
function withSubheadings(columns: ColumnsType<AnswerRow>): ColumnsType<CardRow> {
  const leaves = (cs: ColumnsType<AnswerRow>): number => cs.reduce((n, c) => n + ('children' in c ? leaves(c.children) : 1), 0)
  const span = leaves(columns) - 1
  const wrap = (cs: ColumnsType<AnswerRow>): ColumnsType<CardRow> =>
    cs.map((c) => {
      if ('children' in c) return { ...c, children: wrap(c.children) } as ColumnType<CardRow>
      const column = c as ColumnType<AnswerRow>
      return {
        ...column,
        onCell: (row: CardRow, i?: number) => {
          if (!isSubheading(row)) return column.onCell?.(row, i) ?? {}
          const { level } = row.subheading
          if (column.key === 'number') return { style: { ...subheadingStyle(level), ...CARD_START } }
          if (column.key === 'text') return { colSpan: span, style: { ...subheadingNameStyle(level), ...CARD_END } }
          return { colSpan: 0 }
        },
        render: (value: unknown, row: CardRow, i: number) => {
          if (!isSubheading(row)) return column.render?.(value, row, i)
          const { section } = row.subheading
          if (column.key === 'number') return section.code
          return column.key === 'text' ? section.name : null
        },
      } as ColumnType<CardRow>
    })
  return wrap(columns)
}

/**
 * `style` added to a column's header and to its cells; a group has no cells of its own, so only its header gets it
 * (its last option is a column of its own).
 */
function withCellStyle<C extends ColumnType<AnswerRow>>(column: C, style: CSSProperties): C {
  return {
    ...column,
    onHeaderCell: (c) => {
      const header = column.onHeaderCell?.(c)
      return { ...header, style: { ...header?.style, ...style } }
    },
    ...('children' in column
      ? {}
      : {
          onCell: (r: AnswerRow, index?: number) => {
            const cell = column.onCell?.(r, index)
            return { ...cell, style: { ...cell?.style, ...style } }
          },
        }),
  }
}

/** The card's padding after the matrix's last column (CARD_END): on its header and cells, and on the group it ends. */
function endsCard(columns: ColumnsType<AnswerRow>): ColumnsType<AnswerRow> {
  return columns.map((c, i) => {
    if (i < columns.length - 1) return c
    const ended = withCellStyle(c as ColumnType<AnswerRow>, CARD_END)
    return 'children' in c ? { ...ended, children: endsCard(c.children) } : ended
  })
}
