use std::path::{Component, Path, PathBuf};

/// Session directory operations do not follow links or accept parent traversal.
/// The root must have been canonicalized by the trusted directory chooser.
pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute() || path.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err("path outside directory grant".into());
    }
    let mut current = root.to_path_buf();
    // Check the root as well: replacement with a symlink must revoke access.
    for component in std::iter::once(None).chain(path.components().map(Some)) {
        if let Some(c) = component { current.push(c); }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err("symlinks are not allowed in a directory grant".into()),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_absolute_and_parent_paths() {
        assert!(resolve(Path::new("/tmp"), "../secret").is_err());
        assert!(resolve(Path::new("/tmp"), "/etc/passwd").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_link_outside_selected_directory() {
        let root = std::env::temp_dir().join(format!("session-boundary-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink("/etc", root.join("escape")).unwrap();
        assert!(resolve(&root, "escape/passwd").is_err());
        assert!(resolve(&root, "new/file.txt").is_ok());
        std::fs::remove_file(root.join("escape")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
