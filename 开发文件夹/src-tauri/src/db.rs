use crate::{
    error::{AppError, AppResult},
    models::{
        AppSettings, ProjectSummary, ProjectViewState, RoundDetail, RoundSummary, SaveRoundResult,
        SearchResult, TrashItem, WindowState,
    },
};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Transaction, backup::Backup, params};
use serde_json::Value;
use std::{fs, path::Path, time::Duration};
use uuid::Uuid;

pub const SCHEMA_VERSION: i64 = 2;

/// 业务数据库硬上限（8 GiB）。达到后停止新增内容，但仍允许删除、复制、导出与恢复。
pub const DATABASE_HARD_LIMIT_BYTES: i64 = 8 * 1024 * 1024 * 1024;
/// 软提示阈值（7.5 GiB）。达到后前端持续提示备份与清理。
pub const DATABASE_WARN_BYTES: i64 = 7680 * 1024 * 1024;

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// 估算数据库占用字节数：page_count × page_size（不含 WAL，作为容量护栏足够）。
pub fn database_size_bytes(connection: &Connection) -> AppResult<i64> {
    let page_count: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
    let page_size: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
    Ok(page_count.saturating_mul(page_size))
}

pub fn ensure_database_growth_capacity(
    connection: &Connection,
    incoming_bytes: u64,
) -> AppResult<()> {
    let current = u64::try_from(database_size_bytes(connection)?).unwrap_or(u64::MAX);
    let limit = DATABASE_HARD_LIMIT_BYTES as u64;
    if current.saturating_add(incoming_bytes) > limit {
        return Err(AppError::Validation(
            "数据库将超过 8 GiB 上限；请先备份并清理旧项目或轮次".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
fn unicode_len(value: &str) -> i64 {
    value.chars().count() as i64
}

fn existing_schema_version(connection: &Connection) -> AppResult<Option<i64>> {
    let has_migrations: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        [],
        |row| row.get(0),
    )?;
    if has_migrations == 0 {
        return Ok(None);
    }
    connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .map_err(Into::into)
}

fn create_migration_snapshot(
    source: &Connection,
    recovery_directory: &Path,
    from_version: i64,
) -> AppResult<()> {
    fs::create_dir_all(recovery_directory)?;
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S%3f");
    let target = recovery_directory.join(format!(
        "migration-pre-v{from_version}-to-v{SCHEMA_VERSION}-{timestamp}.sqlite3"
    ));
    let temporary = target.with_extension("sqlite3.tmp");
    let mut destination = Connection::open(&temporary)?;
    {
        let backup = Backup::new(source, &mut destination)?;
        backup.run_to_completion(64, Duration::from_millis(10), None)?;
    }
    destination.close().map_err(|(_, error)| error)?;
    fs::rename(temporary, target)?;
    Ok(())
}

#[cfg(test)]
pub fn open(path: &Path) -> AppResult<Connection> {
    open_managed(path, None, true)
}

pub fn open_managed(
    path: &Path,
    recovery_directory: Option<&Path>,
    unclean_start: bool,
) -> AppResult<Connection> {
    let existed = path.is_file() && fs::metadata(path)?.len() > 0;
    let mut previous_version = None;
    if existed {
        // 用读写连接执行版本探测与完整性检查：崩溃/断电后属于「热 WAL」，SQLite 需要
        // 可写连接才能回放 -wal 日志。若仍用只读连接会触发 SQLITE_READONLY_RECOVERY，
        // 把健康数据库误判为损坏。打开读写连接本身不修改用户数据，WAL 回放是正常恢复行为；
        // 且下方在任何迁移/写入前先校验 schema 版本，schema 更高时不会写库。
        let probe = Connection::open(path)?;
        let version = existing_schema_version(&probe)?;
        let Some(version) = version else {
            return Err(AppError::Validation(
                "现有数据库缺少受支持的 schema 标记；未执行任何迁移或覆盖".into(),
            ));
        };
        if version > SCHEMA_VERSION {
            return Err(AppError::Validation(format!(
                "数据库 schema v{version} 高于本程序支持的 v{SCHEMA_VERSION}；未写入数据"
            )));
        }
        if unclean_start {
            let result: String = probe.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
            if result != "ok" {
                return Err(AppError::Validation(format!(
                    "上次未正常退出，数据库完整性检查失败：{result}"
                )));
            }
        }
        previous_version = Some(version);
        // 关闭探测连接，让主连接以统一的 PRAGMA 打开。
        drop(probe);
    }

    let connection = Connection::open(path)?;
    connection.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=FULL;
         PRAGMA foreign_keys=ON;
         PRAGMA busy_timeout=5000;
         PRAGMA trusted_schema=OFF;
         PRAGMA temp_store=MEMORY;",
    )?;
    connection.set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    let fts5: i64 = connection.query_row(
        "SELECT sqlite_compileoption_used('ENABLE_FTS5')",
        [],
        |row| row.get(0),
    )?;
    if fts5 != 1 {
        return Err(AppError::Validation("当前 SQLite 构建未启用 FTS5".into()));
    }
    if previous_version.unwrap_or(0) < SCHEMA_VERSION {
        if existed && let Some(recovery_directory) = recovery_directory {
            create_migration_snapshot(
                &connection,
                recovery_directory,
                previous_version.unwrap_or(0),
            )?;
        }
        migrate(&connection)?;
        if !quick_check(&connection)? {
            return Err(AppError::Validation("数据库迁移后的完整性检查失败".into()));
        }
    }
    repair_view_state_references(&connection)?;
    // 最近删除不在启动期执行不可逆清理；永久删除只由用户逐项确认的命令触发。
    Ok(connection)
}

pub fn checkpoint_wal(connection: &Connection) -> AppResult<()> {
    let (busy, _log_frames, _checkpointed_frames): (i64, i64, i64) =
        connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
    if busy != 0 {
        return Err(AppError::Validation(
            "数据库仍有读取任务，暂时无法收敛 WAL；已取消正常关闭".into(),
        ));
    }
    Ok(())
}

fn migrate(connection: &Connection) -> AppResult<()> {
    // v1 标记必须与基础 schema 同一事务提交。若进程在后续初始化中被强杀，
    // 下一次启动会看到 v1 并安全重跑幂等步骤，而不是留下“有表但无版本”的死库。
    let app_version = env!("CARGO_PKG_VERSION").replace('\'', "''");
    let base_schema = format!(
        "BEGIN IMMEDIATE;
         CREATE TABLE IF NOT EXISTS meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS projects (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0,1)),
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           last_opened_at INTEGER NOT NULL,
           deleted_at INTEGER,
           revision INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS projects_sort_idx
           ON projects(deleted_at, is_pinned DESC, last_opened_at DESC);
         CREATE TABLE IF NOT EXISTS rounds (
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL REFERENCES projects(id),
           position INTEGER NOT NULL,
           status TEXT NOT NULL CHECK(status IN ('draft','final')),
           content_md TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           finalized_at INTEGER,
           updated_at INTEGER NOT NULL,
           deleted_at INTEGER,
           revision INTEGER NOT NULL DEFAULT 0,
           recovered_from_round_id TEXT,
           note TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS rounds_project_idx
           ON rounds(project_id, deleted_at, status, position, id);
         CREATE UNIQUE INDEX IF NOT EXISTS one_live_draft_per_project
           ON rounds(project_id) WHERE status='draft' AND deleted_at IS NULL;
         CREATE TABLE IF NOT EXISTS project_view_state (
           project_id TEXT PRIMARY KEY REFERENCES projects(id),
           selected_round_id TEXT,
           timeline_anchor_round_id TEXT,
           anchor_offset_px REAL NOT NULL DEFAULT 0,
           editor_mode TEXT NOT NULL DEFAULT 'wysiwyg',
           cursor_anchor INTEGER NOT NULL DEFAULT 0,
           cursor_head INTEGER NOT NULL DEFAULT 0,
           detail_open INTEGER NOT NULL DEFAULT 1,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS app_settings (
           key TEXT PRIMARY KEY,
           versioned_json_value TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS font_registry (
           id TEXT PRIMARY KEY,
           sha256 TEXT NOT NULL UNIQUE,
           source TEXT NOT NULL,
           display_name TEXT NOT NULL,
           internal_family TEXT NOT NULL,
           file_name TEXT NOT NULL,
           format TEXT NOT NULL,
           file_size INTEGER NOT NULL,
           weights_json TEXT NOT NULL,
           is_monospace INTEGER NOT NULL DEFAULT 0,
           face_count INTEGER NOT NULL DEFAULT 1,
           is_variable INTEGER NOT NULL DEFAULT 0,
           axes_json TEXT NOT NULL DEFAULT '[]',
           imported_at INTEGER NOT NULL,
           is_available INTEGER NOT NULL DEFAULT 1,
           error_state TEXT
         );
         CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           app_version TEXT NOT NULL,
           applied_at INTEGER NOT NULL,
           checksum TEXT NOT NULL
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
           project_name,
           note,
           content_md,
           project_id UNINDEXED,
           round_id UNINDEXED,
            status UNINDEXED,
            tokenize='trigram case_sensitive 0'
          );
          INSERT OR IGNORE INTO schema_migrations(version, app_version, applied_at, checksum)
            VALUES (1, '{app_version}', CAST(strftime('%s','now') AS INTEGER) * 1000, 'initial-v1');
          COMMIT;"
    );
    connection.execute_batch(&base_schema)?;

    let columns = {
        let mut statement = connection.prepare("PRAGMA table_info(font_registry)")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
    };
    if !columns.iter().any(|column| column == "face_count") {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE font_registry ADD COLUMN face_count INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE font_registry ADD COLUMN is_variable INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE font_registry ADD COLUMN axes_json TEXT NOT NULL DEFAULT '[]';
             COMMIT;",
        )?;
    }
    connection.execute(
        "INSERT OR IGNORE INTO meta(key, value) VALUES ('next_project_number', '1')",
        [],
    )?;
    ensure_initial_project(connection)?;
    rebuild_search_index(connection)?;
    // v2 是完成标记：只有 meta、初始项目和搜索索引全部就绪后才写入。
    // 中途失败会继续保留 v1，下次启动可幂等重试。
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, app_version, applied_at, checksum)
         VALUES (2, ?1, ?2, 'font-metadata-v2')",
        params![env!("CARGO_PKG_VERSION"), now_ms()],
    )?;
    Ok(())
}

fn ensure_initial_project(connection: &Connection) -> AppResult<()> {
    let live_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM projects WHERE deleted_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    let all_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
    if live_count == 0 && all_count == 0 {
        create_project(connection, None)?;
    }
    Ok(())
}

fn normalized_project_name(name: Option<&str>, number: i64) -> AppResult<String> {
    let trimmed = name.unwrap_or_default().trim();
    let value = if trimmed.is_empty() {
        format!("Vibe Coding 项目-{number}")
    } else {
        trimmed.to_string()
    };
    if value.chars().count() > 120 {
        return Err(AppError::Validation("项目名称不能超过 120 个字符".into()));
    }
    if value.chars().any(char::is_control) {
        return Err(AppError::Validation(
            "项目名称不能包含换行、制表符或其他控制字符".into(),
        ));
    }
    Ok(value)
}

fn next_project_number(transaction: &Transaction<'_>) -> AppResult<i64> {
    let current: i64 = transaction
        .query_row(
            "SELECT value FROM meta WHERE key='next_project_number'",
            [],
            |row| row.get::<_, String>(0),
        )?
        .parse()
        .map_err(|_| AppError::Validation("项目编号计数器损坏".into()))?;
    transaction.execute(
        "UPDATE meta SET value=?1 WHERE key='next_project_number'",
        params![(current + 1).to_string()],
    )?;
    Ok(current)
}

pub fn create_project(
    connection: &Connection,
    requested_name: Option<&str>,
) -> AppResult<ProjectSummary> {
    let transaction = connection.unchecked_transaction()?;
    let number = next_project_number(&transaction)?;
    let name = normalized_project_name(requested_name, number)?;
    let project_id = Uuid::new_v4().to_string();
    let draft_id = Uuid::new_v4().to_string();
    let now = now_ms();
    transaction.execute(
        "INSERT INTO projects(id,name,is_pinned,created_at,updated_at,last_opened_at,revision)
         VALUES (?1,?2,0,?3,?3,?3,0)",
        params![project_id, name, now],
    )?;
    transaction.execute(
        "INSERT INTO rounds(id,project_id,position,status,content_md,created_at,updated_at,revision,note)
         VALUES (?1,?2,2147483647,'draft','',?3,?3,0,'')",
        params![draft_id, project_id, now],
    )?;
    transaction.execute(
        "INSERT INTO project_view_state(project_id,selected_round_id,editor_mode,detail_open,updated_at)
         VALUES (?1,?2,'wysiwyg',1,?3)",
        params![project_id, draft_id, now],
    )?;
    // 立即为项目名建立搜索索引（初始草稿正文为空，仅登记项目名，供 FTS 命中）。
    index_round(&transaction, &draft_id)?;
    transaction.commit()?;
    get_project(connection, &project_id)
}

pub fn list_projects(connection: &Connection) -> AppResult<Vec<ProjectSummary>> {
    let mut statement = connection.prepare(
        "SELECT p.id,p.name,p.is_pinned,p.created_at,p.updated_at,p.last_opened_at,
                SUM(CASE WHEN r.status='final' AND r.deleted_at IS NULL THEN 1 ELSE 0 END),
                MAX(CASE WHEN r.status='draft' AND r.deleted_at IS NULL AND trim(r.content_md)<>'' THEN 1 ELSE 0 END)
         FROM projects p LEFT JOIN rounds r ON r.project_id=p.id
         WHERE p.deleted_at IS NULL
         GROUP BY p.id
         ORDER BY p.is_pinned DESC,p.last_opened_at DESC,p.id",
    )?;
    let rows = statement.query_map([], project_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectSummary> {
    Ok(ProjectSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        is_pinned: row.get::<_, i64>(2)? != 0,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        last_opened_at: row.get(5)?,
        round_count: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
        has_draft: row.get::<_, Option<i64>>(7)?.unwrap_or(0) != 0,
    })
}

pub fn get_project(connection: &Connection, project_id: &str) -> AppResult<ProjectSummary> {
    connection
        .query_row(
            "SELECT p.id,p.name,p.is_pinned,p.created_at,p.updated_at,p.last_opened_at,
                    SUM(CASE WHEN r.status='final' AND r.deleted_at IS NULL THEN 1 ELSE 0 END),
                    MAX(CASE WHEN r.status='draft' AND r.deleted_at IS NULL AND trim(r.content_md)<>'' THEN 1 ELSE 0 END)
             FROM projects p LEFT JOIN rounds r ON r.project_id=p.id
             WHERE p.id=?1 AND p.deleted_at IS NULL GROUP BY p.id",
            params![project_id],
            project_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("项目不存在或已删除".into()))
}

pub fn rename_project(
    connection: &Connection,
    project_id: &str,
    name: &str,
) -> AppResult<ProjectSummary> {
    // 项目重命名的 projects 表更新与搜索索引更新必须在同一事务内，
    // 中途崩溃不得留下「项目名与索引不一致」。
    let now = now_ms();
    let transaction = connection.unchecked_transaction()?;
    // 重命名为空白时使用单调递增计数器生成默认名，避免产出固定的「Vibe Coding 项目-0」。
    let normalized = if name.trim().is_empty() {
        let number = next_project_number(&transaction)?;
        normalized_project_name(None, number)?
    } else {
        normalized_project_name(Some(name), 0)?
    };
    let changed = transaction.execute(
        "UPDATE projects SET name=?1,updated_at=?2,revision=revision+1
         WHERE id=?3 AND deleted_at IS NULL",
        params![normalized, now, project_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound("项目不存在或已删除".into()));
    }
    transaction.execute(
        "UPDATE search_index SET project_name=?1 WHERE project_id=?2",
        params![normalized, project_id],
    )?;
    transaction.commit()?;
    get_project(connection, project_id)
}

pub fn toggle_project_pin(connection: &Connection, project_id: &str) -> AppResult<ProjectSummary> {
    let changed = connection.execute(
        "UPDATE projects SET is_pinned=CASE is_pinned WHEN 0 THEN 1 ELSE 0 END,
         updated_at=?1,revision=revision+1 WHERE id=?2 AND deleted_at IS NULL",
        params![now_ms(), project_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound("项目不存在或已删除".into()));
    }
    get_project(connection, project_id)
}

pub fn touch_project(connection: &Connection, project_id: &str) -> AppResult<()> {
    let changed = connection.execute(
        "UPDATE projects SET last_opened_at=?1 WHERE id=?2 AND deleted_at IS NULL",
        params![now_ms(), project_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound("项目不存在或已删除".into()));
    }
    Ok(())
}

pub fn delete_project(connection: &Connection, project_id: &str) -> AppResult<()> {
    let transaction = connection.unchecked_transaction()?;
    let changed = transaction.execute(
        "UPDATE projects SET deleted_at=?1,revision=revision+1 WHERE id=?2 AND deleted_at IS NULL",
        params![now_ms(), project_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound("项目不存在或已删除".into()));
    }
    transaction.execute(
        "DELETE FROM search_index WHERE project_id=?1",
        params![project_id],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn restore_project(connection: &Connection, project_id: &str) -> AppResult<ProjectSummary> {
    // 恢复项目与重建其搜索索引在同一事务内，避免中途崩溃留下「已恢复但搜不到」。
    let transaction = connection.unchecked_transaction()?;
    let changed = transaction.execute(
        "UPDATE projects SET deleted_at=NULL,last_opened_at=?1,revision=revision+1 WHERE id=?2 AND deleted_at IS NOT NULL",
        params![now_ms(), project_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound("最近删除中没有该项目".into()));
    }
    transaction.execute(
        "DELETE FROM search_index WHERE project_id=?1",
        params![project_id],
    )?;
    transaction.execute(
        "INSERT INTO search_index(project_name,note,content_md,project_id,round_id,status)
         SELECT p.name,r.note,r.content_md,p.id,r.id,r.status FROM rounds r
         JOIN projects p ON p.id=r.project_id
         WHERE p.id=?1 AND p.deleted_at IS NULL AND r.deleted_at IS NULL",
        params![project_id],
    )?;
    transaction.commit()?;
    get_project(connection, project_id)
}

fn require_live_project(connection: &Connection, project_id: &str) -> AppResult<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND deleted_at IS NULL)",
        params![project_id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound("项目不存在或已删除".into()))
    }
}

fn require_live_round_parent(connection: &Connection, round_id: &str) -> AppResult<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM rounds r JOIN projects p ON p.id=r.project_id
           WHERE r.id=?1 AND r.deleted_at IS NULL AND p.deleted_at IS NULL
         )",
        params![round_id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound(
            "轮次不存在、已删除或所属项目在最近删除中".into(),
        ))
    }
}

pub fn list_rounds(connection: &Connection, project_id: &str) -> AppResult<Vec<RoundSummary>> {
    require_live_project(connection, project_id)?;
    let mut statement = connection.prepare(
        "SELECT id,project_id,position,status,substr(content_md,1,8192),created_at,finalized_at,
                updated_at,revision,note,length(content_md)
         FROM rounds WHERE project_id=?1 AND deleted_at IS NULL
         ORDER BY CASE status WHEN 'final' THEN 0 ELSE 1 END,position,id",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok(RoundSummary {
            id: row.get(0)?,
            project_id: row.get(1)?,
            position: row.get(2)?,
            status: row.get(3)?,
            preview_md: row.get(4)?,
            created_at: row.get(5)?,
            finalized_at: row.get(6)?,
            updated_at: row.get(7)?,
            revision: row.get(8)?,
            note: row.get(9)?,
            char_count: row.get(10)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn round_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoundDetail> {
    Ok(RoundDetail {
        id: row.get(0)?,
        project_id: row.get(1)?,
        position: row.get(2)?,
        status: row.get(3)?,
        content_md: row.get(4)?,
        created_at: row.get(5)?,
        finalized_at: row.get(6)?,
        updated_at: row.get(7)?,
        revision: row.get(8)?,
        note: row.get(9)?,
    })
}

pub fn get_round(connection: &Connection, round_id: &str) -> AppResult<RoundDetail> {
    connection
        .query_row(
            "SELECT r.id,r.project_id,r.position,r.status,r.content_md,r.created_at,r.finalized_at,r.updated_at,r.revision,r.note
             FROM rounds r JOIN projects p ON p.id=r.project_id
             WHERE r.id=?1 AND r.deleted_at IS NULL AND p.deleted_at IS NULL",
            params![round_id],
            round_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("轮次不存在或已删除".into()))
}

fn index_round(transaction: &Transaction<'_>, round_id: &str) -> AppResult<()> {
    transaction.execute(
        "DELETE FROM search_index WHERE round_id=?1",
        params![round_id],
    )?;
    transaction.execute(
        "INSERT INTO search_index(project_name,note,content_md,project_id,round_id,status)
         SELECT p.name,r.note,r.content_md,p.id,r.id,r.status FROM rounds r
         JOIN projects p ON p.id=r.project_id
         WHERE r.id=?1 AND r.deleted_at IS NULL AND p.deleted_at IS NULL",
        params![round_id],
    )?;
    Ok(())
}

pub fn rebuild_search_index(connection: &Connection) -> AppResult<()> {
    let transaction = connection.unchecked_transaction()?;
    transaction.execute("DELETE FROM search_index", [])?;
    transaction.execute(
        "INSERT INTO search_index(project_name,note,content_md,project_id,round_id,status)
         SELECT p.name,r.note,r.content_md,p.id,r.id,r.status FROM rounds r
         JOIN projects p ON p.id=r.project_id
         WHERE p.deleted_at IS NULL AND r.deleted_at IS NULL",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn save_round(
    connection: &Connection,
    round_id: &str,
    content_md: &str,
    note: &str,
    expected_revision: i64,
) -> AppResult<SaveRoundResult> {
    require_live_round_parent(connection, round_id)?;
    if content_md.len() > 10 * 1024 * 1024 {
        return Err(AppError::Validation(
            "单轮内容已达到 10 MiB 安全上限；请先删除或拆分内容".into(),
        ));
    }
    let note = note.trim();
    if note.chars().count() > 120 || note.contains(['\r', '\n']) {
        return Err(AppError::Validation(
            "轮次备注必须是 120 字以内的单行文字".into(),
        ));
    }
    let existing_len: Option<i64> = connection
        .query_row(
            "SELECT length(CAST(content_md AS BLOB)) FROM rounds
             WHERE id=?1 AND deleted_at IS NULL",
            params![round_id],
            |row| row.get(0),
        )
        .optional()?;
    let growth = (content_md.len() as u64).saturating_sub(
        existing_len
            .and_then(|value| u64::try_from(value).ok())
            .unwrap_or(0),
    );
    ensure_database_growth_capacity(connection, growth)?;
    let transaction = connection.unchecked_transaction()?;
    let now = now_ms();
    let changed = transaction.execute(
        "UPDATE rounds SET content_md=?1,note=?2,updated_at=?3,revision=revision+1
         WHERE id=?4 AND deleted_at IS NULL AND revision=?5",
        params![content_md, note, now, round_id, expected_revision],
    )?;
    if changed == 0 {
        let current: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM rounds WHERE id=?1 AND deleted_at IS NULL",
                params![round_id],
                |row| row.get(0),
            )
            .optional()?;
        return match current {
            Some(revision) => Err(AppError::RevisionConflict(format!(
                "期望版本 {expected_revision}，数据库版本 {revision}"
            ))),
            None => Err(AppError::NotFound("轮次不存在或已删除".into())),
        };
    }
    let project_id: String = transaction.query_row(
        "SELECT project_id FROM rounds WHERE id=?1",
        params![round_id],
        |row| row.get(0),
    )?;
    transaction.execute(
        "UPDATE projects SET updated_at=?1,last_opened_at=?1,revision=revision+1 WHERE id=?2",
        params![now, project_id],
    )?;
    index_round(&transaction, round_id)?;
    transaction.commit()?;
    Ok(SaveRoundResult {
        revision: expected_revision + 1,
        saved_at: now,
        database_bytes: database_size_bytes(connection)?,
    })
}

pub fn keep_both_after_conflict(
    connection: &Connection,
    round_id: &str,
    local_content_md: &str,
    local_note: &str,
) -> AppResult<RoundDetail> {
    require_live_round_parent(connection, round_id)?;
    if local_content_md.len() > 10 * 1024 * 1024 {
        return Err(AppError::Validation(
            "本地冲突版本超过 10 MiB 安全上限".into(),
        ));
    }
    ensure_database_growth_capacity(connection, local_content_md.len() as u64)?;
    let local_note = local_note.trim();
    if local_note.chars().count() > 120 || local_note.contains(['\r', '\n']) {
        return Err(AppError::Validation(
            "轮次备注必须是 120 字以内的单行文字".into(),
        ));
    }
    let transaction = connection.unchecked_transaction()?;
    let (project_id, status, original_position): (String, String, i64) = transaction
        .query_row(
            "SELECT project_id,status,position FROM rounds WHERE id=?1 AND deleted_at IS NULL",
            params![round_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("冲突轮次不存在或已删除".into()))?;
    let position = if status == "final" {
        transaction.execute(
            "UPDATE rounds SET position=position+1 WHERE project_id=?1 AND status='final'
             AND deleted_at IS NULL AND position>?2",
            params![project_id, original_position],
        )?;
        original_position + 1
    } else {
        transaction.query_row(
            "SELECT COALESCE(MAX(position),-1)+1 FROM rounds
             WHERE project_id=?1 AND status='final' AND deleted_at IS NULL",
            params![project_id],
            |row| row.get(0),
        )?
    };
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    transaction.execute(
        "INSERT INTO rounds(id,project_id,position,status,content_md,created_at,finalized_at,
         updated_at,revision,recovered_from_round_id,note)
         VALUES (?1,?2,?3,'final',?4,?5,?5,?5,0,?6,?7)",
        params![
            id,
            project_id,
            position,
            local_content_md,
            now,
            round_id,
            local_note
        ],
    )?;
    index_round(&transaction, &id)?;
    transaction.execute(
        "UPDATE projects SET updated_at=?1,last_opened_at=?1,revision=revision+1 WHERE id=?2",
        params![now, project_id],
    )?;
    transaction.commit()?;
    get_round(connection, &id)
}

pub fn replace_round_after_conflict(
    connection: &Connection,
    round_id: &str,
    local_content_md: &str,
    local_note: &str,
    expected_revision: i64,
) -> AppResult<RoundDetail> {
    require_live_round_parent(connection, round_id)?;
    if local_content_md.len() > 10 * 1024 * 1024 {
        return Err(AppError::Validation(
            "本地冲突版本超过 10 MiB 安全上限".into(),
        ));
    }
    let existing_len: Option<i64> = connection
        .query_row(
            "SELECT length(CAST(content_md AS BLOB)) FROM rounds
             WHERE id=?1 AND deleted_at IS NULL",
            params![round_id],
            |row| row.get(0),
        )
        .optional()?;
    let growth = (local_content_md.len() as u64).saturating_sub(
        existing_len
            .and_then(|value| u64::try_from(value).ok())
            .unwrap_or(0),
    );
    ensure_database_growth_capacity(connection, growth)?;
    let local_note = local_note.trim();
    if local_note.chars().count() > 120 || local_note.contains(['\r', '\n']) {
        return Err(AppError::Validation(
            "轮次备注必须是 120 字以内的单行文字".into(),
        ));
    }
    let transaction = connection.unchecked_transaction()?;
    let now = now_ms();
    let changed = transaction.execute(
        "UPDATE rounds SET content_md=?1,note=?2,updated_at=?3,revision=revision+1
         WHERE id=?4 AND deleted_at IS NULL AND revision=?5",
        params![
            local_content_md,
            local_note,
            now,
            round_id,
            expected_revision
        ],
    )?;
    if changed == 0 {
        let current: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM rounds WHERE id=?1 AND deleted_at IS NULL",
                params![round_id],
                |row| row.get(0),
            )
            .optional()?;
        return match current {
            Some(revision) => Err(AppError::RevisionConflict(format!(
                "冲突处理期间轮次已更新：期望版本 {expected_revision}，数据库版本 {revision}"
            ))),
            None => Err(AppError::NotFound("冲突轮次不存在或已删除".into())),
        };
    }
    let project_id: String = transaction.query_row(
        "SELECT project_id FROM rounds WHERE id=?1",
        params![round_id],
        |row| row.get(0),
    )?;
    index_round(&transaction, round_id)?;
    transaction.execute(
        "UPDATE projects SET updated_at=?1,last_opened_at=?1,revision=revision+1 WHERE id=?2",
        params![now, project_id],
    )?;
    transaction.commit()?;
    get_round(connection, round_id)
}

pub fn finalize_draft(
    connection: &Connection,
    project_id: &str,
) -> AppResult<crate::models::FinalizeResult> {
    require_live_project(connection, project_id)?;
    let transaction = connection.unchecked_transaction()?;
    let draft: RoundDetail = transaction
        .query_row(
            "SELECT id,project_id,position,status,content_md,created_at,finalized_at,updated_at,revision,note
             FROM rounds WHERE project_id=?1 AND status='draft' AND deleted_at IS NULL",
            params![project_id],
            round_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("当前项目没有草稿".into()))?;
    if draft.content_md.trim().is_empty() {
        return Err(AppError::Validation("空白草稿不会生成正式轮次".into()));
    }
    let position: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(position),-1)+1 FROM rounds
         WHERE project_id=?1 AND status='final' AND deleted_at IS NULL",
        params![project_id],
        |row| row.get(0),
    )?;
    let now = now_ms();
    transaction.execute(
        "UPDATE rounds SET status='final',position=?1,finalized_at=?2,updated_at=?2,revision=revision+1
         WHERE id=?3",
        params![position, now, draft.id],
    )?;
    index_round(&transaction, &draft.id)?;
    let new_draft_id = Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO rounds(id,project_id,position,status,content_md,created_at,updated_at,revision,note)
         VALUES (?1,?2,2147483647,'draft','',?3,?3,0,'')",
        params![new_draft_id, project_id, now],
    )?;
    index_round(&transaction, &new_draft_id)?;
    transaction.execute(
        "UPDATE projects SET updated_at=?1,last_opened_at=?1,revision=revision+1 WHERE id=?2",
        params![now, project_id],
    )?;
    transaction.execute(
        "UPDATE project_view_state SET selected_round_id=?1,updated_at=?2 WHERE project_id=?3",
        params![new_draft_id, now, project_id],
    )?;
    transaction.commit()?;
    Ok(crate::models::FinalizeResult {
        finalized_round: get_round(connection, &draft.id)?,
        draft: get_round(connection, &new_draft_id)?,
    })
}

fn clear_round_view_references(connection: &Connection, round_id: &str) -> AppResult<()> {
    connection.execute(
        "UPDATE project_view_state
         SET selected_round_id=CASE WHEN selected_round_id=?1 THEN NULL ELSE selected_round_id END,
             timeline_anchor_round_id=CASE WHEN timeline_anchor_round_id=?1 THEN NULL ELSE timeline_anchor_round_id END,
             anchor_offset_px=CASE WHEN timeline_anchor_round_id=?1 THEN 0 ELSE anchor_offset_px END
         WHERE selected_round_id=?1 OR timeline_anchor_round_id=?1",
        params![round_id],
    )?;
    Ok(())
}

fn repair_view_state_references(connection: &Connection) -> AppResult<()> {
    connection.execute(
        "DELETE FROM project_view_state
         WHERE NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=project_id)",
        [],
    )?;
    connection.execute(
        "UPDATE project_view_state SET selected_round_id=NULL
         WHERE selected_round_id IS NOT NULL AND NOT EXISTS(
           SELECT 1 FROM rounds r WHERE r.id=selected_round_id
             AND r.project_id=project_view_state.project_id AND r.deleted_at IS NULL
         )",
        [],
    )?;
    connection.execute(
        "UPDATE project_view_state SET timeline_anchor_round_id=NULL,anchor_offset_px=0
         WHERE timeline_anchor_round_id IS NOT NULL AND NOT EXISTS(
           SELECT 1 FROM rounds r WHERE r.id=timeline_anchor_round_id
             AND r.project_id=project_view_state.project_id AND r.deleted_at IS NULL
         )",
        [],
    )?;
    Ok(())
}

pub fn delete_round(connection: &Connection, round_id: &str) -> AppResult<()> {
    require_live_round_parent(connection, round_id)?;
    let transaction = connection.unchecked_transaction()?;
    let detail: RoundDetail = transaction
        .query_row(
            "SELECT id,project_id,position,status,content_md,created_at,finalized_at,updated_at,revision,note
             FROM rounds WHERE id=?1 AND deleted_at IS NULL",
            params![round_id],
            round_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("轮次不存在或已删除".into()))?;
    let now = now_ms();
    if detail.status == "draft" {
        transaction.execute(
            "UPDATE rounds SET content_md='',note='',updated_at=?1,revision=revision+1 WHERE id=?2",
            params![now, round_id],
        )?;
        index_round(&transaction, round_id)?;
    } else {
        transaction.execute(
            "UPDATE rounds SET deleted_at=?1,revision=revision+1 WHERE id=?2",
            params![now, round_id],
        )?;
        transaction.execute(
            "DELETE FROM search_index WHERE round_id=?1",
            params![round_id],
        )?;
        clear_round_view_references(&transaction, round_id)?;
    }
    transaction.execute(
        "UPDATE projects SET updated_at=?1,revision=revision+1 WHERE id=?2",
        params![now, detail.project_id],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn restore_round(connection: &Connection, round_id: &str) -> AppResult<RoundDetail> {
    let project_id: String = connection
        .query_row(
            "SELECT r.project_id FROM rounds r JOIN projects p ON p.id=r.project_id
             WHERE r.id=?1 AND r.deleted_at IS NOT NULL AND p.deleted_at IS NULL",
            params![round_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("最近删除中没有可恢复的轮次，或所属项目已删除".into()))?;
    require_live_project(connection, &project_id)?;
    let transaction = connection.unchecked_transaction()?;
    let (project_id, status, position): (String, String, i64) = transaction
        .query_row(
            "SELECT project_id,status,position FROM rounds
             WHERE id=?1 AND deleted_at IS NOT NULL",
            params![round_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("最近删除中没有该轮次".into()))?;
    if status == "final" {
        transaction.execute(
            "UPDATE rounds SET position=position+1
             WHERE project_id=?1 AND status='final' AND deleted_at IS NULL AND position>=?2",
            params![project_id, position],
        )?;
    }
    let changed = transaction.execute(
        "UPDATE rounds SET deleted_at=NULL,revision=revision+1 WHERE id=?1 AND deleted_at IS NOT NULL",
        params![round_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound("最近删除中没有该轮次".into()));
    }
    index_round(&transaction, round_id)?;
    transaction.execute(
        "UPDATE projects SET updated_at=?1,revision=revision+1 WHERE id=?2",
        params![now_ms(), project_id],
    )?;
    transaction.commit()?;
    get_round(connection, round_id)
}

pub fn reorder_rounds(
    connection: &Connection,
    project_id: &str,
    ordered_ids: &[String],
) -> AppResult<()> {
    require_live_project(connection, project_id)?;
    let transaction = connection.unchecked_transaction()?;
    let mut current = {
        let mut statement = transaction.prepare(
            "SELECT id FROM rounds WHERE project_id=?1 AND status='final' AND deleted_at IS NULL ORDER BY position,id",
        )?;
        let rows = statement.query_map(params![project_id], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut requested = ordered_ids.to_vec();
    current.sort();
    requested.sort();
    if current != requested {
        return Err(AppError::Validation(
            "排序请求与当前轮次集合不一致，数据未被修改".into(),
        ));
    }
    for (position, id) in ordered_ids.iter().enumerate() {
        transaction.execute(
            "UPDATE rounds SET position=?1 WHERE id=?2 AND project_id=?3",
            params![position as i64, id, project_id],
        )?;
    }
    transaction.execute(
        "UPDATE projects SET updated_at=?1,revision=revision+1 WHERE id=?2",
        params![now_ms(), project_id],
    )?;
    transaction.commit()?;
    Ok(())
}

fn escape_like(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn case_insensitive_range(content: &str, query: &str) -> Option<(usize, usize)> {
    let query_lower = query
        .chars()
        .flat_map(char::to_lowercase)
        .collect::<Vec<_>>();
    if query_lower.is_empty() {
        return None;
    }
    let mut content_lower = Vec::new();
    let mut original_indices = Vec::new();
    for (original_index, character) in content.chars().enumerate() {
        for lowered in character.to_lowercase() {
            content_lower.push(lowered);
            original_indices.push(original_index);
        }
    }
    let lowered_start = content_lower
        .windows(query_lower.len())
        .position(|window| window == query_lower.as_slice())?;
    let lowered_end = lowered_start + query_lower.len() - 1;
    Some((
        original_indices[lowered_start],
        original_indices[lowered_end] + 1,
    ))
}

fn make_excerpt(content: &str, query: &str) -> (String, i64, i64) {
    // 以「字符」为单位定位匹配，避免用小写副本的字节偏移去切原文——大小写映射会改变
    // UTF-8 字节长度（如 `İ`→`i̇`），字节偏移切原文可能落在字符中间导致 panic。
    let content_chars: Vec<char> = content.chars().collect();
    let fallback_end = query.chars().count().min(content_chars.len());
    let (start_chars, end_chars) =
        case_insensitive_range(content, query).unwrap_or((0, fallback_end));
    let excerpt_start = start_chars.saturating_sub(42);
    let excerpt: String = content_chars.iter().skip(excerpt_start).take(140).collect();
    // CodeMirror 使用 JavaScript UTF-16 code units；emoji 等补充平面字符占两个单位。
    let match_start = content_chars[..start_chars]
        .iter()
        .map(|character| character.len_utf16())
        .sum::<usize>();
    let match_end = match_start
        + content_chars[start_chars..end_chars]
            .iter()
            .map(|character| character.len_utf16())
            .sum::<usize>();
    (
        excerpt.replace(['\r', '\n'], " "),
        match_start as i64,
        match_end as i64,
    )
}

pub fn search(
    connection: &Connection,
    query: &str,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<SearchResult>> {
    // content_preview 始终由 SQLite 截成有界片段，绝不把命中的完整正文批量物化到 Rust。
    type SearchRow = (
        String,
        String,
        String,
        String,
        String,
        i64,
        String,
        i64,
        bool,
    );

    const MATCH_START: &str = "\u{1f}";
    const MATCH_END: &str = "\u{1e}";

    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 100);
    let scalar_len = query.chars().count();
    let raw: Vec<SearchRow> = if scalar_len >= 3 {
        let quoted = format!("\"{}\"", query.replace('"', "\"\""));
        let mut statement = connection.prepare(
            "SELECT s.project_id,p.name,s.round_id,s.status,s.note,
                    CASE WHEN r.status='final' THEN (
                      SELECT COUNT(*)-1 FROM rounds r2
                      WHERE r2.project_id=r.project_id AND r2.status='final' AND r2.deleted_at IS NULL
                        AND (r2.position<r.position OR (r2.position=r.position AND r2.id<=r.id))
                    ) ELSE r.position END,
                    snippet(search_index,2,?4,?5,' … ',48),r.updated_at
             FROM search_index s JOIN projects p ON p.id=s.project_id JOIN rounds r ON r.id=s.round_id
             WHERE search_index MATCH ?1 AND p.deleted_at IS NULL AND r.deleted_at IS NULL
             ORDER BY rank,r.updated_at DESC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = statement.query_map(
            params![quoted, limit, offset, MATCH_START, MATCH_END],
            |row| {
                let content_preview: String = row.get(6)?;
                let content_matched = content_preview.contains(MATCH_START);
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    content_preview,
                    row.get(7)?,
                    content_matched,
                ))
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>()?
    } else {
        let pattern = format!("%{}%", escape_like(query));
        let mut statement = connection.prepare(
            "SELECT p.id,p.name,r.id,r.status,r.note,
                    CASE WHEN r.status='final' THEN (
                      SELECT COUNT(*)-1 FROM rounds r2
                      WHERE r2.project_id=r.project_id AND r2.status='final' AND r2.deleted_at IS NULL
                        AND (r2.position<r.position OR (r2.position=r.position AND r2.id<=r.id))
                    ) ELSE r.position END,
                    CASE WHEN r.content_md LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                      THEN substr(r.content_md,max(1,instr(lower(r.content_md),lower(?4))-42),140)
                      ELSE '' END,
                    r.updated_at,
                    CASE WHEN r.content_md LIKE ?1 ESCAPE '\\' COLLATE NOCASE THEN 1 ELSE 0 END
             FROM rounds r JOIN projects p ON p.id=r.project_id
             WHERE p.deleted_at IS NULL AND r.deleted_at IS NULL AND
               (p.name LIKE ?1 ESCAPE '\\' COLLATE NOCASE OR r.note LIKE ?1 ESCAPE '\\' COLLATE NOCASE OR r.content_md LIKE ?1 ESCAPE '\\' COLLATE NOCASE)
             ORDER BY r.updated_at DESC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = statement.query_map(params![pattern, limit, offset, query], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get::<_, i64>(8)? != 0,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    Ok(raw
        .into_iter()
        .map(
            |(
                project_id,
                project_name,
                round_id,
                status,
                note,
                position,
                content_preview,
                updated_at,
                content_matched,
            )| {
                let bounded_content = content_preview
                    .replace(MATCH_START, "")
                    .replace(MATCH_END, "");
                let (haystack, match_field) = if content_matched {
                    (bounded_content, "content")
                } else if case_insensitive_range(&note, query).is_some() {
                    (note.clone(), "note")
                } else {
                    (project_name.clone(), "project")
                };
                let (excerpt, match_start, match_end) = make_excerpt(&haystack, query);
                SearchResult {
                    project_id,
                    project_name,
                    round_id,
                    status,
                    position,
                    note,
                    excerpt,
                    // 坐标只相对有界摘要；打开结果后前端会用当前完整正文重新定位。
                    match_start,
                    match_end,
                    match_field: match_field.into(),
                    updated_at,
                }
            },
        )
        .collect())
}

fn raw_settings(connection: &Connection) -> AppResult<Option<String>> {
    connection
        .query_row(
            "SELECT versioned_json_value FROM app_settings WHERE key='settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

pub fn load_settings(connection: &Connection) -> AppResult<AppSettings> {
    let settings = match raw_settings(connection)? {
        Some(json) => serde_json::from_str(&json).map_err(|_| {
            AppError::Validation("已保存的应用设置 JSON 损坏；原始值未被覆盖".into())
        })?,
        None => AppSettings::default(),
    };
    if settings.format_version > 1 {
        return Err(AppError::Validation(format!(
            "应用设置格式 v{} 高于本程序支持的 v1；未覆盖原值",
            settings.format_version
        )));
    }
    validate_settings(&settings)?;
    Ok(settings)
}

pub fn recover_settings_or_default(
    connection: &Connection,
) -> AppResult<(AppSettings, Option<String>)> {
    let Some(raw) = raw_settings(connection)? else {
        return Ok((AppSettings::default(), None));
    };
    match serde_json::from_str::<AppSettings>(&raw) {
        Ok(settings) if settings.format_version > 1 => Err(AppError::Validation(format!(
            "应用设置格式 v{} 高于本程序支持的 v1；未覆盖原值",
            settings.format_version
        ))),
        Ok(settings) => match validate_settings(&settings) {
            Ok(()) => Ok((settings, None)),
            Err(error) => recover_broken_settings(connection, &raw, error.to_string()),
        },
        Err(_) => recover_broken_settings(connection, &raw, "已保存的应用设置 JSON 损坏".into()),
    }
}

fn recover_broken_settings(
    connection: &Connection,
    raw: &str,
    reason: String,
) -> AppResult<(AppSettings, Option<String>)> {
    let settings = AppSettings::default();
    let transaction = connection.unchecked_transaction()?;
    let backup_key = format!("settings.broken.{}.{}", now_ms(), Uuid::new_v4());
    transaction.execute(
        "INSERT INTO app_settings(key,versioned_json_value,updated_at) VALUES (?1,?2,?3)",
        params![backup_key, raw, now_ms()],
    )?;
    let json = serde_json::to_string(&settings)?;
    transaction.execute(
        "INSERT INTO app_settings(key,versioned_json_value,updated_at) VALUES ('settings',?1,?2)
         ON CONFLICT(key) DO UPDATE SET versioned_json_value=excluded.versioned_json_value,updated_at=excluded.updated_at",
        params![json, now_ms()],
    )?;
    transaction.commit()?;
    Ok((settings, Some(reason)))
}

pub fn save_settings(connection: &Connection, settings: &AppSettings) -> AppResult<()> {
    validate_settings(settings)?;
    let json = serde_json::to_string(settings)?;
    connection.execute(
        "INSERT INTO app_settings(key,versioned_json_value,updated_at) VALUES ('settings',?1,?2)
         ON CONFLICT(key) DO UPDATE SET versioned_json_value=excluded.versioned_json_value,updated_at=excluded.updated_at",
        params![json, now_ms()],
    )?;
    Ok(())
}

fn validate_settings(settings: &AppSettings) -> AppResult<()> {
    if settings.format_version != 1 {
        return Err(AppError::Validation("应用设置格式版本无效".into()));
    }
    if !matches!(
        settings.theme.as_str(),
        "system" | "neutral" | "warm" | "mint" | "lavender" | "graphite"
    ) || !matches!(settings.default_editor_mode.as_str(), "wysiwyg" | "source")
    {
        return Err(AppError::Validation("主题或默认编辑模式无效".into()));
    }
    if !(12..=22).contains(&settings.ui_font_size)
        || !(12..=32).contains(&settings.body_font_size)
        || !(11..=28).contains(&settings.code_font_size)
    {
        return Err(AppError::Validation("字号超出允许范围".into()));
    }
    for weight in [
        settings.ui_font_weight,
        settings.body_font_weight,
        settings.code_font_weight,
    ] {
        if ![400, 500, 600, 700].contains(&weight) {
            return Err(AppError::Validation(
                "字体粗细只能是 400、500、600 或 700".into(),
            ));
        }
    }
    if !(0..=20).contains(&settings.preview_lines) {
        return Err(AppError::Validation(
            "预览行数只能为 1～20，0 表示不折叠".into(),
        ));
    }
    if !(1.2..=2.2).contains(&settings.body_line_height)
        || !(1.2..=2.0).contains(&settings.code_line_height)
    {
        return Err(AppError::Validation("行高超出允许范围".into()));
    }
    for values in [
        &settings.ui_fallback_families,
        &settings.body_fallback_families,
        &settings.code_fallback_families,
        &settings.favorite_font_ids,
        &settings.recent_font_ids,
    ] {
        if values.len() > 64
            || values
                .iter()
                .any(|value| value.is_empty() || value.chars().count() > 160)
        {
            return Err(AppError::Validation("字体偏好列表超出安全范围".into()));
        }
    }
    for family in [
        &settings.ui_font_family,
        &settings.body_font_family,
        &settings.code_font_family,
    ] {
        if family.trim().is_empty()
            || family.chars().count() > 160
            || family.chars().any(char::is_control)
        {
            return Err(AppError::Validation(
                "字体名称为空、过长或包含控制字符".into(),
            ));
        }
    }
    if !(200..=340).contains(&settings.project_panel_width)
        || !(280..=460).contains(&settings.timeline_panel_width)
    {
        return Err(AppError::Validation("面板宽度超出允许范围".into()));
    }
    Ok(())
}

pub fn get_view_state(
    connection: &Connection,
    project_id: &str,
) -> AppResult<Option<ProjectViewState>> {
    connection
        .query_row(
            "SELECT project_id,selected_round_id,timeline_anchor_round_id,anchor_offset_px,editor_mode,
                    cursor_anchor,cursor_head,detail_open,updated_at
             FROM project_view_state WHERE project_id=?1",
            params![project_id],
            |row| {
                Ok(ProjectViewState {
                    project_id: row.get(0)?,selected_round_id: row.get(1)?,timeline_anchor_round_id: row.get(2)?,
                    anchor_offset_px: row.get(3)?,editor_mode: row.get(4)?,cursor_anchor: row.get(5)?,
                    cursor_head: row.get(6)?,detail_open: row.get::<_,i64>(7)? != 0,updated_at: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

pub fn save_view_state(connection: &Connection, state: &ProjectViewState) -> AppResult<()> {
    if !matches!(state.editor_mode.as_str(), "wysiwyg" | "source")
        || !state.anchor_offset_px.is_finite()
        || state.anchor_offset_px.abs() > 1_000_000.0
        || !(0..=10 * 1024 * 1024).contains(&state.cursor_anchor)
        || !(0..=10 * 1024 * 1024).contains(&state.cursor_head)
    {
        return Err(AppError::Validation("项目视图状态超出安全范围".into()));
    }
    let project_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND deleted_at IS NULL)",
        params![state.project_id],
        |row| row.get(0),
    )?;
    if !project_exists {
        return Err(AppError::NotFound("项目不存在或已删除".into()));
    }
    for round_id in [
        state.selected_round_id.as_deref(),
        state.timeline_anchor_round_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let belongs_to_project: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM rounds
             WHERE id=?1 AND project_id=?2 AND deleted_at IS NULL)",
            params![round_id, state.project_id],
            |row| row.get(0),
        )?;
        if !belongs_to_project {
            return Err(AppError::Validation(
                "视图状态引用了不属于当前项目的轮次".into(),
            ));
        }
    }
    connection.execute(
        "INSERT INTO project_view_state(project_id,selected_round_id,timeline_anchor_round_id,anchor_offset_px,
          editor_mode,cursor_anchor,cursor_head,detail_open,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(project_id) DO UPDATE SET selected_round_id=excluded.selected_round_id,
          timeline_anchor_round_id=excluded.timeline_anchor_round_id,anchor_offset_px=excluded.anchor_offset_px,
          editor_mode=excluded.editor_mode,cursor_anchor=excluded.cursor_anchor,cursor_head=excluded.cursor_head,
          detail_open=excluded.detail_open,updated_at=excluded.updated_at",
        params![state.project_id,state.selected_round_id,state.timeline_anchor_round_id,state.anchor_offset_px,
          state.editor_mode,state.cursor_anchor,state.cursor_head,state.detail_open as i64,now_ms()],
    )?;
    Ok(())
}

#[cfg(test)]
pub fn purge_expired_trash(connection: &Connection) -> AppResult<usize> {
    const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
    let cutoff = now_ms() - RETENTION_MS;
    let transaction = connection.unchecked_transaction()?;
    let expired_projects = {
        let mut statement = transaction
            .prepare("SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?1")?;
        statement
            .query_map(params![cutoff], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for project_id in &expired_projects {
        transaction.execute(
            "DELETE FROM search_index WHERE project_id=?1",
            params![project_id],
        )?;
        transaction.execute(
            "DELETE FROM project_view_state WHERE project_id=?1",
            params![project_id],
        )?;
        transaction.execute(
            "DELETE FROM rounds WHERE project_id=?1",
            params![project_id],
        )?;
        transaction.execute("DELETE FROM projects WHERE id=?1", params![project_id])?;
    }
    let expired_round_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM rounds WHERE deleted_at IS NOT NULL AND deleted_at < ?1")?;
        statement
            .query_map(params![cutoff], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for round_id in &expired_round_ids {
        clear_round_view_references(&transaction, round_id)?;
        transaction.execute(
            "DELETE FROM search_index WHERE round_id=?1",
            params![round_id],
        )?;
        transaction.execute("DELETE FROM rounds WHERE id=?1", params![round_id])?;
    }
    let removed = expired_projects.len() + expired_round_ids.len();
    transaction.commit()?;
    Ok(removed)
}

pub fn list_trash(connection: &Connection) -> AppResult<Vec<TrashItem>> {
    let mut result = Vec::new();
    let mut projects = connection.prepare(
        "SELECT id,name,deleted_at FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    )?;
    result.extend(
        projects
            .query_map([], |row| {
                Ok(TrashItem {
                    id: row.get(0)?,
                    kind: "project".into(),
                    name: row.get(1)?,
                    project_id: None,
                    deleted_at: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?,
    );
    let mut rounds = connection.prepare(
        "SELECT r.id,CASE WHEN r.note<>'' THEN r.note ELSE substr(replace(r.content_md,char(10),' '),1,60) END,
                r.project_id,r.deleted_at FROM rounds r JOIN projects p ON p.id=r.project_id
         WHERE r.deleted_at IS NOT NULL AND p.deleted_at IS NULL ORDER BY r.deleted_at DESC",
    )?;
    result.extend(
        rounds
            .query_map([], |row| {
                Ok(TrashItem {
                    id: row.get(0)?,
                    kind: "round".into(),
                    name: row.get(1)?,
                    project_id: row.get(2)?,
                    deleted_at: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?,
    );
    result.sort_by_key(|item| std::cmp::Reverse(item.deleted_at));
    Ok(result)
}

pub fn permanently_delete(connection: &Connection, kind: &str, id: &str) -> AppResult<()> {
    let transaction = connection.unchecked_transaction()?;
    match kind {
        "round" => {
            clear_round_view_references(&transaction, id)?;
            let changed = transaction.execute(
                "DELETE FROM rounds WHERE id=?1 AND deleted_at IS NOT NULL",
                params![id],
            )?;
            if changed == 0 {
                return Err(AppError::NotFound("最近删除中没有该轮次".into()));
            }
            transaction.execute("DELETE FROM search_index WHERE round_id=?1", params![id])?;
        }
        "project" => {
            let deleted: Option<i64> = transaction
                .query_row(
                    "SELECT deleted_at FROM projects WHERE id=?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            if deleted.is_none() {
                return Err(AppError::NotFound("最近删除中没有该项目".into()));
            }
            transaction.execute("DELETE FROM search_index WHERE project_id=?1", params![id])?;
            transaction.execute(
                "DELETE FROM project_view_state WHERE project_id=?1",
                params![id],
            )?;
            transaction.execute("DELETE FROM rounds WHERE project_id=?1", params![id])?;
            transaction.execute("DELETE FROM projects WHERE id=?1", params![id])?;
        }
        _ => return Err(AppError::Validation("未知的最近删除对象类型".into())),
    }
    transaction.commit()?;
    Ok(())
}

pub fn quick_check(connection: &Connection) -> AppResult<bool> {
    let result: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    Ok(result == "ok")
}

pub fn setting_json(connection: &Connection, key: &str) -> AppResult<Option<Value>> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT versioned_json_value FROM app_settings WHERE key=?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|json| serde_json::from_str(&json).map_err(Into::into))
        .transpose()
}

fn validate_window_state(state: &WindowState) -> AppResult<()> {
    if !(680..=16_384).contains(&state.width)
        || !(520..=16_384).contains(&state.height)
        || !state.scale_factor.is_finite()
        || !(0.5..=8.0).contains(&state.scale_factor)
        || state
            .monitor_name
            .as_ref()
            .is_some_and(|name| name.chars().count() > 256 || name.chars().any(char::is_control))
    {
        return Err(AppError::Validation(
            "窗口尺寸、缩放值或显示器名称超出安全范围".into(),
        ));
    }
    Ok(())
}

pub fn load_window_state(connection: &Connection) -> AppResult<Option<WindowState>> {
    let state = setting_json(connection, "window_state")?
        .map(serde_json::from_value)
        .transpose()?;
    if let Some(state) = &state {
        validate_window_state(state)?;
    }
    Ok(state)
}

pub fn save_window_state(connection: &Connection, state: &WindowState) -> AppResult<()> {
    validate_window_state(state)?;
    let json = serde_json::to_string(state)?;
    connection.execute(
        "INSERT INTO app_settings(key,versioned_json_value,updated_at) VALUES ('window_state',?1,?2)
         ON CONFLICT(key) DO UPDATE SET versioned_json_value=excluded.versioned_json_value,
         updated_at=excluded.updated_at",
        params![json, now_ms()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().expect("open");
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")
            .expect("pragmas");
        migrate(&connection).expect("migrate");
        connection
    }

    #[test]
    fn creates_monotonic_default_projects() {
        let db = memory_db();
        let second = create_project(&db, None).expect("second");
        delete_project(&db, &second.id).expect("delete");
        let third = create_project(&db, Some("   ")).expect("third");
        assert_eq!(second.name, "Vibe Coding 项目-2");
        assert_eq!(third.name, "Vibe Coding 项目-3");
    }

    #[test]
    fn project_names_reject_control_characters() {
        let db = memory_db();
        let error = create_project(&db, Some("被换行\n破坏的名称")).expect_err("control");
        assert!(error.to_string().contains("控制字符"));

        let project = list_projects(&db).expect("projects").remove(0);
        let error = rename_project(&db, &project.id, "被制表符\t破坏").expect_err("control");
        assert!(error.to_string().contains("控制字符"));
    }

    #[test]
    fn damaged_settings_are_reported_without_being_replaced() {
        let db = memory_db();
        let damaged = r#"{"theme":"neutral","uiFontSize":"broken"}"#;
        db.execute(
            "INSERT INTO app_settings(key,versioned_json_value,updated_at)
             VALUES ('settings',?1,1)
             ON CONFLICT(key) DO UPDATE SET versioned_json_value=excluded.versioned_json_value",
            params![damaged],
        )
        .expect("seed damaged settings");

        let error = load_settings(&db).expect_err("damaged settings must fail");

        assert!(error.to_string().contains("设置 JSON 损坏"));
        let preserved: String = db
            .query_row(
                "SELECT versioned_json_value FROM app_settings WHERE key='settings'",
                [],
                |row| row.get(0),
            )
            .expect("preserved raw settings");
        assert_eq!(preserved, damaged);
    }

    #[test]
    fn damaged_settings_are_backed_up_before_default_recovery() {
        let db = memory_db();
        let damaged = r#"{"theme":"neutral","uiFontSize":"broken"}"#;
        db.execute(
            "INSERT INTO app_settings(key,versioned_json_value,updated_at) VALUES ('settings',?1,1)",
            params![damaged],
        )
        .expect("seed");

        let (settings, warning) = recover_settings_or_default(&db).expect("recover");
        assert_eq!(settings, AppSettings::default());
        assert!(warning.is_some());
        let backup: String = db
            .query_row(
                "SELECT versioned_json_value FROM app_settings WHERE key LIKE 'settings.broken.%'",
                [],
                |row| row.get(0),
            )
            .expect("backup");
        assert_eq!(backup, damaged);
        assert_eq!(load_settings(&db).expect("default"), AppSettings::default());
    }

    #[test]
    fn damaged_or_out_of_range_window_state_is_rejected_without_overwrite() {
        let db = memory_db();
        let damaged = r#"{"width":"broken"}"#;
        db.execute(
            "INSERT INTO app_settings(key,versioned_json_value,updated_at) VALUES ('window_state',?1,1)",
            params![damaged],
        )
        .expect("seed window state");
        assert!(load_window_state(&db).is_err());
        let preserved: String = db
            .query_row(
                "SELECT versioned_json_value FROM app_settings WHERE key='window_state'",
                [],
                |row| row.get(0),
            )
            .expect("preserved window state");
        assert_eq!(preserved, damaged);

        let invalid = WindowState {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            maximized: false,
            scale_factor: 1.0,
            monitor_name: None,
        };
        assert!(save_window_state(&db, &invalid).is_err());
    }

    #[test]
    fn view_state_rejects_round_from_another_project() {
        let db = memory_db();
        let first = list_projects(&db).expect("projects").remove(0);
        let second = create_project(&db, Some("第二项目")).expect("second");
        let foreign_round = list_rounds(&db, &second.id).expect("rounds").remove(0);
        let state = ProjectViewState {
            project_id: first.id,
            selected_round_id: Some(foreign_round.id),
            timeline_anchor_round_id: None,
            anchor_offset_px: 0.0,
            editor_mode: "wysiwyg".into(),
            cursor_anchor: 0,
            cursor_head: 0,
            detail_open: true,
            updated_at: 1,
        };

        let error = save_view_state(&db, &state).expect_err("foreign round must fail");

        assert!(error.to_string().contains("不属于当前项目"));
    }

    #[test]
    fn deleting_selected_round_clears_view_state_references() {
        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        let draft = list_rounds(&db, &project.id).expect("rounds").remove(0);
        save_round(&db, &draft.id, "第一轮", "", 0).expect("save");
        let final_round = finalize_draft(&db, &project.id)
            .expect("finalize")
            .finalized_round;
        save_view_state(
            &db,
            &ProjectViewState {
                project_id: project.id.clone(),
                selected_round_id: Some(final_round.id.clone()),
                timeline_anchor_round_id: Some(final_round.id.clone()),
                anchor_offset_px: 72.5,
                editor_mode: "source".into(),
                cursor_anchor: 0,
                cursor_head: 0,
                detail_open: true,
                updated_at: 1,
            },
        )
        .expect("view state");

        delete_round(&db, &final_round.id).expect("delete");

        let state = get_view_state(&db, &project.id)
            .expect("load state")
            .expect("state");
        assert_eq!(state.selected_round_id, None);
        assert_eq!(state.timeline_anchor_round_id, None);
        assert_eq!(state.anchor_offset_px, 0.0);
    }

    #[test]
    fn finalizes_non_empty_draft_atomically() {
        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        let draft = list_rounds(&db, &project.id).expect("rounds").remove(0);
        save_round(&db, &draft.id, "# 第一轮", "说明", 0).expect("save");
        let result = finalize_draft(&db, &project.id).expect("finalize");
        assert_eq!(result.finalized_round.content_md, "# 第一轮");
        assert_eq!(result.finalized_round.position, 0);
        assert_eq!(result.draft.status, "draft");
        assert!(result.draft.content_md.is_empty());
    }

    #[test]
    fn deleted_project_blocks_all_active_round_access() {
        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        let draft = list_rounds(&db, &project.id).expect("rounds").remove(0);
        save_round(&db, &draft.id, "待保护内容", "", 0).expect("save");
        delete_project(&db, &project.id).expect("delete project");

        assert!(list_rounds(&db, &project.id).is_err());
        assert!(get_round(&db, &draft.id).is_err());
        assert!(save_round(&db, &draft.id, "隐藏改写", "", 1).is_err());
        assert!(finalize_draft(&db, &project.id).is_err());
        assert!(delete_round(&db, &draft.id).is_err());
        assert!(reorder_rounds(&db, &project.id, &[]).is_err());
    }

    #[test]
    fn refuses_stale_revision_without_overwrite() {
        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        let draft = list_rounds(&db, &project.id).expect("rounds").remove(0);
        save_round(&db, &draft.id, "新内容", "", 0).expect("first save");
        let error = save_round(&db, &draft.id, "旧客户端覆盖", "", 0).expect_err("conflict");
        assert!(matches!(error, AppError::RevisionConflict(_)));
        assert_eq!(
            get_round(&db, &draft.id).expect("detail").content_md,
            "新内容"
        );
    }

    #[test]
    fn conflict_resolution_can_keep_both_or_replace_after_recovery_point() {
        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        let draft = list_rounds(&db, &project.id).expect("rounds").remove(0);
        save_round(&db, &draft.id, "数据库版本", "原备注", 0).expect("save");
        let recovered =
            keep_both_after_conflict(&db, &draft.id, "本地版本", "恢复备注").expect("keep both");
        assert_eq!(recovered.status, "final");
        assert_eq!(recovered.content_md, "本地版本");
        assert_eq!(
            get_round(&db, &draft.id)
                .expect("database version")
                .content_md,
            "数据库版本"
        );
        let replaced =
            replace_round_after_conflict(&db, &draft.id, "明确替换", "新备注", 1).expect("replace");
        assert_eq!(replaced.content_md, "明确替换");
        assert_eq!(replaced.note, "新备注");
        let stale = replace_round_after_conflict(&db, &draft.id, "过期替换", "", 1)
            .expect_err("stale replacement");
        assert!(matches!(stale, AppError::RevisionConflict(_)));
        assert_eq!(
            get_round(&db, &draft.id).expect("current").content_md,
            "明确替换"
        );
    }

    #[test]
    fn short_and_trigram_search_include_drafts() {
        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        let draft = list_rounds(&db, &project.id).expect("rounds").remove(0);
        save_round(&db, &draft.id, "中文搜索 TypeScript", "重点", 0).expect("save");
        assert_eq!(search(&db, "中", 100, 0).expect("short").len(), 1);
        assert_eq!(search(&db, "typescript", 100, 0).expect("fts").len(), 1);
    }

    #[test]
    fn search_uses_contiguous_display_position_after_deletion() {
        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        let mut finals = Vec::new();
        for index in 0..3 {
            let draft = list_rounds(&db, &project.id)
                .expect("rounds")
                .into_iter()
                .find(|round| round.status == "draft")
                .expect("draft");
            save_round(&db, &draft.id, &format!("唯一内容-{index}"), "", 0).expect("save");
            finals.push(
                finalize_draft(&db, &project.id)
                    .expect("finalize")
                    .finalized_round,
            );
        }
        delete_round(&db, &finals[1].id).expect("delete middle");

        let result = search(&db, "唯一内容-2", 100, 0).expect("search").remove(0);
        assert_eq!(result.position, 1);
    }

    #[test]
    fn search_returns_bounded_excerpt_for_deep_large_content_matches() {
        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        let draft = list_rounds(&db, &project.id).expect("rounds").remove(0);
        let content = format!(
            "{}needle-target针{}",
            "前置内容 ".repeat(20_000),
            " 后置内容".repeat(20_000)
        );
        save_round(&db, &draft.id, &content, "", 0).expect("save");

        let fts = search(&db, "needle-target", 100, 0).expect("fts").remove(0);
        assert_eq!(fts.match_field, "content");
        assert!(fts.excerpt.contains("needle-target"));
        assert!(fts.excerpt.chars().count() <= 140);

        let short = search(&db, "针", 100, 0).expect("short").remove(0);
        assert!(short.excerpt.contains('针'));
        assert!(short.excerpt.chars().count() <= 140);
    }

    #[test]
    fn project_delete_is_recoverable() {
        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        delete_project(&db, &project.id).expect("delete");
        assert!(list_projects(&db).expect("list").is_empty());
        assert_eq!(list_trash(&db).expect("trash")[0].kind, "project");
        restore_project(&db, &project.id).expect("restore");
        assert_eq!(list_projects(&db).expect("list").len(), 1);
    }

    #[test]
    fn restoring_a_round_reopens_its_position_without_duplicates() {
        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        let first_draft = list_rounds(&db, &project.id).expect("rounds").remove(0);
        save_round(&db, &first_draft.id, "第一轮", "", 0).expect("save first");
        let first = finalize_draft(&db, &project.id)
            .expect("finalize first")
            .finalized_round;
        let second_draft = list_rounds(&db, &project.id)
            .expect("rounds")
            .into_iter()
            .find(|round| round.status == "draft")
            .expect("second draft");
        save_round(&db, &second_draft.id, "第二轮", "", 0).expect("save second");
        let second = finalize_draft(&db, &project.id)
            .expect("finalize second")
            .finalized_round;

        delete_round(&db, &first.id).expect("delete first");
        reorder_rounds(&db, &project.id, std::slice::from_ref(&second.id)).expect("compact");
        restore_round(&db, &first.id).expect("restore first");

        let finals = list_rounds(&db, &project.id)
            .expect("rounds")
            .into_iter()
            .filter(|round| round.status == "final")
            .collect::<Vec<_>>();
        assert_eq!(
            finals
                .iter()
                .map(|round| (round.id.as_str(), round.position))
                .collect::<Vec<_>>(),
            vec![(first.id.as_str(), 0), (second.id.as_str(), 1)]
        );
    }

    #[test]
    fn unicode_character_count_is_scalar_based() {
        assert_eq!(unicode_len("中文😀a"), 4);
    }

    #[test]
    fn search_excerpt_does_not_panic_on_case_mapping_length_changes() {
        // 'İ'(U+0130) 小写化后字节数变化；旧实现用小写字节偏移切原文会 panic。
        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        let draft = list_rounds(&db, &project.id).expect("rounds").remove(0);
        save_round(&db, &draft.id, "İstanbul 城市 İ 记录", "备注", 0).expect("save");
        let hits = search(&db, "城市", 100, 0).expect("search");
        assert_eq!(hits.len(), 1);
        // 命中范围必须落在合法字符边界上（能安全按字符切片）。
        let hit = &hits[0];
        assert!(hit.match_start >= 0 && hit.match_end >= hit.match_start);
    }

    #[test]
    fn search_offsets_use_javascript_utf16_units_and_report_match_field() {
        let (excerpt, start, end) = make_excerpt("😀alpha", "alpha");
        assert!(excerpt.contains("alpha"));
        assert_eq!((start, end), (2, 7));

        let db = memory_db();
        let project = list_projects(&db).expect("projects").remove(0);
        let draft = list_rounds(&db, &project.id).expect("rounds").remove(0);
        save_round(&db, &draft.id, "正文", "emoji 😀 备注命中", 0).expect("save");
        let hit = search(&db, "备注命中", 100, 0).expect("search").remove(0);
        assert_eq!(hit.match_field, "note");
    }

    #[test]
    fn database_capacity_guard_reports_size() {
        let db = memory_db();
        // 新库远小于软/硬阈值。
        assert!(database_size_bytes(&db).expect("size") < DATABASE_WARN_BYTES);
    }

    #[test]
    fn trash_older_than_thirty_days_is_purged_without_touching_recent_items() {
        let db = memory_db();
        let first = list_projects(&db).expect("projects").remove(0);
        delete_project(&db, &first.id).expect("delete old project");
        db.execute(
            "UPDATE projects SET deleted_at=?1 WHERE id=?2",
            params![now_ms() - 31 * 24 * 60 * 60 * 1_000, first.id],
        )
        .expect("age project");
        let recent = create_project(&db, Some("最近删除")).expect("recent project");
        delete_project(&db, &recent.id).expect("delete recent project");
        assert_eq!(purge_expired_trash(&db).expect("purge"), 1);
        let trash = list_trash(&db).expect("trash");
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, recent.id);
    }

    #[test]
    fn refuses_unknown_newer_schema_without_modifying_database() {
        let temp = tempfile::tempdir().expect("temp");
        let path = temp.path().join("future.sqlite3");
        {
            let connection = Connection::open(&path).expect("open future database");
            connection
                .execute_batch(
                    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
                     CREATE TABLE untouched(value TEXT NOT NULL);
                     INSERT INTO schema_migrations(version) VALUES (999);
                     INSERT INTO untouched(value) VALUES ('保留');",
                )
                .expect("seed future schema");
        }
        let before = fs::read(&path).expect("before");
        let error = open_managed(&path, Some(temp.path()), false).expect_err("must refuse");
        assert!(error.to_string().contains("高于本程序支持"));
        assert_eq!(fs::read(&path).expect("after"), before);
    }

    #[test]
    fn migration_creates_consistent_recovery_snapshot_first() {
        let temp = tempfile::tempdir().expect("temp");
        let path = temp.path().join("old.sqlite3");
        {
            let connection = open(&path).expect("create current database");
            connection
                .execute("DELETE FROM schema_migrations WHERE version=2", [])
                .expect("simulate v1 marker");
        }
        let recovery = temp.path().join("recovery");
        let connection = open_managed(&path, Some(&recovery), false).expect("migrate");
        assert_eq!(
            existing_schema_version(&connection).expect("version"),
            Some(2)
        );
        let snapshots = fs::read_dir(recovery)
            .expect("recovery directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("snapshots");
        assert_eq!(snapshots.len(), 1);
        let snapshot = Connection::open(snapshots[0].path()).expect("snapshot database");
        assert_eq!(
            existing_schema_version(&snapshot).expect("snapshot version"),
            Some(1)
        );
        assert!(quick_check(&snapshot).expect("snapshot integrity"));
    }

    #[test]
    fn clean_shutdown_checkpoint_truncates_wal() {
        let temp = tempfile::tempdir().expect("temp");
        let path = temp.path().join("checkpoint.sqlite3");
        let connection = open(&path).expect("database");
        connection
            .execute(
                "INSERT INTO meta(key,value) VALUES ('checkpoint-test','written')",
                [],
            )
            .expect("write");
        let wal = path.with_extension("sqlite3-wal");
        assert!(fs::metadata(&wal).expect("wal").len() > 0);

        checkpoint_wal(&connection).expect("checkpoint");

        assert_eq!(
            fs::metadata(&wal)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            0
        );
    }
}
