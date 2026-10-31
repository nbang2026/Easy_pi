use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{Emitter, Manager, State};
mod claude_runtime;
mod gui_bridge;
mod model_management;
mod pi_paths;
mod runtime;
mod skill_service;
mod terminal_lifecycle;
mod privacy;
mod startup_diagnostics;
mod workbench;

pub(crate) fn agent_config_directory() -> Result<PathBuf, String> {
    pi_paths::agent_directory(
        std::env::var_os("PI_CODING_AGENT_DIR").as_deref(),
        std::env::var_os("HOME").as_deref(),
        std::env::var_os("USERPROFILE").as_deref(),
        std::env::current_dir().as_deref().unwrap_or_else(|_| Path::new(".")),
    )
}

// All implicit drops, including app exit, dispatch cleanup off the GUI thread.
type TerminalState = terminal_lifecycle::BackgroundDrop<TerminalResources>;

struct TerminalResources {
    master: Box<dyn MasterPty + Send>,
    // Input goes through a dedicated thread so a stalled PTY never blocks the UI thread or the state lock,
    // while keystrokes keep their original order.
    writer: std::sync::mpsc::Sender<Vec<u8>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    bridge: std::sync::Arc<gui_bridge::GuiBridge>,
    cwd: PathBuf,
    started_at: std::time::Instant,
    startup: std::sync::Arc<Mutex<startup_diagnostics::StartupDiagnostics>>,
}

impl Drop for TerminalResources {
    fn drop(&mut self) {
        // Only this window's owned child is signalled. portable-pty's kill may
        // already reap it; never introduce an unbounded wait afterwards.
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.bridge.request("prepare_shutdown", None, None);
            #[cfg(unix)]
            terminal_lifecycle::kill_owned_group(self.child.process_id());
            let _ = self.child.kill();
            let _ = terminal_lifecycle::wait_for_exit(
                || self.child.try_wait(), std::time::Duration::from_secs(1),
            );
        }
        self.bridge.close();
    }
}

struct AppState {
    term: std::sync::Arc<Mutex<Option<TerminalState>>>,
    claude: std::sync::Arc<Mutex<Option<std::sync::Arc<claude_runtime::ClaudeRuntime>>>>,
}

#[derive(Default)]
struct ExitState(std::sync::Arc<std::sync::atomic::AtomicU8>);

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return path.metadata().map(|meta| meta.permissions().mode() & 0o111 != 0).unwrap_or(false);
    }
    #[cfg(not(unix))]
    true
}

fn configure_home() {
    if std::env::var_os("HOME").is_none() {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            std::env::set_var("HOME", profile);
        }
    }
}

fn find_pi(home: &Path, search_path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    #[cfg(unix)]
    let mut candidates = vec![
        home.join(".local/bin/pi"), home.join(".bun/bin/pi"),
        home.join(".npm-global/bin/pi"), PathBuf::from("/opt/homebrew/bin/pi"),
        PathBuf::from("/usr/local/bin/pi"),
    ];
    #[cfg(windows)]
    let mut candidates = {
        let mut candidates = vec![
            home.join("AppData/Roaming/npm/pi.cmd"), home.join("AppData/Roaming/npm/pi.exe"),
            home.join(".local/bin/pi.exe"), home.join(".local/bin/pi.cmd"),
            home.join(".bun/bin/pi.exe"), home.join(".bun/bin/pi.cmd"),
        ];
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let npm = PathBuf::from(appdata).join("npm");
            candidates.extend([npm.join("pi.exe"), npm.join("pi.cmd"), npm.join("pi.bat")]);
        }
        candidates
    };
    if let Some(path) = search_path {
        #[cfg(unix)]
        candidates.extend(std::env::split_paths(path).map(|dir| dir.join("pi")));
        #[cfg(windows)]
        candidates.extend(std::env::split_paths(path).flat_map(|dir| [dir.join("pi.exe"), dir.join("pi.cmd"), dir.join("pi.bat")]));
    }
    candidates.into_iter().find(|path| is_executable(path))
}

#[cfg(any(windows, test))]
fn find_windows_git(
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
    local_app_data: Option<&Path>,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for root in [program_files, program_files_x86].into_iter().flatten() {
        candidates.extend([
            root.join("Git/cmd/git.exe"),
            root.join("Git/bin/git.exe"),
        ]);
    }
    if let Some(local) = local_app_data {
        candidates.extend([
            local.join("Programs/Git/cmd/git.exe"),
            local.join("Programs/Git/bin/git.exe"),
        ]);
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn git_executable() -> PathBuf {
    #[cfg(windows)]
    {
        let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
        let program_files_x86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
        let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        if let Some(path) = find_windows_git(
            program_files.as_deref(),
            program_files_x86.as_deref(),
            local_app_data.as_deref(),
        ) {
            return path;
        }
    }
    PathBuf::from("git")
}

fn resolve_runtime(app: &tauri::AppHandle) -> Result<runtime::Runtime, String> {
    #[cfg(windows)]
    let resources = app.path().resource_dir().ok();
    #[cfg(not(windows))]
    let resources: Option<PathBuf> = { let _ = app; None };
    runtime::resolve(
        std::env::var_os("PI_EXECUTABLE").as_deref(),
        resources.as_deref(),
        || {
            let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
            find_pi(Path::new(&home), std::env::var_os("PATH").as_deref())
                .ok_or_else(|| "Pi CLI was not found. Install Pi or set PI_EXECUTABLE to its full executable path.".into())
        },
    )
}

#[tauri::command]
fn get_runtime_info(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "cwd": std::env::var("HOME").unwrap_or_else(|_| "/".into()),
        "executable": resolve_runtime(&app).ok().map(|runtime| runtime.executable().to_string_lossy().into_owned()).unwrap_or_default(),
    })
}

fn read_config(path: &Path) -> Result<serde_json::Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let value: serde_json::Value = serde_json::from_str(&text)
                .map_err(|error| format!("{}: {error}. Original file was not changed.", path.display()))?;
            if !value.is_object() {
                return Err(format!("{} must contain a JSON object. Original file was not changed.", path.display()));
            }
            Ok(value)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(error) => Err(error.to_string()),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid configuration path")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?.as_nanos();
    let temporary = parent.join(format!(".pi-write-{}-{stamp}", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        // Windows cannot reliably replace a file while our temporary handle is open.
        // rename replaces the destination; never delete the old configuration first.
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|error| error.to_string())
}

fn pty_pi_command(spec: &runtime::CommandSpec) -> CommandBuilder {
    let mut command = CommandBuilder::new(&spec.program);
    command.args(&spec.args);
    if let Some(path) = spec.child_path() {
        command.env("PATH", path);
    }
    command
}

fn process_pi_command(spec: &runtime::CommandSpec) -> std::process::Command {
    let mut command = std::process::Command::new(&spec.program);
    command.args(&spec.args);
    if let Some(path) = spec.child_path() {
        command.env("PATH", path);
    }
    command
}

/// Forward only the environment variables pi needs. A GUI app does not
/// inherit the interactive shell environment, so we pass through the API
/// keys and a sensible PATH/HOME/TERM explicitly.
fn pass_env(cmd: &mut CommandBuilder) {
    // CommandBuilder inherits everything by default; copying a whitelist alone
    // does not remove unrelated host credentials.
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        if k == "TERM"
            || k == "PATH"
            || k == "HOME"
            || k == "LANG"
            || k == "LC_ALL"
            || k == "SHELL"
            || k == "TMPDIR"
            || matches!(k.to_ascii_uppercase().as_str(), "SYSTEMROOT" | "WINDIR" | "USERPROFILE" | "TEMP" | "TMP" |
                "APPDATA" | "LOCALAPPDATA" | "COMSPEC" | "PATHEXT" | "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" |
                "NO_PROXY" | "SSL_CERT_FILE" | "SSL_CERT_DIR" | "SSH_AUTH_SOCK")
            || k.ends_with("_API_KEY")
            || k.starts_with("ANTHROPIC_")
            || k.starts_with("OPENAI_")
            || k.starts_with("GOOGLE_")
            || k.starts_with("AZURE_")
            || k.starts_with("PI_")
            || k == "OPENROUTER_API_KEY"
            || k == "XAI_API_KEY"
            || k == "DEEPSEEK_API_KEY"
        {
            cmd.env(k, v);
        }
    }

    // A GUI app launched from Finder/Desktop does NOT inherit TERM/LANG,
    // so the pty would hand pi an empty TERM and it falls back to a dumb
    // terminal (TUI renders broken, interaction dies). Force sane values.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // A GUI app does not inherit the login shell's PATH, so the usual global
    // install locations for pi, node and bun are prepended per platform. Unix
    // prefixes must not leak into the Windows PATH, where they would resolve
    // against the current drive.
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        #[cfg(unix)]
        let mut paths = vec![
            home.join(".local/bin"), home.join(".bun/bin"),
            PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin"),
        ];
        #[cfg(windows)]
        let mut paths = {
            let mut paths = vec![home.join(".local/bin"), home.join(".bun/bin")];
            if let Some(appdata) = std::env::var_os("APPDATA") {
                paths.push(PathBuf::from(appdata).join("npm"));
            }
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                paths.push(PathBuf::from(local).join("bun").join("bin"));
            }
            paths
        };
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        if let Ok(path) = std::env::join_paths(paths) {
            cmd.env("PATH", path);
        }
    }
    if std::env::var("LANG").is_err() && std::env::var("LC_ALL").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("LC_ALL", "en_US.UTF-8");
    }
}

#[tauri::command]
fn start_terminal(
    rows: u16,
    cols: u16,
    on_data: tauri::ipc::Channel<Vec<u8>>,
    on_exit: tauri::ipc::Channel<String>,
    cwd: Option<String>,
    session: Option<String>,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<serde_json::Value, String> {
    if rows == 0 || cols == 0 {
        return Err("Terminal dimensions must be greater than zero".into());
    }
    let runtime = resolve_runtime(&app)?;
    let cwd = workbench::workspace_root(cwd.as_deref())?;
    let session = session.map(|path| {
        let path = workbench::session_path(&path)?;
        workbench::validate_session_workspace(&path, &cwd)?;
        Ok::<_, String>(path)
    }).transpose()?;
    let mut guard = state.term.lock().map_err(|error| error.to_string())?;
    if let Some(terminal) = guard.as_mut() {
        if terminal.child.try_wait().map_err(|error| error.to_string())?.is_none() {
            return Err("Pi is already running in this window.".into());
        }
    }
    guard.take();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let spec = runtime.command(std::iter::empty::<std::ffi::OsString>());
    let mut cmd = pty_pi_command(&spec);
    cmd.cwd(&cwd);
    pass_env(&mut cmd);
    // Resolve relative overrides before changing the child process working directory.
    cmd.env("PI_CODING_AGENT_DIR", agent_config_directory()?);
    cmd.env("PI_GUI_RUNTIME_KIND", match &runtime {
        runtime::Runtime::Bundled { .. } => "bundled",
        runtime::Runtime::External(_) => "external",
    });
    // pass_env augments PATH for external runtimes; bundled Node must be first.
    if let Some(path) = spec.child_path() {
        cmd.env("PATH", path);
    }
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let bridge = gui_bridge::GuiBridge::create(app)?;
    cmd.arg("--extension");
    cmd.arg(&bridge.extension);
    if let Some(path) = session {
        cmd.arg("--session");
        cmd.arg(path);
    }
    cmd.env("PI_GUI_SOCKET", &bridge.socket);
    cmd.env("PI_GUI_TOKEN", &bridge.token);

    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(error) => { bridge.close(); return Err(error.to_string()); }
    };
    drop(pair.slave);

    // Stream pty output -> frontend channel
    let channel = on_data;
    let startup = std::sync::Arc::new(Mutex::new(startup_diagnostics::StartupDiagnostics::default()));
    let capture = std::sync::Arc::clone(&startup);
    let startup_bridge = std::sync::Arc::clone(&bridge);
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        let mut capturing = true;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if capturing {
                        let connected = startup_bridge.status()["connected"] == true;
                        let mut capture = capture.lock().unwrap();
                        if connected { capture.finish(); capturing = false; }
                        else if std::time::Instant::now() < deadline { capture.record(&buf[..n]); }
                        else { capturing = false; }
                    }
                    if channel.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = on_exit.send("exited".into());
    });

    let (input, queue) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut writer = writer;
        // Ends when TerminalState drops the sender or the PTY closes.
        for data in queue {
            if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    *guard = Some(TerminalState::new(TerminalResources {
        master: pair.master,
        writer: input,
        child,
        bridge,
        cwd: cwd.clone(),
        started_at: std::time::Instant::now(),
        startup,
    }));
    Ok(serde_json::json!({
        "cwd": cwd.to_string_lossy(),
        "executable": runtime.executable().to_string_lossy(),
        "bridgeId": guard.as_ref().unwrap().bridge.id(),
    }))
}

#[tauri::command]
async fn stop_terminal(force: Option<bool>, state: State<'_, AppState>) -> Result<(), String> {
    let terminal = std::sync::Arc::clone(&state.term);
    tauri::async_runtime::spawn_blocking(move || {
        // Socket status can wait for a concurrent write timeout. Read it on the
        // worker without holding the terminal mutex so recovery stays usable.
        let bridge = terminal.lock().map_err(|error| error.to_string())?.as_ref()
            .map(|term| std::sync::Arc::clone(&term.bridge));
        let Some(bridge) = bridge else { return Ok(()); };
        // Only explicit recovery opts out of the normal busy/draft protection.
        // Do not consult a possibly stalled bridge on the forced path.
        let status = (!force.unwrap_or(false)).then(|| bridge.status());
        let detached = terminal_lifecycle::take_for_stop(&terminal, |term| {
            if !std::sync::Arc::ptr_eq(&term.bridge, &bridge) {
                return Err("Pi changed while stopping; retry the operation.".into());
            }
            validate_terminal_stop(status.as_ref())
        })?;
        if let Some(terminal) = detached {
            // The state mutex is released before any kill, socket close or PTY
            // handle destruction. Await completion before a normal restart.
            drop(terminal.into_inner());
        }
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

fn validate_terminal_stop(status: Option<&serde_json::Value>) -> Result<(), String> {
    if status.is_some_and(|status| status["busy"] == true || status["nativeDraft"] == true) {
        return Err("请先停止当前任务并处理终端草稿，再切换工作区或会话。".into());
    }
    Ok(())
}

#[tauri::command]
fn validate_terminal_target(cwd: String, session: Option<String>) -> Result<(), String> {
    let root = workbench::workspace_root(Some(&cwd))?;
    if let Some(path) = session {
        workbench::validate_session_workspace(&workbench::session_path(&path)?, &root)?;
    }
    Ok(())
}

#[tauri::command]
async fn gui_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let terminal = std::sync::Arc::clone(&state.term);
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = {
            let mut guard = terminal.lock().map_err(|error| error.to_string())?;
            guard.as_mut().map(|term| {
                let exit_code = term.child.try_wait().map_err(|error| error.to_string())?.map(|status| status.exit_code());
                Ok::<_, String>((std::sync::Arc::clone(&term.bridge), exit_code, term.started_at.elapsed().as_secs(), std::sync::Arc::clone(&term.startup)))
            }).transpose()?
        };
        let (mut status, alive) = match snapshot {
            Some((bridge, exit_code, elapsed, startup)) => {
                let alive = exit_code.is_none();
                let mut status = bridge.status();
                if alive && status["connected"] == true {
                    // An open socket alone does not prove the extension's JS
                    // event loop responds. The bridge bounds this status RPC.
                    match bridge.request("status", None, None).and_then(|response| {
                        response.get("state").filter(|state| state.is_object()).cloned()
                            .ok_or_else(|| "Pi returned an invalid status response.".into())
                    }) {
                        Ok(live) => status = live,
                        Err(error) => {
                            status["connected"] = serde_json::json!(false);
                            status["ready"] = serde_json::json!(false);
                            status["bridgeError"] = serde_json::json!(error);
                        }
                    }
                }
                status["bridgeId"] = serde_json::json!(bridge.id());
                status["startupElapsedSeconds"] = serde_json::json!(elapsed);
                if status["connected"] == true { startup.lock().unwrap().finish(); }
                if let Some(code) = exit_code {
                    status["exitCode"] = serde_json::json!(code);
                    if let Some(error) = startup.lock().unwrap().error() {
                        status["startupError"] = serde_json::json!(error);
                    }
                }
                (status, alive)
            }
            None => (serde_json::json!({"ready": false, "busy": false, "connected": false}), false),
        };
        status["processAlive"] = serde_json::json!(alive);
        if !alive {
            status["ready"] = serde_json::json!(false);
            status["connected"] = serde_json::json!(false);
        }
        Ok(status)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn gui_action(
    action: String, text: Option<String>, mode: Option<String>, state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let bridge = state.term.lock().map_err(|e| e.to_string())?.as_ref()
        .map(|term| std::sync::Arc::clone(&term.bridge)).ok_or("Pi 尚未连接。")?;
    tauri::async_runtime::spawn_blocking(move || bridge.request(&action, text, mode))
        .await.map_err(|e| e.to_string())?
}

fn claude_resource_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("claude-runtime");
        if bundled.is_dir() { return Ok(bundled); }
    }
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../agent-runtime");
        if development.is_dir() { return Ok(development); }
    }
    Err("Claude Agent runtime is not bundled. Run the runtime preparation step before enabling Claude.".into())
}

#[tauri::command]
fn probe_claude(cwd: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let resources = claude_resource_directory(&app)?;
    claude_runtime::ClaudeRuntime::probe(&resources, Path::new(&cwd))?;
    Ok(serde_json::json!({ "available": true }))
}

#[tauri::command]
async fn start_claude(
    cwd: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let resources = claude_resource_directory(&app)?;
    let home = app.path().app_data_dir().map_err(|error| error.to_string())?.join("claude-agent");
    let emitter = app.clone();
    let runtime = tauri::async_runtime::spawn_blocking(move || {
        claude_runtime::ClaudeRuntime::start(&resources, Path::new(&cwd), move |event| {
            let _ = emitter.emit("claude-agent-event", event);
        }, &home)
    }).await.map_err(|error| error.to_string())??;
    let status = runtime.request("status", serde_json::json!({}))?;
    let runtime_id = runtime.id().to_string();
    let previous = state.claude.lock().map_err(|error| error.to_string())?
        .replace(std::sync::Arc::new(runtime));
    if let Some(previous) = previous {
        tauri::async_runtime::spawn_blocking(move || previous.close()).await.map_err(|error| error.to_string())?;
    }
    Ok(serde_json::json!({ "runtimeId": runtime_id, "status": status }))
}

#[tauri::command]
async fn stop_claude(state: State<'_, AppState>) -> Result<(), String> {
    let runtime = state.claude.lock().map_err(|error| error.to_string())?.take();
    if let Some(runtime) = runtime {
        tauri::async_runtime::spawn_blocking(move || runtime.close()).await.map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn claude_action(
    action: String,
    payload: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let payload = payload.unwrap_or_else(|| serde_json::json!({}));
    let runtimes = std::sync::Arc::clone(&state.claude);
    tauri::async_runtime::spawn_blocking({
        let action = action.clone();
        let payload = payload.clone();
        move || {
            // Pending replies must not hold AppState's slot lock: stop,
            // approvals and window exit need to reach the same live transport.
            let runtime = claude_runtime::current_runtime(&runtimes)?;
            runtime.request(&action, payload)
        }
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn skill_store_action(
    text: String, app: tauri::AppHandle, state: State<'_, std::sync::Arc<skill_service::SkillService>>,
) -> Result<serde_json::Value, String> {
    let service = std::sync::Arc::clone(state.inner());
    #[cfg(windows)]
    let resources = app.path().resource_dir().ok();
    #[cfg(not(windows))]
    let resources = { let _ = app; None };
    tauri::async_runtime::spawn_blocking(move || service.action(text, resources).map(|data| serde_json::json!({ "data": data })))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn skill_store_restart(state: State<'_, std::sync::Arc<skill_service::SkillService>>) -> Result<serde_json::Value, String> {
    let service = std::sync::Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.restart()?;
        Ok(serde_json::json!({ "data": { "restarted": true } }))
    }).await.map_err(|error| error.to_string())?
}

fn pi_process_diagnostic_rows(running: bool, bridge_connected: bool, ready: bool) -> [(&'static str, bool, &'static str); 3] {
    let process = (
        "Pi 进程",
        running,
        if running { "已启动" } else { "尚未启动或已退出" },
    );
    let bridge = (
        "输入桥接",
        bridge_connected,
        if bridge_connected {
            "已连接"
        } else if running {
            "Pi 正在运行，但 GUI 输入桥接尚未连接"
        } else {
            "Pi 未运行；桥接会在启动后建立"
        },
    );
    let input = (
        "输入状态",
        ready,
        if ready {
            "可输入"
        } else if !running {
            "Pi 启动后才能检查输入状态"
        } else if !bridge_connected {
            "等待输入桥接连接后检查"
        } else {
            "输入尚未就绪，可能正在等待确认弹窗"
        },
    );
    [process, bridge, input]
}

#[tauri::command]
async fn run_diagnostics(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let terminal = std::sync::Arc::clone(&state.term);
    tauri::async_runtime::spawn_blocking(move || {
    let snapshot = terminal.lock().ok().and_then(|mut guard| {
        guard.as_mut().map(|term| {
            let alive = matches!(term.child.try_wait(), Ok(None));
            (term.cwd.clone(), std::sync::Arc::clone(&term.bridge), alive)
        })
    });
    let (cwd, bridge, running) = snapshot.map(|(cwd, bridge, alive)| (cwd, bridge.status(), alive)).unwrap_or_else(|| (
        workbench::workspace_root(None).unwrap_or_default(),
        serde_json::json!({"connected": false, "ready": false}),
        false,
    ));
    let pi = resolve_runtime(&app);
    let git = git_probe(std::process::Command::new(git_executable()), std::time::Duration::from_secs(2));
    let node = skill_service::diagnostic_node(app.path().resource_dir().ok().as_deref());
    let config = agent_config_directory().and_then(|directory| {
        for name in ["models.json", "settings.json"] { read_config(&directory.join(name))?; }
        Ok(())
    });
    let pi_detail = match &pi {
        Ok(_) => "已找到".to_string(),
        Err(error) => privacy::redact(error),
    };
    let node_detail = match &node {
        Ok(_) => "已找到".to_string(),
        Err(error) => privacy::redact(error),
    };
    let config_detail = if config.is_ok() {
        "JSON 格式可读取；不输出密钥".to_string()
    } else {
        "配置文件不可读取；原文件未修改".to_string()
    };
    let workspace_ok = cwd.is_dir();
    let process_checks = pi_process_diagnostic_rows(running, bridge["connected"] == true, bridge["ready"] == true);
    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "checkedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
        "checks": [
            {"name":"easy_pi 版本", "ok":true, "detail":env!("CARGO_PKG_VERSION")},
            {"name":"正在运行的应用", "ok":true, "detail":"easy_pi"},
            {"name": "Pi CLI", "ok": pi.is_ok(), "detail": pi_detail},
            {"name": "Node.js 22.19+", "ok": node.is_ok(), "detail": node_detail},
            {"name": "配置文件", "ok": config.is_ok(), "detail": config_detail},
            {"name": "工作区", "ok": workspace_ok, "detail": if workspace_ok { "已验证" } else { "未找到" }},
            {"name": process_checks[0].0, "ok": process_checks[0].1, "detail": process_checks[0].2},
            {"name": process_checks[1].0, "ok": process_checks[1].1, "detail": process_checks[1].2},
            {"name": process_checks[2].0, "ok": process_checks[2].1, "detail": process_checks[2].2},
            {"name": "Git", "ok": git, "detail": if git { "已安装" } else { "未安装，审阅暂不可用" }},
        ]
    }))
    }).await.map_err(|error| error.to_string())?
}

fn git_probe(mut command: std::process::Command, timeout: std::time::Duration) -> bool {
    use std::process::Stdio;
    command.arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else { return false; };
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                std::thread::spawn(move || { let _ = child.wait(); });
                return false;
            }
        }
    }
}

/// List the models configured for pi (from ~/.pi/agent/models-store.json),
/// limited to providers the user has credentials for, plus the current default.
#[tauri::command]
fn list_models() -> Result<serde_json::Value, String> {
    list_models_at(&agent_config_directory()?)
}

fn list_models_at(directory: &Path) -> Result<serde_json::Value, String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    model_management::list(directory)
}

static MODEL_CONFIG_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
fn save_model_provider(provider: String, api: String, baseurl: String, apikey: String) -> Result<(), String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let directory = agent_config_directory()?;
    model_management::save_provider(&directory, &provider, &api, &baseurl, &apikey)
}

#[tauri::command]
fn create_model_provider(provider: String, api: String) -> Result<(), String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let directory = agent_config_directory()?;
    model_management::create_provider(&directory, &provider, &api)
}

/// Add (or update) a custom provider/model in ~/.pi/agent/models.json.
#[tauri::command]
fn add_custom_model(
    provider: String,
    api: String,
    baseurl: String,
    apikey: String,
    modelids: String,
    modelname: String,
) -> Result<(), String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let provider = provider.trim().to_string();
    let ids: Vec<String> = modelids
        .split(|c| c == ',' || c == '\n' || c == ';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if provider.is_empty() || ids.is_empty() {
        return Err("provider and at least one model id are required".to_string());
    }

    let dir = agent_config_directory()?;
    let path = dir.join("models.json");

    let mut root = read_config(&path)?;
    if !baseurl.trim().is_empty()
        && !(baseurl.starts_with("http://") || baseurl.starts_with("https://")) {
        return Err("Base URL must use HTTP or HTTPS.".into());
    }

    let obj = root.as_object_mut().ok_or("models.json is not an object")?;
    obj.entry("$schema")
        .or_insert_with(|| serde_json::json!("https://pi.dev/schemas/models.schema.json"));

    let providers = obj.entry("providers").or_insert_with(|| serde_json::json!({}));
    if !providers.is_object() {
        return Err("providers must be a JSON object; original file was not changed".into());
    }
    let providers_obj = providers.as_object_mut().ok_or("providers is not an object")?;
    let entry = providers_obj
        .entry(provider.clone())
        .or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        return Err("provider entry must be a JSON object; original file was not changed".into());
    }
    let entry_obj = entry.as_object_mut().ok_or("provider entry is not an object")?;
    if !baseurl.trim().is_empty() {
        entry_obj.insert("baseUrl".to_string(), serde_json::json!(baseurl.trim()));
    }
    if !api.trim().is_empty() {
        entry_obj.insert("api".to_string(), serde_json::json!(api.trim()));
    }
    if !apikey.trim().is_empty() {
        entry_obj.insert("apiKey".to_string(), serde_json::json!(apikey.trim()));
    }

    let models = entry_obj.entry("models").or_insert_with(|| serde_json::json!([]));
    if !models.is_array() {
        return Err("models must be an array; original file was not changed".into());
    }
    let models_arr = models.as_array_mut().ok_or("models is not an array")?;
    for id in &ids {
        if let Some(existing) = models_arr.iter_mut()
            .find(|model| model.get("id").and_then(|value| value.as_str()) == Some(id.as_str())) {
            if ids.len() == 1 && !modelname.trim().is_empty() {
                if let Some(object) = existing.as_object_mut() {
                    object.insert("name".into(), serde_json::json!(modelname.trim()));
                }
            }
            continue;
        }
        let mut m = serde_json::json!({ "id": id });
        if ids.len() == 1 && !modelname.trim().is_empty() {
            m.as_object_mut()
                .unwrap()
                .insert("name".to_string(), serde_json::json!(modelname.trim()));
        }
        models_arr.push(m);
    }

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    atomic_write(&path, pretty.as_bytes())?;
    model_management::unhide(&dir, &provider, &ids)?;
    Ok(())
}

/// Kept under the original command name for compatibility with earlier GUI builds.
fn delete_custom_model_at(home: &Path, provider: &str, modelid: &str) -> Result<(), String> {
    delete_custom_model_in(&home.join(".pi").join("agent"), provider, modelid)
}

fn delete_custom_model_in(directory: &Path, provider: &str, modelid: &str) -> Result<(), String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    model_management::remove(directory, provider, modelid)
}

#[tauri::command]
fn delete_custom_model(provider: String, modelid: String) -> Result<(), String> {
    let directory = agent_config_directory()?;
    delete_custom_model_in(&directory, &provider, &modelid)
}

#[derive(serde::Deserialize)]
struct ModelTarget { provider: String, id: String }

#[tauri::command]
fn delete_models(models: Vec<ModelTarget>) -> Result<usize, String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = agent_config_directory()?;
    let targets: Vec<_> = models.into_iter().map(|m| (m.provider, m.id)).collect();
    model_management::remove_many(&dir, &targets)
}

#[tauri::command]
fn get_model_edit_info(provider: String, modelid: String) -> Result<serde_json::Value, String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = agent_config_directory()?;
    model_management::edit_info(&dir, &provider, &modelid)
}

#[tauri::command]
fn edit_model(provider: String, originalid: String, modelid: String, modelname: String, api: String, baseurl: String, apikey: String) -> Result<(), String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = agent_config_directory()?;
    model_management::edit(&dir, &provider, &originalid, &modelid, &modelname, &api, &baseurl, &apikey)
}

#[tauri::command]
fn restore_removed_models() -> Result<(), String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = agent_config_directory()?;
    model_management::restore(&dir)
}

/// Install a pi package/extension from npm, git, a URL, or a local path.
/// Runs `pi install <source>` and returns the combined CLI output.
#[tauri::command]
async fn install_package(source: String, app: tauri::AppHandle) -> Result<String, String> {
    let runtime = resolve_runtime(&app)?;
    tauri::async_runtime::spawn_blocking(move || install_package_blocking(source, runtime))
        .await.map_err(|error| error.to_string())?
}

fn install_package_blocking(source: String, runtime: runtime::Runtime) -> Result<String, String> {
    let source = source.trim().to_string();
    if source.is_empty() || source.starts_with('-') || source.contains('\0') {
        return Err("source is required".to_string());
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let output = process_pi_command(&runtime.command(["install"]))
        .arg(&source)
        .current_dir(&home)
        .output()
        .map_err(|e| e.to_string())?;

    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    let err = String::from_utf8_lossy(&output.stderr);
    if !err.trim().is_empty() {
        if !text.is_empty() {
            text.push_str("\n");
        }
        text.push_str(&err);
    }
    let text = text.trim().to_string();
    if output.status.success() {
        Ok(text)
    } else if text.is_empty() {
        Err(format!("install failed (exit {:?})", output.status.code()))
    } else {
        Err(text)
    }
}

/// Read the current model persona (pi's APPEND_SYSTEM.md).
#[tauri::command]
fn read_persona() -> Result<String, String> {
    read_persona_at(&agent_config_directory()?.join("APPEND_SYSTEM.md"))
}

/// Save (or clear, when empty) the model persona to pi's APPEND_SYSTEM.md.
#[tauri::command]
fn save_persona(text: String) -> Result<(), String> {
    save_persona_at(&agent_config_directory()?.join("APPEND_SYSTEM.md"), &text)
}

const MAX_PERSONA_BYTES: usize = 48 * 1024;

fn read_persona_at(path: &Path) -> Result<String, String> {
    match std::fs::metadata(path) {
        Ok(metadata) if !metadata.is_file() => return Err("人设路径不是普通文件。".to_string()),
        Ok(metadata) if metadata.len() > MAX_PERSONA_BYTES as u64 => {
            return Err("模型人设不能超过 48 KB。".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error.to_string()),
    }
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    if text.len() > MAX_PERSONA_BYTES {
        return Err("模型人设不能超过 48 KB。".to_string());
    }
    Ok(text)
}

fn save_persona_at(path: &Path, text: &str) -> Result<(), String> {
    if text.len() > MAX_PERSONA_BYTES {
        return Err("模型人设不能超过 48 KB。".to_string());
    }
    if text.contains('\0') {
        return Err("模型人设包含不支持的空字符。".to_string());
    }
    if text.trim().is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        return Ok(());
    }
    atomic_write(path, text.as_bytes())
}

/// Read the user's pi keybindings overrides (~/.pi/agent/keybindings.json).
#[tauri::command]
fn read_keybindings() -> Result<serde_json::Value, String> {
    let path = agent_config_directory()?.join("keybindings.json");
    read_config(&path)
}

fn write_keybindings(root: &serde_json::Value) -> Result<(), String> {
    let path = agent_config_directory()?.join("keybindings.json");
    let pretty = serde_json::to_string_pretty(root).map_err(|e| e.to_string())?;
    atomic_write(&path, pretty.as_bytes())
}

/// Set one action's binding in ~/.pi/agent/keybindings.json.
#[tauri::command]
fn set_keybinding(action: String, keys: Vec<String>) -> Result<(), String> {
    let path = agent_config_directory()?.join("keybindings.json");
    let mut root = read_config(&path)?;
    let obj = root.as_object_mut().ok_or("keybindings.json is not an object")?;
    let value = if keys.len() == 1 {
        serde_json::json!(keys[0])
    } else {
        serde_json::json!(keys)
    };
    obj.insert(action, value);
    write_keybindings(&root)
}

/// Remove one action's override so the default applies again.
#[tauri::command]
fn reset_keybinding(action: String) -> Result<(), String> {
    let path = agent_config_directory()?.join("keybindings.json");
    let mut root = read_config(&path)?;
    if let Some(obj) = root.as_object_mut() {
        obj.remove(&action);
    }
    write_keybindings(&root)
}

#[tauri::command]
fn log_debug(msg: String) {
    use std::fs::OpenOptions;
    if msg.len() > 8192 { return; }
    if let Ok(home) = std::env::var("HOME") {
        let path = format!("{home}/.pi_app_debug.log");
        if let Ok(meta) = std::fs::symlink_metadata(&path) {
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 { return; }
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        if let Ok(mut f) = options.open(path) {
            let _ = writeln!(f, "{}", privacy::redact(&msg));
        }
    }
}

#[tauri::command]
async fn export_terminal_log(text: String, filename: String) -> Result<String, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let directory = PathBuf::from(home).join("Downloads");
    tauri::async_runtime::spawn_blocking(move || export_terminal_log_at(&directory, &text, &filename))
        .await.map_err(|error| error.to_string())?
}

fn export_terminal_log_at(directory: &Path, text: &str, filename: &str) -> Result<String, String> {
    if text.len() > 50 * 1024 * 1024
        || !filename.starts_with("pi-terminal-")
        || !filename.ends_with(".txt")
        || !filename.chars().all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err("Invalid log filename or file too large.".into());
    }
    let path = directory.join(filename);
    atomic_write(&path, privacy::redact_full(text).as_bytes())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn export_usage_log(text: String, format: String) -> Result<String, String> {
    if text.len() > 524288 || !matches!(format.as_str(), "csv" | "json") {
        return Err("Invalid usage export format or size.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
        let directory = PathBuf::from(home).join("Downloads");
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?.as_nanos();
        let path = directory.join(format!("easy_pi-usage-{stamp}.{format}"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|error| error.to_string())?;
        if let Err(error) = file.write_all(text.as_bytes()).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(error.to_string());
        }
        Ok(path.to_string_lossy().into_owned())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn write_terminal(data: String, state: State<AppState>) -> Result<(), String> {
    let guard = state.term.lock().map_err(|error| error.to_string())?;
    if let Some(ts) = guard.as_ref() {
        ts.writer
            .send(data.into_bytes())
            .map_err(|_| "Terminal is not connected".to_string())
    } else {
        Err("Terminal is not connected".into())
    }
}

#[tauri::command]
fn resize_terminal(rows: u16, cols: u16, state: State<AppState>) -> Result<(), String> {
    if rows == 0 || cols == 0 {
        return Err("Terminal dimensions must be greater than zero".into());
    }
    let mut guard = state.term.lock().map_err(|error| error.to_string())?;
    if let Some(ts) = guard.as_mut() {
        ts.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_home();
    tauri::Builder::default()
        .manage(ExitState::default())
        .manage(std::sync::Arc::new(skill_service::SkillService::default()))
        .manage(AppState {
            term: std::sync::Arc::new(Mutex::new(None)),
            claude: std::sync::Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            start_terminal,
            stop_terminal,
            validate_terminal_target,
            gui_action,
            gui_status,
            probe_claude,
            start_claude,
            stop_claude,
            claude_action,
            skill_store_action,
            skill_store_restart,
            run_diagnostics,
            workbench::choose_workspace,
            workbench::choose_attachments,
            workbench::store_image_attachment,
            workbench::list_sessions,
            workbench::list_workspace_files,
            workbench::search_workspace_files,
            workbench::read_workspace_file,
            workbench::reveal_workspace_file,
            workbench::save_workspace_file,
            workbench::git_changes,
            workbench::git_diff,
            workbench::git_stage,
            get_runtime_info,
            write_terminal,
            resize_terminal,
            list_models,
            save_model_provider,
            create_model_provider,
            add_custom_model,
            delete_custom_model,
            delete_models,
            get_model_edit_info,
            edit_model,
            restore_removed_models,
            install_package,
            read_persona,
            save_persona,
            read_keybindings,
            set_keybinding,
            reset_keybinding,
            export_terminal_log,
            export_usage_log,
            log_debug
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                use std::sync::atomic::Ordering;
                let exit = std::sync::Arc::clone(&app.state::<ExitState>().0);
                if exit.load(Ordering::SeqCst) == 2 { return; }
                api.prevent_exit();
                if exit.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_err() { return; }
                let skills = std::sync::Arc::clone(app.state::<std::sync::Arc<skill_service::SkillService>>().inner());
                let terminal = std::sync::Arc::clone(&app.state::<AppState>().term);
                let claude = std::sync::Arc::clone(&app.state::<AppState>().claude);
                let handle = app.clone();
                // Keep the event loop alive until owned resources are cleaned up.
                std::thread::spawn(move || {
                    if let Ok(Some(terminal)) = terminal_lifecycle::take_for_stop(&terminal, |_| Ok(())) {
                        drop(terminal.into_inner());
                    }
                    // Detach the sidecar from AppState before waiting for its
                    // bounded shutdown, so no poisoned/held lock can delay exit.
                    let runtime = match claude.lock() {
                        Ok(mut guard) => guard.take(),
                        Err(poisoned) => poisoned.into_inner().take(),
                    };
                    if let Some(runtime) = runtime {
                        runtime.close();
                    }
                    skills.shutdown();
                    exit.store(2, Ordering::SeqCst);
                    handle.exit(code.unwrap_or(0));
                });
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_diagnostics_explain_unavailable_bridge_and_input_as_dependent_states() {
        let stopped = pi_process_diagnostic_rows(false, false, false);
        assert_eq!(stopped[0].1, false);
        assert_eq!(stopped[1].2, "Pi 未运行；桥接会在启动后建立");
        assert_eq!(stopped[2].2, "Pi 启动后才能检查输入状态");

        let bridge_pending = pi_process_diagnostic_rows(true, false, false);
        assert_eq!(bridge_pending[0].1, true);
        assert!(bridge_pending[1].2.contains("尚未连接"));
        assert!(bridge_pending[2].2.contains("等待输入桥接"));

        let ready = pi_process_diagnostic_rows(true, true, true);
        assert!(ready.iter().all(|row| row.1));
        assert_eq!(ready[2].2, "可输入");
    }

    #[test]
    fn windows_git_is_found_in_standard_install_directories_without_path() {
        let root = scratch();
        let program_files = root.join("Program Files");
        let git = program_files.join("Git/cmd/git.exe");
        std::fs::create_dir_all(git.parent().unwrap()).unwrap();
        std::fs::write(&git, b"fixture").unwrap();
        assert_eq!(find_windows_git(Some(&program_files), None, None), Some(git));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminal_environment_drops_unrelated_inherited_credentials() {
        let mut command = CommandBuilder::new("pi");
        command.env("PRIVATE_SESSION_CREDENTIAL", "must-not-propagate");
        pass_env(&mut command);
        assert!(command.get_env("PRIVATE_SESSION_CREDENTIAL").is_none());
        assert_eq!(command.get_env("TERM"), Some(std::ffi::OsStr::new("xterm-256color")));
        assert!(command.get_env("PATH").is_some());
    }

    #[test]
    fn session_restore_requires_matching_workspace_and_valid_header() {
        let root = scratch().canonicalize().unwrap();
        let session = root.join("session.jsonl");
        std::fs::write(&session, serde_json::json!({"type":"session","cwd":root}).to_string()).unwrap();
        assert!(workbench::validate_session_workspace(&session, &root).is_ok());
        std::fs::create_dir(root.join("other")).unwrap();
        assert!(workbench::validate_session_workspace(&session, &root.join("other")).is_err());
        std::fs::write(&session, "broken").unwrap();
        assert!(workbench::validate_session_workspace(&session, &root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    pub(crate) fn scratch() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("pi-gui-test-{}-{stamp}-{sequence}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn terminal_log_export_preserves_long_unicode_logs_and_redacts_credentials() {
        let directory = scratch();
        let text = format!("{}DB_PASSWORD=\"first secret second secret\"\nfinal-output-marker\n", "日志 output\n".repeat(1000));
        let filename = "pi-terminal-test.txt";
        let path = PathBuf::from(export_terminal_log_at(&directory, &text, filename).unwrap());
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.chars().count() > 4096);
        assert!(saved.ends_with("final-output-marker\n"));
        assert!(!saved.contains("first secret"));
        assert!(!saved.contains("second secret"));
        assert_eq!(saved.lines().count(), text.lines().count());
        assert!(export_terminal_log_at(&directory, "bad", "../pi-terminal-escape.txt").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn git_probe_bounds_a_hanging_helper_without_leaking_the_test_process() {
        let started = std::time::Instant::now();
        let ok = git_probe(
            {
                let mut command = std::process::Command::new("/bin/sh");
                command.args(["-c", "sleep 5"]);
                command
            },
            std::time::Duration::from_millis(40),
        );
        assert!(!ok);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn normal_stop_preserves_busy_and_draft_protection() {
        assert!(validate_terminal_stop(Some(&serde_json::json!({"busy": true}))).is_err());
        assert!(validate_terminal_stop(Some(&serde_json::json!({"nativeDraft": true}))).is_err());
        assert!(validate_terminal_stop(Some(&serde_json::json!({"busy": false, "nativeDraft": false}))).is_ok());
        // Only the explicit force path omits bridge status validation.
        assert!(validate_terminal_stop(None).is_ok());
    }

    #[test]
    fn rejects_corrupt_config_without_overwriting() {
        let dir = scratch();
        let path = dir.join("models.json");
        std::fs::write(&path, "{not json").unwrap();
        assert!(read_config(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_replaces_and_keeps_private_permissions() {
        let dir = scratch();
        let path = dir.join("models.json");
        atomic_write(&path, b"{\"old\":true}").unwrap();
        atomic_write(&path, b"{\"new\":true}").unwrap();
        assert_eq!(read_config(&path).unwrap()["new"], true);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn persona_save_is_bounded_preserves_previous_data_on_failure_and_clears() {
        let dir = scratch();
        let path = dir.join("APPEND_SYSTEM.md");
        save_persona_at(&path, "A focused coding persona").unwrap();
        assert_eq!(read_persona_at(&path).unwrap(), "A focused coding persona");
        let oversized = "x".repeat(MAX_PERSONA_BYTES + 1);
        assert!(save_persona_at(&path, &oversized).is_err());
        assert_eq!(read_persona_at(&path).unwrap(), "A focused coding persona");
        std::fs::write(&path, &oversized).unwrap();
        assert!(read_persona_at(&path).is_err());
        save_persona_at(&path, "").unwrap();
        assert_eq!(read_persona_at(&path).unwrap(), "");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_config_defaults_to_an_object() {
        let dir = scratch();
        assert_eq!(read_config(&dir.join("missing.json")).unwrap(), serde_json::json!({}));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn arrays_are_not_accepted_as_configuration_objects() {
        let dir = scratch();
        let path = dir.join("keybindings.json");
        std::fs::write(&path, "[]").unwrap();
        assert!(read_config(&path).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn custom_model_delete_rewrites_only_user_models() {
        let dir = scratch();
        let path = dir.join(".pi/agent/models.json");
        let settings = dir.join(".pi/agent/settings.json");
        let root = serde_json::json!({"providers":{"custom":{"apiKey":"keep-secret","baseUrl":"https://example.test","models":[{"id":"keep"},{"id":"remove"}]},"other":{"models":[{"id":"stay"}]}}});
        atomic_write(&path, serde_json::to_string_pretty(&root).unwrap().as_bytes()).unwrap();
        atomic_write(&settings, br#"{"defaultProvider":"custom","defaultModel":"remove","other":true}"#).unwrap();
        delete_custom_model_at(&dir, "custom", "remove").unwrap();
        let saved = read_config(&path).unwrap();
        assert_eq!(saved["providers"]["custom"]["apiKey"], "keep-secret");
        assert_eq!(saved["providers"]["custom"]["models"][0]["id"], "keep");
        assert_eq!(saved["providers"]["other"]["models"][0]["id"], "stay");
        let updated = read_config(&settings).unwrap();
        assert!(updated.get("defaultProvider").is_none());
        assert_eq!(updated["other"], true);
        assert!(delete_custom_model_at(&dir, "custom", "missing").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn last_model_delete_keeps_provider_and_rejects_corrupt_settings() {
        let dir = scratch();
        let path = dir.join(".pi/agent/models.json");
        let settings = dir.join(".pi/agent/settings.json");
        let original = br#"{"providers":{"relay":{"apiKey":"secret","baseUrl":"https://example.test","models":[{"id":"namespace/test"}]}}}"#;
        atomic_write(&path, original).unwrap();
        atomic_write(&settings, b"broken json").unwrap();
        assert!(delete_custom_model_at(&dir, "relay", "namespace/test").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_file(&settings).unwrap();
        delete_custom_model_at(&dir, "relay", "namespace/test").unwrap();
        let saved = read_config(&path).unwrap();
        assert_eq!(saved["providers"]["relay"]["apiKey"], "secret");
        assert_eq!(saved["providers"]["relay"]["baseUrl"], "https://example.test");
        assert_eq!(saved["providers"]["relay"]["models"], serde_json::json!([]));
        assert!(!settings.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn custom_catalog_duplicate_is_removed_from_both_sources() {
        let dir = scratch();
        let config = dir.join(".pi/agent");
        atomic_write(&config.join("models-store.json"), br#"{"relay":{"etag":"keep-etag","models":[{"id":"same","name":"Catalog"}]}}"#).unwrap();
        atomic_write(&config.join("models.json"), br#"{"providers":{"relay":{"apiKey":"secret","models":[{"id":"same"}]}}}"#).unwrap();
        let before = list_models_at(&config).unwrap();
        assert_eq!(before["models"].as_array().unwrap().len(), 1);
        assert_eq!(before["models"][0]["deletable"], true);
        delete_custom_model_at(&dir, "relay", "same").unwrap();
        assert!(list_models_at(&config).unwrap()["models"].as_array().unwrap().is_empty());
        assert_eq!(read_config(&config.join("models-store.json")).unwrap()["relay"]["etag"], "keep-etag");
        assert_eq!(read_config(&config.join("models.json")).unwrap()["providers"]["relay"]["apiKey"], "secret");
        delete_custom_model_at(&dir, "relay", "same").unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn finds_executable_in_the_user_local_bin() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        let bin = dir.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = bin.join("pi");
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(find_pi(&dir, None), Some(path));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
