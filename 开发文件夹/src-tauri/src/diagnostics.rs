use chrono::Utc;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    panic::PanicHookInfo,
    path::Path,
};

const MAX_LOG_BYTES: u64 = 1024 * 1024;
const MAX_MESSAGE_CHARS: usize = 2_000;

fn normalized_message(message: &str) -> String {
    message
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .map(|character| match character {
            '\r' | '\n' | '\t' => ' ',
            value if value.is_control() => '�',
            value => value,
        })
        .collect()
}

fn rotate_if_needed(path: &Path) -> io::Result<()> {
    if fs::metadata(path).map_or(0, |metadata| metadata.len()) < MAX_LOG_BYTES {
        return Ok(());
    }
    let previous = path.with_extension("log.1");
    if previous.exists() {
        fs::remove_file(&previous)?;
    }
    fs::rename(path, previous)
}

fn append_line(log_directory: &Path, kind: &str, message: &str) -> io::Result<()> {
    fs::create_dir_all(log_directory)?;
    let path = log_directory.join("crash.log");
    rotate_if_needed(&path)?;
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(
        file,
        "{} [{}] {}",
        Utc::now().to_rfc3339(),
        kind,
        normalized_message(message)
    )?;
    file.flush()
}

fn panic_location(info: &PanicHookInfo<'_>) -> String {
    info.location().map_or_else(
        || "location=unknown".into(),
        |location| {
            format!(
                "location={}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
        },
    )
}

pub fn install_panic_hook(log_directory: &Path) {
    let directory = log_directory.to_path_buf();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 不记录 panic payload，避免第三方依赖把编辑正文或其他用户内容带入日志。
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        let message = format!(
            "version={} thread={} {}",
            env!("CARGO_PKG_VERSION"),
            thread,
            panic_location(info)
        );
        let _ = append_line(&directory, "panic", &message);
        previous(info);
    }));
}

pub fn log_runtime_error(log_directory: &Path, message: &str) {
    let _ = append_line(log_directory, "runtime-error", message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_log_is_local_bounded_and_single_line() {
        let temp = tempfile::tempdir().expect("temp");
        append_line(temp.path(), "test", "第一行\n第二行\0").expect("append");
        let content = fs::read_to_string(temp.path().join("crash.log")).expect("log");
        assert!(content.contains("[test] 第一行 第二行�"));
        assert_eq!(content.lines().count(), 1);
    }
}
