import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'

const languageLoaders = {
  json: () => import('@shikijs/langs/json'),
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  jsx: () => import('@shikijs/langs/jsx'),
  tsx: () => import('@shikijs/langs/tsx'),
  html: () => import('@shikijs/langs/html'),
  xml: () => import('@shikijs/langs/xml'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  shell: () => import('@shikijs/langs/shellscript'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  sql: () => import('@shikijs/langs/sql'),
  yaml: () => import('@shikijs/langs/yaml'),
  markdown: () => import('@shikijs/langs/markdown'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  toml: () => import('@shikijs/langs/toml'),
} as const

type HighlightLanguage = keyof typeof languageLoaders | 'plaintext'

const aliases = Object.assign(Object.create(null) as Record<string, HighlightLanguage>, {
  text: 'plaintext',
  txt: 'plaintext',
  js: 'javascript',
  ts: 'typescript',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  py: 'python',
  cs: 'csharp',
  yml: 'yaml',
  md: 'markdown',
  docker: 'dockerfile',
})

export const MAX_HIGHLIGHT_CODE_UNITS = 128 * 1024

let highlighterPromise: Promise<HighlighterCore> | null = null
const loaded = new Set<string>()
const loading = new Map<string, Promise<void>>()

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
  return highlighterPromise
}

export function normalizeLanguage(language?: string): HighlightLanguage {
  const normalized = language?.trim().toLowerCase() ?? 'plaintext'
  if (Object.hasOwn(aliases, normalized)) return aliases[normalized]!
  return Object.hasOwn(languageLoaders, normalized)
    ? (normalized as keyof typeof languageLoaders)
    : 'plaintext'
}

async function ensureLanguage(
  highlighter: HighlighterCore,
  language: keyof typeof languageLoaders,
) {
  if (loaded.has(language)) return
  let pending = loading.get(language)
  if (!pending) {
    pending = languageLoaders[language]()
      .then((module) => highlighter.loadLanguage(module))
      .then(() => {
        loaded.add(language)
      })
      .finally(() => {
        loading.delete(language)
      })
    loading.set(language, pending)
  }
  await pending
}

function plainTextHtml(code: string): string {
  const escaped = code
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
  return `<pre class="shiki"><code>${escaped}</code></pre>`
}

export async function highlightCode(
  code: string,
  language?: string,
  dark = false,
): Promise<string> {
  const normalized = normalizeLanguage(language)
  // Shiki 的 JS 正则分词在主线程同步执行；超大代码块必须在加载引擎/语言前短路。
  if (normalized === 'plaintext' || code.length > MAX_HIGHLIGHT_CODE_UNITS) {
    return plainTextHtml(code)
  }
  const highlighter = await getHighlighter()
  await ensureLanguage(highlighter, normalized)
  return highlighter.codeToHtml(code, {
    lang: normalized,
    theme: dark ? 'github-dark' : 'github-light',
  })
}
