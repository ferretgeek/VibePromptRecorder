import {
  Archive,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Database,
  Download,
  Eye,
  FileArchive,
  Type,
  Info,
  Keyboard,
  Monitor,
  Palette,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isTauri } from '../../lib/api'
import { buildMarkdownExport, sanitizeWindowsFileName } from '../../lib/export'
import { applyAppearance } from '../../lib/theme'
import { formatFullTime } from '../../lib/time'
import { useAppStore } from '../../stores/appStore'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type FontFaceInfo,
  type RestorePreparation,
  type ThemeId,
  type TrashItem,
} from '../../types'
import { Dialog } from '../../components/Dialog'
import { IconButton } from '../../components/IconButton'
import { MarkdownPreview } from '../../components/MarkdownPreview'

type SettingsTab = 'appearance' | 'browsing' | 'data' | 'shortcuts' | 'about'
type FontRole = 'ui' | 'body' | 'code'

const FONT_ROLE_CONFIG = {
  ui: {
    title: '界面字体',
    description: '项目列表、时间线、按钮、菜单和状态文字',
    familyKey: 'uiFontFamily',
    sizeKey: 'uiFontSize',
    weightKey: 'uiFontWeight',
    min: 12,
    max: 22,
  },
  body: {
    title: '正文字体',
    description: 'Markdown 编辑、预览与折叠卡片中的非代码内容',
    familyKey: 'bodyFontFamily',
    sizeKey: 'bodyFontSize',
    weightKey: 'bodyFontWeight',
    min: 12,
    max: 32,
  },
  code: {
    title: '代码字体',
    description: '行内代码、围栏代码块和语言标识',
    familyKey: 'codeFontFamily',
    sizeKey: 'codeFontSize',
    weightKey: 'codeFontWeight',
    min: 11,
    max: 28,
  },
} as const

const themes: Array<{
  id: ThemeId
  name: string
  description: string
  colors: [string, string, string]
}> = [
  {
    id: 'neutral',
    name: '晴空蓝白',
    description: '默认 · 明亮蓝白与清晰层级',
    colors: ['#f7fbff', '#2563eb', '#38bdf8'],
  },
  {
    id: 'warm',
    name: '珊瑚暖杏',
    description: '杏色底搭配珊瑚与琥珀',
    colors: ['#fff9f2', '#e4572e', '#f59e0b'],
  },
  {
    id: 'mint',
    name: '湖水薄荷',
    description: '薄荷底搭配湖水青与青柠',
    colors: ['#f4fffb', '#0f8a72', '#84cc16'],
  },
  {
    id: 'lavender',
    name: '莓果淡紫',
    description: '淡紫底搭配莓果与蓝紫',
    colors: ['#fbf8ff', '#7157d9', '#d946ef'],
  },
  {
    id: 'graphite',
    name: '曜石深灰',
    description: '近黑深灰搭配冷蓝高光',
    colors: ['#111419', '#5b9cf6', '#22d3ee'],
  },
  {
    id: 'system',
    name: '跟随系统',
    description: '浅色蓝白，深色自动曜石',
    colors: ['#f7fbff', '#2563eb', '#111419'],
  },
]

const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Palette }> = [
  { id: 'appearance', label: '外观与字体', icon: Palette },
  { id: 'browsing', label: '浏览与编辑', icon: Eye },
  { id: 'data', label: '数据与备份', icon: Database },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'about', label: '关于与许可', icon: Info },
]

const previewMarkdown = `# 字体实时预览

中文阅读与 English typography 0123456789，。！？“”《》😀

## Markdown 层级

这是**粗体文字**、*斜体文字*、[安全链接](https://example.com) 和 \`行内代码\`。

> 好的字体设置，应让标题、正文、辅助信息和代码一眼可分。

- 无序列表与中文标点
- [x] 已完成任务
- [ ] 等待处理的任务

| 项目 | 状态 |
| --- | --- |
| 自动保存 | 已开启 |
| 本地存储 | 安全可用 |

\`\`\`typescript
const greeting: string = '你好，Vibe Coding!'
console.log(greeting)
\`\`\`
`

const shortcutRows = [
  ['新建项目', 'Ctrl + N'],
  ['完成本轮并新建下一轮', '单按 Ctrl'],
  ['正文内换行', 'Enter'],
  ['正文分段', 'Ctrl + Enter'],
  ['复制当前整轮 Markdown', 'Ctrl + Shift + C'],
  ['立即保存', 'Ctrl + S'],
  ['全局搜索', 'Ctrl + Shift + F'],
  ['当前编辑器查找', 'Ctrl + F'],
  ['切换所见即所得 / 源码', 'Ctrl + E'],
  ['窗口始终置顶', 'Ctrl + Alt + T'],
  ['打开设置', 'Ctrl + ,'],
  ['重命名当前项目', 'F2'],
  ['循环主要区域焦点', 'F6 / Shift + F6'],
  ['时间线回到顶部', 'Alt + Home'],
  ['移动正式轮次', 'Alt + Shift + ↑ / ↓'],
  ['关闭当前弹窗或菜单', 'Esc'],
]

interface FontControlProps {
  role: FontRole
  draft: AppSettings
  fonts: FontFaceInfo[]
  update: (patch: Partial<AppSettings>) => void
}

function FontControl({ role, draft, fonts, update }: FontControlProps) {
  const [query, setQuery] = useState('')
  const config = FONT_ROLE_CONFIG[role]
  const family = draft[config.familyKey]
  const size = draft[config.sizeKey]
  const weight = draft[config.weightKey]
  const selectedFont = fonts.find((font) => font.family === family)
  const fontPriority = (font: FontFaceInfo) => {
    const sourcePriority =
      font.source === 'builtin'
        ? 0
        : draft.favoriteFontIds.includes(font.id)
          ? 1
          : draft.recentFontIds.includes(font.id)
            ? 2
            : font.source === 'imported'
              ? 3
              : 4
    return sourcePriority * 10 + (role === 'code' && !font.isMonospace ? 1 : 0)
  }
  const orderedChoices = fonts
    .filter((font) => font.available || font.family === family)
    .sort(
      (left, right) =>
        fontPriority(left) - fontPriority(right) ||
        left.family.localeCompare(right.family, 'zh-CN'),
    )
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
  const filteredChoices = normalizedQuery
    ? orderedChoices.filter((font) =>
        font.family.toLocaleLowerCase('zh-CN').includes(normalizedQuery),
      )
    : orderedChoices
  const choices =
    selectedFont && !filteredChoices.some((font) => font.id === selectedFont.id)
      ? [selectedFont, ...filteredChoices]
      : filteredChoices
  const favorite = selectedFont ? draft.favoriteFontIds.includes(selectedFont.id) : false

  return (
    <section className="font-control settings-card">
      <div className="settings-card__heading">
        <span className="settings-card__icon">
          <Type aria-hidden="true" />
        </span>
        <div>
          <h3>{config.title}</h3>
          <p>{config.description}</p>
        </div>
      </div>
      <div className="font-control__tools">
        <label className="font-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="搜索字体名称"
            aria-label={`搜索${config.title}`}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={favorite ? 'secondary-button is-active' : 'secondary-button'}
          disabled={!selectedFont}
          aria-pressed={favorite}
          onClick={() => {
            if (!selectedFont) return
            update({
              favoriteFontIds: favorite
                ? draft.favoriteFontIds.filter((id) => id !== selectedFont.id)
                : [selectedFont.id, ...draft.favoriteFontIds].slice(0, 64),
            })
          }}
        >
          <Star aria-hidden="true" /> {favorite ? '已收藏' : '收藏'}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            update({
              [config.familyKey]: DEFAULT_SETTINGS[config.familyKey],
              [config.sizeKey]: DEFAULT_SETTINGS[config.sizeKey],
              [config.weightKey]: DEFAULT_SETTINGS[config.weightKey],
              ...(role === 'body'
                ? {
                    bodyLineHeight: DEFAULT_SETTINGS.bodyLineHeight,
                    bodyFallbackFamilies: DEFAULT_SETTINGS.bodyFallbackFamilies,
                  }
                : role === 'code'
                  ? {
                      codeLineHeight: DEFAULT_SETTINGS.codeLineHeight,
                      codeFallbackFamilies: DEFAULT_SETTINGS.codeFallbackFamilies,
                    }
                  : { uiFallbackFamilies: DEFAULT_SETTINGS.uiFallbackFamilies }),
            })
          }
        >
          <RotateCcw aria-hidden="true" /> 恢复当前分类默认值
        </button>
      </div>
      <div className="font-control__grid">
        <label>
          <span>字体家族</span>
          <span className="select-wrap">
            <select
              value={family}
              onChange={(event) => {
                const nextFamily = event.target.value
                const font = fonts.find((item) => item.family === nextFamily)
                update({
                  [config.familyKey]: nextFamily,
                  ...(font
                    ? {
                        recentFontIds: [
                          font.id,
                          ...draft.recentFontIds.filter((id) => id !== font.id),
                        ].slice(0, 12),
                      }
                    : {}),
                })
              }}
            >
              {choices.map((font) => (
                <option
                  key={font.id}
                  value={font.family}
                  style={{ fontFamily: `"${font.family.replaceAll('"', '\\"')}"` }}
                >
                  {font.family} ·{' '}
                  {font.source === 'builtin'
                    ? '内置'
                    : font.source === 'system'
                      ? '系统'
                      : '用户导入'}
                  {font.isMonospace ? ' · 等宽' : ''}
                  {!font.available ? ' · 暂不可用' : ''}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" />
          </span>
        </label>
        <label>
          <span>字号</span>
          <span className="number-stepper">
            <button
              type="button"
              aria-label={`${config.title}字号减小`}
              onClick={() => update({ [config.sizeKey]: Math.max(config.min, size - 1) })}
            >
              −
            </button>
            <input
              type="number"
              min={config.min}
              max={config.max}
              value={size}
              onChange={(event) =>
                update({
                  [config.sizeKey]: Math.max(
                    config.min,
                    Math.min(config.max, Number(event.target.value)),
                  ),
                })
              }
            />
            <button
              type="button"
              aria-label={`${config.title}字号增大`}
              onClick={() => update({ [config.sizeKey]: Math.min(config.max, size + 1) })}
            >
              ＋
            </button>
          </span>
        </label>
        <label>
          <span>基础粗细</span>
          <span className="select-wrap">
            <select
              value={weight}
              onChange={(event) => update({ [config.weightKey]: Number(event.target.value) })}
            >
              {(selectedFont?.weights ?? [400]).map((fontWeight) => (
                <option key={fontWeight} value={fontWeight}>
                  {fontWeight === 400
                    ? '常规'
                    : fontWeight === 500
                      ? '中等'
                      : fontWeight === 600
                        ? '半粗'
                        : '粗体'}{' '}
                  · {fontWeight}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" />
          </span>
        </label>
      </div>
      <input
        className="range-input"
        aria-label={`${config.title}字号滑杆`}
        type="range"
        min={config.min}
        max={config.max}
        value={size}
        onChange={(event) => update({ [config.sizeKey]: Number(event.target.value) })}
      />
    </section>
  )
}

function FallbackOrder({
  title,
  values,
  fonts,
  monospaceFirst = false,
  onChange,
}: {
  title: string
  values: string[]
  fonts: FontFaceInfo[]
  monospaceFirst?: boolean
  onChange: (values: string[]) => void
}) {
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= values.length) return
    const next = [...values]
    const [item] = next.splice(index, 1)
    if (!item) return
    next.splice(target, 0, item)
    onChange(next)
  }
  const available = [...fonts]
    .filter((font) => font.available && !values.includes(font.family))
    .sort(
      (left, right) =>
        (monospaceFirst ? Number(right.isMonospace) - Number(left.isMonospace) : 0) ||
        left.family.localeCompare(right.family, 'zh-CN'),
    )

  return (
    <section className="fallback-order settings-card">
      <div>
        <strong>{title}</strong>
        <small>从上到下依次尝试；末尾系统通用兜底始终保留。</small>
      </div>
      <ol>
        {values.map((family, index) => (
          <li key={family}>
            <span style={{ fontFamily: `"${family.replaceAll('"', '\\"')}"` }}>{family}</span>
            <IconButton
              label={`上移备用字体 ${family}`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUp aria-hidden="true" />
            </IconButton>
            <IconButton
              label={`下移备用字体 ${family}`}
              disabled={index === values.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown aria-hidden="true" />
            </IconButton>
            <IconButton
              label={`移除备用字体 ${family}`}
              onClick={() => onChange(values.filter((value) => value !== family))}
            >
              <Trash2 aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ol>
      <span className="select-wrap">
        <select
          value=""
          aria-label={`添加${title}`}
          onChange={(event) => {
            if (event.target.value) onChange([...values, event.target.value])
          }}
        >
          <option value="">添加备用字体…</option>
          {available.map((font) => (
            <option key={font.id} value={font.family}>
              {font.family} ·{' '}
              {font.source === 'builtin' ? '内置' : font.source === 'system' ? '系统' : '用户导入'}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" />
      </span>
    </section>
  )
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="toggle-row settings-card">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch" aria-hidden="true">
        <span />
      </span>
    </label>
  )
}

function changedSettings(from: AppSettings, to: AppSettings): Partial<AppSettings> {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
    const before = from[key]
    const after = to[key]
    const equal =
      Array.isArray(before) && Array.isArray(after)
        ? before.length === after.length && before.every((value, index) => value === after[index])
        : Object.is(before, after)
    if (!equal) patch[key] = after
  }
  return patch
}

async function saveMarkdownFile(fileName: string, content: string): Promise<void> {
  if (isTauri()) {
    await api.saveTextFile(fileName, content)
    return
  }
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

export function SettingsDialog() {
  const open = useAppStore((state) => state.settingsOpen)
  const setOpen = useAppStore((state) => state.setSettingsOpen)
  const settings = useAppStore((state) => state.settings)
  const fonts = useAppStore((state) => state.fonts)
  const dataDir = useAppStore((state) => state.dataDir)
  const appVersion = useAppStore((state) => state.appVersion)
  const selectedProjectId = useAppStore((state) => state.selectedProjectId)
  const projects = useAppStore((state) => state.projects)
  const rounds = useAppStore((state) => state.rounds)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const refreshProjects = useAppStore((state) => state.refreshProjects)
  const loadProject = useAppStore((state) => state.loadProject)
  const flushActive = useAppStore((state) => state.flushActive)
  const recordDataChange = useAppStore((state) => state.recordDataChange)
  const showToast = useAppStore((state) => state.showToast)
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [trash, setTrash] = useState<TrashItem[]>([])
  const [busy, setBusy] = useState(false)
  const [restorePending, setRestorePending] = useState<RestorePreparation | null>(null)
  const snapshotRef = useRef(settings)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current
    wasOpenRef.current = open
    if (!justOpened) return
    snapshotRef.current = settings
    // A newly opened modal is a fresh transaction over persisted settings.
    setDraft(settings)
    setTab('appearance')
    setRestorePending(null)
  }, [open, settings])

  useEffect(() => {
    if (open) applyAppearance(draft)
  }, [draft, open])

  useEffect(() => {
    if (!open || tab !== 'data') return
    void api
      .listTrash()
      .then(setTrash)
      .catch(() => setTrash([]))
  }, [open, tab])

  const cancel = useCallback(() => {
    if (restorePending) {
      showToast('恢复已准备；请先安全退出，或在设置中明确取消本次恢复', 'warning')
      return
    }
    // 数据导入/项目切换可能在对话框期间更新全局设置；取消只撤销 draft 预览。
    applyAppearance(useAppStore.getState().settings)
    setOpen(false)
  }, [restorePending, setOpen, showToast])

  const complete = async () => {
    if (restorePending) {
      showToast('恢复待处理期间不能保存其他设置；请先退出或取消恢复', 'warning')
      return
    }
    setBusy(true)
    try {
      const patch = changedSettings(snapshotRef.current, draft)
      if (Object.keys(patch).length > 0) await updateSettings(patch)
      snapshotRef.current = useAppStore.getState().settings
      setOpen(false)
      showToast('设置已保存', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'danger')
    } finally {
      setBusy(false)
    }
  }

  const update = (patch: Partial<AppSettings>) => setDraft((current) => ({ ...current, ...patch }))
  const currentProject = projects.find((project) => project.id === selectedProjectId)

  const exportCurrentProject = async () => {
    if (!currentProject) {
      showToast('当前没有可导出的项目', 'warning')
      return
    }
    setBusy(true)
    try {
      if (!(await flushActive())) throw new Error('当前内容尚未安全保存，已取消导出')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      if (isTauri()) {
        const result = await api.exportProjectMarkdown(
          currentProject.id,
          `${sanitizeWindowsFileName(currentProject.name)}-${stamp}.md`,
        )
        if (!result) return
        showToast('项目 Markdown 已导出并写入完整性标记', 'success')
        return
      }
      const details = await Promise.all(rounds.map((round) => api.getRound(round.id)))
      const content = await buildMarkdownExport(currentProject, details)
      await saveMarkdownFile(`${sanitizeWindowsFileName(currentProject.name)}-${stamp}.md`, content)
      showToast('项目 Markdown 已导出', 'success')
    } catch (error) {
      showToast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'danger')
    } finally {
      setBusy(false)
    }
  }

  const exportAllMarkdown = async () => {
    if (!isTauri()) {
      showToast('全部项目目录导出请在 Windows 应用中执行', 'neutral')
      return
    }
    setBusy(true)
    try {
      if (!(await flushActive())) throw new Error('当前内容尚未安全保存，已取消导出')
      const result = await api.exportAllMarkdown()
      if (!result) return
      showToast(`全部项目已导出到新目录：${result.path}`, 'success')
    } catch (error) {
      showToast(
        `全部项目导出失败：${error instanceof Error ? error.message : String(error)}`,
        'danger',
      )
    } finally {
      setBusy(false)
    }
  }

  const importMarkdown = async () => {
    if (!isTauri()) {
      showToast('Markdown 文件导入请在 Windows 应用中执行', 'neutral')
      return
    }
    setBusy(true)
    try {
      if (!(await flushActive())) throw new Error('当前内容尚未安全保存，已取消导入')
      const project = await api.importMarkdown()
      if (!project) return
      recordDataChange()
      await refreshProjects()
      await loadProject(project.id)
      showToast(`已导入“${project.name}”；可信工具标记通过时会恢复多轮结构`, 'success')
    } catch (error) {
      showToast(
        `Markdown 导入失败：${error instanceof Error ? error.message : String(error)}`,
        'danger',
      )
    } finally {
      setBusy(false)
    }
  }

  const exportProjectPackage = async () => {
    if (!currentProject) {
      showToast('当前没有可导出的项目', 'warning')
      return
    }
    if (!isTauri()) {
      showToast('无损项目包请在 Windows 应用中导出', 'neutral')
      return
    }
    setBusy(true)
    try {
      if (!(await flushActive())) throw new Error('当前内容尚未安全保存，已取消导出')
      const result = await api.exportProjectPackage(
        currentProject.id,
        `${sanitizeWindowsFileName(currentProject.name)}.vcpproject`,
      )
      if (!result) return
      showToast(`无损项目包已创建（${Math.ceil(result.byteCount / 1024)} KiB）`, 'success')
    } catch (error) {
      showToast(
        `项目包导出失败：${error instanceof Error ? error.message : String(error)}`,
        'danger',
      )
    } finally {
      setBusy(false)
    }
  }

  const importProjectPackage = async () => {
    if (!isTauri()) {
      showToast('项目包导入请在 Windows 应用中执行', 'neutral')
      return
    }
    setBusy(true)
    try {
      if (!(await flushActive())) throw new Error('当前内容尚未安全保存，已取消导入')
      const project = await api.importProjectPackage()
      if (!project) return
      recordDataChange()
      await refreshProjects()
      await loadProject(project.id)
      showToast(`已无损导入“${project.name}”`, 'success')
    } catch (error) {
      showToast(
        `项目包导入失败：${error instanceof Error ? error.message : String(error)}`,
        'danger',
      )
    } finally {
      setBusy(false)
    }
  }

  const createManualBackup = async () => {
    if (!isTauri()) {
      showToast('完整备份请在 Windows 应用中创建', 'neutral')
      return
    }
    setBusy(true)
    try {
      if (!(await flushActive())) throw new Error('当前内容尚未安全保存，已取消备份')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const result = await api.createManualBackup(`提示词记录工具-${stamp}.vcpbackup`)
      if (!result) return
      showToast(`完整备份已校验并保存（${Math.ceil(result.byteCount / 1024)} KiB）`, 'success')
    } catch (error) {
      showToast(`完整备份失败：${error instanceof Error ? error.message : String(error)}`, 'danger')
    } finally {
      setBusy(false)
    }
  }

  const restoreBackup = async () => {
    if (!isTauri()) {
      showToast('完整恢复请在 Windows 应用中执行', 'neutral')
      return
    }
    setBusy(true)
    let preparation: RestorePreparation | null = null
    try {
      if (!(await flushActive())) throw new Error('当前内容尚未安全保存，已取消恢复')
      if (!window.confirm('选择备份后将完整校验并创建当前数据恢复点。确认继续吗？')) return
      const result = await api.prepareBackupRestore()
      if (!result) return
      preparation = result
      setRestorePending(result)
      const exitNow = window.confirm(
        `备份已校验，恢复前快照已保存到：\n${result.recoveryPointPath}\n\n需要重新启动应用完成原子切换。是否现在退出？`,
      )
      if (exitNow) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        showToast('恢复已准备，正在安全保存并退出', 'warning')
        await getCurrentWindow().close()
      } else {
        await api.cancelPreparedRestore()
        setRestorePending(null)
        showToast('已取消本次恢复；校验恢复点仍保留在手动备份中', 'success')
      }
    } catch (error) {
      showToast(
        preparation
          ? `恢复已准备但后续操作失败；编辑已锁定，请重试退出或明确取消：${error instanceof Error ? error.message : String(error)}`
          : `恢复准备失败，现有数据未改变：${error instanceof Error ? error.message : String(error)}`,
        'danger',
      )
    } finally {
      setBusy(false)
    }
  }

  const retryPreparedRestoreExit = async () => {
    setBusy(true)
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      showToast('正在安全保存并退出，以完成备份恢复', 'warning')
      await getCurrentWindow().close()
    } catch (error) {
      showToast(
        `退出失败，恢复仍保持待处理：${error instanceof Error ? error.message : String(error)}`,
        'danger',
      )
    } finally {
      setBusy(false)
    }
  }

  const cancelPreparedRestore = async () => {
    setBusy(true)
    try {
      await api.cancelPreparedRestore()
      setRestorePending(null)
      showToast('已取消本次恢复；当前数据保持不变，恢复点仍保留', 'success')
    } catch (error) {
      showToast(
        `取消恢复失败；为避免后续编辑被回滚，界面继续锁定：${error instanceof Error ? error.message : String(error)}`,
        'danger',
      )
    } finally {
      setBusy(false)
    }
  }

  const importFonts = async () => {
    if (!isTauri()) {
      showToast('字体文件导入请在 Windows 应用中执行', 'neutral')
      return
    }
    if (
      !window.confirm(
        '请确认这些字体由您合法取得，且其许可允许在本机应用中使用和复制。是否继续选择字体文件？',
      )
    )
      return
    setBusy(true)
    try {
      const nextFonts = await api.importFontFiles()
      if (!nextFonts) return
      recordDataChange()
      useAppStore.setState({ fonts: nextFonts })
      showToast('字体导入完成；所选文件均已校验', 'success')
    } catch (error) {
      showToast(`字体导入失败：${error instanceof Error ? error.message : String(error)}`, 'danger')
    } finally {
      setBusy(false)
    }
  }

  const removeImportedFont = async (font: FontFaceInfo) => {
    if (
      !window.confirm(
        `移除用户字体“${font.family}”？字体文件将从便携数据目录删除，但字体偏好会保留，重新导入同一文件即可恢复。`,
      )
    )
      return
    setBusy(true)
    try {
      const nextFonts = await api.removeImportedFont(font.id)
      recordDataChange()
      useAppStore.setState({ fonts: nextFonts })
      showToast('字体文件已移除，偏好仍保留；重新导入同一文件即可恢复', 'success')
    } catch (error) {
      showToast(`移除字体失败：${error instanceof Error ? error.message : String(error)}`, 'danger')
    } finally {
      setBusy(false)
    }
  }

  const restoreTrash = async (item: TrashItem) => {
    setBusy(true)
    try {
      if (!(await flushActive())) throw new Error('当前内容尚未安全保存，已取消恢复')
      if (item.kind === 'project') await api.restoreProject(item.id)
      else await api.restoreRound(item.id)
      recordDataChange()
      setTrash(await api.listTrash())
      await refreshProjects()
      if (item.kind === 'round' && item.projectId === selectedProjectId && selectedProjectId) {
        await loadProject(selectedProjectId, true)
      }
      showToast('已从最近删除恢复', 'success')
    } catch (error) {
      showToast(`恢复失败：${error instanceof Error ? error.message : String(error)}`, 'danger')
    } finally {
      setBusy(false)
    }
  }

  const purgeTrash = async (item: TrashItem) => {
    if (!window.confirm(`永久删除“${item.name}”？此操作无法撤销。`)) return
    setBusy(true)
    try {
      if (!(await flushActive())) throw new Error('当前内容尚未安全保存，已取消永久删除')
      await api.permanentlyDelete(item.kind, item.id)
      recordDataChange()
      setTrash(await api.listTrash())
      await refreshProjects()
      showToast('已永久删除', 'warning')
    } catch (error) {
      showToast(`永久删除失败：${error instanceof Error ? error.message : String(error)}`, 'danger')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={cancel}
      title="设置"
      description="外观、浏览习惯和数据安全设置在所有项目间共用。"
      className="settings-dialog"
      wide
    >
      {restorePending ? (
        <section className="settings-restore-pending" role="status" aria-live="assertive">
          <RefreshCcw aria-hidden="true" />
          <div>
            <h3>备份恢复已安全准备</h3>
            <p>
              在应用退出并完成切换，或你明确取消本次恢复前，设置与数据操作保持锁定，避免后续改动在重启时被回滚。
            </p>
            <small>恢复前快照：{restorePending.recoveryPointPath}</small>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void cancelPreparedRestore()}
          >
            取消本次恢复
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void retryPreparedRestoreExit()}
          >
            安全退出并恢复
          </button>
        </section>
      ) : null}
      <div
        className="settings-layout"
        inert={restorePending ? true : undefined}
        aria-hidden={restorePending ? 'true' : undefined}
      >
        <nav className="settings-nav" aria-label="设置分类">
          {tabs.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                className={tab === item.id ? 'is-active' : ''}
                onClick={() => setTab(item.id)}
              >
                <Icon aria-hidden="true" /> {item.label}
              </button>
            )
          })}
        </nav>
        <div className="settings-content">
          {tab === 'appearance' ? (
            <>
              <section className="settings-section">
                <div className="settings-section__heading">
                  <div>
                    <span className="eyebrow">全局配色</span>
                    <h2>主题</h2>
                  </div>
                  <span>切换时字体设置保持不变</span>
                </div>
                <div className="theme-grid">
                  {themes.map((theme) => (
                    <button
                      key={theme.id}
                      type="button"
                      className={`theme-choice ${draft.theme === theme.id ? 'is-selected' : ''}`}
                      onClick={() => update({ theme: theme.id })}
                    >
                      <span
                        className="theme-choice__swatch"
                        style={{
                          background: `linear-gradient(135deg, ${theme.colors[0]} 0 56%, ${theme.colors[1]} 56% 79%, ${theme.colors[2]} 79%)`,
                        }}
                      >
                        {draft.theme === theme.id ? <Check aria-hidden="true" /> : null}
                      </span>
                      <span>
                        <strong>{theme.name}</strong>
                        <small>{theme.description}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
              <section className="settings-section">
                <div className="settings-section__heading">
                  <div>
                    <span className="eyebrow">独立配置</span>
                    <h2>字体</h2>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void importFonts()}
                  >
                    <Upload aria-hidden="true" /> 导入字体
                  </button>
                </div>
                <FontControl role="ui" draft={draft} fonts={fonts} update={update} />
                <FontControl role="body" draft={draft} fonts={fonts} update={update} />
                <FontControl role="code" draft={draft} fonts={fonts} update={update} />
                {fonts.some((font) => font.source === 'imported') ? (
                  <div className="settings-card imported-fonts-card">
                    <div className="settings-card__heading">
                      <Type aria-hidden="true" />
                      <div>
                        <h3>用户导入字体</h3>
                        <p>文件已复制到便携数据目录，不依赖原位置。</p>
                      </div>
                    </div>
                    <div className="imported-font-list">
                      {fonts
                        .filter((font) => font.source === 'imported')
                        .map((font) => (
                          <div key={font.id}>
                            <span style={{ fontFamily: `"${font.family.replaceAll('"', '\\"')}"` }}>
                              <strong>{font.family}</strong>
                              <small>
                                {font.weights.join(' / ')} · {font.isMonospace ? '等宽' : '比例'} ·{' '}
                                {font.available ? '可用' : '已移除（偏好保留）'}
                              </small>
                            </span>
                            <button
                              type="button"
                              className="danger-button"
                              disabled={busy || !font.available}
                              onClick={() => void removeImportedFont(font)}
                            >
                              <Trash2 aria-hidden="true" /> {font.available ? '移除' : '已移除'}
                            </button>
                          </div>
                        ))}
                    </div>
                  </div>
                ) : null}
                <div className="line-height-grid">
                  <label className="settings-card">
                    <span>
                      <strong>正文行高</strong>
                      <small>中文长段落建议 1.55～1.75</small>
                    </span>
                    <input
                      type="range"
                      min="1.2"
                      max="2.2"
                      step="0.05"
                      value={draft.bodyLineHeight}
                      onChange={(event) => update({ bodyLineHeight: Number(event.target.value) })}
                    />
                    <output>{draft.bodyLineHeight.toFixed(2)}</output>
                  </label>
                  <label className="settings-card">
                    <span>
                      <strong>代码行高</strong>
                      <small>兼顾密度和符号辨识</small>
                    </span>
                    <input
                      type="range"
                      min="1.2"
                      max="2"
                      step="0.05"
                      value={draft.codeLineHeight}
                      onChange={(event) => update({ codeLineHeight: Number(event.target.value) })}
                    />
                    <output>{draft.codeLineHeight.toFixed(2)}</output>
                  </label>
                </div>
                <div className="settings-section__heading settings-section__heading--sub">
                  <div>
                    <h3>高级缺字回退</h3>
                    <p>
                      可调整备用字体优先级；最终 sans-serif / monospace 与系统 Emoji
                      兜底不会被关闭。
                    </p>
                  </div>
                </div>
                <div className="fallback-order-grid">
                  <FallbackOrder
                    title="界面备用字体"
                    values={draft.uiFallbackFamilies}
                    fonts={fonts}
                    onChange={(values) => update({ uiFallbackFamilies: values })}
                  />
                  <FallbackOrder
                    title="正文备用字体"
                    values={draft.bodyFallbackFamilies}
                    fonts={fonts}
                    onChange={(values) => update({ bodyFallbackFamilies: values })}
                  />
                  <FallbackOrder
                    title="代码备用字体"
                    values={draft.codeFallbackFamilies}
                    fonts={fonts}
                    monospaceFirst
                    onChange={(values) => update({ codeFallbackFamilies: values })}
                  />
                </div>
                <div className="font-preview settings-card">
                  <div className="settings-card__heading">
                    <Monitor aria-hidden="true" />
                    <div>
                      <h3>实时预览</h3>
                      <p>设置页和当前工作区同步展示临时效果</p>
                    </div>
                  </div>
                  <MarkdownPreview markdown={previewMarkdown} />
                </div>
              </section>
            </>
          ) : null}

          {tab === 'browsing' ? (
            <section className="settings-section">
              <div className="settings-section__heading">
                <div>
                  <span className="eyebrow">时间线</span>
                  <h2>浏览与编辑</h2>
                </div>
              </div>
              <div className="settings-card preview-lines-setting">
                <div>
                  <strong>历史轮次预览行数</strong>
                  <p>按渲染后的视觉行数折叠，打开详情不会撑高卡片。支持 1～20 行或不折叠。</p>
                </div>
                <div className="preview-lines-control">
                  <input
                    type="range"
                    min={1}
                    max={21}
                    step={1}
                    aria-label="历史轮次预览行数"
                    value={draft.previewLines === 0 ? 21 : draft.previewLines}
                    onChange={(event) => {
                      const raw = Number(event.target.value)
                      update({ previewLines: raw >= 21 ? 0 : raw })
                    }}
                  />
                  <div className="preview-lines-value">
                    <button
                      type="button"
                      aria-label="减少预览行数"
                      disabled={draft.previewLines === 1}
                      onClick={() =>
                        update({ previewLines: Math.max(1, (draft.previewLines || 1) - 1) })
                      }
                    >
                      −
                    </button>
                    <span>{draft.previewLines === 0 ? '不折叠' : `${draft.previewLines} 行`}</span>
                    <button
                      type="button"
                      aria-label="增加预览行数"
                      disabled={draft.previewLines === 0}
                      onClick={() => {
                        const next = (draft.previewLines || 0) + 1
                        update({ previewLines: next > 20 ? 0 : next })
                      }}
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    className={
                      draft.previewLines === 0
                        ? 'preview-lines-nofold is-active'
                        : 'preview-lines-nofold'
                    }
                    onClick={() => update({ previewLines: draft.previewLines === 0 ? 5 : 0 })}
                  >
                    不折叠
                  </button>
                </div>
              </div>
              <ToggleRow
                title="显示轮次序号"
                description="在时间线卡片上显示高对比度顺序徽标"
                checked={draft.showRoundNumbers}
                onChange={(checked) => update({ showRoundNumbers: checked })}
              />
              <ToggleRow
                title="代码长行自动换行"
                description="关闭时使用横向滚动，保持原始列对齐"
                checked={draft.codeWrap}
                onChange={(checked) => update({ codeWrap: checked })}
              />
              <div className="settings-card editor-default-setting">
                <div>
                  <strong>默认编辑模式</strong>
                  <small>每个项目仍会记忆最后一次使用的模式</small>
                </div>
                <div className="segmented-control">
                  <button
                    type="button"
                    className={draft.defaultEditorMode === 'wysiwyg' ? 'is-active' : ''}
                    onClick={() => update({ defaultEditorMode: 'wysiwyg' })}
                  >
                    所见即所得
                  </button>
                  <button
                    type="button"
                    className={draft.defaultEditorMode === 'source' ? 'is-active' : ''}
                    onClick={() => update({ defaultEditorMode: 'source' })}
                  >
                    Markdown 源码
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {tab === 'data' ? (
            <section className="settings-section">
              <div className="settings-section__heading">
                <div>
                  <span className="eyebrow">便携数据</span>
                  <h2>导出、备份与最近删除</h2>
                </div>
              </div>
              <div className="data-location settings-card">
                <span className="settings-card__icon">
                  <Database aria-hidden="true" />
                </span>
                <div>
                  <strong>当前数据目录</strong>
                  <code>{dataDir}</code>
                  <small>整体迁移便携目录前，请先完全退出应用和 WebView2 子进程。</small>
                </div>
                <ShieldCheck aria-label="本地保存" />
              </div>
              <div className="data-action-grid">
                <button
                  type="button"
                  className="settings-card data-action"
                  disabled={busy || !currentProject}
                  onClick={() => void exportCurrentProject()}
                >
                  <Download aria-hidden="true" />
                  <span>
                    <strong>导出当前项目</strong>
                    <small>UTF-8 Markdown，包含轮次和保存时间</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="settings-card data-action"
                  disabled={busy}
                  onClick={() => void exportAllMarkdown()}
                >
                  <Download aria-hidden="true" />
                  <span>
                    <strong>导出全部项目</strong>
                    <small>新建时间戳目录、index.md 与逐项目文件</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="settings-card data-action"
                  disabled={busy}
                  onClick={() => void importMarkdown()}
                >
                  <Upload aria-hidden="true" />
                  <span>
                    <strong>导入 Markdown</strong>
                    <small>可信标记还原多轮；普通文件作为单轮导入</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="settings-card data-action"
                  disabled={busy || !currentProject}
                  onClick={() => void exportProjectPackage()}
                >
                  <FileArchive aria-hidden="true" />
                  <span>
                    <strong>导出无损项目包</strong>
                    <small>.vcpproject，可再次导入</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="settings-card data-action"
                  disabled={busy}
                  onClick={() => void importProjectPackage()}
                >
                  <Upload aria-hidden="true" />
                  <span>
                    <strong>导入无损项目包</strong>
                    <small>先校验路径、版本、大小与哈希</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="settings-card data-action"
                  disabled={busy}
                  onClick={() => void createManualBackup()}
                >
                  <Archive aria-hidden="true" />
                  <span>
                    <strong>创建完整备份</strong>
                    <small>.vcpbackup，自包含恢复包</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="settings-card data-action"
                  disabled={busy}
                  onClick={() => void restoreBackup()}
                >
                  <RefreshCcw aria-hidden="true" />
                  <span>
                    <strong>从备份恢复</strong>
                    <small>校验通过后在重启时安全切换</small>
                  </span>
                </button>
              </div>
              <ToggleRow
                title="自动备份"
                description="保留最近 7 个每日快照与 4 个每周完整快照"
                checked={draft.autoBackup}
                onChange={(checked) => update({ autoBackup: checked })}
              />
              <div className="settings-section__heading settings-section__heading--sub">
                <div>
                  <h3>最近删除</h3>
                  <p>内容会一直保留，只有在这里逐项确认后才会永久删除。</p>
                </div>
                <span>{trash.length} 项</span>
              </div>
              <div className="trash-list">
                {trash.length === 0 ? (
                  <div className="trash-empty">
                    <Trash2 aria-hidden="true" />
                    <span>
                      <strong>最近删除为空</strong>
                      <small>这里不会渲染无意义的占位列表。</small>
                    </span>
                  </div>
                ) : (
                  trash.map((item) => (
                    <div key={`${item.kind}-${item.id}`} className="trash-item">
                      <span>
                        <strong>
                          {item.name || (item.kind === 'project' ? '未命名项目' : '空轮次')}
                        </strong>
                        <small>
                          {item.kind === 'project' ? '项目' : '提示词轮次'} · 删除于{' '}
                          {formatFullTime(item.deletedAt)}
                        </small>
                      </span>
                      <button type="button" onClick={() => void restoreTrash(item)}>
                        <RotateCcw aria-hidden="true" /> 恢复
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() => void purgeTrash(item)}
                      >
                        <Trash2 aria-hidden="true" /> 永久删除
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="privacy-notice">
                <ShieldCheck aria-hidden="true" />
                <span>
                  <strong>本地明文存储说明</strong>
                  <p>
                    首版 SQLite 数据库不加密。任何能读取便携目录的人都能读取提示词；请配合 Windows
                    账户权限或磁盘加密保护设备。
                  </p>
                </span>
              </div>
            </section>
          ) : null}

          {tab === 'shortcuts' ? (
            <section className="settings-section">
              <div className="settings-section__heading">
                <div>
                  <span className="eyebrow">高效操作</span>
                  <h2>键盘快捷键</h2>
                </div>
              </div>
              <div className="shortcut-list settings-card">
                {shortcutRows.map(([label, keys]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <kbd>{keys}</kbd>
                  </div>
                ))}
              </div>
              <div className="settings-tip">
                <Keyboard aria-hidden="true" />
                <p>
                  编辑器获得焦点时，方向键、Home、End 和 Ctrl+Z
                  始终保留标准文字编辑行为；时间线获得焦点时才用于轮次导航。
                </p>
              </div>
            </section>
          ) : null}

          {tab === 'about' ? (
            <section className="settings-section about-section">
              <div className="about-hero">
                <span className="app-mark app-mark--large">V</span>
                <div>
                  <span className="eyebrow">VibePromptRecorder</span>
                  <h2>提示词记录工具</h2>
                  <p>版本 {appVersion} · Windows x64 个人便携版</p>
                </div>
              </div>
              <div className="about-principles">
                <div>
                  <ShieldCheck aria-hidden="true" />
                  <strong>本地优先</strong>
                  <span>不上传提示词，不做遥测</span>
                </div>
                <div>
                  <BookOpen aria-hidden="true" />
                  <strong>原文真源</strong>
                  <span>始终保存 Markdown 原文</span>
                </div>
                <div>
                  <Monitor aria-hidden="true" />
                  <strong>离线可用</strong>
                  <span>核心功能不依赖网络</span>
                </div>
              </div>
              <div className="settings-card license-card">
                <h3>内置字体与许可</h3>
                <p>
                  <strong>MiSans</strong> — Xiaomi；允许免费使用及软件嵌入。本软件使用 MiSans
                  字体，不修改、不单独分发字体文件。
                </p>
                <p>
                  <strong>HarmonyOS Sans SC</strong> —
                  Huawei；按随附许可用于软件界面，不修改、不单独分发。
                </p>
                <p>
                  <strong>Mona Sans</strong> — GitHub；SIL Open Font License 1.1。
                </p>
                <p>
                  <strong>Sarasa Mono SC</strong> — Sarasa Gothic；SIL Open Font License 1.1。
                </p>
                <p className="muted">
                  用户导入字体由当前用户在本机提供，其许可责任不由应用声明替代。
                </p>
              </div>
              <div className="settings-card">
                <h3>隐私边界</h3>
                <p>
                  无需账号或登录，不接入模型
                  API，不读取终端历史、其他应用窗口、项目代码或系统剪贴板。只有在你主动粘贴或复制时才处理对应文本。
                </p>
              </div>
            </section>
          ) : null}
        </div>
      </div>
      <footer
        className="dialog-footer settings-footer"
        inert={restorePending ? true : undefined}
        aria-hidden={restorePending ? 'true' : undefined}
      >
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setDraft({
              ...DEFAULT_SETTINGS,
              favoriteFontIds: draft.favoriteFontIds,
              recentFontIds: draft.recentFontIds,
              lastProjectId: draft.lastProjectId,
            })
          }
        >
          <RotateCcw aria-hidden="true" /> 恢复外观与行为默认值
        </button>
        <span className="settings-footer__spacer" />
        <button type="button" className="secondary-button" onClick={cancel}>
          取消
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={busy || Boolean(restorePending)}
          onClick={() => void complete()}
        >
          {busy ? '正在处理…' : '完成'}
        </button>
      </footer>
    </Dialog>
  )
}
