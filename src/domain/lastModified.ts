// 最後修改＝時間＋修改人（#201, Q137 (3)): what 範本管理 and 簽核流程 show of the last write to a 範本 or 簽核流程. The
// database records it on every write (抬頭, 章節, 控制要點, 自評單位; any 關卡) and keeps only the last one (Q128 (1)).
import dayjs from 'dayjs'
import { ADMIN_EMP_ID } from '../../exchange/adminAccount'

/** The three columns the database gives a 範本 and a 簽核流程 (`updated_by_name` is a computed column). */
export interface LastModifiedFields {
  updated_at: string
  /** 修改人's 工號 (the 管理員帳號's is `admin`); null when the write had none (對話寫入, a conversion) or predates #201. */
  updated_by: string | null
  /** The 修改人's name from 員工參照; null when it has none. */
  updated_by_name: string | null
}

/** When, to the minute, as on every list. */
export const modifiedAt = (row: LastModifiedFields) => dayjs(row.updated_at).format('YYYY-MM-DD HH:mm')

/**
 * Who: the name, else the 工號, else 「—」. The 管理員帳號 has no name of its own and shows as `adminLabel`
 * (管理員帳號), as the 權限異動紀錄's 操作者 does (使用者 2026-11-18).
 */
export const modifiedBy = (row: LastModifiedFields, adminLabel: string) =>
  row.updated_by === ADMIN_EMP_ID ? adminLabel : row.updated_by_name || row.updated_by || '—'

/** Between the time and the 修改人 when they share a line (the 範本明細's header): two full-width spaces. */
export const LAST_MODIFIED_GAP = '　　'
