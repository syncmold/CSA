import { useMutation } from '@tanstack/react-query'
import { useEffect } from 'react'
import { fetchAssessmentPdfSource } from '../api/assessmentPdf'
import { loadChunk } from '../loadChunk'

let exporter: Promise<typeof import('../pdf/browserExport')> | null = null

function loadExporter() {
  exporter ??= import('../pdf/browserExport').catch((error: unknown) => {
    exporter = null // a failed fetch must not stick: the click tries again
    throw error
  })
  return exporter
}

/**
 * 匯出 PDF (#7): reads the 自評表 fresh, then builds and downloads the PDF, with or without the sign-off times
 * (Q109). Resolves false when RLS hides it.
 */
export function useExportPdf(assessmentId: string) {
  return useMutation({
    mutationFn: async (withSignedAt: boolean) => {
      const source = await fetchAssessmentPdfSource(assessmentId)
      if (!source) return false
      const { exportAssessmentPdf } = await loadChunk(loadExporter)
      await exportAssessmentPdf(source, withSignedAt)
      return true
    },
  })
}

/**
 * Q135: once a 匯出 PDF button shows, fetches the exporter, pdfmake and the font in the background, so the
 * first export does not wait for them and still works after a deploy under the open tab. Once per tab; a failure is
 * left for the click, which tries again.
 */
export function usePreloadPdfExport() {
  useEffect(() => {
    const preload = () => void loadExporter().then((m) => m.preloadPdfEngine()).catch(() => {})
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(preload, { timeout: 5_000 })
      return () => window.cancelIdleCallback(id)
    }
    const id = window.setTimeout(preload, 1_000)
    return () => window.clearTimeout(id)
  }, [])
}
