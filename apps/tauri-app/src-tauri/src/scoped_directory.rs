use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, io::Write};
use serde_json::{Value, json};
static NEXT: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Default)]
pub struct DirectoryScopes(pub Arc<Mutex<HashMap<String, PathBuf>>>);

pub fn directory_read_range(id: String, path: String, offset: u64, length: u64, state: &DirectoryScopes) -> Result<Value, String> {
    use std::io::{Read, Seek, SeekFrom};
    if length > 8 * 1024 * 1024 { return Err("directory read range exceeds 8 MiB".into()); }
    let scopes = state.0.lock().map_err(|e| e.to_string())?;
    let root = scopes.get(&id).ok_or("directory grant has been closed")?;
    let target = crate::directory_boundary::resolve(root, &path)?;
    let mut file = match std::fs::File::open(&target) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(error) => return Err(error.to_string()),
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("search requires a regular file".into()); }
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(length).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(json!(bytes))
}

pub fn directory_open(path: String, state: &DirectoryScopes) -> Result<Value, String> {
    let root = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !root.is_dir() { return Err("selected path is not a directory".into()); }
    let id = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
    state.0.lock().map_err(|e| e.to_string())?.insert(id.clone(), root.clone());
    crate::diagnostics::record("directory.open", json!({"grantId": id, "root": root}));
    Ok(json!({"id": id, "root": root.to_string_lossy()}))
}
pub fn directory_close(id: String, state: &DirectoryScopes) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    crate::diagnostics::record("directory.close", json!({"grantId": id}));
    Ok(())
}

pub fn directory_stat_many(id: String, paths: Vec<String>, state: &DirectoryScopes) -> Result<Value, String> {
    if paths.len() > 256 { return Err("directory stat batch limit exceeded".into()); }
    let scopes = state.0.lock().map_err(|e| e.to_string())?;
    let root = scopes.get(&id).ok_or("directory grant has been closed")?;
    let mut results = Vec::with_capacity(paths.len());
    for path in paths {
        let target = crate::directory_boundary::resolve(root, &path)?;
        results.push(stat_value(&target)?);
    }
    Ok(Value::Array(results))
}

fn stat_value(path: &std::path::Path) -> Result<Value, String> {
    let m = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(e) => return Err(e.to_string()),
    };
    let ms = |t: std::io::Result<std::time::SystemTime>| t.ok()
        .and_then(|v| v.duration_since(std::time::UNIX_EPOCH).ok()).map(|v| v.as_millis() as u64).unwrap_or(0);
    Ok(json!({"size": m.len(), "isDirectory": m.is_dir(), "isFile": m.is_file(),
        "mtimeMs": ms(m.modified()), "birthtimeMs": ms(m.created())}))
}
pub fn directory_read_file(id: String, path: String, state: &DirectoryScopes) -> Result<Option<Vec<u8>>, String> {
    let scopes = state.0.lock().map_err(|e| e.to_string())?;
    let root = scopes.get(&id).ok_or("directory grant has been closed")?;
    let path = crate::directory_boundary::resolve(root, &path)?;
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn directory_io(id: String, operation: String, path: String, to: Option<String>, data: Option<Vec<u8>>, state: &DirectoryScopes) -> Result<Value, String> {
    let scopes = state.0.lock().map_err(|e| e.to_string())?;
    let root = scopes.get(&id).ok_or("directory grant has been closed")?;
    let p = crate::directory_boundary::resolve(root, &path)?;
    if p == *root && ["write", "append", "rename"].contains(&operation.as_str()) {
        return Err("cannot mutate grant root".into());
    }
    let err = |e: std::io::Error| e.to_string();
    match operation.as_str() {
        "stat" => stat_value(&p),
        "exists" => Ok(json!(p.exists())),
        "read" => match std::fs::read(p) { Ok(bytes) => Ok(json!(bytes)), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null), Err(e) => Err(err(e)) },
        "list" => {
            let mut entries = Vec::new();
            for entry in std::fs::read_dir(p).map_err(err)? {
                let entry = entry.map_err(err)?; let kind = entry.file_type().map_err(err)?;
                if !kind.is_symlink() { entries.push(json!({"name": entry.file_name().to_string_lossy(), "isDirectory": kind.is_dir()})); }
            }
            Ok(json!(entries))
        },
        "mkdir" => { std::fs::create_dir_all(p).map_err(err)?; Ok(Value::Null) },
        "write" | "append" => {
            if let Some(parent) = p.parent() { std::fs::create_dir_all(parent).map_err(err)?; }
            let bytes = data.ok_or("missing data")?;
            if operation == "append" {
                let mut file = std::fs::OpenOptions::new().create(true).append(true).open(p).map_err(err)?;
                file.write_all(&bytes).map_err(err)?;
            } else {
                let tmp = p.with_extension(format!("session-tmp-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
                let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(&tmp).map_err(err)?;
                let result = file.write_all(&bytes).and_then(|_| file.sync_all()).and_then(|_| std::fs::rename(&tmp, &p));
                if result.is_err() { let _ = std::fs::remove_file(&tmp); }
                result.map_err(err)?;
            }
            Ok(Value::Null)
        },
        "rename" => { let target = crate::directory_boundary::resolve(root, &to.ok_or("missing destination")?)?; std::fs::rename(p, target).map_err(err)?; Ok(Value::Null) },
        "unlink" | "rmdir" => {
            if p == *root { return Err("cannot remove grant root".into()); }
            let result = if operation == "unlink" { std::fs::remove_file(p) } else { std::fs::remove_dir(p) };
            match result { Ok(()) => Ok(Value::Null), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null), Err(e) => Err(err(e)) }
        },
        _ => Err("unsupported directory operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_reads_preserve_bytes_missing_files_and_grant_boundaries() {
        let root = std::env::temp_dir().join(format!("session-binary-read-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("bytes"), [0, 128, 255, 10]).unwrap();
        std::fs::write(root.join("empty"), []).unwrap();
        let state = DirectoryScopes::default();
        let id = directory_open(root.to_string_lossy().into(), &state).unwrap()["id"].as_str().unwrap().to_string();
        assert_eq!(directory_read_file(id.clone(), "bytes".into(), &state).unwrap(), Some(vec![0, 128, 255, 10]));
        assert_eq!(directory_read_file(id.clone(), "empty".into(), &state).unwrap(), Some(vec![]));
        assert_eq!(directory_read_file(id.clone(), "missing".into(), &state).unwrap(), None);
        assert!(directory_read_file(id.clone(), "../outside".into(), &state).is_err());
        #[cfg(unix)] {
            std::os::unix::fs::symlink(root.join("bytes"), root.join("link")).unwrap();
            assert!(directory_read_file(id.clone(), "link".into(), &state).is_err());
        }
        directory_close(id.clone(), &state).unwrap();
        assert!(directory_read_file(id, "bytes".into(), &state).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn range_reads_bound_large_files_and_preserve_grants() {
        let root = std::env::temp_dir().join(format!("session-range-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("large"), b"0123456789").unwrap();
        std::fs::OpenOptions::new().write(true).open(root.join("large")).unwrap().set_len(128 * 1024 * 1024).unwrap();
        let state = DirectoryScopes::default();
        let id = directory_open(root.to_string_lossy().into(), &state).unwrap()["id"].as_str().unwrap().to_string();
        assert_eq!(directory_read_range(id.clone(), "large".into(), 3, 2, &state).unwrap(), json!([51, 52]));
        assert_eq!(directory_read_range(id.clone(), "large".into(), 0, 0, &state).unwrap(), json!([]));
        assert!(directory_read_range(id.clone(), "../escape".into(), 0, 1, &state).is_err());
        assert!(directory_read_range(id.clone(), "large".into(), 0, 9 * 1024 * 1024, &state).is_err());
        directory_close(id.clone(), &state).unwrap();
        assert!(directory_read_range(id, "large".into(), 0, 1, &state).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn batch_stats_preserve_order_boundaries_and_revocation() {
        let root = std::env::temp_dir().join(format!("session-stat-batch-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("file.txt"), b"mdx").unwrap();
        let state = DirectoryScopes::default();
        let opened = directory_open(root.to_string_lossy().into(), &state).unwrap();
        let id = opened["id"].as_str().unwrap().to_string();
        let rows = directory_stat_many(id.clone(), vec!["file.txt".into(), "missing".into(), "".into()], &state).unwrap();
        assert_eq!(rows[0]["size"], 3); assert_eq!(rows[0]["isFile"], true);
        assert!(rows[1].is_null()); assert_eq!(rows[2]["isDirectory"], true);
        assert!(directory_stat_many(id.clone(), vec!["../outside".into()], &state).is_err());
        assert!(directory_stat_many(id.clone(), vec![String::new(); 257], &state).is_err());
        #[cfg(unix)] {
            std::os::unix::fs::symlink(root.join("file.txt"), root.join("link")).unwrap();
            assert!(directory_stat_many(id.clone(), vec!["link".into()], &state).is_err());
            std::fs::remove_file(root.join("link")).unwrap();
        }
        directory_close(id.clone(), &state).unwrap();
        assert!(directory_stat_many(id, vec!["file.txt".into()], &state).is_err());
        std::fs::remove_file(root.join("file.txt")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn scoped_io_rejects_escape_and_closed_handles() {
        let root = std::env::temp_dir().join(format!("session-scoped-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let state = DirectoryScopes::default();
        let opened = directory_open(root.to_string_lossy().into(), &state).unwrap();
        let id = opened["id"].as_str().unwrap().to_string();
        directory_io(id.clone(), "write".into(), "test.txt".into(), None, Some(vec![1, 2, 3]), &state).unwrap();
        assert_eq!(directory_io(id.clone(), "read".into(), "test.txt".into(), None, None, &state).unwrap(), json!([1, 2, 3]));
        assert!(directory_io(id.clone(), "read".into(), "../outside".into(), None, None, &state).is_err());
        assert!(directory_io(id.clone(), "rename".into(), "test.txt".into(), Some("../escape".into()), None, &state).is_err());
        assert!(directory_io(id.clone(), "write".into(), "".into(), None, Some(vec![0]), &state).is_err());
        directory_close(id.clone(), &state).unwrap();
        assert!(directory_io(id, "read".into(), "test.txt".into(), None, None, &state).is_err());
        std::fs::remove_file(root.join("test.txt")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
