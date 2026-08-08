import { describe, expect, it } from 'vitest'
import {
  countCharacters,
  caseInsensitiveUtf16Range,
  inspectMarkdownSafety,
  isPrivateImageUrl,
  isSafeExternalUrl,
  markdownConcatenationRisks,
  plainTextFromMarkdown,
  truncateUtf16Safely,
} from './markdown'

describe('Markdown 安全预检', () => {
  it('允许首版支持的普通 CommonMark 与 GFM', () => {
    const result = inspectMarkdownSafety('# 标题\n\n- [x] 任务\n\n```ts\nconst n = 1\n```')
    expect(result).toEqual({
      mode: 'wysiwyg_safe',
      reasons: [],
      oversized: false,
      byteCount: 45,
      characterCount: 37,
    })
  })

  it.each([
    ['---\ntitle: test\n---\n正文', 'YAML'],
    ['正文[^1]\n\n[^1]: 注释', '脚注'],
    ['<iframe src="https://example.com"></iframe>', 'HTML'],
    ['<a href="javascript:alert(1)">危险</a>', 'HTML'],
    ['<details><summary>安全详情</summary>正文</details>', 'HTML'],
    ['```ts\nconst open = true', '代码围栏'],
  ])('将有损或危险语法保持在源码模式：%s', (source, reason) => {
    const result = inspectMarkdownSafety(source)
    expect(result.mode).toBe('source_only')
    expect(result.reasons.join('')).toContain(reason)
  })

  it('对 2 MiB 边界启用超大轮次安全模式且不截断', () => {
    const source = '中'.repeat(Math.ceil((2 * 1024 * 1024) / 3))
    const result = inspectMarkdownSafety(source)
    expect(result.oversized).toBe(true)
    expect(countCharacters(source)).toBe([...source].length)
  })

  it('普通货币文本不再被数学公式规则误判', () => {
    const result = inspectMarkdownSafety('这轮花了 $5，又赚了 $10，共 $15。')
    expect(result.mode).toBe('wysiwyg_safe')
  })

  it('真正的 LaTeX 数学语法仍进入源码模式', () => {
    expect(inspectMarkdownSafety('行内公式 $x_i^2$ 结束').mode).toBe('source_only')
    expect(inspectMarkdownSafety('$$\\int_0^1 x\\,dx$$').mode).toBe('source_only')
  })

  it('未闭合的超长行内数学候选保持线性时间', () => {
    const source = `$${'_'.repeat(128 * 1024)}`
    const started = performance.now()
    expect(inspectMarkdownSafety(source).mode).toBe('wysiwyg_safe')
    expect(performance.now() - started).toBeLessThan(250)
  })
})

describe('纯原文拼接边界', () => {
  it.each([
    ['```ts\nconst open = true', '代码围栏'],
    ['~~~~\n内容\n~~~', '代码围栏'],
    ['<!-- 未闭合注释', 'HTML'],
    ['<script>\nconst value = 1', 'HTML'],
    ['<![CDATA[\n原始内容', 'HTML'],
  ])('识别可吞并后续轮次的未闭合块：%s', (source, reason) => {
    expect(markdownConcatenationRisks(source).join('')).toContain(reason)
  })

  it.each([
    '```ts\nconst closed = true\n```',
    '~~~~\n内容\n~~~~',
    '<script>const value = 1</script>',
    '<div>普通块会被轮次间空行终止</div>',
    '数学比较：a < b > c',
  ])('闭合块与普通尖括号文本不误报：%s', (source) => {
    expect(markdownConcatenationRisks(source)).toEqual([])
  })
})

describe('链接、图片与纯文本辅助函数', () => {
  const ipv4ImageUrl = (...octets: [number, number, number, number]) =>
    `http://${octets.join('.')}/a.png`

  it('只允许明确的外部协议', () => {
    expect(isSafeExternalUrl('https://example.com/a')).toBe(true)
    expect(isSafeExternalUrl('mailto:test@example.com')).toBe(true)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('file:///C:/secret.txt')).toBe(false)
  })

  it.each([
    ipv4ImageUrl(127, 0, 0, 1),
    'http://localhost/a.png',
    ipv4ImageUrl(10, 0, 0, 1),
    ipv4ImageUrl(172, 20, 0, 1),
    ipv4ImageUrl(192, 168, 1, 1),
    ipv4ImageUrl(169, 254, 1, 1),
    'http://[fe80::1]/a.png',
    'http://[fd00::1]/a.png',
    'http://[::ffff:127.0.0.1]/a.png',
    'http://printer.local/a.png',
    // 各类 IPv4 字面量绕过写法都必须被识别为内网/回环：
    'http://2130706433/a.png', // 回环地址的十进制形式
    'http://127.1/a.png', // 回环地址的短点分形式
    'http://0x7f.1/a.png', // 回环地址的十六进制段形式
    'http://0x7f000001/a.png', // 回环地址的纯十六进制形式
    ipv4ImageUrl(192, 168, 0, 1),
    ipv4ImageUrl(100, 64, 0, 1), // CGNAT 保留段
  ])('阻止本机与内网图片：%s', (url) => expect(isPrivateImageUrl(url)).toBe(true))

  it('允许显式授权的公网图片', () => {
    expect(isPrivateImageUrl('https://example.com/a.png')).toBe(false)
    expect(isPrivateImageUrl('https://8.8.8.8/a.png')).toBe(false)
  })

  it('提取适合列表预览的正文', () => {
    expect(plainTextFromMarkdown('## 标题\n\n**粗体**与[链接](https://example.com)')).toBe(
      '标题\n\n粗体与链接',
    )
  })

  it('UTF-16 预览截断不会留下孤立高代理项', () => {
    expect(truncateUtf16Safely(`${'a'.repeat(8191)}😀`, 8192)).toBe('a'.repeat(8191))
  })

  it('大小写映射长度变化时返回原文 UTF-16 范围', () => {
    expect(caseInsensitiveUtf16Range('İstanbul', 's')).toEqual({ start: 1, end: 2 })
    expect(caseInsensitiveUtf16Range('😀TypeScript', 'type')).toEqual({ start: 2, end: 6 })
  })
})
