import { Select, Spin, Typography } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PickerRow } from '../../exchange/core'
import { omsCouldNotAnswer } from '../api/people'
import { bringInToStep, type Reminder } from '../domain/people'
import { formatSigner } from '../domain/signoff'
import { COMPLETE_EMP_ID, useLookUpPeople, usePersonLookup, usePlantPeople } from '../hooks/useEmployeeSearch'
import { textSize } from '../theme'

/** What to tell the 分派 page about someone just chosen: OMS's reminders, or that OMS could not be asked about them. */
export type PickNote = Reminder | 'unchecked'

/**
 * 分派's picker (#218, Q133 (11) ④): the people already on this plant's 自評表, narrowed by what is typed, or anyone by
 * their complete 工號, asked of OMS through the CSA backend. No list of a plant's employees and no search of everyone by
 * name: OMS's channel has neither, and CSA's own list of names is not for browsing.
 *
 * Whoever is chosen is checked with OMS first (bringInToStep: 在職 and on the 放行名單, Q150), so someone who left since last year is not assigned
 * again. When OMS itself cannot answer, someone already on this plant's forms is assigned all the same, and the page is
 * told so ('unchecked'). Choosing is the save; the page shows the person once the database has them. `open` starts it
 * unfolded, for 換人; `onClose` is told when it is left without choosing.
 */
export function PlantEmployeeSelect({
  factoryCode,
  onPick,
  open = false,
  onClose,
}: {
  factoryCode: string
  onPick: (row: PickerRow, notes: PickNote[]) => void
  open?: boolean
  onClose?: () => void
}) {
  const { t } = useTranslation('assignment')
  const [term, setTerm] = useState('')
  // Choosing is not holding a value: each choice, assigned or refused, starts the Select over, so the same person can be
  // chosen again after a refusal.
  const [round, setRound] = useState(0)
  const [checking, setChecking] = useState(false)
  /** Why the last choice was not assigned. */
  const [refused, setRefused] = useState<string | null>(null)
  const people = usePlantPeople(factoryCode)
  const lookUp = useLookUpPeople(factoryCode)

  const typed = term.trim().toUpperCase()
  const onForms = people.data ?? []
  const listed = onForms.filter((p) => !typed || p.emp_id.toUpperCase().includes(typed) || (p.name ?? '').toUpperCase().includes(typed))
  // OMS is asked about what is typed unless it is exactly someone on the list (a 工號 that is part of a listed one is
  // still someone else's); each 工號 asked counts against OMS's daily limit.
  const onList = onForms.some((p) => p.emp_id.toUpperCase() === typed)
  const lookup = usePersonLookup(onList || !people.isFetched ? '' : term, factoryCode)
  const verdict = lookup.person ? bringInToStep(lookup.person) : null
  const found = lookup.person && verdict?.ok ? { person: lookup.person, reminders: verdict.reminders } : null

  const options = [
    ...listed.map((p) => ({ value: p.emp_id, label: formatSigner(p.name, p.emp_id) })),
    ...(found
      ? [{
          value: found.person.emp_id,
          label: [formatSigner(found.person.name, found.person.emp_id), ...found.reminders.map((r) => t(`picker.option.${r}`, { plant: found.person.factory_code }))].join(''),
        }]
      : []),
  ]

  /** OMS's word on the person chosen, then the save; whoever may not be brought in is not assigned, and why is shown. */
  const choose = async (empId: string) => {
    setRefused(null)
    setChecking(true)
    setRound((n) => n + 1)
    const known = onForms.find((p) => p.emp_id === empId)
    const unchecked = () => onPick({ emp_id: known!.emp_id, name: known!.name ?? '', factory_code: '' }, ['unchecked'])
    try {
      // A 工號 on the plant's forms that cannot be asked about at all (not one OMS could hold) is assigned as it was.
      if (known && !COMPLETE_EMP_ID.test(empId.trim())) return unchecked()
      const [person] = await lookUp([empId])
      const answer = bringInToStep(person)
      if (!answer.ok) return setRefused(t(`picker.refused.${answer.reason}`, { empId }))
      onPick({ emp_id: person!.emp_id, name: person!.name ?? known?.name ?? '', factory_code: person!.factory_code ?? '' }, answer.reminders)
    } catch (error) {
      // Only OMS itself not answering lets someone already on this plant's forms through without the check.
      if (known && omsCouldNotAnswer(error)) return unchecked()
      const code = error instanceof Error ? error.message : String(error)
      setRefused(t([`picker.errors.${code}`, 'picker.errors.other'], { code }))
    } finally {
      setChecking(false)
    }
  }

  const refusal = lookup.person && verdict && !verdict.ok ? t(`picker.refused.${verdict.reason}`, { empId: lookup.person.asked }) : null
  const nothing = lookup.searching || people.isLoading ? (
    <Spin size="small" />
  ) : people.isError ? (
    <Typography.Text type="danger">{t('picker.listFailed')}</Typography.Text>
  ) : lookup.error ? (
    <Typography.Text type="danger">{t([`picker.errors.${lookup.error}`, 'picker.errors.other'], { code: lookup.error })}</Typography.Text>
  ) : refusal ? (
    <Typography.Text type="secondary">{refusal}</Typography.Text>
  ) : (
    <Typography.Text type="secondary">{t(typed ? 'picker.typeAll' : 'picker.nobodyYet')}</Typography.Text>
  )

  return (
    <>
      <Select
        key={round}
        loading={checking}
        disabled={checking}
        onChange={(empId: string) => void choose(empId)}
        showSearch={{ filterOption: false, onSearch: setTerm }}
        placeholder={t('pick')}
        options={options}
        notFoundContent={nothing}
        defaultOpen={open && round === 0}
        autoFocus={open}
        onBlur={() => {
          // Leaving it, refused or not, goes back to whoever holds the 關卡 (換人); a check under way finishes first.
          if (!checking) onClose?.()
        }}
        style={{ width: '100%' }}
        data-testid="plant-employee-select"
      />
      {refused && (
        <Typography.Text type="danger" style={{ display: 'block', fontSize: textSize(12) }} data-testid="picker-refused">
          {refused}
        </Typography.Text>
      )}
    </>
  )
}
