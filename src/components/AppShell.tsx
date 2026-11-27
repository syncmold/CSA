import {
  ApartmentOutlined, BarChartOutlined, FileTextOutlined, FolderOpenOutlined, HomeOutlined, KeyOutlined, LeftOutlined, MenuOutlined,
  RightOutlined, SendOutlined, TeamOutlined,
} from '@ant-design/icons'
import { Badge, Button, Drawer, Flex, Layout, Menu, theme, Tooltip } from 'antd'
import type { ItemType } from 'antd/es/menu/interface'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import type { AuditRole } from '../api/employee'
import { useAuth } from '../auth/AuthContext'
import { actsAsAuditAdmin, managesAccess, readsSettings } from '../domain/access'
import { env } from '../env'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useAssignsSigners, useMyAuditRole, useSeesTracking } from '../hooks/useMyAuditRole'
import { useMyTasks } from '../hooks/useMyTasks'
import { useSiderCollapsed } from '../hooks/useSiderCollapsed'
import { PAGE_CHROME_Z, palette, textSize } from '../theme'
import { AccountMenu } from './AccountMenu'

/** Space around the page content, in px (useFillToBottom keeps the same gap below a stretched card). */
export const CONTENT_PADDING = 24

const SIDER_WIDTH = 216
/** The side menu folded to its icons. */
const SIDER_COLLAPSED_WIDTH = 72
/** The menu's padding above the brand. */
const NAV_TOP = 18
/** The height of the brand's 「CSA」 line. */
const BRAND_LINE = 26
/** The fold button: a small circle (antd's small round button). */
const TOGGLE_SIZE = 24
/** It sits on the menu's right edge, centred on the 「CSA」 line (使用者 2026-11-09, option C moved up). */
const TOGGLE_TOP = NAV_TOP + (BRAND_LINE - TOGGLE_SIZE) / 2
/** antd's `lg` (992px): below it the menu folds into a drawer. */
const WIDE = '(min-width: 992px)'
/** The menu's 我的待簽 count may be this old; 首頁's 我的自評表 always loads afresh. */
const PENDING_COUNT_STALE_MS = 5 * 60_000

/** The rule between the menu's parts: as dark as the menu's edge, with room above and below (antd's is faint and tight). */
const SECTION_RULE = { type: 'divider', style: { margin: '8px', borderColor: palette.border } } as const

const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const

/**
 * The menu's parts, top to bottom, each after a thin rule (Q124 (3)): 首頁; the steps of sending the forms out
 * (範本 → 流程 → 分派填寫人 → 年度發起, Q147), headed 發出表單 and numbered when someone has two or more of them; the
 * other pages that change settings; the pages that show data. Only the steps have a heading: headings named after
 * whose things they were (我的／管理) misled: 進度追蹤, which someone who only views a plant gets too, sat under 管理.
 */
type NavSection = 'home' | 'steps' | 'settings' | 'data'
const SECTIONS: readonly NavSection[] = ['home', 'steps', 'settings', 'data']

interface NavEntry {
  path: string
  section: NavSection
  /** Its place among the 發出表單 steps, the same for everyone who sees it. */
  step?: number
  label: string
  icon: ReactNode
  testId: string
  /** Who sees the entry. Showing and hiding only; the database decides what they get. */
  shows: (me: Me) => boolean
}

/** What the menu knows about the signed-in employee. */
interface Me {
  role: AuditRole | undefined
  /** 稽核主管, 系統維護員, a 一般使用者 with 檢視廠區 (Q153) and 廠區管理員 (Q117 (3)) */
  seesTracking: boolean
  /** 稽核管理者 and 廠區負責人 (#101) */
  assigns: boolean
}

const everyone = () => true
/** 稽核管理者 and 系統維護員 (Q129): the pages that change things. */
const auditAdmin = (me: Me) => actsAsAuditAdmin(me.role)
/** Also the 稽核人員 (Q144): he sees every plant's 範本 and 簽核流程 and changes his plants'. */
const settingsReader = (me: Me) => readsSettings(me.role)
/** 稽核管理者 and 系統維護員 (Q122). */
const accessManager = (me: Me) => managesAccess(me.role)

/**
 * In the menu's order, which is the order of use: 範本 → 流程 → 分派填寫人 → 年度發起 (Q147). A 系統維護員 gets every
 * entry a 稽核管理者 does (Q129).
 */
const NAV: readonly NavEntry[] = [
  { path: '/', section: 'home', label: 'app.navHome', icon: <HomeOutlined />, testId: 'nav-home', shows: everyone },
  { path: '/admin/templates', section: 'steps', step: 1, label: 'templates.title', icon: <FileTextOutlined />, testId: 'nav-templates', shows: settingsReader },
  { path: '/admin/flows', section: 'steps', step: 2, label: 'flows:title', icon: <ApartmentOutlined />, testId: 'nav-flows', shows: settingsReader },
  { path: '/admin/assignment', section: 'steps', step: 3, label: 'assignment:nav', icon: <TeamOutlined />, testId: 'nav-assignment', shows: (me) => me.assigns },
  { path: '/admin/launch', section: 'steps', step: 4, label: 'launch:nav', icon: <SendOutlined />, testId: 'nav-launch', shows: auditAdmin },
  { path: '/admin/access', section: 'settings', label: 'access:nav', icon: <KeyOutlined />, testId: 'nav-access', shows: accessManager },
  { path: '/records', section: 'data', label: 'records:nav', icon: <FolderOpenOutlined />, testId: 'nav-records', shows: everyone },
  { path: '/admin/tracking', section: 'data', label: 'tracking:nav', icon: <BarChartOutlined />, testId: 'nav-tracking', shows: (me) => me.seesTracking },
]
const HOME = NAV[0]!

/**
 * A 發出表單 step's number in place of its icon: a square with the app's 4px corners, purple on pale purple, and solid
 * (white on the primary purple) for the page one is on (使用者 2026-11-24, option B).
 */
function StepNumber({ step, on }: { step: number; on: boolean }) {
  return (
    <span
      aria-hidden
      // antd spaces the label from an icon it knows by this class, as for the other entries' icons.
      className="anticon"
      data-testid={`nav-step-${step}`}
      style={{
        // Above the line that joins the steps (global.css, .csa-nav-steps).
        position: 'relative', zIndex: 1,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: 18, height: 18, borderRadius: palette.radius,
        background: on ? palette.primary : palette.selectedBg, color: on ? palette.surface : palette.selectedText,
        fontSize: textSize(11), fontWeight: 600, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
      }}
    >
      {step}
    </span>
  )
}

/**
 * The entry a path belongs to: the longest matching entry path, with 自評單位清單 counted under 範本管理. Anything
 * else (the 自評表 page, opened from 首頁) falls back to 首頁.
 */
function activeEntry(pathname: string): NavEntry {
  const path = pathname.startsWith('/admin/assessing-units') ? '/admin/templates' : pathname
  return [...NAV].reverse().find((n) => n !== HOME && path.startsWith(n.path)) ?? HOME
}

/**
 * The frame of the signed-in pages: the menu down the left, with who is signed in at its foot (opening the language,
 * 回 SyncHub and 登出, AccountMenu), and the page content, which takes the window's whole width on every page (Q114 (6)).
 * Wide screens have no top bar: the page's own heading says where you are (Q114). There the menu folds to its icons
 * from the round button on its edge (#86, #119), the foot to its avatar, and each browser remembers it. Narrow screens keep a
 * slim bar whose button opens the menu as a drawer.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { session } = useAuth()
  const role = useMyAuditRole()
  const tracking = useSeesTracking()
  const assigns = useAssignsSigners()
  const tasks = useMyTasks(session?.employee.emp_id, PENDING_COUNT_STALE_MS)
  const { pathname } = useLocation()
  const { token } = theme.useToken()
  // Read on the first render, so a phone does not flash the side menu.
  const wide = useMediaQuery(WIDE)
  const narrow = !wide
  const [menuOpen, setMenuOpen] = useState(false)
  const [storedCollapsed, setCollapsed] = useSiderCollapsed()
  const collapsed = wide && storedCollapsed

  const me: Me = { role: role.data ?? undefined, seesTracking: tracking.sees, assigns }
  const visible = NAV.filter((n) => n.shows(me))
  const active = activeEntry(pathname)
  // Only 首頁 carries a count (我的待簽); the steps show none (使用者 2026-11-24).
  const pending = tasks.data?.length ?? 0
  const countOf = (n: NavEntry) => (n === HOME ? pending : 0)
  const item = (n: NavEntry, numbered: boolean): ItemType => ({
    key: n.path,
    // Folded, the count rides on the icon instead of the label. The icon box is the row's full height, so the
    // dot drops 12px to the glyph's corner; at the box's top the menu item, which hides its overflow, cut it in half.
    icon: numbered && n.step ? <StepNumber step={n.step} on={n === active} /> : collapsed && countOf(n) > 0 ? <Badge dot offset={[2, 12]}>{n.icon}</Badge> : n.icon,
    label: (
      <Link to={n.path} data-testid={n.testId} onClick={() => setMenuOpen(false)}>
        <Flex justify="space-between" align="center" gap={8}>
          <span style={{ fontWeight: n === active ? 500 : undefined }}>{t(n.label)}</span>
          {countOf(n) > 0 && (
            <span data-testid="nav-pending-count" style={{ fontSize: textSize(12), color: palette.textTertiary, fontVariantNumeric: 'tabular-nums' }}>
              {countOf(n)}
              <span style={VISUALLY_HIDDEN}>{t('app.pendingCount')}</span>
            </span>
          )}
        </Flex>
      </Link>
    ),
  })
  // A rule before each part after the first; a part the employee has no page of leaves no rule either. The 發出表單
  // steps get their heading and numbers only when there are two or more: a 廠區管理員's lone 分派填寫人 is a plain
  // entry (使用者 2026-11-24). Folded, the heading goes and the numbers stay as the icons.
  const part = (section: NavSection, entries: NavEntry[]): ItemType[] => {
    const numbered = section === 'steps' && entries.length > 1
    const shown = entries.map((n) => item(n, numbered))
    return numbered && !collapsed
      ? [{ type: 'group', key: 'steps', className: 'csa-nav-steps', label: <span data-testid="nav-steps-title">{t('app.launchSteps')}</span>, children: shown }]
      : shown
  }
  const items: ItemType[] = SECTIONS.map((section) => ({ section, entries: visible.filter((n) => n.section === section) }))
    .filter(({ entries }) => entries.length > 0)
    .flatMap(({ section, entries }, i) => [...(i > 0 ? [SECTION_RULE] : []), ...part(section, entries)])
  const envTag = env.envLabel && (
    <span data-testid="env-label" style={{ fontSize: textSize(11), color: palette.textTertiary }}>
      {env.envLabel}
    </span>
  )
  const brandName = (
    <span style={{ display: 'block', fontSize: textSize(18), fontWeight: 700, lineHeight: `${BRAND_LINE}px`, color: palette.text }}>CSA</span>
  )

  const foot = (
    <Flex justify="center" style={{ borderTop: `1px solid ${palette.border}`, paddingTop: 10 }}>
      <AccountMenu compact={collapsed} />
    </Flex>
  )

  const gutter = narrow ? 16 : 'clamp(24px, 3vw, 44px)'
  const toggleLabel = collapsed ? t('app.expandMenu') : t('app.collapseMenu')
  const toggle = (
    <Tooltip title={toggleLabel} placement="right">
      <Button
        shape="circle"
        size="small"
        icon={collapsed ? <RightOutlined /> : <LeftOutlined />}
        aria-label={toggleLabel}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        data-testid="toggle-sider"
      />
    </Tooltip>
  )
  const nav = (
    // border-box: with the padding on top of the full height, the foot fell below the window.
    <Flex
      vertical
      style={{
        height: '100%', boxSizing: 'border-box', padding: collapsed ? `${NAV_TOP}px 8px 12px` : `${NAV_TOP}px 10px 12px`,
        '--csa-step-line': palette.selectedBorder,
      } as CSSProperties}
      data-testid="side-nav"
    >
      <Flex align="flex-start" justify={collapsed ? 'center' : undefined} gap={4} style={{ padding: collapsed ? '0 0 12px' : '0 0 12px 10px' }}>
        <Link
          to="/"
          // Folded, the name also carries the environment's label, which is not shown then.
          aria-label={collapsed ? (env.envLabel ? t('app.brandWithEnv', { env: env.envLabel }) : 'CSA') : undefined}
          style={{ display: 'block', flex: collapsed ? undefined : 1, minWidth: 0 }}
          onClick={() => setMenuOpen(false)}
        >
          {/* Folded, the environment's label is only in the link's name: a dot here read like the 待簽 count's. */}
          {brandName}
          {!collapsed && (
            <span style={{ display: 'block', fontSize: textSize(12), color: palette.textTertiary }}>{t('app.brandSub')}</span>
          )}
        </Link>
      </Flex>
      {/* Straddling the menu's edge (the Sider is its positioned parent), folded or not; the drawer has none. */}
      {wide && <div style={{ position: 'absolute', top: TOGGLE_TOP, insetInlineEnd: -(TOGGLE_SIZE + 1) / 2 }}>{toggle}</div>}
      {/* On narrow screens the bar above the page shows it instead. */}
      {wide && !collapsed && envTag && <div style={{ padding: '0 0 12px 10px', marginTop: -8 }}>{envTag}</div>}
      <Menu
        mode="inline"
        inlineCollapsed={collapsed}
        inlineIndent={10}
        selectedKeys={[active.path]}
        items={items}
        style={{ border: 'none', flex: 1, minHeight: 0, overflowY: 'auto' }}
      />
      {foot}
    </Flex>
  )

  return (
    // The cards' padding (antd: paddingLG, small cards paddingSM) for the edge-to-edge tables in global.css.
    <Layout style={{ minHeight: '100vh', '--csa-card-pad-lg': `${token.paddingLG}px`, '--csa-card-pad-sm': `${token.paddingSM}px` } as CSSProperties}>
      {narrow ? (
        <Drawer
          placement="left"
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          size={SIDER_WIDTH + 24}
          closable={false}
          aria-label={t('app.menu')}
          styles={{ body: { padding: 0 } }}
        >
          {nav}
        </Drawer>
      ) : (
        <Layout.Sider
          width={SIDER_WIDTH}
          collapsedWidth={SIDER_COLLAPSED_WIDTH}
          collapsed={collapsed}
          trigger={null}
          // Above the page, so the half of the fold button that sticks out over it stays clickable.
          style={{ borderInlineEnd: `1px solid ${palette.border}`, position: 'sticky', top: 0, height: '100vh', zIndex: PAGE_CHROME_Z }}
        >
          {nav}
        </Layout.Sider>
      )}
      <Layout>
        {narrow && (
          <Layout.Header
            data-testid="top-bar"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, background: palette.surface, borderBottom: `1px solid ${palette.border}`,
              position: 'sticky', top: 0, zIndex: PAGE_CHROME_Z,
            }}
          >
            <Button type="text" icon={<MenuOutlined />} aria-label={t('app.openMenu')} onClick={() => setMenuOpen(true)} data-testid="open-menu" />
            <Link to="/" style={{ fontSize: textSize(17), fontWeight: 700, color: palette.text }}>
              CSA
            </Link>
            <span style={{ flex: 1 }} />
            {envTag}
          </Layout.Header>
        )}
        {/* Side gutters grow with the window, as the design's 22–44px; the bottom stays CONTENT_PADDING for useFillToBottom. */}
        <Layout.Content
          style={{
            paddingBlock: CONTENT_PADDING,
            paddingInline: gutter,
          }}
        >
          <Flex vertical gap={16}>
            {children}
          </Flex>
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
