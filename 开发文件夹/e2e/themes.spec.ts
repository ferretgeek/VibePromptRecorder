import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const themeCases = [
  {
    id: 'neutral',
    name: '晴空蓝白',
    variables: {
      bgApp: '#eaf2fc',
      bgElevated: '#ffffff',
      bgSoft: '#eff5fc',
      textPrimary: '#172033',
      textSecondary: '#58677a',
      textTertiary: '#5d6b7e',
      bgPanel: '#f8fbff',
      accent: '#2563eb',
      accentStrong: '#1d4ed8',
      accentSecondary: '#38bdf8',
      accentSoft: '#dbeafe',
      accentContrast: '#ffffff',
    },
  },
  {
    id: 'warm',
    name: '珊瑚暖杏',
    variables: {
      bgApp: '#f6eee5',
      bgElevated: '#fffefd',
      bgSoft: '#fdf1e7',
      textPrimary: '#30241f',
      textSecondary: '#766258',
      textTertiary: '#786258',
      bgPanel: '#fffbf5',
      accent: '#c94a2b',
      accentStrong: '#a7341d',
      accentSecondary: '#f59e0b',
      accentSoft: '#ffdfd2',
      accentContrast: '#ffffff',
    },
  },
  {
    id: 'mint',
    name: '湖水薄荷',
    variables: {
      bgApp: '#e9f7f4',
      bgElevated: '#ffffff',
      bgSoft: '#e5f5f1',
      textPrimary: '#14342e',
      textSecondary: '#53736c',
      textTertiary: '#536f68',
      bgPanel: '#f7fdfb',
      accent: '#087a67',
      accentStrong: '#056452',
      accentSecondary: '#84cc16',
      accentSoft: '#cff2e8',
      accentContrast: '#ffffff',
    },
  },
  {
    id: 'lavender',
    name: '莓果淡紫',
    variables: {
      bgApp: '#f0edfb',
      bgElevated: '#ffffff',
      bgSoft: '#f2effc',
      textPrimary: '#28243d',
      textSecondary: '#66607b',
      textTertiary: '#686177',
      bgPanel: '#faf9ff',
      accent: '#7157d9',
      accentStrong: '#5638bd',
      accentSecondary: '#d946ef',
      accentSoft: '#e9ddff',
      accentContrast: '#ffffff',
    },
  },
  {
    id: 'graphite',
    name: '曜石深灰',
    variables: {
      bgApp: '#0d0f12',
      bgElevated: '#191e25',
      bgSoft: '#171b21',
      textPrimary: '#f2f5f9',
      textSecondary: '#aab4c2',
      textTertiary: '#8f9baa',
      bgPanel: '#13171c',
      accent: '#5b9cf6',
      accentStrong: '#86b8ff',
      accentSecondary: '#22d3ee',
      accentSoft: '#172b47',
      accentContrast: '#07111f',
    },
  },
] as const

function luminance(hex: string): number {
  const channels = [0, 2, 4]
    .map((index) => Number.parseInt(hex.slice(1 + index, 3 + index), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((left, right) => right - left)
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05)
}

test('默认蓝白及五套主题保持清晰层级和可读对比度', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', '视觉主题矩阵只运行一次')
  await mkdir('artifacts/theme-review', { recursive: true })
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'neutral')

  for (const [index, theme] of themeCases.entries()) {
    if (index > 0) {
      await page.getByRole('button', { name: /打开设置/ }).click()
      await page.getByRole('button', { name: new RegExp(theme.name) }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id)
      await page.getByRole('button', { name: '完成', exact: true }).click()
    }

    const variables = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      const read = (name: string) => style.getPropertyValue(name).trim().toLowerCase()
      return {
        bgApp: read('--bg-app'),
        bgElevated: read('--bg-elevated'),
        bgSoft: read('--bg-soft'),
        textPrimary: read('--text-primary'),
        textSecondary: read('--text-secondary'),
        textTertiary: read('--text-tertiary'),
        bgPanel: read('--bg-panel'),
        accent: read('--accent'),
        accentStrong: read('--accent-strong'),
        accentSecondary: read('--accent-secondary'),
        accentSoft: read('--accent-soft'),
        accentContrast: read('--accent-contrast'),
      }
    })

    expect(variables).toEqual(theme.variables)
    expect(contrast(variables.textPrimary, variables.bgElevated)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(variables.textSecondary, variables.bgPanel)).toBeGreaterThanOrEqual(4.5)
    for (const background of [
      variables.bgApp,
      variables.bgElevated,
      variables.bgPanel,
      variables.bgSoft,
    ]) {
      expect(contrast(variables.textTertiary, background)).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(variables.accentContrast, variables.accent)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(variables.accentStrong, variables.accentSoft)).toBeGreaterThanOrEqual(4.5)
    if (theme.id === 'graphite') {
      await expect
        .poll(() =>
          page
            .locator('.crepe-placeholder')
            .evaluate((element) => getComputedStyle(element, '::before').color),
        )
        .toBe('rgb(143, 155, 170)')
    }
    await page.screenshot({
      path: `artifacts/theme-review/${String(index + 1).padStart(2, '0')}-${theme.id}.png`,
      fullPage: true,
    })
  }

  await page.getByRole('button', { name: /打开设置/ }).click()
  await expect(page.getByRole('button', { name: /晴空蓝白/ })).toBeVisible()
  await page.screenshot({ path: 'artifacts/theme-review/06-theme-picker.png', fullPage: true })
})
