import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../types'
import { applyAppearance, resolvedTheme } from './theme'

describe('字体外观映射', () => {
  it('新安装默认使用蓝白主题', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('neutral')
    applyAppearance(DEFAULT_SETTINGS)
    expect(document.documentElement.dataset.theme).toBe('neutral')
    expect(resolvedTheme(DEFAULT_SETTINGS.theme)).toBe('light')
  })

  it('按用户顺序生成回退链并始终保留系统通用兜底', () => {
    applyAppearance({
      ...DEFAULT_SETTINGS,
      bodyFontFamily: '自定义正文',
      bodyFallbackFamilies: ['HarmonyOS Sans SC', 'Microsoft YaHei', 'Segoe UI Emoji'],
      codeFontFamily: '自定义代码',
      codeFallbackFamilies: ['Cascadia Mono', 'Consolas'],
    })

    expect(document.documentElement.style.getPropertyValue('--font-body')).toBe(
      '"自定义正文", "HarmonyOS Sans SC", "Microsoft YaHei", "Segoe UI Emoji", sans-serif',
    )
    expect(document.documentElement.style.getPropertyValue('--font-code')).toBe(
      '"自定义代码", "Cascadia Mono", "Consolas", monospace',
    )
  })

  it('去除与主字体重复的回退项', () => {
    applyAppearance({
      ...DEFAULT_SETTINGS,
      uiFontFamily: 'Segoe UI',
      uiFallbackFamilies: ['Segoe UI', 'Microsoft YaHei UI'],
    })
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(
      '"Segoe UI", "Microsoft YaHei UI", sans-serif',
    )
  })

  it('转义不可信字体名中的引号、反斜杠和控制字符', () => {
    applyAppearance({
      ...DEFAULT_SETTINGS,
      bodyFontFamily: '恶意\\"字体\nfallback',
      bodyFallbackFamilies: [],
    })
    expect(document.documentElement.style.getPropertyValue('--font-body')).toBe(
      '"恶意\\\\\\"字体\\a fallback", sans-serif',
    )
  })
})
