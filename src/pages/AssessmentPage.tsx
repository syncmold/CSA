import { Alert, Breadcrumb, message, Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'
import { AnswerSheet } from '../components/AnswerSheet'
import { AppShell } from '../components/AppShell'
import { AssessmentStatusTag } from '../components/AssessmentStatusTag'
import { ExportPdfButton } from '../components/ExportPdfButton'
import { InfoStrip } from '../components/InfoStrip'
import { PageHeader } from '../components/PageHeader'
import { SignoffFlow } from '../components/SignoffFlow'
import { SignoffHistory } from '../components/SignoffHistory'
import { SignoffPanel } from '../components/SignoffPanel'
import { errorText } from '../domain/errors'
import { myAnswerStep, mySignStep, routeProgress, signerLabeler } from '../domain/signoff'
import { useAssessment } from '../hooks/useAssessments'
import { useSignerNames } from '../hooks/useEmployeeSearch'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useSignoffHistory } from '../hooks/useSignoff'

/**
 * Wide enough for the 簽核歷程 and the 簽核流程 side by side: below it the compact history would scroll sideways and a
 * three-unit route would not fit (checked at 1200 and 1440 with the side menu open).
 */
const SIDE_BY_SIDE = '(min-width: 1400px)'

/**
 * 自評表 (#4, answering since #5): the frozen snapshot with where it stands and who signs now: one 關卡 after the
 * 匯流, or how many 自評單位 are done while their 分流 run (Q116). When it is the signed-in 自行檢查人員's turn, the
 * control points and 整體結論 of their 自評單位 become inputs; everything else stays read-only. What may be written
 * and whether a submission is complete is decided by the database. A 主管 or 稽核 關卡 whose turn it is gets
 * 核准／退回 (#6); everyone who sees the page sees the 簽核歷程 and the 簽核流程 below the answers (side by side and of
 * one height on a wide screen, the 歷程 scrolling inside; one under the other otherwise) and can 匯出 PDF of the
 * 自評表 as it stands (#7). 方向 A (#131): the facts are one line under the title, and the way back is 首頁, as the side
 * menu calls it.
 */
export function AssessmentPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const assessment = useAssessment(id)
  const history = useSignoffHistory(id)
  const sideBySide = useMediaQuery(SIDE_BY_SIDE)
  // Owned here, not by AnswerSheet: a successful 送出 re-mounts the sheet and its message must survive that.
  const [messageApi, messageHolder] = message.useMessage()

  const signerNames = useSignerNames(assessment.data)

  const body = (() => {
    // Wait for this visit's own fetch: the answer sheet copies the saved answers into its inputs once, so
    // starting it from the cache of an earlier visit would show answers from before a later 暫存.
    if (assessment.isPending || !assessment.isFetchedAfterMount) return <Spin />
    if (assessment.isError) return <Alert type="warning" showIcon title={errorText(assessment.error)} />
    const a = assessment.data
    // RLS returns nothing both for "does not exist" and "not yours"; the page says so without telling which.
    if (!a) return <Alert type="info" showIcon title={t('assessments.notFound')} data-testid="assessment-not-found" />

    const label = signerLabeler({ signerNames }, history.data ?? [])
    const progress = routeProgress(a)
    const stepText =
      progress.kind === 'step'
        ? t('assessments.currentStepValue', { position: progress.step.position, total: a.assessment_step.length, name: progress.step.name })
        : progress.kind === 'branches'
          ? t('assessments.branchesValue', { done: progress.done, total: progress.total })
          : '—'
    const signer =
      progress.kind === 'step'
        ? progress.step.signer_emp_id ? label(progress.step.signer_emp_id) : t('assessments.unassigned')
        : progress.kind === 'branches'
          ? progress.current.map((s) => t('assessments.branchSigner', { unit: s.branch_unit_name, signer: label(s.signer_emp_id!) })).join('、') || t('assessments.unassigned')
          : '—'

    return (
      <>
        {/* The facts are one line under the title, the 匯出 PDF beside the title alone (方向 A, #131). */}
        <div>
          <PageHeader
            title={t('assessments.heading', { year: a.annual_cycle.year, plant: a.plant.name, code: a.template_code, name: a.template_name })}
            titleTestId="assessment-heading"
            extra={<ExportPdfButton assessmentId={a.id} notify={messageApi} />}
          />
          <div style={{ marginTop: 6 }}>
            <InfoStrip
              testId="assessment-info"
              items={[
                { key: 'year', label: t('assessments.year'), children: a.annual_cycle.year },
                { key: 'plant', label: t('assessments.plant'), children: `${a.plant.name}（${a.plant.factory_code}）` },
                { key: 'due', label: t('assessments.dueDate'), children: a.annual_cycle.due_date },
                {
                  key: 'status',
                  label: t('assessments.status'),
                  children: <AssessmentStatusTag status={a.status} />,
                },
                {
                  key: 'step',
                  label: t('assessments.currentStep'),
                  children: <span data-testid="current-step">{stepText}</span>,
                },
                { key: 'signer', label: t('assessments.currentSigner'), children: <span data-testid="current-signer">{signer}</span> },
              ]}
            />
          </div>
        </div>
        {/* Re-mount the answers when the signed-in employee's own 關卡 changes, so the inputs start from what was saved;
            other 分流 moving on leaves inputs being filled in alone. */}
        <AnswerSheet key={`${a.id}:${myAnswerStep(a)?.position ?? '-'}:${a.status}`} assessment={a} notify={messageApi} />
        <div
          style={
            sideBySide
              ? { display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', gap: 16, alignItems: 'stretch' }
              : { display: 'flex', flexDirection: 'column', gap: 16 }
          }
        >
          <SignoffHistory assessmentId={a.id} steps={a.assessment_step} compact={sideBySide} />
          <SignoffFlow assessment={a} />
        </div>
        {a.can_approve && <SignoffPanel key={`${a.id}:${mySignStep(a)?.position ?? '-'}`} assessment={a} notify={messageApi} />}
      </>
    )
  })()

  return (
    <AppShell>
      {messageHolder}
      <Breadcrumb
        items={[
          { title: <Link to="/">{t('app.navHome')}</Link> },
          { title: assessment.data ? `${assessment.data.template_code} ${assessment.data.template_name}` : '…' },
        ]}
      />
      {body}
    </AppShell>
  )
}
