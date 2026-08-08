use std::{fs, path::PathBuf};
use tauri::http;

const CORE_FONTS: &[&str] = &[
    "MiSans-Normal.ttf",
    "MiSans-Medium.ttf",
    "MiSans-Semibold.ttf",
    "MiSans-Bold.ttf",
    "HarmonyOS-Sans-SC-Regular.ttf",
    "HarmonyOS-Sans-SC-Medium.ttf",
    "HarmonyOS-Sans-SC-Bold.ttf",
    "Mona-Sans.woff2",
    "Sarasa-Mono-SC-Regular.ttf",
    "Sarasa-Mono-SC-Bold.ttf",
];

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
            "public, max-age=31536000, immutable",
        )
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| http::Response::new(Vec::new()))
}

fn font_path(file_name: &str) -> Option<PathBuf> {
    let executable_path = std::env::current_exe()
        .ok()?
        .parent()?
        .join("resources")
        .join("fonts")
        .join("core")
        .join(file_name);
    if executable_path.is_file() {
        return Some(executable_path);
    }
    if cfg!(debug_assertions) {
        let development_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()?
            .join("public")
            .join("fonts")
            .join(file_name);
        if development_path.is_file() {
            return Some(development_path);
        }
    }
    None
}

pub fn protocol_response<R: tauri::Runtime>(
    _context: tauri::UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let Some(file_name) = request.uri().path().strip_prefix("/fonts/") else {
        return response(
            http::StatusCode::BAD_REQUEST,
            "text/plain; charset=utf-8",
            b"invalid asset path".to_vec(),
        );
    };
    if !CORE_FONTS.contains(&file_name) {
        return response(
            http::StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"asset not found".to_vec(),
        );
    }
    let Some(path) = font_path(file_name) else {
        return response(
            http::StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"asset file missing".to_vec(),
        );
    };
    let Ok(bytes) = fs::read(path) else {
        return response(
            http::StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"asset file unreadable".to_vec(),
        );
    };
    let content_type = if file_name.ends_with(".woff2") {
        "font/woff2"
    } else {
        "font/ttf"
    };
    response(http::StatusCode::OK, content_type, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_asset_allowlist_has_no_paths_or_duplicates() {
        let mut sorted = CORE_FONTS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), CORE_FONTS.len());
        assert!(CORE_FONTS.iter().all(|name| {
            !name.contains('/') && !name.contains('\\') && (*name).split('.').count() == 2
        }));
    }
}
