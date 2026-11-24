import { Button, Flex, Popconfirm } from 'antd'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { RouteStepRow } from '../api/approvalRoutes'
import { type Branch, branchState, canDeleteBranchStep } from '../domain/routes'
import { INK, LINK_BUTTON, palette, textSize } from '../theme'
import { InkDot } from './InkDot'

/** A 分流 to fix (還沒設定, 範本沒用到) has a dashed red edge, besides the words in its heading. */
const CARD_EDGE: Record<ReturnType<typeof branchState>, CSSProperties> = {
  set: { border: `1px solid ${palette.border}` },
  missing: { border: `1px dashed ${INK.red.color}` },
  unused: { border: `1px dashed ${INK.red.color}` },
}

/**
 * One 分流 on the 流程編輯器 (Q116 (2)(3)), in 方向 A (#123): the unit's name on a grey band and its steps numbered in
 * order, each with who is 分派 there (`signer`, Q147: chosen on 分派填寫人, not here), or why it has none. While editing it
 * also offers 多加一關, 修改／刪除 a step, 建立 a new 分流, and deleting a 分流 the template no longer uses. The page owns
 * the writes; the card only says which was asked for.
 */
export function RouteBranchCard({
  branch,
  editing,
  signer,
  onAddStep,
  onEditStep,
  onDeleteStep,
  onSetUp,
  onDeleteBranch,
}: {
  branch: Branch
  editing: boolean
  /** Who is 分派 on a step, or that nobody is yet. */
  signer: (step: RouteStepRow) => ReactNode
  onAddStep: () => void
  onEditStep: (step: RouteStepRow) => void
  onDeleteStep: (step: RouteStepRow) => Promise<unknown>
  onSetUp: () => Promise<unknown>
  onDeleteBranch: () => Promise<unknown>
}) {
  const { t } = useTranslation('flows')
  const state = branchState(branch)
  const { unit, steps } = branch

  const tag = {
    set: <span style={{ color: palette.textTertiary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{t('stepCount', { count: steps.length })}</span>,
    missing: <InkDot ink="red">{t('missingTag')}</InkDot>,
    unused: <InkDot ink="red">{t('unusedTag')}</InkDot>,
  }[state]

  const note = { missing: 'missingNote', unused: 'unusedNote', set: null }[state]
  // The card's own button under its steps: 多加一關, 建立分流 or 刪除這條分流.
  const action = editing && (
    <>
      {state === 'set' && (
        <Button type="dashed" block onClick={onAddStep} data-testid="add-branch-step">
          {t('addBranchStep')}
        </Button>
      )}
      {state === 'missing' && (
        <Button type="dashed" block onClick={onSetUp} data-testid="set-up-branch">
          {t('setUpBranch')}
        </Button>
      )}
      {state === 'unused' && steps.length > 0 && (
        <Popconfirm title={t('deleteBranchConfirm', { unit: unit.name })} onConfirm={onDeleteBranch}>
          <Button danger block data-testid="delete-branch">
            {t('deleteBranch')}
          </Button>
        </Popconfirm>
      )}
    </>
  )

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', borderRadius: palette.radius, background: palette.surface, overflow: 'hidden', ...CARD_EDGE[state] }}
      data-testid={`branch-${unit.name}`}
    >
      <Flex
        align="center"
        justify="space-between"
        gap={8}
        style={{ padding: '8px 12px', background: palette.bg, borderBottom: `1px solid ${palette.border}` }}
      >
        <span style={{ fontWeight: 600, minWidth: 0 }}>{unit.name}</span>
        <span style={{ fontSize: textSize(13) }}>{tag}</span>
      </Flex>
      <Flex vertical gap={8} style={{ flex: 1, padding: '4px 12px 10px', fontSize: textSize(13) }}>
        {note && <div style={{ paddingTop: 4 }}>{t(note)}</div>}
        {steps.length > 0 && (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {steps.map((step, i) => (
              <li key={step.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0' }} data-testid="branch-step">
                <span aria-hidden style={{ flex: 'none', width: 16, textAlign: 'right', color: palette.textTertiary, fontVariantNumeric: 'tabular-nums' }}>
                  {i + 1}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {step.name}
                  <span style={{ display: 'block', fontSize: textSize(12) }} data-testid="branch-step-signer">
                    {signer(step)}
                  </span>
                </span>
                {editing && (
                  <Flex gap={12} style={{ flex: 'none' }}>
                    <Button type="link" size="small" style={LINK_BUTTON} onClick={() => onEditStep(step)} aria-label={t('editStep')}>
                      {t('editLink')}
                    </Button>
                    {canDeleteBranchStep(steps, step) && (
                      <Popconfirm title={t('deleteStepConfirm')} onConfirm={() => onDeleteStep(step)}>
                        <Button type="link" size="small" danger style={LINK_BUTTON}>
                          {t('delete')}
                        </Button>
                      </Popconfirm>
                    )}
                  </Flex>
                )}
              </li>
            ))}
          </ol>
        )}
        {action}
      </Flex>
    </div>
  )
}
