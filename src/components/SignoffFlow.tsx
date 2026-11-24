import { Card, Flex, Typography } from 'antd'
import dayjs from 'dayjs'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssessmentView } from '../api/assessments'
import { branchColumns, maxBranchColumns, nameInBranch, routeLayout, stepLabel, type RouteStep } from '../domain/signoff'
import { useSignerNames } from '../hooks/useEmployeeSearch'
import { useSignoffHistory } from '../hooks/useSignoff'
import { CARD_HEADER_STYLE, CARD_STYLE, INK, palette, textSize } from '../theme'
import { InkDot } from './InkDot'
import { useElementWidth } from './useElementWidth'

/**
 * A 關卡's outline and fill by where it stands (方向 A, #131): done green, its turn the selected item's purple with a
 * thicker edge, not yet a dashed grey, 待分派 a dashed orange. The current one's padding is a pixel less for its
 * thicker edge, so every 關卡 is the same size; edge and padding together stay 7px a side, which BRANCH_MIN counts on.
 */
const STEP_STYLE: Record<RouteStep['state'], CSSProperties> = {
  done: { border: `1px solid ${INK.green.color}`, background: INK.green.background, padding: '4px 6px' },
  current: { border: `2px solid ${palette.primary}`, background: palette.selectedBg, padding: '3px 5px' },
  todo: { border: `1px dashed ${palette.dashed}`, background: palette.surface, padding: '4px 6px' },
  unassigned: { border: `1px dashed ${INK.orange.color}`, background: INK.orange.background, padding: '4px 6px' },
}
/** The states the legend under the route explains; a 關卡 待分派 says so in its own words. */
const LEGEND: RouteStep['state'][] = ['done', 'current', 'todo']

const GROUP_STYLE: CSSProperties = {
  background: palette.bg,
  border: `1px solid ${palette.border}`,
  borderRadius: palette.radius,
  padding: 6,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

/** Connector colour: green once what it leaves is done, otherwise the grey of a 關卡 not yet reached. */
const lineColor = (on: boolean) => (on ? INK.green.color : palette.dashed)

/** The down arrow between two 關卡, green once the one above it is done. */
function Arrow({ on, length = 6 }: { on: boolean; length?: number }) {
  const color = lineColor(on)
  return (
    <div aria-hidden style={{ alignSelf: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '1px 0' }}>
      <div style={{ width: 2, height: length, background: color }} />
      <div style={{ width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: `5px solid ${color}` }} />
    </div>
  )
}

/**
 * A 分流 card's narrowest width: 「自行檢查人員」 stays on one line (6 × 15px, 15px of 關卡 padding and border, 14px of
 * the card's). The cards take as many even rows as they need, so no 單位數 or width ever scrolls sideways; on a page
 * narrower than one card they stand in one column at the page's width.
 */
const BRANCH_MIN = 120
const BRANCH_GAP = 8

const ZoneLabel = ({ children }: { children: ReactNode }) => (
  <Typography.Text type="secondary" style={{ fontSize: textSize(12), marginBottom: 4 }}>
    {children}
  </Typography.Text>
)

/**
 * 簽核流程 (#6, drawn as 分流 since Q116) at the foot of the 自評表, kept small beside the 簽核歷程: each 自評單位's 關卡
 * in its own card, the 匯流 that waits for every card, then the 廠區 關卡 after it and 稽核室覆核 in order. Every 關卡
 * shows its name and 簽核人; its outline says where it stands, as the database left it (assessment_step.state): green
 * done, purple its turn, dashed not yet, orange 待分派, with a legend underneath (方向 A, #131). The 工號 and the time
 * are in its tooltip and in the 簽核歷程. Signing happens in the panel, not here.
 */
export function SignoffFlow({ assessment: a }: { assessment: AssessmentView }) {
  const { t } = useTranslation('signoff')
  const history = useSignoffHistory(a.id)
  const signerNames = useSignerNames(a)
  const layout = routeLayout({ ...a, signerNames }, history.data ?? [])
  const { ref, width } = useElementWidth<HTMLDivElement>()

  const stepBox = (r: RouteStep, title: string) => (
    <div
      key={r.step.id}
      data-testid="route-step"
      data-state={r.state}
      data-position={r.step.position}
      title={[
        stepLabel(r.step),
        r.signer ?? t('route.unassigned'),
        ...(r.signoff ? [dayjs(r.signoff.signed_at).format('YYYY-MM-DD HH:mm')] : []),
      ].join('\n')}
      style={{ ...STEP_STYLE[r.state], borderRadius: palette.radius, textAlign: 'center', minWidth: 0, fontSize: textSize(12) }}
    >
      <div style={{ fontWeight: 600, fontSize: textSize(13), color: r.state === 'todo' ? palette.textSecondary : palette.text }}>{title}</div>
      {r.signerName ? (
        <div style={{ color: palette.textSecondary }}>{r.signerName}</div>
      ) : (
        <div style={{ color: INK.orange.color, fontWeight: 500 }}>{t('route.unassigned')}</div>
      )}
    </div>
  )

  /** 關卡 one under the other with arrows. */
  const column = (steps: RouteStep[], titleOf: (r: RouteStep) => string) =>
    steps.map((r, i) => (
      <Flex key={r.step.id} vertical>
        {i > 0 && <Arrow on={steps[i - 1]!.state === 'done'} />}
        {stepBox(r, titleOf(r))}
      </Flex>
    ))

  const branchCount = layout.branches.length
  const hasBranches = branchCount > 0
  const doneCount = layout.branches.filter((b) => b.done).length
  const allBranchesDone = hasBranches && doneCount === branchCount
  const tail = [...layout.merged, ...layout.audit]
  const closed = a.status === 'closed'
  // A shorter last row stays centred at the cards' width; the cards of a row stretch to one height.
  const columns = branchColumns(branchCount, maxBranchColumns(width, BRANCH_MIN, BRANCH_GAP))
  const cardBasis = `calc((100% - ${(columns - 1) * BRANCH_GAP}px) / ${columns})`

  return (
    <Card title={t('route.title')} size="small" style={CARD_STYLE} styles={{ header: CARD_HEADER_STYLE, body: { padding: '12px var(--csa-card-pad) 14px' } }} data-testid="signoff-route">
      {hasBranches && <ZoneLabel>{t('route.branches')}</ZoneLabel>}
      <Flex vertical ref={ref}>
        {hasBranches && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: BRANCH_GAP }}>
              {layout.branches.map((b) => (
                <div key={b.unit} style={{ ...GROUP_STYLE, boxSizing: 'border-box', flex: `0 0 ${cardBasis}` }} data-testid="route-branch" data-unit={b.unit}>
                  <Flex justify="space-between" align="center" wrap gap={4} style={{ fontWeight: 600, fontSize: textSize(13), marginBottom: 4 }}>
                    <span>{b.unit}</span>
                    {b.returns > 0 && <InkDot ink="red">{t('route.returns', { count: b.returns })}</InkDot>}
                  </Flex>
                  {column(b.steps, (r) => nameInBranch(r.step))}
                </div>
              ))}
            </div>
            <Arrow on={allBranchesDone} />
            <Flex justify="center" data-testid="route-merge" style={{ margin: '8px 0', fontSize: textSize(12) }}>
              <div
                style={{
                  width: 36, height: 36, transform: 'rotate(45deg)', borderRadius: palette.radius, display: 'grid', placeItems: 'center',
                  border: `1.5px solid ${allBranchesDone ? INK.green.color : palette.dashed}`,
                  background: allBranchesDone ? INK.green.background : palette.surface,
                }}
              >
                <span style={{ transform: 'rotate(-45deg)', fontWeight: 600, color: allBranchesDone ? INK.green.color : palette.text }}>
                  {doneCount}/{branchCount}
                </span>
              </div>
            </Flex>
            {tail.length > 0 && <Arrow on={allBranchesDone} />}
          </>
        )}
        <Flex vertical align="stretch" style={{ alignSelf: 'center', width: '100%', maxWidth: 300 }}>
          {column(layout.merged, (r) => r.step.name)}
          {layout.audit.length > 0 && (
            <>
              {layout.merged.length > 0 && <Arrow on={layout.merged.at(-1)!.state === 'done'} />}
              <div style={GROUP_STYLE}>
                <ZoneLabel>{t('route.audit')}</ZoneLabel>
                {column(layout.audit, (r) => r.step.name)}
              </div>
            </>
          )}
          {tail.length > 0 && <Arrow on={closed} />}
          <Flex justify="center">
            <div
              style={{
                ...(closed ? STEP_STYLE.done : { border: `1px solid ${palette.controlBorder}`, background: palette.surface }),
                borderRadius: palette.radius,
                padding: '2px 14px',
                color: closed ? INK.green.color : palette.textSecondary,
              }}
            >
              {t('route.closed')}
            </div>
          </Flex>
        </Flex>
      </Flex>
      <Flex
        wrap
        justify="center"
        gap="4px 16px"
        style={{ marginTop: 12, paddingTop: 8, borderTop: `1px solid ${palette.rowLine}`, color: palette.textSecondary, fontSize: textSize(12) }}
        data-testid="route-legend"
      >
        {LEGEND.map((state) => (
          <Flex key={state} align="center" gap={6}>
            <span aria-hidden style={{ ...STEP_STYLE[state], padding: 0, width: 14, height: 10, boxSizing: 'border-box' }} />
            {t(`route.legend.${state}`)}
          </Flex>
        ))}
      </Flex>
    </Card>
  )
}
