// 方向 A 併回 theme.ts（#132）：整站一套樣式，共用元件只有一種畫法。
import { ConfigProvider, theme } from 'antd'
import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { EditModeControls } from './components/EditModeControls'
import { PlantPicker } from './components/PlantPicker'
import { TemplateStatusTag, TemplateUsageTag } from './components/TemplateStatusTag'
import { antdTheme, INK, palette, textSize } from './theme'

/** As App has it: the whole app inside the theme, under a router for the buttons' navigate. */
const inApp = (children: ReactNode) => renderToStaticMarkup(h(MemoryRouter, null, h(ConfigProvider, { theme: antdTheme }, children)))

function Tokens() {
  const { token } = theme.useToken()
  return h('span', null, `${token.colorPrimary} ${token.fontSize}px`)
}

describe('antdTheme', () => {
  it('is 方向 A’s purple at the type scale moved by FONT_STEP (Q108)', () => {
    expect(inApp(h(Tokens))).toContain(`${palette.primary} ${textSize(14)}px`)
  })
})

describe('parts several pages share', () => {
  it('draws 狀態 and 使用狀況 as a dot and words in their meaning’s colour, not a tag', () => {
    const html = inApp(h('div', null, h(TemplateStatusTag, { status: 'active' }), h(TemplateUsageTag, { inUse: true })))
    expect(html).not.toContain('ant-tag')
    expect(html).toContain(INK.green.color)
    expect(html).toContain(INK.blue.color)
  })

  it('draws the 廠區 as a band of plain buttons, the chosen one pressed', () => {
    const html = inApp(h(PlantPicker, { options: [{ key: 'GT', code: 'GT', name: '敬得(觀音)' }], value: 'GT', onChange: () => {} }))
    expect(html).toContain('csa-plant-band')
    expect(html).not.toContain('ant-btn')
    expect(html).toContain('aria-pressed="true"')
  })

  it('has 查看／修改 buttons without icons, and 修改中 as words in the selected purple', () => {
    expect(inApp(h(EditModeControls, { editing: false, viewPath: '/admin/templates/1' }))).not.toContain('anticon')
    const html = inApp(h(EditModeControls, { editing: true, viewPath: '/admin/templates/1' }))
    expect(html).not.toContain('anticon')
    expect(html).not.toContain('ant-tag')
    expect(html).toMatch(new RegExp(`<span style="color:${palette.selectedText}[^"]*" data-testid="editing-badge">`))
  })
})
