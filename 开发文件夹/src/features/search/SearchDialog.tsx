import { ArrowRight, FileCode2, FileText, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { caseInsensitiveUtf16Range } from '../../lib/markdown'
import { formatTime } from '../../lib/time'
import { useAppStore } from '../../stores/appStore'
import type { SearchResult } from '../../types'
import { Dialog } from '../../components/Dialog'

function HighlightedExcerpt({ excerpt, query }: { excerpt: string; query: string }) {
  const range = caseInsensitiveUtf16Range(excerpt, query)
  if (!range) return <>{excerpt}</>
  return (
    <>
      {excerpt.slice(0, range.start)}
      <mark>{excerpt.slice(range.start, range.end)}</mark>
      {excerpt.slice(range.end)}
    </>
  )
}

interface SearchOrigin {
  projectId: string | null
  roundId: string | null
  editorMode: 'wysiwyg' | 'source'
  cursorAnchor: number
  cursorHead: number
  detailOpen: boolean
}

export function SearchDialog() {
  const open = useAppStore((state) => state.searchOpen)
  const setOpen = useAppStore((state) => state.setSearchOpen)
  const flush = useAppStore((state) => state.flushActive)
  const loadProject = useAppStore((state) => state.loadProject)
  const selectRound = useAppStore((state) => state.selectRound)
  const showToast = useAppStore((state) => state.showToast)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [navigating, setNavigating] = useState(false)
  const requestId = useRef(0)
  // 打开搜索前的导航原点；「清空并返回 / Esc」在未提交跳转时完整恢复。
  const originRef = useRef<SearchOrigin | null>(null)
  const committedRef = useRef(false)

  useEffect(() => {
    if (!open) return
    // 记录本次搜索会话的原点；搜索前会先安全落库，避免数据库索引落后于编辑缓冲。
    const state = useAppStore.getState()
    originRef.current = {
      projectId: state.selectedProjectId,
      roundId: state.selectedRoundId,
      editorMode: state.editorMode,
      cursorAnchor: state.cursorAnchor,
      cursorHead: state.cursorHead,
      detailOpen: state.detailOpen,
    }
    committedRef.current = false
  }, [open])

  useEffect(() => {
    if (!open || !query.trim()) return
    requestId.current += 1
    const currentRequest = requestId.current
    const timeout = window.setTimeout(
      () => {
        // 先把当前缓冲落库以合入索引。保存失败时明确暂停搜索，避免用旧数据库结果
        // 误导用户“刚输入的内容不存在”。
        void (async () => {
          const saved = await flush().catch(() => false)
          if (requestId.current !== currentRequest) return
          if (!saved) {
            setLoading(false)
            setSearchError('当前内容尚未安全保存；请重试保存后再搜索')
            return
          }
          const next = await api.searchAll(query, 100, 0)
          if (requestId.current !== currentRequest) return
          setResults(next)
          setSelectedIndex(0)
          setSearchError(null)
          setLoading(false)
        })().catch((error: unknown) => {
          if (requestId.current === currentRequest) {
            const message = error instanceof Error ? error.message : String(error)
            setSearchError(message || '搜索失败，请重试')
            setLoading(false)
            showToast(message || '搜索失败，请重试', 'danger')
          }
        })
      },
      [...query.trim()].length < 3 ? 500 : 120,
    )
    return () => window.clearTimeout(timeout)
  }, [flush, open, query, showToast])

  const restoreOrigin = async () => {
    const origin = originRef.current
    if (!origin || !origin.projectId) return
    const state = useAppStore.getState()
    if (state.selectedProjectId !== origin.projectId || state.selectedRoundId !== origin.roundId) {
      await loadProject(origin.projectId)
      if (origin.roundId) await selectRound(origin.roundId, origin.detailOpen)
    }
    const restored = useAppStore.getState()
    const editorChanged =
      restored.editorMode !== origin.editorMode ||
      restored.cursorAnchor !== origin.cursorAnchor ||
      restored.cursorHead !== origin.cursorHead
    // 未离开原轮次、模式和选区时只关闭对话框，保留编辑器实例及撤销历史。
    useAppStore.setState({
      editorMode: origin.editorMode,
      cursorAnchor: origin.cursorAnchor,
      cursorHead: origin.cursorHead,
      detailOpen: origin.detailOpen,
      ...(editorChanged ? { editorEpoch: restored.editorEpoch + 1 } : {}),
    })
  }

  const clearSearchState = () => {
    requestId.current += 1
    setQuery('')
    setResults([])
    setLoading(false)
    setSearchError(null)
    setSelectedIndex(0)
  }

  const close = () => {
    if (navigating) return
    setNavigating(true)
    void (async () => {
      try {
        if (!committedRef.current) await restoreOrigin()
        clearSearchState()
        setOpen(false)
      } catch (error) {
        showToast(
          `返回搜索前位置失败：${error instanceof Error ? error.message : String(error)}`,
          'danger',
        )
      } finally {
        setNavigating(false)
      }
    })()
  }

  const finishCommittedNavigation = () => {
    committedRef.current = true
    clearSearchState()
    setOpen(false)
  }

  const openResult = async (result: SearchResult) => {
    if (navigating) return
    const openingQuery = query.trim()
    setNavigating(true)
    try {
      await loadProject(result.projectId)
      if (useAppStore.getState().selectedProjectId !== result.projectId) {
        showToast('该结果所在项目已不可用，已跳过', 'warning')
        return
      }
      await selectRound(result.roundId, true)
      if (useAppStore.getState().selectedRoundId !== result.roundId) {
        showToast('该轮次已被删除或移动，已跳过', 'warning')
        return
      }
      let openedContentRange: { start: number; end: number } | null = null
      if (result.matchField === 'content') {
        // 后端结果只携带有界摘要；打开轮次后必须用当前完整正文和本次 query 重算，
        // 不能沿用摘要坐标或搜索期间可能已经过期的全文坐标。
        openedContentRange = caseInsensitiveUtf16Range(
          useAppStore.getState().editorContent,
          openingQuery,
        )
        useAppStore.setState({
          editorMode: 'source',
          cursorAnchor: openedContentRange?.start ?? 0,
          cursorHead: openedContentRange?.end ?? 0,
          editorEpoch: useAppStore.getState().editorEpoch + 1,
        })
      }
      finishCommittedNavigation()
      showToast(
        result.matchField === 'content'
          ? openedContentRange
            ? '已定位到搜索结果，并使用源码模式选中命中文本'
            : '正文已发生变化；已打开对应轮次，但当前正文中未再找到关键词'
          : result.matchField === 'note'
            ? '已定位到备注命中的轮次'
            : '已定位到项目名称命中的轮次',
        'success',
      )
    } catch (error) {
      showToast(
        `打开搜索结果失败：${error instanceof Error ? error.message : String(error)}`,
        'danger',
      )
    } finally {
      setNavigating(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="搜索全部项目"
      description="项目名称、轮次备注、草稿与代码块都会参与搜索。"
      className="search-dialog"
      wide
    >
      <div className="search-input-wrap">
        <Search aria-hidden="true" />
        <input
          data-dialog-autofocus
          type="search"
          disabled={navigating}
          value={query}
          placeholder="输入中文、英文、代码或备注…"
          aria-label="全文搜索"
          onChange={(event) => {
            const nextQuery = event.target.value
            requestId.current += 1
            setQuery(nextQuery)
            setResults([])
            setSelectedIndex(0)
            setSearchError(null)
            setLoading(Boolean(nextQuery.trim()))
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setSelectedIndex((index) => Math.min(results.length - 1, index + 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSelectedIndex((index) => Math.max(0, index - 1))
            } else if (event.key === 'Enter') {
              const result = results[selectedIndex]
              if (result) void openResult(result)
            }
          }}
        />
        {query ? (
          <button
            type="button"
            aria-label="清空搜索"
            onClick={() => {
              requestId.current += 1
              setQuery('')
              setResults([])
              setLoading(false)
              setSearchError(null)
            }}
          >
            <X aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="search-status" role="status">
        {searchError
          ? searchError
          : loading
            ? '正在搜索…'
            : query.trim()
              ? `找到 ${results.length} 条结果${results.length === 100 ? '（可继续细化关键词）' : ''}`
              : '输入关键词即可实时搜索'}
      </div>
      <div className="search-results" role="listbox" aria-label="搜索结果">
        {!query.trim() ? (
          <div className="search-empty">
            <Search aria-hidden="true" />
            <h3>在所有提示词中查找</h3>
            <p>支持中文连续子串、英文忽略大小写，并包含代码内容。</p>
          </div>
        ) : !loading && results.length === 0 ? (
          <div className="search-empty">
            <FileText aria-hidden="true" />
            <h3>没有找到“{query}”</h3>
            <p>可以换一个更短的关键词，或检查当前内容是否已保存。</p>
          </div>
        ) : (
          results.map((result, index) => (
            <button
              key={result.roundId}
              type="button"
              disabled={navigating}
              role="option"
              aria-selected={index === selectedIndex}
              className={`search-result ${index === selectedIndex ? 'is-selected' : ''}`}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => void openResult(result)}
            >
              <span className="search-result__icon">
                {result.status === 'draft' ? (
                  <FileCode2 aria-hidden="true" />
                ) : (
                  <FileText aria-hidden="true" />
                )}
              </span>
              <span className="search-result__content">
                <span className="search-result__title">
                  <strong>{result.projectName}</strong>
                  <span>
                    {result.status === 'draft' ? '当前草稿' : `第 ${result.position + 1} 轮`}
                    {result.note ? ` · ${result.note}` : ''}
                  </span>
                </span>
                <span className="search-result__excerpt">
                  <HighlightedExcerpt excerpt={result.excerpt} query={query.trim()} />
                </span>
                <time>{formatTime(result.updatedAt)}</time>
              </span>
              <ArrowRight aria-hidden="true" />
            </button>
          ))
        )}
      </div>
      <footer className="dialog-footer search-dialog__footer">
        <span>↑↓ 选择 · Enter 打开 · Esc 返回原位置</span>
        <button type="button" className="secondary-button" disabled={navigating} onClick={close}>
          {navigating ? '正在切换…' : '清空并返回'}
        </button>
      </footer>
    </Dialog>
  )
}
