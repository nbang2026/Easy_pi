use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{Manager, State};
mod gui_bridge;
mod model_management;
mod runtime;
mod workbench;

struct TerminalState {
    master: Box<dyn MasterPty + Send>,
    // Input goes through a dedicated thread so a stalled PTY never blocks the UI thread or the state lock,
    // while keystrokes keep their original order.
    writer: std::sync::mpsc::Sender<Vec<u8>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    bridge: std::sync::Arc<gui_bridge::GuiBridge>,
    cwd: PathBuf,
}

impl Drop for TerminalState {
    fn drop(&mut self) {
        self.bridge.close();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct AppState {
    term: Mutex<Option<TerminalState>>,
}

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
    for (k, v) in std::env::vars() {
        if k == "TERM"
            || k == "PATH"
            || k == "HOME"
            || k == "LANG"
            || k == "LC_ALL"
            || k == "SHELL"
            || k == "TMPDIR"
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
    let session = session.map(|path| workbench::session_path(&path)).transpose()?;
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
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
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

    *guard = Some(TerminalState {
        master: pair.master,
        writer: input,
        child,
        bridge,
        cwd: cwd.clone(),
    });
    Ok(serde_json::json!({
        "cwd": cwd.to_string_lossy(),
        "executable": runtime.executable().to_string_lossy(),
        "bridgeId": guard.as_ref().unwrap().bridge.id(),
    }))
}

#[tauri::command]
fn stop_terminal(state: State<AppState>) -> Result<(), String> {
    let mut guard = state.term.lock().map_err(|e| e.to_string())?;
    if let Some(terminal) = guard.as_ref() {
        let status = terminal.bridge.status();
        if status["busy"] == true || status["nativeDraft"] == true {
            return Err("请先停止当前任务并处理终端草稿，再切换工作区或会话。".into());
        }
    }
    guard.take();
    Ok(())
}

#[tauri::command]
fn validate_terminal_target(cwd: String, session: Option<String>) -> Result<(), String> {
    workbench::workspace_root(Some(&cwd))?;
    if let Some(path) = session { workbench::session_path(&path)?; }
    Ok(())
}

#[tauri::command]
fn gui_status(state: State<AppState>) -> Result<serde_json::Value, String> {
    let guard = state.term.lock().map_err(|e| e.to_string())?;
    Ok(guard.as_ref().map(|term| term.bridge.status())
        .unwrap_or_else(|| serde_json::json!({"ready": false, "busy": false, "connected": false})))
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

#[tauri::command]
fn run_diagnostics(app: tauri::AppHandle, state: State<AppState>) -> serde_json::Value {
    let guard = state.term.lock().ok();
    let terminal = guard.as_ref().and_then(|guard| guard.as_ref());
    let cwd = terminal.map(|term| term.cwd.clone()).unwrap_or_else(|| workbench::workspace_root(None).unwrap_or_default());
    let bridge = terminal.map(|term| term.bridge.status()).unwrap_or(serde_json::json!({"connected": false, "ready": false}));
    let pi = resolve_runtime(&app);
    let git = std::process::Command::new("git").arg("--version").output().map(|output| output.status.success()).unwrap_or(false);
    serde_json::json!({
        "checkedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
        "checks": [
            {"name": "Pi CLI", "ok": pi.is_ok(), "detail": pi.map(|runtime| runtime.executable().to_string_lossy().into_owned()).unwrap_or_else(|e| e)},
            {"name": "工作区", "ok": cwd.is_dir(), "detail": cwd.to_string_lossy()},
            {"name": "Pi 进程", "ok": terminal.is_some(), "detail": if terminal.is_some() { "已启动" } else { "未连接" }},
            {"name": "输入桥接", "ok": bridge["connected"] == true, "detail": if bridge["connected"] == true { "已连接" } else { "尚未连接，可使用终端输入" }},
            {"name": "输入状态", "ok": bridge["ready"] == true, "detail": if bridge["ready"] == true { "可输入" } else { "弹窗打开或输入尚未就绪" }},
            {"name": "Git", "ok": git, "detail": if git { "已安装" } else { "未安装，审阅暂不可用" }},
        ]
    })
}

/// List the models configured for pi (from ~/.pi/agent/models-store.json),
/// limited to providers the user has credentials for, plus the current default.
#[tauri::command]
fn list_models() -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    list_models_at(&PathBuf::from(home).join(".pi/agent"))
}

fn list_models_at(directory: &Path) -> Result<serde_json::Value, String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    model_management::list(directory)
}

static MODEL_CONFIG_LOCK: Mutex<()> = Mutex::new(());

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

    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = format!("{home}/.pi/agent");
    let path = format!("{dir}/models.json");

    let mut root = read_config(Path::new(&path))?;
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
    atomic_write(Path::new(&path), pretty.as_bytes())?;
    model_management::unhide(&PathBuf::from(home).join(".pi/agent"), &provider, &ids)?;
    Ok(())
}

/// Kept under the original command name for compatibility with earlier GUI builds.
fn delete_custom_model_at(home: &Path, provider: &str, modelid: &str) -> Result<(), String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    model_management::remove(&home.join(".pi/agent"), provider, modelid)
}

#[tauri::command]
fn delete_custom_model(provider: String, modelid: String) -> Result<(), String> {
    let home = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?);
    delete_custom_model_at(&home, &provider, &modelid)
}

#[derive(serde::Deserialize)]
struct ModelTarget { provider: String, id: String }

#[tauri::command]
fn delete_models(models: Vec<ModelTarget>) -> Result<usize, String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?).join(".pi/agent");
    let targets: Vec<_> = models.into_iter().map(|m| (m.provider, m.id)).collect();
    model_management::remove_many(&dir, &targets)
}

#[tauri::command]
fn get_model_edit_info(provider: String, modelid: String) -> Result<serde_json::Value, String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?).join(".pi/agent");
    model_management::edit_info(&dir, &provider, &modelid)
}

#[tauri::command]
fn edit_model(provider: String, originalid: String, modelid: String, modelname: String, api: String, baseurl: String, apikey: String) -> Result<(), String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?).join(".pi/agent");
    model_management::edit(&dir, &provider, &originalid, &modelid, &modelname, &api, &baseurl, &apikey)
}

#[tauri::command]
fn restore_removed_models() -> Result<(), String> {
    let _guard = MODEL_CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?).join(".pi/agent");
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
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = format!("{home}/.pi/agent/APPEND_SYSTEM.md");
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

/// Save (or clear, when empty) the model persona to pi's APPEND_SYSTEM.md.
#[tauri::command]
fn save_persona(text: String) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = format!("{home}/.pi/agent");
    let path = format!("{dir}/APPEND_SYSTEM.md");
    if text.trim().is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        return Ok(());
    }
    atomic_write(Path::new(&path), text.as_bytes())
}

/// Read the user's pi keybindings overrides (~/.pi/agent/keybindings.json).
#[tauri::command]
fn read_keybindings() -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = format!("{home}/.pi/agent/keybindings.json");
    read_config(Path::new(&path))
}

fn write_keybindings(root: &serde_json::Value) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = format!("{home}/.pi/agent");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = format!("{dir}/keybindings.json");
    let pretty = serde_json::to_string_pretty(root).map_err(|e| e.to_string())?;
    atomic_write(Path::new(&path), pretty.as_bytes())
}

/// Set one action's binding in ~/.pi/agent/keybindings.json.
#[tauri::command]
fn set_keybinding(action: String, keys: Vec<String>) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = format!("{home}/.pi/agent/keybindings.json");
    let mut root = read_config(Path::new(&path))?;
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
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = format!("{home}/.pi/agent/keybindings.json");
    let mut root = read_config(Path::new(&path))?;
    if let Some(obj) = root.as_object_mut() {
        obj.remove(&action);
    }
    write_keybindings(&root)
}

#[tauri::command]
fn log_debug(msg: String) {
    use std::fs::OpenOptions;
    if let Ok(home) = std::env::var("HOME") {
        let path = format!("{home}/.pi_app_debug.log");
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{msg}");
        }
    }
}

#[tauri::command]
fn export_terminal_log(text: String, filename: String) -> Result<String, String> {
    if text.len() > 50 * 1024 * 1024
        || !filename.starts_with("pi-terminal-")
        || !filename.ends_with(".txt")
        || !filename.chars().all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err("Invalid log filename or file too large.".into());
    }
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let path = PathBuf::from(home).join("Downloads").join(filename);
    atomic_write(&path, text.as_bytes())?;
    Ok(path.to_string_lossy().into_owned())
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
        .manage(AppState {
            term: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            start_terminal,
            stop_terminal,
            validate_terminal_target,
            gui_action,
            gui_status,
            run_diagnostics,
            workbench::choose_workspace,
            workbench::choose_attachments,
            workbench::store_image_attachment,
            workbench::list_sessions,
            workbench::list_workspace_files,
            workbench::search_workspace_files,
            workbench::read_workspace_file,
            workbench::save_workspace_file,
            workbench::git_changes,
            workbench::git_diff,
            workbench::git_stage,
            get_runtime_info,
            write_terminal,
            resize_terminal,
            list_models,
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
            log_debug
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Ok(mut terminal) = app.state::<AppState>().term.lock() {
                    terminal.take();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn scratch() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("pi-gui-test-{}-{stamp}-{sequence}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
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
