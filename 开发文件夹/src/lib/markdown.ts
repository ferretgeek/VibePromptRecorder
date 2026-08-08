export interface MarkdownSafety {
  mode: 'wysiwyg_safe' | 'source_only'
  reasons: string[]
  oversized: boolean
  byteCount: number
  characterCount: number
}

const SOURCE_ONLY_RULES: Array<[RegExp, string]> = [
  [/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '检测到 YAML Front Matter'],
  [/^\[\^[^\]]+\]:/m, '检测到脚注定义'],
  [/\[\^[^\]]+\]/, '检测到脚注引用'],
  [/^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im, '检测到 GitHub Alert'],
  // 块级 $$...$$，或行内 $...$ 且其中包含 TeX 运算符（\ ^ _ { }），
  // 以避免把「花了 $5 赚了 $10」这类普通货币文本误判为数学公式。
  [/\$\$[\s\S]+?\$\$/, '检测到数学公式语法'],
  [/^:::[a-z]/im, '检测到自定义指令'],
]

const ALLOWED_HTML_TAGS = new Set([
  'p',
  'br',
  'strong',
  'em',
  's',
  'del',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'code',
  'pre',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'details',
  'summary',
  'kbd',
])

// 单次线性扫描行内 $...$；避免两个相邻贪婪区间在未闭合长行上产生平方级回溯。
function containsInlineMath(markdown: string): boolean {
  let index = 0
  while (index < markdown.length) {
    const opening = markdown.indexOf('$', index)
    if (opening < 0) return false
    if (markdown[opening + 1] === '$') {
      const closingBlock = markdown.indexOf('$$', opening + 2)
      index = closingBlock < 0 ? opening + 2 : closingBlock + 2
      continue
    }
    let hasTexOperator = false
    let cursor = opening + 1
    for (; cursor < markdown.length; cursor += 1) {
      const character = markdown[cursor]
      if (character === '\n' || character === '\r') break
      if (character === '$') {
        if (hasTexOperator) return true
        break
      }
      if (
        character === '\\' ||
        character === '^' ||
        character === '_' ||
        character === '{' ||
        character === '}'
      ) {
        hasTexOperator = true
      }
    }
    index = Math.max(opening + 1, cursor + 1)
  }
  return false
}

function unclosedFence(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/)
  let open: { marker: '`' | '~'; length: number } | null = null
  for (const line of lines) {
    if (!open) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (!match?.[1]) continue
      const marker = match[1][0] as '`' | '~'
      if (marker === '`' && (match[2] ?? '').includes('`')) continue
      open = { marker, length: match[1].length }
      continue
    }
    const closing = new RegExp(`^ {0,3}\\${open.marker}{${open.length},}[\\t ]*$`)
    if (closing.test(line)) open = null
  }
  return open !== null
}

function unclosedRawHtmlBlock(markdown: string): boolean {
  const delimitedBlocks: Array<[RegExp, string]> = [
    [/<!--/g, '-->'],
    [/<\?/g, '?>'],
    [/<!\[CDATA\[/g, ']]>'],
  ]
  for (const [opening, closing] of delimitedBlocks) {
    opening.lastIndex = 0
    while (opening.exec(markdown) !== null) {
      const closingIndex = markdown.indexOf(closing, opening.lastIndex)
      if (closingIndex < 0) return true
      opening.lastIndex = closingIndex + closing.length
    }
  }
  const rawTags = /<\s*(script|pre|style|textarea)(?:\s|>|$)/gi
  let tag: RegExpExecArray | null
  while ((tag = rawTags.exec(markdown))) {
    const name = tag[1]
    if (!name) continue
    const closing = new RegExp(`<\\/\\s*${name}\\s*>`, 'gi')
    closing.lastIndex = rawTags.lastIndex
    const match = closing.exec(markdown)
    if (!match) return true
    rawTags.lastIndex = closing.lastIndex
  }
  const declarations = /^\s{0,3}<![A-Z][^\n]*$/gm
  for (const match of markdown.matchAll(declarations)) {
    if (!match[0].includes('>')) return true
  }
  return false
}

export function markdownConcatenationRisks(markdown: string): string[] {
  const risks: string[] = []
  if (unclosedFence(markdown)) risks.push('未闭合的 Markdown 代码围栏')
  if (unclosedRawHtmlBlock(markdown)) risks.push('未闭合的原始 HTML 块')
  return risks
}

export function utf8ByteLengthAtLeast(value: string, threshold: number): boolean {
  let byteCount = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    byteCount += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (byteCount >= threshold) return true
  }
  return false
}

function unsafeHtml(markdown: string): boolean {
  const tagPattern = /<\/?([a-zA-Z][\w-]*)(?:\s[^>]*)?>/g
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(markdown))) {
    const tag = match[1]?.toLowerCase()
    const source = match[0]
    if (!tag || !ALLOWED_HTML_TAGS.has(tag)) return true
    if (
      /\son\w+\s*=|\sstyle\s*=|\s(?:src|href)\s*=\s*["']?\s*(?:javascript|file|data):/i.test(source)
    ) {
      return true
    }
  }
  return false
}

function containsRawHtml(markdown: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(markdown)
}

export function inspectMarkdownSafety(markdown: string): MarkdownSafety {
  const metrics = textMetrics(markdown)
  const oversized = metrics.byteCount >= 2 * 1024 * 1024
  if (oversized) {
    return {
      mode: 'source_only',
      reasons: ['内容达到 2 MiB，已启用超大轮次安全模式'],
      oversized: true,
      ...metrics,
    }
  }
  const reasons = new Set(
    SOURCE_ONLY_RULES.filter(([pattern]) => pattern.test(markdown)).map(([, reason]) => reason),
  )
  if (containsInlineMath(markdown)) reasons.add('检测到数学公式语法')
  if (unclosedFence(markdown)) reasons.add('检测到未闭合的代码围栏')
  if (unsafeHtml(markdown)) reasons.add('检测到不受支持或不安全的原始 HTML')
  else if (containsRawHtml(markdown)) reasons.add('检测到原始 HTML，仅在安全预览中渲染')
  const reasonList = [...reasons]
  return {
    mode: reasonList.length ? 'source_only' : 'wysiwyg_safe',
    reasons: reasonList,
    oversized: false,
    ...metrics,
  }
}

export function plainTextFromMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?|```$/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
}

export function countCharacters(value: string): number {
  return textMetrics(value).characterCount
}

export function truncateUtf16Safely(value: string, maxUnits: number): string {
  if (value.length <= maxUnits) return value
  let end = Math.max(0, maxUnits)
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return value.slice(0, end)
}

function textMetrics(value: string): { byteCount: number; characterCount: number } {
  let byteCount = 0
  let characterCount = 0
  for (const character of value) {
    characterCount += 1
    const codePoint = character.codePointAt(0) ?? 0
    byteCount += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return { byteCount, characterCount }
}

export function caseInsensitiveUtf16Range(
  value: string,
  query: string,
): { start: number; end: number } | null {
  const foldedQuery = query.toLocaleLowerCase('zh-CN')
  if (!foldedQuery) return null
  let foldedValue = ''
  const sourceRanges: Array<{ start: number; end: number }> = []
  let sourceOffset = 0
  for (const character of value) {
    const end = sourceOffset + character.length
    const foldedCharacter = character.toLocaleLowerCase('zh-CN')
    foldedValue += foldedCharacter
    for (let index = 0; index < foldedCharacter.length; index += 1) {
      sourceRanges.push({ start: sourceOffset, end })
    }
    sourceOffset = end
  }
  const foldedStart = foldedValue.indexOf(foldedQuery)
  if (foldedStart < 0) return null
  const first = sourceRanges[foldedStart]
  const last = sourceRanges[foldedStart + foldedQuery.length - 1]
  if (!first || !last) return null
  return { start: first.start, end: last.end }
}

export function extractCodeFromFence(value: string): string {
  return value.replace(/\n$/, '')
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol)
  } catch {
    return false
  }
}

/** 判断一个 32 位 IPv4（以四个八位组表示）是否落在回环/私有/保留网段。 */
function isPrivateIpv4Octets(a: number, b: number): boolean {
  return (
    a === 0 || // 0.0.0.0/8 本机
    a === 10 || // 10/8 私有
    a === 127 || // 127/8 回环
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // 169.254/16 link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 私有
    (a === 192 && b === 168) || // 192.168/16 私有
    a >= 224 // 组播/保留
  )
}

/**
 * 尝试把主机名解析为 IPv4 整数（覆盖十进制、十六进制、八进制、短点分等 WHATWG 记法），
 * 解析成功返回 [a,b,c,d]，否则返回 null（说明不是 IPv4 字面量）。
 */
function parseIpv4Literal(host: string): [number, number, number, number] | null {
  const segments = host.split('.')
  if (segments.length === 0 || segments.length > 4) return null
  const numbers: number[] = []
  for (const segment of segments) {
    if (segment === '') return null
    let value: number
    if (/^0x[0-9a-f]+$/i.test(segment)) value = parseInt(segment, 16)
    else if (/^0[0-7]+$/.test(segment)) value = parseInt(segment, 8)
    else if (/^\d+$/.test(segment)) value = parseInt(segment, 10)
    else return null
    if (!Number.isFinite(value) || value < 0) return null
    numbers.push(value)
  }
  // 按 WHATWG 规则组合成 32 位整数。
  let ip = 0
  if (numbers.length === 1) {
    ip = numbers[0]!
  } else {
    const last = numbers[numbers.length - 1]!
    const maxLast = 256 ** (5 - numbers.length)
    if (last >= maxLast) return null
    for (let i = 0; i < numbers.length - 1; i += 1) {
      if (numbers[i]! > 255) return null
      ip += numbers[i]! * 256 ** (3 - i)
    }
    ip += last
  }
  if (ip < 0 || ip > 0xffffffff) return null
  return [(ip >>> 24) & 0xff, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff]
}

/**
 * 保守判断远程图片地址是否指向本机/内网/保留地址。任何无法确定为「公网」的目标都按内网处理
 * （返回 true = 拒绝）。注意：字符串层无法防御 DNS 重绑定，正式代理仍应由 Rust 端二次校验。
 */
export function isPrivateImageUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return true
  }
  if (!['http:', 'https:'].includes(url.protocol)) return true
  const rawHost = url.hostname.toLowerCase()
  const host = rawHost.replace(/^\[|\]$/g, '')
  if (!host) return true
  // 明确的本机/本地名称。
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  // IPv6 处理。
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true
    // ULA(fc/fd)、link-local(fe80::/10)。
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true
    // IPv4 映射/兼容地址：提取尾部并按 IPv4 规则判断。
    const mapped =
      /(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/i.exec(host)
    if (mapped?.[1]) {
      if (mapped[1].includes('.')) {
        const octets = parseIpv4Literal(mapped[1])
        if (octets) return isPrivateIpv4Octets(octets[0], octets[1])
      } else {
        const [high, low] = mapped[1].split(':')
        const value32 = (parseInt(high ?? '0', 16) << 16) | parseInt(low ?? '0', 16)
        const a = (value32 >>> 24) & 0xff
        const b = (value32 >>> 16) & 0xff
        return isPrivateIpv4Octets(a, b)
      }
    }
    // 其它 IPv6：无法判定为公网时保守放行公网全局单播（2000::/3 之外一律拒绝）。
    return !/^[23]/.test(host)
  }
  // IPv4 字面量（含十进制/十六进制/八进制/短点分）。
  const octets = parseIpv4Literal(host)
  if (octets) return isPrivateIpv4Octets(octets[0], octets[1])
  // 普通域名：无法在前端探测重绑定，按公网放行（Rust 代理需再校验）。
  return false
}
