import { describe, expect, it } from 'vitest'
import { highlightCode, MAX_HIGHLIGHT_CODE_UNITS, normalizeLanguage } from './highlighter'

describe('normalizeLanguage', () => {
  it('不把对象原型上的属性误识别为语言别名', () => {
    expect(normalizeLanguage('constructor')).toBe('plaintext')
    expect(normalizeLanguage('__proto__')).toBe('plaintext')
  })

  it('保留受支持语言和显式别名', () => {
    expect(normalizeLanguage('TS')).toBe('typescript')
    expect(normalizeLanguage('rust')).toBe('rust')
  })

  it('超大受支持语言代码块直接安全转义为纯文本', async () => {
    const code = `<script>${'x'.repeat(MAX_HIGHLIGHT_CODE_UNITS)}</script>`
    const html = await highlightCode(code, 'typescript')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
})
