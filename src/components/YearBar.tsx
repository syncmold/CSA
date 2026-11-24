import { Flex, Select } from 'antd'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { YearChoice } from '../hooks/useYearChoice'
import { palette } from '../theme'
import { ChoiceBar } from './ChoiceBar'

/**
 * 年度發起's 年度 menu (#175) with `note` beside it on what launching the chosen year does: the next year to launch in
 * pale purple, a launched one (topped up) in grey. 範本管理 and 簽核流程 have no 年度 (Q137 (2)).
 */
export function YearBar({ choice, onChange, note }: { choice: YearChoice; onChange: (year: number) => void; note: ReactNode }) {
  const { t } = useTranslation()
  return (
    <ChoiceBar launched={choice.launched} label={t('years.label')} note={note} testId="year-bar" noteTestId="year-note">
      <Flex align="center" gap={8}>
        <label htmlFor="csa-year" style={{ color: palette.textSecondary }}>
          {t('years.label')}
        </label>
        <Select<number>
          id="csa-year"
          value={choice.year}
          onChange={onChange}
          popupMatchSelectWidth={false}
          style={{ minWidth: 220 }}
          data-testid="year-select"
          options={choice.options.map((o) => ({
            value: o.year,
            label: t(o.launched ? 'years.launched' : 'years.next', { year: o.year }),
          }))}
        />
      </Flex>
    </ChoiceBar>
  )
}
