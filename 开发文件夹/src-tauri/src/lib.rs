mod archive;
mod commands;
mod core_assets;
mod db;
mod diagnostics;
mod error;
mod file_atomic;
mod fonts;
mod markdown_io;
mod models;
mod paths;
mod remote_images;

use parking_lot::Mutex;
use rusqlite::Connection;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tauri::Manager;

#[cfg(windows)]
fn webview2_registry_available() -> bool {
    use winreg::{RegKey, enums::*};

    const CLIENT: &str =
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    for hive in [
        RegKey::predef(HKEY_LOCAL_MACHINE),
        RegKey::predef(HKEY_CURRENT_USER),
    ] {
        for view in [KEY_WOW64_32KEY, KEY_WOW64_64KEY] {
            if let Ok(key) = hive.open_subkey_with_flags(CLIENT, KEY_READ | view)
                && let Ok(version) = key.get_value::<String, _>("pv")
                && !version.trim().is_empty()
                && version.trim() != "0.0.0.0"
            {
                return true;
            }
        }
    }
    false
}

#[cfg(windows)]
fn webview2_available() -> bool {
    if webview2_registry_available() {
        return true;
    }
    let mut roots = Vec::new();
    if let Some(explicit) = std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER") {
        roots.push(std::path::PathBuf::from(explicit));
    }
    for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(program_files) = std::env::var_os(variable) {
            roots.push(
                std::path::PathBuf::from(program_files)
                    .join("Microsoft")
                    .join("EdgeWebView")
                    .join("Application"),
            );
        }
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        roots.push(
            std::path::PathBuf::from(local_app_data)
                .join("Microsoft")
                .join("EdgeWebView")
                .join("Application"),
        );
    }
    roots.into_iter().any(|root| {
        root.join("msedgewebview2.exe").is_file()
            || std::fs::read_dir(&root).is_ok_and(|entries| {
                entries
                    .flatten()
                    .any(|entry| entry.path().join("msedgewebview2.exe").is_file())
            })
    })
}

#[cfg(not(windows))]
fn webview2_available() -> bool {
    true
}

fn native_error(title: &str, description: &str) {
    let _ = rfd::MessageDialog::new()
        .set_title(title)
        .set_description(description)
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

fn native_info(title: &str, description: &str) {
    let _ = rfd::MessageDialog::new()
        .set_title(title)
        .set_description(description)
        .set_level(rfd::MessageLevel::Info)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

fn restored_axis(
    saved_coordinate: i32,
    monitor_origin: i32,
    work_origin: i32,
    work_extent: u32,
    logical_window_extent: f64,
    saved_scale: f64,
    current_scale: f64,
) -> i32 {
    let relative = f64::from(saved_coordinate.saturating_sub(monitor_origin)) / saved_scale;
    let desired = work_origin.saturating_add((relative * current_scale).round() as i32);
    let physical_window_extent = (logical_window_extent * current_scale).round() as i32;
    let minimum = work_origin.saturating_sub(physical_window_extent.saturating_sub(80));
    let maximum = work_origin
        .saturating_add(work_extent as i32)
        .saturating_sub(80);
    desired.clamp(minimum, maximum)
}

fn restore_window_state(
    window: &tauri::WebviewWindow,
    state: &models::WindowState,
) -> tauri::Result<()> {
    use tauri::{LogicalSize, PhysicalPosition};

    let saved_scale = state.scale_factor.clamp(0.5, 8.0);
    let logical_width = f64::from(state.width) / saved_scale;
    let logical_height = f64::from(state.height) / saved_scale;
    window.set_size(LogicalSize::new(logical_width, logical_height))?;

    let monitors = window.available_monitors()?;
    let target_monitor = state
        .monitor_name
        .as_ref()
        .and_then(|name| {
            monitors
                .iter()
                .find(|monitor| monitor.name().is_some_and(|current| current == name))
        })
        .or_else(|| {
            monitors.iter().find(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                state.x >= position.x
                    && state.y >= position.y
                    && state.x < position.x.saturating_add(size.width as i32)
                    && state.y < position.y.saturating_add(size.height as i32)
            })
        });
    if let Some(monitor) = target_monitor {
        let current_scale = monitor.scale_factor().clamp(0.5, 8.0);
        let work = monitor.work_area();
        window.set_position(PhysicalPosition::new(
            restored_axis(
                state.x,
                monitor.position().x,
                work.position.x,
                work.size.width,
                logical_width,
                saved_scale,
                current_scale,
            ),
            restored_axis(
                state.y,
                monitor.position().y,
                work.position.y,
                work.size.height,
                logical_height,
                saved_scale,
                current_scale,
            ),
        ))?;
    } else {
        window.center()?;
    }
    if state.maximized {
        window.maximize()?;
    }
    Ok(())
}

#[derive(Default)]
struct CleanShutdownIntent {
    requested_generation: AtomicU64,
    cancelled_generation: AtomicU64,
}

impl CleanShutdownIntent {
    fn request(&self, generation: u64) {
        self.requested_generation
            .fetch_max(generation, Ordering::AcqRel);
    }

    fn cancel(&self, generation: u64) {
        self.cancelled_generation
            .fetch_max(generation, Ordering::AcqRel);
    }

    fn take_authorized(&self) -> bool {
        let requested = self.requested_generation.swap(0, Ordering::AcqRel);
        requested != 0 && requested > self.cancelled_generation.load(Ordering::Acquire)
    }
}

pub struct AppState {
    db: Arc<Mutex<Connection>>,
    font_operations: Mutex<()>,
    clean_shutdown: CleanShutdownIntent,
    paths: paths::DataPaths,
}

pub fn run() {
    let runtime_log_directory = Arc::new(Mutex::new(None::<std::path::PathBuf>));
    let setup_log_directory = Arc::clone(&runtime_log_directory);
    let builder = tauri::Builder::default()
        .register_uri_scheme_protocol("vprasset", core_assets::protocol_response)
        .register_uri_scheme_protocol("vprfont", fonts::protocol_response)
        .plugin(tauri_plugin_single_instance::init(|app, arguments, _cwd| {
            if arguments.iter().any(|argument| {
                argument == "--data-dir" || argument.starts_with("--data-dir=")
            }) {
                native_info(
                    "数据目录未切换",
                    "提示词记录工具已在运行。第二次启动携带的 --data-dir 不会切换当前实例；请先安全关闭现有窗口，再使用目标数据目录启动。",
                );
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let state = window.state::<AppState>();
            // 只有正常关闭状态机明确授权、且窗口确实已销毁后才写 clean 标记。
            // 强退和销毁失败都不会提前留下“正常退出”的假标记。
            if state.clean_shutdown.take_authorized()
                && let Err(error) = paths::mark_clean_shutdown(&state.paths)
            {
                diagnostics::log_runtime_error(
                    &state.paths.logs,
                    &format!("窗口已关闭，但 clean-shutdown 标记写入失败：{error}"),
                );
            }
        })
        .setup(move |app| {
            if !webview2_available() {
                let message = "缺少 Microsoft Edge WebView2 Runtime。程序尚未读取或创建项目数据，也不会联网下载组件。请安装受支持的 WebView2 Runtime 后重新打开。";
                native_error("提示词记录工具无法启动", message);
                return Err(message.into());
            }
            let data_paths = match paths::initialize() {
                Ok(paths) => paths,
                Err(error) => {
                    let message = format!("无法安全打开便携数据目录：\n\n{error}");
                    native_error("提示词记录工具无法启动", &message);
                    return Err(message.into());
                }
            };
            *setup_log_directory.lock() = Some(data_paths.logs.clone());
            diagnostics::install_panic_hook(&data_paths.logs);
            // 启动期的恢复切换 / 打开数据库 / 读取设置若失败，必须给出原生中文说明再退出，
            // 而不是静默 panic（发布版无控制台）。原始数据保持不变，用户可据此从备份恢复。
            match archive::apply_pending_restore(&data_paths) {
                Ok(Some(message)) => native_info("备份恢复状态", &message),
                Ok(None) => {}
                Err(error) => {
                    let message = format!(
                        "上次的备份恢复切换未能完成，原始数据没有被覆盖。\n\n{error}\n\n请勿手动删除 data/recovery 下的文件；可重新打开程序重试，或从备份恢复。"
                    );
                    diagnostics::log_runtime_error(&data_paths.logs, &message);
                    native_error("提示词记录工具无法启动", &message);
                    return Err(message.into());
                }
            }
            if let Err(error) = archive::cleanup_stale_recovery_artifacts(&data_paths) {
                let message = format!("陈旧恢复工作目录清理失败，已继续启动：{error}");
                diagnostics::log_runtime_error(&data_paths.logs, &message);
                native_info("恢复目录清理提醒", &message);
            }
            let database_path = data_paths.database.join("app.sqlite3");
            let connection = match db::open_managed(
                &database_path,
                Some(&data_paths.recovery),
                data_paths.unclean_start,
            ) {
                Ok(connection) => connection,
                Err(error) => {
                    let message = format!(
                        "数据库未能安全打开，程序没有创建空库覆盖现场。\n\n{error}\n\n请保留整个 data 目录（尤其 database、backups、recovery），并从已校验的备份恢复。"
                    );
                    diagnostics::log_runtime_error(&data_paths.logs, &message);
                    native_error("提示词记录工具无法启动", &message);
                    return Err(message.into());
                }
            };
            if let Err(error) = fonts::reconcile_imported_fonts(
                &connection,
                &data_paths.imported_fonts,
                true,
            ) {
                let message = format!("用户字体登记对账失败，已继续启动：{error}");
                diagnostics::log_runtime_error(&data_paths.logs, &message);
                native_info("字体状态提醒", &message);
            }
            let settings = match db::recover_settings_or_default(&connection) {
                Ok((settings, warning)) => {
                    if let Some(reason) = warning {
                        let message = format!(
                            "已保存的应用设置无效，原始 JSON 已备份并使用默认设置继续启动。项目内容没有受到影响。\n\n{reason}"
                        );
                        diagnostics::log_runtime_error(&data_paths.logs, &message);
                        native_info("应用设置已安全重置", &message);
                    }
                    settings
                }
                Err(error) => {
                    let message = format!("读取应用设置失败，数据未被修改：\n\n{error}");
                    diagnostics::log_runtime_error(&data_paths.logs, &message);
                    native_error("提示词记录工具无法启动", &message);
                    return Err(message.into());
                }
            };
            let window_state = match db::load_window_state(&connection) {
                Ok(state) => state,
                Err(error) => {
                    let message = format!(
                        "已保存的窗口布局无效，已使用默认位置和尺寸继续启动。项目内容没有受到影响。\n\n{error}"
                    );
                    diagnostics::log_runtime_error(&data_paths.logs, &message);
                    native_info("窗口布局已重置", &message);
                    None
                }
            };
            let webview_data_directory = data_paths.webview2.clone();
            app.manage(AppState {
                db: Arc::new(Mutex::new(connection)),
                font_operations: Mutex::new(()),
                clean_shutdown: CleanShutdownIntent::default(),
                paths: data_paths,
            });
            let window = match tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("提示词记录工具")
            .inner_size(1440.0, 860.0)
            .min_inner_size(680.0, 520.0)
            .resizable(true)
            .decorations(false)
            .center()
            .visible(false)
            .devtools(false)
            .data_directory(webview_data_directory)
            .build()
            {
                Ok(window) => window,
                Err(error) => {
                    native_error(
                        "提示词记录工具无法创建窗口",
                        &format!("WebView2 窗口创建失败，项目数据没有被改写：\n\n{error}"),
                    );
                    return Err(error.into());
                }
            };
            window.set_always_on_top(settings.always_on_top)?;
            if let Some(window_state) = window_state
                && let Err(error) = restore_window_state(&window, &window_state)
            {
                let message = format!("窗口布局恢复失败，已继续使用默认布局：{error}");
                diagnostics::log_runtime_error(&window.app_handle().state::<AppState>().paths.logs, &message);
                native_info("窗口布局已重置", &message);
            }
            window.show()?;
            window.set_focus()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::create_project,
            commands::rename_project,
            commands::toggle_project_pin,
            commands::open_project,
            commands::delete_project,
            commands::restore_project,
            commands::list_projects,
            commands::list_rounds,
            commands::get_round,
            commands::save_round,
            commands::resolve_conflict_keep_both,
            commands::resolve_conflict_replace_local,
            commands::finalize_draft,
            commands::delete_round,
            commands::restore_round,
            commands::reorder_rounds,
            commands::search_all,
            commands::save_settings,
            commands::get_view_state,
            commands::save_view_state,
            commands::list_trash,
            commands::permanently_delete,
            commands::set_always_on_top,
            commands::database_health,
            commands::fetch_remote_image,
            commands::export_project_package,
            commands::import_project_package,
            commands::create_manual_backup,
            commands::prepare_backup_restore,
            commands::cancel_prepared_restore,
            commands::run_auto_backup,
            commands::list_fonts,
            commands::import_font_files,
            commands::remove_imported_font,
            commands::export_project_markdown,
            commands::export_all_markdown,
            commands::import_markdown,
            commands::save_window_state,
            commands::mark_clean_shutdown,
            commands::cancel_clean_shutdown,
            commands::save_text_file,
        ]);

    if let Err(error) = builder.run(tauri::generate_context!()) {
        let message = format!("应用运行时发生错误，项目数据不会因此被主动清空：{error}");
        if let Some(directory) = runtime_log_directory.lock().as_ref() {
            diagnostics::log_runtime_error(directory, &message);
        }
        native_error("提示词记录工具意外退出", &message);
        eprintln!("提示词记录工具运行失败：{error}");
    }
}

#[cfg(test)]
mod window_state_tests {
    use super::{CleanShutdownIntent, restored_axis};

    #[test]
    fn cross_dpi_restore_preserves_logical_offset_and_keeps_window_reachable() {
        assert_eq!(restored_axis(300, 0, 0, 1920, 800.0, 1.5, 1.25), 250);
        assert_eq!(restored_axis(-20_000, 0, 0, 1920, 800.0, 1.0, 1.25), -920);
        assert_eq!(restored_axis(20_000, 0, 0, 1920, 800.0, 1.0, 1.25), 1840);
    }

    #[test]
    fn cancelled_close_generation_cannot_be_revived_by_a_late_request() {
        let intent = CleanShutdownIntent::default();
        intent.cancel(1);
        intent.request(1);
        assert!(!intent.take_authorized());

        intent.request(2);
        intent.cancel(1);
        assert!(intent.take_authorized());
    }
}
