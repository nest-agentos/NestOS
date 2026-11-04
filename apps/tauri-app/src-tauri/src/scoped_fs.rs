use tauri::State;
use serde_json::Value;
pub use crate::scoped_directory::DirectoryScopes;

// Keep filesystem calls and grant-lock contention off the native UI/event thread.
async fn run_directory<T: Send + 'static>(
    state: DirectoryScopes,
    operation: impl FnOnce(&DirectoryScopes) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || operation(&state))
        .await.map_err(|error| format!("directory worker failed: {error}"))?
}

#[tauri::command]
pub async fn directory_read_file(id: String, path: String, state: State<'_, DirectoryScopes>) -> Result<tauri::ipc::Response, String> {
    let bytes = run_directory(state.inner().clone(), move |state| crate::scoped_directory::directory_read_file(id, path, state)).await?;
    Ok(match bytes {
        Some(bytes) => tauri::ipc::Response::new(bytes),
        None => tauri::ipc::Response::new(tauri::ipc::InvokeResponseBody::Json("null".into())),
    })
}

#[tauri::command]
pub async fn directory_read_range(id: String, path: String, offset: u64, length: u64, state: State<'_, DirectoryScopes>) -> Result<Value, String> {
    run_directory(state.inner().clone(), move |state| crate::scoped_directory::directory_read_range(id, path, offset, length, state)).await
}
#[tauri::command]
pub async fn directory_open(path: String, state: State<'_, DirectoryScopes>) -> Result<Value, String> {
    run_directory(state.inner().clone(), move |state| crate::scoped_directory::directory_open(path, state)).await
}
#[tauri::command]
pub async fn directory_close(id: String, state: State<'_, DirectoryScopes>) -> Result<(), String> {
    run_directory(state.inner().clone(), move |state| crate::scoped_directory::directory_close(id, state)).await
}
#[tauri::command]
pub async fn directory_stat_many(id: String, paths: Vec<String>, state: State<'_, DirectoryScopes>) -> Result<Value, String> {
    run_directory(state.inner().clone(), move |state| crate::scoped_directory::directory_stat_many(id, paths, state)).await
}
#[tauri::command]
pub async fn directory_io(id: String, operation: String, path: String, to: Option<String>, data: Option<Vec<u8>>, state: State<'_, DirectoryScopes>) -> Result<Value, String> {
    run_directory(state.inner().clone(), move |state| crate::scoped_directory::directory_io(id, operation, path, to, data, state)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_worker_leaves_the_caller_thread_and_shares_revocation() {
        let state = DirectoryScopes::default();
        state.0.lock().unwrap().insert("grant".into(), std::env::temp_dir());
        let observer = state.clone();
        let caller = std::thread::current().id();
        tauri::async_runtime::block_on(run_directory(state, move |state| {
            assert_ne!(std::thread::current().id(), caller);
            crate::scoped_directory::directory_close("grant".into(), state)
        })).unwrap();
        assert!(observer.0.lock().unwrap().is_empty());
        let error = tauri::async_runtime::block_on(run_directory(observer, |state| {
            crate::scoped_directory::directory_stat_many("grant".into(), vec![], state)
        })).unwrap_err();
        assert!(error.contains("closed"));
    }
}
