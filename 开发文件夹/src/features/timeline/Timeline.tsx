import { ArrowUpToLine, ChevronDown, Copy, FilePlus2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { api, writeClipboard } from '../../lib/api'
import { markdownConcatenationRisks } from '../../lib/markdown'
import { useAppStore } from '../../stores/appStore'
import { IconButton } from '../../components/IconButton'
import { RoundCard } from './RoundCard'

export function Timeline() {
  const rounds = useAppStore((state) => state.rounds)
  const selectedRoundId = useAppStore((state) => state.selectedRoundId)
  const selectedProjectId = useAppStore((state) => state.selectedProjectId)
  const timelineAnchorRoundId = useAppStore((state) => state.timelineAnchorRoundId)
  const timelineAnchorOffsetPx = useAppStore((state) => state.timelineAnchorOffsetPx)
  const settings = useAppStore((state) => state.settings)
  const selectRound = useAppStore((state) => state.selectRound)
  const showToast = useAppStore((state) => state.showToast)
  const reorderRoundTo = useAppStore((state) => state.reorderRoundTo)
  const setTimelineAnchor = useAppStore((state) => state.setTimelineAnchor)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [showTop, setShowTop] = useState(false)
  const [copyMenuOpen, setCopyMenuOpen] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(5)
  const [fontLayoutVersion, setFontLayoutVersion] = useState(0)
  const finalCount = useMemo(
    () => rounds.filter((round) => round.status === 'final').length,
    [rounds],
  )
  const selectedIndex = Math.max(
    0,
    rounds.findIndex((round) => round.id === selectedRoundId),
  )
  const initialAnchorIndex = Math.max(
    0,
    rounds.findIndex((round) => round.id === timelineAnchorRoundId),
  )

  // Windows 开启「减少动画」时用即时定位，否则用短平滑动画。
  const scrollBehavior = (): 'auto' | 'smooth' =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'

  useEffect(() => {
    const toTop = () => virtuosoRef.current?.scrollToIndex({ index: 0, behavior: scrollBehavior() })
    window.addEventListener('vpr:timeline-top', toTop)
    return () => window.removeEventListener('vpr:timeline-top', toTop)
  }, [])

  useEffect(() => {
    // react-virtuoso 会在普通 ResizeObserver 更新时自动重测；字体异步替换可能不改变
    // 容器宽度，因此用当前锚点重挂载一次，确保折叠行数和虚拟高度立即一致。
    const remeasureForFonts = () => setFontLayoutVersion((version) => version + 1)
    window.addEventListener('vpr:fonts-ready', remeasureForFonts)
    return () => window.removeEventListener('vpr:fonts-ready', remeasureForFonts)
  }, [])

  useEffect(() => {
    // 详情收起后把焦点还给当前选中的时间线卡片。
    const focusSelected = () => {
      const id = useAppStore.getState().selectedRoundId
      if (!id) return
      document.querySelector<HTMLElement>(`[data-round-id="${id}"]`)?.focus({ preventScroll: true })
    }
    window.addEventListener('vpr:focus-selected-round', focusSelected)
    return () => window.removeEventListener('vpr:focus-selected-round', focusSelected)
  }, [])

  useEffect(() => {
    if (!copyMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.split-button')) {
        setCopyMenuOpen(false)
      }
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setCopyMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [copyMenuOpen])

  const navigate = (index: number) => {
    const bounded = Math.max(0, Math.min(rounds.length - 1, index))
    const target = rounds[bounded]
    if (!target) return
    void selectRound(target.id, false).then(() => {
      if (useAppStore.getState().selectedRoundId !== target.id) return
      virtuosoRef.current?.scrollIntoView({
        index: bounded,
        behavior: scrollBehavior(),
        done: () => {
          document
            .querySelector<HTMLElement>(`[data-round-id="${target.id}"]`)
            ?.focus({ preventScroll: true })
        },
      })
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target
    if (
      target instanceof Element &&
      target !== event.currentTarget &&
      target.closest('button, input, select, textarea, a[href]')
    )
      return
    const key = event.key
    if (event.altKey && event.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault()
      const round = rounds[selectedIndex]
      if (round?.status === 'final')
        void useAppStore.getState().moveRound(round.id, key === 'ArrowUp' ? -1 : 1)
      return
    }
    const destinations: Record<string, number> = {
      ArrowUp: selectedIndex - 1,
      ArrowDown: selectedIndex + 1,
      PageUp: selectedIndex - visibleCount,
      PageDown: selectedIndex + visibleCount,
      Home: 0,
      End: rounds.length - 1,
    }
    if (key in destinations) {
      event.preventDefault()
      navigate(destinations[key] ?? selectedIndex)
    }
  }

  const handleSelect = useCallback(
    (roundId: string) => {
      void selectRound(roundId, true)
    },
    [selectRound],
  )

  const handleDrop = useCallback(
    (targetId: string) => {
      if (draggingId) void reorderRoundTo(draggingId, targetId)
      setDraggingId(null)
    },
    [draggingId, reorderRoundTo],
  )

  const copyAll = async (withLabels: boolean) => {
    if (!selectedProjectId) return
    setCopyMenuOpen(false)
    // 复制前先把当前草稿最新编辑落库，保证复制内容包含最近输入。
    if (!(await useAppStore.getState().flushActive())) {
      showToast('内容尚未安全保存，已阻止复制以免遗漏最新输入', 'warning')
      return
    }
    try {
      // 剪贴板接口最终仍需一个完整字符串，因此设置明确上限；更大的项目应走流式
      // Markdown 导出，避免同时保留所有详情对象和最终拼接结果。
      const maxClipboardCharacters = 16 * 1024 * 1024
      // charCount 是 Unicode 标量数；按每个标量最多两个 UTF-16 单元保守预检，
      // 明显超限时不再发起几十次详情 IPC。
      const estimatedUnits = rounds.reduce((total, round) => total + round.charCount * 2 + 48, 0)
      if (estimatedUnits > maxClipboardCharacters) {
        throw new Error('项目内容超过剪贴板安全上限，请使用“导出 Markdown”保存全部内容')
      }
      const chunks: string[] = []
      const boundaryRisks = new Set<string>()
      let totalCharacters = 0
      let finalNumber = 0
      const batchSize = 24
      for (let start = 0; start < rounds.length; start += batchSize) {
        const batch = rounds.slice(start, start + batchSize)
        const resolved = await Promise.all(batch.map((round) => api.getRound(round.id)))
        for (const round of resolved) {
          if (round.status === 'draft' && !round.contentMd.trim()) continue
          const content = round.contentMd.replace(/\r\n?/g, '\n')
          if (!withLabels) {
            for (const risk of markdownConcatenationRisks(content)) boundaryRisks.add(risk)
          }
          let chunk = content
          if (withLabels) {
            if (round.status === 'draft') chunk = `===== 当前草稿 =====\n${content}`
            else {
              finalNumber += 1
              chunk = `===== 第 ${finalNumber} 轮 =====\n${content}`
            }
          }
          totalCharacters += chunk.length + (chunks.length ? 2 : 0)
          if (totalCharacters > maxClipboardCharacters) {
            throw new Error('项目内容超过剪贴板安全上限，请使用“导出 Markdown”保存全部内容')
          }
          chunks.push(chunk)
        }
      }
      const content = chunks.join('\n\n')
      if (!content) {
        showToast('当前项目还没有可复制的内容', 'warning')
        return
      }
      if (
        !withLabels &&
        boundaryRisks.size > 0 &&
        !window.confirm(
          `纯原文拼接检测到跨轮 Markdown 边界风险：\n\n${[...boundaryRisks]
            .map((risk) => `• ${risk}`)
            .join(
              '\n',
            )}\n\n后续轮次粘贴到 Markdown 工具后可能被并入前一轮。应用不会改写任何原文；是否仍继续复制？`,
        )
      ) {
        showToast('已取消纯原文复制；可改用“带轮次标签”或先闭合 Markdown 块', 'warning')
        return
      }
      await writeClipboard(content)
      showToast(withLabels ? '已复制全部轮次（带标签）' : '已复制全部轮次（纯原文）', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '复制全部失败，请重试', 'danger')
    }
  }

  if (!selectedProjectId) {
    return (
      <section className="timeline timeline--empty" aria-label="轮次时间线">
        <FilePlus2 aria-hidden="true" />
        <h2>还没有项目</h2>
        <p>新建项目后即可开始记录提示词。</p>
      </section>
    )
  }

  return (
    <section className="timeline" aria-label="轮次时间线">
      <header className="timeline-header">
        <div>
          <span className="eyebrow">轮次时间线</span>
          <h2>
            {rounds[selectedIndex]?.status === 'draft'
              ? `当前：+ 草稿 / 共 ${finalCount} 轮`
              : `当前：第 ${selectedIndex + 1} 轮 / 共 ${finalCount} 轮`}
          </h2>
        </div>
        <div className="split-button">
          <button type="button" onClick={() => void copyAll(true)}>
            <Copy aria-hidden="true" /> 复制全部
          </button>
          <IconButton
            label="选择复制全部格式"
            aria-expanded={copyMenuOpen}
            onClick={() => setCopyMenuOpen((open) => !open)}
          >
            <ChevronDown aria-hidden="true" />
          </IconButton>
          {copyMenuOpen ? (
            <div className="popover-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void copyAll(true)}>
                带轮次标签（推荐）
                <small>保留清晰轮次边界</small>
              </button>
              <button type="button" role="menuitem" onClick={() => void copyAll(false)}>
                纯原文拼接
                <small>轮次之间保留两个换行</small>
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div
        className="timeline-list"
        role="listbox"
        aria-label="轮次列表"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <Virtuoso
          key={`${selectedProjectId}:${fontLayoutVersion}`}
          ref={virtuosoRef}
          data={rounds}
          initialTopMostItemIndex={{ index: initialAnchorIndex, offset: timelineAnchorOffsetPx }}
          computeItemKey={(_index, round) => round.id}
          overscan={320}
          rangeChanged={(range) => {
            setShowTop(range.startIndex > 6)
            setVisibleCount(Math.max(1, range.endIndex - range.startIndex + 1))
            const anchor = rounds[range.startIndex]
            window.requestAnimationFrame(() => {
              if (useAppStore.getState().selectedProjectId !== selectedProjectId) return
              const list = document.querySelector<HTMLElement>('.timeline-list')
              const card = anchor
                ? document.querySelector<HTMLElement>(`[data-round-id="${anchor.id}"]`)
                : null
              const offset =
                list && card
                  ? card.getBoundingClientRect().top - list.getBoundingClientRect().top
                  : 0
              setTimelineAnchor(anchor?.id ?? null, offset)
            })
          }}
          itemContent={(index, round) => (
            <RoundCard
              round={round}
              index={index}
              finalCount={finalCount}
              selected={round.id === selectedRoundId}
              previewLines={settings.previewLines}
              showNumber={settings.showRoundNumbers}
              onSelect={handleSelect}
              onDragStart={setDraggingId}
              onDrop={handleDrop}
            />
          )}
        />
        {showTop ? (
          <button
            type="button"
            className="back-to-top"
            onClick={() =>
              virtuosoRef.current?.scrollToIndex({ index: 0, behavior: scrollBehavior() })
            }
          >
            <ArrowUpToLine aria-hidden="true" /> 回到顶部
          </button>
        ) : null}
      </div>
    </section>
  )
}
