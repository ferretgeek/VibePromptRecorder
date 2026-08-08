import { invoke } from '@tauri-apps/api/core'
import type {
  AppSettings,
  BackupInfo,
  BootstrapData,
  FinalizeResult,
  FontFaceInfo,
  ProjectSummary,
  ProjectViewState,
  RestorePreparation,
  RoundDetail,
  RoundSummary,
  SaveRoundResult,
  SearchResult,
  TrashItem,
  ExportResult,
  WindowState,
  RemoteImageData,
} from '../types'
import { browserRepository } from './browserRepository'

export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) return invoke<T>(command, args)
  const browserMethod = browserRepository[commandToBrowserMethod(command)] as (
    ...values: unknown[]
  ) => Promise<T>
  return browserMethod(...commandArguments(command, args))
}

function commandToBrowserMethod(command: string): keyof typeof browserRepository {
  const mapping: Record<string, keyof typeof browserRepository> = {
    bootstrap: 'bootstrap',
    list_projects: 'listProjects',
    create_project: 'createProject',
    rename_project: 'renameProject',
    toggle_project_pin: 'toggleProjectPin',
    open_project: 'openProject',
    delete_project: 'deleteProject',
    restore_project: 'restoreProject',
    list_rounds: 'listRounds',
    get_round: 'getRound',
    save_round: 'saveRound',
    resolve_conflict_keep_both: 'resolveConflictKeepBoth',
    resolve_conflict_replace_local: 'resolveConflictReplaceLocal',
    finalize_draft: 'finalizeDraft',
    delete_round: 'deleteRound',
    restore_round: 'restoreRound',
    reorder_rounds: 'reorderRounds',
    search_all: 'searchAll',
    save_settings: 'saveSettings',
    get_view_state: 'getViewState',
    save_view_state: 'saveViewState',
    list_trash: 'listTrash',
    permanently_delete: 'permanentlyDelete',
    set_always_on_top: 'setAlwaysOnTop',
    database_health: 'databaseHealth',
    fetch_remote_image: 'fetchRemoteImage',
    export_project_package: 'exportProjectPackage',
    save_text_file: 'saveTextFile',
    import_project_package: 'importProjectPackage',
    create_manual_backup: 'createManualBackup',
    prepare_backup_restore: 'prepareBackupRestore',
    cancel_prepared_restore: 'cancelPreparedRestore',
    run_auto_backup: 'runAutoBackup',
    list_fonts: 'listFonts',
    import_font_files: 'importFontFiles',
    remove_imported_font: 'removeImportedFont',
    export_project_markdown: 'exportProjectMarkdown',
    export_all_markdown: 'exportAllMarkdown',
    import_markdown: 'importMarkdown',
    save_window_state: 'saveWindowState',
    mark_clean_shutdown: 'markCleanShutdown',
    cancel_clean_shutdown: 'cancelCleanShutdown',
  }
  const method = mapping[command]
  if (!method) throw new Error(`浏览器验收壳尚未实现命令：${command}`)
  return method
}

function commandArguments(command: string, args: Record<string, unknown> = {}): unknown[] {
  const keys: Record<string, string[]> = {
    bootstrap: [],
    list_projects: [],
    create_project: ['name'],
    rename_project: ['projectId', 'name'],
    toggle_project_pin: ['projectId'],
    open_project: ['projectId'],
    delete_project: ['projectId'],
    restore_project: ['projectId'],
    list_rounds: ['projectId'],
    get_round: ['roundId'],
    save_round: ['roundId', 'contentMd', 'note', 'expectedRevision'],
    resolve_conflict_keep_both: ['roundId', 'localContentMd', 'localNote'],
    resolve_conflict_replace_local: ['roundId', 'localContentMd', 'localNote', 'expectedRevision'],
    finalize_draft: ['projectId'],
    delete_round: ['roundId'],
    restore_round: ['roundId'],
    reorder_rounds: ['projectId', 'orderedIds'],
    search_all: ['query', 'limit', 'offset'],
    save_settings: ['patch'],
    get_view_state: ['projectId'],
    save_view_state: ['viewState'],
    list_trash: [],
    permanently_delete: ['kind', 'id'],
    set_always_on_top: ['enabled'],
    database_health: [],
    fetch_remote_image: ['url'],
    export_project_package: ['projectId', 'suggestedName'],
    save_text_file: ['suggestedName', 'content'],
    import_project_package: [],
    create_manual_backup: ['suggestedName'],
    prepare_backup_restore: [],
    cancel_prepared_restore: [],
    run_auto_backup: [],
    list_fonts: [],
    import_font_files: [],
    remove_imported_font: ['fontId'],
    export_project_markdown: ['projectId', 'suggestedName'],
    export_all_markdown: [],
    import_markdown: [],
    save_window_state: ['windowState'],
    mark_clean_shutdown: ['generation'],
    cancel_clean_shutdown: ['generation'],
  }
  return (keys[command] ?? []).map((key) => args[key])
}

export const api = {
  bootstrap: (): Promise<BootstrapData> => call('bootstrap'),
  listProjects: (): Promise<ProjectSummary[]> => call('list_projects'),
  createProject: (name?: string): Promise<ProjectSummary> => call('create_project', { name }),
  renameProject: (projectId: string, name: string): Promise<ProjectSummary> =>
    call('rename_project', { projectId, name }),
  toggleProjectPin: (projectId: string): Promise<ProjectSummary> =>
    call('toggle_project_pin', { projectId }),
  openProject: (projectId: string): Promise<void> => call('open_project', { projectId }),
  deleteProject: (projectId: string): Promise<void> => call('delete_project', { projectId }),
  restoreProject: (projectId: string): Promise<ProjectSummary> =>
    call('restore_project', { projectId }),
  listRounds: (projectId: string): Promise<RoundSummary[]> => call('list_rounds', { projectId }),
  getRound: (roundId: string): Promise<RoundDetail> => call('get_round', { roundId }),
  saveRound: (
    roundId: string,
    contentMd: string,
    note: string,
    expectedRevision: number,
  ): Promise<SaveRoundResult> => call('save_round', { roundId, contentMd, note, expectedRevision }),
  resolveConflictKeepBoth: (
    roundId: string,
    localContentMd: string,
    localNote: string,
  ): Promise<RoundDetail> =>
    call('resolve_conflict_keep_both', { roundId, localContentMd, localNote }),
  resolveConflictReplaceLocal: (
    roundId: string,
    localContentMd: string,
    localNote: string,
    expectedRevision: number,
  ): Promise<RoundDetail> =>
    call('resolve_conflict_replace_local', {
      roundId,
      localContentMd,
      localNote,
      expectedRevision,
    }),
  finalizeDraft: (projectId: string): Promise<FinalizeResult> =>
    call('finalize_draft', { projectId }),
  deleteRound: (roundId: string): Promise<void> => call('delete_round', { roundId }),
  restoreRound: (roundId: string): Promise<RoundDetail> => call('restore_round', { roundId }),
  reorderRounds: (projectId: string, orderedIds: string[]): Promise<void> =>
    call('reorder_rounds', { projectId, orderedIds }),
  searchAll: (query: string, limit = 100, offset = 0): Promise<SearchResult[]> =>
    call('search_all', { query, limit, offset }),
  saveSettings: (patch: Partial<AppSettings>): Promise<void> => call('save_settings', { patch }),
  getViewState: (projectId: string): Promise<ProjectViewState | null> =>
    call('get_view_state', { projectId }),
  saveViewState: (viewState: ProjectViewState): Promise<void> =>
    call('save_view_state', { viewState }),
  listTrash: (): Promise<TrashItem[]> => call('list_trash'),
  permanentlyDelete: (kind: 'project' | 'round', id: string): Promise<void> =>
    call('permanently_delete', { kind, id }),
  setAlwaysOnTop: (enabled: boolean): Promise<void> => call('set_always_on_top', { enabled }),
  databaseHealth: (): Promise<boolean> => call('database_health'),
  fetchRemoteImage: (url: string): Promise<RemoteImageData> => call('fetch_remote_image', { url }),
  exportProjectPackage: (projectId: string, suggestedName: string): Promise<ExportResult | null> =>
    call('export_project_package', { projectId, suggestedName }),
  importProjectPackage: (): Promise<ProjectSummary | null> => call('import_project_package'),
  createManualBackup: (suggestedName: string): Promise<BackupInfo | null> =>
    call('create_manual_backup', { suggestedName }),
  prepareBackupRestore: (): Promise<RestorePreparation | null> => call('prepare_backup_restore'),
  cancelPreparedRestore: (): Promise<void> => call('cancel_prepared_restore'),
  runAutoBackup: (): Promise<BackupInfo | null> => call('run_auto_backup'),
  listFonts: (): Promise<FontFaceInfo[]> => call('list_fonts'),
  importFontFiles: (): Promise<FontFaceInfo[] | null> => call('import_font_files'),
  removeImportedFont: (fontId: string): Promise<FontFaceInfo[]> =>
    call('remove_imported_font', { fontId }),
  exportProjectMarkdown: (projectId: string, suggestedName: string): Promise<ExportResult | null> =>
    call('export_project_markdown', { projectId, suggestedName }),
  exportAllMarkdown: (): Promise<ExportResult | null> => call('export_all_markdown'),
  importMarkdown: (): Promise<ProjectSummary | null> => call('import_markdown'),
  saveWindowState: (windowState: WindowState): Promise<void> =>
    call('save_window_state', { windowState }),
  markCleanShutdown: (generation: number): Promise<void> =>
    call('mark_clean_shutdown', { generation }),
  cancelCleanShutdown: (generation: number): Promise<void> =>
    call('cancel_clean_shutdown', { generation }),
  saveTextFile: (suggestedName: string, content: string): Promise<ExportResult | null> =>
    call('save_text_file', { suggestedName, content }),
}

export async function writeClipboard(text: string): Promise<void> {
  if (isTauri()) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
    return
  }
  await navigator.clipboard.writeText(text)
}
