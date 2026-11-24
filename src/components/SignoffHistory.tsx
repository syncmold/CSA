import { Alert, Card, Flex, Table, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import type { HTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssessmentStep } from '../api/assessments'
import type { Signoff } from '../api/signoff'
import { errorText } from '../domain/errors'
import { formatSigner, signedStepLabel, stepLabelAt } from '../domain/signoff'
import { useSignoffHistory } from '../hooks/useSignoff'
import { InkDot } from './InkDot'
import { NO_WRAP } from './tableColumns'
import { CARD_HEADER_STYLE, CARD_STYLE, type Ink, palette } from '../theme'

/** The 動作 in the colour of its meaning (方向 A, #131): 送出 moves it on, 核准 passes it, 退回 sends it back to be redone. */
const ACTION_INK: Record<Signoff['action'], Ink> = { submit: 'blue', approve: 'green', return: 'orange' }
/** Least width that keeps the 意見／原因 column readable beside the columns that never wrap (full width). */
const TABLE_WIDTH = 900
/**
 * The scrolling box of a compact 簽核歷程. It reaches the card's edges and pads itself back by the card's padding
 * (csa-edge-row), so the csa-edge-table inside still runs edge to edge without scrolling sideways by that padding.
 */
const COMPACT_SCROLL_BOX = {
  // A 0px basis, not flex: 1's 0%: while the row is being sized a percentage basis counts as the whole table's height.
  flex: '1 1 0px',
  height: 0,
  minHeight: 160,
  overflow: 'auto',
} as const

/**
 * 簽核歷程 (#6): every 送出, 核准 and 退回 of the 自評表 in time order, voided sign-offs included. `compact` is the form
 * beside the 簽核流程: the card takes the height its row gives it and the table scrolls inside, its header kept in view,
 * and it fits its width without scrolling sideways (使用者 2026-11-02): five columns instead of seven, the 簽核人 under
 * the 關卡, the 狀態 under the 動作, the time on two lines.
 */
export function SignoffHistory({ assessmentId, steps, compact = false }: { assessmentId: string; steps: AssessmentStep[]; compact?: boolean }) {
  const { t } = useTranslation('signoff')
  const history = useSignoffHistory(assessmentId)

  // 「資材單位・部門主管」, not 「第 N 關」 (#99); the name as it was signed under.
  const step = (r: Signoff) => signedStepLabel(steps, r.step_position, r.step_name)
  const returnedTo = (r: Signoff) => stepLabelAt(steps, r.return_to_position) ?? String(r.return_to_position)
  // The name as it was when signing: the history is a record, not today's directory.
  const signer = (r: Signoff) => formatSigner(r.signer_name, r.signer_emp_id)
  // A 退回 names its target under the tag, wrapping: on one line it would squeeze the 關卡 column (#99).
  const action = (r: Signoff) => (
    <Flex vertical align="start" gap={2}>
      <InkDot ink={ACTION_INK[r.action]} strong>
        {t(`history.actions.${r.action}`)}
      </InkDot>
      {r.action === 'return' && (
        <Typography.Text type="secondary" style={{ whiteSpace: 'normal', maxWidth: '9em', fontSize: 'inherit' }}>
          {t('history.returnTo', { step: returnedTo(r) })}
        </Typography.Text>
      )}
    </Flex>
  )
  // Only 作廢 is coloured; 有效 is the usual case and stays grey words.
  const state = (r: Signoff) =>
    r.action === 'return' ? null : r.voided_at ? (
      <InkDot ink="red">{t('history.voided')}</InkDot>
    ) : (
      <Typography.Text type="secondary" style={{ fontSize: 'inherit' }}>
        {t('history.valid')}
      </Typography.Text>
    )
  const serialNo: ColumnsType<Signoff>[number] = {
    title: t(compact ? 'history.serialNoShort' : 'history.serialNo'),
    dataIndex: 'serial_no',
    align: 'right',
    ...NO_WRAP,
  }
  const signedAt: ColumnsType<Signoff>[number] = {
    title: t('history.signedAt'),
    dataIndex: 'signed_at',
    ...NO_WRAP,
    render: (v: string) =>
      compact ? (
        <>
          {dayjs(v).format('YYYY-MM-DD')}
          <br />
          {dayjs(v).format('HH:mm:ss')}
        </>
      ) : (
        dayjs(v).format('YYYY-MM-DD HH:mm:ss')
      ),
  }
  const comment: ColumnsType<Signoff>[number] = {
    title: t('history.comment'),
    dataIndex: 'comment',
    // A least width of its own: beside the never-wrapping columns it would otherwise shrink to one character a line.
    render: (v: string | null) => (
      <Typography.Text style={{ whiteSpace: 'pre-wrap', display: 'block', minWidth: compact ? '6em' : 160 }}>{v}</Typography.Text>
    ),
  }

  const columns: ColumnsType<Signoff> = compact
    ? [
        serialNo,
        signedAt,
        {
          title: t('history.stepAndSigner'),
          key: 'step',
          render: (_, r) => (
            <div data-testid="signoff-step-signer">
              <div>{step(r)}</div>
              <Typography.Text type="secondary">{signer(r)}</Typography.Text>
            </div>
          ),
        },
        {
          title: t('history.actionAndState'),
          key: 'action',
          ...NO_WRAP,
          render: (_, r) => (
            <Flex vertical align="start" gap={4} data-testid="signoff-action-state">
              {action(r)}
              {state(r)}
            </Flex>
          ),
        },
        comment,
      ]
    : [
        serialNo,
        signedAt,
        { title: t('history.step'), key: 'step', ...NO_WRAP, render: (_, r) => step(r) },
        { title: t('history.signer'), key: 'signer', ...NO_WRAP, render: (_, r) => signer(r) },
        { title: t('history.action'), dataIndex: 'action', ...NO_WRAP, render: (_, r) => action(r) },
        comment,
        { title: t('history.state'), key: 'state', ...NO_WRAP, render: (_, r) => state(r) },
      ]

  return (
    <Card
      title={t('history.title')}
      size="small"
      data-testid="signoff-history"
      style={compact ? { ...CARD_STYLE, height: '100%', display: 'flex', flexDirection: 'column' } : CARD_STYLE}
      styles={{
        header: CARD_HEADER_STYLE,
        // The table ends the card: no padding below it.
        body: { padding: '12px var(--csa-card-pad) 0', ...(compact ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : {}) },
      }}
    >
      {history.isError ? (
        <Alert type="warning" showIcon title={errorText(history.error)} style={{ marginBottom: 12 }} />
      ) : (
        <>
          <Typography.Paragraph type="secondary">{t('history.note')}</Typography.Paragraph>
          {/* Compact: no height of its own (height 0, grow), so the row's height comes from the 簽核流程 alone; this box
              scrolls it and the header row sticks to its top (csa-sticky-head). antd's own scroll.y would need fixed
              column widths, which the shrink-to-fit NO_WRAP columns do not have. */}
          <div className={compact ? 'csa-edge-row' : undefined} style={compact ? COMPACT_SCROLL_BOX : undefined} data-testid={compact ? 'signoff-history-scroll' : undefined}>
            <Table<Signoff>
              className={compact ? 'csa-edge-table csa-edge-bottom csa-sticky-head' : 'csa-edge-table csa-edge-bottom'}
              rowKey="serial_no"
              size="small"
              pagination={false}
              // Compact: no antd scroll (the box scrolls it up and down) and no least width, so it fits beside the 簽核流程.
              scroll={compact ? undefined : { x: TABLE_WIDTH }}
              loading={history.isPending}
              dataSource={history.data}
              columns={columns}
              locale={{ emptyText: t('history.empty') }}
              onRow={(r) =>
                ({
                  'data-testid': 'signoff-row',
                  'data-action': r.action,
                  'data-voided': r.voided_at ? 'true' : 'false',
                  style: r.voided_at ? { color: palette.textTertiary } : undefined,
                }) as HTMLAttributes<HTMLElement>
              }
            />
          </div>
        </>
      )}
    </Card>
  )
}
