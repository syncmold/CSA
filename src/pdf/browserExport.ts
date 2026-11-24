// 匯出 PDF in the browser (Q45): pdfmake and the 7 MB Chinese font stay out of the main bundle and are fetched in
// the background once a 匯出 PDF button shows (Q135, `usePreloadPdfExport`). The font is embedded (as a subset) so
// the PDF reads the same on a computer without it, and the file is downloaded.
import fontUrl from '@expo-google-fonts/noto-sans-tc/400Regular/NotoSansTC_400Regular.ttf?url'
import type { AssessmentPdfSource } from '../api/assessmentPdf'
import { renderAssessmentPdf } from './assessmentPdf'
import groupLogoUrl from './assets/group-logo.png'
import { PDF_FONT, type PdfEngine } from './engine'

let engine: Promise<PdfEngine> | null = null

function browserEngine(): Promise<PdfEngine> {
  engine ??= import('pdfmake')
    .then(({ default: pdfmake }) => {
      const font = new URL(fontUrl, window.location.href).href
      pdfmake.setFonts({ [PDF_FONT]: { normal: font, bold: font, italics: font, bolditalics: font } })
      // Only this app's own files (the font); images arrive as data URLs.
      pdfmake.setUrlAccessPolicy((url) => new URL(url).origin === window.location.origin)
      return pdfmake as unknown as PdfEngine
    })
    .catch((error: unknown) => {
      engine = null // a network blip must not break every later export in this tab
      throw error
    })
  return engine
}

let font: Promise<void> | null = null

/**
 * Q135: pdfmake and the font fetched ahead of the first export. The font lands in the browser's cache, where
 * pdfmake reads it at export time. A failure is not reported: the export fetches them again.
 */
export function preloadPdfEngine(): Promise<void> {
  font ??= fetch(fontUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`font: HTTP ${response.status}`)
      return response.arrayBuffer()
    })
    .then(() => undefined)
    .catch((error: unknown) => {
      font = null
      throw error
    })
  return Promise.all([browserEngine(), font]).then(() => undefined)
}

/** An image the web app serves, as a data URL; undefined (the 版頭 leaves the space blank) when it cannot be read. */
async function dataUrl(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url)
    if (!response.ok) return undefined
    const blob = await response.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  } catch {
    return undefined
  }
}

/** "2026_福清富群_02_採購及付款循環.pdf", or "…_不含簽核時間.pdf" for the version without sign-off times (Q109). */
export function pdfFileName(source: AssessmentPdfSource, withSignedAt: boolean): string {
  const a = source.assessment
  const name = `${a.annual_cycle.year}_${a.plant.name}_${a.template_code}_${a.template_name}${withSignedAt ? '' : '_不含簽核時間'}`
  return `${name}.pdf`.replace(/[\\/:*?"<>|]/g, '_')
}

/** Builds and downloads the PDF, with or without the sign-off times (Q109). */
export async function exportAssessmentPdf(source: AssessmentPdfSource, withSignedAt: boolean): Promise<void> {
  const [pdfEngine, group, company] = await Promise.all([
    browserEngine(),
    dataUrl(groupLogoUrl),
    source.company.logo_path ? dataUrl(`${import.meta.env.BASE_URL}${source.company.logo_path}`) : undefined,
  ])
  const bytes = await renderAssessmentPdf(
    {
      assessment: source.assessment,
      signoffs: source.signoffs,
      companyName: source.company.name,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      withSignedAt,
      logos: { group, company },
    },
    pdfEngine,
  )
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: pdfFileName(source, withSignedAt) })
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
