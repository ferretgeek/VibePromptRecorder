use std::{fs, io, path::Path};

/// 将同目录内、已经完整写入并同步的临时文件发布到目标路径。
///
/// Windows 的 `rename` 不能覆盖现有文件，因此直接调用系统的 ReplaceFileW；
/// 它不会先让目标路径消失。其他平台使用同文件系统内的原子 rename。
pub fn replace_file(temporary: &Path, target: &Path) -> io::Result<()> {
    if target.exists() {
        replace_existing(temporary, target)?;
    } else {
        match fs::rename(temporary, target) {
            Ok(()) => {}
            Err(_error) if target.exists() => replace_existing(temporary, target)?,
            Err(error) => return Err(error),
        }
    }
    sync_parent_best_effort(target);
    Ok(())
}

#[cfg(windows)]
fn replace_existing(temporary: &Path, target: &Path) -> io::Result<()> {
    use std::{iter, os::windows::ffi::OsStrExt, ptr};

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        #[link_name = "ReplaceFileW"]
        fn replace_file_w(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut core::ffi::c_void,
            reserved: *mut core::ffi::c_void,
        ) -> i32;
    }

    const REPLACEFILE_WRITE_THROUGH: u32 = 0x0000_0001;
    let target_wide = target
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both paths are stable, nul-terminated UTF-16 buffers for the duration
    // of the call; optional pointer parameters are intentionally null.
    let result = unsafe {
        replace_file_w(
            target_wide.as_ptr(),
            temporary_wide.as_ptr(),
            ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_existing(temporary: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temporary, target)
}

#[cfg(windows)]
fn sync_parent_best_effort(path: &Path) {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    if let Some(parent) = path.parent()
        && let Ok(directory) = OpenOptions::new()
            .access_mode(0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(parent)
    {
        let _ = directory.sync_all();
    }
}

#[cfg(not(windows))]
fn sync_parent_best_effort(path: &Path) {
    if let Some(parent) = path.parent()
        && let Ok(directory) = std::fs::File::open(parent)
    {
        let _ = directory.sync_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_existing_file_without_losing_new_content() {
        let directory = tempfile::tempdir().expect("temp directory");
        let target = directory.path().join("target.txt");
        let temporary = directory.path().join(".target.tmp");
        fs::write(&target, b"old").expect("old");
        fs::write(&temporary, b"new").expect("new");
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&temporary)
            .expect("open temp")
            .sync_all()
            .expect("sync");

        replace_file(&temporary, &target).expect("replace");

        assert_eq!(fs::read(&target).expect("target"), b"new");
        assert!(!temporary.exists());
    }

    #[test]
    fn publishes_new_file() {
        let directory = tempfile::tempdir().expect("temp directory");
        let target = directory.path().join("target.txt");
        let temporary = directory.path().join(".target.tmp");
        fs::write(&temporary, b"new").expect("new");

        replace_file(&temporary, &target).expect("publish");

        assert_eq!(fs::read(&target).expect("target"), b"new");
    }
}
