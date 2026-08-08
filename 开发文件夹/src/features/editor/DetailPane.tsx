import {
  AlignLeft,
  ArrowLeft,
  Check,
  ChevronLeft,
  Copy,
  FileCode2,
  FileText,
  Download,
  Save,
  ShieldAlert,
  Sparkles,
  LoaderCircle,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { api, isTauri, writeClipboard } from '../../lib/api'
import type { MarkdownSafety } from '../../lib/markdown'
import { analyzeMarkdownSafety } from '../../lib/markdownSafetyClient'
import { formatClock, formatFullTime } from '../../lib/time'
import { useAppStore } from '../../stores/appStore'
import { IconButton } from '../../components/IconButton'
import { MarkdownPreview } from '../../components/MarkdownPreview'

// 编辑内核（Milkdown/ProseMirror、CodeMirror）体积较大且仅在打开详情后才需要，
// 懒加载可让冷启动先绘制项目列表与时间线，缩短「到可输入」时间。
const SourceEditor = lazy(() =>
  import('./SourceEditor').then((module) => ({ default: module.SourceEditor })),
)
const WysiwygEditor = lazy(() =>
  import('./WysiwygEditor').then((module) => ({ default: module.WysiwygEditor })),
)

function EditorLoading() {
  return <div className="editor-loading">正在加载编辑器…</div>
}

interface DetailPaneProps {
  onCompositionChange: (composing: boolean) => void
}

const LARGE_MARKDOWN_ANALYSIS_THRESHOLD = 256 * 1024
export const MARKDOWN_ANALYSIS_DELAY_MS = 120
export const LARGE_MARKDOWN_ANALYSIS_DELAY_MS = 600

interface DeferredSafetyResult {
  editorIdentity: string
  markdown: string
  safety: MarkdownSafety
}

function useDeferredMarkdownSafety(markdown: string, editorIdentity: string) {
  const [analysis, setAnalysis] = useState<DeferredSafetyResult | null>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    const request = ++requestRef.current
    const delay =
      markdown.length >= LARGE_MARKDOWN_ANALYSIS_THRESHOLD
        ? LARGE_MARKDOWN_ANALYSIS_DELAY_MS
        : MARKDOWN_ANALYSIS_DELAY_MS
    const timer = window.setTimeout(() => {
      void analyzeMarkdownSafety(markdown)
        .then((safety) => {
          if (request === requestRef.current) setAnalysis({ editorIdentity, markdown, safety })
        })
        .catch(() => {
          if (request !== requestRef.current) return
          setAnalysis({
            editorIdentity,
            markdown,
            safety: {
              mode: 'source_only',
              reasons: ['Markdown 安全分析失败，已保守使用源码模式'],
              oversized: false,
              byteCount: 0,
              characterCount: 0,
            },
          })
        })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [editorIdentity, markdown])

  return analysis
}

export function DetailPane({ onCompositionChange }: DetailPaneProps) {
  const activeRound = useAppStore((state) => state.activeRound)
  const content = useAppStore((state) => state.editorContent)
  const note = useAppStore((state) => state.editorNote)
  const mode = useAppStore((state) => state.editorMode)
  const cursorAnchor = useAppStore((state) => state.cursorAnchor)
  const cursorHead = useAppStore((state) => state.cursorHead)
  const detailOpen = useAppStore((state) => state.detailOpen)
  const editorEpoch = useAppStore((state) => state.editorEpoch)
  const contentTransitionLocked = useAppStore((state) => state.contentTransitionLocked)
  const saveState = useAppStore((state) => state.saveState)
  const savedAt = useAppStore((state) => state.savedAt)
  const saveError = useAppStore((state) => state.saveError)
  const settings = useAppStore((state) => state.settings)
  const updateContent = useAppStore((state) => state.updateEditorContent)
  const updateNote = useAppStore((state) => state.updateEditorNote)
  const setMode = useAppStore((state) => state.setEditorMode)
  const setEditorSelection = useAppStore((state) => state.setEditorSelection)
  const setDetailOpen = useAppStore((state) => state.setDetailOpen)
  const flush = useAppStore((state) => state.flushActive)
  const finalize = useAppStore((state) => state.finalizeActiveDraft)
  const showToast = useAppStore((state) => state.showToast)
  const [copied, setCopied] = useState(false)
  const [readOnlyPreviewRoundId, setReadOnlyPreviewRoundId] = useState<string | null>(null)
  const readOnlyPreview = readOnlyPreviewRoundId === activeRound?.id
  const detailRef = useRef<HTMLElement>(null)
  const copyTimerRef = useRef<number | undefined>(undefined)
  const noteComposingRef = useRef(false)
  const onCompositionChangeRef = useRef(onCompositionChange)
  const editorIdentity = `${activeRound?.id ?? 'none'}:${editorEpoch}`
  const analysis = useDeferredMarkdownSafety(content, editorIdentity)
  const analysisMatchesEditor = analysis?.editorIdentity === editorIdentity
  const analysisPending = !analysisMatchesEditor || analysis?.markdown !== content
  const awaitingInitialSafety = !analysisMatchesEditor
  const safety = !analysisPending ? analysis.safety : null
  const effectiveMode = awaitingInitialSafety || safety?.mode === 'source_only' ? 'source' : mode

  useEffect(() => {
    useAppStore.setState({
      markdownSafetyPending: analysisPending,
      markdownSafetyMode: safety?.mode ?? null,
      markdownSafetyReason: safety?.reasons[0] ?? null,
    })
  }, [analysisPending, safety])

  useEffect(() => {
    if (safety?.mode === 'source_only' && mode !== 'source') {
      void setMode('source', false)
    }
  }, [mode, safety, setMode])

  useEffect(() => {
    if (detailOpen) detailRef.current?.focus({ preventScroll: true })
  }, [activeRound?.id, detailOpen])

  useEffect(() => {
    onCompositionChangeRef.current = onCompositionChange
  }, [onCompositionChange])

  useEffect(
    () => () => {
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
      if (noteComposingRef.current) {
        noteComposingRef.current = false
        onCompositionChangeRef.current(false)
      }
    },
    [],
  )

  useEffect(
    () => () => {
      // 收起详情或切换轮次只会卸载备注 input，不会卸载 DetailPane 本身；
      // 该条件分支也必须释放 App 级输入法组合状态。
      if (noteComposingRef.current) {
        noteComposingRef.current = false
        onCompositionChangeRef.current(false)
      }
    },
    [activeRound?.id, detailOpen],
  )

  if (!activeRound) {
    return (
      <section className="detail-pane detail-pane--empty" aria-label="轮次详情">
        <FileText aria-hidden="true" />
        <h2>选择一轮以查看完整内容</h2>
        <p>时间线的位置和折叠状态不会因打开详情而改变。</p>
      </section>
    )
  }

  if (!detailOpen) {
    return (
      <section className="detail-pane detail-pane--collapsed" aria-label="详情已收起">
        <div>
          <span className="eyebrow">详情已收起</span>
          <h2>{activeRound.status === 'draft' ? '当前草稿' : note || '已保存的提示词'}</h2>
          <p>{content.trim().slice(0, 120) || '这一轮还没有内容'}</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setDetailOpen(true)}>
          打开详情
        </button>
      </section>
    )
  }

  const copyRound = async () => {
    try {
      await writeClipboard(content)
      setCopied(true)
      showToast('已复制当前轮 Markdown 原文', 'success')
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      showToast('复制失败，内容仍保留在编辑器中', 'danger')
    }
  }

  const exportUnsaved = async () => {
    try {
      const name = `未保存内容-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`
      if (isTauri()) {
        const result = await api.saveTextFile(name, content)
        if (!result) return
      } else {
        const url = URL.createObjectURL(
          new Blob([content], { type: 'text/markdown;charset=utf-8' }),
        )
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = name
        anchor.click()
        URL.revokeObjectURL(url)
      }
      showToast('未保存内容已按 Markdown 原文导出', 'success')
    } catch (error) {
      showToast(
        `恢复文件导出失败：${error instanceof Error ? error.message : String(error)}`,
        'danger',
      )
    }
  }

  const statusLabel =
    saveState === 'saving'
      ? '正在保存…'
      : saveState === 'pending'
        ? '等待保存…'
        : saveState === 'failed'
          ? '内容尚未安全保存'
          : savedAt
            ? `已保存 ${formatClock(savedAt)}`
            : '已保存'

  const collapseDetail = () => {
    setDetailOpen(false)
    window.dispatchEvent(new Event('vpr:focus-selected-round'))
  }

  return (
    <section
      ref={detailRef}
      className="detail-pane"
      aria-label="轮次详情"
      aria-busy={contentTransitionLocked}
      inert={contentTransitionLocked ? true : undefined}
      tabIndex={-1}
    >
      <header className="detail-header">
        <div className="detail-header__title">
          <IconButton label="收起详情（Esc）" onClick={collapseDetail}>
            <ChevronLeft aria-hidden="true" />
          </IconButton>
          <div>
            <span className="eyebrow">
              {activeRound.status === 'draft'
                ? '正在编写'
                : `保存于 ${formatFullTime(activeRound.finalizedAt ?? activeRound.updatedAt)}`}
            </span>
            <h2>{activeRound.status === 'draft' ? '当前草稿' : note || '提示词详情'}</h2>
          </div>
        </div>
        <div className="detail-header__actions">
          <button type="button" className="secondary-button" onClick={() => void copyRound()}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? '已复制' : '复制当前轮'}
          </button>
        </div>
      </header>

      <div className="editor-meta-row">
        <input
          className="round-note-input"
          value={note}
          disabled={contentTransitionLocked}
          onChange={(event) => updateNote(event.target.value)}
          onCompositionStart={() => {
            noteComposingRef.current = true
            onCompositionChangeRef.current(true)
          }}
          onCompositionEnd={() => {
            noteComposingRef.current = false
            onCompositionChangeRef.current(false)
          }}
          placeholder="添加备注…"
          maxLength={120}
          aria-label="轮次备注"
        />
        <span
          className={`save-status save-status--${saveState}`}
          title={saveError ?? undefined}
          role={saveState === 'failed' ? 'alert' : 'status'}
          aria-live={saveState === 'failed' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          {saveState === 'failed' ? (
            <ShieldAlert aria-hidden="true" />
          ) : (
            <Save aria-hidden="true" />
          )}
          {statusLabel}
          {saveState === 'failed' ? (
            <>
              <button type="button" onClick={() => void flush()}>
                重试
              </button>
              <button
                type="button"
                onClick={() =>
                  void writeClipboard(content)
                    .then(() => showToast('未保存缓冲已复制', 'success'))
                    .catch(() => showToast('复制失败，请使用“导出恢复文件”', 'danger'))
                }
              >
                <Copy aria-hidden="true" /> 复制缓冲
              </button>
              <button type="button" onClick={() => void exportUnsaved()}>
                <Download aria-hidden="true" /> 导出恢复文件
              </button>
            </>
          ) : null}
        </span>
        <span className="character-count">
          {safety ? `${safety.characterCount.toLocaleString('zh-CN')} 字符` : '正在统计…'}
        </span>
      </div>

      <div className="editor-toolbar" role="toolbar" aria-label="Markdown 编辑工具栏">
        <div className="segmented-control" aria-label="编辑模式">
          <button
            type="button"
            className={effectiveMode === 'wysiwyg' && !readOnlyPreview ? 'is-active' : ''}
            disabled={analysisPending || safety?.mode === 'source_only'}
            title={
              analysisPending
                ? '正在分析最新 Markdown，完成前不能切换'
                : safety?.reasons.join('；') || '所见即所得模式'
            }
            onClick={() => {
              if (analysisPending) return
              if (safety?.mode === 'source_only') {
                showToast(
                  `无法进入所见即所得：${safety.reasons[0] ?? '当前内容需要源码模式'}`,
                  'warning',
                )
                return
              }
              setReadOnlyPreviewRoundId(null)
              void setMode('wysiwyg')
            }}
          >
            <AlignLeft aria-hidden="true" /> 所见即所得
          </button>
          <button
            type="button"
            className={effectiveMode === 'source' && !readOnlyPreview ? 'is-active' : ''}
            onClick={() => {
              setReadOnlyPreviewRoundId(null)
              void setMode('source')
            }}
          >
            <FileCode2 aria-hidden="true" /> Markdown 源码
          </button>
          <button
            type="button"
            className={readOnlyPreview ? 'is-active' : ''}
            onClick={() => setReadOnlyPreviewRoundId(activeRound.id)}
          >
            <FileText aria-hidden="true" /> 安全预览
          </button>
        </div>
        <div className="editor-toolbar__actions">
          {analysisPending ? (
            <span className="source-only-notice">
              <LoaderCircle className="spin" aria-hidden="true" /> 正在分析 Markdown 安全性
            </span>
          ) : safety?.mode === 'source_only' ? (
            <span className="source-only-notice" title={safety.reasons.join('；')}>
              <ShieldAlert aria-hidden="true" /> 已使用源码安全模式
            </span>
          ) : (
            <span className="toolbar-hint">
              <span>
                <kbd>Enter</kbd> 换行
              </span>
              <span>
                <kbd>Ctrl+Enter</kbd> 分段
              </span>
            </span>
          )}
          <button
            type="button"
            className="primary-button editor-next-round"
            disabled={contentTransitionLocked}
            title={
              activeRound.status === 'draft'
                ? '完成本轮并新建下一轮（单按 Ctrl）'
                : '回到当前草稿（单按 Ctrl）'
            }
            onClick={() => void finalize()}
          >
            {activeRound.status === 'draft' ? (
              <>
                <Sparkles aria-hidden="true" /> 完成并新建下一轮
              </>
            ) : (
              <>
                <ArrowLeft aria-hidden="true" /> 回到当前草稿
              </>
            )}
            <kbd>Ctrl</kbd>
          </button>
        </div>
      </div>

      <div className="editor-surface">
        {awaitingInitialSafety ? (
          <EditorLoading />
        ) : readOnlyPreview ? (
          <div className="detail-preview-scroll">
            <MarkdownPreview markdown={content} wrapCode={settings.codeWrap} />
          </div>
        ) : effectiveMode === 'source' ? (
          <Suspense fallback={<EditorLoading />}>
            <SourceEditor
              key={`${activeRound.id}-source-${editorEpoch}`}
              value={content}
              onChange={updateContent}
              onCompositionChange={onCompositionChange}
              initialSelection={{ anchor: cursorAnchor, head: cursorHead }}
              onSelectionChange={setEditorSelection}
              wrap={settings.codeWrap}
            />
          </Suspense>
        ) : (
          <Suspense fallback={<EditorLoading />}>
            <WysiwygEditor
              key={`${activeRound.id}-wysiwyg-${editorEpoch}`}
              value={content}
              onChange={updateContent}
              onCompositionChange={onCompositionChange}
              onLifecycleError={(message) => showToast(message, 'danger')}
            />
          </Suspense>
        )}
      </div>
    </section>
  )
}
