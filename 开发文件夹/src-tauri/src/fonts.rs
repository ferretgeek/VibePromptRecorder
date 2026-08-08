use crate::{
    AppState,
    error::{AppError, AppResult},
    models::FontFaceInfo,
};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};
use skrifa::{
    MetadataProvider,
    instance::{LocationRef, Size},
    prelude::FontRef,
    string::StringId,
};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::{Manager, Runtime, UriSchemeContext, http};
use uuid::Uuid;

const MAX_FONT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES: usize = 256 * 1024 * 1024;
const MAX_IMPORTED_TOTAL_BYTES: u64 = 500 * 1024 * 1024;

#[derive(Debug)]
struct ParsedFont {
    family: String,
    weights: Vec<i32>,
    is_monospace: bool,
    face_count: i64,
    is_variable: bool,
    axes_json: String,
}

struct PreparedImport {
    id: String,
    sha256: String,
    file_name: String,
    extension: String,
    file_size: u64,
    parsed: Option<ParsedFont>,
    existing: bool,
    counts_toward_capacity: bool,
    staged_path: Option<PathBuf>,
    target_path: PathBuf,
}

fn core_fonts() -> Vec<FontFaceInfo> {
    vec![
        FontFaceInfo {
            id: "core-misans".into(),
            family: "MiSans".into(),
            source: "builtin".into(),
            is_monospace: false,
            weights: vec![400, 500, 600, 700],
            available: true,
            url: None,
            removable: false,
        },
        FontFaceInfo {
            id: "core-harmony".into(),
            family: "HarmonyOS Sans SC".into(),
            source: "builtin".into(),
            is_monospace: false,
            weights: vec![400, 500, 700],
            available: true,
            url: None,
            removable: false,
        },
        FontFaceInfo {
            id: "core-mona".into(),
            family: "Mona Sans".into(),
            source: "builtin".into(),
            is_monospace: false,
            weights: vec![400, 500, 600, 700],
            available: true,
            url: None,
            removable: false,
        },
        FontFaceInfo {
            id: "core-sarasa".into(),
            family: "Sarasa Mono SC".into(),
            source: "builtin".into(),
            is_monospace: true,
            weights: vec![400, 700],
            available: true,
            url: None,
            removable: false,
        },
    ]
}

fn normalize_system_family(display_name: &str) -> Option<(String, i32)> {
    let mut family = display_name
        .split(" (")
        .next()
        .unwrap_or(display_name)
        .trim()
        .trim_start_matches('@')
        .to_string();
    if family.is_empty() {
        return None;
    }
    let lower = family.to_ascii_lowercase();
    let weight = if lower.contains("semibold") || lower.contains("demibold") {
        600
    } else if lower.contains("bold") {
        700
    } else if lower.contains("medium") {
        500
    } else {
        400
    };
    const STYLE_SUFFIXES: &[&str] = &[
        " Bold Italic",
        " Semibold Italic",
        " DemiBold Italic",
        " Medium Italic",
        " Regular Italic",
        " Bold Oblique",
        " Semibold",
        " DemiBold",
        " Medium",
        " Regular",
        " Italic",
        " Oblique",
        " Bold",
        " Light",
    ];
    loop {
        let before = family.clone();
        for suffix in STYLE_SUFFIXES {
            if family.ends_with(suffix) {
                family.truncate(family.len() - suffix.len());
                family = family.trim_end().to_string();
                break;
            }
        }
        if family == before {
            break;
        }
    }
    (!family.is_empty()).then_some((family, weight))
}

#[cfg(windows)]
fn system_fonts() -> Vec<FontFaceInfo> {
    use winreg::{
        RegKey,
        enums::{
            HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
        },
    };

    let mut families: BTreeMap<String, (String, HashSet<i32>)> = BTreeMap::new();
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let Ok(key) = RegKey::predef(hive).open_subkey_with_flags(
                "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
                KEY_READ | view,
            ) else {
                continue;
            };
            for value in key.enum_values().flatten() {
                let display = value.0;
                for candidate in display.split(" & ") {
                    let Some((family, weight)) = normalize_system_family(candidate) else {
                        continue;
                    };
                    let canonical = family.to_lowercase();
                    let entry = families
                        .entry(canonical)
                        .or_insert_with(|| (family.clone(), HashSet::new()));
                    entry.1.insert(weight);
                }
            }
        }
    }
    let mut result = families
        .into_values()
        .map(|(family, weights)| {
            let lower = family.to_ascii_lowercase();
            let is_monospace = ["mono", "code", "console", "courier", "fixed"]
                .iter()
                .any(|hint| lower.contains(hint));
            let mut weights = weights.into_iter().collect::<Vec<_>>();
            weights.sort_unstable();
            FontFaceInfo {
                id: format!("system-{}", sha256_prefix(family.as_bytes())),
                family,
                source: "system".into(),
                is_monospace,
                weights,
                available: true,
                url: None,
                removable: false,
            }
        })
        .collect::<Vec<_>>();
    result.sort_by(|left, right| left.family.cmp(&right.family));
    if result.is_empty() {
        fallback_system_fonts()
    } else {
        result
    }
}

#[cfg(not(windows))]
fn system_fonts() -> Vec<FontFaceInfo> {
    fallback_system_fonts()
}

fn fallback_system_fonts() -> Vec<FontFaceInfo> {
    [
        ("Segoe UI", false, vec![400, 600, 700]),
        ("Microsoft YaHei UI", false, vec![400, 700]),
        ("Cascadia Mono", true, vec![400, 600, 700]),
        ("Consolas", true, vec![400, 700]),
    ]
    .into_iter()
    .map(|(family, is_monospace, weights)| FontFaceInfo {
        id: format!("system-{}", sha256_prefix(family.as_bytes())),
        family: family.into(),
        source: "system".into(),
        is_monospace,
        weights,
        available: true,
        url: None,
        removable: false,
    })
    .collect()
}

fn sha256_prefix(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn imported_url(id: &str) -> String {
    format!("http://vprfont.localhost/{id}")
}

fn imported_fonts(connection: &rusqlite::Connection) -> AppResult<Vec<FontFaceInfo>> {
    let mut statement = connection.prepare(
        "SELECT id,internal_family,weights_json,is_monospace,is_available
         FROM font_registry WHERE source='imported' ORDER BY imported_at DESC,internal_family",
    )?;
    statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let weights_json: String = row.get(2)?;
            Ok(FontFaceInfo {
                url: Some(imported_url(&id)),
                id,
                family: row.get(1)?,
                source: "imported".into(),
                is_monospace: row.get::<_, i64>(3)? != 0,
                weights: serde_json::from_str(&weights_json).unwrap_or_else(|_| vec![400]),
                available: row.get::<_, i64>(4)? != 0,
                removable: true,
            })
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub fn reconcile_imported_fonts(
    connection: &Connection,
    directory: &Path,
    verify_hash: bool,
) -> AppResult<usize> {
    let records = {
        let mut statement = connection.prepare(
            "SELECT id,sha256,file_name,file_size,is_available FROM font_registry
             WHERE source='imported'",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)? != 0,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let registered = records
        .iter()
        .map(|record| record.2.clone())
        .collect::<HashSet<_>>();
    let mut invalid = Vec::new();
    for (id, expected_sha, file_name, expected_size, available) in &records {
        if !available {
            continue;
        }
        let safe_name = Path::new(file_name)
            .file_name()
            .and_then(|name| name.to_str())
            == Some(file_name.as_str());
        let path = directory.join(file_name);
        let metadata = safe_name
            .then(|| fs::metadata(&path))
            .transpose()
            .ok()
            .flatten();
        let valid_size = metadata
            .as_ref()
            .is_some_and(|metadata| metadata.is_file() && metadata.len() == *expected_size as u64);
        let valid_hash = !verify_hash
            || (valid_size && sha256_file(&path).is_ok_and(|actual| actual == *expected_sha));
        if !safe_name || !valid_size || !valid_hash {
            invalid.push(id.clone());
        }
    }
    if !invalid.is_empty() {
        let transaction = connection.unchecked_transaction()?;
        for id in &invalid {
            transaction.execute(
                "UPDATE font_registry SET is_available=0,error_state='file-missing-or-mismatched'
                 WHERE id=?1 AND source='imported'",
                params![id],
            )?;
        }
        transaction.commit()?;
    }
    // 只清理名称为“完整 SHA-256 + 支持扩展名”的无登记文件；未知文件原样保留。
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let recognized_orphan = name.split_once('.').is_some_and(|(hash, extension)| {
            hash.len() == 64
                && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                && matches!(extension, "ttf" | "otf" | "woff" | "woff2")
        }) && !registered.contains(&name);
        if recognized_orphan {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(invalid.len())
}

pub fn list_fonts(connection: &rusqlite::Connection) -> AppResult<Vec<FontFaceInfo>> {
    let mut fonts = core_fonts();
    let mut seen = fonts
        .iter()
        .map(|font| font.family.to_lowercase())
        .collect::<HashSet<_>>();
    for font in imported_fonts(connection)?
        .into_iter()
        .chain(system_fonts())
    {
        if font.source == "imported" || seen.insert(font.family.to_lowercase()) {
            fonts.push(font);
        }
    }
    Ok(fonts)
}

fn decoded_font(bytes: &[u8], extension: &str) -> AppResult<Vec<u8>> {
    if matches!(extension, "woff" | "woff2") {
        let advertised_size = bytes
            .get(16..20)
            .and_then(|value| <[u8; 4]>::try_from(value).ok())
            .map(u32::from_be_bytes)
            .ok_or_else(|| AppError::Validation("WOFF 字体头部不完整".into()))?;
        if advertised_size == 0 || advertised_size as usize > MAX_DECOMPRESSED_BYTES {
            return Err(AppError::Validation(
                "字体声明的解压体积异常，已在解压前拒绝导入".into(),
            ));
        }
    }
    let decoded = match extension {
        "woff" => wuff::decompress_woff1(bytes)
            .map_err(|_| AppError::Validation("WOFF 字体压缩数据损坏或不受支持".into()))?,
        "woff2" => wuff::decompress_woff2(bytes)
            .map_err(|_| AppError::Validation("WOFF2 字体压缩数据损坏或不受支持".into()))?,
        "ttf" | "otf" => bytes.to_vec(),
        _ => {
            return Err(AppError::Validation(
                "仅支持 .ttf、.otf、.woff 和 .woff2 字体".into(),
            ));
        }
    };
    if decoded.len() > MAX_DECOMPRESSED_BYTES {
        return Err(AppError::Validation(
            "字体解压后体积异常，已拒绝导入".into(),
        ));
    }
    Ok(decoded)
}

fn face_family(face: &FontRef<'_>) -> Option<String> {
    for wanted in [StringId::TYPOGRAPHIC_FAMILY_NAME, StringId::FAMILY_NAME] {
        if let Some(name) = face
            .localized_strings(wanted)
            .english_or_first()
            .map(|name| name.to_string())
            .filter(|name| !name.trim().is_empty())
        {
            return Some(name.trim().to_string());
        }
    }
    None
}

fn common_weight(weight: f32) -> i32 {
    match weight {
        value if value < 450.0 => 400,
        value if value < 550.0 => 500,
        value if value < 650.0 => 600,
        _ => 700,
    }
}

fn parse_font(bytes: &[u8], extension: &str) -> AppResult<ParsedFont> {
    let decoded = decoded_font(bytes, extension)?;
    let faces = FontRef::fonts(&decoded)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| AppError::Validation("字体结构损坏，无法读取 OpenType 元数据".into()))?;
    let face_count = faces.len();
    if face_count == 0 {
        return Err(AppError::Validation(
            "字体结构损坏，无法读取 OpenType 元数据".into(),
        ));
    }
    if face_count > 64 {
        return Err(AppError::Validation("字体 face 数量过多".into()));
    }
    let mut family = None;
    let mut weights = HashSet::new();
    let mut is_monospace = true;
    let mut is_variable = false;
    let mut axes = Vec::new();
    for face in faces {
        let current_family = face_family(&face)
            .ok_or_else(|| AppError::Validation("字体缺少可读取的内部家族名称".into()))?;
        if family.is_none() {
            family = Some(current_family.clone());
        } else if family.as_deref() != Some(current_family.as_str()) {
            return Err(AppError::Validation(
                "一个文件包含多个不同字体家族；请分别导入单一家族文件".into(),
            ));
        }
        is_monospace &= face
            .metrics(Size::unscaled(), LocationRef::default())
            .is_monospace;
        let variation_axes = face.axes();
        if !variation_axes.is_empty() {
            is_variable = true;
            weights.extend([400, 500, 600, 700]);
            for axis in variation_axes.iter() {
                axes.push(json!({
                    "tag": axis.tag().to_string(),
                    "min": axis.min_value(),
                    "default": axis.default_value(),
                    "max": axis.max_value(),
                }));
            }
        } else {
            weights.insert(common_weight(face.attributes().weight.value()));
        }
    }
    let mut weights = weights.into_iter().collect::<Vec<_>>();
    weights.sort_unstable();
    Ok(ParsedFont {
        family: family.unwrap_or_else(|| "未命名字体".into()),
        weights,
        is_monospace,
        face_count: face_count as i64,
        is_variable,
        axes_json: serde_json::to_string(&axes)?,
    })
}

fn valid_extension(path: &Path) -> AppResult<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| matches!(extension.as_str(), "ttf" | "otf" | "woff" | "woff2"))
        .ok_or_else(|| AppError::Validation("仅支持 .ttf、.otf、.woff 和 .woff2 字体".into()))
}

fn ensure_import_capacity(connection: &rusqlite::Connection, incoming_bytes: u64) -> AppResult<()> {
    let used_bytes: i64 = connection.query_row(
        "SELECT COALESCE(SUM(file_size), 0) FROM font_registry
         WHERE source='imported' AND is_available=1",
        [],
        |row| row.get(0),
    )?;
    let used_bytes = u64::try_from(used_bytes).unwrap_or(u64::MAX);
    if used_bytes.saturating_add(incoming_bytes) > MAX_IMPORTED_TOTAL_BYTES {
        return Err(AppError::Validation(
            "用户字体总量不能超过 500 MiB；请先移除不再使用的字体".into(),
        ));
    }
    Ok(())
}

fn stage_import_bytes(state: &AppState, id: &str, bytes: &[u8]) -> AppResult<PathBuf> {
    let temporary = state.paths.imported_fonts.join(format!(".import-{id}.tmp"));
    {
        let mut output = File::create(&temporary)?;
        output.write_all(bytes)?;
        output.sync_all()?;
    }
    Ok(temporary)
}

fn prepare_import(
    state: &AppState,
    path: &Path,
    seen_hashes: &mut HashSet<String>,
) -> AppResult<Option<PreparedImport>> {
    if !path.is_absolute() || !path.is_file() {
        return Err(AppError::Validation("所选字体路径无效".into()));
    }
    let extension = valid_extension(path)?;
    let metadata = fs::metadata(path)?;
    if metadata.len() == 0 || metadata.len() > MAX_FONT_BYTES {
        return Err(AppError::Validation(
            "字体文件必须非空且不超过 50 MiB".into(),
        ));
    }
    let bytes = fs::read(path)?;
    let sha256: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if !seen_hashes.insert(sha256.clone()) {
        return Ok(None);
    }
    let parsed = parse_font(&bytes, &extension)?;
    let duplicate: Option<(String, String, bool)> = state
        .db
        .lock()
        .query_row(
            "SELECT id,file_name,is_available FROM font_registry WHERE sha256=?1",
            params![sha256],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)),
        )
        .optional()?;
    if let Some((id, file_name, available)) = duplicate {
        if Path::new(&file_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(file_name.as_str())
        {
            return Err(AppError::Validation("字体登记文件名不安全".into()));
        }
        let target = state.paths.imported_fonts.join(&file_name);
        let staged_path = if target.exists() {
            let existing_sha256: String = Sha256::digest(fs::read(&target)?)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            if existing_sha256 != sha256 {
                return Err(AppError::Validation(
                    "字体登记路径已存在不同内容，已拒绝覆盖".into(),
                ));
            }
            None
        } else {
            Some(stage_import_bytes(state, &id, &bytes)?)
        };
        if available && staged_path.is_none() {
            return Ok(None);
        }
        return Ok(Some(PreparedImport {
            id,
            sha256,
            file_name,
            extension,
            file_size: metadata.len(),
            parsed: None,
            existing: true,
            counts_toward_capacity: !available,
            staged_path,
            target_path: target,
        }));
    }

    let id = Uuid::new_v4().to_string();
    let file_name = format!("{sha256}.{extension}");
    let target = state.paths.imported_fonts.join(&file_name);
    let staged_path = if target.exists() {
        let existing_sha256: String = Sha256::digest(fs::read(&target)?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if existing_sha256 != sha256 {
            return Err(AppError::Validation(
                "字体哈希目标已存在不同内容，已拒绝覆盖".into(),
            ));
        }
        None
    } else {
        Some(stage_import_bytes(state, &id, &bytes)?)
    };
    Ok(Some(PreparedImport {
        id,
        sha256,
        file_name,
        extension,
        file_size: metadata.len(),
        parsed: Some(parsed),
        existing: false,
        counts_toward_capacity: true,
        staged_path,
        target_path: target,
    }))
}

fn commit_imports(state: &AppState, imports: &[PreparedImport]) -> AppResult<()> {
    let mut created_targets = Vec::new();
    for import in imports {
        if let Some(temporary) = &import.staged_path {
            if let Err(error) = fs::rename(temporary, &import.target_path) {
                for target in created_targets {
                    let _ = fs::remove_file(target);
                }
                return Err(error.into());
            }
            created_targets.push(import.target_path.clone());
        }
    }

    let commit_result = (|| -> AppResult<()> {
        let mut connection = state.db.lock();
        let transaction = connection.transaction()?;
        let imported_at = Utc::now().timestamp_millis();
        for import in imports {
            if import.existing {
                transaction.execute(
                    "UPDATE font_registry SET is_available=1,error_state=NULL,file_size=?2,imported_at=?3
                     WHERE id=?1 AND source='imported'",
                    params![import.id, import.file_size as i64, imported_at],
                )?;
                continue;
            }
            let parsed = import
                .parsed
                .as_ref()
                .ok_or_else(|| AppError::Validation("字体预检结果不完整".into()))?;
            transaction.execute(
                "INSERT INTO font_registry(id,sha256,source,display_name,internal_family,file_name,format,
                 file_size,weights_json,is_monospace,face_count,is_variable,axes_json,imported_at,is_available,error_state)
                 VALUES (?1,?2,'imported',?3,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,NULL)",
                params![
                    import.id,
                    import.sha256,
                    parsed.family,
                    import.file_name,
                    import.extension,
                    import.file_size as i64,
                    serde_json::to_string(&parsed.weights)?,
                    parsed.is_monospace as i64,
                    parsed.face_count,
                    parsed.is_variable as i64,
                    parsed.axes_json,
                    imported_at,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    })();
    if let Err(error) = commit_result {
        for target in created_targets {
            let _ = fs::remove_file(target);
        }
        return Err(error);
    }
    Ok(())
}

pub fn import_files(state: &AppState, paths: &[String]) -> AppResult<Vec<FontFaceInfo>> {
    let _operation = state.font_operations.lock();
    if paths.is_empty() {
        return Err(AppError::Validation("没有选择字体文件".into()));
    }
    if paths.len() > 100 {
        return Err(AppError::Validation("一次最多导入 100 个字体文件".into()));
    }
    let mut seen_hashes = HashSet::new();
    let mut prepared = Vec::new();
    let prepare_result = (|| -> AppResult<()> {
        for path in paths {
            if let Some(import) = prepare_import(state, &PathBuf::from(path), &mut seen_hashes)? {
                prepared.push(import);
            }
        }
        let additional_bytes = prepared
            .iter()
            .filter(|import| import.counts_toward_capacity)
            .fold(0_u64, |total, import| {
                total.saturating_add(import.file_size)
            });
        ensure_import_capacity(&state.db.lock(), additional_bytes)?;
        Ok(())
    })();
    if let Err(error) = prepare_result {
        for import in prepared {
            if let Some(path) = import.staged_path {
                let _ = fs::remove_file(path);
            }
        }
        return Err(error);
    }
    if let Err(error) = commit_imports(state, &prepared) {
        for import in &prepared {
            if let Some(path) = &import.staged_path {
                let _ = fs::remove_file(path);
            }
        }
        return Err(error);
    }
    list_fonts(&state.db.lock())
}

pub fn remove_imported(state: &AppState, id: &str) -> AppResult<Vec<FontFaceInfo>> {
    let _operation = state.font_operations.lock();
    Uuid::parse_str(id).map_err(|_| AppError::Validation("字体 ID 无效".into()))?;
    let connection = state.db.lock();
    let registered: Option<String> = connection
        .query_row(
            "SELECT file_name FROM font_registry WHERE id=?1 AND source='imported'",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let file_name =
        registered.ok_or_else(|| AppError::NotFound("未找到可移除的用户字体".into()))?;
    if Path::new(&file_name)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(file_name.as_str())
    {
        return Err(AppError::Validation("字体登记文件名不安全".into()));
    }
    let source = state.paths.imported_fonts.join(&file_name);
    let quarantine = state.paths.temp.join(format!("removed-font-{id}.tmp"));
    if source.exists() {
        fs::rename(&source, &quarantine)?;
    }
    let result = (|| -> AppResult<()> {
        let transaction = connection.unchecked_transaction()?;
        transaction.execute(
            "UPDATE font_registry SET is_available=0,error_state='removed-by-user' WHERE id=?1",
            params![id],
        )?;
        transaction.commit()?;
        Ok(())
    })();
    if let Err(error) = result {
        if quarantine.exists() {
            let _ = fs::rename(&quarantine, &source);
        }
        return Err(error);
    }
    if quarantine.exists() {
        fs::remove_file(quarantine)?;
    }
    list_fonts(&connection)
}

fn response(
    status: http::StatusCode,
    content_type: &str,
    body: Vec<u8>,
) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, content_type)
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            http::header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| http::Response::new(Vec::new()))
}

pub fn protocol_response<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let id = request.uri().path().trim_start_matches('/');
    if Uuid::parse_str(id).is_err() {
        return response(
            http::StatusCode::BAD_REQUEST,
            "text/plain; charset=utf-8",
            b"invalid font id".to_vec(),
        );
    }
    let state = context.app_handle().state::<AppState>();
    // 查询语句结束后临时 MutexGuard 立即释放，后续字体文件读取不会阻塞数据库保存。
    let registered: Result<Option<(String, String)>, rusqlite::Error> =
        state
            .db
            .lock()
            .query_row(
                "SELECT file_name,format FROM font_registry WHERE id=?1 AND source='imported' AND is_available=1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional();
    let (file_name, format) = match registered {
        Ok(Some(registered)) => registered,
        Ok(None) => {
            return response(
                http::StatusCode::NOT_FOUND,
                "text/plain; charset=utf-8",
                b"font not found".to_vec(),
            );
        }
        Err(_) => {
            return response(
                http::StatusCode::INTERNAL_SERVER_ERROR,
                "text/plain; charset=utf-8",
                b"font registry unavailable".to_vec(),
            );
        }
    };
    if Path::new(&file_name)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(file_name.as_str())
    {
        return response(
            http::StatusCode::BAD_REQUEST,
            "text/plain; charset=utf-8",
            b"invalid registry path".to_vec(),
        );
    }
    let path = state.paths.imported_fonts.join(file_name);
    let Ok(bytes) = fs::read(path) else {
        return response(
            http::StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"font file missing".to_vec(),
        );
    };
    let content_type = match format.as_str() {
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "otf" => "font/otf",
        _ => "font/ttf",
    };
    response(http::StatusCode::OK, content_type, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, paths::DataPaths};
    use parking_lot::Mutex;
    use std::sync::Arc;

    #[test]
    fn oversized_woff_is_rejected_from_header_before_decompression() {
        let mut bytes = vec![0_u8; 20];
        bytes[16..20].copy_from_slice(&(MAX_DECOMPRESSED_BYTES as u32 + 1).to_be_bytes());

        let error = decoded_font(&bytes, "woff2").expect_err("oversized WOFF2");

        assert!(error.to_string().contains("解压前拒绝"));
    }

    #[test]
    fn system_font_names_are_grouped_by_family_and_common_weight() {
        assert_eq!(
            normalize_system_family("Arial Bold Italic (TrueType)"),
            Some(("Arial".into(), 700))
        );
        assert_eq!(
            normalize_system_family("Yu Gothic UI Semibold (TrueType)"),
            Some(("Yu Gothic UI".into(), 600))
        );
    }

    #[test]
    fn unsupported_and_fake_fonts_are_rejected() {
        let error = parse_font(b"not a font", "ttf").expect_err("invalid font");
        assert!(error.to_string().contains("字体结构损坏"));
        assert!(valid_extension(Path::new("font.exe")).is_err());
    }

    #[test]
    fn imported_font_capacity_counts_only_available_files() {
        let connection = rusqlite::Connection::open_in_memory().expect("memory database");
        connection
            .execute_batch(
                "CREATE TABLE font_registry(
                    source TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    is_available INTEGER NOT NULL
                );
                INSERT INTO font_registry(source,file_size,is_available)
                VALUES ('imported', 523239424, 1), ('imported', 104857600, 0);",
            )
            .expect("font registry");
        assert!(ensure_import_capacity(&connection, 1_048_576).is_ok());
        assert!(ensure_import_capacity(&connection, 1_048_577).is_err());
    }

    #[test]
    fn startup_reconciliation_rejects_same_size_font_tampering() {
        let temp = tempfile::tempdir().expect("temp");
        let file_name = format!("{}.ttf", "a".repeat(64));
        fs::write(temp.path().join(&file_name), b"xyz").expect("tampered font");
        let connection = rusqlite::Connection::open_in_memory().expect("memory database");
        connection
            .execute_batch(
                "CREATE TABLE font_registry(
                    id TEXT PRIMARY KEY,
                    sha256 TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    is_available INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    error_state TEXT
                );",
            )
            .expect("font registry");
        connection
            .execute(
                "INSERT INTO font_registry(id,sha256,file_name,file_size,is_available,source)
                 VALUES (?1,?2,?3,3,1,'imported')",
                params![
                    "font-1",
                    Sha256::digest(b"abc")
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>(),
                    file_name
                ],
            )
            .expect("font row");

        assert_eq!(
            reconcile_imported_fonts(&connection, temp.path(), true).expect("reconcile"),
            1
        );
        let state: (i64, String) = connection
            .query_row(
                "SELECT is_available,error_state FROM font_registry WHERE id='font-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("state");
        assert_eq!(state, (0, "file-missing-or-mismatched".into()));
    }

    #[test]
    fn invalid_file_rolls_back_the_entire_font_batch() {
        let temp = tempfile::tempdir().expect("temp");
        for directory in [
            "database",
            "backups/auto",
            "backups/manual",
            "recovery",
            "fonts/imported",
            "logs",
            "temp",
            "webview2",
        ] {
            fs::create_dir_all(temp.path().join(directory)).expect("directory");
        }
        let state = AppState {
            db: Arc::new(Mutex::new(
                db::open(&temp.path().join("database/app.sqlite3")).expect("database"),
            )),
            font_operations: Mutex::new(()),
            clean_shutdown: crate::CleanShutdownIntent::default(),
            paths: DataPaths {
                root: temp.path().to_path_buf(),
                database: temp.path().join("database"),
                backups_auto: temp.path().join("backups/auto"),
                backups_manual: temp.path().join("backups/manual"),
                recovery: temp.path().join("recovery"),
                imported_fonts: temp.path().join("fonts/imported"),
                logs: temp.path().join("logs"),
                temp: temp.path().join("temp"),
                webview2: temp.path().join("webview2"),
                unclean_start: false,
                clean_shutdown_marker: temp.path().join(".vpr-clean-shutdown"),
                in_sync_directory: false,
                _lock_file: File::create(temp.path().join("instance.lock")).expect("lock"),
            },
        };
        let valid =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/fonts/core/Mona-Sans.woff2");
        let invalid = temp.path().join("invalid.ttf");
        fs::write(&invalid, b"not a font").expect("invalid font");
        let error = import_files(
            &state,
            &[
                valid.to_string_lossy().into_owned(),
                invalid.to_string_lossy().into_owned(),
            ],
        )
        .expect_err("batch must fail");
        assert!(error.to_string().contains("字体结构损坏"));
        let count: i64 = state
            .db
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM font_registry WHERE source='imported'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 0);
        assert!(
            fs::read_dir(&state.paths.imported_fonts)
                .expect("fonts")
                .next()
                .is_none()
        );
    }

    #[test]
    fn concurrent_duplicate_imports_leave_one_registered_file() {
        let temp = tempfile::tempdir().expect("temp");
        for directory in [
            "database",
            "backups/auto",
            "backups/manual",
            "recovery",
            "fonts/imported",
            "logs",
            "temp",
            "webview2",
        ] {
            fs::create_dir_all(temp.path().join(directory)).expect("directory");
        }
        let state = Arc::new(AppState {
            db: Arc::new(Mutex::new(
                db::open(&temp.path().join("database/app.sqlite3")).expect("database"),
            )),
            font_operations: Mutex::new(()),
            clean_shutdown: crate::CleanShutdownIntent::default(),
            paths: DataPaths {
                root: temp.path().to_path_buf(),
                database: temp.path().join("database"),
                backups_auto: temp.path().join("backups/auto"),
                backups_manual: temp.path().join("backups/manual"),
                recovery: temp.path().join("recovery"),
                imported_fonts: temp.path().join("fonts/imported"),
                logs: temp.path().join("logs"),
                temp: temp.path().join("temp"),
                webview2: temp.path().join("webview2"),
                unclean_start: false,
                clean_shutdown_marker: temp.path().join(".vpr-clean-shutdown"),
                in_sync_directory: false,
                _lock_file: File::create(temp.path().join("instance.lock")).expect("lock"),
            },
        });
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/fonts/core/Mona-Sans.woff2")
            .to_string_lossy()
            .into_owned();

        std::thread::scope(|scope| {
            for _ in 0..2 {
                let state = Arc::clone(&state);
                let path = path.clone();
                scope.spawn(move || import_files(&state, &[path]).expect("concurrent import"));
            }
        });

        let connection = state.db.lock();
        let registered: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM font_registry WHERE source='imported' AND is_available=1",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(registered, 1);
        let files = fs::read_dir(&state.paths.imported_fonts)
            .expect("font directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .count();
        assert_eq!(files, 1);
    }
}
