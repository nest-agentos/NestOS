// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if tauri_app_lib::diagnostics::run_watcher() { return; }
    tauri_app_lib::run();
}
