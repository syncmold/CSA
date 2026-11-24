// The PDF's last page: the whole 簽核歷程, as the 自評表 page shows it (#6), voided sign-offs and 退回 included.
import type { Content, TableCell } from 'pdfmake/interfaces'
import type { AssessmentStep } from '../api/assessments'
import type { Signoff } from '../api/signoffModel'
import { formatSigner, inSignedOrder, isSignOff, signedStepLabel, stepLabelAt } from '../domain/signoff'
import { formatSignedAt, HEADER_FONT_SIZE, TABLE_FONT_SIZE, THIN_RULES } from './print'

/**
 * The PDF's 簽核歷程 page. 關卡 are named as on screen, 「資材單位・部門主管」 (#99): the 分流 run side by side, so a
 * 「第 N 關」 would not be the order they signed in.
 */
export function historyPage(signoffs: Signoff[], steps: AssessmentStep[], timeZone: string): Content[] {
  // A 退回 says where it went on a line of its own, as on the 自評表 page.
  const action: Record<Signoff['action'], (s: Signoff) => { text: string } | { stack: string[] }> = {
    submit: () => ({ text: '送出' }),
    approve: () => ({ text: '核准' }),
    return: (s) => ({ stack: ['退回', `至 ${stepLabelAt(steps, s.return_to_position) ?? s.return_to_position}`] }),
  }
  const rows = inSignedOrder(signoffs)
  const head = ['簽核記錄編號', '時間', '關卡', '簽核人', '動作', '意見／原因', '狀態'].map(
    (text): TableCell => ({ text, fillColor: '#eeeeee', alignment: 'center' }),
  )
  const body: TableCell[][] = [
    head,
    ...rows.map((s): TableCell[] => {
      const color = s.voided_at ? '#888888' : undefined
      return [
        { text: String(s.serial_no), alignment: 'right' },
        { text: formatSignedAt(s.signed_at, timeZone) },
        { text: signedStepLabel(steps, s.step_position, s.step_name) },
        { text: formatSigner(s.signer_name, s.signer_emp_id) },
        action[s.action](s),
        { text: s.comment ?? '' },
        // Only a 送出 or 核准 can be voided; a 退回 stays as it is.
        { text: isSignOff(s) ? (s.voided_at ? '作廢' : '有效') : '', alignment: 'center' },
      ].map((cell) => ({ ...cell, color }) as TableCell)
    }),
  ]
  return [
    { text: '簽核歷程', fontSize: HEADER_FONT_SIZE, margin: [0, 0, 0, 4] },
    { text: '簽核以系統紀錄為憑（方案A）：帳號、姓名、時間與簽核記錄編號。作廢的簽核是被後來的退回取消的，仍保留在歷程中。', fontSize: TABLE_FONT_SIZE, margin: [0, 0, 0, 6] },
    {
      // Rows may break across pages, so a long 退回原因 is never cut off; the header row repeats. 動作 fits
      // 「至 資材單位・自行檢查人員」 on one line.
      table: { headerRows: 1, widths: [60, 84, 130, 90, 140, '*', 30], body },
      layout: THIN_RULES,
    },
    ...(rows.length === 0 ? [{ text: '還沒有任何簽核紀錄', alignment: 'center' as const, margin: [0, 8, 0, 0] as [number, number, number, number] }] : []),
  ]
}
