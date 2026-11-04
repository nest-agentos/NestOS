#[path = "../../tauri-app/src-tauri/src/session_bash.rs"]
mod session_bash;
#[path = "../../tauri-app/src-tauri/src/bash_process.rs"]
mod bash_process;

use itookit_sanbox::{session_command, NetworkAccess};

// Harness for the real Tauri Session Bash module: it builds the same bwrap command the
// desktop host uses and executes it through `bash_process::execute_command`, so the
// cancellation path (process-group SIGTERM → SIGKILL) is exercisable outside the GUI.
// An optional 4th argument flips the cancel flag after that many milliseconds.
//
// `SESSION_BASH_NETWORK=allow` is a test-only switch for the nested-DAG harness, whose child
// run must reach an LLM fixture on loopback; the product path keeps the deny-network policy.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mounts = [
        session_bash::Mount { source: args[1].clone(), target: "/app".into(), writable: false },
        session_bash::Mount { source: args[2].clone(), target: "/workspace".into(), writable: true },
    ];
    let command = if std::env::var("SESSION_BASH_NETWORK").as_deref() == Ok("allow") {
        session_command(&args[3], "/workspace", &mounts, NetworkAccess::Allow).unwrap()
    } else {
        session_bash::command(&args[3], "/workspace", &mounts).unwrap()
    };
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Some(delay) = args.get(4).and_then(|value| value.parse::<u64>().ok()) {
        let flag = std::sync::Arc::clone(&cancelled);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });
    }
    let started = std::time::Instant::now();
    let (stdout, stderr, code) = bash_process::execute_command(
        command, 30_000, &cancelled,
    ).unwrap();
    print!("{stdout}");
    eprint!("{stderr}");
    println!("cancelled={} elapsed_ms={}", cancelled.load(std::sync::atomic::Ordering::SeqCst),
        started.elapsed().as_millis());
    std::process::exit(if code < 0 { 1 } else { code });
}
