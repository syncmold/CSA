import { useEffect, useRef, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { PlantOption } from '../domain/plantChoice'
import { palette, textSize } from '../theme'

/** The colours of the band of 廠區 (global.css's .csa-plant-band draws it). */
const BAND_COLOURS = {
  '--csa-plant-band': palette.tableHeaderBg,
  '--csa-plant-line': palette.border,
  '--csa-plant-text': palette.text,
  '--csa-plant-name': palette.textTertiary,
  '--csa-plant-hover': palette.surface,
  '--csa-plant-on': palette.primary,
  '--csa-plant-on-text': palette.surface,
} as CSSProperties

/**
 * 廠區按鈕（#84 B2）：一排按鈕，選中的填色。範本管理與簽核流程（#85）共用這個元件與同一個選擇（usePlantChoice）。
 * 真正的按鈕（aria-pressed），可以用 Tab 走到、Enter／空白鍵選。方向 A（#120）不另佔一張卡片：
 * 卡片頂端一條淺灰的廠區帶，按鈕沒有框，代碼粗字、名稱灰字，選中的填紫色，和下面白底、底線的組成要素分頁分得開；
 * 窄螢幕上排成一行左右滑，選中的捲進畫面。
 */
export function PlantPicker({
  options,
  value,
  onChange,
  testId = 'plant-picker',
}: {
  options: readonly PlantOption[]
  value: string | null
  onChange: (plant: string) => void
  testId?: string
}) {
  const { t } = useTranslation()
  const band = useRef<HTMLDivElement>(null)
  // On a narrow screen the band scrolls sideways: bring the chosen plant into it rather than leave it off the edge.
  useEffect(() => {
    const list = band.current
    const chosen = list?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (!list || !chosen) return
    const [box, item] = [list.getBoundingClientRect(), chosen.getBoundingClientRect()]
    if (item.left < box.left || item.right > box.right) list.scrollLeft += item.left - box.left - (box.width - item.width) / 2
  }, [value, options.length])
  return (
    <div className="csa-edge-row csa-plant-band" style={BAND_COLOURS} role="group" aria-labelledby={`${testId}-label`} data-testid={testId}>
      <span id={`${testId}-label`} className="csa-plant-label" style={{ fontSize: textSize(12) }}>
        {t('plants.pickerLabel')}
      </span>
      <div ref={band} className="csa-plant-options">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            className="csa-plant-option"
            style={{ fontSize: textSize(13) }}
            aria-pressed={o.key === value}
            onClick={() => onChange(o.key)}
            data-testid={`plant-${o.key}`}
          >
            {/* A space between, so the button reads 「GT 敬得(觀音)」 (domain/plantChoice's plantLabel). */}
            {o.code && <b>{o.code}</b>}
            {o.code && o.name && ' '}
            {o.name && <span className="csa-plant-name">{o.name}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
