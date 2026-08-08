import { AlertTriangle, Copy, Database, LoaderCircle, Plus, RefreshCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DetailPane } from '../features/editor/DetailPane'
import { ConflictDialog } from '../features/editor/ConflictDialog'
import { ProjectSidebar } from '../features/projects/ProjectSidebar'
import { SearchDialog } from '../features/search/SearchDialog'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import { Timeline } from '../features/timeline/Timeline'
import { api, writeClipboard, isTauri } from '../lib/api'
import {
  createCloseProtection,
  type CloseFailureState,
  type CloseProtectionCoordinator,
} from '../lib/closeProtection'
import { isTextEditingTarget, shortcutAction } from '../lib/shortcuts'
import { applyAppearance, loadAppearanceFonts, observeSystemTheme } from '../lib/theme'
import { useAppStore } from '../stores/appStore'
import { Dialog } from '../components/Dialog'
import { Toast } from '../components/Toast'
import { TopBar } from './TopBar'

function LoadingScreen() {
  return (
    <main className="boot-screen">
      <div className="app-mark app-mark--large">V</div>
      <LoaderCircle className="spin" aria-hidden="true" />
      <h1>正在打开本地工作区</h1>
      <p>检查数据目录、数据库和上次编辑状态…</p>
    </main>
  )
}

function RecoveryScreen({ message }: { message: string }) {
  return (
    <main className="recovery-screen">
      <div className="recovery-card">
        <span className="recovery-card__icon">
          <AlertTriangle aria-hidden="true" />
        </span>
        <span className="eyebrow">只读恢复保护</span>
        <h1>工作区未能安全打开</h1>
        <p>应用没有创建空数据库覆盖现场，也没有继续写入。请检查下面的原因。</p>
        <pre>{message}</pre>
        <div className="recovery-actions">
          <button type="button" className="primary-button" onClick={() => window.location.reload()}>
            <RefreshCcw aria-hidden="true" /> 重试启动
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void writeClipboard(message)}
          >
            复制技术详情
          </button>
        </div>
        <small>原始文件保持不变；恢复与选择新数据目录能力可从备份流程继续。</small>
      </div>
    </main>
  )
}

interface PanelResizerProps {
  target: 'project' | 'timeline'
  ariaLabel: string
}

// 拖动调整项目栏 / 时间线栏宽度；拖动中直接改写 workspace CSS 变量以保证流畅，
// 松手后持久化到设置。范围与执行文档 9.2 一致（项目 200~340 / 时间线 280~460）。
function PanelResizer({ target, ariaLabel }: PanelResizerProps) {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const showToast = useAppStore((state) => state.showToast)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const bounds = target === 'project' ? { min: 200, max: 340 } : { min: 280, max: 460 }
  const cssVar = target === 'project' ? '--project-panel-width' : '--timeline-panel-width'
  const startWidth = target === 'project' ? settings.projectPanelWidth : settings.timelinePanelWidth

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    dragCleanupRef.current?.()
    const workspace = event.currentTarget.closest<HTMLElement>('.workspace')
    if (!workspace) return
    const originX = event.clientX
    const originWidth = startWidth
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    let latest = originWidth
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.round(
        Math.min(bounds.max, Math.max(bounds.min, originWidth + (moveEvent.clientX - originX))),
      )
      latest = next
      workspace.style.setProperty(cssVar, `${next}px`)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
      dragCleanupRef.current = null
    }
    const onUp = () => {
      cleanup()
      const patch =
        target === 'project' ? { projectPanelWidth: latest } : { timelinePanelWidth: latest }
      void updateSettings(patch).catch(() => {
        workspace.style.setProperty(cssVar, `${originWidth}px`)
        showToast('面板宽度保存失败，已恢复原宽度', 'danger')
      })
    }
    const onCancel = () => {
      cleanup()
      workspace.style.setProperty(cssVar, `${originWidth}px`)
    }
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  useEffect(() => () => dragCleanupRef.current?.(), [])

  const nudge = (delta: number) => {
    const next = Math.min(bounds.max, Math.max(bounds.min, startWidth + delta))
    const patch = target === 'project' ? { projectPanelWidth: next } : { timelinePanelWidth: next }
    void updateSettings(patch).catch(() => showToast('面板宽度保存失败，请重试', 'danger'))
  }

  return (
    <button
      type="button"
      className={`panel-resizer panel-resizer--${target}`}
      aria-label={ariaLabel}
      title={ariaLabel}
      onPointerDown={beginDrag}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          nudge(-16)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          nudge(16)
        }
      }}
    />
  )
}

function NoProjectPane() {
  const createProject = useAppStore((state) => state.createProject)
  return (
    <section className="no-project-pane">
      <span className="no-project-pane__icon">
        <Database aria-hidden="true" />
      </span>
      <span className="eyebrow">本地工作区已就绪</span>
      <h2>创建一个项目，开始记录提示词</h2>
      <p>每个项目都有独立的多轮提示词和一个当前草稿。所有内容只保存在本机。</p>
      <button type="button" className="primary-button" onClick={() => void createProject()}>
        <Plus aria-hidden="true" /> 新建项目
      </button>
    </section>
  )
}

async function persistNativeWindowState(): Promise<void> {
  const { currentMonitor, getCurrentWindow } = await import('@tauri-apps/api/window')
  const windowHandle = getCurrentWindow()
  const [position, size, maximized, scaleFactor, monitor] = await Promise.all([
    windowHandle.outerPosition(),
    windowHandle.innerSize(),
    windowHandle.isMaximized(),
    windowHandle.scaleFactor(),
    currentMonitor(),
  ])
  await api.saveWindowState({
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    maximized,
    scaleFactor,
    monitorName: monitor?.name ?? null,
  })
}

export function App() {
  const initialize = useAppStore((state) => state.initialize)
  const initialized = useAppStore((state) => state.initialized)
  const loading = useAppStore((state) => state.loading)
  const fatalError = useAppStore((state) => state.fatalError)
  const settings = useAppStore((state) => state.settings)
  const fonts = useAppStore((state) => state.fonts)
  const activeRound = useAppStore((state) => state.activeRound)
  const selectedProjectId = useAppStore((state) => state.selectedProjectId)
  const editSequence = useAppStore((state) => state.editSequence)
  const persistedSequence = useAppStore((state) => state.persistedSequence)
  const dataChangeSequence = useAppStore((state) => state.dataChangeSequence)
  const contentTransitionLocked = useAppStore((state) => state.contentTransitionLocked)
  const content = useAppStore((state) => state.editorContent)
  const searchOpen = useAppStore((state) => state.searchOpen)
  const settingsOpen = useAppStore((state) => state.settingsOpen)
  const detailOpen = useAppStore((state) => state.detailOpen)
  const composingRef = useRef(false)
  const standaloneControlRef = useRef(false)
  const closeProtectionRef = useRef<CloseProtectionCoordinator | null>(null)
  const [compositionVersion, setCompositionVersion] = useState(0)
  const [closeFailure, setCloseFailure] = useState<CloseFailureState | null>(null)

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    applyAppearance(settings)
    void loadAppearanceFonts(fonts, settings).catch(() => {
      useAppStore.getState().showToast('所选用户字体加载失败，已继续使用安全回退字体', 'warning')
    })
    return observeSystemTheme(settings)
  }, [fonts, settings])

  useEffect(() => {
    if (!activeRound || contentTransitionLocked || editSequence === persistedSequence) return
    // UTF-16 单元最坏可对应 3 个 UTF-8 字节；这里只决定防抖时长，保守提前进入
    // 大文本延时即可，避免每次输入都重新编码并分配完整 UTF-8 缓冲。
    const delay = content.length > Math.floor((512 * 1024) / 3) ? 1_000 : 300
    const timeout = window.setTimeout(() => {
      if (!composingRef.current) void useAppStore.getState().flushActive()
    }, delay)
    return () => window.clearTimeout(timeout)
  }, [
    activeRound,
    compositionVersion,
    content,
    contentTransitionLocked,
    editSequence,
    persistedSequence,
  ])

  useEffect(() => {
    const flushWhenBackgrounded = () => {
      if (!composingRef.current && (document.hidden || !document.hasFocus())) {
        void useAppStore.getState().flushActive()
      }
    }
    document.addEventListener('visibilitychange', flushWhenBackgrounded)
    window.addEventListener('blur', flushWhenBackgrounded)
    return () => {
      document.removeEventListener('visibilitychange', flushWhenBackgrounded)
      window.removeEventListener('blur', flushWhenBackgrounded)
    }
  }, [])

  useEffect(() => {
    if (
      !initialized ||
      !settings.autoBackup ||
      dataChangeSequence === 0 ||
      editSequence !== persistedSequence
    )
      return
    const timeout = window.setTimeout(() => {
      void api
        .runAutoBackup()
        .then((backup) => {
          if (backup) useAppStore.setState({ backupWarning: null })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          useAppStore.setState({ backupWarning: `自动备份失败：${message}` })
        })
    }, 5_000)
    return () => window.clearTimeout(timeout)
  }, [dataChangeSequence, editSequence, initialized, persistedSequence, settings.autoBackup])

  useEffect(() => {
    const trackStandaloneControl = (event: KeyboardEvent) => {
      if (
        event.key === 'Control' &&
        !event.repeat &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        standaloneControlRef.current = true
        return
      }
      if (event.ctrlKey) {
        standaloneControlRef.current = false
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const store = useAppStore.getState()
      if (
        event.key === 'Escape' &&
        // 已被更内层组件（CodeMirror 查找面板、菜单、浮层等）处理时不再收起详情，
        // 保证 Esc 的层级顺序：先关最内层，最后才收详情。
        !event.defaultPrevented &&
        !composingRef.current &&
        !store.searchOpen &&
        !store.settingsOpen &&
        store.detailOpen
      ) {
        store.setDetailOpen(false)
        // 收起详情后把焦点还给当前选中的时间线卡片。
        window.dispatchEvent(new Event('vpr:focus-selected-round'))
        return
      }
      const action = shortcutAction(event, {
        composing: composingRef.current,
        editorFocused: isTextEditingTarget(event.target),
        blocked:
          store.searchOpen ||
          store.settingsOpen ||
          store.projectDrawerOpen ||
          Boolean(store.revisionConflict) ||
          store.contentTransitionLocked,
      })
      if (!action) return
      event.preventDefault()
      switch (action) {
        case 'new-project':
          void store.createProject()
          break
        case 'copy-round':
          if (store.activeRound) {
            void writeClipboard(store.editorContent)
              .then(() => store.showToast('已复制当前轮 Markdown 原文', 'success'))
              .catch(() => store.showToast('复制失败，请重试', 'danger'))
          }
          break
        case 'save':
          void store.flushActive().then((saved) => {
            if (saved) store.showToast('内容已安全保存', 'success')
          })
          break
        case 'global-search':
          store.setSearchOpen(true)
          break
        case 'toggle-editor': {
          if (store.editorMode !== 'source') {
            void store.setEditorMode('source')
            break
          }
          if (store.markdownSafetyPending) {
            store.showToast('正在分析最新 Markdown；完成前不能进入所见即所得模式', 'warning')
            break
          }
          if (store.markdownSafetyMode === 'source_only') {
            store.showToast(
              `无法进入所见即所得：${store.markdownSafetyReason ?? '当前内容需要源码模式'}`,
              'warning',
            )
          } else {
            void store.setEditorMode('wysiwyg')
          }
          break
        }
        case 'toggle-always-on-top':
          void store
            .setAlwaysOnTop(!store.settings.alwaysOnTop)
            .catch(() => store.showToast('窗口置顶切换失败，请重试', 'danger'))
          break
        case 'open-settings':
          store.setSettingsOpen(true)
          break
        case 'timeline-top':
          window.dispatchEvent(new Event('vpr:timeline-top'))
          break
        case 'structural-undo':
          void store.undoLast()
          break
        case 'cycle-region':
          window.dispatchEvent(new CustomEvent('vpr:cycle-region', { detail: { direction: 1 } }))
          break
        case 'cycle-region-back':
          window.dispatchEvent(new CustomEvent('vpr:cycle-region', { detail: { direction: -1 } }))
          break
      }
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Control') return
      const wasStandalone = standaloneControlRef.current
      standaloneControlRef.current = false
      if (!wasStandalone || composingRef.current) return

      const store = useAppStore.getState()
      if (
        store.searchOpen ||
        store.settingsOpen ||
        store.projectDrawerOpen ||
        store.revisionConflict ||
        store.contentTransitionLocked ||
        !store.activeRound
      ) {
        return
      }
      event.preventDefault()
      void store.finalizeActiveDraft()
    }
    const cancelStandaloneControl = () => {
      standaloneControlRef.current = false
    }
    // 文本编辑器会拦截部分纯修饰键事件；捕获阶段只跟踪 Ctrl 是否与其他键组合，
    // 不处理其他快捷键，避免改变 Esc、查找等编辑器内键盘优先级。
    document.addEventListener('keydown', trackStandaloneControl, true)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('keyup', handleKeyUp, true)
    document.addEventListener('pointerdown', cancelStandaloneControl, true)
    window.addEventListener('blur', cancelStandaloneControl)
    return () => {
      document.removeEventListener('keydown', trackStandaloneControl, true)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('keyup', handleKeyUp, true)
      document.removeEventListener('pointerdown', cancelStandaloneControl, true)
      window.removeEventListener('blur', cancelStandaloneControl)
    }
  }, [])

  useEffect(() => {
    // F6 / Shift+F6：在顶部操作栏、项目栏、时间线、详情四个主区域之间循环焦点。
    const regionSelectors = ['.topbar', '.project-sidebar', '.timeline', '.detail-pane']
    const focusRegion = (direction: number) => {
      const regions = regionSelectors
        .map((selector) => document.querySelector<HTMLElement>(selector))
        .filter((element): element is HTMLElement => Boolean(element))
      if (regions.length === 0) return
      const active = document.activeElement as HTMLElement | null
      const currentIndex = regions.findIndex((region) => region.contains(active))
      const nextIndex =
        currentIndex < 0 ? 0 : (currentIndex + direction + regions.length) % regions.length
      const target = regions[nextIndex]
      if (!target) return
      const focusable = target.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [tabindex="-1"]',
      )
      ;(focusable ?? target).focus({ preventScroll: false })
    }
    const handleCycle = (event: Event) => {
      const direction = (event as CustomEvent<{ direction: number }>).detail?.direction ?? 1
      focusRegion(direction)
    }
    window.addEventListener('vpr:cycle-region', handleCycle)
    return () => window.removeEventListener('vpr:cycle-region', handleCycle)
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        if (disposed) return
        const windowHandle = getCurrentWindow()
        const closeProtection = createCloseProtection({
          isComposing: () => composingRef.current,
          getBuffer: () => useAppStore.getState().editorContent,
          setEditingLocked: (locked) => useAppStore.setState({ contentTransitionLocked: locked }),
          flushActive: () => useAppStore.getState().flushActive(),
          persistViewState: () => useAppStore.getState().persistViewState(),
          persistWindowState: persistNativeWindowState,
          markCleanShutdown: (generation) => api.markCleanShutdown(generation),
          cancelCleanShutdown: (generation) => api.cancelCleanShutdown(generation),
          destroyWindow: () => windowHandle.destroy(),
          copyBuffer: writeClipboard,
          showFailure: setCloseFailure,
          notify: (message, tone) => useAppStore.getState().showToast(message, tone),
        })
        closeProtectionRef.current = closeProtection
        const nextUnlisten = await windowHandle.onCloseRequested((event) => {
          // 所有系统关闭请求都由同一个有界状态机接管；重复请求会复用正在执行的流程。
          event.preventDefault()
          void closeProtection.requestClose()
        })
        if (disposed) {
          closeProtection.dispose()
          nextUnlisten()
        } else {
          unlisten = nextUnlisten
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          useAppStore
            .getState()
            .showToast(
              `窗口关闭保护初始化失败：${error instanceof Error ? error.message : String(error)}`,
              'danger',
            )
        }
      })
    return () => {
      disposed = true
      closeProtectionRef.current?.dispose()
      closeProtectionRef.current = null
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let timer: number | null = null
    const unlisteners: Array<() => void> = []
    const persist = async () => {
      if (disposed) return
      await persistNativeWindowState()
    }
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void persist().catch(() => undefined)
      }, 350)
    }
    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        if (disposed) return
        const windowHandle = getCurrentWindow()
        const moved = await windowHandle.onMoved(schedule)
        if (disposed) {
          moved()
          return
        }
        unlisteners.push(moved)
        const resized = await windowHandle.onResized(schedule)
        if (disposed) resized()
        else unlisteners.push(resized)
      })
      .catch((error: unknown) => {
        if (!disposed) {
          useAppStore
            .getState()
            .showToast(
              `窗口位置记忆初始化失败：${error instanceof Error ? error.message : String(error)}`,
              'warning',
            )
        }
      })
    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      unlisteners.forEach((unlisten) => unlisten())
    }
  }, [])

  if (fatalError) return <RecoveryScreen message={fatalError} />
  if (!initialized && loading) return <LoadingScreen />

  return (
    <div className="app-shell">
      <TopBar />
      <main
        className={`workspace ${detailOpen ? 'has-detail' : 'detail-collapsed'}`}
        style={
          {
            '--project-panel-width': `${settings.projectPanelWidth}px`,
            '--timeline-panel-width': `${settings.timelinePanelWidth}px`,
          } as React.CSSProperties
        }
      >
        <ProjectSidebar />
        <PanelResizer target="project" ariaLabel="拖动调整项目栏宽度（方向键微调）" />
        <Timeline />
        <PanelResizer target="timeline" ariaLabel="拖动调整时间线宽度（方向键微调）" />
        {selectedProjectId ? (
          <DetailPane
            onCompositionChange={(composing) => {
              composingRef.current = composing
              if (!composing) setCompositionVersion((version) => version + 1)
            }}
          />
        ) : (
          <NoProjectPane />
        )}
      </main>
      <SearchDialog />
      <SettingsDialog />
      <ConflictDialog />
      <Dialog
        open={Boolean(closeFailure)}
        onClose={() => closeProtectionRef.current?.continueEditing()}
        title="内容尚未安全保存"
        description="关闭流程已停止，编辑缓冲仍保留在内存中。"
        className="close-recovery-dialog"
      >
        <div className="close-recovery-dialog__body">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>未能在安全等待时间内完成关闭</strong>
            <p>{closeFailure?.message}</p>
            <small>建议继续编辑并重试保存，或先复制当前缓冲再退出。</small>
          </div>
        </div>
        <footer className="dialog-footer close-recovery-dialog__actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => closeProtectionRef.current?.continueEditing()}
          >
            继续编辑
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void closeProtectionRef.current?.copyBufferAndExit()}
          >
            <Copy aria-hidden="true" /> 复制缓冲并退出
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={() => void closeProtectionRef.current?.exitAnyway()}
          >
            不保存，仍然退出
          </button>
        </footer>
      </Dialog>
      <Toast />
      {loading ? (
        <div className="route-loading" aria-label="正在切换项目">
          <LoaderCircle className="spin" />
        </div>
      ) : null}
      {searchOpen || settingsOpen ? <span className="sr-only">已打开模态窗口</span> : null}
    </div>
  )
}
