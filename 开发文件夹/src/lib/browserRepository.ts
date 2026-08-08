import {
  CORE_FONTS,
  DEFAULT_SETTINGS,
  type AppSettings,
  type BackupInfo,
  type BootstrapData,
  type FinalizeResult,
  type FontFaceInfo,
  type ProjectSummary,
  type ProjectViewState,
  type RemoteImageData,
  type RestorePreparation,
  type RoundDetail,
  type RoundSummary,
  type SaveRoundResult,
  type SearchResult,
  type TrashItem,
  type ExportResult,
  type WindowState,
} from '../types'
import { caseInsensitiveUtf16Range, truncateUtf16Safely } from './markdown'

const DATABASE_KEY = 'vpr-browser-database-v1'
const DATABASE_LOCK_KEY = 'vpr-browser-database-write-v1'
const MAX_ROUND_BYTES = 10 * 1024 * 1024

interface BrowserProject {
  id: string
  name: string
  isPinned: boolean
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  deletedAt: number | null
  revision: number
}

interface BrowserRound extends RoundDetail {
  deletedAt: number | null
}

interface BrowserDatabase {
  nextProjectNumber: number
  projects: BrowserProject[]
  rounds: BrowserRound[]
  settings: AppSettings
  viewStates: ProjectViewState[]
}

const clone = <T>(value: T): T => structuredClone(value)

function createId(): string {
  return crypto.randomUUID()
}

function now(): number {
  return Date.now()
}

function initialDatabase(): BrowserDatabase {
  const timestamp = now()
  const projectId = createId()
  const draftId = createId()
  return {
    nextProjectNumber: 2,
    projects: [
      {
        id: projectId,
        name: 'Vibe Coding 项目-1',
        isPinned: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
        deletedAt: null,
        revision: 0,
      },
    ],
    rounds: [
      {
        id: draftId,
        projectId,
        position: 2_147_483_647,
        status: 'draft',
        contentMd: '',
        createdAt: timestamp,
        finalizedAt: null,
        updatedAt: timestamp,
        revision: 0,
        note: '',
        deletedAt: null,
      },
    ],
    settings: { ...DEFAULT_SETTINGS, lastProjectId: projectId },
    viewStates: [
      {
        projectId,
        selectedRoundId: draftId,
        timelineAnchorRoundId: draftId,
        anchorOffsetPx: 0,
        editorMode: 'wysiwyg',
        cursorAnchor: 0,
        cursorHead: 0,
        detailOpen: true,
        updatedAt: timestamp,
      },
    ],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || (isSafeNumber(value) && value >= 0)
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint < 32 || (codePoint >= 0x7f && codePoint <= 0x9f)
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((item) => typeof item === 'string' && item.length > 0 && [...item].length <= 160)
  )
}

function isAllowedFontWeight(value: unknown): value is number {
  return Number.isSafeInteger(value) && [400, 500, 600, 700].includes(value as number)
}

function isValidFontFamily(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    [...value].length <= 160 &&
    ![...value].some(isControlCharacter)
  )
}

function validatedSettings(value: unknown): AppSettings {
  if (!isRecord(value)) throw new Error('浏览器本地设置结构无效')
  const settings = { ...DEFAULT_SETTINGS, ...value }
  if (
    settings.formatVersion !== 1 ||
    !['system', 'neutral', 'warm', 'mint', 'lavender', 'graphite'].includes(settings.theme) ||
    !['wysiwyg', 'source'].includes(settings.defaultEditorMode) ||
    typeof settings.showRoundNumbers !== 'boolean' ||
    typeof settings.alwaysOnTop !== 'boolean' ||
    typeof settings.codeWrap !== 'boolean' ||
    typeof settings.autoBackup !== 'boolean' ||
    !Number.isSafeInteger(settings.previewLines) ||
    settings.previewLines < 0 ||
    settings.previewLines > 20 ||
    !Number.isSafeInteger(settings.uiFontSize) ||
    settings.uiFontSize < 12 ||
    settings.uiFontSize > 22 ||
    !Number.isSafeInteger(settings.bodyFontSize) ||
    settings.bodyFontSize < 12 ||
    settings.bodyFontSize > 32 ||
    !Number.isSafeInteger(settings.codeFontSize) ||
    settings.codeFontSize < 11 ||
    settings.codeFontSize > 28 ||
    !isAllowedFontWeight(settings.uiFontWeight) ||
    !isAllowedFontWeight(settings.bodyFontWeight) ||
    !isAllowedFontWeight(settings.codeFontWeight) ||
    !isSafeNumber(settings.bodyLineHeight) ||
    settings.bodyLineHeight < 1.2 ||
    settings.bodyLineHeight > 2.2 ||
    !isSafeNumber(settings.codeLineHeight) ||
    settings.codeLineHeight < 1.2 ||
    settings.codeLineHeight > 2 ||
    !Number.isSafeInteger(settings.projectPanelWidth) ||
    settings.projectPanelWidth < 200 ||
    settings.projectPanelWidth > 340 ||
    !Number.isSafeInteger(settings.timelinePanelWidth) ||
    settings.timelinePanelWidth < 280 ||
    settings.timelinePanelWidth > 460 ||
    !isValidFontFamily(settings.uiFontFamily) ||
    !isValidFontFamily(settings.bodyFontFamily) ||
    !isValidFontFamily(settings.codeFontFamily) ||
    !isStringArray(settings.uiFallbackFamilies) ||
    !isStringArray(settings.bodyFallbackFamilies) ||
    !isStringArray(settings.codeFallbackFamilies) ||
    !isStringArray(settings.favoriteFontIds) ||
    !isStringArray(settings.recentFontIds) ||
    (settings.lastProjectId !== null && typeof settings.lastProjectId !== 'string')
  ) {
    throw new Error('浏览器本地设置字段无效')
  }
  return settings
}

function validatedDatabase(value: unknown): BrowserDatabase {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.nextProjectNumber) ||
    Number(value.nextProjectNumber) < 1 ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.rounds)
  ) {
    throw new Error('浏览器本地数据库顶层结构无效')
  }
  const projects = value.projects.map((item): BrowserProject => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      item.id.length === 0 ||
      typeof item.name !== 'string' ||
      item.name.trim().length === 0 ||
      [...item.name].length > 120 ||
      [...item.name].some(isControlCharacter) ||
      typeof item.isPinned !== 'boolean' ||
      !isSafeNumber(item.createdAt) ||
      !isSafeNumber(item.updatedAt) ||
      !isSafeNumber(item.lastOpenedAt) ||
      !isNullableTimestamp(item.deletedAt) ||
      !Number.isSafeInteger(item.revision) ||
      Number(item.revision) < 0
    ) {
      throw new Error('浏览器本地项目记录无效')
    }
    return item as unknown as BrowserProject
  })
  const projectIds = new Set(projects.map((project) => project.id))
  if (projectIds.size !== projects.length) throw new Error('浏览器本地项目 ID 重复')
  const rounds = value.rounds.map((item): BrowserRound => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      item.id.length === 0 ||
      typeof item.projectId !== 'string' ||
      !projectIds.has(item.projectId) ||
      !isSafeNumber(item.position) ||
      !['draft', 'final'].includes(String(item.status)) ||
      typeof item.contentMd !== 'string' ||
      new TextEncoder().encode(item.contentMd).byteLength > MAX_ROUND_BYTES ||
      !isSafeNumber(item.createdAt) ||
      !isNullableTimestamp(item.finalizedAt) ||
      !isSafeNumber(item.updatedAt) ||
      !Number.isSafeInteger(item.revision) ||
      Number(item.revision) < 0 ||
      typeof item.note !== 'string' ||
      [...item.note].length > 120 ||
      /[\r\n]/.test(item.note) ||
      !isNullableTimestamp(item.deletedAt)
    ) {
      throw new Error('浏览器本地轮次记录无效')
    }
    return item as unknown as BrowserRound
  })
  const roundIds = new Set(rounds.map((round) => round.id))
  if (roundIds.size !== rounds.length) throw new Error('浏览器本地轮次 ID 重复')
  for (const project of projects) {
    if (
      rounds.filter(
        (round) =>
          round.projectId === project.id && round.status === 'draft' && round.deletedAt === null,
      ).length > 1
    ) {
      throw new Error('浏览器本地项目包含多个当前草稿')
    }
  }
  const rawViewStates = value.viewStates ?? []
  if (!Array.isArray(rawViewStates)) throw new Error('浏览器本地视图状态结构无效')
  const viewStates = rawViewStates.map((item): ProjectViewState => {
    if (
      !isRecord(item) ||
      typeof item.projectId !== 'string' ||
      !projectIds.has(item.projectId) ||
      (item.selectedRoundId !== null && typeof item.selectedRoundId !== 'string') ||
      (item.timelineAnchorRoundId !== null &&
        item.timelineAnchorRoundId !== undefined &&
        typeof item.timelineAnchorRoundId !== 'string') ||
      !isSafeNumber(item.anchorOffsetPx) ||
      !['wysiwyg', 'source'].includes(String(item.editorMode)) ||
      !isSafeNumber(item.cursorAnchor) ||
      !isSafeNumber(item.cursorHead) ||
      typeof item.detailOpen !== 'boolean' ||
      !isSafeNumber(item.updatedAt)
    ) {
      throw new Error('浏览器本地视图状态字段无效')
    }
    const liveReference = (roundId: unknown): string | null => {
      if (typeof roundId !== 'string') return null
      const round = rounds.find(
        (candidate) =>
          candidate.id === roundId &&
          candidate.projectId === item.projectId &&
          candidate.deletedAt === null,
      )
      return round?.id ?? null
    }
    const selectedRoundId = liveReference(item.selectedRoundId)
    const timelineAnchorRoundId = liveReference(item.timelineAnchorRoundId)
    // 视图状态属于便利数据：启动读取时直接修复已删除、已永久清理或跨项目的悬空引用。
    return {
      projectId: item.projectId,
      selectedRoundId,
      timelineAnchorRoundId,
      anchorOffsetPx: timelineAnchorRoundId ? item.anchorOffsetPx : 0,
      editorMode: item.editorMode as ProjectViewState['editorMode'],
      cursorAnchor: item.cursorAnchor,
      cursorHead: item.cursorHead,
      detailOpen: item.detailOpen,
      updatedAt: item.updatedAt,
    }
  })
  return {
    nextProjectNumber: value.nextProjectNumber as number,
    projects,
    rounds,
    settings: validatedSettings(value.settings ?? DEFAULT_SETTINGS),
    viewStates,
  }
}

function readDatabase(): BrowserDatabase {
  const raw = localStorage.getItem(DATABASE_KEY)
  if (!raw) return initialDatabase()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('浏览器本地数据库 JSON 损坏；原始数据已保留，未创建空库覆盖')
  }
  return validatedDatabase(parsed)
}

function writeDatabase(database: BrowserDatabase): void {
  try {
    // Web Storage 的单次 setItem 是原子操作；配额失败时旧值按规范保持不变，
    // 因此不引入容易产生额外恢复状态的双键协议。
    localStorage.setItem(DATABASE_KEY, JSON.stringify(database))
  } catch (error) {
    const candidate = error as { name?: string; code?: number }
    if (
      candidate?.name === 'QuotaExceededError' ||
      candidate?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      candidate?.code === 22 ||
      candidate?.code === 1014
    ) {
      throw new Error('浏览器本地存储空间已满；本次更改未写入，原有数据仍保持不变', {
        cause: error,
      })
    }
    throw error
  }
}

let fallbackMutationQueue: Promise<void> = Promise.resolve()

async function mutateDatabase<T>(operation: (database: BrowserDatabase) => T): Promise<T> {
  const run = () => {
    const database = readDatabase()
    const result = operation(database)
    writeDatabase(database)
    return result
  }
  if (navigator.locks) {
    return navigator.locks.request(DATABASE_LOCK_KEY, run)
  }
  const previous = fallbackMutationQueue
  let release!: () => void
  fallbackMutationQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return run()
  } finally {
    release()
  }
}

function projectSummary(database: BrowserDatabase, project: BrowserProject): ProjectSummary {
  const liveRounds = database.rounds.filter(
    (round) => round.projectId === project.id && round.deletedAt === null,
  )
  return {
    id: project.id,
    name: project.name,
    isPinned: project.isPinned,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt,
    roundCount: liveRounds.filter((round) => round.status === 'final').length,
    hasDraft: liveRounds.some(
      (round) => round.status === 'draft' && round.contentMd.trim().length > 0,
    ),
  }
}

function liveProject(database: BrowserDatabase, id: string): BrowserProject {
  const project = database.projects.find((item) => item.id === id && item.deletedAt === null)
  if (!project) throw new Error('项目不存在或已删除')
  return project
}

function liveRound(database: BrowserDatabase, id: string): BrowserRound {
  const round = database.rounds.find((item) => item.id === id && item.deletedAt === null)
  if (!round) throw new Error('轮次不存在或已删除')
  liveProject(database, round.projectId)
  return round
}

function summaries(database: BrowserDatabase): ProjectSummary[] {
  return database.projects
    .filter((project) => project.deletedAt === null)
    .sort(
      (left, right) =>
        Number(right.isPinned) - Number(left.isPinned) || right.lastOpenedAt - left.lastOpenedAt,
    )
    .map((project) => projectSummary(database, project))
}

function roundSummary(round: BrowserRound): RoundSummary {
  return {
    id: round.id,
    projectId: round.projectId,
    position: round.position,
    status: round.status,
    previewMd: truncateUtf16Safely(round.contentMd, 8192),
    createdAt: round.createdAt,
    finalizedAt: round.finalizedAt,
    updatedAt: round.updatedAt,
    revision: round.revision,
    note: round.note,
    charCount: [...round.contentMd].length,
  }
}

function detail(round: BrowserRound): RoundDetail {
  return clone({
    id: round.id,
    projectId: round.projectId,
    position: round.position,
    status: round.status,
    contentMd: round.contentMd,
    createdAt: round.createdAt,
    finalizedAt: round.finalizedAt,
    updatedAt: round.updatedAt,
    revision: round.revision,
    note: round.note,
  })
}

function clearRoundViewStateReferences(database: BrowserDatabase, roundId: string): void {
  for (const viewState of database.viewStates) {
    if (viewState.selectedRoundId === roundId) viewState.selectedRoundId = null
    if (viewState.timelineAnchorRoundId === roundId) {
      viewState.timelineAnchorRoundId = null
      viewState.anchorOffsetPx = 0
    }
  }
}

function validatedProjectName(name: string): string {
  const trimmed = name.trim()
  if ([...trimmed].length > 120) throw new Error('项目名称不能超过 120 个字符')
  if ([...trimmed].some(isControlCharacter)) {
    throw new Error('项目名称不能包含换行、制表符或其他控制字符')
  }
  return trimmed
}

function newProjectName(database: BrowserDatabase, name?: string | null): string {
  const trimmed = name?.trim() ?? ''
  const number = database.nextProjectNumber
  database.nextProjectNumber += 1
  return trimmed ? validatedProjectName(trimmed) : `Vibe Coding 项目-${number}`
}

function renamedProjectName(database: BrowserDatabase, name: string): string {
  const trimmed = name.trim()
  if (trimmed) return validatedProjectName(trimmed)
  const number = database.nextProjectNumber
  database.nextProjectNumber += 1
  return `Vibe Coding 项目-${number}`
}

function validateRoundMutation(contentMd: string, note: string): string {
  if (new TextEncoder().encode(contentMd).byteLength > MAX_ROUND_BYTES) {
    throw new Error('单轮内容已达到 10 MiB 安全上限；请先删除或拆分内容')
  }
  const normalizedNote = note.trim()
  if ([...normalizedNote].length > 120 || /[\r\n]/.test(note)) {
    throw new Error('轮次备注必须是 120 字以内的单行文字')
  }
  return normalizedNote
}

function matchInfo(
  content: string,
  query: string,
): { excerpt: string; start: number; end: number } {
  const characters = [...content]
  const range = caseInsensitiveUtf16Range(content, query)
  const start = range?.start ?? 0
  const excerptStart = Math.max(0, [...content.slice(0, start)].length - 42)
  return {
    excerpt: characters
      .slice(excerptStart, excerptStart + 140)
      .join('')
      .replace(/[\r\n]+/g, ' '),
    // CodeMirror 使用 JavaScript 原生 UTF-16 offset；不要转换成 Unicode 标量数量。
    start,
    end: range?.end ?? Math.min(content.length, query.length),
  }
}

export const browserRepository = {
  async bootstrap(): Promise<BootstrapData> {
    // 初始化和首次写入也必须与普通 mutation 共用同一把锁，避免多标签页 lost update。
    const database = await mutateDatabase((current) => clone(current))
    const projects = summaries(database)
    const selectedProjectId = projects.some((item) => item.id === database.settings.lastProjectId)
      ? database.settings.lastProjectId
      : (projects[0]?.id ?? null)
    return {
      projects,
      settings: clone(database.settings),
      selectedProjectId,
      dataDir: '浏览器验收模式 · 本机 localStorage',
      appVersion: '0.0.0-web',
      ftsEnabled: false,
      fonts: clone(CORE_FONTS),
      databaseBytes: 0,
      databaseWarnBytes: 7680 * 1024 * 1024,
      databaseLimitBytes: 8 * 1024 * 1024 * 1024,
      dataInSyncDir: false,
    }
  },

  async listProjects(): Promise<ProjectSummary[]> {
    return summaries(readDatabase())
  },

  async createProject(name?: string): Promise<ProjectSummary> {
    return mutateDatabase((database) => {
      const timestamp = now()
      const project: BrowserProject = {
        id: createId(),
        name: newProjectName(database, name),
        isPinned: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
        deletedAt: null,
        revision: 0,
      }
      const draft: BrowserRound = {
        id: createId(),
        projectId: project.id,
        position: 2_147_483_647,
        status: 'draft',
        contentMd: '',
        createdAt: timestamp,
        finalizedAt: null,
        updatedAt: timestamp,
        revision: 0,
        note: '',
        deletedAt: null,
      }
      database.projects.push(project)
      database.rounds.push(draft)
      database.viewStates.push({
        projectId: project.id,
        selectedRoundId: draft.id,
        timelineAnchorRoundId: draft.id,
        anchorOffsetPx: 0,
        editorMode: database.settings.defaultEditorMode,
        cursorAnchor: 0,
        cursorHead: 0,
        detailOpen: true,
        updatedAt: timestamp,
      })
      return projectSummary(database, project)
    })
  },

  async renameProject(projectId: string, name: string): Promise<ProjectSummary> {
    return mutateDatabase((database) => {
      const project = liveProject(database, projectId)
      project.name = renamedProjectName(database, name)
      project.updatedAt = now()
      project.revision += 1
      return projectSummary(database, project)
    })
  },

  async toggleProjectPin(projectId: string): Promise<ProjectSummary> {
    return mutateDatabase((database) => {
      const project = liveProject(database, projectId)
      project.isPinned = !project.isPinned
      project.updatedAt = now()
      project.revision += 1
      return projectSummary(database, project)
    })
  },

  async openProject(projectId: string): Promise<void> {
    await mutateDatabase((database) => {
      const project = liveProject(database, projectId)
      project.lastOpenedAt = now()
      database.settings.lastProjectId = projectId
    })
  },

  async deleteProject(projectId: string): Promise<void> {
    await mutateDatabase((database) => {
      const project = liveProject(database, projectId)
      project.deletedAt = now()
      project.revision += 1
    })
  },

  async restoreProject(projectId: string): Promise<ProjectSummary> {
    return mutateDatabase((database) => {
      const project = database.projects.find(
        (item) => item.id === projectId && item.deletedAt !== null,
      )
      if (!project) throw new Error('最近删除中没有该项目')
      project.deletedAt = null
      project.lastOpenedAt = now()
      project.revision += 1
      return projectSummary(database, project)
    })
  },

  async listRounds(projectId: string): Promise<RoundSummary[]> {
    const database = readDatabase()
    liveProject(database, projectId)
    return database.rounds
      .filter((round) => round.projectId === projectId && round.deletedAt === null)
      .sort(
        (left, right) =>
          Number(left.status === 'draft') - Number(right.status === 'draft') ||
          left.position - right.position,
      )
      .map(roundSummary)
  },

  async getRound(roundId: string): Promise<RoundDetail> {
    return detail(liveRound(readDatabase(), roundId))
  },

  async saveRound(
    roundId: string,
    contentMd: string,
    note: string,
    expectedRevision: number,
  ): Promise<SaveRoundResult> {
    const normalizedNote = validateRoundMutation(contentMd, note)
    return mutateDatabase((database) => {
      const round = liveRound(database, roundId)
      if (round.revision !== expectedRevision) {
        throw new Error(
          `REVISION_CONFLICT:期望版本 ${expectedRevision}，数据库版本 ${round.revision}`,
        )
      }
      const savedAt = now()
      round.contentMd = contentMd
      round.note = normalizedNote
      round.updatedAt = savedAt
      round.revision += 1
      const project = liveProject(database, round.projectId)
      project.updatedAt = savedAt
      project.lastOpenedAt = savedAt
      project.revision += 1
      return { revision: round.revision, savedAt, databaseBytes: 0 }
    })
  },

  async resolveConflictKeepBoth(
    roundId: string,
    localContentMd: string,
    localNote: string,
  ): Promise<RoundDetail> {
    const normalizedNote = validateRoundMutation(localContentMd, localNote)
    return mutateDatabase((database) => {
      const original = liveRound(database, roundId)
      const timestamp = now()
      const liveFinals = database.rounds.filter(
        (round) =>
          round.projectId === original.projectId &&
          round.status === 'final' &&
          round.deletedAt === null,
      )
      const position =
        original.status === 'final'
          ? original.position + 1
          : Math.max(-1, ...liveFinals.map((round) => round.position)) + 1
      if (original.status === 'final') {
        liveFinals
          .filter((round) => round.position > original.position)
          .forEach((round) => {
            round.position += 1
          })
      }
      const recovered: BrowserRound = {
        id: createId(),
        projectId: original.projectId,
        position,
        status: 'final',
        contentMd: localContentMd,
        createdAt: timestamp,
        finalizedAt: timestamp,
        updatedAt: timestamp,
        revision: 0,
        note: normalizedNote,
        deletedAt: null,
      }
      database.rounds.push(recovered)
      const project = liveProject(database, original.projectId)
      project.updatedAt = timestamp
      project.lastOpenedAt = timestamp
      project.revision += 1
      return detail(recovered)
    })
  },

  async resolveConflictReplaceLocal(
    roundId: string,
    localContentMd: string,
    localNote: string,
    expectedRevision: number,
  ): Promise<RoundDetail> {
    const normalizedNote = validateRoundMutation(localContentMd, localNote)
    return mutateDatabase((database) => {
      const round = liveRound(database, roundId)
      if (round.revision !== expectedRevision) {
        throw new Error(
          `REVISION_CONFLICT:期望版本 ${expectedRevision}，数据库版本 ${round.revision}`,
        )
      }
      const timestamp = now()
      round.contentMd = localContentMd
      round.note = normalizedNote
      round.updatedAt = timestamp
      round.revision += 1
      const project = liveProject(database, round.projectId)
      project.updatedAt = timestamp
      project.lastOpenedAt = timestamp
      project.revision += 1
      return detail(round)
    })
  },

  async finalizeDraft(projectId: string): Promise<FinalizeResult> {
    return mutateDatabase((database) => {
      const project = liveProject(database, projectId)
      const draft = database.rounds.find(
        (round) =>
          round.projectId === projectId && round.status === 'draft' && round.deletedAt === null,
      )
      if (!draft) throw new Error('当前项目没有草稿')
      if (!draft.contentMd.trim()) throw new Error('空白草稿不会生成正式轮次')
      const timestamp = now()
      const position =
        Math.max(
          -1,
          ...database.rounds
            .filter(
              (round) =>
                round.projectId === projectId &&
                round.status === 'final' &&
                round.deletedAt === null,
            )
            .map((round) => round.position),
        ) + 1
      draft.status = 'final'
      draft.position = position
      draft.finalizedAt = timestamp
      draft.updatedAt = timestamp
      draft.revision += 1
      const nextDraft: BrowserRound = {
        id: createId(),
        projectId,
        position: 2_147_483_647,
        status: 'draft',
        contentMd: '',
        createdAt: timestamp,
        finalizedAt: null,
        updatedAt: timestamp,
        revision: 0,
        note: '',
        deletedAt: null,
      }
      database.rounds.push(nextDraft)
      project.updatedAt = timestamp
      project.lastOpenedAt = timestamp
      project.revision += 1
      const viewState = database.viewStates.find((item) => item.projectId === projectId)
      if (viewState) viewState.selectedRoundId = nextDraft.id
      return { finalizedRound: detail(draft), draft: detail(nextDraft) }
    })
  },

  async deleteRound(roundId: string): Promise<void> {
    await mutateDatabase((database) => {
      const round = liveRound(database, roundId)
      if (round.status === 'draft') {
        round.contentMd = ''
        round.note = ''
      } else {
        round.deletedAt = now()
        clearRoundViewStateReferences(database, roundId)
      }
      round.updatedAt = now()
      round.revision += 1
    })
  },

  async restoreRound(roundId: string): Promise<RoundDetail> {
    return mutateDatabase((database) => {
      const round = database.rounds.find((item) => item.id === roundId && item.deletedAt !== null)
      if (!round) throw new Error('最近删除中没有该轮次')
      if (round.status === 'final') {
        database.rounds
          .filter(
            (candidate) =>
              candidate.projectId === round.projectId &&
              candidate.status === 'final' &&
              candidate.deletedAt === null &&
              candidate.position >= round.position,
          )
          .forEach((candidate) => {
            candidate.position += 1
          })
      }
      round.deletedAt = null
      round.revision += 1
      return detail(round)
    })
  },

  async reorderRounds(projectId: string, orderedIds: string[]): Promise<void> {
    await mutateDatabase((database) => {
      const liveIds = database.rounds
        .filter(
          (round) =>
            round.projectId === projectId && round.status === 'final' && round.deletedAt === null,
        )
        .map((round) => round.id)
        .sort()
      if (JSON.stringify(liveIds) !== JSON.stringify([...orderedIds].sort())) {
        throw new Error('排序请求与当前轮次集合不一致，数据未被修改')
      }
      orderedIds.forEach((id, position) => {
        liveRound(database, id).position = position
      })
    })
  },

  async searchAll(query: string, limit = 100, offset = 0): Promise<SearchResult[]> {
    const database = readDatabase()
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    if (!needle) return []
    return database.rounds
      .filter((round) => round.deletedAt === null)
      .flatMap((round) => {
        const project = database.projects.find(
          (item) => item.id === round.projectId && item.deletedAt === null,
        )
        if (!project) return []
        const matched = [
          { value: round.contentMd, field: 'content' as const },
          { value: round.note, field: 'note' as const },
          { value: project.name, field: 'project' as const },
        ].find(({ value }) => value.toLocaleLowerCase('zh-CN').includes(needle))
        if (!matched) return []
        const match = matchInfo(matched.value, query.trim())
        return [
          {
            projectId: project.id,
            projectName: project.name,
            roundId: round.id,
            status: round.status,
            position:
              round.status === 'final'
                ? database.rounds
                    .filter(
                      (candidate) =>
                        candidate.projectId === round.projectId &&
                        candidate.status === 'final' &&
                        candidate.deletedAt === null,
                    )
                    .sort(
                      (left, right) =>
                        left.position - right.position || left.id.localeCompare(right.id),
                    )
                    .findIndex((candidate) => candidate.id === round.id)
                : round.position,
            note: round.note,
            excerpt: match.excerpt,
            matchStart: match.start,
            matchEnd: match.end,
            matchField: matched.field,
            updatedAt: round.updatedAt,
          } satisfies SearchResult,
        ]
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(offset, offset + Math.min(limit, 100))
  },

  async saveSettings(patch: Partial<AppSettings>): Promise<void> {
    await mutateDatabase((database) => {
      database.settings = clone(validatedSettings({ ...database.settings, ...patch }))
    })
  },

  async getViewState(projectId: string): Promise<ProjectViewState | null> {
    return clone(readDatabase().viewStates.find((item) => item.projectId === projectId) ?? null)
  },

  async saveViewState(viewState: ProjectViewState): Promise<void> {
    await mutateDatabase((database) => {
      liveProject(database, viewState.projectId)
      for (const roundId of [viewState.selectedRoundId, viewState.timelineAnchorRoundId]) {
        if (roundId && liveRound(database, roundId).projectId !== viewState.projectId) {
          throw new Error('视图状态引用了不属于当前项目的轮次')
        }
      }
      const index = database.viewStates.findIndex((item) => item.projectId === viewState.projectId)
      if (index >= 0) database.viewStates[index] = clone(viewState)
      else database.viewStates.push(clone(viewState))
    })
  },

  async listTrash(): Promise<TrashItem[]> {
    const database = readDatabase()
    return [
      ...database.projects
        .filter((project) => project.deletedAt !== null)
        .map(
          (project) =>
            ({
              id: project.id,
              kind: 'project',
              name: project.name,
              projectId: null,
              deletedAt: project.deletedAt ?? 0,
            }) satisfies TrashItem,
        ),
      ...database.rounds
        .filter((round) => round.deletedAt !== null)
        .map(
          (round) =>
            ({
              id: round.id,
              kind: 'round',
              name: round.note || round.contentMd.replace(/[\r\n]+/g, ' ').slice(0, 60) || '空轮次',
              projectId: round.projectId,
              deletedAt: round.deletedAt ?? 0,
            }) satisfies TrashItem,
        ),
    ].sort((left, right) => right.deletedAt - left.deletedAt)
  },

  async permanentlyDelete(kind: 'project' | 'round', id: string): Promise<void> {
    await mutateDatabase((database) => {
      if (kind === 'project') {
        const project = database.projects.find((item) => item.id === id && item.deletedAt !== null)
        if (!project) throw new Error('最近删除中没有该项目')
        database.projects = database.projects.filter((item) => item.id !== id)
        database.rounds = database.rounds.filter((round) => round.projectId !== id)
        database.viewStates = database.viewStates.filter((state) => state.projectId !== id)
      } else {
        const round = database.rounds.find((item) => item.id === id && item.deletedAt !== null)
        if (!round) throw new Error('最近删除中没有该轮次')
        clearRoundViewStateReferences(database, id)
        database.rounds = database.rounds.filter((item) => item.id !== id)
      }
    })
  },

  async setAlwaysOnTop(enabled: boolean): Promise<void> {
    await mutateDatabase((database) => {
      database.settings.alwaysOnTop = enabled
    })
  },

  async databaseHealth(): Promise<boolean> {
    readDatabase()
    return true
  },

  async fetchRemoteImage(_url: string): Promise<RemoteImageData> {
    void _url
    throw new Error('安全远程图片加载仅在 Windows 应用中可用')
  },

  async exportProjectPackage(_projectId: string, suggestedName: string): Promise<ExportResult> {
    void _projectId
    return { path: suggestedName, byteCount: 0, sha256: 'browser-acceptance-adapter' }
  },

  async importProjectPackage(): Promise<ProjectSummary> {
    throw new Error('浏览器验收壳不读本机归档；请在 Windows 应用中导入')
  },

  async createManualBackup(suggestedName: string): Promise<BackupInfo> {
    return {
      path: suggestedName,
      byteCount: 0,
      sha256: 'browser-acceptance-adapter',
      createdAt: now(),
      includesFonts: true,
    }
  },

  async prepareBackupRestore(): Promise<RestorePreparation> {
    throw new Error('完整恢复只在 Windows 原生应用中执行')
  },

  async cancelPreparedRestore(): Promise<void> {},

  async runAutoBackup(): Promise<BackupInfo | null> {
    return null
  },

  async listFonts(): Promise<FontFaceInfo[]> {
    return clone(CORE_FONTS)
  },

  async importFontFiles(): Promise<FontFaceInfo[]> {
    throw new Error('字体文件导入请在 Windows 应用中执行')
  },

  async removeImportedFont(_fontId: string): Promise<FontFaceInfo[]> {
    void _fontId
    return clone(CORE_FONTS)
  },

  async exportProjectMarkdown(_projectId: string, suggestedName: string): Promise<ExportResult> {
    void _projectId
    return { path: suggestedName, byteCount: 0, sha256: 'browser-acceptance-adapter' }
  },

  async exportAllMarkdown(): Promise<ExportResult> {
    return { path: 'browser-export', byteCount: 0, sha256: 'browser-acceptance-adapter' }
  },

  async importMarkdown(): Promise<ProjectSummary> {
    throw new Error('Markdown 文件导入请在 Windows 应用中执行')
  },

  async saveWindowState(_windowState: WindowState): Promise<void> {
    void _windowState
  },

  async markCleanShutdown(_generation: number): Promise<void> {
    void _generation
  },

  async cancelCleanShutdown(_generation: number): Promise<void> {
    void _generation
  },

  async saveTextFile(suggestedName: string, content: string): Promise<ExportResult> {
    return {
      path: suggestedName,
      byteCount: new TextEncoder().encode(content).byteLength,
      sha256: 'browser-acceptance-adapter',
    }
  },
}

export function resetBrowserRepository(): void {
  localStorage.removeItem(DATABASE_KEY)
}
