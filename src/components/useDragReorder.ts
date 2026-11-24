import { theme } from 'antd'
import { useEffect, useState, type CSSProperties, type DragEvent, type PointerEvent } from 'react'
import { moveId } from '../domain/templates'
import { palette } from '../theme'

/**
 * 拖曳排序 with the browser's own drag and drop, for one list (the sections of a template, or the
 * control points of one section). An item only becomes draggable while its handle is pressed, so the
 * text in a row stays selectable. Lists can be nested: each list ignores drags it did not start,
 * which is also what keeps a control point from being dropped into another section.
 * UI-only state, so it lives with the components rather than with the data hooks in src/hooks/.
 */
export function useDragReorder(ids: readonly string[], onReorder: (ids: string[]) => void) {
  const { token } = theme.useToken()
  const [armed, setArmed] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  // Pressing the handle without dragging: the pointer comes back up and nothing starts.
  useEffect(() => {
    if (!armed || dragging) return
    const release = () => setArmed(null)
    window.addEventListener('pointerup', release)
    return () => window.removeEventListener('pointerup', release)
  }, [armed, dragging])

  const reset = () => {
    setArmed(null)
    setDragging(null)
    setOver(null)
  }

  const handleProps = (id: string) => ({
    onPointerDown: (e: PointerEvent) => {
      e.stopPropagation()
      setArmed(id)
    },
    style: { cursor: 'grab', touchAction: 'none' } satisfies CSSProperties,
  })

  const itemProps = (id: string) => ({
    draggable: armed === id,
    onDragStart: (e: DragEvent) => {
      if (armed !== id) return
      e.stopPropagation()
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', id)
      setDragging(id)
    },
    onDragOver: (e: DragEvent) => {
      if (!dragging) return
      e.preventDefault()
      e.stopPropagation()
      if (over !== id) setOver(id)
    },
    onDrop: (e: DragEvent) => {
      if (!dragging) return
      e.preventDefault()
      e.stopPropagation()
      const next = moveId(ids, dragging, id)
      reset()
      if (next.some((x, i) => x !== ids[i])) onReorder(next)
    },
    onDragEnd: (e: DragEvent) => {
      if (!dragging) return
      e.stopPropagation()
      reset()
    },
    style: (dragging && over === id && dragging !== id
      ? { outline: `2px dashed ${token.colorPrimary}`, outlineOffset: -2 }
      : dragging === id
        ? { opacity: 0.5 }
        : {}) satisfies CSSProperties,
  })

  return { handleProps, itemProps }
}

/** A ⠿ handle's props in the secondary grey, as the mockups of 範本明細 and the 流程編輯器 (方向 A, #122, #123). */
export const greyHandle = <P extends { style: CSSProperties }>(props: P): P => ({ ...props, style: { ...props.style, color: palette.textTertiary } })
