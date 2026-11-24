// The PDF engine is pdfmake, set up with the embedded Chinese font under PDF_FONT. The browser and the tests
// set it up differently (font fetched by URL vs. read from node_modules); the layout code only sees this.
import type { TDocumentDefinitions } from 'pdfmake/interfaces'

/** Font name the document definitions use. Noto Sans TC (OFL), embedded as a subset in every PDF. */
export const PDF_FONT = 'NotoSansTC'

export interface PdfEngine {
  createPdf(doc: TDocumentDefinitions): { getBuffer(): Promise<Uint8Array> }
}
