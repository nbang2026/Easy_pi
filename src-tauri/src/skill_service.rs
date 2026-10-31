//! App-owned skill storage service. No terminal, Pi or model runtime is involved.
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_REQUEST: usize = 1024 * 1024;
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
const MAX_PENDING: usize = 32;
fn request_timeout(text: &str) -> Duration {
    let action = serde_json::from_str::<serde_json::Value>(text).ok().and_then(|value| value["action"].as_str().map(|action| action.trim().to_ascii_lowercase()));
    Duration::from_secs(match action.as_deref() {
        Some("status" | "list" | "job" | "cancel") => 10,
        Some("browse" | "search") => 30,
        _ => 60,
    })
}
const RESTART: &str = "Restart the skill service and refresh the library before retrying. The action was not resent; a change may already have completed.";
type Reply = Result<serde_json::Value, String>;
type Pending = HashMap<String, mpsc::SyncSender<Reply>>;

#[derive(Default)]
pub(crate) struct SkillService {
    connection: Mutex<ServiceState>,
}
#[derive(Default)]
struct ServiceState { connection: Option<Arc<Connection>>, failed: bool, stopped: bool }

impl SkillService {
    pub(crate) fn action(&self, text: String, resources: Option<PathBuf>) -> Reply {
        validate_request(&text)?;
        // Discovery is filesystem-only, outside the state lock, and never calls Pi.
        let connection = {
            let existing = self.connection.lock().map_err(|e| e.to_string())?;
            if existing.stopped { return Err("Skill service is shutting down.".into()); }
            if existing.failed { return Err(RESTART.into()); }
            existing.connection.clone()
        };
        let connection = match connection {
            Some(connection) => connection,
            None => {
                let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
                let node = discover_node(home.as_deref().map(Path::new), std::env::var_os("PATH").as_deref(), resources.as_deref())?;
                let mut state = self.connection.lock().map_err(|e| e.to_string())?;
                if state.stopped { return Err("Skill service is shutting down.".into()); }
                if state.failed { return Err(RESTART.into()); }
                if state.connection.is_none() {
                    // spawn installs asynchronous readers/writers; it never waits for the child.
                    let mut command = Command::new(node);
                    command.env("PI_CODING_AGENT_DIR", super::agent_config_directory()?);
                    state.connection = Some(Arc::new(Connection::spawn(command)?));
                }
                state.connection.as_ref().unwrap().clone()
            }
        };
        let timeout = request_timeout(&text);
        let result = connection.request(text, timeout);
        if connection.shared.closed.load(Ordering::Acquire) {
            if let Ok(mut state) = self.connection.lock() {
                if state.connection.as_ref().is_some_and(|current| Arc::ptr_eq(current, &connection)) { state.failed = true; }
            }
        }
        result
    }

    pub(crate) fn restart(&self) -> Result<(), String> {
        let connection = {
            let mut state = self.connection.lock().map_err(|e| e.to_string())?;
            if state.stopped { return Err("Skill service is shutting down.".into()); }
            state.failed = false;
            state.connection.take()
        };
        if let Some(connection) = connection { connection.close("Skill service restarted; preview tokens and jobs were discarded."); }
        Ok(())
    }

    pub(crate) fn shutdown(&self) {
        let connection = self.connection.lock().ok().and_then(|mut state| { state.stopped = true; state.connection.take() });
        if let Some(connection) = connection { connection.close("Skill service stopped."); }
    }
}
impl Drop for SkillService {
    fn drop(&mut self) {
        if let Ok(state) = self.connection.get_mut() {
            if let Some(connection) = state.connection.take() {
                std::thread::spawn(move || connection.close("Skill service stopped."));
            }
        }
    }
}

fn validate_request(text: &str) -> Result<(), String> {
    if text.len() > MAX_REQUEST / 2 { return Err("Skill request exceeds its size limit.".into()); }
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| "Invalid skill request JSON.")?;
    if !value.is_object() || !value.get("action").is_some_and(serde_json::Value::is_string) { return Err("A skill action is required.".into()); }
    Ok(())
}

struct Assets { directory: PathBuf }
impl Assets {
    fn create() -> Result<Self, String> {
        for _ in 0..8 {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|e| e.to_string())?;
            let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let directory = std::env::temp_dir().join(format!("pi-gui-skill-service-{suffix}"));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
            match builder.create(&directory) {
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
                Ok(()) => {}
            }
            let assets = Self { directory };
            for (name, source) in [
                ("gui-skills.mjs", include_str!("gui-skills.mjs")),
                ("privacy.mjs", include_str!("privacy.mjs")),
                ("pi-paths.mjs", include_str!("pi-paths.mjs")),
                ("skill-sources.mjs", include_str!("skill-sources.mjs")),
                ("skill-service.mjs", include_str!("skill-service.mjs")),
                ("gui-library.mjs", include_str!("gui-library.mjs")),
                ("gui-market.mjs", include_str!("gui-market.mjs")),
                ("agent-sources.mjs", include_str!("agent-sources.mjs")),
                ("task-routing.mjs", include_str!("task-routing.mjs")),
            ] {
                let mut options = std::fs::OpenOptions::new();
                options.create_new(true).write(true);
                #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
                options.open(assets.directory.join(name)).and_then(|mut file| file.write_all(source.as_bytes())).map_err(|e| e.to_string())?;
            }
            return Ok(assets);
        }
        Err("Could not create private skill service files.".into())
    }
}
impl Drop for Assets { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.directory); } }

struct Process { child: Child, _assets: Assets }
struct Shared { pending: Mutex<Pending>, closed: AtomicBool }
impl Shared {
    fn fail(&self, reason: &str) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut pending) = self.pending.lock() {
            for (_, response) in pending.drain() { let _ = response.send(Err(format!("{reason} {RESTART}"))); }
        }
    }
}
struct Connection {
    writer: mpsc::SyncSender<Vec<u8>>,
    shared: Arc<Shared>,
    process: Arc<Mutex<Option<Process>>>,
    next: AtomicU64,
}

impl Connection {
    fn spawn(mut command: Command) -> Result<Self, String> {
        let assets = Assets::create()?;
        // Ignore Node injection and credentials inherited from the assistant runtime.
        let inherited: Vec<_> = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "APPDATA", "LOCALAPPDATA", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]
            .into_iter().filter_map(|name| command.get_envs().find(|(key, _)| *key == OsStr::new(name)).map(|(_, value)| value.map(|value| (name, value.to_os_string()))).unwrap_or_else(|| std::env::var_os(name).map(|value| (name, value)))).collect();
        command.env_clear().envs(inherited).arg(assets.directory.join("skill-service.mjs"))
            .current_dir(&assets.directory).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|e| format!("Cannot start Node skill service: {e}"))?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let shared = Arc::new(Shared { pending: Mutex::new(HashMap::new()), closed: AtomicBool::new(false) });
        let process = Arc::new(Mutex::new(Some(Process { child, _assets: assets })));
        let (writer, queue) = mpsc::sync_channel::<Vec<u8>>(MAX_PENDING);
        let write_shared = shared.clone();
        let write_process = process.clone();
        std::thread::spawn(move || {
            for frame in queue {
                if write_shared.closed.load(Ordering::Acquire) { break; }
                if stdin.write_all(&frame).and_then(|_| stdin.flush()).is_err() {
                    write_shared.fail("Skill service input closed.");
                    stop_process(&write_process);
                    break;
                }
            }
        });
        let read_shared = shared.clone();
        let read_process = process.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let frame = match read_frame(&mut reader, MAX_RESPONSE) {
                    Ok(Some(frame)) => frame,
                    Ok(None) => { read_shared.fail("Skill service exited or Node is unsupported (Node 22.19+ is required)."); break; }
                    Err(error) => { read_shared.fail(&format!("Invalid skill service output: {error}")); break; }
                };
                if let Err(error) = deliver(&read_shared, &frame) { read_shared.fail(&error); break; }
            }
            stop_process(&read_process);
        });
        Ok(Self { writer, shared, process, next: AtomicU64::new(1) })
    }

    fn request(&self, text: String, timeout: Duration) -> Reply {
        validate_request(&text)?;
        let id = self.next.fetch_add(1, Ordering::Relaxed).to_string();
        let mut frame = serde_json::to_vec(&serde_json::json!({ "id": id, "text": text })).map_err(|e| e.to_string())?;
        if frame.len() > MAX_REQUEST { return Err("Skill request exceeds its transport size limit.".into()); }
        frame.push(b'\n');
        let (sender, response) = mpsc::sync_channel(1);
        {
            let mut pending = self.shared.pending.lock().map_err(|e| e.to_string())?;
            if self.shared.closed.load(Ordering::Acquire) { return Err(RESTART.into()); }
            if pending.len() >= MAX_PENDING { return Err("Skill service is busy; wait for pending actions to finish.".into()); }
            pending.insert(id.clone(), sender);
        }
        if self.writer.try_send(frame).is_err() {
            self.close("Skill service input is unavailable.");
            return Err(RESTART.into());
        }
        match response.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => { self.close("Skill service action timed out or disconnected."); Err(format!("Skill service action timed out or disconnected. {RESTART}")) }
        }
    }
    fn close(&self, reason: &str) { self.shared.fail(reason); stop_process(&self.process); }
}
impl Drop for Connection { fn drop(&mut self) { self.close("Skill service stopped."); } }

fn stop_process(process: &Mutex<Option<Process>>) {
    // Take ownership before killing/reaping: neither state nor process mutex is
    // held while waiting, so restart can reject outstanding requests immediately.
    let Some(mut process) = process.lock().ok().and_then(|mut slot| slot.take()) else { return; };
    if !matches!(process.child.try_wait(), Ok(Some(_))) {
        let _ = process.child.kill();
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if matches!(process.child.try_wait(), Ok(Some(_))) { break; }
            if Instant::now() >= deadline {
                // The reaper retains assets until the child has actually exited.
                std::thread::spawn(move || { let _ = process.child.wait(); drop(process); });
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn read_frame(reader: &mut impl BufRead, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let mut frame = Vec::new();
    reader.take((limit + 2) as u64).read_until(b'\n', &mut frame).map_err(|e| e.to_string())?;
    if frame.is_empty() { return Ok(None); }
    if frame.last() != Some(&b'\n') || frame.len() > limit + 1 { return Err("JSONL frame is truncated or exceeds its limit.".into()); }
    frame.pop();
    Ok(Some(frame))
}

fn deliver(shared: &Shared, frame: &[u8]) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_slice(frame).map_err(|_| "Malformed JSONL response.")?;
    let id = value.get("id").and_then(serde_json::Value::as_str).ok_or("Missing response id.")?;
    let result = match value.get("ok").and_then(serde_json::Value::as_bool) {
        Some(true) => Ok(value.get("data").cloned().ok_or("Missing response data.")?),
        Some(false) => Err(value["error"]["message"].as_str().ok_or("Missing response error.")?.to_string()),
        None => return Err("Invalid response status.".into()),
    };
    let sender = shared.pending.lock().map_err(|e| e.to_string())?.remove(id).ok_or("Unexpected or duplicate skill response id.")?;
    let _ = sender.send(result);
    Ok(())
}

fn discover_node(home: Option<&Path>, search_path: Option<&OsStr>, resources: Option<&Path>) -> Result<PathBuf, String> {
    for candidate in node_candidates(home, search_path, resources) {
        if super::is_executable(&candidate) {
            if let Ok(node) = probe_node(&candidate) { return Ok(node); }
        }
    }
    Err("Node.js 22.19+ was not found for the skill library. Install a supported Node or repair the bundled runtime, then restart the skill service.".into())
}

pub(crate) fn diagnostic_node(resources: Option<&Path>) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    discover_node(home.as_deref(), std::env::var_os("PATH").as_deref(), resources)
}

fn supported_node(version: &str) -> bool {
    let mut parts = version.trim_start_matches('v').split('.').filter_map(|part| part.parse::<u32>().ok());
    matches!((parts.next(), parts.next(), parts.next()), (Some(major), Some(minor), Some(_)) if major > 22 || major == 22 && minor >= 19)
}

fn probe_node(candidate: &Path) -> Result<PathBuf, String> {
    let mut command = Command::new(candidate);
    let inherited: Vec<_> = ["HOME", "USERPROFILE", "PATH", "SYSTEMROOT", "SystemRoot", "WINDIR", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP"].into_iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (name, value))).collect();
    command.env_clear().envs(inherited).arg("-p").arg("JSON.stringify({execPath:process.execPath,version:process.version})")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).current_dir(std::env::temp_dir());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let (sender, response) = mpsc::sync_channel(1);
    std::thread::spawn(move || { let mut bytes = Vec::new(); let result = stdout.take(8193).read_to_end(&mut bytes).map(|_| bytes); let _ = sender.send(result); });
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() { return Err("Node probe failed.".into()); }
                let bytes = response.recv_timeout(Duration::from_millis(100)).map_err(|_| "Node probe output timed out.")?.map_err(|e| e.to_string())?;
                if bytes.len() > 8192 { return Err("Node probe output exceeded limit.".into()); }
                let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid Node probe output.")?;
                if !value["version"].as_str().is_some_and(supported_node) { return Err("Node.js 22.19+ is required.".into()); }
                let path = PathBuf::from(value["execPath"].as_str().ok_or("Node probe did not return its executable.")?);
                return if path.is_absolute() && super::is_executable(&path) { Ok(path) } else { Err("Invalid Node executable path.".into()) };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                std::thread::spawn(move || { let _ = child.wait(); });
                return Err("Node probe timed out.".into());
            }
        }
    }
}
fn node_candidates(home: Option<&Path>, search_path: Option<&OsStr>, resources: Option<&Path>) -> Vec<PathBuf> {
    let node = if cfg!(windows) { "node.exe" } else { "node" };
    let mut paths = Vec::new();
    if let Some(resources) = resources.filter(|path| path.is_absolute()) {
        paths.extend([resources.join("runtime/node/node.exe"), resources.join("runtime/windows-x64/node/node.exe")]);
    }
    if let Some(search_path) = search_path {
        paths.extend(std::env::split_paths(search_path).filter(|path| path.is_absolute()).map(|path| path.join(node)));
    }
    if let Some(home) = home.filter(|path| path.is_absolute()) {
        for relative in [".local/bin", ".bun/bin", ".volta/bin", ".local/share/mise/shims", ".asdf/shims"] { paths.push(home.join(relative).join(node)); }
        for relative in [".nvm/versions/node", ".local/share/mise/installs/node", ".workbuddy/binaries/node/versions", "Library/Application Support/CherryStudio/Toolchain/mise/installs/node"] {
            if let Ok(entries) = std::fs::read_dir(home.join(relative)) {
                let mut versions: Vec<_> = entries.filter_map(Result::ok).filter(|entry| entry.path().is_dir()).map(|entry| entry.path().join("bin").join(node)).collect();
                versions.sort(); versions.reverse(); paths.extend(versions);
            }
        }
        #[cfg(windows)] paths.extend([home.join("AppData/Local/Programs/nodejs/node.exe"), home.join("AppData/Roaming/nvm/current/node.exe")]);
    }
    #[cfg(unix)] paths.extend(["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/opt/local/bin/node"].map(PathBuf::from));
    #[cfg(windows)] for name in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "NVM_SYMLINK"] {
        if let Some(path) = std::env::var_os(name).map(PathBuf::from).filter(|path| path.is_absolute()) {
            paths.push(if name == "NVM_SYMLINK" { path.join(node) } else { path.join("nodejs").join(node) });
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_frames_reject_oversized_truncated_and_invalid_responses() {
        assert_eq!(read_frame(&mut &b"{}\nnext\n"[..], 2).unwrap().unwrap(), b"{}");
        assert!(read_frame(&mut &b"xxx\n"[..], 2).is_err());
        assert!(read_frame(&mut &b"{}"[..], 2).is_err());
        assert!(read_frame(&mut &b""[..], 2).unwrap().is_none());
        let shared = Shared { pending: Mutex::new(HashMap::new()), closed: AtomicBool::new(false) };
        let (a, ra) = mpsc::sync_channel(1);
        let (b, rb) = mpsc::sync_channel(1);
        shared.pending.lock().unwrap().extend([("1".into(), a), ("2".into(), b)]);
        deliver(&shared, br#"{"id":"2","ok":true,"data":{"second":true}}"#).unwrap();
        deliver(&shared, br#"{"id":"1","ok":false,"error":{"message":"first failed"}}"#).unwrap();
        assert_eq!(rb.recv().unwrap().unwrap()["second"], true);
        assert_eq!(ra.recv().unwrap().unwrap_err(), "first failed");
        assert!(deliver(&shared, br#"{"id":"2","ok":true,"data":{}}"#).is_err());
    }

    #[test]
    fn assets_are_adjacent_private_and_removed() {
        let assets = Assets::create().unwrap();
        let directory = assets.directory.clone();
        for name in ["gui-skills.mjs", "privacy.mjs", "pi-paths.mjs", "skill-sources.mjs", "skill-service.mjs", "gui-library.mjs", "gui-market.mjs", "agent-sources.mjs", "task-routing.mjs"] { assert!(directory.join(name).is_file()); }
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(directory.metadata().unwrap().permissions().mode() & 0o777, 0o700); assert_eq!(directory.join("skill-service.mjs").metadata().unwrap().permissions().mode() & 0o777, 0o600); }
        drop(assets);
        assert!(!directory.exists());
    }

    #[test]
    fn node_discovery_uses_path_and_bundled_node_without_pi() {
        let root = crate::tests::scratch();
        let bin = root.join("node bin 空间");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join(if cfg!(windows) { "node.exe" } else { "node" });
        std::fs::write(&node, b"node").unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o700)).unwrap(); }
        let path = std::env::join_paths([Path::new("relative"), bin.as_path()]).unwrap();
        assert_eq!(node_candidates(None, Some(&path), None)[0], node);
        let bundled = root.join("runtime/node/node.exe");
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"node").unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&bundled, std::fs::Permissions::from_mode(0o700)).unwrap(); }
        assert_eq!(node_candidates(None, Some(&path), Some(&root))[0], bundled);
        assert!(node_candidates(None, Some(OsStr::new("relative")), None).iter().all(|path| path.is_absolute()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn supported_node_version_and_timeout_limits() {
        for version in ["v22.19.0", "v22.23.3", "v24.1.0"] { assert!(supported_node(version)); }
        for version in ["v20.99.0", "v22.18.0", "unknown", "v22.19"] { assert!(!supported_node(version)); }
        assert_eq!(request_timeout(r#"{"action":"status"}"#), Duration::from_secs(10));
        assert_eq!(request_timeout(r#"{"action":"browse"}"#), Duration::from_secs(30));
        assert_eq!(request_timeout(r#"{"action":"install"}"#), Duration::from_secs(60));
    }

    #[test]
    fn timeout_does_not_resend_writes_and_explicit_restart_clears_failed_connection() {
        let root = crate::tests::scratch();
        let node = discover_node(std::env::var_os("HOME").as_deref().map(Path::new), std::env::var_os("PATH").as_deref(), None).unwrap();
        let marker = root.join("write-attempts");
        let mut command = Command::new(node);
        command.args(["--input-type=module", "-e", "import fs from 'node:fs'; process.stdin.on('data',()=>fs.appendFileSync(process.env.HOME+'/write-attempts','write\\n')); fs.writeFileSync(process.env.HOME+'/ready','ready'); setInterval(()=>{},1000);"])
            .env("HOME", &root).env("USERPROFILE", &root).env("PATH", &root);
        let connection = Arc::new(Connection::spawn(command).unwrap());
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.join("ready").exists() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
        assert!(root.join("ready").exists(), "Test child did not finish starting.");
        assert!(connection.request(r#"{"action":"install","accepted":true}"#.into(), Duration::from_millis(250)).is_err());
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "write\n");
        let service = SkillService { connection: Mutex::new(ServiceState { connection: Some(connection.clone()), failed: false, stopped: false }) };
        assert!(service.action(r#"{"action":"install","accepted":true}"#.into(), None).unwrap_err().contains("not resent"));
        assert!(service.connection.lock().unwrap().failed);
        service.restart().unwrap();
        let state = service.connection.lock().unwrap();
        assert!(!state.failed);
        assert!(state.connection.is_none());
        drop(state);
        service.shutdown();
        assert!(service.action(r#"{"action":"status"}"#.into(), None).unwrap_err().contains("shutting down"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "Uses public skill catalogs; run explicitly with PI_GUI_SMOKE_NODE pointing to Node 22.19+."]
    fn real_skill_store_native_browse_without_pi_or_model() {
        let root = crate::tests::scratch();
        let node = PathBuf::from(std::env::var_os("PI_GUI_SMOKE_NODE").expect("PI_GUI_SMOKE_NODE is required"));
        assert!(node.is_absolute());
        let mut command = Command::new(node);
        command.env("HOME", &root).env("USERPROFILE", &root).env("PATH", &root).env_remove("PI_CODING_AGENT_DIR");
        let connection = Connection::spawn(command).unwrap();
        assert_eq!(connection.request(r#"{"action":"status"}"#.into(), Duration::from_secs(10)).unwrap()["installed"], 0);
        assert_eq!(connection.request(r#"{"action":"list"}"#.into(), Duration::from_secs(10)).unwrap()["skills"], serde_json::json!([]));
        let result = connection.request(r#"{"action":"browse","source":"all","page":1}"#.into(), Duration::from_secs(60)).unwrap();
        assert!(result["entries"].is_array(), "Expected catalog entries: {result}");
        assert!(!result["entries"].as_array().unwrap().is_empty(), "Expected a real catalog entry: {result}");
        assert!(!root.join(".pi").exists());
        println!("Native Rust service browse returned {} public entries with Pi absent and a fresh HOME.", result["entries"].as_array().unwrap().len());
        connection.close("smoke complete");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn real_service_status_and_list_need_no_pi_and_cleanup_child_assets() {
        let root = crate::tests::scratch();
        let node = discover_node(std::env::var_os("HOME").as_deref().map(Path::new), std::env::var_os("PATH").as_deref(), None).expect("Node is required for skill service integration tests");
        let mut command = Command::new(node);
        command.env("HOME", &root).env("USERPROFILE", &root).env("PATH", &root).env_remove("PI_CODING_AGENT_DIR");
        let connection = Connection::spawn(command).unwrap();
        let assets = connection.process.lock().unwrap().as_ref().unwrap()._assets.directory.clone();
        let status = connection.request(r#"{"action":"status"}"#.into(), Duration::from_secs(10)).unwrap();
        assert_eq!(status, serde_json::json!({"revision":0,"enabled":[],"installed":0}));
        assert_eq!(connection.request(r#"{"action":"list"}"#.into(), Duration::from_secs(10)).unwrap(), serde_json::json!({"skills":[],"revision":0}));
        let market = connection.request(r#"{"kind":"market","action":"list"}"#.into(), Duration::from_secs(10)).unwrap();
        assert_eq!(market["entries"].as_array().unwrap().len(), 64);
        assert!(market["installed"].as_array().unwrap().is_empty());
        let preview = connection.request(r#"{"kind":"market","action":"preview","id":"code-reviewer"}"#.into(), Duration::from_secs(10)).unwrap();
        assert!(preview["content"].as_str().unwrap().contains("Code Reviewer"));
        assert!(!root.join(".pi").exists());
        connection.close("test shutdown");
        let deadline = Instant::now() + Duration::from_secs(2);
        while assets.exists() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
        assert!(!assets.exists());
        assert!(connection.request(r#"{"action":"status"}"#.into(), Duration::from_millis(50)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
