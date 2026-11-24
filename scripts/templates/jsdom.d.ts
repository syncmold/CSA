// jsdom 只在轉檔腳本（html.ts）解析 Word 另存的 HTML 時用到，只宣告用到的部分，不另裝 @types/jsdom。
declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string)
    readonly window: Window & typeof globalThis
  }
}
