import { Flex, Table, Typography } from 'antd'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { IDENTITIES, type Identity } from '../domain/access'
import { INK, palette, textSize } from '../theme'

/**
 * Each 身分's colour (方向 A, #127), the same on the 人員 tab and here: 一般使用者 blue, 廠區管理員 orange,
 * 稽核人員 (#187) the primary purple on a deeper pale purple, 稽核主管 the selected item's purple, 系統維護員 (Q122) the body text on grey. Fixed colours
 * that name the 身分, always beside its name. (檢視者, green until Q153, is gone.)
 */
export const IDENTITY_COLOR: Record<Identity, { color: string; background: string }> = {
  signer: INK.blue,
  coordinator: INK.orange,
  audit_staff: { color: palette.primary, background: palette.selectedBorder },
  audit_admin: { color: palette.selectedText, background: palette.selectedBg },
  system_maintainer: { color: palette.text, background: palette.tableHeaderBg },
}

/**
 * A 身分 as the mockup draws it (#127): a dot and the name in the 身分's colour on its pale fill, 4px corners, in the
 * small text size since the colour already tells them apart (使用者 2026-11-10). Not
 * InkDot, whose colours are meanings (no purple) and which has no fill.
 */
export function IdentityTag({ identity, testId, children }: { identity: Identity; testId?: string; children: ReactNode }) {
  const { color, background } = IDENTITY_COLOR[identity]
  return (
    <span
      data-testid={testId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        paddingInline: 6,
        borderRadius: palette.radius,
        background,
        color,
        fontSize: textSize(12),
        lineHeight: '22px',
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: color, flex: 'none' }} />
      {children}
    </span>
  )
}

/**
 * The matrix's columns (使用者 2026-11-26, as on the 權限申請表): the four 系統角色 as they are without a plant to run,
 * then 廠區管理員 last, since it is added on top of a role (兼任) and its column only says what running a plant adds.
 */
const COLUMNS: readonly Identity[] = [...IDENTITIES.filter((i) => i !== 'coordinator'), 'coordinator']

/**
 * What one 身分 may do with one feature: yes, no, or within a reach (Q117 (2)). In the 廠區管理員 column `addRun` is
 * what running a plant adds (「＋負責廠區」), and `same` its empty cell: it adds nothing there, the person's own role
 * decides.
 */
type Cell = 'yes' | 'no' | 'same' | 'addRun' | 'viewPlants' | 'readOnly'
/**
 * 方向 A (#127): a green tick, a grey dash, a reach in words: blue for some plants, orange for what running one adds.
 * A row whose reach is the same for everyone says it in its name and ticks (作答 and 匯出 PDF, 使用者 2026-11-27).
 */
const CELL_COLOR: Record<Cell, string> = {
  yes: INK.green.color,
  no: INK.grey.color,
  same: INK.grey.color,
  addRun: INK.orange.color,
  viewPlants: INK.blue.color,
  readOnly: INK.blue.color,
}

/**
 * One row's cells, in COLUMNS order: 一般使用者, 稽核人員, 稽核主管, 系統維護員, then what 廠區管理員（兼任） adds. The
 * 一般使用者's column says what their optional 檢視廠區 add (Q153; the 檢視者 column until then); the 稽核人員's is him
 * without a plant to run, nothing about running one (使用者 2026-11-27): that is on his card below.
 */
type Cells = [Cell, Cell, Cell, Cell, Cell]

/** The 權限說明 matrix, by group. Mirrors the database's rules, it does not set them. */
const MATRIX: { group: string; rows: { key: string; cells: Cells }[] }[] = [
  {
    group: 'assessment',
    rows: [
      { key: 'ownAssessments', cells: ['yes', 'yes', 'yes', 'yes', 'same'] },
      // Only the step that is theirs, whatever the role: said in the row's name.
      { key: 'act', cells: ['yes', 'yes', 'yes', 'yes', 'same'] },
      { key: 'allAnswers', cells: ['viewPlants', 'no', 'yes', 'yes', 'addRun'] },
      // Whatever they may open, they may export: the two rows above set the reach.
      { key: 'pdf', cells: ['yes', 'yes', 'yes', 'yes', 'same'] },
    ],
  },
  {
    group: 'assign',
    rows: [
      { key: 'assign', cells: ['no', 'no', 'yes', 'yes', 'addRun'] },
      // Once issued, only the 稽核主管 and the 系統維護員 replace a signer (Q147): running the plant adds nothing.
      { key: 'replace', cells: ['no', 'no', 'yes', 'yes', 'same'] },
    ],
  },
  {
    group: 'tracking',
    rows: [
      { key: 'tracking', cells: ['viewPlants', 'no', 'yes', 'yes', 'addRun'] },
      // Running a plant adds its Excel and its 題庫 and 簽核流程 only for a 稽核人員 (Q117 (3), Q144); the column says what
      // running one adds, and the 稽核人員's card says whose (使用者 2026-11-27: one column, no notes in it).
      { key: 'excel', cells: ['viewPlants', 'no', 'yes', 'yes', 'addRun'] },
    ],
  },
  {
    group: 'settings',
    rows: [
      // 稽核人員 (Q144): sees every plant's, changes his plants' once he runs them.
      ...['templates', 'flows'].map((key) => ({ key, cells: ['no', 'readOnly', 'yes', 'yes', 'addRun'] as Cells })),
      { key: 'launch', cells: ['no', 'no', 'yes', 'yes', 'same'] },
      { key: 'coordinators', cells: ['no', 'no', 'yes', 'yes', 'same'] },
      // The 稽核主管 sees the people and the log but changes neither (Q150): a ✓ there read as before.
      { key: 'access', cells: ['no', 'no', 'readOnly', 'yes', 'same'] },
      // Letting people in and every role is the 系統維護員's alone (Q150).
      { key: 'admit', cells: ['no', 'no', 'no', 'yes', 'same'] },
    ],
  },
]

type MatrixRow = { key: string; group?: string; cells?: Cell[] }

/** A role column's header and cells: one line, and never narrower than this so the five columns stay even. */
const ROLE_CELL: CSSProperties = { minWidth: 104, whiteSpace: 'nowrap' }
/**
 * The 廠區管理員（兼任） column is set off by a dashed line in its orange, not filled: it is an addition to the four
 * roles, and a filled column of mostly empty cells read as missing data (使用者 2026-11-27).
 */
const ADD_ON_EDGE = `1px dashed ${INK.orange.border}`

/** A heading inside the tab, 16px like the mockup's. */
const heading = (text: string) => (
  <Typography.Title level={5} style={{ margin: 0, fontSize: textSize(14) }}>{text}</Typography.Title>
)

/**
 * 權限說明 (Q117, #187): the 身分 and what each may do. Read only; the same for everyone. 方向 A (#127): drawn in
 * AccessPage's card under its tabs, the matrix running to the card's edges with its contents centred, then the rule as
 * a plain line across it. The cards of what each 身分 sees went with Q153 (使用者 2026-11-27: they made the matrix
 * harder to read).
 */
export function AccessGuide() {
  const { t } = useTranslation('access')
  const rows: MatrixRow[] = MATRIX.flatMap((g) => [{ key: `group-${g.group}`, group: g.group }, ...g.rows])

  const cell = (c: Cell) =>
    c === 'same' ? null : (
      <span style={{ color: CELL_COLOR[c], fontWeight: c === 'yes' ? 700 : undefined }} aria-label={c === 'yes' ? '✓' : undefined}>
        {c === 'yes' ? '✓' : c === 'no' ? '—' : t(`guide.cell.${c}`)}
      </span>
    )
  /** 廠區管理員 is named as an addition wherever this tab lists the 身分. */
  const nameOf = (i: Identity) => (i === 'coordinator' ? t('guide.addOn.name') : t(`role.${i}`))

  return (
    <Flex vertical data-testid="access-guide">
      {/* One line over the matrix (使用者 2026-11-24: the head took the matrix's room): its title and the 身分 legend. */}
      <Flex align="center" gap="8px 16px" wrap style={{ paddingBlock: '12px 8px' }}>
        {heading(t('guide.matrixTitle'))}
        <Flex gap={8} wrap>
          {COLUMNS.map((i) => (
            <IdentityTag key={i} identity={i}>{nameOf(i)}</IdentityTag>
          ))}
        </Flex>
        <Typography.Text type="secondary" data-testid="access-guide-add-on-hint">{t('guide.addOn.hint')}</Typography.Text>
      </Flex>
      <Table<MatrixRow>
        className="csa-edge-table"
        data-testid="access-guide-matrix"
        rowKey="key"
        size="small"
        pagination={false}
        scroll={{ x: 1000 }}
        dataSource={rows}
        onRow={(r) => (r.group ? {} : { style: { height: 40 } })}
        columns={[
          {
            title: t('guide.operation'),
            key: 'operation',
            // A group's one cell is both first and last in its row, so global.css's edge padding passes it by; it takes the
            // card's padding itself. Its grey is on the cell, where a row's hover does not reach.
            onCell: (r) =>
              r.group ? { colSpan: COLUMNS.length + 1, style: { paddingInlineStart: 'var(--csa-card-pad)', background: palette.bg } } : {},
            render: (_, r) => (r.group ? <Typography.Text strong>{t(`guide.group.${r.group}`)}</Typography.Text> : t(`guide.row.${r.key}`)),
          },
          // Each role as wide as its longest cell on one line (at least ROLE_CELL's minWidth), so 功能／操作 gives up its spare width
          // and nothing wraps (a 1px width in the automatic layout, as NO_WRAP).
          ...COLUMNS.map((i, n) => ({
            title:
              i === 'coordinator' ? (
                <Flex vertical align="center" style={ROLE_CELL}>
                  {nameOf(i)}
                  <Typography.Text type="secondary" style={{ fontSize: textSize(12), fontWeight: 400 }}>{t('guide.addOn.column')}</Typography.Text>
                </Flex>
              ) : (
                <div style={ROLE_CELL}>{nameOf(i)}</div>
              ),
            key: i,
            align: 'center' as const,
            width: 1,
            onHeaderCell: () => (i === 'coordinator' ? { style: { borderInlineStart: ADD_ON_EDGE } } : {}),
            onCell: (r: MatrixRow) => (r.group ? { colSpan: 0 } : i === 'coordinator' ? { style: { borderInlineStart: ADD_ON_EDGE } } : {}),
            render: (_: unknown, r: MatrixRow) => (r.cells ? <div style={ROLE_CELL}>{cell(r.cells[n]!)}</div> : null),
          })),
        ]}
      />

      {/*
        Only what the matrix would leave unclear, one short note a line (使用者 2026-11-27): what a reach in a cell
        covers, how a 廠區管理員's plants add up, and the three 「＋負責廠區」 that only a 稽核人員 gets. How 廠區管理員 are
        named is said where they are named (廠區權限), not here.
      */}
      <ul
        className="csa-edge-row"
        style={{ marginBlock: 0, paddingBlock: '10px 16px', paddingInlineStart: 'calc(var(--csa-card-pad) + 18px)', color: palette.textSecondary, borderTop: `1px solid ${palette.border}`, display: 'flex', flexDirection: 'column', gap: 4 }}
        data-testid="access-guide-notes"
      >
        {(t('guide.notes', { returnObjects: true }) as string[]).map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </Flex>
  )
}
