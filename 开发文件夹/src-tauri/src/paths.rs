use crate::{
    error::{AppError, AppResult},
    file_atomic,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MARKER_NAME: &str = ".vpr-data-root.json";
const CLEAN_SHUTDOWN_MARKER: &str = ".vpr-clean-shutdown";

#[cfg(windows)]
fn windows_volume_root(path: &Path) -> Option<String> {
    use std::path::{Component, Prefix};

    match path.components().next()? {
        Component::Prefix(prefix) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                Some(format!("{}:\\", char::from(letter)))
            }
            _ => None,
        },
        _ => None,
    }
}

#[cfg(windows)]
fn reject_remote_volume(path: &Path) -> AppResult<()> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDriveTypeW(root_path_name: *const u16) -> u32;
    }
    const DRIVE_REMOTE: u32 = 4;

    let Some(root) = windows_volume_root(path) else {
        return Ok(());
    };
    let wide = root
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: `wide` 是以 NUL 结尾且在调用期间保持有效的 UTF-16 驱动器根路径。
    let drive_type = unsafe { GetDriveTypeW(wide.as_ptr()) };
    if drive_type == DRIVE_REMOTE {
        return Err(AppError::Validation(
            "活动数据库不能放在映射网络驱动器或 UNC 网络路径；备份和导出仍可选择网络位置".into(),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn reject_remote_volume(_path: &Path) -> AppResult<()> {
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataRootMarker {
    format_version: u32,
    instance_id: String,
    created_by: String,
}

pub struct DataPaths {
    pub root: PathBuf,
    pub database: PathBuf,
    pub backups_auto: PathBuf,
    pub backups_manual: PathBuf,
    pub recovery: PathBuf,
    pub imported_fonts: PathBuf,
    pub logs: PathBuf,
    pub temp: PathBuf,
    pub webview2: PathBuf,
    pub unclean_start: bool,
    pub clean_shutdown_marker: PathBuf,
    /// 数据根位于 OneDrive / Dropbox 等同步目录内时为 true，供前端一次性提醒。
    pub in_sync_directory: bool,
    pub _lock_file: File,
}

fn normalized_windows_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().to_lowercase().replace('/', "\\");
    normalized
        .strip_prefix("\\\\?\\unc\\")
        .map(|value| format!("\\\\{value}"))
        .or_else(|| normalized.strip_prefix("\\\\?\\").map(str::to_string))
        .unwrap_or(normalized)
        .trim_end_matches('\\')
        .to_string()
}

/// 判断数据根是否落在已知的云同步目录内（按环境变量与常见路径特征）。
fn detect_sync_directory(root: &Path) -> bool {
    let normalized = normalized_windows_path(root);
    let mut roots: Vec<String> = Vec::new();
    for key in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(value) = env::var_os(key) {
            roots.push(normalized_windows_path(Path::new(&value)));
        }
    }
    if let Some(profile) = env::var_os("USERPROFILE") {
        let base = normalized_windows_path(Path::new(&profile));
        roots.push(format!("{base}\\dropbox"));
        roots.push(format!("{base}\\google drive"));
        roots.push(format!("{base}\\坚果云"));
    }
    if roots
        .iter()
        .any(|sync_root| !sync_root.is_empty() && normalized.starts_with(sync_root))
    {
        return true;
    }
    // 兜底特征匹配：路径片段包含常见同步目录名。
    ["\\onedrive", "\\dropbox", "\\google drive"]
        .iter()
        .any(|needle| normalized.contains(needle))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataLocator {
    format_version: u32,
    data_path: PathBuf,
}

fn data_dir_from_args(args: &[std::ffi::OsString]) -> Option<PathBuf> {
    for (index, argument) in args.iter().enumerate().skip(1) {
        if argument == "--data-dir" {
            return args.get(index + 1).map(PathBuf::from);
        }
        if let Some(value) = argument
            .to_str()
            .and_then(|value| value.strip_prefix("--data-dir="))
            .filter(|value| !value.is_empty())
        {
            return Some(PathBuf::from(value));
        }
    }
    None
}

fn requested_data_dir() -> Option<PathBuf> {
    let args: Vec<_> = env::args_os().collect();
    data_dir_from_args(&args).or_else(|| env::var_os("VPR_DATA_DIR").map(PathBuf::from))
}

fn adjacent_data_dir() -> AppResult<PathBuf> {
    let executable = env::current_exe()?;
    let parent = executable.parent().ok_or_else(|| {
        AppError::Validation("无法确定程序所在目录，不能安全创建便携数据目录".into())
    })?;
    Ok(parent.join("data"))
}

fn cleanup_root_startup_artifacts(root: &Path) -> AppResult<usize> {
    if !root.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let recognized = name == format!("{MARKER_NAME}.tmp")
            || matches_uuid_temp_name(&name, ".vpr-data-root-", ".tmp")
            || matches_uuid_temp_name(&name, ".write-probe-", "")
            || matches_uuid_temp_name(&name, ".write-probe-renamed-", "");
        if recognized {
            fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn validate_or_create_marker(root: &Path) -> AppResult<()> {
    fs::create_dir_all(root)?;
    cleanup_root_startup_artifacts(root)?;
    let marker_path = root.join(MARKER_NAME);
    if marker_path.exists() {
        let marker: DataRootMarker = serde_json::from_slice(&fs::read(&marker_path)?)?;
        if marker.format_version != 1 || marker.instance_id.trim().is_empty() {
            return Err(AppError::Validation(
                "数据目录标记版本无效；现有文件未被覆盖".into(),
            ));
        }
        return Ok(());
    }

    if fs::read_dir(root)?.next().is_some() {
        return Err(AppError::Validation(format!(
            "目录“{}”非空且不是有效的数据目录；为避免覆盖，请选择其他空目录",
            root.display()
        )));
    }

    let marker = DataRootMarker {
        format_version: 1,
        instance_id: Uuid::new_v4().to_string(),
        created_by: env!("CARGO_PKG_VERSION").into(),
    };
    let temp_marker = root.join(format!(".vpr-data-root-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(&marker)?;
    {
        let mut file = File::create(&temp_marker)?;
        use std::io::Write;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    file_atomic::replace_file(&temp_marker, &marker_path)?;
    Ok(())
}

fn writable_probe(root: &Path) -> AppResult<()> {
    let probe = root.join(format!(".write-probe-{}", Uuid::new_v4()));
    let renamed = root.join(format!(".write-probe-renamed-{}", Uuid::new_v4()));
    {
        let file = File::create(&probe)?;
        file.sync_all()?;
    }
    fs::rename(&probe, &renamed)?;
    fs::remove_file(renamed)?;
    if fs2::available_space(root)? < 64 * 1024 * 1024 {
        return Err(AppError::Validation(
            "数据目录可用空间不足 64 MiB；请先释放空间或选择其他本地目录".into(),
        ));
    }
    Ok(())
}

fn initialization_lock(root: &Path) -> AppResult<File> {
    let local = env::var_os("LOCALAPPDATA")
        .ok_or_else(|| AppError::Validation("Windows LOCALAPPDATA 不可用".into()))?;
    let directory = PathBuf::from(local)
        .join("VibePromptRecorder")
        .join("initialization-locks");
    fs::create_dir_all(&directory)?;
    let digest = Sha256::digest(normalized_windows_path(root).as_bytes());
    let key: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(format!("{key}.lock")))?;
    file.try_lock_exclusive().map_err(|_| {
        AppError::Validation("该数据目录正在由另一个提示词记录工具实例初始化".into())
    })?;
    Ok(file)
}

fn acquire_instance_lock(root: &Path) -> AppResult<File> {
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("instance.lock"))?;
    lock_file
        .try_lock_exclusive()
        .map_err(|_| AppError::Validation("该数据目录正被另一个提示词记录工具实例使用".into()))?;
    Ok(lock_file)
}

fn prepare_root(root: PathBuf) -> AppResult<(PathBuf, File)> {
    let root = if root.is_absolute() {
        root
    } else {
        let executable = env::current_exe()?;
        executable
            .parent()
            .ok_or_else(|| AppError::Validation("无法确定程序目录".into()))?
            .join(root)
    };
    let root_text = root.to_string_lossy().replace('/', "\\").to_lowercase();
    let extended_unc = root_text.starts_with("\\\\?\\unc\\");
    let ordinary_unc = root_text.starts_with("\\\\")
        && !root_text.starts_with("\\\\?\\")
        && !root_text.starts_with("\\\\.\\");
    if extended_unc || ordinary_unc {
        return Err(AppError::Validation(
            "活动数据库不能放在 UNC 网络路径；备份和导出仍可选择网络位置".into(),
        ));
    }
    reject_remote_volume(&root)?;
    // 候选路径侧锁位于 LOCALAPPDATA，不会为了加锁而污染尚未验证的用户目录。
    let _initialization_lock = initialization_lock(&root)?;
    validate_or_create_marker(&root)?;
    writable_probe(&root)?;
    let root = fs::canonicalize(&root)?;
    let lock_file = acquire_instance_lock(&root)?;
    Ok((root, lock_file))
}

fn locator_path() -> AppResult<PathBuf> {
    let executable = env::current_exe()?;
    let executable_directory = executable
        .parent()
        .ok_or_else(|| AppError::Validation("无法确定程序目录".into()))?;
    let canonical = fs::canonicalize(executable_directory)
        .unwrap_or_else(|_| executable_directory.to_path_buf());
    let digest = Sha256::digest(canonical.to_string_lossy().to_lowercase().as_bytes());
    let key: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let local = env::var_os("LOCALAPPDATA")
        .ok_or_else(|| AppError::Validation("Windows LOCALAPPDATA 不可用".into()))?;
    Ok(PathBuf::from(local)
        .join("VibePromptRecorder")
        .join("locators")
        .join(format!("{key}.json")))
}

fn read_locator() -> AppResult<Option<PathBuf>> {
    let path = locator_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let locator: DataLocator = serde_json::from_slice(&fs::read(path)?)?;
    if locator.format_version != 1 || !locator.data_path.is_absolute() {
        return Err(AppError::Validation("便携数据定位文件无效".into()));
    }
    Ok(Some(locator.data_path))
}

fn write_locator(data_path: &Path) -> AppResult<()> {
    let path = locator_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Validation("数据定位文件没有父目录".into()))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".locator-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(&DataLocator {
        format_version: 1,
        data_path: data_path.to_path_buf(),
    })?;
    {
        let mut file = File::create(&temporary)?;
        use std::io::Write;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    file_atomic::replace_file(&temporary, &path)?;
    Ok(())
}

fn matches_uuid_temp_name(name: &str, prefix: &str, suffix: &str) -> bool {
    name.strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(suffix))
        .is_some_and(|value| Uuid::parse_str(value).is_ok())
}

fn clean_shutdown_temp_name(id: Uuid) -> String {
    format!("{CLEAN_SHUTDOWN_MARKER}-{id}.tmp")
}

fn cleanup_stale_clean_shutdown_temps(directory: &Path) -> AppResult<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if matches_uuid_temp_name(&name, ".vpr-clean-shutdown-", ".tmp") {
            fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn cleanup_webview2_caches(directory: &Path) -> AppResult<usize> {
    const CACHE_DIRECTORIES: &[&str] = &[
        "EBWebView/Crashpad",
        "EBWebView/GrShaderCache",
        "EBWebView/GPUPersistentCache",
        "EBWebView/Default/Cache",
        "EBWebView/Default/Code Cache",
        "EBWebView/Default/DawnGraphiteCache",
        "EBWebView/Default/DawnWebGPUCache",
        "EBWebView/Default/GPUCache",
        "EBWebView/Default/Shared Dictionary/cache",
    ];
    let mut removed = 0;
    for relative in CACHE_DIRECTORIES {
        let candidate = directory.join(relative);
        let metadata = match fs::symlink_metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        // 只删除固定层级上的真实目录；同名文件、链接和所有未知路径均保留。
        if metadata.file_type().is_dir() {
            fs::remove_dir_all(candidate)?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn cleanup_stale_temp_files(directory: &Path) -> AppResult<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let recognized = matches_uuid_temp_name(&name, "snapshot-", ".sqlite3")
            || matches_uuid_temp_name(&name, "read-snapshot-", ".sqlite3")
            || matches_uuid_temp_name(&name, "import-project-", "")
            || matches_uuid_temp_name(&name, "backup-fonts-", "")
            || matches_uuid_temp_name(&name, "removed-font-", ".tmp");
        if !recognized {
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

fn cleanup_stale_imported_font_temps(directory: &Path) -> AppResult<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name
            .strip_prefix(".import-")
            .and_then(|value| value.strip_suffix(".tmp"))
        else {
            continue;
        };
        if Uuid::parse_str(id).is_ok() {
            fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn choose_fallback_root() -> AppResult<(PathBuf, File)> {
    let selected = rfd::FileDialog::new()
        .set_title("选择提示词记录工具的本地数据目录")
        .pick_folder()
        .ok_or_else(|| AppError::Validation("尚未选择可保存数据的位置".into()))?;
    let candidate =
        if selected.join(MARKER_NAME).exists() || fs::read_dir(&selected)?.next().is_none() {
            selected
        } else {
            selected.join("提示词记录工具-data")
        };
    let (root, lock_file) = prepare_root(candidate)?;
    write_locator(&root)?;
    Ok((root, lock_file))
}

pub fn initialize() -> AppResult<DataPaths> {
    let (root, lock_file) = if let Some(requested) = requested_data_dir() {
        prepare_root(requested)?
    } else {
        let adjacent = adjacent_data_dir()?;
        match prepare_root(adjacent) {
            Ok(root) => root,
            Err(_adjacent_error) => match read_locator() {
                Ok(Some(located)) => match prepare_root(located) {
                    Ok(root) => root,
                    Err(_) => choose_fallback_root()?,
                },
                Ok(None) | Err(_) => choose_fallback_root()?,
            },
        }
    };

    let database = root.join("database");
    let clean_shutdown_marker = root.join(CLEAN_SHUTDOWN_MARKER);
    let unclean_start = database.join("app.sqlite3").is_file() && !clean_shutdown_marker.is_file();
    if clean_shutdown_marker.exists() {
        fs::remove_file(&clean_shutdown_marker)?;
    }
    if let Err(error) = cleanup_stale_clean_shutdown_temps(&root) {
        eprintln!("清理陈旧退出标记临时文件失败，已继续启动：{error}");
    }
    let backups_auto = root.join("backups").join("auto");
    let backups_manual = root.join("backups").join("manual");
    let recovery = root.join("recovery");
    let imported_fonts = root.join("fonts").join("imported");
    let logs = root.join("logs");
    let temp = root.join("temp");
    let webview2 = root.join("webview2");
    for directory in [
        &database,
        &backups_auto,
        &backups_manual,
        &recovery,
        &imported_fonts,
        &logs,
        &temp,
        &webview2,
    ] {
        fs::create_dir_all(directory)?;
    }
    // 单实例锁已经取得；这里只删除名称严格匹配的应用临时项，未知文件原样保留。
    if let Err(error) = cleanup_stale_temp_files(&temp) {
        eprintln!("清理陈旧临时文件失败，已继续启动：{error}");
    }
    if let Err(error) = cleanup_stale_imported_font_temps(&imported_fonts) {
        eprintln!("清理陈旧字体临时文件失败，已继续启动：{error}");
    }
    if let Err(error) = cleanup_webview2_caches(&webview2) {
        eprintln!("清理 WebView2 可再生缓存失败，已继续启动：{error}");
    }

    let in_sync_directory = detect_sync_directory(&root);
    Ok(DataPaths {
        root,
        database,
        backups_auto,
        backups_manual,
        recovery,
        imported_fonts,
        logs,
        temp,
        webview2,
        unclean_start,
        clean_shutdown_marker,
        in_sync_directory,
        _lock_file: lock_file,
    })
}

pub fn mark_clean_shutdown(paths: &DataPaths) -> AppResult<()> {
    let temporary = paths.root.join(clean_shutdown_temp_name(Uuid::new_v4()));
    struct TemporaryFile(PathBuf);
    impl Drop for TemporaryFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let _temporary_guard = TemporaryFile(temporary.clone());
    {
        use std::io::Write;
        let mut file = File::create(&temporary)?;
        file.write_all(b"v1\n")?;
        file.sync_all()?;
    }
    file_atomic::replace_file(&temporary, &paths.clean_shutdown_marker)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_rejects_non_empty_foreign_directory() {
        let temp = tempfile::tempdir().expect("temp dir");
        fs::write(temp.path().join("foreign.txt"), b"keep").expect("seed");
        let error = validate_or_create_marker(temp.path()).expect_err("must reject");
        assert!(error.to_string().contains("非空"));
        assert!(temp.path().join("foreign.txt").exists());
    }

    #[test]
    fn marker_creation_recovers_only_known_root_artifacts() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("data");
        fs::create_dir(&root).expect("root");
        fs::write(root.join(format!("{MARKER_NAME}.tmp")), b"stale").expect("legacy temp");
        fs::write(
            root.join(format!(".write-probe-{}", Uuid::new_v4())),
            b"stale",
        )
        .expect("probe");

        validate_or_create_marker(&root).expect("recover marker");
        assert!(root.join(MARKER_NAME).is_file());
    }

    #[test]
    fn extended_paths_are_normalized_for_sync_detection() {
        let normalized = normalized_windows_path(Path::new(r"\\?\C:\Users\<USER>\OneDrive\data"));
        assert_eq!(normalized, r"c:\users\<user>\onedrive\data");
        let unc = normalized_windows_path(Path::new(r"\\?\UNC\server\share\data"));
        assert_eq!(unc, r"\\server\share\data");
    }

    #[cfg(windows)]
    #[test]
    fn windows_volume_root_handles_normal_and_verbatim_drive_paths() {
        assert_eq!(
            windows_volume_root(Path::new(r"C:\portable\data")).as_deref(),
            Some(r"C:\")
        );
        assert_eq!(
            windows_volume_root(Path::new(r"\\?\Z:\portable\data")).as_deref(),
            Some(r"Z:\")
        );
        assert!(windows_volume_root(Path::new(r"\\server\share\data")).is_none());
    }

    #[test]
    fn webview_cache_cleanup_removes_only_fixed_real_directories() {
        let temp = tempfile::tempdir().expect("temp");
        let webview = temp.path().join("webview2");
        let cache = webview.join("EBWebView/Default/Cache");
        let preferences = webview.join("EBWebView/Default/Preferences");
        let unknown = webview.join("EBWebView/Default/FutureCache");
        fs::create_dir_all(&cache).expect("cache");
        fs::create_dir_all(&unknown).expect("unknown");
        fs::write(&preferences, b"keep").expect("preferences");
        fs::write(cache.join("entry"), b"cache").expect("cache entry");

        assert_eq!(cleanup_webview2_caches(&webview).expect("cleanup"), 1);
        assert!(!cache.exists());
        assert!(preferences.is_file());
        assert!(unknown.is_dir());
    }

    #[test]
    fn marker_round_trip_supports_chinese_and_spaces() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("中文 data 空格");
        validate_or_create_marker(&root).expect("create marker");
        validate_or_create_marker(&root).expect("read marker");
        assert!(root.join(MARKER_NAME).exists());
    }

    #[test]
    fn stale_temp_cleanup_only_removes_recognized_uuid_items() {
        let temp = tempfile::tempdir().expect("temp dir");
        let id = Uuid::new_v4();
        fs::write(temp.path().join(format!("snapshot-{id}.sqlite3")), b"stale").expect("snapshot");
        fs::create_dir(temp.path().join(format!("backup-fonts-{id}"))).expect("fonts temp");
        fs::write(temp.path().join("keep-me.txt"), b"keep").expect("unknown");

        assert_eq!(cleanup_stale_temp_files(temp.path()).expect("cleanup"), 2);
        assert!(temp.path().join("keep-me.txt").is_file());
    }

    #[test]
    fn clean_shutdown_temp_cleanup_uses_one_dot_and_preserves_unknown_files() {
        let temp = tempfile::tempdir().expect("temp dir");
        let recognized = clean_shutdown_temp_name(Uuid::new_v4());
        assert!(recognized.starts_with(".vpr-clean-shutdown-"));
        assert!(!recognized.starts_with(".."));
        fs::write(temp.path().join(&recognized), b"stale").expect("recognized");
        fs::write(temp.path().join("..vpr-clean-shutdown-legacy.tmp"), b"keep").expect("unknown");
        fs::write(
            temp.path().join(".vpr-clean-shutdown-not-a-uuid.tmp"),
            b"keep",
        )
        .expect("invalid");

        assert_eq!(
            cleanup_stale_clean_shutdown_temps(temp.path()).expect("cleanup"),
            1
        );
        assert!(!temp.path().join(recognized).exists());
        assert!(
            temp.path()
                .join("..vpr-clean-shutdown-legacy.tmp")
                .is_file()
        );
        assert!(
            temp.path()
                .join(".vpr-clean-shutdown-not-a-uuid.tmp")
                .is_file()
        );
    }

    #[test]
    fn marker_supports_paths_longer_than_legacy_max_path() {
        let temp = tempfile::tempdir().expect("temp dir");
        let mut root = temp.path().to_path_buf();
        for index in 0..8 {
            root.push(format!("中文长路径段-{index}-abcdefghijklmnopqrstuvwxyz"));
        }
        assert!(root.as_os_str().to_string_lossy().len() > 260);
        validate_or_create_marker(&root).expect("create long-path marker");
        validate_or_create_marker(&root).expect("read long-path marker");
    }

    #[test]
    fn data_dir_argument_supports_split_and_equals_forms() {
        let split = vec!["app.exe".into(), "--data-dir".into(), "相对 data".into()];
        assert_eq!(data_dir_from_args(&split), Some(PathBuf::from("相对 data")));
        let equals = vec!["app.exe".into(), "--data-dir=D:\\便携 数据".into()];
        assert_eq!(
            data_dir_from_args(&equals),
            Some(PathBuf::from("D:\\便携 数据"))
        );
    }
}
