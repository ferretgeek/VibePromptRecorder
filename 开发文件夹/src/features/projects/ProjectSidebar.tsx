import {
  ChevronLeft,
  Download,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { formatRelativeTime } from '../../lib/time'
import { useAppStore } from '../../stores/appStore'
import type { ProjectSummary } from '../../types'
import { IconButton } from '../../components/IconButton'

interface ProjectItemProps {
  project: ProjectSummary
  selected: boolean
}

function ProjectItem({ project, selected }: ProjectItemProps) {
  const loadProject = useAppStore((state) => state.loadProject)
  const renameProject = useAppStore((state) => state.renameProject)
  const togglePin = useAppStore((state) => state.toggleProjectPin)
  const deleteProject = useAppStore((state) => state.deleteProject)
  const showToast = useAppStore((state) => state.showToast)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(project.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRef = useRef<HTMLDivElement>(null)
  const cancelRenameRef = useRef(false)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  useEffect(() => {
    if (!menuOpen) return
    const item = itemRef.current
    window.requestAnimationFrame(() =>
      item?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(),
    )
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !item?.contains(event.target)) setMenuOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMenuOpen(false)
      window.requestAnimationFrame(() =>
        item?.querySelector<HTMLElement>('.project-item__menu-button')?.focus(),
      )
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menuOpen])

  const commitRename = () => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false
      return
    }
    setRenaming(false)
    if (name.trim() === project.name) return
    void renameProject(project.id, name)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'F2') {
      event.preventDefault()
      setName(project.name)
      setRenaming(true)
    }
  }

  return (
    <div
      ref={itemRef}
      className={`project-item ${selected ? 'is-selected' : ''}`}
      onKeyDown={handleKeyDown}
    >
      {renaming ? (
        <div className="project-item__rename">
          <input
            ref={inputRef}
            value={name}
            maxLength={120}
            aria-label="项目名称"
            onFocus={() => {
              cancelRenameRef.current = false
            }}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelRenameRef.current = true
                setName(project.name)
                setRenaming(false)
              }
            }}
            onBlur={commitRename}
          />
        </div>
      ) : (
        <button
          type="button"
          className="project-item__main"
          aria-current={selected ? 'page' : undefined}
          title={project.name}
          onClick={() => void loadProject(project.id)}
        >
          <span className="project-item__name">
            {project.isPinned ? <Pin aria-label="已固定" /> : null}
            <strong>{project.name}</strong>
          </span>
          <span className="project-item__meta">
            {project.roundCount} 轮{project.hasDraft ? ' · 有草稿' : ''} ·{' '}
            {formatRelativeTime(project.updatedAt)}
          </span>
        </button>
      )}
      <IconButton
        label={`打开“${project.name}”菜单`}
        className="project-item__menu-button"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <MoreHorizontal aria-hidden="true" />
      </IconButton>
      {menuOpen ? (
        <div className="popover-menu project-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              setName(project.name)
              setRenaming(true)
            }}
          >
            重命名 <kbd>F2</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              void togglePin(project.id)
            }}
          >
            {project.isPinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
            {project.isPinned ? '取消固定在顶部' : '固定在顶部'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              void (async () => {
                await loadProject(project.id)
                if (useAppStore.getState().selectedProjectId !== project.id) {
                  showToast('项目未能安全切换，已取消打开导出入口', 'warning')
                  return
                }
                showToast('项目导出入口已打开，请在“设置 → 数据”中选择导出格式', 'neutral')
                useAppStore.getState().setSettingsOpen(true)
              })()
            }}
          >
            <Download aria-hidden="true" /> 导出项目
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger-menu-item"
            onClick={() => {
              setMenuOpen(false)
              void deleteProject(project.id)
            }}
          >
            <Trash2 aria-hidden="true" /> 移入最近删除
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function ProjectSidebar() {
  const projects = useAppStore((state) => state.projects)
  const selectedProjectId = useAppStore((state) => state.selectedProjectId)
  const drawerOpen = useAppStore((state) => state.projectDrawerOpen)
  const createProject = useAppStore((state) => state.createProject)
  const setDrawerOpen = useAppStore((state) => state.setProjectDrawerOpen)
  const sidebarRef = useRef<HTMLElement>(null)
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia('(max-width: 879px)').matches)
  const pinned = projects.filter((project) => project.isPinned)
  const recent = projects.filter((project) => !project.isPinned)

  useEffect(() => {
    const query = window.matchMedia('(max-width: 879px)')
    const update = () => setIsNarrow(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!drawerOpen || !isNarrow) return
    const sidebar = sidebarRef.current
    if (!sidebar) return
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const background = ['.topbar', '.timeline', '.detail-pane']
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .filter((element): element is HTMLElement => Boolean(element))
    const priorInert = background.map((element) => element.inert)
    background.forEach((element) => {
      element.inert = true
    })
    const animationFrame = window.requestAnimationFrame(() =>
      sidebar.querySelector<HTMLElement>('.project-sidebar__close')?.focus(),
    )
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDrawerOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [
        ...sidebar.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.getClientRects().length > 0)
      if (focusable.length === 0) {
        event.preventDefault()
        sidebar.focus()
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      document.removeEventListener('keydown', onKeyDown, true)
      background.forEach((element, index) => {
        element.inert = priorInert[index] ?? false
      })
      previouslyFocused?.focus()
    }
  }, [drawerOpen, isNarrow, setDrawerOpen])

  return (
    <>
      <div
        className={`project-drawer-scrim ${drawerOpen ? 'is-visible' : ''}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <aside
        ref={sidebarRef}
        className={`project-sidebar ${drawerOpen ? 'is-open' : ''}`}
        aria-label="项目导航"
        aria-hidden={isNarrow && !drawerOpen ? true : undefined}
        aria-modal={isNarrow && drawerOpen ? true : undefined}
        inert={isNarrow && !drawerOpen}
        role={isNarrow && drawerOpen ? 'dialog' : undefined}
        tabIndex={isNarrow && drawerOpen ? -1 : undefined}
      >
        <header className="project-sidebar__header">
          <div>
            <span className="eyebrow">本地工作区</span>
            <h2>我的项目</h2>
          </div>
          <IconButton
            label="收起项目栏"
            className="project-sidebar__close"
            onClick={() => setDrawerOpen(false)}
          >
            <PanelLeftClose aria-hidden="true" />
          </IconButton>
        </header>
        <button
          type="button"
          className="new-project-button"
          data-testid="new-project"
          onClick={() => void createProject()}
        >
          <Plus aria-hidden="true" />
          <span>
            <strong>新建项目</strong>
            <small>Ctrl+N</small>
          </span>
        </button>

        <nav className="project-list" aria-label="项目列表">
          {projects.length === 0 ? (
            <div className="project-empty">
              <ChevronLeft aria-hidden="true" />
              <strong>项目列表为空</strong>
              <p>数据只保存在本机。新建一个项目即可继续。</p>
            </div>
          ) : null}
          {pinned.length ? (
            <section className="project-group" aria-labelledby="pinned-projects">
              <h3 id="pinned-projects">固定在顶部</h3>
              {pinned.map((project) => (
                <ProjectItem
                  key={project.id}
                  project={project}
                  selected={project.id === selectedProjectId}
                />
              ))}
            </section>
          ) : null}
          {recent.length ? (
            <section className="project-group" aria-labelledby="recent-projects">
              <h3 id="recent-projects">最近使用</h3>
              {recent.map((project) => (
                <ProjectItem
                  key={project.id}
                  project={project}
                  selected={project.id === selectedProjectId}
                />
              ))}
            </section>
          ) : null}
        </nav>
        <footer className="project-sidebar__footer">
          <span className="privacy-dot" aria-hidden="true" />
          <span>
            <strong>仅保存在这台设备</strong>
            <small>无账号 · 无云同步 · 无遥测</small>
          </span>
        </footer>
      </aside>
    </>
  )
}
