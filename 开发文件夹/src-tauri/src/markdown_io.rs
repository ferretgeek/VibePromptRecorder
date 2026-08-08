use crate::{
    db,
    error::{AppError, AppResult},
    file_atomic,
    models::{ExportResult, ProjectSummary},
};
use chrono::{Local, TimeZone, Utc};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};
use uuid::Uuid;

const MARKDOWN_IMPORT_LIMIT: u64 = 512 * 1024 * 1024;
const SINGLE_ROUND_LIMIT: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone)]
struct ImportedRound<'a> {
    status: String,
    content: &'a str,
    note: String,
}

#[derive(Debug, Clone)]
struct PreparedRound {
    status: String,
    content_start: usize,
    content_end: usize,
    note: String,
}

pub struct PreparedMarkdownImport {
    name: String,
    text: String,
    rounds: Vec<PreparedRound>,
}

struct TempFile(std::path::PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct TempDirectory(std::path::PathBuf);

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn format_time(timestamp: i64) -> String {
    Local
        .timestamp_millis_opt(timestamp)
        .single()
        .unwrap_or_else(Local::now)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn truncate_utf16(value: &str, max_units: usize) -> String {
    let mut units = 0_usize;
    value
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > max_units {
                return false;
            }
            units = next;
            true
        })
        .collect()
}

fn sanitize_file_name(value: &str) -> String {
    let sanitized = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let mut result = truncate_utf16(&sanitized, 180);
    while result.ends_with(['.', ' ']) {
        result.pop();
    }
    if result.is_empty() {
        result = "未命名项目".into();
    }
    let stem = result.split('.').next().unwrap_or_default();
    if matches!(
        stem.to_ascii_lowercase().as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    ) {
        result.insert(0, '_');
    }
    result
}

fn export_display_name(value: &str) -> String {
    let name = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let name = name.trim();
    if name.is_empty() {
        "未命名项目".into()
    } else {
        name.chars().take(120).collect()
    }
}

fn markdown_link_label(value: &str) -> String {
    export_display_name(value)
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn percent_encode_path_component(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'.' | b'_' | b'~') {
            result.push(char::from(*byte));
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

fn cleanup_stale_export_temps(parent: &Path) -> AppResult<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let id = name
            .strip_prefix(".vpr-markdown-")
            .and_then(|value| value.strip_suffix(".tmp"))
            .or_else(|| {
                name.strip_prefix(".vpr-all-export-")
                    .and_then(|value| value.strip_suffix(".tmp"))
            });
        if id.is_none_or(|value| Uuid::parse_str(value).is_err()) {
            continue;
        }
        let stale = entry
            .metadata()?
            .modified()
            .ok()
            .and_then(|time| time.elapsed().ok())
            .is_some_and(|age| age >= std::time::Duration::from_secs(24 * 60 * 60));
        if !stale {
            continue;
        }
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
        removed += 1;
    }
    Ok(removed)
}

fn validate_markdown_target(target: &Path) -> AppResult<&Path> {
    if !target.is_absolute()
        || target
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
            != Some("md")
    {
        return Err(AppError::Validation(
            "Markdown 导出目标必须是完整的 .md 路径".into(),
        ));
    }
    target
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| AppError::Validation("Markdown 导出目标目录不存在".into()))
}

fn publish_text_file(temporary: &Path, target: &Path, parent: &Path) -> AppResult<()> {
    let _ = parent;
    file_atomic::replace_file(temporary, target)?;
    Ok(())
}

fn write_project_markdown_atomically(
    connection: &Connection,
    project_id: &str,
    target: &Path,
) -> AppResult<ExportResult> {
    let parent = validate_markdown_target(target)?;
    cleanup_stale_export_temps(parent)?;
    let project = db::get_project(connection, project_id)?;
    let export_id = Uuid::new_v4().to_string();
    let temporary = parent.join(format!(".vpr-markdown-{}.tmp", Uuid::new_v4()));
    let _temporary_guard = TempFile(temporary.clone());
    let mut file = File::create(&temporary)?;
    let mut hasher = Sha256::new();
    let mut byte_count = 0_u64;
    let header = format!(
        "<!-- vpr-export:v1 export={export_id} -->\n# {}\n\n> 导出时间：{}\n\n",
        export_display_name(&project.name),
        format_time(now_ms())
    );
    file.write_all(header.as_bytes())?;
    hasher.update(header.as_bytes());
    byte_count = byte_count.saturating_add(header.len() as u64);
    let rounds = db::list_rounds(connection, project_id)?;
    let mut final_number = 0_i64;
    for summary in rounds {
        let round = db::get_round(connection, &summary.id)?;
        if round.status == "draft" && round.content_md.trim().is_empty() {
            continue;
        }
        let title = if round.status == "draft" {
            "## 当前草稿".to_string()
        } else {
            final_number += 1;
            if round.note.is_empty() {
                format!("## 第 {final_number} 轮")
            } else {
                format!("## 第 {final_number} 轮 · {}", round.note)
            }
        };
        let bytes = round.content_md.as_bytes();
        let metadata = format!(
            "<!-- vpr-round export={export_id} id={} bytes={} sha256={} -->\n{title}\n\n> 保存时间：{}\n\n",
            round.id,
            bytes.len(),
            sha256(bytes),
            format_time(round.finalized_at.unwrap_or(round.updated_at)),
        );
        for chunk in [metadata.as_bytes(), bytes, b"\n\n"] {
            file.write_all(chunk)?;
            hasher.update(chunk);
            byte_count = byte_count.saturating_add(chunk.len() as u64);
        }
    }
    file.sync_all()?;
    drop(file);
    publish_text_file(&temporary, target, parent)?;
    Ok(ExportResult {
        path: target.to_string_lossy().into_owned(),
        byte_count,
        sha256: hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    })
}

pub fn write_text_file_atomically(target: &Path, content: &str) -> AppResult<ExportResult> {
    let parent = validate_markdown_target(target)?;
    cleanup_stale_export_temps(parent)?;
    let temporary = parent.join(format!(".vpr-markdown-{}.tmp", Uuid::new_v4()));
    let _temporary_guard = TempFile(temporary.clone());
    {
        let mut file = File::create(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    publish_text_file(&temporary, target, parent)?;
    let bytes = content.as_bytes();
    Ok(ExportResult {
        path: target.to_string_lossy().into_owned(),
        byte_count: bytes.len() as u64,
        sha256: sha256(bytes),
    })
}

pub fn export_project_markdown(
    connection: &Connection,
    project_id: &str,
    target: &Path,
) -> AppResult<ExportResult> {
    write_project_markdown_atomically(connection, project_id, target)
}

const ALL_EXPORT_COMPLETE_MARKER: &str = "EXPORT-COMPLETE";

fn copy_completed_export(source: &Path, target: &Path) -> AppResult<()> {
    fs::create_dir(target)?;
    let target_guard = TempDirectory(target.to_path_buf());
    let mut entries = fs::read_dir(source)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries
        .iter()
        .filter(|entry| entry.file_name() != ALL_EXPORT_COMPLETE_MARKER)
    {
        if !entry.file_type()?.is_file() {
            return Err(AppError::Validation(
                "全部项目导出的临时目录包含意外子目录".into(),
            ));
        }
        let copied = fs::copy(entry.path(), target.join(entry.file_name()))?;
        if copied != entry.metadata()?.len() {
            return Err(AppError::Validation("网络目标文件复制不完整".into()));
        }
        File::open(target.join(entry.file_name()))?.sync_all()?;
    }
    // 完成标记必须最后发布；没有该标记的目录一律视为未完成导出。
    let marker_source = source.join(ALL_EXPORT_COMPLETE_MARKER);
    let marker_target = target.join(ALL_EXPORT_COMPLETE_MARKER);
    fs::copy(&marker_source, &marker_target)?;
    File::open(&marker_target)?.sync_all()?;
    std::mem::forget(target_guard);
    Ok(())
}

pub fn export_all_markdown(connection: &Connection, parent: &Path) -> AppResult<ExportResult> {
    if !parent.is_absolute() || !parent.is_dir() {
        return Err(AppError::Validation("请选择现有的完整目标目录".into()));
    }
    cleanup_stale_export_temps(parent)?;
    let directory_name = format!(
        "提示词记录工具-全部项目-{}-{}",
        Local::now().format("%Y%m%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    );
    let directory = parent.join(&directory_name);
    let temporary_directory = parent.join(format!(".vpr-all-export-{}.tmp", Uuid::new_v4()));
    fs::create_dir(&temporary_directory)?;
    let temporary_guard = TempDirectory(temporary_directory.clone());
    let projects = db::list_projects(connection)?;
    let mut index = format!(
        "<!-- vpr-all-export:v1 -->\n# 提示词记录工具 · 全部项目\n\n> 导出时间：{}\n\n",
        format_time(now_ms())
    );
    let mut total = 0_u64;
    for (position, project) in projects.iter().enumerate() {
        let file_name = format!(
            "{:03}-{}-{}.md",
            position + 1,
            sanitize_file_name(&project.name),
            &project.id[..8.min(project.id.len())]
        );
        let result = write_project_markdown_atomically(
            connection,
            &project.id,
            &temporary_directory.join(&file_name),
        )?;
        total = total.saturating_add(result.byte_count);
        index.push_str(&format!(
            "- [{}]({}) — {} 个正式轮次{}\n",
            markdown_link_label(&project.name),
            percent_encode_path_component(&file_name),
            project.round_count,
            if project.has_draft {
                "，含当前草稿"
            } else {
                ""
            }
        ));
    }
    let index_result = write_text_file_atomically(&temporary_directory.join("index.md"), &index)?;
    total = total.saturating_add(index_result.byte_count);
    let complete_marker = temporary_directory.join(ALL_EXPORT_COMPLETE_MARKER);
    {
        let mut file = File::create(&complete_marker)?;
        writeln!(file, "v1")?;
        writeln!(file, "index-sha256={}", index_result.sha256)?;
        writeln!(file, "markdown-bytes={total}")?;
        file.sync_all()?;
    }
    match fs::rename(&temporary_directory, &directory) {
        Ok(()) => std::mem::forget(temporary_guard),
        Err(rename_error) => copy_completed_export(&temporary_directory, &directory).map_err(
            |copy_error| {
                AppError::Validation(format!(
                    "目标位置不支持目录原子发布，逐文件回退也失败：{copy_error}（原始错误：{rename_error}）"
                ))
            },
        )?,
    }
    Ok(ExportResult {
        path: directory.to_string_lossy().into_owned(),
        byte_count: total,
        sha256: index_result.sha256,
    })
}

fn attributes(marker: &str) -> Option<Vec<(&str, &str)>> {
    let inner = marker.strip_prefix("<!-- ")?.strip_suffix(" -->")?;
    Some(
        inner
            .split_whitespace()
            .skip(1)
            .filter_map(|part| part.split_once('='))
            .collect(),
    )
}

fn attribute<'a>(attributes: &'a [(&str, &str)], key: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find_map(|(name, value)| (*name == key).then_some(*value))
}

fn parse_structured_export(text: &str) -> Option<(String, Vec<PreparedRound>)> {
    let header_end = text.find(" -->")? + 4;
    let header = &text[..header_end];
    if !header.starts_with("<!-- vpr-export:v1 ") {
        return None;
    }
    let header_attributes = attributes(header)?;
    let export_id = attribute(&header_attributes, "export")?;
    Uuid::parse_str(export_id).ok()?;
    let after_header = text.get(header_end..)?.strip_prefix('\n')?;
    let project_line = after_header.lines().next()?.strip_prefix("# ")?;
    if project_line.trim().is_empty() {
        return None;
    }
    // 只接受行首的第一个结构 marker；正文内部即使包含同形注释，也必须由 bytes 字段
    // 直接跨过，绝不能参与全局 marker 扫描。
    let wrapper_start = 2 + project_line.len();
    let wrapper_and_rounds = after_header.get(wrapper_start..)?;
    let first_marker_relative = wrapper_and_rounds.find("\n<!-- vpr-round ");
    let wrapper = first_marker_relative
        .map(|offset| &wrapper_and_rounds[..offset])
        .unwrap_or(wrapper_and_rounds);
    let export_time = wrapper.strip_prefix("\n\n> 导出时间：")?;
    let (_, wrapper_tail) = export_time.split_once('\n')?;
    if !wrapper_tail.trim().is_empty() {
        return None;
    }
    let Some(first_marker_relative) = first_marker_relative else {
        return Some((project_line.trim().chars().take(120).collect(), Vec::new()));
    };
    let first_marker_offset = header_end + 1 + wrapper_start + first_marker_relative + 1;
    let mut rounds = Vec::new();
    let mut ids = HashSet::new();
    let mut marker_start = first_marker_offset;
    loop {
        let marker_end = text.get(marker_start..)?.find(" -->")? + marker_start + 4;
        let marker = text.get(marker_start..marker_end)?;
        let marker_attributes = attributes(marker)?;
        if attribute(&marker_attributes, "export")? != export_id {
            return None;
        }
        let round_id = attribute(&marker_attributes, "id")?;
        Uuid::parse_str(round_id).ok()?;
        if !ids.insert(round_id.to_string()) {
            return None;
        }
        let byte_count = attribute(&marker_attributes, "bytes")?
            .parse::<usize>()
            .ok()?;
        let expected_sha = attribute(&marker_attributes, "sha256")?;
        if expected_sha.len() != 64 || !expected_sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let after_marker = text.get(marker_end..)?.strip_prefix('\n')?;
        let title_end = after_marker.find('\n')?;
        let title = &after_marker[..title_end];
        let status = if title == "## 当前草稿" {
            "draft"
        } else if title.starts_with("## 第 ") {
            "final"
        } else {
            return None;
        };
        let note = if status == "final" {
            title
                .split_once(" · ")
                .map_or("", |(_, note)| note)
                .to_string()
        } else {
            String::new()
        };
        if note.chars().count() > 120 || note.contains(['\r', '\n']) {
            return None;
        }
        let wrapper = &after_marker[title_end..];
        let time_prefix = "\n\n> 保存时间：";
        let time_start = wrapper.strip_prefix(time_prefix)?;
        let separator = time_start.find("\n\n")?;
        let relative_content_start = title_end + time_prefix.len() + separator + 2;
        let content_start = marker_end + 1 + relative_content_start;
        let content_end = content_start.checked_add(byte_count)?;
        let content = text.get(content_start..content_end)?;
        if sha256(content.as_bytes()) != expected_sha.to_ascii_lowercase() {
            return None;
        }
        rounds.push(PreparedRound {
            status: status.into(),
            content_start,
            content_end,
            note,
        });
        let tail = text.get(content_end..)?;
        let remaining = tail.trim_start_matches(['\r', '\n']);
        let next_start = text.len() - remaining.len();
        if remaining.is_empty() {
            break;
        }
        if !remaining.starts_with("<!-- vpr-round ") {
            return None;
        }
        marker_start = next_start;
    }
    if rounds
        .iter()
        .filter(|round| round.status == "draft")
        .count()
        > 1
    {
        return None;
    }
    Some((project_line.trim().chars().take(120).collect(), rounds))
}

fn unique_name(connection: &Connection, base: &str) -> AppResult<String> {
    for index in 0..10_000 {
        let suffix = match index {
            0 => String::new(),
            1 => "（导入）".into(),
            _ => format!("（导入 {index}）"),
        };
        let keep = 120_usize.saturating_sub(suffix.chars().count());
        let candidate = format!("{}{}", base.chars().take(keep).collect::<String>(), suffix);
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

fn insert_imported_project(
    connection: &Connection,
    name: &str,
    rounds: &[ImportedRound<'_>],
) -> AppResult<ProjectSummary> {
    // 在开启事务、插入项目之前完成全部轮次校验，超限导入不会产生任何临时数据库状态。
    if rounds
        .iter()
        .any(|round| round.content.len() as u64 > SINGLE_ROUND_LIMIT)
    {
        return Err(AppError::Validation(
            "存在超过 10 MiB 的单轮内容，未导入任何数据；请先拆分后再导入".into(),
        ));
    }
    let incoming_bytes = rounds.iter().try_fold(0_u64, |total, round| {
        total
            .checked_add(round.content.len() as u64)
            .ok_or_else(|| AppError::Validation("Markdown 导入内容大小溢出".into()))
    })?;
    db::ensure_database_growth_capacity(connection, incoming_bytes)?;
    let project_id = Uuid::new_v4().to_string();
    let name = unique_name(connection, name.trim())?;
    let now = now_ms();
    let transaction = connection.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO projects(id,name,is_pinned,created_at,updated_at,last_opened_at,revision)
         VALUES (?1,?2,0,?3,?3,?3,0)",
        params![project_id, name, now],
    )?;
    let mut draft_id = None;
    let mut final_position = 0_i64;
    for round in rounds {
        let id = Uuid::new_v4().to_string();
        let position = if round.status == "draft" {
            draft_id = Some(id.clone());
            2_147_483_647
        } else {
            let position = final_position;
            final_position += 1;
            position
        };
        let finalized_at = (round.status == "final").then_some(now);
        transaction.execute(
            "INSERT INTO rounds(id,project_id,position,status,content_md,created_at,finalized_at,
             updated_at,revision,note) VALUES (?1,?2,?3,?4,?5,?6,?7,?6,0,?8)",
            params![
                id,
                project_id,
                position,
                round.status,
                round.content,
                now,
                finalized_at,
                round.note
            ],
        )?;
        transaction.execute(
            "INSERT INTO search_index(project_name,note,content_md,project_id,round_id,status)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                name,
                round.note,
                round.content,
                project_id,
                id,
                round.status
            ],
        )?;
    }
    if draft_id.is_none() {
        let id = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO rounds(id,project_id,position,status,content_md,created_at,updated_at,revision,note)
             VALUES (?1,?2,2147483647,'draft','',?3,?3,0,'')",
            params![id, project_id, now],
        )?;
        transaction.execute(
            "INSERT INTO search_index(project_name,note,content_md,project_id,round_id,status)
             VALUES (?1,'','',?2,?3,'draft')",
            params![name, project_id, id],
        )?;
        draft_id = Some(id);
    }
    transaction.execute(
        "INSERT INTO project_view_state(project_id,selected_round_id,editor_mode,detail_open,updated_at)
         VALUES (?1,?2,'wysiwyg',1,?3)",
        params![project_id, draft_id, now],
    )?;
    transaction.commit()?;
    db::get_project(connection, &project_id)
}

pub fn prepare_markdown_import(path: &Path) -> AppResult<PreparedMarkdownImport> {
    if !path.is_absolute()
        || !path.is_file()
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
            != Some("md")
    {
        return Err(AppError::Validation("请选择完整的 UTF-8 .md 文件".into()));
    }
    let size = fs::metadata(path)?.len();
    if size > MARKDOWN_IMPORT_LIMIT {
        return Err(AppError::Validation(
            "Markdown 文件超过 512 MiB 安全上限；请拆分后再导入".into(),
        ));
    }
    let structured_candidate = {
        let mut file = File::open(path)?;
        let mut prefix = [0_u8; 32];
        let count = file.read(&mut prefix)?;
        prefix[..count].starts_with(b"<!-- vpr-export:")
    };
    if !structured_candidate && size > SINGLE_ROUND_LIMIT {
        return Err(AppError::Validation(
            "普通 Markdown 会作为单个轮次导入，文件超过 10 MiB 单轮上限；请先拆分后再导入".into(),
        ));
    }
    let bytes = fs::read(path)?;
    if bytes.len() as u64 > MARKDOWN_IMPORT_LIMIT {
        return Err(AppError::Validation(
            "Markdown 文件在读取期间超过 512 MiB 安全上限；未导入任何数据".into(),
        ));
    }
    if !structured_candidate && bytes.len() as u64 > SINGLE_ROUND_LIMIT {
        return Err(AppError::Validation(
            "普通 Markdown 在读取期间超过 10 MiB 单轮上限；未导入任何数据".into(),
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::Validation("Markdown 文件不是有效 UTF-8".into()))?;
    if let Some((name, rounds)) = parse_structured_export(&text) {
        return Ok(PreparedMarkdownImport { name, text, rounds });
    }
    if text.starts_with("<!-- vpr-export:") {
        return Err(AppError::Validation(
            "结构化 Markdown 的轮次边界或完整性校验失败；未把包装文件降级为普通正文".into(),
        ));
    }
    let name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("导入的 Markdown");
    let name = name.chars().take(120).collect::<String>();
    let text_length = text.len();
    Ok(PreparedMarkdownImport {
        name,
        text,
        rounds: vec![PreparedRound {
            status: "final".into(),
            content_start: 0,
            content_end: text_length,
            note: String::new(),
        }],
    })
}

pub fn commit_markdown_import(
    connection: &Connection,
    prepared: &PreparedMarkdownImport,
) -> AppResult<ProjectSummary> {
    let rounds = prepared
        .rounds
        .iter()
        .map(|round| {
            let content = prepared
                .text
                .get(round.content_start..round.content_end)
                .ok_or_else(|| AppError::Validation("Markdown 暂存范围无效".into()))?;
            Ok(ImportedRound {
                status: round.status.clone(),
                content,
                note: round.note.clone(),
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    insert_imported_project(connection, &prepared.name, &rounds)
}

#[cfg(test)]
pub fn import_markdown(connection: &Connection, path: &Path) -> AppResult<ProjectSummary> {
    let prepared = prepare_markdown_import(path)?;
    commit_markdown_import(connection, &prepared)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database(path: &Path) -> Connection {
        db::open(path).expect("database")
    }

    #[test]
    fn generated_markdown_round_trips_only_when_hashes_match() {
        let temp = tempfile::tempdir().expect("temp");
        let source = database(&temp.path().join("source.sqlite3"));
        let project = db::list_projects(&source).expect("projects").remove(0);
        let draft = db::list_rounds(&source, &project.id)
            .expect("rounds")
            .remove(0);
        db::save_round(
            &source,
            &draft.id,
            "## 原始标题\n\n中文 😀\n",
            "关键备注",
            0,
        )
        .expect("save");
        db::finalize_draft(&source, &project.id).expect("finalize");
        let file = temp.path().join("export.md");
        export_project_markdown(&source, &project.id, &file).expect("export");
        let target = database(&temp.path().join("target.sqlite3"));
        let imported = import_markdown(&target, &file).expect("import");
        let rounds = db::list_rounds(&target, &imported.id).expect("rounds");
        let imported_final = rounds
            .iter()
            .find(|round| round.status == "final")
            .expect("final");
        assert_eq!(
            db::get_round(&target, &imported_final.id)
                .expect("detail")
                .note,
            "关键备注"
        );

        let mut tampered = fs::read_to_string(&file).expect("read");
        tampered = tampered.replace("中文", "篡改");
        fs::write(&file, tampered).expect("tamper");
        let error = import_markdown(&target, &file).expect_err("reject tampered structured export");
        assert!(error.to_string().contains("完整性校验失败"));
    }

    #[test]
    fn structured_export_preserves_trailing_newlines_and_marker_like_content() {
        let temp = tempfile::tempdir().expect("temp");
        let source = database(&temp.path().join("source.sqlite3"));
        let project = db::list_projects(&source).expect("projects").remove(0);
        let draft = db::list_rounds(&source, &project.id)
            .expect("rounds")
            .remove(0);
        let original = "正文\n<!-- vpr-round 只是正文，不是边界 -->\n\n\n";
        db::save_round(&source, &draft.id, original, "", 0).expect("save");
        let file = temp.path().join("export.md");
        export_project_markdown(&source, &project.id, &file).expect("export");

        let target = database(&temp.path().join("target.sqlite3"));
        let imported = import_markdown(&target, &file).expect("import");
        let imported_draft = db::list_rounds(&target, &imported.id)
            .expect("rounds")
            .into_iter()
            .find(|round| round.status == "draft")
            .expect("draft");
        assert_eq!(
            db::get_round(&target, &imported_draft.id)
                .expect("detail")
                .content_md,
            original
        );
    }

    #[test]
    fn windows_file_name_sanitization_is_stable() {
        assert_eq!(sanitize_file_name(" A:B? "), "A_B_");
        assert_eq!(sanitize_file_name("..."), "未命名项目");
        assert_eq!(sanitize_file_name("CON"), "_CON");
        let emoji = sanitize_file_name(&"😀".repeat(100));
        assert_eq!(emoji.encode_utf16().count(), 180);
        assert_eq!(emoji.chars().count(), 90);
    }

    #[test]
    fn empty_project_export_round_trips_without_importing_the_wrapper_as_content() {
        let temp = tempfile::tempdir().expect("temp");
        let source = database(&temp.path().join("source.sqlite3"));
        let project = db::list_projects(&source).expect("projects").remove(0);
        let file = temp.path().join("empty.md");

        export_project_markdown(&source, &project.id, &file).expect("export");
        let exported = fs::read_to_string(&file).expect("read");
        assert!(!exported.contains("<!-- vpr-round "));

        let target = database(&temp.path().join("target.sqlite3"));
        let imported = import_markdown(&target, &file).expect("import");
        let rounds = db::list_rounds(&target, &imported.id).expect("rounds");
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].status, "draft");
        assert_eq!(
            db::get_round(&target, &rounds[0].id)
                .expect("draft")
                .content_md,
            ""
        );
    }

    #[test]
    fn all_projects_index_escapes_labels_and_percent_encodes_file_links() {
        let temp = tempfile::tempdir().expect("temp");
        let connection = database(&temp.path().join("source.sqlite3"));
        let project = db::list_projects(&connection).expect("projects").remove(0);
        db::rename_project(&connection, &project.id, "方括号[甲] 空格😀").expect("rename");

        let result = export_all_markdown(&connection, temp.path()).expect("export all");
        let index = fs::read_to_string(Path::new(&result.path).join("index.md")).expect("index");

        assert!(index.contains(r"[方括号\[甲\] 空格😀]"));
        assert!(index.contains("%20"));
        assert!(index.contains("%F0%9F%98%80"));
    }

    #[test]
    fn all_projects_export_is_published_only_after_completion() {
        let temp = tempfile::tempdir().expect("temp");
        let connection = database(&temp.path().join("source.sqlite3"));

        let result = export_all_markdown(&connection, temp.path()).expect("export all");

        let directory = Path::new(&result.path);
        assert!(directory.join("index.md").is_file());
        assert!(directory.join(ALL_EXPORT_COMPLETE_MARKER).is_file());
        let leftovers = fs::read_dir(temp.path())
            .expect("parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".vpr-all-export-")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn oversized_plain_markdown_is_rejected_at_single_round_limit_before_full_read() {
        let temp = tempfile::tempdir().expect("temp");
        let path = temp.path().join("plain-large.md");
        let mut file = File::create(&path).expect("file");
        file.write_all(b"ordinary markdown\n").expect("prefix");
        file.set_len(SINGLE_ROUND_LIMIT + 1).expect("sparse file");
        drop(file);
        let connection = database(&temp.path().join("source.sqlite3"));

        let error = import_markdown(&connection, &path).expect_err("plain oversized import");

        assert!(error.to_string().contains("10 MiB 单轮上限"));
    }

    #[test]
    fn oversized_markdown_is_rejected_before_reading_into_memory() {
        let temp = tempfile::tempdir().expect("temp");
        let path = temp.path().join("oversized.md");
        let file = File::create(&path).expect("file");
        file.set_len(MARKDOWN_IMPORT_LIMIT + 1)
            .expect("sparse file");
        let connection = database(&temp.path().join("source.sqlite3"));

        let error = import_markdown(&connection, &path).expect_err("oversized import");

        assert!(error.to_string().contains("512 MiB"));
    }
}
