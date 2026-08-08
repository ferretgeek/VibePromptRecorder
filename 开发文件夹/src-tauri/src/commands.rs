use crate::{
    AppState, archive, db,
    error::{AppError, AppResult},
    fonts, markdown_io,
    models::{
        AppSettingsPatch, BootstrapData, ProjectSummary, ProjectViewState, RoundDetail,
        RoundSummary, SaveRoundResult, SearchResult, TrashItem,
    },
    remote_images,
};
use rusqlite::{Connection, OpenFlags, backup::Backup};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{State, WebviewWindow};

fn validated_suggested_name(name: &str, extension: &str) -> AppResult<String> {
    let path = std::path::Path::new(name);
    let is_file_name = path.file_name().and_then(|value| value.to_str()) == Some(name);
    let has_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension));
    if !is_file_name
        || !has_extension
        || name.encode_utf16().count() > 200
        || name.chars().any(char::is_control)
    {
        return Err(AppError::Validation("建议文件名不安全或扩展名无效".into()));
    }
    Ok(name.to_string())
}

fn choose_save_file(name: &str, extension: &str, filter: &str) -> AppResult<Option<PathBuf>> {
    let name = validated_suggested_name(name, extension)?;
    Ok(rfd::FileDialog::new()
        .set_title("选择安全的导出位置")
        .set_file_name(name)
        .add_filter(filter, &[extension])
        .save_file())
}

fn choose_open_file(extension: &str, filter: &str) -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_title("选择要安全读取的本地文件")
        .add_filter(filter, &[extension])
        .pick_file()
}

fn choose_font_files() -> Option<Vec<PathBuf>> {
    rfd::FileDialog::new()
        .set_title("选择要导入的字体文件")
        .add_filter("字体文件", &["ttf", "otf", "woff", "woff2"])
        .pick_files()
}

fn open_read_connection(state: &AppState) -> AppResult<Connection> {
    let connection = Connection::open_with_flags(
        state.paths.database.join("app.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.execute_batch("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;")?;
    Ok(connection)
}

struct ReadSnapshot {
    connection: Option<Connection>,
    path: PathBuf,
}

impl ReadSnapshot {
    fn connection(&self) -> &Connection {
        self.connection.as_ref().expect("snapshot connection")
    }
}

impl Drop for ReadSnapshot {
    fn drop(&mut self) {
        drop(self.connection.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

fn open_export_snapshot(state: &AppState) -> AppResult<ReadSnapshot> {
    let source = open_read_connection(state)?;
    let path = state
        .paths
        .temp
        .join(format!("read-snapshot-{}.sqlite3", uuid::Uuid::new_v4()));
    let mut destination = Connection::open(&path)?;
    {
        let backup = Backup::new(&source, &mut destination)?;
        backup.run_to_completion(128, Duration::from_millis(5), None)?;
    }
    destination.close().map_err(|(_, error)| error)?;
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.execute_batch("PRAGMA query_only=ON;")?;
    Ok(ReadSnapshot {
        connection: Some(connection),
        path,
    })
}

#[tauri::command]
pub async fn bootstrap(state: State<'_, AppState>) -> AppResult<BootstrapData> {
    let connection = state.db.lock();
    let settings = db::load_settings(&connection)?;
    let projects = db::list_projects(&connection)?;
    let selected_project_id = settings
        .last_project_id
        .clone()
        .filter(|id| projects.iter().any(|project| &project.id == id))
        .or_else(|| projects.first().map(|project| project.id.clone()));
    Ok(BootstrapData {
        projects,
        settings,
        selected_project_id,
        data_dir: state.paths.root.to_string_lossy().into_owned(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        fts_enabled: true,
        fonts: fonts::list_fonts(&connection)?,
        database_bytes: db::database_size_bytes(&connection)?,
        database_warn_bytes: db::DATABASE_WARN_BYTES,
        database_limit_bytes: db::DATABASE_HARD_LIMIT_BYTES,
        data_in_sync_dir: state.paths.in_sync_directory,
    })
}

#[tauri::command]
pub async fn create_project(
    state: State<'_, AppState>,
    name: Option<String>,
) -> AppResult<ProjectSummary> {
    db::create_project(&state.db.lock(), name.as_deref())
}

#[tauri::command]
pub async fn rename_project(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
) -> AppResult<ProjectSummary> {
    db::rename_project(&state.db.lock(), &project_id, &name)
}

#[tauri::command]
pub async fn toggle_project_pin(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<ProjectSummary> {
    db::toggle_project_pin(&state.db.lock(), &project_id)
}

#[tauri::command]
pub async fn open_project(state: State<'_, AppState>, project_id: String) -> AppResult<()> {
    db::touch_project(&state.db.lock(), &project_id)
}

#[tauri::command]
pub async fn delete_project(state: State<'_, AppState>, project_id: String) -> AppResult<()> {
    db::delete_project(&state.db.lock(), &project_id)
}

#[tauri::command]
pub async fn restore_project(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<ProjectSummary> {
    db::restore_project(&state.db.lock(), &project_id)
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<ProjectSummary>> {
    db::list_projects(&state.db.lock())
}

#[tauri::command]
pub async fn list_rounds(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<Vec<RoundSummary>> {
    db::list_rounds(&state.db.lock(), &project_id)
}

#[tauri::command]
pub async fn get_round(state: State<'_, AppState>, round_id: String) -> AppResult<RoundDetail> {
    db::get_round(&state.db.lock(), &round_id)
}

#[tauri::command]
pub async fn save_round(
    state: State<'_, AppState>,
    round_id: String,
    content_md: String,
    note: String,
    expected_revision: i64,
) -> AppResult<SaveRoundResult> {
    db::save_round(
        &state.db.lock(),
        &round_id,
        &content_md,
        &note,
        expected_revision,
    )
}

#[tauri::command]
pub async fn resolve_conflict_keep_both(
    state: State<'_, AppState>,
    round_id: String,
    local_content_md: String,
    local_note: String,
) -> AppResult<RoundDetail> {
    db::keep_both_after_conflict(&state.db.lock(), &round_id, &local_content_md, &local_note)
}

#[tauri::command]
pub async fn resolve_conflict_replace_local(
    state: State<'_, AppState>,
    round_id: String,
    local_content_md: String,
    local_note: String,
    expected_revision: i64,
) -> AppResult<RoundDetail> {
    let target = state.paths.recovery.join(format!(
        "conflict-before-{}-{}.vcpbackup",
        chrono::Utc::now().format("%Y%m%d-%H%M%S%3f"),
        uuid::Uuid::new_v4()
    ));
    let _font_operation = state.font_operations.lock();
    {
        let connection = state.db.lock();
        let current = db::get_round(&connection, &round_id)?;
        if current.revision != expected_revision {
            return Err(AppError::RevisionConflict(format!(
                "冲突处理开始前轮次已更新：期望版本 {expected_revision}，数据库版本 {}",
                current.revision
            )));
        }
    }
    // 在线快照后立即释放数据库锁；字体复制、哈希和 ZIP 压缩期间保存仍可继续。
    archive::create_backup_managed(&state.db, &state.paths, &target, true)?;
    archive::prune_conflict_backups(&state.paths.recovery)?;
    db::replace_round_after_conflict(
        &state.db.lock(),
        &round_id,
        &local_content_md,
        &local_note,
        expected_revision,
    )
}

#[tauri::command]
pub async fn finalize_draft(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<crate::models::FinalizeResult> {
    db::finalize_draft(&state.db.lock(), &project_id)
}

#[tauri::command]
pub async fn delete_round(state: State<'_, AppState>, round_id: String) -> AppResult<()> {
    db::delete_round(&state.db.lock(), &round_id)
}

#[tauri::command]
pub async fn restore_round(state: State<'_, AppState>, round_id: String) -> AppResult<RoundDetail> {
    db::restore_round(&state.db.lock(), &round_id)
}

#[tauri::command]
pub async fn reorder_rounds(
    state: State<'_, AppState>,
    project_id: String,
    ordered_ids: Vec<String>,
) -> AppResult<()> {
    db::reorder_rounds(&state.db.lock(), &project_id, &ordered_ids)
}

#[tauri::command]
pub async fn search_all(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<Vec<SearchResult>> {
    // 搜索只有一条 SQL，语句自身提供一致快照；无需把读事务延长到命令结束。
    let connection = open_read_connection(&state)?;
    let is_short_query = query.trim().chars().count() < 3;
    let deadline = Instant::now() + Duration::from_secs(1);
    // LIKE 与 FTS 都受同一时间护栏约束；搜索使用独立只读快照，不占用写连接。
    connection.progress_handler(10_000, Some(move || Instant::now() >= deadline))?;
    let result = db::search(
        &connection,
        &query,
        limit.unwrap_or(100),
        offset.unwrap_or(0),
    );
    connection.progress_handler(0, None::<fn() -> bool>)?;
    match result {
        Err(AppError::Database(rusqlite::Error::SqliteFailure(error, _)))
            if error.code == rusqlite::ErrorCode::OperationInterrupted =>
        {
            Err(AppError::Validation(if is_short_query {
                "短关键词搜索范围过大，请再输入一个字后重试".into()
            } else {
                "全文搜索耗时过长，请缩小关键词范围后重试".into()
            }))
        }
        other => other,
    }
}

#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    window: WebviewWindow,
    patch: AppSettingsPatch,
) -> AppResult<()> {
    let connection = state.db.lock();
    let previous = db::load_settings(&connection)?;
    let mut settings = previous.clone();
    patch.apply(&mut settings);
    let top_changed = previous.always_on_top != settings.always_on_top;
    if top_changed {
        window
            .set_always_on_top(settings.always_on_top)
            .map_err(|error| AppError::Validation(format!("窗口置顶状态应用失败：{error}")))?;
    }
    if let Err(error) = db::save_settings(&connection, &settings) {
        if top_changed {
            window
                .set_always_on_top(previous.always_on_top)
                .map_err(|rollback_error| {
                    AppError::Validation(format!(
                        "设置保存失败，且窗口置顶状态回滚失败：{error}；{rollback_error}"
                    ))
                })?;
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_view_state(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<Option<ProjectViewState>> {
    db::get_view_state(&state.db.lock(), &project_id)
}

#[tauri::command]
pub async fn save_view_state(
    state: State<'_, AppState>,
    view_state: ProjectViewState,
) -> AppResult<()> {
    db::save_view_state(&state.db.lock(), &view_state)
}

#[tauri::command]
pub async fn list_trash(state: State<'_, AppState>) -> AppResult<Vec<TrashItem>> {
    db::list_trash(&state.db.lock())
}

#[tauri::command]
pub async fn permanently_delete(
    state: State<'_, AppState>,
    kind: String,
    id: String,
) -> AppResult<()> {
    db::permanently_delete(&state.db.lock(), &kind, &id)
}

#[tauri::command]
pub async fn set_always_on_top(
    state: State<'_, AppState>,
    window: WebviewWindow,
    enabled: bool,
) -> AppResult<()> {
    let connection = state.db.lock();
    let mut settings = db::load_settings(&connection)?;
    let previous = settings.always_on_top;
    if previous == enabled {
        return Ok(());
    }
    window
        .set_always_on_top(enabled)
        .map_err(|error| AppError::Validation(format!("无法切换窗口置顶：{error}")))?;
    settings.always_on_top = enabled;
    if let Err(error) = db::save_settings(&connection, &settings) {
        window
            .set_always_on_top(previous)
            .map_err(|rollback_error| {
                AppError::Validation(format!(
                    "窗口置顶设置保存失败，且原生状态回滚失败：{error}；{rollback_error}"
                ))
            })?;
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub async fn database_health(state: State<'_, AppState>) -> AppResult<bool> {
    db::quick_check(&open_read_connection(&state)?)
}

#[tauri::command]
pub async fn fetch_remote_image(url: String) -> AppResult<crate::models::RemoteImageData> {
    tauri::async_runtime::spawn_blocking(move || remote_images::fetch(&url))
        .await
        .map_err(|error| AppError::Validation(format!("远程图片任务失败：{error}")))?
}

#[tauri::command]
pub async fn export_project_package(
    state: State<'_, AppState>,
    project_id: String,
    suggested_name: String,
) -> AppResult<Option<crate::models::ExportResult>> {
    let Some(path) = choose_save_file(&suggested_name, "vcpproject", "提示词项目包")? else {
        return Ok(None);
    };
    let snapshot = open_export_snapshot(&state)?;
    archive::export_project(snapshot.connection(), &project_id, &path).map(Some)
}

#[tauri::command]
pub async fn import_project_package(
    state: State<'_, AppState>,
) -> AppResult<Option<ProjectSummary>> {
    let Some(path) = choose_open_file("vcpproject", "提示词项目包") else {
        return Ok(None);
    };
    let prepared = archive::prepare_project_import(&path, &state.paths.temp)?;
    archive::commit_project_import(&state.db.lock(), prepared).map(Some)
}

#[tauri::command]
pub async fn create_manual_backup(
    state: State<'_, AppState>,
    suggested_name: String,
) -> AppResult<Option<crate::models::BackupInfo>> {
    let Some(path) = choose_save_file(&suggested_name, "vcpbackup", "完整数据备份")? else {
        return Ok(None);
    };
    let _font_operation = state.font_operations.lock();
    archive::create_backup_managed(&state.db, &state.paths, &path, true).map(Some)
}

#[tauri::command]
pub async fn prepare_backup_restore(
    state: State<'_, AppState>,
) -> AppResult<Option<crate::models::RestorePreparation>> {
    let Some(path) = choose_open_file("vcpbackup", "完整数据备份") else {
        return Ok(None);
    };
    let _font_operation = state.font_operations.lock();
    archive::prepare_restore_managed(&state.db, &state.paths, &path).map(Some)
}

#[tauri::command]
pub async fn cancel_prepared_restore(state: State<'_, AppState>) -> AppResult<()> {
    let _font_operation = state.font_operations.lock();
    archive::cancel_prepared_restore(&state.paths)
}

#[tauri::command]
pub async fn run_auto_backup(
    state: State<'_, AppState>,
) -> AppResult<Option<crate::models::BackupInfo>> {
    let _font_operation = state.font_operations.lock();
    archive::maybe_create_auto_backup_managed(&state.db, &state.paths)
}

#[tauri::command]
pub async fn list_fonts(state: State<'_, AppState>) -> AppResult<Vec<crate::models::FontFaceInfo>> {
    fonts::list_fonts(&state.db.lock())
}

#[tauri::command]
pub async fn import_font_files(
    state: State<'_, AppState>,
) -> AppResult<Option<Vec<crate::models::FontFaceInfo>>> {
    let Some(paths) = choose_font_files() else {
        return Ok(None);
    };
    let paths = paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    fonts::import_files(&state, &paths).map(Some)
}

#[tauri::command]
pub async fn remove_imported_font(
    state: State<'_, AppState>,
    font_id: String,
) -> AppResult<Vec<crate::models::FontFaceInfo>> {
    fonts::remove_imported(&state, &font_id)
}

#[tauri::command]
pub async fn export_project_markdown(
    state: State<'_, AppState>,
    project_id: String,
    suggested_name: String,
) -> AppResult<Option<crate::models::ExportResult>> {
    let Some(path) = choose_save_file(&suggested_name, "md", "Markdown")? else {
        return Ok(None);
    };
    let snapshot = open_export_snapshot(&state)?;
    markdown_io::export_project_markdown(snapshot.connection(), &project_id, &path).map(Some)
}

#[tauri::command]
pub async fn export_all_markdown(
    state: State<'_, AppState>,
) -> AppResult<Option<crate::models::ExportResult>> {
    let Some(directory) = rfd::FileDialog::new()
        .set_title("选择全部项目 Markdown 的导出目录")
        .pick_folder()
    else {
        return Ok(None);
    };
    let snapshot = open_export_snapshot(&state)?;
    markdown_io::export_all_markdown(snapshot.connection(), &directory).map(Some)
}

#[tauri::command]
pub async fn import_markdown(state: State<'_, AppState>) -> AppResult<Option<ProjectSummary>> {
    let Some(path) = choose_open_file("md", "Markdown") else {
        return Ok(None);
    };
    let prepared = markdown_io::prepare_markdown_import(&path)?;
    markdown_io::commit_markdown_import(&state.db.lock(), &prepared).map(Some)
}

#[tauri::command]
pub async fn save_window_state(
    state: State<'_, AppState>,
    window_state: crate::models::WindowState,
) -> AppResult<()> {
    db::save_window_state(&state.db.lock(), &window_state)
}

#[tauri::command]
pub async fn mark_clean_shutdown(state: State<'_, AppState>, generation: u64) -> AppResult<()> {
    if generation == 0 || generation > 9_007_199_254_740_991 {
        return Err(AppError::Validation("关闭请求 generation 无效".into()));
    }
    // flushActive、视图和窗口状态已经由前端串行完成；WAL 成功收敛后才登记 clean 意图。
    db::checkpoint_wal(&state.db.lock())?;
    state.clean_shutdown.request(generation);
    Ok(())
}

#[tauri::command]
pub async fn cancel_clean_shutdown(state: State<'_, AppState>, generation: u64) -> AppResult<()> {
    if generation == 0 || generation > 9_007_199_254_740_991 {
        return Err(AppError::Validation("关闭请求 generation 无效".into()));
    }
    state.clean_shutdown.cancel(generation);
    Ok(())
}

#[tauri::command]
pub async fn save_text_file(
    suggested_name: String,
    content: String,
) -> AppResult<Option<crate::models::ExportResult>> {
    let Some(path) = choose_save_file(&suggested_name, "md", "Markdown")? else {
        return Ok(None);
    };
    markdown_io::write_text_file_atomically(&path, &content).map(Some)
}
