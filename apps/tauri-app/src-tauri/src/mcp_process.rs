use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex};
use tauri::State;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

const MAX_LINE: usize = 4 * 1024 * 1024;
const MAX_QUEUE: usize = 8 * 1024 * 1024;
const MAX_STDERR: usize = 16 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
type Registry = Arc<Mutex<HashMap<String, Arc<Process>>>>;
#[derive(Default)]
pub struct MCPProcesses(Registry, Arc<AtomicBool>);
#[derive(Default)]
struct Output { lines: VecDeque<String>, bytes: usize, stderr: Vec<u8>, eof: bool, error: Option<String> }
struct Process { stopped: AtomicBool, child: Mutex<Child>, stdin: Mutex<ChildStdin>, output: Mutex<Output> }
#[derive(Serialize)]
pub struct Batch { lines: Vec<String>, exited: bool, error: Option<String> }

impl MCPProcesses {
    pub fn shutdown(&self) {
        self.1.store(true, Ordering::SeqCst);
        let processes: Vec<_> = self.0.lock().unwrap().drain().map(|(_, process)| process).collect();
        for process in processes { process.stop(); }
    }
}
impl Drop for MCPProcesses { fn drop(&mut self) { self.shutdown(); } }

impl Process {
    fn spawn(command: &str, args: &[String], cwd: Option<&str>, env: &HashMap<String, String>) -> Result<Arc<Self>, String> {
        if command.trim().is_empty() { return Err("MCP command is required".into()); }
        let mut cmd = Command::new(command);
        cmd.args(args).envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(cwd) = cwd.filter(|path| !path.is_empty()) { cmd.current_dir(cwd); }
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn().map_err(|e| format!("MCP start failed: {e}"))?;
        let stdin = child.stdin.take().ok_or("MCP stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("MCP stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("MCP stderr unavailable")?;
        let process = Arc::new(Self { stopped: AtomicBool::new(false), child: Mutex::new(child), stdin: Mutex::new(stdin), output: Mutex::new(Output::default()) });
        let reader = process.clone(); std::thread::spawn(move || reader.read_stdout(stdout));
        let reader = process.clone(); std::thread::spawn(move || reader.read_stderr(stderr));
        Ok(process)
    }

    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            if self.stopped.swap(true, Ordering::SeqCst) { return; }
            #[cfg(unix)]
            unsafe { unsafe extern "C" { fn kill(pid: i32, signal: i32) -> i32; } kill(-(child.id() as i32), 9); }
            let _ = child.kill(); let _ = child.wait();
            #[cfg(target_os = "linux")]
            crate::bash_process::wait_group_stopped(child.id());
        }
    }

    fn fail(&self, message: String) {
        self.output.lock().unwrap().error = Some(message);
        self.stop();
    }

    fn push_line(&self, bytes: &[u8]) -> Result<(), String> {
        let line = std::str::from_utf8(bytes).map_err(|_| "MCP stdout is not UTF-8")?;
        if line.trim().is_empty() { return Ok(()); }
        let mut output = self.output.lock().unwrap();
        if output.bytes + line.len() > MAX_QUEUE || output.lines.len() >= 1024 { return Err("MCP output queue limit exceeded".into()); }
        output.bytes += line.len(); output.lines.push_back(line.to_owned()); Ok(())
    }

    fn read_stdout(&self, mut stdout: impl Read) {
        let mut buffer = [0u8; 8192]; let mut pending = Vec::new();
        loop {
            let count = match stdout.read(&mut buffer) { Ok(0) => break, Ok(n) => n, Err(e) => { self.fail(format!("MCP stdout failed: {e}")); break; } };
            let mut failed = false;
            for &byte in &buffer[..count] {
                if byte == b'\n' {
                    if let Err(error) = self.push_line(&pending) { self.fail(error); failed = true; break; }
                    pending.clear();
                } else {
                    pending.push(byte);
                    if pending.len() > MAX_LINE { self.fail("MCP message limit exceeded".into()); failed = true; break; }
                }
            }
            if failed { break; }
        }
        let mut output = self.output.lock().unwrap();
        if !pending.is_empty() && output.error.is_none() { output.error = Some("MCP stdout ended with an incomplete message".into()); }
        output.eof = true;
    }

    fn read_stderr(&self, mut stderr: impl Read) {
        let mut buffer = [0u8; 4096];
        while let Ok(count) = stderr.read(&mut buffer) {
            if count == 0 { break; }
            let mut output = self.output.lock().unwrap(); output.stderr.extend_from_slice(&buffer[..count]);
            let excess = output.stderr.len().saturating_sub(MAX_STDERR);
            if excess > 0 { output.stderr.drain(..excess); }
        }
    }

    fn poll(&self) -> Result<Batch, String> {
        let exit = self.child.lock().map_err(|_| "MCP process lock poisoned")?.try_wait().map_err(|e| e.to_string())?;
        let mut output = self.output.lock().map_err(|_| "MCP output lock poisoned")?;
        let mut lines = Vec::new(); let mut bytes = 0;
        while lines.len() < 64 && bytes < 256 * 1024 {
            let Some(line) = output.lines.pop_front() else { break; };
            bytes += line.len(); output.bytes -= line.len(); lines.push(line);
        }
        let exited = output.eof && output.lines.is_empty();
        let error = output.error.clone().or_else(|| if exited { Some(format!("MCP server exited ({exit:?}): {}", String::from_utf8_lossy(&output.stderr))) } else { None });
        Ok(Batch { lines, exited, error })
    }
}

fn lookup(registry: &Registry, id: &str) -> Result<Arc<Process>, String> {
    registry.lock().map_err(|_| "MCP registry lock poisoned")?.get(id).cloned().ok_or_else(|| "MCP process is closed".into())
}

#[tauri::command]
pub async fn mcp_start(command: String, args: Vec<String>, cwd: Option<String>, env: HashMap<String, String>, processes: State<'_, MCPProcesses>) -> Result<String, String> {
    let registry = processes.0.clone(); let closing = processes.1.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if closing.load(Ordering::SeqCst) { return Err("MCP host is closing".into()); }
        let process = Process::spawn(&command, &args, cwd.as_deref(), &env)?;
        let id = format!("mcp-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        let mut entries = registry.lock().map_err(|_| "MCP registry lock poisoned")?;
        if closing.load(Ordering::SeqCst) { drop(entries); process.stop(); return Err("MCP host is closing".into()); }
        entries.insert(id.clone(), process); Ok(id)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcp_send(id: String, line: String, processes: State<'_, MCPProcesses>) -> Result<(), String> {
    if line.len() > MAX_LINE || line.contains('\n') { return Err("Invalid MCP message framing or size".into()); }
    let process = lookup(&processes.0, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut stdin = process.stdin.lock().map_err(|_| "MCP stdin lock poisoned")?;
        writeln!(stdin, "{line}").and_then(|_| stdin.flush()).map_err(|e| format!("MCP write failed: {e}"))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcp_poll(id: String, processes: State<'_, MCPProcesses>) -> Result<Batch, String> {
    let process = lookup(&processes.0, &id)?;
    tauri::async_runtime::spawn_blocking(move || process.poll()).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mcp_stop(id: String, processes: State<'_, MCPProcesses>) -> Result<(), String> {
    let process = processes.0.lock().map_err(|_| "MCP registry lock poisoned")?.remove(&id);
    tauri::async_runtime::spawn_blocking(move || { if let Some(process) = process { process.stop(); } }).await.map_err(|e| e.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    fn collect(process: &Process) -> Batch {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let batch = process.poll().unwrap();
            if !batch.lines.is_empty() || batch.exited || batch.error.is_some() { return batch; }
            assert!(Instant::now() < deadline, "MCP child timed out"); std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn independent_children_preserve_json_lines_and_stop() {
        let first = Process::spawn("sh", &["-c".into(), "read line; printf '%s\\n' \"$line\"; sleep 10".into()], None, &HashMap::new()).unwrap();
        let second = Process::spawn("sh", &["-c".into(), "printf 'second\\n'".into()], None, &HashMap::new()).unwrap();
        writeln!(first.stdin.lock().unwrap(), "{{\"jsonrpc\":\"2.0\",\"id\":1}}").unwrap();
        assert_eq!(collect(&first).lines, vec!["{\"jsonrpc\":\"2.0\",\"id\":1}"]);
        assert_eq!(collect(&second).lines, vec!["second"]); first.stop(); second.stop();
        assert!(first.child.lock().unwrap().try_wait().unwrap().is_some());
    }
    #[test]
    fn bounds_stderr_and_rejects_oversized_messages() {
        let process = Process::spawn("sh", &["-c".into(), "head -c 20000 /dev/zero >&2; head -c 5000000 /dev/zero".into()], None, &HashMap::new()).unwrap();
        assert!(collect(&process).error.unwrap().contains("message limit"));
        assert!(process.output.lock().unwrap().stderr.len() <= MAX_STDERR); process.stop();
    }
}
