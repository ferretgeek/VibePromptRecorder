import {
  CloudOff,
  Copy,
  Menu,
  Minus,
  MoonStar,
  Palette,
  Pin,
  Plus,
  Search,
  Settings,
  Square,
  SunMedium,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import type { ThemeId } from '../types'
import { IconButton } from '../components/IconButton'
import { isTauri } from '../lib/api'

const themeOrder: ThemeId[] = ['neutral', 'warm', 'mint', 'lavender', 'graphite', 'system']

const themeNames: Record<ThemeId, string> = {
  system: '跟随系统',
  neutral: '晴空蓝白',
  warm: '珊瑚暖杏',
  mint: '湖水薄荷',
  lavender: '莓果淡紫',
  graphite: '曜石深灰',
}

type NativeWindowAction = 'minimize' | 'toggleMaximize' | 'close'

function NativeWindowControls() {
  const [maximized, setMaximized] = useState(false)
  const showToast = useAppStore((state) => state.showToast)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const windowHandle = getCurrentWindow()
        const syncMaximizedState = async () => {
          const nextMaximized = await windowHandle.isMaximized()
          if (!disposed) setMaximized(nextMaximized)
        }

        await syncMaximizedState()
        const nextUnlisten = await windowHandle.onResized(() => {
          void syncMaximizedState().catch(() => undefined)
        })
        if (disposed) nextUnlisten()
        else unlisten = nextUnlisten
      })
      .catch((error: unknown) => {
        if (!disposed) {
          showToast(
            `窗口状态监听失败：${error instanceof Error ? error.message : String(error)}`,
            'warning',
          )
        }
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [showToast])

  const runWindowAction = (action: NativeWindowAction) => {
    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const windowHandle = getCurrentWindow()
        if (action === 'minimize') {
          await windowHandle.minimize()
          return
        }
        if (action === 'close') {
          await windowHandle.close()
          return
        }

        await windowHandle.toggleMaximize()
        setMaximized(await windowHandle.isMaximized())
      })
      .catch((error: unknown) => {
        showToast(
          `窗口操作失败：${error instanceof Error ? error.message : String(error)}`,
          'danger',
        )
      })
  }

  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="window-control"
        aria-label="最小化窗口"
        title="最小化"
        onClick={() => runWindowAction('minimize')}
      >
        <Minus aria-hidden="true" />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? '还原窗口' : '最大化窗口'}
        title={maximized ? '还原' : '最大化'}
        onClick={() => runWindowAction('toggleMaximize')}
      >
        {maximized ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="window-control window-control--close"
        aria-label="关闭窗口"
        title="关闭"
        onClick={() => runWindowAction('close')}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  )
}

export function TopBar() {
  const projects = useAppStore((state) => state.projects)
  const selectedProjectId = useAppStore((state) => state.selectedProjectId)
  const settings = useAppStore((state) => state.settings)
  const saveState = useAppStore((state) => state.saveState)
  const backupWarning = useAppStore((state) => state.backupWarning)
  const createProject = useAppStore((state) => state.createProject)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const setAlwaysOnTop = useAppStore((state) => state.setAlwaysOnTop)
  const setSearchOpen = useAppStore((state) => state.setSearchOpen)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const setProjectDrawerOpen = useAppStore((state) => state.setProjectDrawerOpen)
  const showToast = useAppStore((state) => state.showToast)
  const currentProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId),
    [projects, selectedProjectId],
  )
  const nativeWindow = isTauri()

  const cycleTheme = () => {
    const current = themeOrder.indexOf(settings.theme)
    const nextTheme = themeOrder[(current + 1) % themeOrder.length] ?? 'neutral'
    void updateSettings({ theme: nextTheme })
      .then(() => {
        showToast(`已切换为${themeNames[nextTheme]}`, 'success')
      })
      .catch(() => showToast('主题切换保存失败，请重试', 'danger'))
  }

  const ThemeIcon =
    settings.theme === 'graphite' ? MoonStar : settings.theme === 'system' ? Palette : SunMedium

  return (
    <header className={`topbar${nativeWindow ? ' topbar--native' : ''}`} data-tauri-drag-region>
      <div className="topbar__left" data-tauri-drag-region>
        <IconButton
          label="打开项目列表"
          className="mobile-project-toggle"
          onClick={() => setProjectDrawerOpen(true)}
        >
          <Menu aria-hidden="true" />
        </IconButton>
        <div className="app-mark" aria-hidden="true" data-tauri-drag-region>
          <span data-tauri-drag-region>V</span>
        </div>
        <div className="topbar__project" data-tauri-drag-region>
          <span className="eyebrow" data-tauri-drag-region>
            提示词记录工具
          </span>
          <h1 data-tauri-drag-region>{currentProject?.name ?? '尚未选择项目'}</h1>
        </div>
        <span
          className={`topbar-save topbar-save--${saveState === 'saved' && backupWarning ? 'failed' : saveState}`}
          title={backupWarning ?? undefined}
          role={saveState === 'failed' || backupWarning ? 'alert' : 'status'}
          aria-live={saveState === 'failed' || backupWarning ? 'assertive' : 'polite'}
          aria-atomic="true"
          aria-label={backupWarning ?? undefined}
          data-tauri-drag-region
        >
          {saveState === 'failed'
            ? '内容尚未安全保存'
            : saveState === 'saving'
              ? '正在保存'
              : backupWarning
                ? '自动备份需处理'
                : '本地已保存'}
        </span>
      </div>
      <div className="topbar__actions">
        <span className="offline-badge" title="应用不会上传项目或提示词">
          <CloudOff aria-hidden="true" /> 离线
        </span>
        <button type="button" className="topbar-action" onClick={() => void createProject()}>
          <Plus aria-hidden="true" /> 新建项目
        </button>
        <button type="button" className="topbar-action" onClick={() => setSearchOpen(true)}>
          <Search aria-hidden="true" /> 搜索
          <kbd>Ctrl</kbd>
          <kbd>Shift</kbd>
          <kbd>F</kbd>
        </button>
        <IconButton label={`切换主题；当前为${themeNames[settings.theme]}`} onClick={cycleTheme}>
          <ThemeIcon aria-hidden="true" />
        </IconButton>
        <IconButton
          label={
            settings.alwaysOnTop ? '取消窗口始终置顶（Ctrl+Alt+T）' : '窗口始终置顶（Ctrl+Alt+T）'
          }
          active={settings.alwaysOnTop}
          onClick={() =>
            void setAlwaysOnTop(!settings.alwaysOnTop).catch(() =>
              showToast('窗口置顶切换失败，请重试', 'danger'),
            )
          }
        >
          <Pin aria-hidden="true" />
        </IconButton>
        <IconButton label="打开设置（Ctrl+,）" onClick={() => setSettingsOpen(true)}>
          <Settings aria-hidden="true" />
        </IconButton>
        {nativeWindow ? <NativeWindowControls /> : null}
      </div>
    </header>
  )
}
