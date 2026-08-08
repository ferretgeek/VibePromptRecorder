use crate::{
    db,
    error::{AppError, AppResult},
    file_atomic, fonts,
    models::{BackupInfo, ExportResult, ProjectSummary, RestorePreparation},
    paths::DataPaths,
};
use chrono::{Datelike, Local, TimeZone, Utc};
use parking_lot::Mutex;
use rusqlite::{Connection, backup::Backup, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

const ARCHIVE_FORMAT_VERSION: u32 = 1;
const MANIFEST_LIMIT: u64 = 8 * 1024 * 1024;
const PROJECT_UNPACKED_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
const BACKUP_UNPACKED_LIMIT: u64 = 10 * 1024 * 1024 * 1024;
const DATABASE_LIMIT: u64 = 8 * 1024 * 1024 * 1024;
const FONT_LIMIT: u64 = 50 * 1024 * 1024;
const FONT_TOTAL_LIMIT: u64 = 500 * 1024 * 1024;
const ENTRY_LIMIT: usize = 20_000;
const AUTO_BACKUP_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const CONFLICT_BACKUP_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const RESTORE_SPACE_MARGIN: u64 = 64 * 1024 * 1024;
const MAX_PROJECT_NAME_CHARS: usize = 120;
const MAX_TIMESTAMP_MS: i64 = 253_402_300_799_999;
const MAX_SAFE_REVISION: i64 = 9_007_199_254_740_990;
const DRAFT_POSITION: i64 = 2_147_483_647;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    path: String,
    byte_count: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveManifest {
    kind: String,
    format_version: u32,
    database_schema_version: i64,
    app_version: String,
    created_at: i64,
    min_reader_format_version: u32,
    includes_fonts: bool,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRecord {
    id: String,
    name: String,
    is_pinned: bool,
    created_at: i64,
    updated_at: i64,
    last_opened_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoundRecord {
    id: String,
    position: i64,
    status: String,
    created_at: i64,
    finalized_at: Option<i64>,
    updated_at: i64,
    revision: i64,
    note: String,
    content_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPackage {
    format_version: u32,
    project: ProjectRecord,
    rounds: Vec<RoundRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreState {
    format_version: u32,
    restore_id: String,
    includes_fonts: bool,
    #[serde(default)]
    database_schema_version: i64,
    phase: String,
    prepared_at: i64,
}

enum EntrySource {
    Bytes(Vec<u8>),
    File(PathBuf),
    RoundContent(String),
}

struct ArchiveEntry {
    path: String,
    source: EntrySource,
}

struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct TempDirectory {
    path: PathBuf,
    keep: bool,
}

impl TempDirectory {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }

    fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_file(path: &Path) -> AppResult<(String, u64)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    let mut size = 0_u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        size = size
            .checked_add(count as u64)
            .ok_or_else(|| AppError::Validation("文件大小溢出".into()))?;
    }
    Ok((
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        size,
    ))
}

fn safe_target(path: &Path, extension: &str) -> AppResult<()> {
    if !path.is_absolute() {
        return Err(AppError::Validation("导出目标必须是完整路径".into()));
    }
    let actual = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if actual.as_deref() != Some(extension) {
        return Err(AppError::Validation(format!(
            "目标文件扩展名必须是 .{extension}"
        )));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Validation("目标文件没有有效父目录".into()))?;
    if !parent.is_dir() {
        return Err(AppError::Validation("目标目录不存在或不可访问".into()));
    }
    Ok(())
}

fn safe_archive_name(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 1024
        || name.contains(['\\', '\0'])
        || name.starts_with('/')
        || name.contains(':')
    {
        return false;
    }
    Path::new(name)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}

fn publish_atomically(temporary: &Path, target: &Path) -> AppResult<()> {
    file_atomic::replace_file(temporary, target).map_err(Into::into)
}

fn write_entry_once(
    writer: &mut ZipWriter<File>,
    entry: ArchiveEntry,
    options: SimpleFileOptions,
    connection: Option<&Connection>,
) -> AppResult<ManifestFile> {
    let ArchiveEntry { path, source } = entry;
    writer.start_file(&path, options)?;
    let mut hasher = Sha256::new();
    let mut byte_count = 0_u64;
    let mut write_chunk = |chunk: &[u8]| -> AppResult<()> {
        writer.write_all(chunk)?;
        hasher.update(chunk);
        byte_count = byte_count
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| AppError::Validation("归档条目大小溢出".into()))?;
        Ok(())
    };
    match source {
        EntrySource::Bytes(bytes) => write_chunk(&bytes)?,
        EntrySource::File(path) => {
            let mut input = File::open(path)?;
            let mut buffer = [0_u8; 128 * 1024];
            loop {
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                write_chunk(&buffer[..count])?;
            }
        }
        EntrySource::RoundContent(round_id) => {
            let connection = connection
                .ok_or_else(|| AppError::Validation("项目归档缺少只读数据库连接".into()))?;
            let round = db::get_round(connection, &round_id)?;
            write_chunk(round.content_md.as_bytes())?;
        }
    }
    Ok(ManifestFile {
        path,
        byte_count,
        sha256: hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    })
}

fn write_archive(
    target: &Path,
    kind: &str,
    includes_fonts: bool,
    entries: Vec<ArchiveEntry>,
    include_checksums: bool,
    connection: Option<&Connection>,
) -> AppResult<ExportResult> {
    if entries.len() > ENTRY_LIMIT.saturating_sub(2) {
        return Err(AppError::Validation("归档条目数量超过 20,000 个".into()));
    }
    for entry in &entries {
        if !safe_archive_name(&entry.path) {
            return Err(AppError::Validation(format!(
                "归档内部路径不安全：{}",
                entry.path
            )));
        }
    }
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Validation("目标文件没有有效父目录".into()))?;
    let temporary_path = parent.join(format!(".vpr-archive-{}.tmp", Uuid::new_v4()));
    let temporary_guard = TempFile(temporary_path.clone());
    let output = File::create(&temporary_path)?;
    let mut writer = ZipWriter::new(output);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    let mut files = Vec::with_capacity(entries.len());
    for entry in entries {
        files.push(write_entry_once(&mut writer, entry, options, connection)?);
    }
    let manifest = ArchiveManifest {
        kind: kind.into(),
        format_version: ARCHIVE_FORMAT_VERSION,
        database_schema_version: db::SCHEMA_VERSION,
        app_version: env!("CARGO_PKG_VERSION").into(),
        created_at: now_ms(),
        min_reader_format_version: 1,
        includes_fonts,
        files: files.clone(),
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    if manifest_bytes.len() as u64 > MANIFEST_LIMIT {
        return Err(AppError::Validation("归档 manifest 超过 8 MiB".into()));
    }
    writer.start_file("manifest.json", options)?;
    writer.write_all(&manifest_bytes)?;
    if include_checksums {
        let checksums = files
            .iter()
            .map(|file| format!("{}  {}\n", file.sha256, file.path))
            .collect::<String>();
        writer.start_file("checksums.sha256", options)?;
        writer.write_all(checksums.as_bytes())?;
    }
    let output = writer.finish()?;
    output.sync_all()?;
    publish_atomically(&temporary_path, target)?;
    drop(temporary_guard);
    let (sha256, byte_count) = sha256_file(target)?;
    Ok(ExportResult {
        path: target.to_string_lossy().into_owned(),
        byte_count,
        sha256,
    })
}

fn validate_zip_layout(
    archive: &mut ZipArchive<File>,
    unpacked_limit: u64,
) -> AppResult<HashMap<String, u64>> {
    if archive.len() > ENTRY_LIMIT {
        return Err(AppError::Validation("归档条目数量超过 20,000 个".into()));
    }
    let mut names = HashMap::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index)?;
        let name = file.name().to_string();
        if file.is_dir() || !safe_archive_name(&name) {
            return Err(AppError::Validation(format!(
                "归档包含目录、绝对路径或越界路径：{name}"
            )));
        }
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(AppError::Validation("归档不允许包含符号链接".into()));
        }
        if names.insert(name.clone(), file.size()).is_some() {
            return Err(AppError::Validation(format!("归档包含重复条目：{name}")));
        }
        total = total
            .checked_add(file.size())
            .ok_or_else(|| AppError::Validation("归档解压大小溢出".into()))?;
        if total > unpacked_limit {
            return Err(AppError::Validation("归档解压后超过本版本安全上限".into()));
        }
    }
    Ok(names)
}

fn read_entry_bytes(archive: &mut ZipArchive<File>, name: &str, limit: u64) -> AppResult<Vec<u8>> {
    let mut entry = archive.by_name(name)?;
    if entry.size() > limit {
        return Err(AppError::Validation(format!("归档条目过大：{name}")));
    }
    let mut bytes = Vec::with_capacity(entry.size().min(16 * 1024 * 1024) as usize);
    entry
        .by_ref()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(AppError::Validation(format!("归档条目过大：{name}")));
    }
    Ok(bytes)
}

fn open_validated_archive(
    path: &Path,
    kind: &str,
    limit: u64,
) -> AppResult<(ZipArchive<File>, ArchiveManifest, HashMap<String, u64>)> {
    if !path.is_file() {
        return Err(AppError::Validation("所选归档不存在或不是文件".into()));
    }
    let mut archive = ZipArchive::new(File::open(path)?)?;
    let names = validate_zip_layout(&mut archive, limit)?;
    let manifest_bytes = read_entry_bytes(&mut archive, "manifest.json", MANIFEST_LIMIT)?;
    let manifest: ArchiveManifest = serde_json::from_slice(&manifest_bytes)?;
    if manifest.kind != kind {
        return Err(AppError::Validation(format!(
            "归档类型不匹配：期望 {kind}，实际 {}",
            manifest.kind
        )));
    }
    if manifest.format_version != ARCHIVE_FORMAT_VERSION
        || manifest.min_reader_format_version > ARCHIVE_FORMAT_VERSION
    {
        return Err(AppError::Validation(
            "归档格式版本不受当前应用支持，现有数据未被修改".into(),
        ));
    }
    if manifest.database_schema_version > db::SCHEMA_VERSION {
        return Err(AppError::Validation(
            "归档来自更新的数据结构，当前版本不能安全降级读取".into(),
        ));
    }
    let mut expected = HashSet::new();
    expected.insert("manifest.json".to_string());
    if kind == "vcpbackup" {
        expected.insert("checksums.sha256".to_string());
    }
    for file in &manifest.files {
        if !safe_archive_name(&file.path) || !expected.insert(file.path.clone()) {
            return Err(AppError::Validation(
                "manifest 包含不安全或重复的文件路径".into(),
            ));
        }
        if names.get(&file.path).copied() != Some(file.byte_count) {
            return Err(AppError::Validation(format!(
                "归档文件大小与 manifest 不一致：{}",
                file.path
            )));
        }
    }
    if expected.len() != names.len() || expected.iter().any(|name| !names.contains_key(name)) {
        return Err(AppError::Validation(
            "归档包含 manifest 未声明的文件或缺少必要文件".into(),
        ));
    }
    Ok((archive, manifest, names))
}

fn verify_bytes(file: &ManifestFile, bytes: &[u8]) -> AppResult<()> {
    if bytes.len() as u64 != file.byte_count || sha256_bytes(bytes) != file.sha256 {
        return Err(AppError::Validation(format!(
            "归档校验失败，文件可能损坏：{}",
            file.path
        )));
    }
    Ok(())
}

pub fn export_project(
    connection: &Connection,
    project_id: &str,
    target: &Path,
) -> AppResult<ExportResult> {
    safe_target(target, "vcpproject")?;
    let entries = project_archive_entries(connection, project_id)?;
    write_archive(
        target,
        "vcpproject",
        false,
        entries,
        false,
        Some(connection),
    )
}

fn project_archive_entries(
    connection: &Connection,
    project_id: &str,
) -> AppResult<Vec<ArchiveEntry>> {
    let summary = db::get_project(connection, project_id)?;
    let rounds = db::list_rounds(connection, project_id)?;
    let mut round_records = Vec::with_capacity(rounds.len());
    let mut entries = Vec::with_capacity(rounds.len() + 1);
    for round in rounds {
        let content_path = format!("content/{}.md", round.id);
        entries.push(ArchiveEntry {
            path: content_path.clone(),
            source: EntrySource::RoundContent(round.id.clone()),
        });
        round_records.push(RoundRecord {
            id: round.id,
            position: round.position,
            status: round.status,
            created_at: round.created_at,
            finalized_at: round.finalized_at,
            updated_at: round.updated_at,
            revision: round.revision,
            note: round.note,
            content_path,
        });
    }
    let package = ProjectPackage {
        format_version: ARCHIVE_FORMAT_VERSION,
        project: ProjectRecord {
            id: summary.id,
            name: summary.name,
            is_pinned: summary.is_pinned,
            created_at: summary.created_at,
            updated_at: summary.updated_at,
            last_opened_at: summary.last_opened_at,
        },
        rounds: round_records,
    };
    entries.insert(
        0,
        ArchiveEntry {
            path: "project.json".into(),
            source: EntrySource::Bytes(serde_json::to_vec_pretty(&package)?),
        },
    );
    Ok(entries)
}

fn unique_import_name(connection: &Connection, base: &str) -> AppResult<String> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE name=?1 AND deleted_at IS NULL)",
        params![base],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(base.to_string());
    }
    for index in 1..=9_999 {
        let suffix = if index == 1 {
            "（导入）".to_string()
        } else {
            format!("（导入 {index}）")
        };
        let keep = 120_usize.saturating_sub(suffix.chars().count());
        let stem: String = base.chars().take(keep).collect();
        let candidate = format!("{stem}{suffix}");
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE name=?1 AND deleted_at IS NULL)",
            params![candidate],
            |row| row.get(0),
        )?;
        if !exists {
            return Ok(candidate);
        }
    }
    Err(AppError::Validation("无法生成不冲突的导入项目名称".into()))
}

fn valid_timestamp(value: i64) -> bool {
    (0..=MAX_TIMESTAMP_MS).contains(&value)
}

fn validate_project_package_metadata(package: &ProjectPackage) -> AppResult<()> {
    let name = package.project.name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_PROJECT_NAME_CHARS
        || name.contains(['\r', '\n'])
    {
        return Err(AppError::Validation("项目名称为空、过长或包含换行".into()));
    }
    if !valid_timestamp(package.project.created_at)
        || !valid_timestamp(package.project.updated_at)
        || !valid_timestamp(package.project.last_opened_at)
        || package.project.updated_at < package.project.created_at
        || package.project.last_opened_at < package.project.created_at
    {
        return Err(AppError::Validation(
            "项目时间元数据超出支持范围或顺序无效".into(),
        ));
    }
    for round in &package.rounds {
        if !valid_timestamp(round.created_at)
            || !valid_timestamp(round.updated_at)
            || round.updated_at < round.created_at
            || !(0..=MAX_SAFE_REVISION).contains(&round.revision)
        {
            return Err(AppError::Validation(
                "轮次时间或 revision 超出支持范围".into(),
            ));
        }
        match round.status.as_str() {
            "draft" if round.finalized_at.is_none() && round.position == DRAFT_POSITION => {}
            "final" => {
                let finalized_at = round
                    .finalized_at
                    .ok_or_else(|| AppError::Validation("正式轮次缺少完成时间".into()))?;
                if round.position < 0
                    || round.position >= DRAFT_POSITION
                    || !valid_timestamp(finalized_at)
                    || finalized_at < round.created_at
                    || finalized_at > round.updated_at
                {
                    return Err(AppError::Validation("正式轮次排序或时间元数据无效".into()));
                }
            }
            _ => {
                return Err(AppError::Validation(
                    "草稿轮次包含完成时间或排序位置无效".into(),
                ));
            }
        }
    }
    Ok(())
}

pub struct PreparedProjectImport {
    package: ProjectPackage,
    content_directory: PathBuf,
    _content_guard: TempDirectory,
    incoming_bytes: u64,
}

pub fn prepare_project_import(path: &Path, temp_root: &Path) -> AppResult<PreparedProjectImport> {
    let (mut archive, manifest, _) =
        open_validated_archive(path, "vcpproject", PROJECT_UNPACKED_LIMIT)?;
    let manifest_files = manifest
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<HashMap<_, _>>();
    let project_file = manifest_files
        .get("project.json")
        .copied()
        .ok_or_else(|| AppError::Validation("项目包缺少 project.json".into()))?;
    let project_bytes = read_entry_bytes(&mut archive, "project.json", MANIFEST_LIMIT)?;
    verify_bytes(project_file, &project_bytes)?;
    let package: ProjectPackage = serde_json::from_slice(&project_bytes)?;
    if package.format_version != ARCHIVE_FORMAT_VERSION
        || package.rounds.len() > ENTRY_LIMIT.saturating_sub(2)
    {
        return Err(AppError::Validation("项目元数据版本或轮次数量无效".into()));
    }
    Uuid::parse_str(&package.project.id)
        .map_err(|_| AppError::Validation("项目内部 ID 无效".into()))?;
    validate_project_package_metadata(&package)?;
    let mut seen_rounds = HashSet::new();
    let mut positions = HashSet::new();
    let mut draft_count = 0;
    let content_directory = temp_root.join(format!("import-project-{}", Uuid::new_v4()));
    fs::create_dir(&content_directory)?;
    let content_guard = TempDirectory::new(content_directory.clone());
    let mut incoming_bytes = 0_u64;
    for round in &package.rounds {
        Uuid::parse_str(&round.id).map_err(|_| AppError::Validation("轮次内部 ID 无效".into()))?;
        if !seen_rounds.insert(round.id.clone())
            || round.content_path != format!("content/{}.md", round.id)
            || !matches!(round.status.as_str(), "draft" | "final")
            || round.note.chars().count() > 120
            || round.note.contains(['\r', '\n'])
        {
            return Err(AppError::Validation("项目轮次元数据无效".into()));
        }
        if round.status == "draft" {
            draft_count += 1;
        } else if round.position < 0 || !positions.insert(round.position) {
            return Err(AppError::Validation("正式轮次排序位置无效或重复".into()));
        }
        let file = manifest_files
            .get(round.content_path.as_str())
            .copied()
            .ok_or_else(|| AppError::Validation("项目包缺少轮次正文".into()))?;
        // 单轮硬上限 10 MiB，与 db::save_round 一致，避免绕过写入超限内容。
        let bytes = read_entry_bytes(&mut archive, &round.content_path, 10 * 1024 * 1024)?;
        verify_bytes(file, &bytes)?;
        std::str::from_utf8(&bytes)
            .map_err(|_| AppError::Validation("轮次 Markdown 不是有效 UTF-8".into()))?;
        incoming_bytes = incoming_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| AppError::Validation("项目包正文大小溢出".into()))?;
        let staged = content_directory.join(format!("{}.md", round.id));
        let mut output = File::create(&staged)?;
        output.write_all(&bytes)?;
        output.sync_all()?;
    }
    if draft_count > 1 {
        return Err(AppError::Validation("项目包包含多个当前草稿".into()));
    }
    if manifest.files.len() != package.rounds.len() + 1 {
        return Err(AppError::Validation("项目包包含未引用的内容文件".into()));
    }
    Ok(PreparedProjectImport {
        package,
        content_directory,
        _content_guard: content_guard,
        incoming_bytes,
    })
}

pub fn commit_project_import(
    connection: &Connection,
    prepared: PreparedProjectImport,
) -> AppResult<ProjectSummary> {
    db::ensure_database_growth_capacity(connection, prepared.incoming_bytes)?;
    let package = &prepared.package;
    let project_id_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
        params![package.project.id],
        |row| row.get(0),
    )?;
    let new_project_id = if project_id_exists {
        Uuid::new_v4().to_string()
    } else {
        package.project.id.clone()
    };
    let name = unique_import_name(connection, package.project.name.trim())?;
    let imported_at = now_ms();
    let transaction = connection.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO projects(id,name,is_pinned,created_at,updated_at,last_opened_at,revision)
         VALUES (?1,?2,?3,?4,?5,?6,0)",
        params![
            new_project_id,
            name,
            package.project.is_pinned as i64,
            package.project.created_at.max(0),
            package.project.updated_at.max(0),
            imported_at,
        ],
    )?;
    let mut selected_round_id = None;
    for round in &package.rounds {
        let id_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM rounds WHERE id=?1)",
            params![round.id],
            |row| row.get(0),
        )?;
        let new_round_id = if id_exists {
            Uuid::new_v4().to_string()
        } else {
            round.id.clone()
        };
        let content =
            fs::read_to_string(prepared.content_directory.join(format!("{}.md", round.id)))?;
        transaction.execute(
            "INSERT INTO rounds(id,project_id,position,status,content_md,created_at,finalized_at,
             updated_at,revision,note) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                new_round_id,
                new_project_id,
                round.position,
                round.status,
                content,
                round.created_at.max(0),
                round.finalized_at,
                round.updated_at.max(0),
                round.revision.max(0),
                round.note,
            ],
        )?;
        transaction.execute(
            "INSERT INTO search_index(project_name,note,content_md,project_id,round_id,status)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                name,
                round.note,
                content,
                new_project_id,
                new_round_id,
                round.status
            ],
        )?;
        if round.status == "draft" {
            selected_round_id = Some(new_round_id);
        }
    }
    if selected_round_id.is_none() {
        let draft_id = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO rounds(id,project_id,position,status,content_md,created_at,updated_at,revision,note)
             VALUES (?1,?2,2147483647,'draft','',?3,?3,0,'')",
            params![draft_id, new_project_id, imported_at],
        )?;
        transaction.execute(
            "INSERT INTO search_index(project_name,note,content_md,project_id,round_id,status)
             VALUES (?1,'','',?2,?3,'draft')",
            params![name, new_project_id, draft_id],
        )?;
        selected_round_id = Some(draft_id);
    }
    transaction.execute(
        "INSERT INTO project_view_state(project_id,selected_round_id,editor_mode,detail_open,updated_at)
         VALUES (?1,?2,'wysiwyg',1,?3)",
        params![new_project_id, selected_round_id, imported_at],
    )?;
    transaction.commit()?;
    db::get_project(connection, &new_project_id)
}

#[cfg(test)]
pub fn import_project(connection: &Connection, path: &Path) -> AppResult<ProjectSummary> {
    let temp_root = path
        .parent()
        .ok_or_else(|| AppError::Validation("项目包没有父目录".into()))?;
    let prepared = prepare_project_import(path, temp_root)?;
    commit_project_import(connection, prepared)
}

fn snapshot_database(connection: &Connection, target: &Path) -> AppResult<()> {
    let mut destination = Connection::open(target)?;
    {
        let backup = Backup::new(connection, &mut destination)?;
        backup.run_to_completion(128, Duration::from_millis(5), None)?;
    }
    let integrity: String =
        destination.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Validation(
            "SQLite 一致性快照完整性检查失败".into(),
        ));
    }
    destination.close().map_err(|(_, error)| error)?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(target)?
        .sync_all()?;
    Ok(())
}

type ImportedFontRecord = (String, String, i64);

fn imported_font_records(connection: &Connection) -> AppResult<Vec<ImportedFontRecord>> {
    let mut statement = connection.prepare(
        "SELECT sha256,file_name,file_size FROM font_registry
         WHERE source='imported' AND is_available=1 ORDER BY sha256",
    )?;
    statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn imported_font_entries(
    records: Vec<ImportedFontRecord>,
    font_directory: &Path,
) -> AppResult<Vec<ArchiveEntry>> {
    let mut entries = Vec::new();
    let mut total = 0_u64;
    for (expected_sha, file_name, expected_size) in records {
        if Path::new(&file_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(&file_name)
        {
            return Err(AppError::Validation("字体登记包含不安全文件名".into()));
        }
        let source = font_directory.join(&file_name);
        let (actual_sha, actual_size) = sha256_file(&source)?;
        if actual_sha != expected_sha || actual_size != expected_size as u64 {
            return Err(AppError::Validation(format!(
                "已导入字体与登记哈希不一致：{file_name}"
            )));
        }
        if actual_size > FONT_LIMIT {
            return Err(AppError::Validation("单个字体超过 50 MiB 备份上限".into()));
        }
        total = total.saturating_add(actual_size);
        if total > FONT_TOTAL_LIMIT {
            return Err(AppError::Validation("已导入字体总量超过 500 MiB".into()));
        }
        entries.push(ArchiveEntry {
            path: format!("fonts/imported/{file_name}"),
            source: EntrySource::File(source),
        });
    }
    Ok(entries)
}

struct PreparedBackup {
    snapshot_guard: TempFile,
    snapshot_path: PathBuf,
    font_snapshot_guard: Option<TempDirectory>,
    font_entries: Vec<ArchiveEntry>,
}

fn prepare_database_backup_source(
    connection: &Connection,
    paths: &DataPaths,
) -> AppResult<PreparedBackup> {
    let snapshot_path = paths
        .temp
        .join(format!("snapshot-{}.sqlite3", Uuid::new_v4()));
    let snapshot_guard = TempFile(snapshot_path.clone());
    snapshot_database(connection, &snapshot_path)
        .map_err(|error| AppError::Validation(format!("创建 SQLite 在线快照失败：{error}")))?;
    let snapshot_size = fs::metadata(&snapshot_path)?.len();
    if snapshot_size > DATABASE_LIMIT {
        return Err(AppError::Validation("数据库快照超过 8 GiB".into()));
    }
    Ok(PreparedBackup {
        snapshot_guard,
        snapshot_path,
        font_snapshot_guard: None,
        font_entries: Vec::new(),
    })
}

fn prepare_font_backup_source(
    records: Vec<ImportedFontRecord>,
    paths: &DataPaths,
) -> AppResult<(TempDirectory, Vec<ArchiveEntry>)> {
    let snapshot_root = paths.temp.join(format!("backup-fonts-{}", Uuid::new_v4()));
    fs::create_dir(&snapshot_root)?;
    let snapshot_guard = TempDirectory::new(snapshot_root.clone());
    for (_, file_name, _) in &records {
        if Path::new(file_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(file_name)
        {
            return Err(AppError::Validation("字体登记包含不安全文件名".into()));
        }
        let source = paths.imported_fonts.join(file_name);
        let target = snapshot_root.join(file_name);
        fs::copy(&source, &target)?;
        File::open(&target)?.sync_all()?;
    }
    let entries = imported_font_entries(records, &snapshot_root)?;
    Ok((snapshot_guard, entries))
}

#[cfg(test)]
fn prepare_backup_source(
    connection: &Connection,
    paths: &DataPaths,
    includes_fonts: bool,
) -> AppResult<PreparedBackup> {
    let mut prepared = prepare_database_backup_source(connection, paths)?;
    if includes_fonts {
        let records = imported_font_records(connection)?;
        let (font_snapshot_guard, font_entries) = prepare_font_backup_source(records, paths)?;
        prepared.font_snapshot_guard = Some(font_snapshot_guard);
        prepared.font_entries = font_entries;
    }
    Ok(prepared)
}

fn finish_backup(
    prepared: PreparedBackup,
    _paths: &DataPaths,
    target: &Path,
    includes_fonts: bool,
) -> AppResult<BackupInfo> {
    let mut entries = vec![ArchiveEntry {
        path: "database/app.sqlite3".into(),
        source: EntrySource::File(prepared.snapshot_path.clone()),
    }];
    entries.extend(prepared.font_entries);
    let exported = write_archive(target, "vcpbackup", includes_fonts, entries, true, None)
        .map_err(|error| AppError::Validation(format!("写入完整备份归档失败：{error}")))?;
    drop(prepared.snapshot_guard);
    drop(prepared.font_snapshot_guard);
    Ok(BackupInfo {
        path: exported.path,
        created_at: now_ms(),
        byte_count: exported.byte_count,
        sha256: exported.sha256,
        includes_fonts,
    })
}

#[cfg(test)]
pub fn create_backup(
    connection: &Connection,
    paths: &DataPaths,
    target: &Path,
    includes_fonts: bool,
) -> AppResult<BackupInfo> {
    safe_target(target, "vcpbackup")?;
    let prepared = prepare_backup_source(connection, paths, includes_fonts)?;
    finish_backup(prepared, paths, target, includes_fonts)
}

pub fn create_backup_managed(
    database: &Mutex<Connection>,
    paths: &DataPaths,
    target: &Path,
    includes_fonts: bool,
) -> AppResult<BackupInfo> {
    safe_target(target, "vcpbackup")?;
    if includes_fonts {
        let reconciliation = Connection::open(paths.database.join("app.sqlite3"))?;
        reconciliation.execute_batch(
            "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;",
        )?;
        fonts::reconcile_imported_fonts(&reconciliation, &paths.imported_fonts, true)?;
        drop(reconciliation);
    }
    // 字体登记只在全局连接上短读；SQLite Online Backup 使用独立连接，快照和
    // integrity_check 不再占住自动保存共用的 Mutex。
    let font_records = if includes_fonts {
        Some(imported_font_records(&database.lock())?)
    } else {
        None
    };
    let source = Connection::open(paths.database.join("app.sqlite3"))?;
    source.execute_batch("PRAGMA busy_timeout=5000; PRAGMA query_only=ON;")?;
    let mut prepared = prepare_database_backup_source(&source, paths)?;
    drop(source);
    if let Some(records) = font_records {
        let (font_snapshot_guard, font_entries) = prepare_font_backup_source(records, paths)?;
        prepared.font_snapshot_guard = Some(font_snapshot_guard);
        prepared.font_entries = font_entries;
    }
    finish_backup(prepared, paths, target, includes_fonts)
}

fn copy_zip_entry_checked(
    archive: &mut ZipArchive<File>,
    metadata: &ManifestFile,
    target: &Path,
    limit: u64,
) -> AppResult<()> {
    if metadata.byte_count > limit {
        return Err(AppError::Validation(format!(
            "归档条目超过安全上限：{}",
            metadata.path
        )));
    }
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Validation("恢复目标没有父目录".into()))?;
    fs::create_dir_all(parent)?;
    let mut source = archive.by_name(&metadata.path)?;
    let mut output = File::create(target)?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total.saturating_add(count as u64);
        if total > limit {
            return Err(AppError::Validation("恢复条目解压后超过安全上限".into()));
        }
        hasher.update(&buffer[..count]);
        output.write_all(&buffer[..count])?;
    }
    output.sync_all()?;
    let actual_sha: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if total != metadata.byte_count || actual_sha != metadata.sha256 {
        return Err(AppError::Validation(format!(
            "恢复文件哈希校验失败：{}",
            metadata.path
        )));
    }
    Ok(())
}

fn table_columns(connection: &Connection, table: &str) -> AppResult<HashSet<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(columns)
}

fn require_columns(connection: &Connection, table: &str, required: &[&str]) -> AppResult<()> {
    let columns = table_columns(connection, table)?;
    if columns.is_empty() {
        return Err(AppError::Validation(format!(
            "备份数据库缺少必需表：{table}"
        )));
    }
    let missing = required
        .iter()
        .filter(|column| !columns.contains(**column))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(AppError::Validation(format!(
            "备份数据库表 {table} 缺少必需列：{}",
            missing.join(", ")
        )));
    }
    Ok(())
}

fn validate_database_semantics(connection: &Connection) -> AppResult<()> {
    let projects = {
        let mut statement = connection.prepare(
            "SELECT id,name,is_pinned,created_at,updated_at,last_opened_at,deleted_at,revision
             FROM projects",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    if projects.is_empty() {
        return Err(AppError::Validation(
            "备份数据库没有任何项目，业务状态无效".into(),
        ));
    }
    for (id, name, pinned, created, updated, opened, deleted, revision) in &projects {
        if Uuid::parse_str(id).is_err()
            || name.trim().is_empty()
            || name.chars().count() > MAX_PROJECT_NAME_CHARS
            || name.chars().any(char::is_control)
            || !matches!(pinned, 0 | 1)
            || !valid_timestamp(*created)
            || !valid_timestamp(*updated)
            || !valid_timestamp(*opened)
            || *updated < *created
            || *opened < *created
            || deleted.is_some_and(|value| !valid_timestamp(value) || value < *created)
            || !(0..=MAX_SAFE_REVISION).contains(revision)
        {
            return Err(AppError::Validation(
                "备份数据库包含无效的项目 ID、名称、时间或 revision".into(),
            ));
        }
    }

    let rounds = {
        let mut statement = connection.prepare(
            "SELECT id,project_id,position,status,created_at,finalized_at,updated_at,deleted_at,
                    revision,note,recovered_from_round_id,length(CAST(content_md AS BLOB))
             FROM rounds",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, i64>(11)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (
        id,
        project_id,
        position,
        status,
        created,
        finalized,
        updated,
        deleted,
        revision,
        note,
        recovered_from,
        content_bytes,
    ) in &rounds
    {
        let common_invalid = Uuid::parse_str(id).is_err()
            || Uuid::parse_str(project_id).is_err()
            || recovered_from
                .as_ref()
                .is_some_and(|value| Uuid::parse_str(value).is_err())
            || !valid_timestamp(*created)
            || !valid_timestamp(*updated)
            || *updated < *created
            || deleted.is_some_and(|value| !valid_timestamp(value) || value < *created)
            || !(0..=MAX_SAFE_REVISION).contains(revision)
            || note.chars().count() > 120
            || note.contains(['\r', '\n'])
            || !(0..=10 * 1024 * 1024).contains(content_bytes);
        if common_invalid {
            return Err(AppError::Validation(
                "备份数据库包含无效的轮次 ID、正文大小、备注、时间或 revision".into(),
            ));
        }
        match status.as_str() {
            "draft" if *position == DRAFT_POSITION && finalized.is_none() && deleted.is_none() => {}
            "final" => {
                let Some(finalized) = finalized else {
                    return Err(AppError::Validation(
                        "备份数据库正式轮次缺少完成时间".into(),
                    ));
                };
                if !(0..DRAFT_POSITION).contains(position)
                    || !valid_timestamp(*finalized)
                    || *finalized < *created
                    || *finalized > *updated
                {
                    return Err(AppError::Validation(
                        "备份数据库正式轮次排序或时间无效".into(),
                    ));
                }
            }
            _ => {
                return Err(AppError::Validation(
                    "备份数据库草稿状态、完成时间或排序位置无效".into(),
                ));
            }
        }
    }

    let invalid_draft_projects: i64 = connection.query_row(
        "SELECT COUNT(*) FROM (
           SELECT p.id
           FROM projects p
           LEFT JOIN rounds r
             ON r.project_id=p.id AND r.status='draft' AND r.deleted_at IS NULL
           GROUP BY p.id
           HAVING COUNT(r.id) <> 1
         )",
        [],
        |row| row.get(0),
    )?;
    if invalid_draft_projects != 0 {
        return Err(AppError::Validation(
            "备份数据库必须为每个项目保留且只保留一个当前草稿".into(),
        ));
    }
    let invalid_positions: i64 = connection.query_row(
        "SELECT COUNT(*) FROM (
           SELECT project_id
           FROM rounds
           WHERE status='final' AND deleted_at IS NULL
           GROUP BY project_id
           HAVING MIN(position) <> 0
              OR MAX(position) <> COUNT(*) - 1
              OR COUNT(DISTINCT position) <> COUNT(*)
         )",
        [],
        |row| row.get(0),
    )?;
    if invalid_positions != 0 {
        return Err(AppError::Validation(
            "备份数据库有效正式轮次的排序位置不连续或重复".into(),
        ));
    }

    let invalid_view_references: i64 = connection.query_row(
        "SELECT COUNT(*)
         FROM project_view_state v
         WHERE (v.selected_round_id IS NOT NULL AND NOT EXISTS(
                  SELECT 1 FROM rounds r
                  WHERE r.id=v.selected_round_id AND r.project_id=v.project_id
                    AND r.deleted_at IS NULL
                ))
            OR (v.timeline_anchor_round_id IS NOT NULL AND NOT EXISTS(
                  SELECT 1 FROM rounds r
                  WHERE r.id=v.timeline_anchor_round_id AND r.project_id=v.project_id
                    AND r.deleted_at IS NULL
                ))",
        [],
        |row| row.get(0),
    )?;
    if invalid_view_references != 0 {
        return Err(AppError::Validation(
            "备份数据库视图状态引用了已删除或其他项目的轮次".into(),
        ));
    }
    let view_states = {
        let mut statement = connection.prepare(
            "SELECT editor_mode,anchor_offset_px,cursor_anchor,cursor_head,detail_open,updated_at
             FROM project_view_state",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (mode, offset, anchor, head, detail_open, updated_at) in view_states {
        if !matches!(mode.as_str(), "wysiwyg" | "source")
            || !offset.is_finite()
            || offset.abs() > 1_000_000.0
            || !(0..=10 * 1024 * 1024).contains(&anchor)
            || !(0..=10 * 1024 * 1024).contains(&head)
            || !matches!(detail_open, 0 | 1)
            || !valid_timestamp(updated_at)
        {
            return Err(AppError::Validation(
                "备份数据库包含无效的项目视图状态".into(),
            ));
        }
    }

    db::load_settings(connection)
        .map_err(|error| AppError::Validation(format!("备份数据库应用设置无效：{error}")))?;
    db::load_window_state(connection)
        .map_err(|error| AppError::Validation(format!("备份数据库窗口状态无效：{error}")))?;
    Ok(())
}

fn validate_database_file(path: &Path, expected_schema: Option<i64>) -> AppResult<()> {
    let connection = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Validation(format!(
            "备份数据库完整性检查失败：{integrity}"
        )));
    }
    let foreign_key_errors: i64 =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    if foreign_key_errors != 0 {
        return Err(AppError::Validation("备份数据库存在外键错误".into()));
    }
    require_columns(
        &connection,
        "schema_migrations",
        &["version", "app_version", "applied_at", "checksum"],
    )?;
    let schema: i64 = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get::<_, Option<i64>>(0)
        })?
        .ok_or_else(|| AppError::Validation("备份数据库没有有效 schema 版本".into()))?;
    if !(1..=db::SCHEMA_VERSION).contains(&schema) {
        return Err(AppError::Validation(
            "备份数据库 schema 不受当前版本支持".into(),
        ));
    }
    if expected_schema.is_some_and(|expected| expected != schema) {
        return Err(AppError::Validation(
            "备份 manifest 与数据库实际 schema 不一致".into(),
        ));
    }
    require_columns(
        &connection,
        "projects",
        &[
            "id",
            "name",
            "is_pinned",
            "created_at",
            "updated_at",
            "last_opened_at",
            "deleted_at",
            "revision",
        ],
    )?;
    require_columns(
        &connection,
        "rounds",
        &[
            "id",
            "project_id",
            "position",
            "status",
            "content_md",
            "created_at",
            "finalized_at",
            "updated_at",
            "deleted_at",
            "revision",
            "recovered_from_round_id",
            "note",
        ],
    )?;
    require_columns(
        &connection,
        "project_view_state",
        &[
            "project_id",
            "selected_round_id",
            "timeline_anchor_round_id",
            "anchor_offset_px",
            "editor_mode",
            "cursor_anchor",
            "cursor_head",
            "detail_open",
            "updated_at",
        ],
    )?;
    require_columns(
        &connection,
        "app_settings",
        &["key", "versioned_json_value", "updated_at"],
    )?;
    require_columns(
        &connection,
        "font_registry",
        &[
            "id",
            "sha256",
            "source",
            "display_name",
            "internal_family",
            "file_name",
            "format",
            "file_size",
            "weights_json",
            "is_available",
        ],
    )?;
    if schema >= 2 {
        require_columns(
            &connection,
            "font_registry",
            &["face_count", "is_variable", "axes_json"],
        )?;
    }
    validate_database_semantics(&connection)?;
    let fts_sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='search_index'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| AppError::Validation("备份数据库缺少 FTS5 搜索表".into()))?;
    if !fts_sql.to_ascii_lowercase().contains("using fts5") {
        return Err(AppError::Validation(
            "备份数据库 search_index 不是 FTS5 表".into(),
        ));
    }
    let indexed_rows: i64 =
        connection.query_row("SELECT COUNT(*) FROM search_index", [], |row| row.get(0))?;
    let expected_rows: i64 = connection.query_row(
        "SELECT COUNT(*) FROM rounds r JOIN projects p ON p.id=r.project_id
         WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    if indexed_rows != expected_rows {
        return Err(AppError::Validation(
            "备份数据库全文索引与有效轮次数量不一致".into(),
        ));
    }
    let mismatched_index_rows: i64 = connection.query_row(
        "SELECT COUNT(*)
         FROM search_index s
         LEFT JOIN rounds r ON r.id=s.round_id
         LEFT JOIN projects p ON p.id=s.project_id
         WHERE r.id IS NULL OR p.id IS NULL
            OR r.project_id <> p.id
            OR r.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL
            OR s.project_name <> p.name OR s.note <> r.note
            OR s.content_md <> r.content_md OR s.status <> r.status",
        [],
        |row| row.get(0),
    )?;
    let missing_index_rows: i64 = connection.query_row(
        "SELECT COUNT(*)
         FROM rounds r
         JOIN projects p ON p.id=r.project_id
         WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL
           AND NOT EXISTS(
             SELECT 1 FROM search_index s
             WHERE s.round_id=r.id AND s.project_id=p.id
               AND s.project_name=p.name AND s.note=r.note
               AND s.content_md=r.content_md AND s.status=r.status
           )",
        [],
        |row| row.get(0),
    )?;
    if mismatched_index_rows != 0 || missing_index_rows != 0 {
        return Err(AppError::Validation(
            "备份数据库全文索引内容与项目、轮次原文不一致".into(),
        ));
    }
    Ok(())
}

fn existing_file_size(path: &Path) -> AppResult<u64> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(metadata.len()),
        Ok(_) => Ok(0),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}

fn current_backup_space_upper_bound(paths: &DataPaths) -> AppResult<u64> {
    let mut total = existing_file_size(&paths.database.join("app.sqlite3"))?;
    total = total.saturating_add(existing_file_size(&paths.database.join("app.sqlite3-wal"))?);
    if paths.imported_fonts.exists() {
        for entry in fs::read_dir(&paths.imported_fonts)? {
            let metadata = entry?.metadata()?;
            if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let _temporary_guard = TempFile(temporary.clone());
    {
        let mut file = File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    file_atomic::replace_file(&temporary, path)?;
    Ok(())
}

fn prepare_restore_with<F>(
    paths: &DataPaths,
    backup_path: &Path,
    create_recovery: F,
) -> AppResult<RestorePreparation>
where
    F: FnOnce(&Path) -> AppResult<BackupInfo>,
{
    let state_path = paths.recovery.join("restore-state.json");
    if state_path.exists() {
        return Err(AppError::Validation(
            "已有待完成的恢复任务；请先重启应用完成或回滚".into(),
        ));
    }
    let (mut archive, manifest, _) =
        open_validated_archive(backup_path, "vcpbackup", BACKUP_UNPACKED_LIMIT)?;
    let checksums_bytes = read_entry_bytes(&mut archive, "checksums.sha256", MANIFEST_LIMIT)?;
    let expected_checksums = manifest
        .files
        .iter()
        .map(|file| format!("{}  {}\n", file.sha256, file.path))
        .collect::<String>();
    if checksums_bytes != expected_checksums.as_bytes() {
        return Err(AppError::Validation(
            "checksums.sha256 与 manifest 不一致".into(),
        ));
    }
    let database = manifest
        .files
        .iter()
        .find(|file| file.path == "database/app.sqlite3")
        .ok_or_else(|| AppError::Validation("完整备份缺少数据库快照".into()))?;
    let staged_bytes = manifest
        .files
        .iter()
        .fold(0_u64, |total, file| total.saturating_add(file.byte_count));
    let current_backup_bytes = current_backup_space_upper_bound(paths)?;
    // 峰值同时存在 staged 内容、恢复前 SQLite 快照及其归档；再留 64 MiB 给 ZIP
    // 元数据、状态文件和文件系统簿记，空间不足时在创建任何恢复目录前失败。
    let required_bytes = staged_bytes
        .saturating_add(current_backup_bytes.saturating_mul(2))
        .saturating_add(RESTORE_SPACE_MARGIN);
    let available_bytes = fs2::available_space(&paths.recovery)?;
    if available_bytes < required_bytes {
        return Err(AppError::Validation(format!(
            "可用空间不足，恢复至少还需约 {} MiB，当前仅有 {} MiB",
            required_bytes.div_ceil(1024 * 1024),
            available_bytes / (1024 * 1024)
        )));
    }
    let restore_id = Uuid::new_v4().to_string();
    let restore_root = paths.recovery.join(format!("restore-{restore_id}"));
    let mut restore_guard = TempDirectory::new(restore_root.clone());
    let staged = restore_root.join("staged");
    fs::create_dir_all(staged.join("database"))?;
    let stage_result = (|| -> AppResult<()> {
        copy_zip_entry_checked(
            &mut archive,
            database,
            &staged.join("database").join("app.sqlite3"),
            DATABASE_LIMIT,
        )?;
        let mut font_total = 0_u64;
        for file in &manifest.files {
            if file.path == "database/app.sqlite3" {
                continue;
            }
            let file_name = file
                .path
                .strip_prefix("fonts/imported/")
                .filter(|name| {
                    Path::new(name).file_name().and_then(|part| part.to_str()) == Some(*name)
                })
                .ok_or_else(|| AppError::Validation("备份包含不允许恢复的文件类型".into()))?;
            if !manifest.includes_fonts {
                return Err(AppError::Validation("仅数据库快照却声明了字体文件".into()));
            }
            font_total = font_total.saturating_add(file.byte_count);
            if file.byte_count > FONT_LIMIT || font_total > FONT_TOTAL_LIMIT {
                return Err(AppError::Validation("备份字体超过安全大小限制".into()));
            }
            copy_zip_entry_checked(
                &mut archive,
                file,
                &staged.join("fonts").join("imported").join(file_name),
                FONT_LIMIT,
            )?;
        }
        if manifest.includes_fonts {
            fs::create_dir_all(staged.join("fonts").join("imported"))?;
        }
        validate_database_file(
            &staged.join("database").join("app.sqlite3"),
            Some(manifest.database_schema_version),
        )?;
        Ok(())
    })();
    if let Err(error) = stage_result {
        let _ = fs::remove_dir_all(&restore_root);
        return Err(error);
    }

    let recovery_target = paths.backups_manual.join(format!(
        "recovery-before-{}-{}.vcpbackup",
        Local::now().format("%Y%m%d-%H%M%S"),
        Uuid::new_v4()
    ));
    let recovery = create_recovery(&recovery_target)?;
    let state = RestoreState {
        format_version: ARCHIVE_FORMAT_VERSION,
        restore_id: restore_id.clone(),
        includes_fonts: manifest.includes_fonts,
        database_schema_version: manifest.database_schema_version,
        phase: "prepared".into(),
        prepared_at: now_ms(),
    };
    write_json_atomically(&state_path, &state)?;
    restore_guard.keep();
    Ok(RestorePreparation {
        restore_id,
        backup_path: backup_path.to_string_lossy().into_owned(),
        recovery_point_path: recovery.path,
        requires_restart: true,
    })
}

#[cfg(test)]
pub fn prepare_restore(
    connection: &Connection,
    paths: &DataPaths,
    backup_path: &Path,
) -> AppResult<RestorePreparation> {
    prepare_restore_with(paths, backup_path, |target| {
        create_backup(connection, paths, target, true)
    })
}

pub fn prepare_restore_managed(
    database: &Mutex<Connection>,
    paths: &DataPaths,
    backup_path: &Path,
) -> AppResult<RestorePreparation> {
    prepare_restore_with(paths, backup_path, |target| {
        create_backup_managed(database, paths, target, true)
    })
}

pub fn cancel_prepared_restore(paths: &DataPaths) -> AppResult<()> {
    let state_path = paths.recovery.join("restore-state.json");
    if !state_path.is_file() {
        return Err(AppError::Validation("没有可取消的待恢复任务".into()));
    }
    let state: RestoreState = serde_json::from_slice(&fs::read(&state_path)?)?;
    if state.format_version != ARCHIVE_FORMAT_VERSION
        || Uuid::parse_str(&state.restore_id).is_err()
        || state.phase != "prepared"
    {
        return Err(AppError::Validation(
            "待恢复任务已进入切换阶段或状态无效，不能在运行中取消".into(),
        ));
    }
    let restore_root = paths.recovery.join(format!("restore-{}", state.restore_id));
    // 先移除启动期识别的状态文件。即使进程随后被强杀，下次启动也只会把严格
    // 匹配的 restore-{uuid} 当作陈旧工作目录清理，绝不会应用半取消的恢复。
    fs::remove_file(&state_path)?;
    if restore_root.exists() {
        // 状态文件已删除即代表取消完成。Windows 上若杀毒软件或索引器短暂占用
        // 工作目录，不能把已经安全取消的任务重新报告成“仍待恢复”；初始化流程会
        // 按严格的 restore-{uuid} 规则再次清理这个无效目录。
        let _ = fs::remove_dir_all(restore_root);
    }
    Ok(())
}

fn remove_empty_or_quarantine(path: &Path, quarantine: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() && fs::read_dir(path)?.next().is_none() {
        fs::remove_dir(path)?;
    } else {
        fs::rename(path, quarantine)?;
    }
    Ok(())
}

fn rollback_interrupted_restore(
    paths: &DataPaths,
    state: &RestoreState,
    old_root: &Path,
    restore_root: &Path,
) -> AppResult<()> {
    let old_database = old_root.join("database");
    if old_database.exists() {
        remove_empty_or_quarantine(
            &paths.database,
            &restore_root.join(format!("failed-database-{}", now_ms())),
        )?;
        fs::rename(old_database, &paths.database)?;
    }
    if state.includes_fonts {
        let old_fonts = old_root.join("imported-fonts");
        if old_fonts.exists() {
            remove_empty_or_quarantine(
                &paths.imported_fonts,
                &restore_root.join(format!("failed-fonts-{}", now_ms())),
            )?;
            fs::create_dir_all(
                paths
                    .imported_fonts
                    .parent()
                    .ok_or_else(|| AppError::Validation("字体目录无父目录".into()))?,
            )?;
            fs::rename(old_fonts, &paths.imported_fonts)?;
        }
    }
    let state_path = paths.recovery.join("restore-state.json");
    fs::remove_file(state_path)?;
    validate_database_file(&paths.database.join("app.sqlite3"), None)?;
    Ok(())
}

pub fn apply_pending_restore(paths: &DataPaths) -> AppResult<Option<String>> {
    let state_path = paths.recovery.join("restore-state.json");
    if !state_path.exists() {
        return Ok(None);
    }
    let state: RestoreState = serde_json::from_slice(&fs::read(&state_path)?)?;
    if state.format_version != ARCHIVE_FORMAT_VERSION || Uuid::parse_str(&state.restore_id).is_err()
    {
        return Err(AppError::Validation(
            "待恢复状态文件无效；未触碰现有数据".into(),
        ));
    }
    let restore_root = paths.recovery.join(format!("restore-{}", state.restore_id));
    let staged = restore_root.join("staged");
    let old_root = paths.recovery.join(format!("old-{}", state.restore_id));

    if old_root.join("database").exists() {
        rollback_interrupted_restore(paths, &state, &old_root, &restore_root)?;
        return Ok(Some("检测到中断的恢复切换，已回滚到恢复前数据".into()));
    }
    // 回滚可能已经把 database 移回，但在恢复字体或删除 state 前被强杀。
    // old-moved 阶段始终继续幂等回滚；即使 old/database 已不存在，也会校验当前库并收尾。
    if state.phase == "old-moved" {
        rollback_interrupted_restore(paths, &state, &old_root, &restore_root)?;
        return Ok(Some("检测到未完成的恢复回滚，已继续恢复到原始数据".into()));
    }
    if state.phase != "prepared" {
        return Err(AppError::Validation(
            "待恢复状态阶段无效；现有数据未被修改".into(),
        ));
    }
    let expected_schema =
        (state.database_schema_version > 0).then_some(state.database_schema_version);
    validate_database_file(
        &staged.join("database").join("app.sqlite3"),
        expected_schema,
    )?;
    // 若上次恰在创建 old_root 后、移动数据库前被强杀，允许复用这个空目录。
    if old_root.exists() {
        if !old_root.is_dir() || fs::read_dir(&old_root)?.next().is_some() {
            return Err(AppError::Validation(
                "恢复旧数据目录已存在且非空；为避免覆盖，未开始切换".into(),
            ));
        }
    } else {
        fs::create_dir(&old_root)?;
    }
    fs::rename(&paths.database, old_root.join("database"))?;
    let mut next_state = state.clone();
    next_state.phase = "old-moved".into();
    write_json_atomically(&state_path, &next_state)?;

    let switch_result = (|| -> AppResult<()> {
        fs::rename(staged.join("database"), &paths.database)?;
        if state.includes_fonts {
            fs::rename(&paths.imported_fonts, old_root.join("imported-fonts"))?;
            fs::create_dir_all(
                paths
                    .imported_fonts
                    .parent()
                    .ok_or_else(|| AppError::Validation("字体目录无父目录".into()))?,
            )?;
            fs::rename(staged.join("fonts").join("imported"), &paths.imported_fonts)?;
        }
        validate_database_file(&paths.database.join("app.sqlite3"), expected_schema)?;
        Ok(())
    })();
    if let Err(error) = switch_result {
        rollback_interrupted_restore(paths, &next_state, &old_root, &restore_root)?;
        return Err(AppError::Validation(format!(
            "恢复切换失败，已自动回滚：{error}"
        )));
    }
    fs::remove_file(state_path)?;
    Ok(Some(
        "已完成备份恢复；恢复前数据已保存在 backups/manual 的校验恢复点中".into(),
    ))
}

pub fn cleanup_stale_recovery_artifacts(paths: &DataPaths) -> AppResult<usize> {
    if paths.recovery.join("restore-state.json").exists() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in fs::read_dir(&paths.recovery)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let recognized = ["old-", "restore-"].iter().any(|prefix| {
            name.strip_prefix(prefix)
                .is_some_and(|value| Uuid::parse_str(value).is_ok())
        });
        if recognized {
            fs::remove_dir_all(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn backup_manifest_created_at(path: &Path) -> Option<i64> {
    let (_, manifest, _) = open_validated_archive(path, "vcpbackup", BACKUP_UNPACKED_LIMIT).ok()?;
    valid_timestamp(manifest.created_at).then_some(manifest.created_at)
}

fn prune_auto_backups(directory: &Path) -> AppResult<()> {
    let mut daily = Vec::new();
    let mut weekly = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("vcpbackup")
        {
            continue;
        }
        // 损坏或未知格式的文件不自动删除；有效归档只以内部 createdAt 排序。
        let Some(created_at) = backup_manifest_created_at(&path) else {
            continue;
        };
        let item = (created_at, path);
        if name.starts_with("daily-") {
            daily.push(item);
        } else if name.starts_with("weekly-") {
            weekly.push(item);
        }
    }
    daily.sort_by_key(|item| std::cmp::Reverse(item.0));
    weekly.sort_by_key(|item| std::cmp::Reverse(item.0));
    for (_, path) in daily.iter().skip(7).chain(weekly.iter().skip(4)) {
        fs::remove_file(path)?;
    }
    let mut remaining = daily
        .into_iter()
        .take(7)
        .chain(weekly.into_iter().take(4))
        .collect::<Vec<_>>();
    remaining.sort_by_key(|item| std::cmp::Reverse(item.0));
    let mut total = remaining.iter().try_fold(0_u64, |sum, (_, path)| {
        fs::metadata(path)
            .map(|metadata| sum.saturating_add(metadata.len()))
            .map_err(AppError::from)
    })?;
    for (_, path) in remaining.iter().skip(1).rev() {
        if total <= AUTO_BACKUP_LIMIT {
            break;
        }
        let size = fs::metadata(path)?.len();
        fs::remove_file(path)?;
        total = total.saturating_sub(size);
    }
    Ok(())
}

pub fn prune_conflict_backups(directory: &Path) -> AppResult<()> {
    let mut backups = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type()?.is_file()
            || !name.starts_with("conflict-before-")
            || path.extension().and_then(|value| value.to_str()) != Some("vcpbackup")
        {
            continue;
        }
        let Some(created_at) = backup_manifest_created_at(&path) else {
            continue;
        };
        backups.push((created_at, path, entry.metadata()?.len()));
    }
    backups.sort_by_key(|item| std::cmp::Reverse(item.0));
    let mut total = backups.iter().map(|item| item.2).sum::<u64>();
    for (index, (_, path, size)) in backups.iter().enumerate().rev() {
        if index < 3 && total <= CONFLICT_BACKUP_LIMIT {
            continue;
        }
        if index == 0 {
            break;
        }
        fs::remove_file(path)?;
        total = total.saturating_sub(*size);
    }
    Ok(())
}

fn auto_backup_plan(paths: &DataPaths) -> AppResult<Option<(PathBuf, bool)>> {
    let local = Local::now();
    let date = local.format("%Y-%m-%d").to_string();
    let iso = local.iso_week();
    let week = format!("{}-W{:02}", iso.year(), iso.week());
    let (has_today, has_week) = valid_auto_backup_periods(&paths.backups_auto, &date, &week)?;
    if has_today {
        return Ok(None);
    }
    let (prefix, includes_fonts) = if has_week {
        (format!("daily-{date}"), false)
    } else {
        (format!("weekly-{week}-{date}"), true)
    };
    let target = paths
        .backups_auto
        .join(format!("{prefix}-{}.vcpbackup", Uuid::new_v4()));
    Ok(Some((target, includes_fonts)))
}

fn valid_auto_backup_periods(
    directory: &Path,
    current_date: &str,
    current_week: &str,
) -> AppResult<(bool, bool)> {
    let mut has_today = false;
    let mut has_week = false;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type()?.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("vcpbackup")
            || (!name.starts_with("daily-") && !name.starts_with("weekly-"))
        {
            continue;
        }
        let Some(created_at) = backup_manifest_created_at(&path) else {
            // 损坏、截断或伪造文件名的条目不阻止创建新的安全备份。
            continue;
        };
        let Some(created) = Local.timestamp_millis_opt(created_at).single() else {
            continue;
        };
        let created_date = created.format("%Y-%m-%d").to_string();
        let iso = created.iso_week();
        let created_week = format!("{}-W{:02}", iso.year(), iso.week());
        if created_date == current_date {
            has_today = true;
        }
        if name.starts_with("weekly-") && created_week == current_week {
            has_week = true;
        }
    }
    Ok((has_today, has_week))
}

pub fn maybe_create_auto_backup_managed(
    database: &Mutex<Connection>,
    paths: &DataPaths,
) -> AppResult<Option<BackupInfo>> {
    let auto_backup = {
        let connection = database.lock();
        db::load_settings(&connection)?.auto_backup
    };
    if !auto_backup {
        return Ok(None);
    }
    let Some((target, includes_fonts)) = auto_backup_plan(paths)? else {
        return Ok(None);
    };
    let result = create_backup_managed(database, paths, &target, includes_fonts)?;
    prune_auto_backups(&paths.backups_auto)?;
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::Instant;

    fn test_db(path: &Path) -> Connection {
        db::open(path).expect("open database")
    }

    fn test_paths(root: &Path) -> DataPaths {
        fs::create_dir_all(root.join("database")).expect("database");
        fs::create_dir_all(root.join("backups/auto")).expect("auto");
        fs::create_dir_all(root.join("backups/manual")).expect("manual");
        fs::create_dir_all(root.join("recovery")).expect("recovery");
        fs::create_dir_all(root.join("fonts/imported")).expect("fonts");
        fs::create_dir_all(root.join("logs")).expect("logs");
        fs::create_dir_all(root.join("temp")).expect("temp");
        fs::create_dir_all(root.join("webview2")).expect("webview2");
        let lock_file = File::create(root.join("instance.lock")).expect("lock");
        DataPaths {
            root: root.to_path_buf(),
            database: root.join("database"),
            backups_auto: root.join("backups/auto"),
            backups_manual: root.join("backups/manual"),
            recovery: root.join("recovery"),
            imported_fonts: root.join("fonts/imported"),
            logs: root.join("logs"),
            temp: root.join("temp"),
            webview2: root.join("webview2"),
            unclean_start: false,
            clean_shutdown_marker: root.join(".vpr-clean-shutdown"),
            in_sync_directory: false,
            _lock_file: lock_file,
        }
    }

    #[test]
    fn project_package_round_trip_preserves_markdown_and_metadata() {
        let temp = tempfile::tempdir().expect("temp");
        let source_path = temp.path().join("source.sqlite3");
        let source = test_db(&source_path);
        let project = db::list_projects(&source).expect("projects").remove(0);
        let draft = db::list_rounds(&source, &project.id)
            .expect("rounds")
            .remove(0);
        db::save_round(
            &source,
            &draft.id,
            "# 中文\n\n```rust\nfn main() {}\n```",
            "备注",
            0,
        )
        .expect("save");
        db::finalize_draft(&source, &project.id).expect("finalize");
        let package = temp.path().join("roundtrip.vcpproject");
        export_project(&source, &project.id, &package).expect("export");

        let target_path = temp.path().join("target.sqlite3");
        let target = test_db(&target_path);
        let imported = import_project(&target, &package).expect("import");
        let rounds = db::list_rounds(&target, &imported.id).expect("list rounds");
        let final_round = rounds
            .iter()
            .find(|round| round.status == "final")
            .expect("final");
        let detail = db::get_round(&target, &final_round.id).expect("detail");
        assert_eq!(detail.note, "备注");
        assert!(detail.content_md.contains("fn main()"));
        assert!(rounds.iter().any(|round| round.status == "draft"));
    }

    #[test]
    fn project_package_metadata_rejects_unrenderable_time_and_revision() {
        let package = ProjectPackage {
            format_version: ARCHIVE_FORMAT_VERSION,
            project: ProjectRecord {
                id: Uuid::new_v4().to_string(),
                name: "安全项目".into(),
                is_pinned: false,
                created_at: 1,
                updated_at: 1,
                last_opened_at: 1,
            },
            rounds: vec![RoundRecord {
                id: Uuid::new_v4().to_string(),
                position: DRAFT_POSITION,
                status: "draft".into(),
                created_at: 1,
                finalized_at: None,
                updated_at: i64::MAX,
                revision: i64::MAX,
                note: String::new(),
                content_path: "content/test.md".into(),
            }],
        };
        let error = validate_project_package_metadata(&package).expect_err("reject metadata");
        assert!(error.to_string().contains("时间或 revision"));
    }

    #[test]
    fn backup_database_validation_rejects_missing_fts_schema() {
        let temp = tempfile::tempdir().expect("temp");
        let database_path = temp.path().join("invalid.sqlite3");
        let connection = test_db(&database_path);
        connection
            .execute("DROP TABLE search_index", [])
            .expect("drop fts");
        drop(connection);
        let error =
            validate_database_file(&database_path, Some(db::SCHEMA_VERSION)).expect_err("reject");
        assert!(error.to_string().contains("FTS5"));
    }

    #[test]
    fn backup_database_validation_rejects_project_without_a_live_draft() {
        let temp = tempfile::tempdir().expect("temp");
        let database_path = temp.path().join("invalid-semantics.sqlite3");
        let connection = test_db(&database_path);
        connection
            .execute(
                "UPDATE rounds
                 SET status='final',position=0,finalized_at=updated_at
                 WHERE status='draft'",
                [],
            )
            .expect("damage draft invariant");
        db::checkpoint_wal(&connection).expect("checkpoint");
        drop(connection);

        let error =
            validate_database_file(&database_path, Some(db::SCHEMA_VERSION)).expect_err("reject");

        assert!(error.to_string().contains("当前草稿"));
    }

    #[test]
    fn backup_database_validation_compares_fts_content_not_only_row_count() {
        let temp = tempfile::tempdir().expect("temp");
        let database_path = temp.path().join("invalid-index.sqlite3");
        let connection = test_db(&database_path);
        connection
            .execute("UPDATE search_index SET content_md='被篡改的索引'", [])
            .expect("damage index content");
        db::checkpoint_wal(&connection).expect("checkpoint");
        drop(connection);

        let error =
            validate_database_file(&database_path, Some(db::SCHEMA_VERSION)).expect_err("reject");

        assert!(error.to_string().contains("索引内容"));
    }

    #[test]
    fn uncommitted_restore_directory_is_removed_by_guard() {
        let temp = tempfile::tempdir().expect("temp");
        let restore_root = temp.path().join("restore-test");
        fs::create_dir_all(restore_root.join("staged")).expect("create staged");
        {
            let _guard = TempDirectory::new(restore_root.clone());
        }
        assert!(!restore_root.exists());
    }

    #[test]
    fn restore_state_update_replaces_existing_file() {
        let temp = tempfile::tempdir().expect("temp");
        let state_path = temp.path().join("restore-state.json");
        let mut state = RestoreState {
            format_version: ARCHIVE_FORMAT_VERSION,
            restore_id: Uuid::new_v4().to_string(),
            includes_fonts: false,
            database_schema_version: db::SCHEMA_VERSION,
            phase: "prepared".into(),
            prepared_at: 1,
        };
        write_json_atomically(&state_path, &state).expect("initial state");
        state.phase = "old-moved".into();

        write_json_atomically(&state_path, &state).expect("replace state");

        let loaded: RestoreState =
            serde_json::from_slice(&fs::read(state_path).expect("read")).expect("json");
        assert_eq!(loaded.phase, "old-moved");
    }

    #[test]
    fn archive_layout_rejects_parent_traversal() {
        let temp = tempfile::tempdir().expect("temp");
        let archive_path = temp.path().join("bad.vcpproject");
        let output = File::create(&archive_path).expect("create");
        let mut writer = ZipWriter::new(output);
        writer
            .start_file("../escape.txt", SimpleFileOptions::default())
            .expect("start");
        writer.write_all(b"bad").expect("write");
        writer.finish().expect("finish");
        let mut archive = ZipArchive::new(File::open(archive_path).expect("open")).expect("zip");
        let error = validate_zip_layout(&mut archive, PROJECT_UNPACKED_LIMIT).expect_err("reject");
        assert!(error.to_string().contains("越界路径"));
    }

    #[test]
    fn backup_is_online_snapshot_with_verified_manifest() {
        let temp = tempfile::tempdir().expect("temp");
        let paths = test_paths(temp.path());
        let connection = test_db(&paths.database.join("app.sqlite3"));
        let target = temp.path().join("manual.vcpbackup");
        let result = create_backup(&connection, &paths, &target, true).expect("backup");
        assert!(result.byte_count > 0);
        let (_, manifest, _) =
            open_validated_archive(&target, "vcpbackup", BACKUP_UNPACKED_LIMIT).expect("validate");
        assert!(
            manifest
                .files
                .iter()
                .any(|file| file.path == "database/app.sqlite3")
        );
        assert!(manifest.includes_fonts);
    }

    #[test]
    #[ignore = "手动性能测量入口：cargo test backend_performance_measurement -- --ignored --nocapture"]
    fn backend_performance_measurement() {
        let temp = tempfile::tempdir().expect("temp");
        let paths = test_paths(temp.path());
        let connection = test_db(&paths.database.join("app.sqlite3"));
        let project = db::list_projects(&connection).expect("projects").remove(0);
        let content = "性能基准正文 ".repeat(128);
        let transaction = connection.unchecked_transaction().expect("transaction");
        for position in 0..2_000_i64 {
            let id = format!("performance-round-{position}");
            transaction
                .execute(
                    "INSERT INTO rounds(id,project_id,position,status,content_md,created_at,
                     finalized_at,updated_at,revision,note)
                     VALUES (?1,?2,?3,'final',?4,1,1,1,1,'性能')",
                    params![id, project.id, position, content],
                )
                .expect("round");
            transaction
                .execute(
                    "INSERT INTO search_index(project_name,note,content_md,project_id,round_id,status)
                     VALUES (?1,'性能',?2,?3,?4,'final')",
                    params![project.name, content, project.id, id],
                )
                .expect("search index");
        }
        transaction.commit().expect("commit");

        let search_started = Instant::now();
        let search_results = db::search(&connection, "性", 100, 0).expect("short search");
        let short_search_ms = search_started.elapsed().as_millis();
        assert_eq!(search_results.len(), 100);

        let package_started = Instant::now();
        export_project(
            &connection,
            &project.id,
            &temp.path().join("large.vcpproject"),
        )
        .expect("project package");
        let project_package_ms = package_started.elapsed().as_millis();

        let markdown_started = Instant::now();
        crate::markdown_io::export_project_markdown(
            &connection,
            &project.id,
            &temp.path().join("large.md"),
        )
        .expect("markdown");
        let markdown_export_ms = markdown_started.elapsed().as_millis();

        let managed = Mutex::new(connection);
        let snapshot_started = Instant::now();
        let prepared = {
            let locked = managed.lock();
            prepare_backup_source(&locked, &paths, false).expect("snapshot")
        };
        let snapshot_ms = snapshot_started.elapsed().as_millis();
        assert!(
            managed.try_lock().is_some(),
            "归档压缩阶段不应继续持有数据库锁"
        );
        let archive_started = Instant::now();
        finish_backup(
            prepared,
            &paths,
            &temp.path().join("large.vcpbackup"),
            false,
        )
        .expect("backup archive");
        let backup_archive_ms = archive_started.elapsed().as_millis();
        eprintln!(
            "[PERF] backend 2000x{}B short-search={}ms project-package={}ms markdown={}ms \
             backup-snapshot={}ms backup-archive={}ms",
            content.len(),
            short_search_ms,
            project_package_ms,
            markdown_export_ms,
            snapshot_ms,
            backup_archive_ms
        );
    }

    #[test]
    fn conflict_backups_are_bounded_and_latest_is_preserved() {
        let temp = tempfile::tempdir().expect("temp");
        let paths = test_paths(temp.path());
        let database = test_db(&paths.database.join("app.sqlite3"));
        for index in 0..5 {
            let target = paths
                .recovery
                .join(format!("conflict-before-{index}.vcpbackup"));
            create_backup(&database, &paths, &target, true).expect("backup");
            std::thread::sleep(Duration::from_millis(2));
        }

        prune_conflict_backups(&paths.recovery).expect("prune");
        let remaining = fs::read_dir(&paths.recovery)
            .expect("recovery")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("conflict-before-")
            })
            .count();
        assert_eq!(remaining, 3);
    }

    #[test]
    fn prepared_restore_switches_on_next_start_and_preserves_recovery_point() {
        let temp = tempfile::tempdir().expect("temp");
        let paths = test_paths(temp.path());
        let database_path = paths.database.join("app.sqlite3");
        let connection = test_db(&database_path);
        let project = db::list_projects(&connection).expect("projects").remove(0);
        let draft = db::list_rounds(&connection, &project.id)
            .expect("rounds")
            .remove(0);
        let first = db::save_round(&connection, &draft.id, "备份中的版本", "", 0)
            .expect("save backup version");
        let backup_path = paths.backups_manual.join("restore-source.vcpbackup");
        create_backup(&connection, &paths, &backup_path, true).expect("create source backup");
        db::save_round(&connection, &draft.id, "恢复前当前版本", "", first.revision)
            .expect("save current version");
        let preparation =
            prepare_restore(&connection, &paths, &backup_path).expect("prepare restore");
        assert!(Path::new(&preparation.recovery_point_path).is_file());
        drop(connection);

        let message = apply_pending_restore(&paths)
            .expect("apply restore")
            .expect("restore message");
        assert!(message.contains("已完成备份恢复"));
        let restored = test_db(&database_path);
        assert_eq!(
            db::get_round(&restored, &draft.id)
                .expect("restored round")
                .content_md,
            "备份中的版本"
        );
        assert!(!paths.recovery.join("restore-state.json").exists());
    }

    #[test]
    fn prepared_restore_can_be_cancelled_without_removing_recovery_point() {
        let temp = tempfile::tempdir().expect("temp");
        let paths = test_paths(temp.path());
        let database_path = paths.database.join("app.sqlite3");
        let connection = test_db(&database_path);
        let project = db::list_projects(&connection).expect("projects").remove(0);
        let draft = db::list_rounds(&connection, &project.id)
            .expect("rounds")
            .remove(0);
        let saved = db::save_round(&connection, &draft.id, "备份版本", "", 0).expect("save");
        let backup_path = paths.backups_manual.join("cancel-source.vcpbackup");
        create_backup(&connection, &paths, &backup_path, true).expect("backup");
        db::save_round(&connection, &draft.id, "取消后保留", "", saved.revision).expect("current");
        let preparation =
            prepare_restore(&connection, &paths, &backup_path).expect("prepare restore");
        let recovery_point = PathBuf::from(&preparation.recovery_point_path);
        assert!(recovery_point.is_file());
        assert!(
            paths
                .recovery
                .join(format!("restore-{}", preparation.restore_id))
                .is_dir()
        );

        cancel_prepared_restore(&paths).expect("cancel restore");

        assert!(!paths.recovery.join("restore-state.json").exists());
        assert!(
            !paths
                .recovery
                .join(format!("restore-{}", preparation.restore_id))
                .exists()
        );
        assert!(recovery_point.is_file());
        assert_eq!(apply_pending_restore(&paths).expect("no restore"), None);
        assert_eq!(
            db::get_round(&connection, &draft.id)
                .expect("current round")
                .content_md,
            "取消后保留"
        );
    }

    #[test]
    fn restore_cancellation_refuses_non_prepared_phase() {
        let temp = tempfile::tempdir().expect("temp");
        let paths = test_paths(temp.path());
        let restore_id = Uuid::new_v4().to_string();
        write_json_atomically(
            &paths.recovery.join("restore-state.json"),
            &RestoreState {
                format_version: ARCHIVE_FORMAT_VERSION,
                restore_id,
                includes_fonts: false,
                database_schema_version: db::SCHEMA_VERSION,
                phase: "old-moved".into(),
                prepared_at: now_ms(),
            },
        )
        .expect("state");

        let error = cancel_prepared_restore(&paths).expect_err("must refuse");

        assert!(error.to_string().contains("不能在运行中取消"));
        assert!(paths.recovery.join("restore-state.json").is_file());
    }

    #[test]
    fn stale_recovery_cleanup_preserves_unknown_directories_and_backup_files() {
        let temp = tempfile::tempdir().expect("temp");
        let paths = test_paths(temp.path());
        let id = Uuid::new_v4();
        fs::create_dir_all(paths.recovery.join(format!("old-{id}"))).expect("old");
        fs::create_dir_all(paths.recovery.join(format!("restore-{id}"))).expect("restore");
        fs::create_dir_all(paths.recovery.join("用户保留")).expect("unknown");
        fs::write(
            paths.recovery.join("conflict-before-test.vcpbackup"),
            b"backup",
        )
        .expect("backup");

        assert_eq!(
            cleanup_stale_recovery_artifacts(&paths).expect("cleanup"),
            2
        );
        assert!(paths.recovery.join("用户保留").is_dir());
        assert!(
            paths
                .recovery
                .join("conflict-before-test.vcpbackup")
                .is_file()
        );
    }

    #[test]
    fn safe_archive_name_blocks_windows_and_unix_escape_forms() {
        assert!(safe_archive_name("content/a.md"));
        assert!(!safe_archive_name("../a.md"));
        assert!(!safe_archive_name("C:/a.md"));
        assert!(!safe_archive_name("content\\a.md"));
        assert!(!safe_archive_name("/absolute.md"));
        let _ = Cursor::new(Vec::<u8>::new());
    }

    #[test]
    fn damaged_or_directory_auto_backup_names_do_not_block_new_backup() {
        let temp = tempfile::tempdir().expect("temp");
        fs::create_dir(temp.path().join("daily-2026-07-31-fake.vcpbackup"))
            .expect("fake directory");
        fs::write(
            temp.path()
                .join("weekly-2026-W31-2026-07-31-fake.vcpbackup"),
            b"not a backup",
        )
        .expect("damaged backup");

        assert_eq!(
            valid_auto_backup_periods(temp.path(), "2026-07-31", "2026-W31").expect("period scan"),
            (false, false)
        );
    }
}
