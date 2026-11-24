import { expect, type Page } from '@playwright/test'

/** 繁中 and English side by side on one line (#117, #137: squeezed, they wrapped under each other). */
export async function expectLanguageButtonsOnOneLine(page: Page) {
  const box = (text: string) => page.getByTestId('language-switcher').getByText(text, { exact: true }).boundingBox()
  const [zh, en] = [(await box('繁中'))!, (await box('English'))!]
  expect(Math.abs(en.y - zh.y)).toBeLessThanOrEqual(1)
  expect(en.x).toBeGreaterThan(zh.x)
}
