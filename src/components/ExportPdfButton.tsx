import { DownOutlined, FilePdfOutlined } from '@ant-design/icons'
import { Button, Dropdown, message, Tooltip } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorText } from '../domain/errors'
import { useExportPdf, usePreloadPdfExport } from '../hooks/useExportPdf'

type Notify = ReturnType<typeof message.useMessage>[0]

/**
 * 匯出 PDF (#7): anyone who can see the 自評表 can export it, at any 關卡 and after 結案, choosing the version with
 * or without the sign-off times from the menu (Q109).
 */
export function ExportPdfButton({ assessmentId, notify }: { assessmentId: string; notify: Notify }) {
  const { t } = useTranslation('pdf')
  const exportPdf = useExportPdf(assessmentId)
  usePreloadPdfExport()
  // The tooltip would cover the menu it explains, so it stays hidden while the menu is open.
  const [menuOpen, setMenuOpen] = useState(false)

  const run = (withSignedAt: boolean) =>
    exportPdf.mutate(withSignedAt, {
      onSuccess: (found) => {
        if (!found) void notify.warning(t('notFound'))
      },
      onError: (error) => void notify.error(t('failed', { error: errorText(error) })),
    })

  return (
    <Dropdown
      trigger={['click']}
      disabled={exportPdf.isPending}
      onOpenChange={setMenuOpen}
      menu={{
        items: [
          { key: 'withSignedAt', label: <span data-testid="export-pdf-with-signed-at">{t('withSignedAt')}</span> },
          { key: 'withoutSignedAt', label: <span data-testid="export-pdf-without-signed-at">{t('withoutSignedAt')}</span> },
        ],
        onClick: ({ key }) => run(key === 'withSignedAt'),
      }}
    >
      <Tooltip title={t('exportTip')} open={menuOpen ? false : undefined}>
        <Button icon={<FilePdfOutlined />} loading={exportPdf.isPending} data-testid="export-pdf">
          {exportPdf.isPending ? t('exporting') : t('export')}
          {!exportPdf.isPending && <DownOutlined />}
        </Button>
      </Tooltip>
    </Dropdown>
  )
}
