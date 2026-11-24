// Column settings shared by the tables (antd Table).

/**
 * For short columns (編號, 版本, 狀態, 適用廠區…): exactly as wide as their content on one line (a 1px width that
 * never wraps), so the one column without a width (the name) takes what is left, instead of a long value
 * stacking into several lines next to an empty name column. Relies on the table's automatic layout: a column that
 * is fixed, has ellipsis, or a table with scroll.y switches antd to a fixed layout, where 1px would really be 1px.
 */
export const NO_WRAP = {
  width: 1,
  onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
  onCell: () => ({ style: { whiteSpace: 'nowrap' } }),
} as const
