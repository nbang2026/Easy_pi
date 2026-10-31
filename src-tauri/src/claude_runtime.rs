//! Per-window JSONL transport for the locally staged Claude Agent SDK sidecar.
//!
//! No shell, authentication files, or model calls are used for discovery/probing.
//! Unix children have their own process group: shutdown first asks the SDK to close,
//! then kills that group (including SDK subprocesses). Other platforms use the same
//! handshake followed by `Child::kill`; std cannot terminate a Windows process tree.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use super::privacy;

const MAX_FRAME: usize = 1024 * 1024;
const MAX_PENDING: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1200);
static NEXT_RUNTIME: AtomicU64 = AtomicU64::new(1);
const ACTIONS: &[&str] = &[
    "status", "configure", "submit", "stop", "new_session", "sessions", "resume",
    "library", "approval", "workspace", "permissions",
];
type Reply = Result<Value, String>;
type Emitter = Arc<dyn Fn(Value) + Send + Sync>;

struct Lifecycle {
    failure: Option<String>,
    pending: HashMap<u64, mpsc::SyncSender<Reply>>,
}
struct Shared {
    id: String,
    next_id: AtomicU64,
    closing: AtomicBool,
    lifecycle: Mutex<Lifecycle>,
    emit: Emitter,
    control: mpsc::Sender<Control>,
}
enum Control {
    Abort,
    Close(mpsc::Sender<()>),
}
struct WriteFrame {
    bytes: Vec<u8>,
    flushed: Option<mpsc::SyncSender<()>>,
}

/// Own one instance per window. Call blocking RPCs through Tauri's blocking pool;
/// the stdout worker independently forwards events via the supplied callback.
/// Reader/writer threads hold only Weak references, so Drop always closes the host.
pub struct ClaudeRuntime {
    shared: Arc<Shared>,
    writer: mpsc::SyncSender<WriteFrame>,
}

pub(crate) fn current_runtime(slot: &Mutex<Option<Arc<ClaudeRuntime>>>) -> Result<Arc<ClaudeRuntime>, String> {
    slot.lock().map_err(|error| error.to_string())?.as_ref().cloned()
        .ok_or_else(|| "Claude Agent 尚未启动。".into())
}

impl ClaudeRuntime {
    /// Validate the workspace, staged SDK/native executable, and local Node version
    /// before the caller tears down its currently running engine.
    pub fn probe(resources: &Path, cwd: &Path) -> Result<(), String> {
        canonical_directory(cwd, "Workspace")?;
        resource_entry(resources)?;
        discover_node(resources)?;
        Ok(())
    }

    pub fn start<F>(resources: &Path, cwd: &Path, emit: F, app_home: &Path) -> Result<Self, String>
    where
        F: Fn(Value) + Send + Sync + 'static,
    {
        let cwd = canonical_directory(cwd, "Workspace")?;
        let entry = resource_entry(resources)?;
        let node = discover_node(resources)?;
        if !app_home.is_absolute() {
            return Err("Claude app home must be an absolute path.".into());
        }
        // The sidecar owns creating its app-specific directories. Do not create or
        // inspect the user's Claude configuration/authentication here.
        if app_home.exists() && !app_home.is_dir() {
            return Err("Claude app home must be a directory.".into());
        }
        let mut command = Command::new(&node);
        command.arg(&entry).arg("--cwd").arg(&cwd).current_dir(&cwd);
        basic_environment(&mut command, true);
        let node_parent = node.parent().ok_or("Node executable has no parent directory.")?.to_path_buf();
        let mut node_paths = vec![node_parent];
        if let Some(path) = std::env::var_os("PATH") {
            node_paths.extend(std::env::split_paths(&path));
        }
        let node_path = std::env::join_paths(node_paths)
            .map_err(|_| "Could not prepare Claude runtime PATH.".to_string())?;
        command.env("PATH", node_path);
        command.env("EASY_PI_CLAUDE_HOME", app_home)
            .env("CLAUDE_CONFIG_DIR", app_home.join("claude"))
            .env("EASY_PI_CLAUDE_CWD", &cwd)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        own_process_group(&mut command);
        let mut child = command.spawn().map_err(|_| "Could not start the Agent Node sidecar.".to_string())?;
        let stdin = child.stdin.take().ok_or_else(|| "Claude sidecar stdin is unavailable.".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "Claude sidecar stdout is unavailable.".to_string())?;
        let (control_tx, control_rx) = mpsc::channel();
        let (writer_tx, writer_rx) = mpsc::sync_channel::<WriteFrame>(MAX_PENDING);
        let sequence = NEXT_RUNTIME.fetch_add(1, Ordering::Relaxed);
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let shared = Arc::new(Shared {
            id: format!("claude-{}-{stamp}-{sequence}", std::process::id()),
            next_id: AtomicU64::new(1), closing: AtomicBool::new(false),
            lifecycle: Mutex::new(Lifecycle { failure: None, pending: HashMap::new() }),
            emit: Arc::new(emit), control: control_tx,
        });
        // Spawn failure cleanup must still reap the child, even if a worker could
        // not be allocated. Workers never own the process handle.
        let weak = Arc::downgrade(&shared);
        if thread::Builder::new().name("claude-stdin".into()).spawn(move || {
            let mut stdin = stdin;
            while let Ok(frame) = writer_rx.recv() {
                if stdin.write_all(&frame.bytes).and_then(|_| stdin.flush()).is_err() {
                    fail_weak(&weak, "Claude sidecar input closed.");
                    break;
                }
                if let Some(flushed) = frame.flushed { let _ = flushed.send(()); }
            }
        }).is_err() {
            terminate_child(&mut child);
            return Err("Could not start the Claude input worker.".into());
        }
        let weak = Arc::downgrade(&shared);
        if thread::Builder::new().name("claude-stdout".into()).spawn(move || read_stdout(stdout, weak)).is_err() {
            terminate_child(&mut child);
            return Err("Could not start the Claude output worker.".into());
        }
        // The supervisor owns Child, but only a Weak host reference. A finished
        // worker cannot accidentally keep this runtime alive after window close.
        let weak = Arc::downgrade(&shared);
        let child_slot = Arc::new(Mutex::new(Some(child)));
        let supervisor_slot = child_slot.clone();
        if thread::Builder::new().name("claude-process".into()).spawn(move || {
            let mut child = supervisor_slot.lock().unwrap_or_else(|e| e.into_inner()).take().unwrap();
            loop {
                match control_rx.recv_timeout(Duration::from_millis(25)) {
                    Ok(Control::Close(done)) => {
                        // Allow SDK shutdown to reject approvals and reap its child.
                        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
                        while Instant::now() < deadline {
                            match child.try_wait() {
                                Ok(Some(_)) => break,
                                Err(_) => break,
                                Ok(None) => thread::sleep(Duration::from_millis(15)),
                            }
                        }
                        terminate_child(&mut child);
                        let _ = done.send(());
                        break;
                    }
                    Ok(Control::Abort) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        terminate_child(&mut child);
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => match child.try_wait() {
                        Ok(Some(_)) => {
                            fail_weak(&weak, "Claude sidecar exited.");
                            terminate_child(&mut child);
                            break;
                        }
                        Err(_) => {
                            fail_weak(&weak, "Could not monitor the Claude sidecar.");
                            terminate_child(&mut child);
                            break;
                        }
                        Ok(None) => {}
                    },
                }
            }
        }).is_err() {
            if let Some(mut child) = child_slot.lock().unwrap_or_else(|e| e.into_inner()).take() {
                terminate_child(&mut child);
            }
            return Err("Could not start the Claude process worker.".into());
        }
        let runtime = Self { shared, writer: writer_tx };
        // Local status only: verify transport/imports without any paid/model call.
        runtime.request_timeout("status", json!({}), Duration::from_secs(10))?;
        Ok(runtime)
    }

    pub fn id(&self) -> &str { &self.shared.id }

    /// The sidecar acknowledges submit immediately; generation arrives as events.
    /// stop's reply is sent only after its pending approval callbacks are rejected.
    pub fn request(&self, action: &str, payload: Value) -> Reply {
        self.request_timeout(action, payload, REQUEST_TIMEOUT)
    }

    fn request_timeout(&self, action: &str, payload: Value, timeout: Duration) -> Reply {
        if !ACTIONS.contains(&action) {
            return Err("Unsupported Claude action.".into());
        }
        let mut object = match payload {
            Value::Object(object) => object,
            Value::Null => serde_json::Map::new(),
            _ => return Err("Claude request payload must be an object.".into()),
        };
        if action == "workspace" {
            let cwd = object.get("cwd").and_then(Value::as_str).ok_or("Workspace must be an absolute directory.")?;
            let canonical = canonical_directory(Path::new(cwd), "Workspace")?;
            let canonical = canonical.to_str().ok_or("Workspace path must be valid Unicode.")?;
            object.insert("cwd".into(), Value::String(canonical.into()));
        }
        let id = self.shared.next_id.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| "Claude request IDs exhausted.".to_string())?;
        object.insert("id".into(), Value::from(id));
        object.insert("action".into(), Value::String(action.into()));
        let mut bytes = serde_json::to_vec(&Value::Object(object)).map_err(|_| "Could not encode Claude request.".to_string())?;
        if bytes.len() > MAX_FRAME { return Err("Claude request exceeds the 1 MiB frame limit.".into()); }
        bytes.push(b'\n');
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut state = self.shared.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
            if self.shared.closing.load(Ordering::Acquire) { return Err("Claude runtime is closed.".into()); }
            if let Some(error) = &state.failure { return Err(error.clone()); }
            let limit = if matches!(action, "stop" | "approval" | "permissions") { MAX_PENDING } else { MAX_PENDING - 4 };
            if state.pending.len() >= limit { return Err("Too many pending Claude requests.".into()); }
            state.pending.insert(id, sender);
            // Insertion and enqueue are ordered with close, so nothing can appear
            // after the shutdown frame or escape cancellation.
            if self.writer.try_send(WriteFrame { bytes, flushed: None }).is_err() {
                state.pending.remove(&id);
                return Err("Claude sidecar input queue is unavailable or full.".into());
            }
        }
        match receiver.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                fail(&self.shared, "Claude sidecar request timed out.");
                Err("Claude sidecar request timed out.".into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("Claude sidecar reply channel closed.".into()),
        }
    }

    /// Idempotent, bounded close. Fail pending RPCs, send the private SDK shutdown
    /// handshake, then let the supervisor force termination and reap the child.
    pub fn close(&self) {
        let (flushed, written) = mpsc::sync_channel(1);
        {
            let mut state = self.shared.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
            if self.shared.closing.swap(true, Ordering::AcqRel) { return; }
            for (_, waiter) in state.pending.drain() { let _ = waiter.send(Err("Claude runtime is closed.".into())); }
            let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
            let bytes = format!("{{\"id\":{id},\"action\":\"shutdown\"}}\n").into_bytes();
            let _ = self.writer.try_send(WriteFrame { bytes, flushed: Some(flushed) });
        }
        let _ = written.recv_timeout(Duration::from_millis(250));
        let (done, receiver) = mpsc::channel();
        if self.shared.control.send(Control::Close(done)).is_ok() {
            let _ = receiver.recv_timeout(SHUTDOWN_TIMEOUT + Duration::from_secs(1));
        }
    }
}
impl Drop for ClaudeRuntime { fn drop(&mut self) { self.close(); } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicU64, Ordering};
    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture { root: PathBuf, resources: PathBuf, cwd: PathBuf, home: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let sequence = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!("claude-host-test-{}-{stamp}-{sequence}", std::process::id())).join("path 空格 & $ literal");
            let resources = root.join("resources/claude-runtime");
            let cwd = root.join("workspace 中文");
            let home = root.join("app home");
            for directory in [&resources, &cwd, &home] { std::fs::create_dir_all(directory).unwrap(); }
            Self { root, resources, cwd, home }
        }
        fn staged(&self) {
            for relative in [
                PathBuf::from("runtime.mjs"),
                PathBuf::from("node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
                PathBuf::from("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"),
                native_relative().unwrap(),
            ] {
                let path = self.resources.join(relative);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, b"fixture").unwrap();
                #[cfg(unix)] {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
                }
            }
            std::fs::write(self.resources.join("claude-sidecar.mjs"), r#"
import readline from 'node:readline';
import fs from 'node:fs';
const reply = (id, data) => process.stdout.write(JSON.stringify({id, ok:true, data})+'\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.action === 'shutdown') {
    fs.writeFileSync(process.env.EASY_PI_CLAUDE_HOME+'/shutdown', 'closed');
    reply(request.id, {}); process.exit(0); return;
  }
  if (request.action === 'status') {
    reply(request.id, {ready:true,pid:process.pid,cwd:process.cwd(),home:process.env.EASY_PI_CLAUDE_HOME,config:process.env.CLAUDE_CONFIG_DIR,
      nodeDirectory:process.env.PATH?.split(process.platform === 'win32' ? ';' : ':')[0],
      nodeOptions:process.env.NODE_OPTIONS ?? null,piCredential:process.env.PI_TEST_API_KEY ?? null}); return;
  }
  if (request.mode === 'malformed') { process.stdout.write('not JSON\n'); return; }
  if (request.mode === 'truncated') { process.stdout.write('{"id":'); process.exit(0); return; }
  if (request.mode === 'oversized') { process.stdout.write('a'.repeat(1024*1024+1)+'\n'); return; }
  if (request.mode === 'exit') { process.exit(7); return; }
  if (request.mode === 'hang') { return; }
  if (request.mode === 'event') {
    process.stdout.write(JSON.stringify({type:'event',event:{type:'test',runtimeId:'forged',text:'中文'}})+'\n');
  }
  setTimeout(() => reply(request.id,request),request.delay ?? 0);
});
"#).unwrap();
        }
        fn start(&self, emit: impl Fn(Value) + Send + Sync + 'static) -> ClaudeRuntime {
            self.staged();
            ClaudeRuntime::start(&self.resources, &self.cwd, emit, &self.home).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(self.root.parent().unwrap()); }
    }

    #[test]
    fn claude_frames_bound_allocation_and_require_newlines() {
        assert_eq!(read_frame(&mut Cursor::new(b"{}\r\n")).unwrap(), Some(b"{}".to_vec()));
        assert_eq!(read_frame(&mut Cursor::new(Vec::<u8>::new())).unwrap(), None);
        assert!(read_frame(&mut Cursor::new(b"{\"partial\":" )).unwrap_err().contains("truncated"));
        let mut exact = vec![b'a'; MAX_FRAME]; exact.push(b'\n');
        assert_eq!(read_frame(&mut Cursor::new(exact)).unwrap().unwrap().len(), MAX_FRAME);
        assert!(read_frame(&mut Cursor::new(vec![b'a'; MAX_FRAME + 1])).unwrap_err().contains("limit"));
    }

    #[test]
    fn claude_node_version_and_error_redaction() {
        for version in ["v22.19.0\n", "v22.23.3", "v23.0.0", "v24.1.2"] { assert!(supported_node(version)); }
        for version in ["v22.18.9", "v20.99.0", "", "invalid", "v22.no.0"] { assert!(!supported_node(version)); }
        let message = safe_error(Some(&json!("bad sk-ant-api-secret, key sk-other-secret token")));
        assert!(!message.contains("secret"));
        assert!(safe_error(Some(&json!("a".repeat(5000)))).len() <= 2048);
    }

    #[test]
    fn claude_preflight_rejects_missing_files_and_relative_workspaces() {
        let fixture = Fixture::new();
        assert!(ClaudeRuntime::probe(&fixture.resources, &fixture.cwd).is_err());
        assert!(canonical_directory(Path::new("relative"), "Workspace").is_err());
        fixture.staged();
        assert_eq!(resource_entry(fixture.resources.parent().unwrap()).unwrap(), fixture.resources.join("claude-sidecar.mjs").canonicalize().unwrap());
        std::fs::remove_file(fixture.resources.join(native_relative().unwrap())).unwrap();
        assert!(resource_entry(&fixture.resources).unwrap_err().contains("incomplete"));
    }

    #[test]
    fn bundled_windows_node_is_resolved_from_resources_and_development_layouts() {
        let fixture = Fixture::new();
        let packaged = fixture.root.join("resources/runtime/windows-x64/node/node.exe");
        std::fs::create_dir_all(packaged.parent().unwrap()).unwrap();
        std::fs::write(&packaged, b"node").unwrap();
        assert_eq!(bundled_node(&fixture.resources), Some(packaged));

        std::fs::remove_file(fixture.root.join("resources/runtime/windows-x64/node/node.exe")).unwrap();
        let development = fixture.root.join("src-tauri/runtime/windows-x64/node/node.exe");
        std::fs::create_dir_all(development.parent().unwrap()).unwrap();
        std::fs::write(&development, b"node").unwrap();
        assert_eq!(bundled_node(&fixture.resources), Some(development));
    }

    #[cfg(unix)]
    #[test]
    fn claude_preflight_rejects_resource_symlinks_outside_bundle() {
        let fixture = Fixture::new(); fixture.staged();
        let anchor = fixture.resources.join("runtime.mjs");
        std::fs::remove_file(&anchor).unwrap();
        let outside = fixture.root.join("outside.mjs"); std::fs::write(&outside, b"fixture").unwrap();
        std::os::unix::fs::symlink(&outside, &anchor).unwrap();
        assert!(resource_entry(&fixture.resources).unwrap_err().contains("invalid"));
    }

    #[test]
    fn claude_rpc_preserves_paths_correlates_replies_and_stamps_events() {
        let fixture = Fixture::new();
        let (sender, receiver) = mpsc::channel();
        let runtime = fixture.start(move |event| { let _ = sender.send(event); });
        let status = runtime.request("status", json!({})).unwrap();
        assert_eq!(status["cwd"], fixture.cwd.canonicalize().unwrap().to_str().unwrap());
        assert_eq!(status["config"], fixture.home.join("claude").to_str().unwrap());
        let node_directory = Path::new(status["nodeDirectory"].as_str().unwrap());
        let expected_directory = discover_node(&fixture.resources).unwrap();
        assert_eq!(node_directory, expected_directory.parent().unwrap());
        assert!(status["nodeOptions"].is_null());
        assert!(status["piCredential"].is_null());
        let event_reply = runtime.request("configure", json!({"mode":"event","id":999,"action":"shutdown","text":"space 中文"})).unwrap();
        assert_ne!(event_reply["id"], 999);
        assert_eq!(event_reply["action"], "configure");
        assert_eq!(event_reply["text"], "space 中文");
        let event = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(event["runtimeId"], runtime.id()); assert_eq!(event["text"], "中文");
        thread::scope(|scope| {
            let slow = scope.spawn(|| runtime.request("configure", json!({"tag":"slow","delay":80})).unwrap());
            let fast = scope.spawn(|| runtime.request("configure", json!({"tag":"fast"})).unwrap());
            assert_eq!(fast.join().unwrap()["tag"], "fast");
            assert_eq!(slow.join().unwrap()["tag"], "slow");
        });
        assert!(runtime.request("shutdown", json!({})).is_err());
        assert!(runtime.request("configure", json!([])).is_err());
        assert!(runtime.request("configure", json!({"text":"x".repeat(MAX_FRAME)})).is_err());
        runtime.close(); runtime.close();
        assert!(fixture.home.join("shutdown").is_file());
        assert!(runtime.request("status", json!({})).is_err());
    }

    #[test]
    fn claude_malformed_truncated_oversized_and_exit_end_waiters() {
        for mode in ["malformed", "truncated", "oversized", "exit"] {
            let fixture = Fixture::new(); let runtime = fixture.start(|_| {});
            let started = Instant::now();
            let reply = runtime.request("configure", json!({"mode":mode}));
            assert!(reply.is_err(), "{mode}");
            assert!(started.elapsed() < Duration::from_secs(5), "{mode} left a waiter hanging");
            assert!(runtime.request("status", json!({})).is_err());
        }
    }

    #[test]
    fn claude_timeout_and_close_cancel_waiters() {
        let fixture = Fixture::new(); let runtime = fixture.start(|_| {});
        assert!(runtime.request_timeout("configure", json!({"mode":"hang"}), Duration::from_millis(50)).is_err());
        assert!(runtime.request("status", json!({})).is_err());
        drop(runtime);
        let fixture = Fixture::new(); let runtime = fixture.start(|_| {});
        thread::scope(|scope| {
            let waiter = scope.spawn(|| runtime.request("configure", json!({"mode":"hang"})));
            thread::sleep(Duration::from_millis(50));
            runtime.close();
            assert!(waiter.join().unwrap().is_err());
        });
    }

    #[test]
    fn claude_pending_rpc_releases_app_slot_for_stop_and_close() {
        let fixture = Fixture::new();
        let slot = Mutex::new(Some(Arc::new(fixture.start(|_| {}))));
        thread::scope(|scope| {
            let waiter = scope.spawn(|| {
                let runtime = current_runtime(&slot).unwrap();
                runtime.request_timeout("submit", json!({"mode":"hang"}), Duration::from_secs(5))
            });
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let runtime = current_runtime(&slot).unwrap();
                if !runtime.shared.lifecycle.lock().unwrap().pending.is_empty() { break; }
                assert!(Instant::now() < deadline, "pending request did not start");
                thread::sleep(Duration::from_millis(5));
            }
            assert!(slot.try_lock().is_ok(), "waiting for an RPC must not hold the AppState slot");
            let stopped = current_runtime(&slot).unwrap()
                .request_timeout("stop", json!({}), Duration::from_millis(500)).unwrap();
            assert_eq!(stopped["action"], "stop");
            let runtime = slot.lock().unwrap().take().unwrap();
            runtime.close();
            assert!(waiter.join().unwrap().is_err(), "close must release the pending waiter");
            assert!(current_runtime(&slot).is_err());
        });
    }

    #[test]
    fn claude_busy_request_pool_preserves_capacity_for_stop() {
        let fixture = Fixture::new();
        let runtime = fixture.start(|_| {});
        let mut receivers = Vec::new();
        {
            let mut lifecycle = runtime.shared.lifecycle.lock().unwrap();
            for id in 100..100 + (MAX_PENDING - 4) as u64 {
                let (sender, receiver) = mpsc::sync_channel(1);
                lifecycle.pending.insert(id, sender);
                receivers.push(receiver);
            }
        }
        assert!(runtime.request("status", json!({})).unwrap_err().contains("Too many pending"));
        let reply = runtime.request_timeout("stop", json!({}), Duration::from_millis(500)).unwrap();
        assert_eq!(reply["action"], "stop");
        runtime.close();
        for receiver in receivers { assert!(receiver.recv_timeout(Duration::from_millis(50)).unwrap().is_err()); }
    }

    #[cfg(unix)]
    #[test]
    fn claude_drop_reaps_child_without_reader_arc_cycle() {
        extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
        let fixture = Fixture::new(); let runtime = fixture.start(|_| {});
        let pid = runtime.request("status", json!({})).unwrap()["pid"].as_i64().unwrap() as i32;
        assert_eq!(unsafe { kill(pid, 0) }, 0);
        drop(runtime);
        assert_ne!(unsafe { kill(pid, 0) }, 0);
        assert!(fixture.home.join("shutdown").is_file());
    }

    #[test]
    #[ignore = "requires intentionally staged official SDK resources; local status only, never a model call"]
    fn claude_staged_runtime_smoke() {
        let resources = std::env::var_os("EASY_PI_CLAUDE_SMOKE_RESOURCES").expect("set EASY_PI_CLAUDE_SMOKE_RESOURCES");
        let fixture = Fixture::new();
        #[cfg(windows)] {
            let expected = Path::new(&resources)
                .parent()
                .unwrap()
                .join("runtime/windows-x64/node/node.exe")
                .canonicalize()
                .unwrap();
            assert_eq!(discover_node(Path::new(&resources)).unwrap(), expected);
        }
        ClaudeRuntime::probe(Path::new(&resources), &fixture.cwd).unwrap();
        let runtime = ClaudeRuntime::start(Path::new(&resources), &fixture.cwd, |_| {}, &fixture.home).unwrap();
        let status = runtime.request("status", json!({})).unwrap();
        assert_eq!(status["ready"], true);
        assert_eq!(status["busy"], false);
        assert_eq!(status["permissionMode"], "ask");
        let full = runtime.request("permissions", json!({"mode":"full",
            "expectedWorkspace":status["cwd"],"expectedSessionId":status["sessionId"]})).unwrap();
        assert_eq!(full["permissionMode"], "full");
        let controlled = runtime.request("permissions", json!({"mode":"ask",
            "expectedWorkspace":status["cwd"],"expectedSessionId":status["sessionId"]})).unwrap();
        assert_eq!(controlled["permissionMode"], "ask");
        runtime.close();
    }
}

fn fail_weak(shared: &Weak<Shared>, error: &str) {
    if let Some(shared) = shared.upgrade() { fail(&shared, error); }
}
fn fail(shared: &Shared, error: &str) {
    let should_emit = {
        let mut state = shared.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        if state.failure.is_some() || shared.closing.load(Ordering::Acquire) { return; }
        state.failure = Some(error.into());
        for (_, waiter) in state.pending.drain() { let _ = waiter.send(Err(error.into())); }
        true
    };
    let _ = shared.control.send(Control::Abort);
    if should_emit { emit(shared, json!({"type":"runtime_error", "error":error})); }
}
fn emit(shared: &Shared, mut event: Value) {
    if shared.closing.load(Ordering::Acquire) { return; }
    if let Some(object) = event.as_object_mut() {
        object.insert("runtimeId".into(), Value::String(shared.id.clone()));
        // A consumer panic must not strand every pending RPC or crash cleanup.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (shared.emit)(event)));
    }
}

fn read_stdout(stdout: impl Read, weak: Weak<Shared>) {
    let mut reader = BufReader::new(stdout);
    loop {
        let bytes = match read_frame(&mut reader) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => { fail_weak(&weak, "Claude sidecar output closed."); break; }
            Err(error) => { fail_weak(&weak, error); break; }
        };
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => { fail_weak(&weak, "Claude sidecar sent malformed JSON."); break; }
        };
        let Some(shared) = weak.upgrade() else { break; };
        if shared.closing.load(Ordering::Acquire) { continue; }
        if value.get("type").and_then(Value::as_str) == Some("event") {
            match value.get("event").filter(|event| event.is_object()) {
                Some(event) => emit(&shared, event.clone()),
                None => { fail(&shared, "Claude sidecar sent an invalid event."); break; }
            }
            continue;
        }
        let (Some(id), Some(ok)) = (value.get("id").and_then(Value::as_u64), value.get("ok").and_then(Value::as_bool)) else {
            fail(&shared, "Claude sidecar sent an invalid reply."); break;
        };
        let waiter = shared.lifecycle.lock().unwrap_or_else(|e| e.into_inner()).pending.remove(&id);
        if let Some(waiter) = waiter {
            let reply = if ok { Ok(value.get("data").cloned().unwrap_or(Value::Null)) }
            else { Err(safe_error(value.get("error"))) };
            let _ = waiter.send(reply);
        }
    }
}

/// fill_buf bounds allocation even when the child never sends a newline. EOF in
/// the middle of a frame is an error rather than an implicitly accepted reply.
fn read_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, &'static str> {
    let mut frame = Vec::new();
    loop {
        let chunk = reader.fill_buf().map_err(|_| "Could not read Claude sidecar output.")?;
        if chunk.is_empty() {
            return if frame.is_empty() { Ok(None) } else { Err("Claude sidecar sent a truncated frame.") };
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let take = newline.unwrap_or(chunk.len());
        if frame.len() + take > MAX_FRAME { return Err("Claude sidecar frame exceeds the 1 MiB limit."); }
        frame.extend_from_slice(&chunk[..take]);
        reader.consume(take + usize::from(newline.is_some()));
        if newline.is_some() {
            if frame.last() == Some(&b'\r') { frame.pop(); }
            return Ok(Some(frame));
        }
    }
}

// Sidecar errors are bounded and stripped of explicit known key values; malformed
// transport diagnostics never include stdout/stderr/request bodies in errors.
fn safe_error(value: Option<&Value>) -> String {
    let text = value.and_then(Value::as_str)
        .or_else(|| value.and_then(|value| value.get("message")).and_then(Value::as_str))
        .unwrap_or("Claude sidecar request failed.");
    let mut text: String = text.chars().take(2048).collect();
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        if !key.is_empty() { text = text.replace(&key, "[redacted]"); }
    }
    // configure keys are in-memory payloads; never return an apparent API token
    // even when the sidecar SDK mentions one in its error message.
    for prefix in ["sk-ant-", "sk-"] {
        while let Some(start) = text.find(prefix) {
            let end = text[start..].find(|ch: char| ch.is_whitespace() || matches!(ch, '\"' | '\'' | ',' | '}' | ')')).map(|offset| start + offset).unwrap_or(text.len());
            text.replace_range(start..end.max(start + prefix.len()), "[redacted]");
        }
    }
    privacy::redact(&text)
}
fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() { return Err(format!("{label} must be an absolute directory.")); }
    let path = path.canonicalize().map_err(|_| format!("{label} directory does not exist or is inaccessible."))?;
    if !path.is_dir() { return Err(format!("{label} must be a directory.")); }
    Ok(path)
}
fn resource_entry(resources: &Path) -> Result<PathBuf, String> {
    let resources = canonical_directory(resources, "Claude runtime resource")?;
    let root = if resources.join("claude-sidecar.mjs").is_file() { resources }
        else { canonical_directory(&resources.join("claude-runtime"), "Claude runtime resource")? };
    let mut required = vec![
        PathBuf::from("claude-sidecar.mjs"), PathBuf::from("runtime.mjs"),
        PathBuf::from("node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
        PathBuf::from("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"),
    ];
    required.push(native_relative()?);
    for relative in &required {
        let file = root.join(relative);
        let canonical = file.canonicalize().map_err(|_| format!("Staged Agent runtime is incomplete ({}). Rebuild its resources.", relative.display()))?;
        if !canonical.starts_with(&root) || !canonical.is_file() || canonical.metadata().map(|meta| meta.len() == 0).unwrap_or(true) {
            return Err(format!("Staged Agent runtime file is invalid ({}).", relative.display()));
        }
    }
    if root.join(required.last().unwrap()).metadata().map(|meta| meta.len() == 0).unwrap_or(true) { return Err("Agent runtime launcher is missing or empty.".into()); }
    Ok(root.join("claude-sidecar.mjs"))
}
fn native_relative() -> Result<PathBuf, String> {
    let platform = if cfg!(target_os = "macos") { "darwin" }
        else if cfg!(target_os = "windows") { "win32" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let libc = if cfg!(all(target_os = "linux", target_env = "musl")) { "-musl" } else { "" };
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    Ok(PathBuf::from(format!("node_modules/@anthropic-ai/claude-agent-sdk-{platform}-{arch}{libc}/claude{suffix}")))
}

fn executable(path: &Path) -> bool {
    if !path.is_absolute() || !path.is_file() { return false; }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        path.metadata().map(|meta| meta.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))] { true }
}

const BASIC_ENV: &[&str] = &[
    "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "USER", "LOGNAME",
];
fn basic_environment(command: &mut Command, credentials: bool) {
    command.env_clear();
    for name in BASIC_ENV {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    if credentials {
        for name in ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "EASY_PI_AGENT_API_KEY", "EASY_PI_AGENT_BASE_URL", "EASY_PI_AGENT_MODEL", "EASY_PI_AGENT_PROTOCOL"] {
            if let Some(value) = std::env::var_os(name) { command.env(name, value); }
        }
    }
}
fn node_candidates() -> Vec<PathBuf> {
    let node = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).filter(|dir| dir.is_absolute()).map(|dir| dir.join(node)));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        for directory in [".local/bin", ".volta/bin", ".bun/bin", ".local/share/mise/shims", ".asdf/shims", ".n/bin"] {
            candidates.push(home.join(directory).join(node));
        }
        for directory in [".nvm/versions/node", ".local/share/mise/installs/node", ".workbuddy/binaries/node/versions", "Library/Application Support/CherryStudio/Toolchain/mise/installs/node"] {
            if let Ok(entries) = std::fs::read_dir(home.join(directory)) {
                let mut paths = entries.filter_map(Result::ok).map(|entry| entry.path().join("bin").join(node)).collect::<Vec<_>>();
                paths.sort(); paths.reverse(); candidates.extend(paths);
            }
        }
        #[cfg(windows)] candidates.extend([home.join("AppData/Local/Programs/nodejs/node.exe"), home.join("AppData/Roaming/nvm/current/node.exe")]);
    }
    #[cfg(unix)] candidates.extend([PathBuf::from("/opt/homebrew/bin/node"), PathBuf::from("/usr/local/bin/node"), PathBuf::from("/usr/bin/node"), PathBuf::from("/opt/local/bin/node")]);
    #[cfg(windows)] for name in ["ProgramFiles", "ProgramFiles(x86)", "NVM_SYMLINK"] {
        if let Some(path) = std::env::var_os(name) {
            let path = PathBuf::from(path);
            candidates.push(if name == "NVM_SYMLINK" { path.join(node) } else { path.join("nodejs").join(node) });
        }
    }
    candidates
}
fn discover_node(resources: &Path) -> Result<PathBuf, String> {
    for name in ["CLAUDE_NODE_EXECUTABLE", "EASY_PI_NODE", "EASY_PI_NODE_PATH"] {
        if let Some(value) = std::env::var_os(name) {
            let path = PathBuf::from(value);
            if !executable(&path) || check_node(&path).is_err() {
                return Err(format!("{name} must point to an absolute Node executable, version 22.19 or newer."));
            }
            return path.canonicalize().map_err(|_| "Could not resolve the configured Node executable.".into());
        }
    }
    if cfg!(windows) {
        if let Some(path) = bundled_node(resources) {
            if !executable(&path) || check_node(&path).is_err() {
                return Err("The bundled Node runtime is invalid. Reinstall easy_pi.".into());
            }
            return path.canonicalize().map_err(|_| "Could not resolve the bundled Node executable.".into());
        }
    }
    for path in node_candidates() {
        if executable(&path) && check_node(&path).is_ok() {
            if let Ok(path) = path.canonicalize() { return Ok(path); }
        }
    }
    Err("Node.js 22.19 or newer was not found. Install Node or set CLAUDE_NODE_EXECUTABLE to its absolute executable path.".into())
}
fn bundled_node(resources: &Path) -> Option<PathBuf> {
    resources.ancestors()
        .flat_map(|ancestor| [
            ancestor.join("runtime/windows-x64/node/node.exe"),
            ancestor.join("src-tauri/runtime/windows-x64/node/node.exe"),
        ])
        .find(|candidate| candidate.is_file())
}
fn check_node(node: &Path) -> Result<(), String> {
    let mut command = Command::new(node);
    basic_environment(&mut command, false);
    command.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    own_process_group(&mut command);
    let mut child = command.spawn().map_err(|_| "Could not run Node.".to_string())?;
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = mpsc::sync_channel(1);
    if thread::Builder::new().name("claude-node-probe".into()).spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(129).read_to_end(&mut bytes).map(|_| bytes);
        let _ = sender.send(result);
    }).is_err() {
        terminate_child(&mut child);
        return Err("Could not check Node version.".into());
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                break receiver.recv_timeout(Duration::from_millis(100)).ok().and_then(Result::ok)
                    .filter(|bytes| bytes.len() <= 128)
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .filter(|version| supported_node(version)).map(|_| ()).ok_or_else(|| "Node 22.19 or newer is required.".to_string());
            }
            Ok(Some(_)) | Err(_) => break Err("Could not check Node version.".into()),
            Ok(None) if Instant::now() >= deadline => break Err("Node version check timed out.".into()),
            Ok(None) => thread::sleep(Duration::from_millis(10)),
        }
    };
    terminate_child(&mut child);
    result
}
fn supported_node(version: &str) -> bool {
    let mut parts = version.trim().trim_start_matches('v').split('.');
    match (parts.next().and_then(|value| value.parse::<u32>().ok()), parts.next().and_then(|value| value.parse::<u32>().ok())) {
        (Some(major), Some(minor)) => major > 22 || (major == 22 && minor >= 19),
        _ => false,
    }
}
fn own_process_group(command: &mut Command) {
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}
fn terminate_child(child: &mut Child) {
    #[cfg(unix)] {
        // POSIX kill is linked from the platform C runtime; declaring this narrow
        // ABI avoids adding libc as a direct dependency solely for process cleanup.
        extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
        if let Ok(pid) = i32::try_from(child.id()) {
            unsafe { kill(-pid, 9); }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}
