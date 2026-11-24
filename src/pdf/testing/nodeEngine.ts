// The PDF engine for tests (unit and db): pdfmake's Node build with the same embedded font the browser uses,
// read from node_modules instead of fetched by URL.
import { createRequire } from 'node:module'
import type { PdfEngine } from '../engine'
import { PDF_FONT } from '../engine'

const require = createRequire(import.meta.url)

export function nodePdfEngine(): PdfEngine {
  const pdfmake = require('pdfmake') as {
    setFonts(fonts: object): void
    setUrlAccessPolicy(policy: (url: string) => boolean): void
    setLocalAccessPolicy(policy: (path: string) => boolean): void
  } & PdfEngine
  const font = require.resolve('@expo-google-fonts/noto-sans-tc/400Regular/NotoSansTC_400Regular.ttf')
  pdfmake.setFonts({ [PDF_FONT]: { normal: font, bold: font, italics: font, bolditalics: font } })
  pdfmake.setUrlAccessPolicy(() => false)
  pdfmake.setLocalAccessPolicy((path) => path === font)
  return pdfmake
}
