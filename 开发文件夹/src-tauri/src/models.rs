use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub is_pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_opened_at: i64,
    pub round_count: i64,
    pub has_draft: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundSummary {
    pub id: String,
    pub project_id: String,
    pub position: i64,
    pub status: String,
    pub preview_md: String,
    pub created_at: i64,
    pub finalized_at: Option<i64>,
    pub updated_at: i64,
    pub revision: i64,
    pub note: String,
    pub char_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundDetail {
    pub id: String,
    pub project_id: String,
    pub position: i64,
    pub status: String,
    pub content_md: String,
    pub created_at: i64,
    pub finalized_at: Option<i64>,
    pub updated_at: i64,
    pub revision: i64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRoundResult {
    pub revision: i64,
    pub saved_at: i64,
    /// 保存后数据库估算字节数，用于前端刷新容量提醒。
    pub database_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeResult {
    pub finalized_round: RoundDetail,
    pub draft: RoundDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub project_id: String,
    pub project_name: String,
    pub round_id: String,
    pub status: String,
    pub position: i64,
    pub note: String,
    pub excerpt: String,
    pub match_start: i64,
    pub match_end: i64,
    pub match_field: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub project_id: Option<String>,
    pub deleted_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFaceInfo {
    pub id: String,
    pub family: String,
    pub source: String,
    pub is_monospace: bool,
    pub weights: Vec<i32>,
    pub available: bool,
    pub url: Option<String>,
    pub removable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct AppSettings {
    pub format_version: u32,
    pub theme: String,
    pub preview_lines: i32,
    pub show_round_numbers: bool,
    pub default_editor_mode: String,
    pub always_on_top: bool,
    pub code_wrap: bool,
    pub ui_font_family: String,
    pub ui_font_size: i32,
    pub ui_font_weight: i32,
    pub body_font_family: String,
    pub body_font_size: i32,
    pub body_font_weight: i32,
    pub body_line_height: f64,
    pub code_font_family: String,
    pub code_font_size: i32,
    pub code_font_weight: i32,
    pub code_line_height: f64,
    pub ui_fallback_families: Vec<String>,
    pub body_fallback_families: Vec<String>,
    pub code_fallback_families: Vec<String>,
    pub favorite_font_ids: Vec<String>,
    pub recent_font_ids: Vec<String>,
    pub project_panel_width: i32,
    pub timeline_panel_width: i32,
    pub auto_backup: bool,
    pub last_project_id: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            format_version: 1,
            theme: "neutral".into(),
            preview_lines: 5,
            show_round_numbers: true,
            default_editor_mode: "wysiwyg".into(),
            always_on_top: false,
            code_wrap: false,
            ui_font_family: "MiSans".into(),
            ui_font_size: 14,
            ui_font_weight: 400,
            body_font_family: "MiSans".into(),
            body_font_size: 16,
            body_font_weight: 400,
            body_line_height: 1.65,
            code_font_family: "Sarasa Mono SC".into(),
            code_font_size: 14,
            code_font_weight: 400,
            code_line_height: 1.55,
            ui_fallback_families: vec![
                "Segoe UI Variable Text".into(),
                "Segoe UI".into(),
                "Microsoft YaHei UI".into(),
                "Segoe UI Emoji".into(),
            ],
            body_fallback_families: vec![
                "HarmonyOS Sans SC".into(),
                "Microsoft YaHei".into(),
                "Segoe UI Emoji".into(),
            ],
            code_fallback_families: vec![
                "Cascadia Mono".into(),
                "Consolas".into(),
                "Microsoft YaHei UI".into(),
                "Segoe UI Emoji".into(),
            ],
            favorite_font_ids: Vec::new(),
            recent_font_ids: Vec::new(),
            project_panel_width: 236,
            timeline_panel_width: 340,
            auto_backup: true,
            last_project_id: None,
        }
    }
}

#[derive(Debug, Default)]
pub enum NullablePatch<T> {
    #[default]
    Unset,
    Value(T),
    Null,
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for NullablePatch<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<T>::deserialize(deserializer).map(|value| match value {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AppSettingsPatch {
    pub theme: Option<String>,
    pub preview_lines: Option<i32>,
    pub show_round_numbers: Option<bool>,
    pub default_editor_mode: Option<String>,
    pub always_on_top: Option<bool>,
    pub code_wrap: Option<bool>,
    pub ui_font_family: Option<String>,
    pub ui_font_size: Option<i32>,
    pub ui_font_weight: Option<i32>,
    pub body_font_family: Option<String>,
    pub body_font_size: Option<i32>,
    pub body_font_weight: Option<i32>,
    pub body_line_height: Option<f64>,
    pub code_font_family: Option<String>,
    pub code_font_size: Option<i32>,
    pub code_font_weight: Option<i32>,
    pub code_line_height: Option<f64>,
    pub ui_fallback_families: Option<Vec<String>>,
    pub body_fallback_families: Option<Vec<String>>,
    pub code_fallback_families: Option<Vec<String>>,
    pub favorite_font_ids: Option<Vec<String>>,
    pub recent_font_ids: Option<Vec<String>>,
    pub project_panel_width: Option<i32>,
    pub timeline_panel_width: Option<i32>,
    pub auto_backup: Option<bool>,
    pub last_project_id: NullablePatch<String>,
}

impl AppSettingsPatch {
    pub fn apply(self, settings: &mut AppSettings) {
        macro_rules! assign {
            ($($field:ident),+ $(,)?) => {
                $(if let Some(value) = self.$field { settings.$field = value; })+
            };
        }
        assign!(
            theme,
            preview_lines,
            show_round_numbers,
            default_editor_mode,
            always_on_top,
            code_wrap,
            ui_font_family,
            ui_font_size,
            ui_font_weight,
            body_font_family,
            body_font_size,
            body_font_weight,
            body_line_height,
            code_font_family,
            code_font_size,
            code_font_weight,
            code_line_height,
            ui_fallback_families,
            body_fallback_families,
            code_fallback_families,
            favorite_font_ids,
            recent_font_ids,
            project_panel_width,
            timeline_panel_width,
            auto_backup,
        );
        match self.last_project_id {
            NullablePatch::Unset => {}
            NullablePatch::Value(value) => settings.last_project_id = Some(value),
            NullablePatch::Null => settings.last_project_id = None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectViewState {
    pub project_id: String,
    pub selected_round_id: Option<String>,
    pub timeline_anchor_round_id: Option<String>,
    pub anchor_offset_px: f64,
    pub editor_mode: String,
    pub cursor_anchor: i64,
    pub cursor_head: i64,
    pub detail_open: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapData {
    pub projects: Vec<ProjectSummary>,
    pub settings: AppSettings,
    pub selected_project_id: Option<String>,
    pub data_dir: String,
    pub app_version: String,
    pub fts_enabled: bool,
    pub fonts: Vec<FontFaceInfo>,
    /// 当前数据库估算字节数，用于前端展示 7.5 GiB 容量提醒。
    pub database_bytes: i64,
    /// 软提示阈值（字节）。
    pub database_warn_bytes: i64,
    /// 硬上限（字节）。
    pub database_limit_bytes: i64,
    /// 数据目录位于云同步目录内，前端一次性提醒可能与数据库文件冲突。
    pub data_in_sync_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub byte_count: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub created_at: i64,
    pub byte_count: u64,
    pub sha256: String,
    pub includes_fonts: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreparation {
    pub restore_id: String,
    pub backup_path: String,
    pub recovery_point_path: String,
    pub requires_restart: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteImageData {
    pub data_url: String,
    pub byte_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    pub scale_factor: f64,
    pub monitor_name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{AppSettings, AppSettingsPatch};

    #[test]
    fn new_install_uses_the_blue_white_theme() {
        assert_eq!(AppSettings::default().theme, "neutral");
    }

    #[test]
    fn older_settings_json_gains_new_font_preferences_without_resetting_existing_values() {
        let settings: AppSettings = serde_json::from_str(r#"{"theme":"warm","bodyFontSize":19}"#)
            .expect("deserialize old settings");
        assert_eq!(settings.format_version, 1);
        assert_eq!(settings.theme, "warm");
        assert_eq!(settings.body_font_size, 19);
        assert!(!settings.ui_fallback_families.is_empty());
        assert!(settings.favorite_font_ids.is_empty());
    }

    #[test]
    fn settings_patch_changes_only_present_fields_and_rejects_unknown_fields() {
        let mut settings = AppSettings {
            body_font_size: 19,
            ..AppSettings::default()
        };
        let patch: AppSettingsPatch =
            serde_json::from_str(r#"{"theme":"warm","lastProjectId":null}"#).expect("patch");
        patch.apply(&mut settings);
        assert_eq!(settings.theme, "warm");
        assert_eq!(settings.body_font_size, 19);
        assert_eq!(settings.last_project_id, None);
        assert!(serde_json::from_str::<AppSettingsPatch>(r#"{"unknown":true}"#).is_err());
    }
}
