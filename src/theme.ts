import type { ThemeConfig } from 'antd'
import type { CSSProperties } from 'react'

/**
 * 方向 A (#118, Q121): the purple kept, the rest neutral grey, nothing but subtraction. Purple is only for the main
 * buttons, the selected item and links; everything else that has a colour has it for a meaning (INK). Every colour
 * the app draws is here: antd reads `antdTheme`, the hand-drawn parts read `palette` and the tables below it. The
 * colours are provisional: the user may still adjust them.
 */
export const palette = {
  primary: '#6444b8',
  primaryHover: '#4f3496',
  /** The selected menu item: a pale purple with a darker purple text. */
  selectedBg: '#f1eefa',
  selectedText: '#5a3cac',
  /** The edge of a pale-purple box: the 年度 bar while the next year to launch is edited (#173). */
  selectedBorder: '#d8cff1',
  bg: '#f5f6f8',
  surface: '#ffffff',
  /** Cards, the menu's edge and other dividing lines. */
  border: '#dfe3e8',
  /** The edge of inputs and plain buttons. */
  controlBorder: '#c9d0d8',
  /** Between a table's rows. */
  rowLine: '#e8ebef',
  tableHeaderBg: '#f0f2f5',
  /** A table row under the mouse. */
  rowHoverBg: '#f8f9fa',
  text: '#1f2933',
  textSecondary: '#3b4652',
  textTertiary: '#5b6672',
  /**
   * A dashed line for what is still to come: a 關卡 not yet reached in the 自評表's 簽核流程 and the arrows into it,
   * and the 流程編輯器's line into the 匯流 (#123, #131).
   */
  dashed: '#8a95a1',
  /** Corners: 4px for controls and menu items, 6px for cards. No shadows and no gradients. */
  radius: 4,
  radiusLG: 6,
  /** 登入's page background behind the centred card. */
  loginBackground: 'radial-gradient(ellipse at 100% 0%, #eefaf5 0%, #f6f2ff 55%, #f2edff 100%)',
  /** 登入's quiet lines (Q123): the 系統版本, and paler still, the office's name at the very bottom. */
  loginVersion: '#8a95a1',
  loginOffice: '#b6bcc4',
} as const

/**
 * Colour by meaning (#118), always alongside words or a symbol, never colour alone. Each has a text colour and a
 * pale fill for the rare soft background.
 */
export const INK = {
  /** 完成、通過、啟用、可以 */
  green: { color: '#14684f', background: '#e8f3ee', border: '#b8d9cc' },
  /** 進行中、簽核中、已使用、範圍受限 */
  blue: { color: '#1d5fa8', background: '#e9f0f9', border: '#bcd1ec' },
  /** 待處理、草稿、提醒、僅自己的 */
  orange: { color: '#a85a00', background: '#fbf0e1', border: '#ecd0a6' },
  /** 錯誤、逾期、刪除 */
  red: { color: '#a8321f', background: '#fbebe8', border: '#ecc3bb' },
  /** 無、未使用、停用 */
  grey: { color: palette.textTertiary, background: palette.tableHeaderBg, border: palette.border },
} as const

/** One of INK's meanings: green, blue, orange, red or grey. */
export type Ink = keyof typeof INK

/**
 * Every font size on screen is the design's size plus this step (使用者 2026-10-22: 全站放大 2px). antd's type
 * scale and every size written in the components go through textSize, so the whole site moves with this one
 * number. The PDF keeps the paper's sizes (src/pdf).
 */
export const FONT_STEP = 2

/** A size from the design (in px), moved by FONT_STEP. */
export const textSize = (px: number) => px + FONT_STEP

/**
 * The stacking level of the page's own fixed parts (#116): the bottom action bars (antd Affix: 核准／退回, 暫存／送出),
 * the narrow screens' top bar and the side menu (its fold button sticks out over the page). Above a table's fixed columns, which antd stacks by the
 * table's column count (the 自評表's 「#」 column measured 18), and below antd's overlays (Modal and Drawer 1000,
 * Select's drop-down 1150), so a dialog or a drop-down still opens over the bar.
 */
export const PAGE_CHROME_Z = 100

const FONT_FAMILY = '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", -apple-system, "Segoe UI", Roboto, sans-serif'

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: palette.primary,
    colorLink: palette.primary,
    colorLinkHover: palette.primaryHover,
    colorInfo: INK.blue.color,
    colorInfoBg: INK.blue.background,
    colorInfoBorder: INK.blue.border,
    colorSuccess: INK.green.color,
    colorSuccessBg: INK.green.background,
    colorSuccessBorder: INK.green.border,
    colorWarning: INK.orange.color,
    colorWarningBg: INK.orange.background,
    colorWarningBorder: INK.orange.border,
    colorError: INK.red.color,
    colorErrorBg: INK.red.background,
    colorErrorBorder: INK.red.border,
    colorText: palette.text,
    colorTextSecondary: palette.textSecondary,
    colorTextTertiary: palette.textTertiary,
    colorBorder: palette.controlBorder,
    colorBorderSecondary: palette.border,
    colorSplit: palette.rowLine,
    colorBgLayout: palette.bg,
    colorBgContainer: palette.surface,
    fontFamily: FONT_FAMILY,
    // antd's default scale (14, 12, 16, 20; headings 38/30/24/20/16), each moved by FONT_STEP.
    fontSize: textSize(14),
    fontSizeSM: textSize(12),
    fontSizeLG: textSize(16),
    fontSizeXL: textSize(20),
    fontSizeHeading1: textSize(38),
    fontSizeHeading2: textSize(30),
    fontSizeHeading3: textSize(24),
    fontSizeHeading4: textSize(20),
    fontSizeHeading5: textSize(16),
    borderRadius: palette.radius,
    borderRadiusSM: palette.radius,
    borderRadiusLG: palette.radiusLG,
    boxShadowTertiary: 'none',
  },
  components: {
    Affix: { zIndexPopup: PAGE_CHROME_Z },
    Layout: { bodyBg: palette.bg, headerBg: palette.surface, siderBg: palette.surface, headerHeight: 52, headerPadding: '0 12px' },
    Menu: {
      itemBg: 'transparent',
      itemColor: palette.textSecondary,
      itemHoverBg: palette.bg,
      itemHoverColor: palette.text,
      itemSelectedBg: palette.selectedBg,
      itemSelectedColor: palette.selectedText,
      itemBorderRadius: palette.radius,
      itemMarginInline: 0,
      itemMarginBlock: 2,
      activeBarBorderWidth: 0,
      groupTitleColor: palette.textTertiary,
      groupTitleFontSize: textSize(12),
      // The group headings' and items' side padding, so both line up with the brand 10px in (AppShell's inlineIndent).
      padding: 10,
    },
    // A breadcrumb's way back is a link like any other (#124); where you are stays grey.
    Breadcrumb: { linkColor: palette.primary, linkHoverColor: palette.primaryHover, separatorColor: palette.textTertiary, lastItemColor: palette.textTertiary },
    // No rule between the header's cells (#124): the darker header row is enough.
    Table: { headerBg: palette.tableHeaderBg, headerColor: palette.textSecondary, headerSplitColor: 'transparent', borderColor: palette.rowLine, rowHoverBg: palette.rowHoverBg },
    Card: { headerFontSize: textSize(15) },
    Button: { primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
    Tabs: { itemSelectedColor: palette.primary, inkBarColor: palette.primary, itemHoverColor: palette.primaryHover },
    Segmented: { itemSelectedColor: palette.primary },
    // A chosen button in a button-style group (the language switcher, #130) on the selected item's pale purple.
    Radio: { buttonCheckedBg: palette.selectedBg },
  },
}

/**
 * A card whose rows run to its edges (global.css's csa-edge-row, csa-edge-table, csa-edge-tabs): 16px in, as most of
 * the mockups, header and body alike. A card with a table puts no padding above or below it.
 */
export const CARD_STYLE = { overflow: 'hidden', '--csa-card-pad': '16px' } as CSSProperties
/** The same 20px in, as the mockups draw the lists with a toolbar or tabs (範本管理, 簽核流程, 年度發起, 權限管理). */
export const LIST_CARD_STYLE = { overflow: 'hidden', '--csa-card-pad': '20px' } as CSSProperties
/** The body of such a card, padded only at the sides: its rows step back over that padding to its edges. */
export const CARD_BODY_STYLE: CSSProperties = { padding: '0 var(--csa-card-pad)' }
/** The header of such a card, its title as far in as the body. */
export const CARD_HEADER_STYLE: CSSProperties = { paddingInline: 'var(--csa-card-pad)' }

/**
 * 權限管理's two cards side by side (#215): each as tall as it is given, its list alone scrolling inside it. The body is
 * a column with no padding of its own; its parts pad themselves.
 */
export const ACCESS_CARD_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }
/** The grey rows of 權限管理's 廠區管理員 cells: palette.bg (#f5f6f8) 5% darker (使用者 2026-11-23). */
export const PLANT_STRIPE_BG = '#e9eaec'
export const ACCESS_CARD_BODY: CSSProperties ={ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }

/** A link-like button in a row of them (修改／刪除／移除): no padding of its own, the gap spaces them. */
export const LINK_BUTTON: CSSProperties = { padding: 0, height: 'auto' }

/**
 * Narrower than this a card's table scrolls sideways in the card instead of squeezing its columns, as the mockups
 * (範本明細's 章節, 流程編輯器's 匯流後).
 */
export const TABLE_MIN_WIDTH = 620

/**
 * A 分段列 inside a card (#166, the approved mockup): 第二層 on a pale purple, 第三層 paler, lighter and set in, so a
 * multi-level 章節 shows its upper levels once (範本明細, 答題).
 */
export function subheadingStyle(level: number): CSSProperties {
  return level <= 2
    ? { background: '#f3f1fa', fontWeight: 600, color: palette.text }
    : { background: '#fafafc', fontWeight: 500, color: palette.textSecondary }
}
/** A 分段列's name cell: the row's style, a 第三層 set in from a 第二層 by 12px. */
export function subheadingNameStyle(level: number): CSSProperties {
  return { ...subheadingStyle(level), ...(level > 2 ? { paddingInlineStart: 20 } : {}) }
}

/** A control point's text keeps the line breaks of the paper form: a note in brackets, the items of a list (Q126). */
export const POINT_TEXT_STYLE: CSSProperties = { whiteSpace: 'pre-line' }

/** A white box of a line or a few above the cards (範本明細, 流程編輯器): what editing does, the 發起檢查. */
export const NOTE_BOX: CSSProperties = {
  padding: '8px 14px',
  background: palette.surface,
  border: `1px solid ${palette.border}`,
  borderRadius: palette.radius,
  fontSize: textSize(13),
}

/**
 * 追蹤總覽's own 狀態 colours (#128), which the user chose over 方向 A's pale meaning colours so the spread of states
 * reads at a glance yet stays easy on the eye over a long look: 結案 a cool fog blue; waiting warm, warmer the longer
 * (a pale grey under the first threshold, sand, then a dried rose). Mid tones of low chroma, every pair apart for
 * normal and colour-blind vision alike (ΔE ≥ 15 and ≥ 11). The fills are the 熱度矩陣's; `text` is the same colour
 * dark enough for words on white (`onFill` is for words on the fill), for the counts that name those states (the strip above, a 廠區's heading in
 * 待處理優先), so one state has one colour on the page.
 */
export const TRACKING = {
  closed: { fill: '#7fa3c4', onFill: '#14304a', text: '#3f6a92' },
  short: { fill: '#eef0f2', onFill: '#33404d' },
  long: { fill: '#ddb874', onFill: '#3a2800' },
  /** Its light grey on the fill is the user's pick over white, which glared (contrast 4.4). */
  veryLong: { fill: '#9e5854', onFill: '#edebe9', text: '#9e5854' },
  /** Not states of a 自評表 but of a cell: a frame where it is not yet launched, a faint dash where it does not apply. */
  notLaunched: { frame: '#9aa3ad', hatch: palette.tableHeaderBg },
  notApplicable: { dash: '#b3bac2' },
} as const

/**
 * 追蹤總覽's 停留 shades (Q105, #128): a 熱度矩陣 cell, its legend swatch and the 待處理優先 day chip, each with its number
 * or a tick for 結案; 未發起 a dashed, hatched frame, 不適用 a faint dash. Keyed like domain/tracking's HeatLevel and
 * DwellLevel, spelled out so the theme does not import the domain. The hatch is a pattern drawn with a gradient, the one
 * exception to 方向 A's none, which the user saw and kept in the mockup: a dashed frame alone read like an empty cell.
 */
export const HEAT_SHADES: Record<'closed' | 'short' | 'long' | 'veryLong' | 'not_launched' | 'filtered_out' | 'not_applicable', CSSProperties> = {
  closed: { background: TRACKING.closed.fill, color: TRACKING.closed.onFill },
  short: { background: TRACKING.short.fill, color: TRACKING.short.onFill },
  long: { background: TRACKING.long.fill, color: TRACKING.long.onFill, fontWeight: 600 },
  veryLong: { background: TRACKING.veryLong.fill, color: TRACKING.veryLong.onFill, fontWeight: 600 },
  not_launched: {
    border: `1px dashed ${TRACKING.notLaunched.frame}`,
    background: `repeating-linear-gradient(135deg, ${TRACKING.notLaunched.hatch} 0 2px, transparent 2px 6px)`,
  },
  filtered_out: {},
  not_applicable: { color: TRACKING.notApplicable.dash },
}

/**
 * 各廠填單進度's bars and their legend (#129): mid-tone fills for the stages' meanings, 填寫中 orange (待處理), 簽核中
 * blue, 結案 green, over a grey track. The counts and the legend's words beside them say the same in text.
 */
export const STAGE_FILL = { filling: '#e0b252', signing: '#4f86c6', closed: '#2f8f6f', track: '#eef0f3' } as const

/**
 * 自評表's own tints (#131). The rows the signed-in 自行檢查人員 answers in a purple paler than the selected item, so the
 * ticked options stay the strongest purple on the row; the note above them in the selected item's pale purple with a
 * darker purple text.
 */
export const SHEET = { editableRow: '#faf8fe', noteBorder: '#dcd3f3', noteText: '#3b2a78' } as const
