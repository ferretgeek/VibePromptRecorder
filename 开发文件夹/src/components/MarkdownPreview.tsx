import { Check, Copy, ExternalLink, ImageOff, LoaderCircle } from 'lucide-react'
import {
  memo,
  useEffect,
  isValidElement,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type ImgHTMLAttributes,
} from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { api, isTauri, writeClipboard } from '../lib/api'
import { highlightCode, MAX_HIGHLIGHT_CODE_UNITS, normalizeLanguage } from '../lib/highlighter'
import {
  extractCodeFromFence,
  isPrivateImageUrl,
  isSafeExternalUrl,
  truncateUtf16Safely,
  utf8ByteLengthAtLeast,
} from '../lib/markdown'

const LARGE_PREVIEW_THRESHOLD_BYTES = 2 * 1024 * 1024
const LARGE_PREVIEW_EXCERPT_UNITS = 256 * 1024

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'kbd', 'input'],
  attributes: {
    ...defaultSchema.attributes,
    a: ['href', 'title'],
    ol: ['start'],
    td: ['align', 'colspan', 'rowspan'],
    th: ['align', 'colspan', 'rowspan'],
    input: ['type', 'checked', 'disabled'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
}

async function openExternal(href: string) {
  if (!isSafeExternalUrl(href)) return
  const url = new URL(href)
  const accepted = window.confirm(`即将使用系统默认程序打开：\n\n${url.href}\n\n是否继续？`)
  if (!accepted) return
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(href)
  } else {
    window.open(href, '_blank', 'noopener,noreferrer')
  }
}

function SafeLink({ href = '', children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const safe = isSafeExternalUrl(href)
  return (
    <a
      {...props}
      href={safe ? href : undefined}
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault()
        if (safe) {
          void openExternal(href).catch(() => {
            window.alert('无法打开该链接，请稍后重试。')
          })
        }
      }}
      title={safe ? `打开外部链接：${href}` : '已阻止不安全的链接'}
    >
      {children}
      {safe ? <ExternalLink className="inline-icon" aria-hidden="true" /> : null}
    </a>
  )
}

function RemoteImage(props: ImgHTMLAttributes<HTMLImageElement>) {
  return <RemoteImageState key={props.src} {...props} />
}

function RemoteImageState({ src = '', alt = '', title }: ImgHTMLAttributes<HTMLImageElement>) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const blocked = !src || isPrivateImageUrl(src)
  const sourceLabel = (() => {
    try {
      return new URL(src).hostname
    } catch {
      return src
    }
  })()

  useEffect(
    () => () => {
      requestIdRef.current += 1
    },
    [],
  )

  if (dataUrl && !failed && !blocked) {
    return (
      <span className="remote-image">
        <img
          src={dataUrl}
          alt={alt}
          title={title}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(true)}
        />
        {alt ? <span className="remote-image__caption">{alt}</span> : null}
      </span>
    )
  }

  return (
    <span className="remote-image-placeholder">
      <ImageOff aria-hidden="true" />
      <span>
        <strong>
          {failed || errorMessage
            ? '图片加载失败'
            : blocked
              ? '已阻止本机或内网图片'
              : loading
                ? '正在安全加载图片'
                : '远程图片默认未加载'}
        </strong>
        <small>{errorMessage ?? (alt ? alt + ' · ' + sourceLabel : sourceLabel)}</small>
      </span>
      {!blocked ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            if (failed) {
              setFailed(false)
              setDataUrl(null)
            }
            let host: string
            try {
              host = new URL(src).hostname
            } catch {
              setErrorMessage('图片地址无效')
              return
            }
            if (window.confirm(`本次临时加载来自 ${host} 的图片？不会保存到项目。`)) {
              if (!isTauri()) {
                setErrorMessage('安全远程图片加载仅在 Windows 应用中可用')
                return
              }
              const requestId = ++requestIdRef.current
              setLoading(true)
              setErrorMessage(null)
              void api
                .fetchRemoteImage(src)
                .then((result) => {
                  if (requestId === requestIdRef.current) setDataUrl(result.dataUrl)
                })
                .catch((error: unknown) => {
                  if (requestId === requestIdRef.current) {
                    setErrorMessage(error instanceof Error ? error.message : String(error))
                  }
                })
                .finally(() => {
                  if (requestId === requestIdRef.current) setLoading(false)
                })
            }
          }}
        >
          {loading ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : null}
          {failed || errorMessage ? '重试' : loading ? '加载中' : '临时加载'}
        </button>
      ) : null}
    </span>
  )
}

interface CodeBlockProps {
  code: string
  language?: string | undefined
  compact?: boolean
}

function MarkdownPre({ children, compact }: { children?: React.ReactNode; compact: boolean }) {
  const child = isValidElement<{
    className?: string
    children?: React.ReactNode
  }>(children)
    ? children
    : null
  if (!child) return <pre>{children}</pre>
  const language = /language-([\w+#-]+)/.exec(child.props.className ?? '')?.[1]
  const value = extractCodeFromFence(reactNodeText(child.props.children))
  return <CodeBlock code={value} language={language} compact={compact} />
}

// 所有代码块共享一个根主题观察器；最后一个订阅者卸载时再断开。
const themeListeners = new Set<() => void>()
let themeObserver: MutationObserver | null = null
const resolvedDarkSnapshot = () => document.documentElement.dataset.resolvedTheme === 'dark'
const subscribeResolvedTheme = (listener: () => void) => {
  themeListeners.add(listener)
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      for (const notify of themeListeners) notify()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-resolved-theme'],
    })
  }
  return () => {
    themeListeners.delete(listener)
    if (themeListeners.size === 0) {
      themeObserver?.disconnect()
      themeObserver = null
    }
  }
}

function useResolvedDark(): boolean {
  return useSyncExternalStore(subscribeResolvedTheme, resolvedDarkSnapshot, resolvedDarkSnapshot)
}

function HighlightedCodeBlock({ code, language }: Omit<CodeBlockProps, 'compact'>) {
  const [highlight, setHighlight] = useState<{
    key: string
    html: string | null
    failed: boolean
  }>({ key: '', html: null, failed: false })
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copyTimerRef = useRef<number | undefined>(undefined)
  const normalized = normalizeLanguage(language)
  const dark = useResolvedDark()
  const highlightKey = `${normalized}\u0000${dark ? 'dark' : 'light'}\u0000${code}`
  const html = highlight.key === highlightKey ? highlight.html : null
  const highlightFailed = highlight.key === highlightKey && highlight.failed
  const highlightSkipped = code.length > MAX_HIGHLIGHT_CODE_UNITS

  useEffect(() => {
    let active = true
    void highlightCode(code, normalized, dark)
      .then((value) => {
        if (active) setHighlight({ key: highlightKey, html: value, failed: false })
      })
      .catch(() => {
        if (active) setHighlight({ key: highlightKey, html: null, failed: true })
      })
    return () => {
      active = false
    }
  }, [code, normalized, dark, highlightKey])

  useEffect(
    () => () => {
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
    },
    [],
  )

  return (
    <div className="code-block">
      <div className="code-block__header">
        <span>
          {language || '纯文本'}
          {highlightSkipped ? ' · 内容过大，已显示纯文本' : ''}
        </span>
        <button
          type="button"
          onClick={() => {
            setCopyFailed(false)
            void writeClipboard(code)
              .then(() => {
                setCopied(true)
                if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
                copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_500)
              })
              .catch(() => setCopyFailed(true))
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? '已复制' : copyFailed ? '复制失败，请重试' : '复制代码'}
        </button>
      </div>
      {html ? (
        <div className="code-block__highlight" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
          {highlightFailed ? (
            <span className="code-block__error">代码高亮加载失败，已显示纯文本</span>
          ) : (
            <LoaderCircle className="code-block__loader" aria-label="正在加载代码高亮" />
          )}
        </pre>
      )}
    </div>
  )
}

function CodeBlock({ code, language, compact = false }: CodeBlockProps) {
  if (compact) {
    return (
      <pre className="code-block code-block--compact">
        <code>{code}</code>
      </pre>
    )
  }
  return <HighlightedCodeBlock code={code} language={language} />
}

interface MarkdownPreviewProps {
  markdown: string
  compact?: boolean
  wrapCode?: boolean
  className?: string
}

function reactNodeText(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return node.toString()
  if (Array.isArray(node)) return node.map(reactNodeText).join('')
  return ''
}

export const MarkdownPreview = memo(function MarkdownPreview({
  markdown,
  compact = false,
  wrapCode = false,
  className = '',
}: MarkdownPreviewProps) {
  const components = useMemo(
    () => ({
      a: compact
        ? ({ children }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
            <span className="compact-link">{children}</span>
          )
        : SafeLink,
      img: compact
        ? ({ alt = '' }: ImgHTMLAttributes<HTMLImageElement>) => (
            <span className="compact-image-alt">{alt ? '图片：' + alt : '图片'}</span>
          )
        : RemoteImage,
      pre: ({ children }: { children?: React.ReactNode }) => (
        <MarkdownPre compact={compact}>{children}</MarkdownPre>
      ),
      code: ({
        className: codeClassName,
        children,
      }: {
        className?: string
        children?: React.ReactNode
      }) => {
        return (
          <code className={[codeClassName, 'inline-code'].filter(Boolean).join(' ')}>
            {children}
          </code>
        )
      },
      input: ({ type, checked }: React.InputHTMLAttributes<HTMLInputElement>) => (
        <input type={type} checked={checked} disabled aria-label={checked ? '已完成' : '未完成'} />
      ),
    }),
    [compact],
  )

  if (!markdown.trim()) return <p className="markdown-empty">暂无内容</p>
  const previewClassName = [
    'markdown-body',
    compact ? 'markdown-body--compact' : '',
    wrapCode ? 'markdown-body--wrap-code' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  if (!compact && utf8ByteLengthAtLeast(markdown, LARGE_PREVIEW_THRESHOLD_BYTES)) {
    const excerpt = truncateUtf16Safely(markdown, LARGE_PREVIEW_EXCERPT_UNITS)
    return (
      <section className={`${previewClassName} markdown-large-preview`} aria-label="超大内容预览">
        <div className="markdown-large-preview__notice" role="status">
          <strong>超大内容已使用有界纯文本预览</strong>
          <span>
            为保持窗口流畅，这里只显示开头约 25 万个字符且不解析 Markdown；完整原文仍保留在 Markdown
            源码中，可继续编辑和导出。
          </span>
        </div>
        <pre className="markdown-large-preview__content">{excerpt}</pre>
      </section>
    )
  }
  return (
    <div className={previewClassName}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={components as Components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
})
