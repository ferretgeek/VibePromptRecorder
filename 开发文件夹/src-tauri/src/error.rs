use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("数据库操作失败：{0}")]
    Database(#[from] rusqlite::Error),
    #[error("文件操作失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("数据格式无效：{0}")]
    Json(#[from] serde_json::Error),
    #[error("归档处理失败：{0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("{0}")]
    Validation(String),
    #[error("REVISION_CONFLICT:{0}")]
    RevisionConflict(String),
    #[error("未找到：{0}")]
    NotFound(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let public_message = match self {
            Self::Database(_) => "DATABASE_ERROR:数据库操作失败，请重试",
            Self::Io(_) => "FILE_ERROR:文件操作失败，请检查文件是否被占用或磁盘空间是否充足",
            Self::Json(_) => "DATA_FORMAT_ERROR:数据格式无效或文件已损坏",
            Self::Zip(_) => "ARCHIVE_ERROR:归档文件无效、已损坏或不受支持",
            // 业务错误不包含底层路径或数据库实现细节，并且冲突前缀需保持现有前端兼容。
            Self::Validation(_) | Self::RevisionConflict(_) | Self::NotFound(_) => {
                return serializer.serialize_str(&self.to_string());
            }
        };
        serializer.serialize_str(public_message)
    }
}

#[cfg(test)]
mod tests {
    use super::AppError;

    #[test]
    fn serialized_io_error_does_not_expose_local_path() {
        let error = AppError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            r"C:\Users\<USER>\example.db",
        ));
        let serialized = serde_json::to_string(&error).expect("serialize error");
        assert!(serialized.contains("FILE_ERROR"));
        assert!(!serialized.contains("<USER>"));
        assert!(!serialized.contains("example.db"));
    }

    #[test]
    fn revision_conflict_protocol_remains_compatible() {
        let error = AppError::RevisionConflict("round-1".to_string());
        assert_eq!(
            serde_json::to_string(&error).expect("serialize error"),
            "\"REVISION_CONFLICT:round-1\""
        );
    }
}
