import { Flex, Table, Typography } from 'antd'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { IDENTITIES, type Identity } from '../domain/access'
import { INK, palette, textSize } from '../theme'

/**
 * Each 身分's colour (方向 A, #127), the same on the 人員 tab and here: 一般使用者 blue, 檢視者 green, 廠區負責人 orange,
 * 稽核人員 (#187) the primary purple on a deeper pale purple, 稽核主管 the selected item's purple, 系統維護員 (Q122) the body text on grey. Fixed colours
 * that name the 身分, always beside its name.
 */
export const IDENTITY_COLOR: Record<Identity, { color: string; background: string }> = {
  signer: INK.blue,
  viewer: INK.green,
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

/** What one 身分 may do with one feature: yes, no, or within a reach (Q117 (2)). */
type Cell = 'yes' | 'no' | 'turn' | 'own' | 'viewPlants' | 'runPlants' | 'editRun'
/** 方向 A (#127): a green tick, a grey dash, a reach in words: orange for one's own, blue for some plants. */
const CELL_COLOR: Record<Cell, string> = {
  yes: INK.green.color,
  no: INK.grey.color,
  turn: INK.orange.color,
  own: INK.orange.color,
  viewPlants: INK.blue.color,
  runPlants: INK.blue.color,
  editRun: INK.blue.color,
}

/** One row's cells, in IDENTITIES order: 一般使用者, 檢視者, 廠區管理員, 稽核人員, 稽核主管, 系統維護員. */
type Cells = [Cell, Cell, Cell, Cell, Cell, Cell]

/** The 權限說明 matrix, by group. Mirrors the database's rules, it does not set them. */
const MATRIX: { group: string; rows: { key: string; cells: Cells }[] }[] = [
  {
    group: 'assessment',
    rows: [
      { key: 'ownAssessments', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes'] },
      { key: 'act', cells: ['turn', 'turn', 'turn', 'turn', 'turn', 'turn'] },
      { key: 'allAnswers', cells: ['no', 'viewPlants', 'runPlants', 'runPlants', 'yes', 'yes'] },
      { key: 'pdf', cells: ['own', 'viewPlants', 'runPlants', 'runPlants', 'yes', 'yes'] },
    ],
  },
  {
    group: 'assign',
    rows: [
      { key: 'assign', cells: ['no', 'no', 'runPlants', 'runPlants', 'yes', 'yes'] },
      { key: 'replace', cells: ['no', 'no', 'runPlants', 'runPlants', 'yes', 'yes'] },
    ],
  },
  {
    group: 'tracking',
    rows: [
      { key: 'tracking', cells: ['no', 'viewPlants', 'runPlants', 'runPlants', 'yes', 'yes'] },
      { key: 'excel', cells: ['no', 'viewPlants', 'no', 'runPlants', 'yes', 'yes'] },
    ],
  },
  {
    group: 'settings',
    rows: [
      // 稽核人員 (Q144): sees every plant, changes only the plants he runs (and only adds to the 自評單位 list).
      ...['templates', 'flows'].map((key) => ({ key, cells: ['no', 'no', 'no', 'editRun', 'yes', 'yes'] as Cells })),
      { key: 'launch', cells: ['no', 'no', 'no', 'no', 'yes', 'yes'] },
      { key: 'access', cells: ['no', 'no', 'no', 'no', 'yes', 'yes'] },
      { key: 'accessAdmins', cells: ['no', 'no', 'no', 'no', 'no', 'yes'] },
    ],
  },
]

type MatrixRow = { key: string; group?: string; cells?: Cell[] }

/** A role column's header and cells: one line, and never narrower than this so the six columns stay even. */
const ROLE_CELL: CSSProperties = { minWidth: 104, whiteSpace: 'nowrap' }

/** A heading inside the tab, 16px like the mockup's. */
const heading = (text: string) => (
  <Typography.Title level={5} style={{ margin: 0, fontSize: textSize(14) }}>{text}</Typography.Title>
)

/**
 * 權限說明 (Q117, #187): the 身分, what each may do, and what each sees. Read only; the same for everyone. 方向 A (#127):
 * drawn in AccessPage's card under its tabs, the rule as a plain line across it, the matrix running to the card's
 * edges with its contents centred.
 */
export function AccessGuide() {
  const { t } = useTranslation('access')
  const rows: MatrixRow[] = MATRIX.flatMap((g) => [{ key: `group-${g.group}`, group: g.group }, ...g.rows])

  const cell = (c: Cell) => (
    <span style={{ color: CELL_COLOR[c], fontWeight: c === 'yes' ? 700 : undefined }} aria-label={c === 'yes' ? '✓' : undefined}>
      {c === 'yes' ? '✓' : c === 'no' ? '—' : t(`guide.cell.${c}`)}
    </span>
  )

  return (
    <Flex vertical data-testid="access-guide">
      {/* One line over the matrix (使用者 2026-11-24: the head took the matrix's room): its title and the 身分 legend. */}
      <Flex align="center" gap="8px 16px" wrap style={{ paddingBlock: '12px 8px' }}>
        {heading(t('guide.matrixTitle'))}
        <Flex gap={8} wrap>
          {IDENTITIES.map((i) => (
            <IdentityTag key={i} identity={i}>{t(`role.${i}`)}</IdentityTag>
          ))}
        </Flex>
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
              r.group ? { colSpan: IDENTITIES.length + 1, style: { paddingInlineStart: 'var(--csa-card-pad)', background: palette.bg } } : {},
            render: (_, r) => (r.group ? <Typography.Text strong>{t(`guide.group.${r.group}`)}</Typography.Text> : t(`guide.row.${r.key}`)),
          },
          // Each role as wide as its longest cell on one line (at least ROLE_CELL's minWidth), so 功能／操作 gives up its spare width
          // and nothing wraps (a 1px width in the automatic layout, as NO_WRAP).
          ...IDENTITIES.map((i, n) => ({
            title: <div style={ROLE_CELL}>{t(`role.${i}`)}</div>,
            key: i,
            align: 'center' as const,
            width: 1,
            onCell: (r: MatrixRow) => (r.group ? { colSpan: 0 } : {}),
            render: (_: unknown, r: MatrixRow) => (r.cells ? <div style={ROLE_CELL}>{cell(r.cells[n]!)}</div> : null),
          })),
        ]}
      />

      {/* The rule that holds whatever the role, under the matrix it qualifies. */}
      <Typography.Paragraph className="csa-edge-row" style={{ marginBlock: 0, paddingBlock: 10, color: palette.textSecondary, borderTop: `1px solid ${palette.border}` }} data-testid="access-guide-rule">
        {t('guide.rule')}
      </Typography.Paragraph>
      <div className="csa-edge-row" style={{ paddingBlock: '14px 8px', borderTop: `1px solid ${palette.border}` }}>{heading(t('guide.scopeTitle'))}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, paddingBottom: 16 }}>
        {IDENTITIES.map((i) => {
          const { color } = IDENTITY_COLOR[i]
          return (
            <div key={i} data-testid={`access-guide-${i}`} style={{ padding: '10px 12px', border: `1px solid ${palette.border}`, borderRadius: palette.radius }}>
              <Flex align="center" gap={6} style={{ color, fontWeight: 600, fontSize: textSize(14) }}>
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: color, flex: 'none' }} />
                {t(`role.${i}`)}
              </Flex>
              <ul style={{ margin: '4px 0 6px', paddingInlineStart: 18 }}>
                {(t(`guide.card.${i}.points`, { returnObjects: true }) as string[]).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <Typography.Text type="secondary">{t(`guide.card.${i}.note`)}</Typography.Text>
            </div>
          )
        })}
      </div>
      {/* The 廠區管理員 rule that sat under the plant cells on 人員 until #215. */}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }} data-testid="access-guide-coordinator-rule">
        {t('guide.coordinatorRule')}
      </Typography.Paragraph>
    </Flex>
  )
}
