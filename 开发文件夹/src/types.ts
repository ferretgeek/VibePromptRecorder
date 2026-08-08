export type ThemeId = 'system' | 'neutral' | 'warm' | 'mint' | 'lavender' | 'graphite'
export type EditorMode = 'wysiwyg' | 'source'
export type RoundStatus = 'draft' | 'final'
export type SaveState = 'saved' | 'pending' | 'saving' | 'failed'

export interface ProjectSummary {
  id: string
  name: string
  isPinned: boolean
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  roundCount: number
  hasDraft: boolean
}

export interface RoundSummary {
  id: string
  projectId: string
  position: number
  status: RoundStatus
  previewMd: string
  createdAt: number
  finalizedAt: number | null
  updatedAt: number
  revision: number
  note: string
  charCount: number
}

export interface RoundDetail {
  id: string
  projectId: string
  position: number
  status: RoundStatus
  contentMd: string
  createdAt: number
  finalizedAt: number | null
  updatedAt: number
  revision: number
  note: string
}

export interface SaveRoundResult {
  revision: number
  savedAt: number
  databaseBytes: number
}

export interface FinalizeResult {
  finalizedRound: RoundDetail
  draft: RoundDetail
}

export interface SearchResult {
  projectId: string
  projectName: string
  roundId: string
  status: RoundStatus
  position: number
  note: string
  excerpt: string
  matchStart: number
  matchEnd: number
  matchField: 'content' | 'note' | 'project'
  updatedAt: number
}

export interface TrashItem {
  id: string
  kind: 'project' | 'round'
  name: string
  projectId: string | null
  deletedAt: number
}

export interface FontFaceInfo {
  id: string
  family: string
  source: 'builtin' | 'system' | 'imported'
  isMonospace: boolean
  weights: number[]
  available: boolean
  url?: string | null
  removable?: boolean
}

export interface AppSettings {
  formatVersion: 1
  theme: ThemeId
  previewLines: number
  showRoundNumbers: boolean
  defaultEditorMode: EditorMode
  alwaysOnTop: boolean
  codeWrap: boolean
  uiFontFamily: string
  uiFontSize: number
  uiFontWeight: number
  bodyFontFamily: string
  bodyFontSize: number
  bodyFontWeight: number
  bodyLineHeight: number
  codeFontFamily: string
  codeFontSize: number
  codeFontWeight: number
  codeLineHeight: number
  uiFallbackFamilies: string[]
  bodyFallbackFamilies: string[]
  codeFallbackFamilies: string[]
  favoriteFontIds: string[]
  recentFontIds: string[]
  projectPanelWidth: number
  timelinePanelWidth: number
  autoBackup: boolean
  lastProjectId: string | null
}

export interface ProjectViewState {
  projectId: string
  selectedRoundId: string | null
  timelineAnchorRoundId: string | null
  anchorOffsetPx: number
  editorMode: EditorMode
  cursorAnchor: number
  cursorHead: number
  detailOpen: boolean
  updatedAt: number
}

export interface BootstrapData {
  projects: ProjectSummary[]
  settings: AppSettings
  selectedProjectId: string | null
  dataDir: string
  appVersion: string
  ftsEnabled: boolean
  fonts: FontFaceInfo[]
  databaseBytes: number
  databaseWarnBytes: number
  databaseLimitBytes: number
  dataInSyncDir: boolean
}

export interface ExportResult {
  path: string
  byteCount: number
  sha256: string
}

export interface BackupInfo extends ExportResult {
  createdAt: number
  includesFonts: boolean
}

export interface RestorePreparation {
  restoreId: string
  backupPath: string
  recoveryPointPath: string
  requiresRestart: boolean
}

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
  scaleFactor: number
  monitorName: string | null
}

export interface RemoteImageData {
  dataUrl: string
  byteCount: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  formatVersion: 1,
  theme: 'neutral',
  previewLines: 5,
  showRoundNumbers: true,
  defaultEditorMode: 'wysiwyg',
  alwaysOnTop: false,
  codeWrap: false,
  uiFontFamily: 'MiSans',
  uiFontSize: 14,
  uiFontWeight: 400,
  bodyFontFamily: 'MiSans',
  bodyFontSize: 16,
  bodyFontWeight: 400,
  bodyLineHeight: 1.65,
  codeFontFamily: 'Sarasa Mono SC',
  codeFontSize: 14,
  codeFontWeight: 400,
  codeLineHeight: 1.55,
  uiFallbackFamilies: [
    'Segoe UI Variable Text',
    'Segoe UI',
    'Microsoft YaHei UI',
    'Segoe UI Emoji',
  ],
  bodyFallbackFamilies: ['HarmonyOS Sans SC', 'Microsoft YaHei', 'Segoe UI Emoji'],
  codeFallbackFamilies: ['Cascadia Mono', 'Consolas', 'Microsoft YaHei UI', 'Segoe UI Emoji'],
  favoriteFontIds: [],
  recentFontIds: [],
  projectPanelWidth: 236,
  timelinePanelWidth: 340,
  autoBackup: true,
  lastProjectId: null,
}

export const CORE_FONTS: FontFaceInfo[] = [
  {
    id: 'core-misans',
    family: 'MiSans',
    source: 'builtin',
    isMonospace: false,
    weights: [400, 500, 600, 700],
    available: true,
  },
  {
    id: 'core-harmony',
    family: 'HarmonyOS Sans SC',
    source: 'builtin',
    isMonospace: false,
    weights: [400, 500, 700],
    available: true,
  },
  {
    id: 'core-mona',
    family: 'Mona Sans',
    source: 'builtin',
    isMonospace: false,
    weights: [400, 500, 600, 700],
    available: true,
  },
  {
    id: 'core-sarasa',
    family: 'Sarasa Mono SC',
    source: 'builtin',
    isMonospace: true,
    weights: [400, 700],
    available: true,
  },
  {
    id: 'system-segoe',
    family: 'Segoe UI',
    source: 'system',
    isMonospace: false,
    weights: [400, 600, 700],
    available: true,
  },
  {
    id: 'system-yahei',
    family: 'Microsoft YaHei UI',
    source: 'system',
    isMonospace: false,
    weights: [400, 700],
    available: true,
  },
  {
    id: 'system-cascadia',
    family: 'Cascadia Mono',
    source: 'system',
    isMonospace: true,
    weights: [400, 600, 700],
    available: true,
  },
  {
    id: 'system-consolas',
    family: 'Consolas',
    source: 'system',
    isMonospace: true,
    weights: [400, 700],
    available: true,
  },
]
