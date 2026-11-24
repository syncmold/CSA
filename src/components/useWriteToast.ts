import { message } from 'antd'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { writeErrorMessage } from '../domain/templates'

/**
 * How a page words a refused write: message keys per Postgres error code on top of the 範本管理 defaults,
 * or its own function (the 流程編輯器 words its refusals by the hint the database sends back).
 */
export type DescribeError = Record<string, string> | ((error: unknown) => string)

export function describeWriteError(t: TFunction, error: unknown, describe?: DescribeError): string {
  return typeof describe === 'function' ? describe(error) : writeErrorMessage(t, error, describe)
}

/**
 * For one-click actions (delete, drag, rename in place): a refusal becomes a toast instead
 * of an error the page has to catch. Render `holder` once in the page.
 */
export function useWriteToast(describe?: DescribeError) {
  const { t } = useTranslation()
  const [messageApi, holder] = message.useMessage()
  /** Resolves true when the write succeeded, false when it was refused (and the toast shown). */
  const withToast = (write: Promise<unknown>) =>
    write.then(
      () => true,
      (error) => {
        messageApi.error(describeWriteError(t, error, describe))
        return false
      },
    )
  return { holder, messageApi, withToast }
}
