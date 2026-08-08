import { create } from 'zustand'
import { api } from '../lib/api'
import { truncateUtf16Safely } from '../lib/markdown'
import type {
  AppSettings,
  EditorMode,
  FontFaceInfo,
  ProjectSummary,
  ProjectViewState,
  RoundDetail,
  RoundSummary,
  SaveState,
} from '../types'
import { DEFAULT_SETTINGS } from '../types'

interface ToastState {
  id: number
  message: string
  tone: 'neutral' | 'success' | 'warning' | 'danger'
  undoLabel: string | null
}

export interface RevisionConflictState {
  databaseRound: RoundDetail
  localContent: string
  localNote: string
  detectedAt: number
}

interface AppStore {
  initialized: boolean
  loading: boolean
  fatalError: string | null
  projects: ProjectSummary[]
  rounds: RoundSummary[]
  selectedProjectId: string | null
  selectedRoundId: string | null
  timelineAnchorRoundId: string | null
  timelineAnchorOffsetPx: number
  activeRound: RoundDetail | null
  editorContent: string
  editorNote: string
  editorMode: EditorMode
  cursorAnchor: number
  cursorHead: number
  editSequence: number
  persistedSequence: number
  dataChangeSequence: number
  saveState: SaveState
  savedAt: number | null
  saveError: string | null
  revisionConflict: RevisionConflictState | null
  // 编辑器纪元：仅在「非编辑器来源」替换正文时自增（冲突解决、加载项目、切轮），
  // 用于强制所见即所得编辑器重挂载并显示新内容；普通自动保存不自增，避免打断编辑。
  editorEpoch: number
  contentTransitionLocked: boolean
  markdownSafetyPending: boolean
  markdownSafetyMode: 'wysiwyg_safe' | 'source_only' | null
  markdownSafetyReason: string | null
  backupWarning: string | null
  databaseBytes: number
  databaseWarnBytes: number
  databaseLimitBytes: number
  detailOpen: boolean
  settings: AppSettings
  fonts: FontFaceInfo[]
  dataDir: string
  appVersion: string
  ftsEnabled: boolean
  searchOpen: boolean
  settingsOpen: boolean
  projectDrawerOpen: boolean
  toast: ToastState | null
  undoAction: (() => Promise<void>) | null
  pushStructuralUndo: (
    projectId: string | null,
    message: string,
    action: () => Promise<void>,
    estimatedBytes?: number,
  ) => void
  initialize: () => Promise<void>
  refreshProjects: () => Promise<void>
  loadProject: (projectId: string, preserveSelection?: boolean) => Promise<void>
  selectRound: (roundId: string, openDetail?: boolean) => Promise<void>
  updateEditorContent: (value: string) => void
  updateEditorNote: (value: string) => void
  flushActive: () => Promise<boolean>
  persistViewState: () => Promise<void>
  resolveRevisionConflict: (
    choice: 'keep-both' | 'replace-local' | 'keep-database',
  ) => Promise<void>
  finalizeActiveDraft: () => Promise<void>
  createProject: (name?: string) => Promise<void>
  renameProject: (projectId: string, name: string) => Promise<void>
  toggleProjectPin: (projectId: string) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  deleteRound: (roundId: string) => Promise<void>
  moveRound: (roundId: string, direction: -1 | 1) => Promise<void>
  reorderRoundTo: (roundId: string, targetRoundId: string) => Promise<void>
  setEditorMode: (mode: EditorMode, announce?: boolean) => Promise<void>
  setEditorSelection: (anchor: number, head: number) => void
  setTimelineAnchor: (roundId: string | null, offsetPx?: number) => void
  setDetailOpen: (open: boolean) => void
  updateSettings: (settings: Partial<AppSettings>) => Promise<void>
  setAlwaysOnTop: (enabled: boolean) => Promise<void>
  setSearchOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setProjectDrawerOpen: (open: boolean) => void
  showToast: (
    message: string,
    tone?: ToastState['tone'],
    undoAction?: (() => Promise<void>) | null,
  ) => void
  dismissToast: () => void
  undoLast: () => Promise<void>
  recordDataChange: () => void
}

let savePromise: Promise<boolean> | null = null
let finalizePromise: Promise<void> | null = null
let initializationPromise: Promise<void> | null = null
let viewStateTimer: ReturnType<typeof setTimeout> | null = null
let toastCounter = 0
// 「切换模式会清空撤销历史」提示每个会话只弹一次，避免反复打扰。
let modeSwitchNoticeShown = false
// 结构撤销栈：按项目隔离的删除/清空草稿/重排反向操作，单会话最多 100 项。
// 删除项目会额外压入 projectId=null（全局）项，便于删项目后仍能 Ctrl+Z 撤销。
interface StructuralUndoEntry {
  projectId: string | null
  label: string
  action: () => Promise<void>
  estimatedBytes: number
}
const structuralUndoStack: StructuralUndoEntry[] = []
let structuralUndoBytes = 0
let undoInFlight = false
// 迟到响应防护：每次发起加载/选轮请求前自增，异步结果回来后若不再是最新请求则丢弃，
// 避免旧轮次的迟到响应覆盖用户已切到的新轮次并清掉新输入。
let navigationToken = 0
// 设置由多个独立入口修改。后端接收字段 patch；前端维护“最后确认值 + 待提交 patch”，
// 任一写入失败后重放剩余队列，连续失败和同字段交错也不会留下幽灵设置。
let settingsWriteTail: Promise<void> = Promise.resolve()
let confirmedSettings: AppSettings = DEFAULT_SETTINGS
let settingsWriteId = 0
interface PendingSettingsWrite {
  id: number
  patch: Partial<AppSettings>
}
const pendingSettingsWrites: PendingSettingsWrite[] = []

function replayPendingSettings(): AppSettings {
  return pendingSettingsWrites.reduce(
    (settings, entry) => ({ ...settings, ...entry.patch }),
    confirmedSettings,
  )
}
// 结构撤销栈（删除/清空草稿/重排），按项目隔离；除条数外限制正文快照总预算，
// 避免几十个接近单轮上限的草稿长期滞留在 JS 堆中。
const MAX_UNDO_STACK = 100
export const STRUCTURAL_UNDO_BUDGET_BYTES = 64 * 1024 * 1024

export function clearStructuralUndoHistory(): void {
  structuralUndoStack.length = 0
  structuralUndoBytes = 0
  undoInFlight = false
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '发生了未知错误'
}

function toSummary(detail: RoundDetail): RoundSummary {
  return {
    id: detail.id,
    projectId: detail.projectId,
    position: detail.position,
    status: detail.status,
    previewMd: truncateUtf16Safely(detail.contentMd, 8192),
    createdAt: detail.createdAt,
    finalizedAt: detail.finalizedAt,
    updatedAt: detail.updatedAt,
    revision: detail.revision,
    note: detail.note,
    charCount: [...detail.contentMd].length,
  }
}

function currentViewState(state: AppStore): ProjectViewState | null {
  if (!state.selectedProjectId) return null
  return {
    projectId: state.selectedProjectId,
    selectedRoundId: state.selectedRoundId,
    timelineAnchorRoundId: state.timelineAnchorRoundId ?? state.selectedRoundId,
    anchorOffsetPx: state.timelineAnchorOffsetPx,
    editorMode: state.editorMode,
    cursorAnchor: state.cursorAnchor,
    cursorHead: state.cursorHead,
    detailOpen: state.detailOpen,
    updatedAt: Date.now(),
  }
}

async function saveViewStateBestEffort(state: AppStore): Promise<void> {
  const viewState = currentViewState(state)
  if (!viewState) return
  try {
    await api.saveViewState(viewState)
  } catch {
    // View state is convenience data. Content durability remains independent.
  }
}

function scheduleViewStateSave(getState: () => AppStore): void {
  if (viewStateTimer) clearTimeout(viewStateTimer)
  viewStateTimer = setTimeout(() => {
    viewStateTimer = null
    void saveViewStateBestEffort(getState())
  }, 250)
}

export const useAppStore = create<AppStore>((set, get) => ({
  initialized: false,
  loading: true,
  fatalError: null,
  projects: [],
  rounds: [],
  selectedProjectId: null,
  selectedRoundId: null,
  timelineAnchorRoundId: null,
  timelineAnchorOffsetPx: 0,
  activeRound: null,
  editorContent: '',
  editorNote: '',
  editorMode: 'wysiwyg',
  cursorAnchor: 0,
  cursorHead: 0,
  editSequence: 0,
  persistedSequence: 0,
  dataChangeSequence: 0,
  saveState: 'saved',
  savedAt: null,
  saveError: null,
  revisionConflict: null,
  editorEpoch: 0,
  contentTransitionLocked: false,
  markdownSafetyPending: false,
  markdownSafetyMode: null,
  markdownSafetyReason: null,
  backupWarning: null,
  databaseBytes: 0,
  databaseWarnBytes: 7680 * 1024 * 1024,
  databaseLimitBytes: 8 * 1024 * 1024 * 1024,
  detailOpen: true,
  settings: DEFAULT_SETTINGS,
  fonts: [],
  dataDir: '',
  appVersion: '0.0.0-dev',
  ftsEnabled: false,
  searchOpen: false,
  settingsOpen: false,
  projectDrawerOpen: false,
  toast: null,
  undoAction: null,

  initialize: async () => {
    if (get().initialized) return
    if (initializationPromise) return initializationPromise
    initializationPromise = (async () => {
      set({ loading: true, fatalError: null })
      try {
        const data = await api.bootstrap()
        confirmedSettings = data.settings
        pendingSettingsWrites.length = 0
        set({
          projects: data.projects,
          settings: data.settings,
          fonts: data.fonts,
          dataDir: data.dataDir,
          appVersion: data.appVersion,
          ftsEnabled: data.ftsEnabled,
          databaseBytes: data.databaseBytes,
          databaseWarnBytes: data.databaseWarnBytes,
          databaseLimitBytes: data.databaseLimitBytes,
          initialized: true,
        })
        // 数据目录位于云同步盘时给出一次性提醒（同步软件可能与 SQLite 文件冲突）。
        if (data.dataInSyncDir) {
          get().showToast(
            '数据目录位于云同步文件夹内，同步软件可能与数据库冲突，建议移到不被同步的本地目录',
            'warning',
          )
        }
        // 数据库达到软阈值时持续提示备份与清理。
        if (data.databaseBytes >= data.databaseWarnBytes) {
          set({ backupWarning: '数据库接近 8 GiB 上限，请尽快备份并清理旧项目或轮次' })
        }
        if (data.selectedProjectId) await get().loadProject(data.selectedProjectId)
        else set({ loading: false })
      } catch (error) {
        set({ loading: false, fatalError: errorMessage(error) })
      }
    })()
    try {
      await initializationPromise
    } finally {
      initializationPromise = null
    }
  },

  refreshProjects: async () => {
    const projects = await api.listProjects()
    set({ projects })
  },

  loadProject: async (projectId, preserveSelection = false) => {
    const token = ++navigationToken
    const saved = await get().flushActive()
    if (!saved || token !== navigationToken) return
    // flush 解决调用前和调用中的输入；它成功返回后立即锁住编辑区，直到异步导航完成，
    // 避免后续 IPC 等待期间的新输入被目标项目状态覆盖。
    set({ loading: true, projectDrawerOpen: false, contentTransitionLocked: true })
    try {
      await api.openProject(projectId)
      const [rounds, viewState] = await Promise.all([
        api.listRounds(projectId),
        api.getViewState(projectId),
      ])
      if (token !== navigationToken) return
      const previousId = preserveSelection ? get().selectedRoundId : null
      const preferredId = previousId ?? viewState?.selectedRoundId ?? null
      const selected =
        rounds.find((round) => round.id === preferredId) ??
        rounds.find((round) => round.status === 'draft') ??
        rounds.at(-1) ??
        null
      const activeRound = selected ? await api.getRound(selected.id) : null
      if (token !== navigationToken) return
      const restoreCursor = Boolean(viewState && selected?.id === viewState.selectedRoundId)
      set((state) => ({
        selectedProjectId: projectId,
        rounds,
        selectedRoundId: selected?.id ?? null,
        timelineAnchorRoundId:
          rounds.find((round) => round.id === viewState?.timelineAnchorRoundId)?.id ??
          selected?.id ??
          null,
        timelineAnchorOffsetPx: viewState?.anchorOffsetPx ?? 0,
        activeRound,
        editorContent: activeRound?.contentMd ?? '',
        editorNote: activeRound?.note ?? '',
        editSequence: 0,
        persistedSequence: 0,
        saveState: 'saved',
        savedAt: activeRound?.updatedAt ?? null,
        saveError: null,
        revisionConflict: null,
        editorMode: viewState?.editorMode ?? state.settings.defaultEditorMode,
        cursorAnchor: restoreCursor ? (viewState?.cursorAnchor ?? 0) : 0,
        cursorHead: restoreCursor ? (viewState?.cursorHead ?? 0) : 0,
        detailOpen: viewState?.detailOpen ?? true,
        markdownSafetyPending: true,
        markdownSafetyMode: null,
        markdownSafetyReason: null,
        editorEpoch: state.editorEpoch + 1,
      }))
      await get().refreshProjects()
      void get()
        .updateSettings({ lastProjectId: projectId })
        .catch(() => get().showToast('上次项目位置保存失败，不影响项目内容', 'warning'))
    } catch (error) {
      if (token === navigationToken) get().showToast(errorMessage(error), 'danger')
    } finally {
      // 只有仍为当前 generation 的导航才能解锁；迟到 generation 既不能覆盖内容，
      // 也不能清掉后来导航持有的锁。两个导航入口对称清理 loading 与编辑锁。
      if (token === navigationToken) set({ loading: false, contentTransitionLocked: false })
    }
  },

  selectRound: async (roundId, openDetail = true) => {
    if (roundId === get().selectedRoundId) {
      if (openDetail && !get().detailOpen) get().setDetailOpen(true)
      return
    }
    const token = ++navigationToken
    const expectedProjectId = get().selectedProjectId
    const saved = await get().flushActive()
    if (!saved || token !== navigationToken) return
    set({ contentTransitionLocked: true })
    try {
      const detail = await api.getRound(roundId)
      if (
        token !== navigationToken ||
        detail.projectId !== expectedProjectId ||
        get().selectedProjectId !== expectedProjectId
      )
        return
      set((state) => ({
        selectedRoundId: roundId,
        activeRound: detail,
        editorContent: detail.contentMd,
        editorNote: detail.note,
        cursorAnchor: 0,
        cursorHead: 0,
        editSequence: 0,
        persistedSequence: 0,
        saveState: 'saved',
        savedAt: detail.updatedAt,
        saveError: null,
        revisionConflict: null,
        detailOpen: openDetail || get().detailOpen,
        markdownSafetyPending: true,
        markdownSafetyMode: null,
        markdownSafetyReason: null,
        editorEpoch: state.editorEpoch + 1,
      }))
      void saveViewStateBestEffort(get())
    } catch (error) {
      if (token === navigationToken) get().showToast(errorMessage(error), 'danger')
    } finally {
      if (token === navigationToken) set({ loading: false, contentTransitionLocked: false })
    }
  },

  updateEditorContent: (value) => {
    if (get().contentTransitionLocked) return
    set((state) => ({
      editorContent: value,
      markdownSafetyPending: true,
      markdownSafetyMode: null,
      markdownSafetyReason: null,
      editSequence: state.editSequence + 1,
      saveState: 'pending',
      saveError: null,
    }))
  },

  updateEditorNote: (value) => {
    if (get().contentTransitionLocked) return
    const normalized = value.replace(/[\r\n]+/g, ' ').slice(0, 120)
    set((state) => ({
      editorNote: normalized,
      editSequence: state.editSequence + 1,
      saveState: 'pending',
      saveError: null,
    }))
  },

  flushActive: async () => {
    if (get().revisionConflict) return false
    // 单次保存：捕获调用瞬间的脏内容快照并落库。仅供 flushActive 循环调用。
    const runSingleSave = (): Promise<boolean> => {
      const initial = get()
      const roundId = initial.activeRound?.id
      if (!roundId) return Promise.resolve(true)
      const content = initial.editorContent
      const note = initial.editorNote
      const expectedRevision = initial.activeRound!.revision
      const sequence = initial.editSequence
      set({ saveState: 'saving', saveError: null })
      savePromise = (async () => {
        try {
          const result = await api.saveRound(roundId, content, note, expectedRevision)
          get().recordDataChange()
          set((state) => {
            if (state.activeRound?.id !== roundId) return state
            const updatedDetail: RoundDetail = {
              ...state.activeRound,
              contentMd: content,
              note,
              updatedAt: result.savedAt,
              revision: result.revision,
            }
            const stillDirty = state.editSequence !== sequence
            return {
              activeRound: updatedDetail,
              rounds: state.rounds.map((round) =>
                round.id === roundId ? toSummary(updatedDetail) : round,
              ),
              persistedSequence: sequence,
              saveState: stillDirty ? 'pending' : 'saved',
              savedAt: result.savedAt,
              saveError: null,
              databaseBytes: result.databaseBytes,
            }
          })
          if (result.databaseBytes >= get().databaseWarnBytes && !get().backupWarning) {
            set({ backupWarning: '数据库接近 8 GiB 上限，请尽快备份并清理旧项目或轮次' })
          }
          return true
        } catch (error) {
          const message = errorMessage(error)
          if (message.startsWith('REVISION_CONFLICT:')) {
            try {
              const databaseRound = await api.getRound(roundId)
              set((state) => {
                if (state.activeRound?.id !== roundId) return state
                return {
                  saveState: 'failed',
                  saveError: '检测到版本冲突，自动保存已暂停',
                  revisionConflict: {
                    databaseRound,
                    // 冲突详情读取期间用户可能仍在输入；以此刻编辑器中的最新内容
                    // 为恢复版本，不能退回到保存请求发起时的旧快照。
                    localContent: state.editorContent,
                    localNote: state.editorNote,
                    detectedAt: Date.now(),
                  },
                }
              })
              get().showToast('检测到两个版本；请选择安全的保留方式', 'warning')
            } catch (loadError) {
              set({ saveState: 'failed', saveError: errorMessage(loadError) })
              get().showToast('冲突版本读取失败，本地内容仍保留在内存中', 'danger')
            }
          } else {
            set({ saveState: 'failed', saveError: message })
            get().showToast('内容尚未安全保存，请重试或先复制内容', 'danger')
          }
          return false
        } finally {
          savePromise = null
        }
      })()
      return savePromise
    }

    // 循环等待，确保任何调用者（包括并发切轮/切项目/关窗）都等到「最新」内容落盘，
    // 而非仅等到保存发起瞬间捕获的旧快照。避免慢盘时序下丢失刚输入的内容。
    for (;;) {
      if (get().revisionConflict) return false
      const inFlight = savePromise
      if (inFlight) {
        const ok = await inFlight
        if (!ok) return false
        if (get().editSequence === get().persistedSequence) return true
        continue
      }
      const current = get()
      if (!current.activeRound || current.editSequence === current.persistedSequence) return true
      const ok = await runSingleSave()
      if (!ok) return false
      if (get().editSequence === get().persistedSequence) return true
    }
  },

  persistViewState: async () => {
    if (viewStateTimer) {
      clearTimeout(viewStateTimer)
      viewStateTimer = null
    }
    await saveViewStateBestEffort(get())
  },

  resolveRevisionConflict: async (choice) => {
    const state = get()
    const conflict = state.revisionConflict
    if (!conflict) return
    const sameActiveRound = state.activeRound?.id === conflict.databaseRound.id
    const localContent = sameActiveRound ? state.editorContent : conflict.localContent
    const localNote = sameActiveRound ? state.editorNote : conflict.localNote
    set({ contentTransitionLocked: true })
    try {
      const resolved =
        choice === 'keep-both'
          ? await api.resolveConflictKeepBoth(conflict.databaseRound.id, localContent, localNote)
          : choice === 'replace-local'
            ? await api.resolveConflictReplaceLocal(
                conflict.databaseRound.id,
                localContent,
                localNote,
                conflict.databaseRound.revision,
              )
            : conflict.databaseRound
      if (choice !== 'keep-database') get().recordDataChange()
      const rounds = await api.listRounds(resolved.projectId)
      set({
        rounds,
        selectedRoundId: resolved.id,
        activeRound: resolved,
        editorContent: resolved.contentMd,
        editorNote: resolved.note,
        markdownSafetyPending: true,
        editSequence: 0,
        persistedSequence: 0,
        saveState: 'saved',
        savedAt: resolved.updatedAt,
        saveError: null,
        revisionConflict: null,
        editorEpoch: get().editorEpoch + 1,
        detailOpen: true,
        contentTransitionLocked: false,
      })
      await get().refreshProjects()
      get().showToast(
        choice === 'keep-both'
          ? '两个版本均已保留，本地版已成为相邻正式轮次'
          : choice === 'replace-local'
            ? '已创建恢复点并用本地版替换'
            : '已保留数据库版本',
        'success',
      )
    } catch (error) {
      set({ contentTransitionLocked: false })
      get().showToast(`冲突处理失败：${errorMessage(error)}`, 'danger')
    }
  },

  finalizeActiveDraft: () => {
    if (finalizePromise) return finalizePromise
    const initial = get()
    if (!initial.selectedProjectId || !initial.activeRound || initial.contentTransitionLocked)
      return Promise.resolve()
    const expectedProjectId = initial.selectedProjectId
    const expectedRoundId = initial.activeRound.id
    const operation = (async () => {
      // 保存循环期间仍允许编辑；flushActive 会持续追赶 editSequence，直到最新输入落盘。
      // 只有即将切换数据库状态和编辑器实例时才锁住输入。
      const saved = await initial.flushActive()
      if (!saved) return
      const current = get()
      if (
        current.selectedProjectId !== expectedProjectId ||
        current.activeRound?.id !== expectedRoundId ||
        current.contentTransitionLocked
      ) {
        return
      }
      set({ contentTransitionLocked: true })
      if (current.activeRound.status === 'final') {
        const draft = current.rounds.find((round) => round.status === 'draft')
        if (draft) await get().selectRound(draft.id, true)
        else set({ contentTransitionLocked: false })
        return
      }
      try {
        const result = await api.finalizeDraft(expectedProjectId)
        get().recordDataChange()
        const rounds = await api.listRounds(expectedProjectId)
        set((state) => ({
          rounds,
          selectedRoundId: result.draft.id,
          activeRound: result.draft,
          editorContent: '',
          editorNote: '',
          markdownSafetyPending: true,
          editSequence: 0,
          persistedSequence: 0,
          saveState: 'saved',
          savedAt: result.draft.updatedAt,
          detailOpen: true,
          contentTransitionLocked: false,
          editorEpoch: state.editorEpoch + 1,
        }))
        await get().refreshProjects()
        get().showToast('本轮已保存，已开始新的草稿', 'success')
      } catch (error) {
        set({ contentTransitionLocked: false })
        get().showToast(errorMessage(error), 'warning')
      }
    })()
    finalizePromise = operation
    void operation.then(
      () => {
        if (finalizePromise === operation) finalizePromise = null
      },
      () => {
        if (finalizePromise === operation) finalizePromise = null
      },
    )
    return operation
  },

  createProject: async (name) => {
    if (!(await get().flushActive())) return
    try {
      const project = await api.createProject(name)
      get().recordDataChange()
      await get().refreshProjects()
      await get().loadProject(project.id)
      get().showToast(`已创建“${project.name}”`, 'success')
    } catch (error) {
      get().showToast(errorMessage(error), 'danger')
    }
  },

  renameProject: async (projectId, name) => {
    try {
      await api.renameProject(projectId, name)
      get().recordDataChange()
      await get().refreshProjects()
      get().showToast('项目名称已更新', 'success')
    } catch (error) {
      get().showToast(errorMessage(error), 'danger')
    }
  },

  toggleProjectPin: async (projectId) => {
    try {
      const project = await api.toggleProjectPin(projectId)
      get().recordDataChange()
      await get().refreshProjects()
      get().showToast(project.isPinned ? '项目已固定在顶部' : '已取消项目固定', 'success')
    } catch (error) {
      get().showToast(errorMessage(error), 'danger')
    }
  },

  deleteProject: async (projectId) => {
    if (!(await get().flushActive())) return
    const affectsActiveProject = get().selectedProjectId === projectId
    if (affectsActiveProject) set({ contentTransitionLocked: true })
    const before = get().projects
    const index = before.findIndex((project) => project.id === projectId)
    try {
      await api.deleteProject(projectId)
      get().recordDataChange()
      const projects = await api.listProjects()
      set({ projects })
      if (get().selectedProjectId === projectId) {
        const next = projects[Math.min(index, Math.max(0, projects.length - 1))]
        if (next) await get().loadProject(next.id)
        else {
          set({
            selectedProjectId: null,
            selectedRoundId: null,
            rounds: [],
            activeRound: null,
            editorContent: '',
            editorNote: '',
            markdownSafetyPending: false,
            contentTransitionLocked: false,
          })
        }
      }
      get().pushStructuralUndo(null, '项目已移入最近删除', async () => {
        await api.restoreProject(projectId)
        await get().refreshProjects()
        await get().loadProject(projectId)
      })
    } catch (error) {
      get().showToast(errorMessage(error), 'danger')
    } finally {
      if (affectsActiveProject) set({ contentTransitionLocked: false })
    }
  },

  deleteRound: async (roundId) => {
    const beforeFlush = get()
    if (!beforeFlush.rounds.some((round) => round.id === roundId)) return
    if (!(await get().flushActive())) return
    const state = get()
    const target = state.rounds.find((round) => round.id === roundId)
    // flush 期间可能已切换项目；只使用返回后的当前状态和仍存在的目标。
    if (!target || !state.selectedProjectId || target.projectId !== state.selectedProjectId) return
    const projectId = state.selectedProjectId
    const affectsActiveRound = state.selectedRoundId === roundId
    if (affectsActiveRound) set({ contentTransitionLocked: true })
    let draftSnapshot: RoundDetail | null = null
    try {
      // 草稿不进回收站；完整快照读取与删除必须处于同一个 try/finally 解锁范围内。
      if (target.status === 'draft') draftSnapshot = await api.getRound(roundId)
      await api.deleteRound(roundId)
      get().recordDataChange()
      const rounds = await api.listRounds(projectId)
      set({ rounds })
      if (affectsActiveRound) {
        if (target.status === 'draft') {
          const detail = await api.getRound(roundId)
          set({
            selectedRoundId: roundId,
            activeRound: detail,
            editorContent: detail.contentMd,
            editorNote: detail.note,
            markdownSafetyPending: true,
            editSequence: 0,
            persistedSequence: 0,
            saveState: 'saved',
            savedAt: detail.updatedAt,
            saveError: null,
            editorEpoch: get().editorEpoch + 1,
          })
        } else {
          const previousFinals = state.rounds.filter((round) => round.status === 'final')
          const deletedFinalIndex = previousFinals.findIndex((round) => round.id === roundId)
          const finals = rounds.filter((round) => round.status === 'final')
          const next =
            finals[deletedFinalIndex] ??
            finals[deletedFinalIndex - 1] ??
            rounds.find((round) => round.status === 'draft') ??
            null
          if (next) await get().selectRound(next.id, true)
        }
      }
      if (target.status === 'final') {
        get().pushStructuralUndo(projectId, '轮次已移入最近删除', async () => {
          await api.restoreRound(roundId)
          if (get().selectedProjectId === projectId) await get().loadProject(projectId, true)
        })
      } else if (draftSnapshot && (draftSnapshot.contentMd !== '' || draftSnapshot.note !== '')) {
        const snapshot = draftSnapshot
        get().pushStructuralUndo(
          projectId,
          '草稿已清空',
          async () => {
            // 先保存撤销前的新输入；只有草稿仍处于“刚清空”的精确 revision 才原位恢复。
            // 若用户已经继续写作，则把旧快照保存为相邻正式恢复轮次，绝不覆盖新草稿。
            if (get().selectedRoundId === roundId && !(await get().flushActive())) {
              throw new Error('当前新草稿尚未安全保存，未执行撤销')
            }
            const fresh = await api.getRound(roundId)
            const unchangedSinceClear =
              fresh.revision === snapshot.revision + 1 &&
              fresh.contentMd === '' &&
              fresh.note === ''
            if (unchangedSinceClear) {
              await api.saveRound(roundId, snapshot.contentMd, snapshot.note, fresh.revision)
            } else {
              await api.resolveConflictKeepBoth(roundId, snapshot.contentMd, snapshot.note)
            }
            if (get().selectedProjectId === projectId) await get().loadProject(projectId, true)
          },
          (snapshot.contentMd.length + snapshot.note.length) * 2,
        )
      } else {
        get().showToast('草稿已清空', 'warning')
      }
      await get().refreshProjects()
    } catch (error) {
      get().showToast(errorMessage(error), 'danger')
    } finally {
      if (affectsActiveRound) set({ contentTransitionLocked: false })
    }
  },

  moveRound: async (roundId, direction) => {
    if (!(await get().flushActive())) return
    const state = get()
    if (!state.selectedProjectId) return
    const projectId = state.selectedProjectId
    const finals = state.rounds.filter((round) => round.status === 'final')
    const index = finals.findIndex((round) => round.id === roundId)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= finals.length) return
    const previousIds = finals.map((round) => round.id)
    const nextIds = [...previousIds]
    const [moved] = nextIds.splice(index, 1)
    if (!moved) return
    nextIds.splice(targetIndex, 0, moved)
    try {
      await api.reorderRounds(projectId, nextIds)
      get().recordDataChange()
      const rounds = await api.listRounds(projectId)
      set({ rounds })
      get().pushStructuralUndo(projectId, '轮次顺序已调整', async () => {
        await api.reorderRounds(projectId, previousIds)
        if (get().selectedProjectId === projectId) set({ rounds: await api.listRounds(projectId) })
      })
    } catch (error) {
      get().showToast(errorMessage(error), 'danger')
    }
  },

  reorderRoundTo: async (roundId, targetRoundId) => {
    if (roundId === targetRoundId) return
    if (!(await get().flushActive())) return
    const state = get()
    if (!state.selectedProjectId) return
    const projectId = state.selectedProjectId
    const finals = state.rounds.filter((round) => round.status === 'final')
    const previousIds = finals.map((round) => round.id)
    const sourceIndex = previousIds.indexOf(roundId)
    const targetIndex = previousIds.indexOf(targetRoundId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const nextIds = [...previousIds]
    const [moved] = nextIds.splice(sourceIndex, 1)
    if (!moved) return
    nextIds.splice(targetIndex, 0, moved)
    try {
      await api.reorderRounds(projectId, nextIds)
      get().recordDataChange()
      set({ rounds: await api.listRounds(projectId) })
      get().pushStructuralUndo(projectId, '轮次顺序已调整', async () => {
        await api.reorderRounds(projectId, previousIds)
        if (get().selectedProjectId === projectId) set({ rounds: await api.listRounds(projectId) })
      })
    } catch (error) {
      get().showToast(errorMessage(error), 'danger')
    }
  },

  setEditorMode: (mode, announce = true) => {
    if (mode === get().editorMode) return Promise.resolve()
    set({ editorMode: mode })
    if (announce && !modeSwitchNoticeShown) {
      modeSwitchNoticeShown = true
      get().showToast('已切换模式，此前的编辑不能再撤销', 'neutral')
    }
    void saveViewStateBestEffort(get())
    return Promise.resolve()
  },

  setEditorSelection: (anchor, head) => {
    if (get().cursorAnchor === anchor && get().cursorHead === head) return
    set({ cursorAnchor: anchor, cursorHead: head })
    scheduleViewStateSave(get)
  },

  setTimelineAnchor: (roundId, offsetPx = 0) => {
    if (get().timelineAnchorRoundId === roundId && get().timelineAnchorOffsetPx === offsetPx) return
    set({ timelineAnchorRoundId: roundId, timelineAnchorOffsetPx: offsetPx })
    scheduleViewStateSave(get)
  },

  setDetailOpen: (open) => {
    set({ detailOpen: open })
    void saveViewStateBestEffort(get())
  },

  updateSettings: async (patch) => {
    const affectsBackup = Object.keys(patch).some((key) => key !== 'lastProjectId')
    if (pendingSettingsWrites.length === 0) confirmedSettings = get().settings
    const entry = { id: ++settingsWriteId, patch }
    pendingSettingsWrites.push(entry)
    set({ settings: replayPendingSettings() })
    const write = settingsWriteTail
      .catch(() => undefined)
      .then(async () => {
        await api.saveSettings(patch)
        confirmedSettings = { ...confirmedSettings, ...patch }
        if (affectsBackup) get().recordDataChange()
      })
    settingsWriteTail = write
    try {
      await write
    } finally {
      const index = pendingSettingsWrites.findIndex((candidate) => candidate.id === entry.id)
      if (index >= 0) pendingSettingsWrites.splice(index, 1)
      set({ settings: replayPendingSettings() })
    }
  },

  setAlwaysOnTop: async (enabled) => {
    await get().updateSettings({ alwaysOnTop: enabled })
  },

  setSearchOpen: (open) => set({ searchOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setProjectDrawerOpen: (open) => set({ projectDrawerOpen: open }),

  recordDataChange: () => set((state) => ({ dataChangeSequence: state.dataChangeSequence + 1 })),

  showToast: (message, tone = 'neutral', undoAction = null) => {
    toastCounter += 1
    set({
      toast: { id: toastCounter, message, tone, undoLabel: undoAction ? '撤销' : null },
      undoAction,
    })
  },

  pushStructuralUndo: (projectId, message, action, estimatedBytes = 0) => {
    const retainedBytes = Math.max(0, Math.floor(estimatedBytes))
    const entry = { projectId, label: message, action, estimatedBytes: retainedBytes }
    structuralUndoStack.push(entry)
    structuralUndoBytes += retainedBytes
    while (
      structuralUndoStack.length > MAX_UNDO_STACK ||
      structuralUndoBytes > STRUCTURAL_UNDO_BUDGET_BYTES
    ) {
      const evicted = structuralUndoStack.shift()
      if (!evicted) break
      structuralUndoBytes -= evicted.estimatedBytes
    }
    toastCounter += 1
    const retained = structuralUndoStack.includes(entry)
    // Toast 的「撤销」按钮与 Ctrl+Z 共用同一个栈：都弹出并执行最近一次结构操作。
    set({
      toast: {
        id: toastCounter,
        message: retained ? message : `${message}；撤销快照超过内存预算，未保留`,
        tone: 'warning',
        undoLabel: retained ? '撤销' : null,
      },
      undoAction: retained ? () => get().undoLast() : null,
    })
  },

  dismissToast: () => set({ toast: null, undoAction: null }),

  undoLast: async () => {
    if (undoInFlight) return
    undoInFlight = true
    // 优先撤销当前项目的最近结构操作；找不到时退回栈顶（例如刚删除的项目）。
    const currentProjectId = get().selectedProjectId
    let index = -1
    for (let i = structuralUndoStack.length - 1; i >= 0; i -= 1) {
      const entry = structuralUndoStack[i]
      if (entry && (entry.projectId === currentProjectId || entry.projectId === null)) {
        index = i
        break
      }
    }
    if (index < 0) index = structuralUndoStack.length - 1
    if (index < 0) {
      // 无结构操作可撤销：回退到旧的单槽 undoAction（如项目恢复等场景）。
      const action = get().undoAction
      if (!action) {
        undoInFlight = false
        return
      }
      set({ undoAction: null, toast: null })
      try {
        await action()
        get().recordDataChange()
        get().showToast('已撤销操作', 'success')
      } catch (error) {
        set({ undoAction: action })
        get().showToast(`撤销失败：${errorMessage(error)}`, 'danger', action)
      } finally {
        undoInFlight = false
      }
      return
    }
    const [entry] = structuralUndoStack.splice(index, 1)
    if (entry) structuralUndoBytes -= entry.estimatedBytes
    set({ undoAction: null, toast: null })
    if (!entry) {
      undoInFlight = false
      return
    }
    try {
      await entry.action()
      get().recordDataChange()
      get().showToast('已撤销操作', 'success')
    } catch (error) {
      structuralUndoStack.splice(Math.min(index, structuralUndoStack.length), 0, entry)
      structuralUndoBytes += entry.estimatedBytes
      get().showToast(`撤销失败：${errorMessage(error)}`, 'danger', () => get().undoLast())
    } finally {
      undoInFlight = false
    }
  },
}))
