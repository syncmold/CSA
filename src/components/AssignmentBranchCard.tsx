import { Button, Flex } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PickerRow } from '../../exchange/core'
import type { AssignableStep } from '../api/assignment'
import type { AssignmentBranch, BranchStatus } from '../domain/assignment'
import { nameInBranch } from '../domain/signoff'
import { INK, type Ink, palette, textSize } from '../theme'
import { PlantEmployeeSelect, type PickNote } from './PlantEmployeeSelect'

/**
 * 方向 A (#126): 待分派 orange (待處理), 已開始 blue (進行中), 已核准 and a route's 已分派 green (完成); the words say it
 * too.
 */
const STATUS_INKS: Record<BranchStatus, Ink> = { unassigned: 'orange', assigned: 'green', started: 'blue', approved: 'green' }

/**
 * What the page gives every 關卡, on a 簽核流程 (下次發出) or an issued 自評表 alike: the plant whose employees may be
 * chosen, how to show a 工號, and the write.
 */
export interface AssignContext {
  factoryCode: string
  /**
   * Whether picking and 換人 are offered (Q147): on a route for a 稽核主管 and the plant's 廠區管理員; once the forms are
   * out only for a 稽核主管, others only see who is on them.
   */
  canChange: boolean
  person: (empId: string) => string
  onAssign: (step: AssignableStep, row: PickerRow, notes: PickNote[]) => Promise<unknown>
}

/**
 * One 關卡's 簽核人: a picker while 待分派, under who left when it is 從缺 (in red, only on a 自評表 issued before Q147);
 * the person with 換人 until it is signed (Q116 (7), the one whose turn it is too: the answers stay on the 自評表; a
 * route's 關卡 are never signed); once signed, the person with 已簽 in green and nothing to press. Without `canChange`,
 * the person or 待分派 as plain text.
 */
export function StepSigner({ step, context }: { step: AssignableStep; context: AssignContext }) {
  const { t } = useTranslation('assignment')
  const [changing, setChanging] = useState(false)
  const { signer_emp_id: signer } = step

  if (signer === null && !context.canChange) {
    return <span style={{ color: INK.orange.color }} data-testid="step-unassigned">{t('branch.unassigned')}</span>
  }
  if (signer === null || changing) {
    return (
      <>
        {step.vacated_emp_id && (
          <Flex gap={6} wrap style={{ color: INK.red.color, fontSize: textSize(12) }} data-testid="step-vacant">
            <span>{t('vacant')}</span>
            <span>{t('vacatedFrom', { person: step.vacated_name ?? step.vacated_emp_id })}</span>
          </Flex>
        )}
        <PlantEmployeeSelect
          factoryCode={context.factoryCode}
          open={changing}
          onClose={() => setChanging(false)}
          onPick={(row, notes) => {
            setChanging(false)
            void context.onAssign(step, row, notes)
          }}
        />
      </>
    )
  }
  return (
    <Flex align="center" justify="space-between" gap={8} wrap>
      <span>{context.person(signer)}</span>
      {step.state === 'done' ? (
        <span style={{ color: INK.green.color }} data-testid="step-signed">
          {t('signed')}
        </span>
      ) : context.canChange && (
        <Button type="link" size="small" style={{ padding: 0, height: 'auto', fontSize: 'inherit' }} onClick={() => setChanging(true)} data-testid="reassign">
          {t('reassign')}
        </Button>
      )}
    </Flex>
  )
}

/**
 * One 分流 on the 分派 page: its unit and status on a grey band, then its 關卡 in order, each its number and name over
 * who is on it (方向 A, #126: square 4px corners, lines between the 關卡, no circles).
 */
export function AssignmentBranchCard({ branch, context }: { branch: AssignmentBranch; context: AssignContext }) {
  const { t } = useTranslation('assignment')
  const line = `1px solid ${palette.border}`
  return (
    <section style={{ border: line, borderRadius: palette.radius, background: palette.surface, overflow: 'hidden' }} data-testid={`assign-branch-${branch.unit}`}>
      <Flex align="center" justify="space-between" gap={8} style={{ padding: '8px 12px', background: palette.bg, borderBottom: line }}>
        <span style={{ fontWeight: 600 }}>{branch.unit}</span>
        <span style={{ fontSize: textSize(13), color: INK[STATUS_INKS[branch.status]].color, whiteSpace: 'nowrap' }}>{t(`branch.${branch.status}`)}</span>
      </Flex>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: textSize(13) }}>
        {branch.steps.map((step, i) => (
          <li
            key={step.id}
            style={{ padding: '8px 12px', borderTop: i === 0 ? 'none' : `1px solid ${palette.rowLine}`, display: 'flex', flexDirection: 'column', gap: 2 }}
            data-testid="assign-step"
          >
            <span style={{ color: palette.textTertiary }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', marginInlineEnd: '1em' }}>{i + 1}</span>
              {nameInBranch(step)}
            </span>
            <StepSigner step={step} context={context} />
          </li>
        ))}
      </ol>
    </section>
  )
}
