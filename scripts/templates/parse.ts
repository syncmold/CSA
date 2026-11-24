// 轉檔 ①: Word 表格的列（每列是儲存格文字陣列）→ 章節與控制要點。
// 只依表格形狀判斷，不依賴任何人名；Word 另存 HTML 在 word.mjs，HTML → 列在 html.ts。

export interface ParsedControlPoint {
  /** 原檔的題號（「1.1.1-1」）；沒有就不給，畫面依同一張卡片內的順序編（Q125）。 */
  code?: string
  text: string
  /** 依作答順序（紙本上的列順序）；一題由幾個單位各答一列時有多個（#46）。要素類沒有自評單位欄，為空。 */
  assessingUnits: string[]
}

export interface ParsedSection {
  /** 層級：第 1 層是卡片，不給；2、3 是卡片裡的分段列（Q125）。 */
  level?: 2 | 3
  /** 原檔的章節題號（「1」「1.1」）；沒有就不給。 */
  code?: string
  name: string
  controlPoints: ParsedControlPoint[]
}

export interface ParsedTemplateBody {
  sections: ParsedSection[]
  /** 自評單位，依第一次出現的順序。 */
  assessingUnits: string[]
}

/** Word 的儲存格文字以 \r\a 結尾。 */
export function cleanCell(cell: string): string {
  return cell.replace(/[\r\u0007]/g, '').trim()
}

/** 一段寫完的結尾：問號、句號、冒號。斷在這些後面的換行是原檔故意的（Q126）；斷在「(ME)」這類括號後面的不算。 */
const SENTENCE_END = /[？?。：]$/

/**
 * 控制要點格的文字（Q126）：一格裡的幾段，寫完一句才換行的保留換行（「…辦理？⏎(依規定提出…)」、條列項）；斷在句子
 * 中間的接回，原檔在斷點打了空白硬湊換行的（「修模檢討報 ⏎ 告」）要登錄在 wordBreaks，空白拿掉、詞接回，沒登錄就
 * 讓轉檔失敗。沒有空白的直接接上，和原本一樣。
 */
function pointText(cell: string, wordBreaks: readonly string[], used: Set<string>): string {
  const paragraphs = cell.replace(/\u0007/g, '').split('\r').filter((p) => p.trim())
  return paragraphs
    .reduce((text, paragraph, i) => {
      if (i === 0) return paragraph
      if (SENTENCE_END.test(text.trimEnd())) return `${text.trimEnd()}\n${paragraph.trimStart()}`
      if (!/\s$/.test(text) && !/^\s/.test(paragraph)) return text + paragraph
      const before = text.trimEnd()
      const joined = before + paragraph.trimStart()
      const word = wordBreaks.find((w) => {
        const at = joined.indexOf(w, Math.max(0, before.length - w.length + 1))
        return at >= 0 && at < before.length && at + w.length > before.length
      })
      if (!word) throw new Error(`控制要點「${cleanCell(cell)}」斷在句子中間、斷點有空白；確認是原檔硬湊換行就把接回的詞加進 wordBreaks`)
      used.add(word)
      return joined
    }, '')
    .trim()
}

/** 主表的表頭列：控制活動類寫「內部控制制度設計」，要素類寫「評估結果」；下一列是逐欄的答題欄名稱。 */
export const HEADER_MARKERS = ['內部控制制度設計', '評估結果']

/** 原檔的形狀差異：convert.mjs 依寫法給的預設（headingLevel 等），加上個別原檔登錄在範本設定的更正。 */
export interface ParseOptions {
  /** 表頭沒有自評單位欄的控制活動類（10.1、15），整份掛這個單位（Q90）。 */
  unitWhenNoColumn?: string
  /** 第一個章節列之前就有控制要點（11 沒有任何章節列）時的章節名稱。 */
  untitledSection?: string
  /** 多層章節（10.1）：章節列文字 → 層級（2、3），沒列的是第 1 層。每個章節列都是一個章節（Q125）。 */
  headingLevels?: Record<string, number>
  /** 沒列在 headingLevels 的章節列依寫法判斷層級；above 是目前上層的章節列原文（第 i 個是第 i+1 層）。 */
  headingLevel?: (heading: string, above: string[]) => number
  /** 確定底下沒有控制要點、也沒有下層的章節列（如「設計評估階段(由台北研發部進行)」），不建章節（使用者 2026-11-11 決定照舊不收）。 */
  emptyHeadings?: string[]
  /** 原檔自評單位格空白的控制要點（依文字）→ 改掛的單位。原檔補上後這條會讓轉檔失敗，屆時把它刪掉。 */
  blankUnits?: Record<string, string>
  /** 原檔多了一列、同一個自評單位答兩次的控制要點（依文字）：只留一次。原檔修好後這條會讓轉檔失敗。 */
  repeatedUnitRows?: string[]
  /** 原檔在詞中間打空白硬湊換行的地方，接回後的詞（「修模檢討報告」，Q126）。原檔修好後這條會讓轉檔失敗。 */
  wordBreaks?: string[]
}

/**
 * 主表的列 → 章節與控制要點。只依表格形狀判斷：
 * - 表頭列與下一列（答題欄名稱，它的格數就是每列答題欄的數目）之前全部略過；表頭有「自評單位」才有自評單位欄。
 * - 比答題欄還少格的列是章節列（只看第一格），層級依 headingLevels／headingLevel，最多三層（Q125）。後面接著更深一層的
 *   章節列是上層標題：建成沒有控制要點的章節；其他底下沒有控制要點的章節列要列在 emptyHeadings（不建章節），否則視為
 *   解析出了問題。
 * - 其餘是控制要點列：答題欄前面是控制要點文字（與自評單位）。一個控制要點由幾個自評單位各答一列時，Word 把垂直合併的
 *   控制要點格讀成「少一格」或「控制要點格空白」，這兩種列是上一個控制要點的下一個自評單位（#46）。
 */
export function parseTemplateRows(rawRows: string[][], options: ParseOptions = {}): ParsedTemplateBody {
  const rows = rawRows.map((row) => row.map(cleanCell))
  const headerIndex = rows.findIndex((cells) => cells.some((c) => HEADER_MARKERS.includes(c)))
  if (headerIndex < 0 || !rows[headerIndex + 1]) throw new Error('找不到問卷主表的表頭列')
  const hasUnitColumn = rows[headerIndex]!.includes('自評單位')
  const answerCells = rows[headerIndex + 1]!.length

  const sections: ParsedSection[] = []
  const assessingUnits: string[] = []
  // 目前所在的章節列原文，第 i 個是第 i+1 層（給 headingLevel 判斷層級）。
  const rawPath: string[] = []
  // 最近一個章節列：底下出現第一個控制要點、或接著出現更深一層的章節列時才建章節。
  let pending: { heading: string; level: number } | null = null
  const usedCorrections = new Set<string>()
  const sectionOf = ({ heading, level }: { heading: string; level: number }): ParsedSection => ({
    ...(level > 1 ? { level: level as 2 | 3 } : {}),
    name: heading.replace(/^-+/, ''),
    controlPoints: [],
  })
  // 下一個章節列（或表格結束，nextLevel 0）出現時，還沒建的章節列：更深一層的話它是上層標題，否則它底下什麼都沒有。
  const closePending = (nextLevel: number) => {
    if (!pending) return
    if (nextLevel > pending.level) sections.push(sectionOf(pending))
    else if (!options.emptyHeadings?.includes(pending.heading)) {
      throw new Error(`章節「${pending.heading}」底下沒有控制要點；確定原檔如此就把它加進 emptyHeadings`)
    }
    pending = null
  }

  for (const [r, cells] of rows.entries()) {
    if (r < headerIndex + 2) continue
    if (cells.length < answerCells) {
      const heading = cells[0]
      if (!heading) continue
      const level = options.headingLevels?.[heading] ?? options.headingLevel?.(heading, rawPath) ?? 1
      if (level > 3) throw new Error(`章節「${heading}」是第 ${level} 層，系統的章節最多三層`)
      if (level > rawPath.length + 1) throw new Error(`章節「${heading}」是第 ${level} 層，但上面沒有第 ${level - 1} 層`)
      closePending(level)
      rawPath.splice(level - 1, rawPath.length, heading)
      pending = { heading, level }
      continue
    }
    const lead = cells.slice(0, cells.length - answerCells)
    // 只有一格的是垂直合併的下一列，那一格是自評單位，不是控制要點。
    const onlyUnit = hasUnitColumn && lead.length === 1
    let text = lead[0] && !onlyUnit ? pointText(rawRows[r]![0]!, options.wordBreaks ?? [], usedCorrections) : ''
    let unit: string | null = options.unitWhenNoColumn ?? null
    if (hasUnitColumn) unit = onlyUnit ? lead[0]! : (lead[1] ?? '')
    if (!text && !(hasUnitColumn && unit)) continue // 空白列

    if (pending) {
      sections.push(sectionOf(pending))
      pending = null
    } else if (sections.length === 0) {
      if (!options.untitledSection) throw new Error(`控制要點出現在第一個章節之前：「${lead.join(' ')}」`)
      sections.push({ name: options.untitledSection, controlPoints: [] })
    }
    const current = sections.at(-1)!
    if (!text) {
      // 垂直合併的下一列：同一個控制要點的下一個自評單位。
      const previous = current.controlPoints.at(-1)
      if (!previous) throw new Error(`章節「${current.name}」第一列沒有控制要點文字、只有自評單位「${unit}」`)
      if (previous.assessingUnits.includes(unit!)) {
        if (!options.repeatedUnitRows?.includes(previous.text)) throw new Error(`控制要點「${previous.text}」重複出現自評單位「${unit}」`)
        usedCorrections.add(previous.text)
        continue
      }
      previous.assessingUnits.push(unit!)
      if (!assessingUnits.includes(unit!)) assessingUnits.push(unit!)
      continue
    }
    // 章節開始後每一列都是控制要點；沒有自評單位就是原檔或解析出了問題，不能默默丟掉。
    if (hasUnitColumn && !unit && options.blankUnits?.[text]) {
      unit = options.blankUnits[text]!
      usedCorrections.add(text)
    }
    if (hasUnitColumn && !unit) throw new Error(`控制要點沒有自評單位：「${text}」（章節「${current.name}」）`)
    if (unit && !assessingUnits.includes(unit)) assessingUnits.push(unit)
    current.controlPoints.push({ text, assessingUnits: unit ? [unit] : [] })
  }
  closePending(0)
  const levelOf = (section: ParsedSection | undefined) => section?.level ?? 1
  const bare = sections.find((section, i) => section.controlPoints.length === 0 && levelOf(sections[i + 1]) <= levelOf(section))
  if (bare) throw new Error(`章節「${bare.name}」底下沒有控制要點，也沒有下一層的章節`)
  const stale = [...Object.keys(options.blankUnits ?? {}), ...(options.repeatedUnitRows ?? []), ...(options.wordBreaks ?? [])].filter(
    (t) => !usedCorrections.has(t),
  )
  if (stale.length) throw new Error(`原檔已經沒有這些要更正的地方，請把它們從轉檔設定移除：${stale.join('、')}`)

  return { sections, assessingUnits }
}

/**
 * 原檔寫在文字開頭的題號（Q125）：「數字（.數字或 -數字）＊」加上可有可無的結尾點（「1.1.1-1」「1.2.」「10.」），後面
 * 接中文才算（「3D圖面」不算）。題號與文字之間的空白不保留，其餘逐字：code＋空白＋text＝原文。沒有題號回 null。
 * 規則與 migration 20261125000000 的 q125_split_code 相同。
 */
export function splitSourceCode(original: string): { code: string; text: string } | null {
  const match = /^(\d+(?:[.-]\d+)*\.?)( *)([^ -~][\s\S]*)$/.exec(original)
  return match ? { code: match[1]!, text: match[3]! } : null
}

/**
 * 原檔有題號的範本（台北總公司 A～D、SY-08、VN-10.1）：章節名稱與控制要點文字開頭的題號拿出來放進題號欄。開頭是數字卻
 * 拆不出題號的（題號後面直接接英文等）讓轉檔失敗，不默默把題號留在文字裡。
 */
export function takeSourceCodes(body: ParsedTemplateBody): ParsedTemplateBody {
  const unsplit = body.sections.flatMap((s) => [s.name, ...s.controlPoints.map((p) => p.text)]).find((t) => /^\d/.test(t) && !splitSourceCode(t))
  if (unsplit) throw new Error(`「${unsplit}」開頭像題號，但拆不出來；確認原檔寫法後調整 splitSourceCode`)
  return {
    ...body,
    sections: body.sections.map(({ level, name, controlPoints }) => {
      const heading = splitSourceCode(name)
      return {
        ...(level ? { level } : {}),
        ...(heading ? { code: heading.code } : {}),
        name: heading?.text ?? name,
        controlPoints: controlPoints.map((p) => {
          const found = splitSourceCode(p.text)
          return found ? { code: found.code, text: found.text, assessingUnits: p.assessingUnits } : p
        }),
      }
    }),
  }
}

/**
 * 紙本在第二、三層的章節裡每段從 1 重編（SAMOA，使用者 2026-11-11 決定照紙本）：系統預設是同一張卡片內連續編，
 * 所以把這些控制要點的號碼寫進題號欄。
 */
export function numberPointsPerSubsection(body: ParsedTemplateBody): ParsedTemplateBody {
  return {
    ...body,
    sections: body.sections.map((section) =>
      section.level ? { ...section, controlPoints: section.controlPoints.map((p, i) => ({ code: String(i + 1), ...p })) } : section,
    ),
  }
}

/** 版型（ADR-0005）：要素類、控制活動類。 */
export type TemplateLayout = 'element' | 'control_activity'

export interface TemplateFileInfo {
  /** 紙本編號，照檔名寫（「03.1」「5.1」「A」）。 */
  code: string
  layout: TemplateLayout
  name: string
  /** 同一循環分成幾份時的區分（「研發循環(陸合-台中)~沖壓」的「沖壓」、「生產循環(陸合-台中) 模具&沖壓」）；沒有就不給。 */
  variant?: string
  /** 只剩 02 的種子 migration 在用；每廠一份範本之後，草稿的適用廠區是原檔所在的廠區（Q111）。 */
  allPlants: boolean
}

/**
 * 「02~控制活動~採購及付款循環(所有廠區適用)..doc」→ 編號、版型、名稱、適用廠區。各廠的寫法（#84）：
 * - 名稱後面的括號是廠區或適用範圍（「(敬得-桃園)」「(組裝廠及福清富群)」，可能不只一組、可能少了右括號、
 *   可能寫成「生產循環~(敬得-桃園)」），不算名稱；括號裡寫「所有廠區適用」才算全部廠區。
 * - 括號後以「~」、空白或直接接的是區分（variant），例如研發循環分沖壓、塑膠兩份。
 * - 以「.」開頭的是註記（「.小改」「.(信鋐文件無)」「.增加模具管理」），不算名稱。
 * 要素類（A–D）只有「A~控制環境..doc」，沒有版型那一段。
 */
export function parseTemplateFileName(fileName: string): TemplateFileInfo {
  const element = /^([A-Z])~([^~(（.]+)[^~]*\.docx?$/i.exec(fileName)
  if (element) return { code: element[1]!, layout: 'element', name: element[2]!.trim(), allPlants: false }

  const match = /^([0-9][0-9.]*)~([^~]+)~(.+?)\.docx?$/i.exec(fileName)
  const name = match && /^[^(（.~\s]+/.exec(match[3]!)?.[0]
  if (!match || !name) throw new Error(`看不懂的範本檔名：${fileName}`)
  const [, code, layoutLabel, rest] = match
  if (layoutLabel !== '控制活動') throw new Error(`尚未支援的版型「${layoutLabel}」：${fileName}`)

  const groups: string[] = []
  let variant: string | undefined
  let tail = rest!.slice(name.length)
  for (;;) {
    tail = tail.replace(/^~(?=[(（])/, '')
    const group = /^[(（]([^)）]*)[)）]?/.exec(tail)
    // 括號後直接接字也算（「生產循環(陸和-蘇州)模具&沖壓」）。
    const extra = /^[~\s]*([^.(（~\s][^.(（~]*)/.exec(tail)
    if (group) groups.push(group[1]!)
    else if (extra && !variant) variant = extra[1]!.trim()
    else break
    tail = tail.slice((group ?? extra)![0].length)
  }
  return {
    code: code!,
    layout: 'control_activity',
    name,
    ...(variant ? { variant } : {}),
    allPlants: groups.some((g) => g.includes('所有廠區適用')),
  }
}

export interface SplitControlPoint {
  first: string
  second: string
}

/**
 * 原檔把一題拆在相鄰兩列時，接回一題（自評單位取第一列）。
 * 找不到那一對就丟錯：原檔修好之後這條更正就該拿掉，而不是默默放行。
 */
export function mergeSplitControlPoints(body: ParsedTemplateBody, splits: SplitControlPoint[]): ParsedTemplateBody {
  const sections = body.sections.map((s) => ({ ...s, controlPoints: [...s.controlPoints] }))
  for (const { first, second } of splits) {
    let merged = false
    for (const section of sections) {
      const i = section.controlPoints.findIndex((p, k) => p.text === first && section.controlPoints[k + 1]?.text === second)
      if (i < 0) continue
      const head = section.controlPoints[i]!
      section.controlPoints.splice(i, 2, { text: first + second, assessingUnits: head.assessingUnits })
      merged = true
      break
    }
    if (!merged) throw new Error(`原檔已沒有拆開的「${first}」＋「${second}」，請把這條更正從轉檔腳本移除`)
  }
  return { sections, assessingUnits: body.assessingUnits }
}
