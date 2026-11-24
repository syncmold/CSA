// 管理員帳號 (Q122 (5), #161): OMS's 系統管理帳號, which belongs to no employee. Its own module, with no imports, so the
// page can share these without pulling the exchange (and jose) into the browser bundle.

/**
 * OMS gives it no 工號, so it is known by this Email, as the 主管's GHG does (使用者 2026-11-11: fixed here, not a
 * setting). OMS checks its password; CSA keeps none.
 */
export const ADMIN_EMAIL = 'admin@id.syncmold.com.tw'
/**
 * The 工號 its CSA session carries. No employee has it, and the database keeps it off the 放行名單 and employee_ref:
 * supabase/migrations/20261118000000_admin_account.sql spells it out again, so change both together.
 */
export const ADMIN_EMP_ID = 'admin'
/** Its name in its session, where a person's name shows (the side menu). */
export const ADMIN_NAME = '管理員帳號'
