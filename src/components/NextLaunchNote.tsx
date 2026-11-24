import { Trans } from 'react-i18next'
import { Link } from 'react-router'
import { NOTE_BOX, palette } from '../theme'

/**
 * The line under 範本管理's and 簽核流程's titles (Q137 (2)): what is edited here is the template or route itself, used
 * by the next launch and top-up; what was issued keeps its own copy (ADR-0004), found in 自評表紀錄. `subject` is what
 * the page edits (題目, 簽核流程). White with a thin border, as the other notes.
 */
export function NextLaunchNote({ subject }: { subject: string }) {
  return (
    <div style={{ ...NOTE_BOX, color: palette.textSecondary }} role="note" data-testid="next-launch-note">
      <Trans i18nKey="nextLaunch.note" ns="common" values={{ subject }} components={{ records: <Link to="/records" data-testid="to-records" /> }} />
    </div>
  )
}
