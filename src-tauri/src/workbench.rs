use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use serde_json::{json, Value};

pub fn workspace_root(path: Option<&str>) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let value = path.filter(|value| !value.is_empty()).unwrap_or(&home);
    let value = if value == "~" { home } else if value.starts_with("~/") { format!("{home}/{}", &value[2..]) } else { value.to_owned() };
    let root = PathBuf::from(value).canonicalize().map_err(|e| format!("工作区不可用: {e}"))?;
    if !root.is_dir() { return Err("工作区必须是文件夹。".into()); }
    Ok(root)
}

fn scoped_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let path = Path::new(relative);
    if path.components().any(|part| !matches!(part, Component::Normal(_) | Component::CurDir)) {
        return Err("文件路径超出工作区。".into());
    }
    let resolved = root.join(path).canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) { return Err("链接指向工作区之外，无法访问。".into()); }
    Ok(resolved)
}

fn sessions_root() -> Result<PathBuf, String> {
    Ok(crate::agent_config_directory()?.join("sessions"))
}

pub fn session_path(path: &str) -> Result<PathBuf, String> {
    let root = sessions_root()?.canonicalize().map_err(|e| e.to_string())?;
    let path = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(&root) || path.extension().is_none_or(|ext| ext != "jsonl") || !path.is_file() {
        return Err("会话文件必须来自 Pi 的会话目录。".into());
    }
    Ok(path)
}

pub(crate) fn validate_session_workspace(path: &Path, workspace: &Path) -> Result<(), String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut header = Vec::new();
    BufReader::new(file).take(65537).read_until(b'\n', &mut header).map_err(|error| error.to_string())?;
    if header.len() > 65536 { return Err("会话头部过大，原文件已保留。".into()); }
    let value: Value = serde_json::from_slice(&header).map_err(|_| "会话头部损坏，原文件已保留。")?;
    let origin = value["cwd"].as_str().ok_or("会话缺少工作区信息。")?;
    if value["type"] != "session" || Path::new(origin).canonicalize().ok().as_deref() != Some(workspace) {
        return Err("会话所属工作区与当前选择不一致；请从会话列表打开原工作区。".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn choose_workspace() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
        let result = Command::new("/usr/bin/osascript")
            .args(["-e", "try", "-e", "POSIX path of (choose folder with prompt \"选择 Pi 工作区\")", "-e", "on error number -128", "-e", "\"\"", "-e", "end try"])
            .output().map_err(|e| e.to_string())?;
        if !result.status.success() { return Err("文件夹选择器未能打开。".into()); }
        let path = String::from_utf8_lossy(&result.stdout).trim().to_owned();
        if path.is_empty() { Ok(None) } else { Ok(Some(workspace_root(Some(&path))?.to_string_lossy().into_owned())) }
        }
        #[cfg(windows)]
        {
            let script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Select Pi workspace'; if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}";
            let result = Command::new("powershell.exe").args(["-NoProfile", "-STA", "-Command", script]).output().map_err(|e| e.to_string())?;
            if !result.status.success() { return Err("文件夹选择器未能打开。".into()); }
            let path = String::from_utf8_lossy(&result.stdout).trim().to_owned();
            if path.is_empty() { Ok(None) } else { Ok(Some(workspace_root(Some(&path))?.to_string_lossy().into_owned())) }
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        { Err("当前系统尚未提供原生文件夹选择器。".into()) }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn choose_attachments() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
        let script = r#"const app = Application.currentApplication(); app.includeStandardAdditions = true;
try { JSON.stringify(app.chooseFile({withPrompt: "选择 Pi 附件", multipleSelectionsAllowed: true}).map(p => p.toString())); }
catch (e) { if (e.errorNumber === -128) "[]"; else throw e; }"#;
        let output = Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", script]).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err("附件选择器未能打开。".into()); }
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
        }
        #[cfg(windows)]
        {
            let script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect=$true; $d.Title='Select Pi attachments'; if($d.ShowDialog() -eq 'OK'){$d.FileNames | ConvertTo-Json -Compress}";
            let output = Command::new("powershell.exe").args(["-NoProfile", "-STA", "-Command", script]).output().map_err(|e| e.to_string())?;
            if !output.status.success() { return Err("附件选择器未能打开。".into()); }
            let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if text.is_empty() { return Ok(Vec::new()); }
            let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            Ok(match value { Value::String(path) => vec![path], Value::Array(paths) => paths.into_iter().filter_map(|path| path.as_str().map(str::to_owned)).collect(), _ => Vec::new() })
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        { Err("当前系统尚未提供原生附件选择器。".into()) }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn store_image_attachment(bytes: Vec<u8>, app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 { return Err("图片不能超过 8 MB。".into()); }
    let extension = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { "png" }
        else if bytes.starts_with(b"\xff\xd8\xff") { "jpg" }
        else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { "gif" }
        else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { "webp" }
        else { return Err("仅支持 PNG、JPEG、GIF 和 WebP 图片。".into()); };
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("attachments");
    tauri::async_runtime::spawn_blocking(move || {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        let path = cache.join(format!("paste-{}-{stamp}.{extension}", std::process::id()));
        super::atomic_write(&path, &bytes)?;
        Ok(path.to_string_lossy().into_owned())
    }).await.map_err(|e| e.to_string())?
}

fn collect_sessions(root: &Path, files: &mut Vec<(u64, PathBuf)>, depth: u8) {
    if depth > 2 || files.len() > 10000 { return; }
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let kind = match entry.file_type() { Ok(kind) => kind, Err(_) => continue };
            let path = entry.path();
            if kind.is_dir() { collect_sessions(&path, files, depth + 1); }
            else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
                let modified = entry.metadata().ok().and_then(|m| m.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                files.push((modified, path));
            }
        }
    }
}

fn session_summary(path: &Path, modified: u64) -> Result<Value, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut lines = BufReader::new(file.take(16 * 1024 * 1024)).lines();
    let header: Value = serde_json::from_str(&lines.next().ok_or("Empty session")?.map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if header["type"] != "session" { return Err("Invalid session header".into()); }
    let mut title = String::new();
    let mut name = String::new();
    for line in lines {
        let value: Value = match line.ok().and_then(|text| serde_json::from_str(&text).ok()) { Some(value) => value, None => continue };
        if value["type"] == "session_info" {
            if let Some(value) = value["name"].as_str() { name = value.to_owned(); }
        }
        if title.is_empty() && value["type"] == "message" && value["message"]["role"] == "user" {
            if let Some(content) = value["message"]["content"].as_array() {
                title = content.iter().filter_map(|item| item["text"].as_str()).collect::<Vec<_>>().join(" ");
            } else if let Some(content) = value["message"]["content"].as_str() { title = content.to_owned(); }
        }
    }
    let title = if !name.is_empty() { name } else if !title.is_empty() { title } else { "新会话".into() };
    Ok(json!({
        "path": path.to_string_lossy(), "id": header["id"], "cwd": header["cwd"],
        "title": title.lines().next().unwrap_or("新会话").chars().take(100).collect::<String>(),
        "modified": modified,
    }))
}

#[tauri::command]
pub async fn list_sessions() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut files = Vec::new();
        collect_sessions(&sessions_root()?, &mut files, 0);
        files.sort_by(|a, b| b.0.cmp(&a.0));
        let sessions: Vec<_> = files.iter().take(150).filter_map(|(time, path)| session_summary(path, *time).ok()).collect();
        Ok(json!({"sessions": sessions, "truncated": files.len() > 150}))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_workspace_files(root: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(Some(&root))?;
        let directory = scoped_path(&root, &path)?;
        if !directory.is_dir() { return Err("此路径不是目录。".into()); }
        let mut files = Vec::new();
        for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())?.flatten().take(2000) {
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() || entry.file_name() == ".git" { continue; }
            files.push(json!({
                "name": entry.file_name().to_string_lossy(), "directory": kind.is_dir(),
                "path": entry.path().strip_prefix(&root).map_err(|e| e.to_string())?.to_string_lossy(),
            }));
        }
        files.sort_by(|a, b| b["directory"].as_bool().cmp(&a["directory"].as_bool())
            .then(a["name"].as_str().cmp(&b["name"].as_str())));
        Ok(json!(files))
    }).await.map_err(|e| e.to_string())?
}

fn walk_files(root: &Path, directory: &Path, files: &mut Vec<String>, depth: usize) {
    if depth > 8 || files.len() >= 20000 { return; }
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.flatten() {
            if files.len() >= 20000 { break; }
            let kind = match entry.file_type() { Ok(kind) => kind, Err(_) => continue };
            if kind.is_symlink() { continue; }
            if kind.is_dir() {
                if matches!(entry.file_name().to_str(), Some(".git" | "node_modules" | "target" | "dist" | ".cache" | "Library" | ".Trash")) { continue; }
                walk_files(root, &entry.path(), files, depth + 1);
            } else if kind.is_file() {
                if let Ok(relative) = entry.path().strip_prefix(root) { files.push(relative.to_string_lossy().into_owned()); }
            }
        }
    }
}

fn git(root: &Path, arguments: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new(super::git_executable());
    clear_git_environment(&mut command);
    #[cfg(test)]
    {
        // Tests use only their disposable repository, never the user's Git config.
        command.env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .env("GIT_CONFIG_NOSYSTEM", "1");
    }
    command.arg("--no-pager").arg("--literal-pathspecs").arg("-c").arg("core.fsmonitor=false")
        .arg("-C").arg(root).args(arguments);
    git_output(&mut command, std::time::Duration::from_secs(10))
}

fn clear_git_environment(command: &mut Command) {
    // Preserve ordinary user configuration, but discard overrides injected by
    // the GUI's launching process before choosing a repository or index.
    let keys: Vec<_> = std::env::vars_os().map(|(key, _)| key)
        .chain(command.get_envs().map(|(key, _)| key.to_os_string())).collect();
    for key in keys {
        if key.to_string_lossy().to_ascii_uppercase().starts_with("GIT_") { command.env_remove(key); }
    }
}

fn git_output(command: &mut Command, timeout: std::time::Duration) -> Result<Vec<u8>, String> {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + timeout;
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("Git 不可用: {e}"))?;
    let (sender, receiver) = mpsc::channel();
    for (kind, stream, limit) in [
        (true, Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>, 2 * 1024 * 1024),
        (false, Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>, 16384),
    ] {
        let sender = sender.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stream.take(limit + 1).read_to_end(&mut bytes).map(|_| bytes);
            let _ = sender.send((kind, result, limit as usize));
        });
    }
    drop(sender);
    let result = (|| {
        let mut output = None;
        let mut errors = None;
        let mut exit = None;
        while Instant::now() < deadline {
            while let Ok((stdout, bytes, limit)) = receiver.try_recv() {
                let bytes = bytes.map_err(|e| e.to_string())?;
                if bytes.len() > limit { return Err("Git 输出超过限制，请缩小审阅范围。".into()); }
                if stdout { output = Some(bytes); } else { errors = Some(bytes); }
            }
            if exit.is_none() { exit = child.try_wait().map_err(|e| e.to_string())?; }
            if let (Some(status), Some(output), Some(errors)) = (&exit, &output, &errors) {
                return if status.success() { Ok(output.clone()) } else { Err(String::from_utf8_lossy(errors).trim().to_owned()) };
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err("Git 操作超时，已停止等待。请检查仓库后重试；写入操作可能已完成，请先刷新状态。".into())
    })();
    if result.is_err() {
        let _ = child.kill();
        // A descendant may keep an inherited pipe open. Reaping runs independently
        // and pipe-reader threads are never joined on the caller's deadline.
        std::thread::spawn(move || { let _ = child.wait(); });
    }
    result
}

#[tauri::command]
pub async fn search_workspace_files(root: String, query: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(Some(&root))?;
        let mut files = match git(&root, &["ls-files", "--cached", "--others", "--exclude-standard", "-z"]) {
            Ok(bytes) => bytes.split(|byte| *byte == 0).filter(|part| !part.is_empty())
                .filter_map(|part| std::str::from_utf8(part).ok().map(str::to_owned)).take(20000).collect(),
            Err(_) => { let mut files = Vec::new(); walk_files(&root, &root, &mut files, 0); files }
        };
        files.sort();
        files.dedup();
        let query = query.to_lowercase();
        let matches: Vec<_> = files.iter().filter(|path| path.to_lowercase().contains(&query)).take(100).cloned().collect();
        Ok(json!({"files": matches, "truncated": files.len() >= 20000}))
    }).await.map_err(|e| e.to_string())?
}

fn read_text(path: &Path) -> Result<String, String> {
    if !path.is_file() { return Err("此路径不是文件。".into()); }
    let mut bytes = Vec::new();
    std::fs::File::open(path).map_err(|e| e.to_string())?.take(512 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > 512 * 1024 { return Err("文件超过 512 KB，请用外部编辑器打开。".into()); }
    if bytes.contains(&0) { return Err("二进制文件不能在文本编辑器中打开。".into()); }
    String::from_utf8(bytes).map_err(|_| "该文件不是 UTF-8 文本。".into())
}

fn revision(text: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn artifact_file(root: &Path, path: &str) -> Result<PathBuf, String> {
        let root = root.canonicalize().map_err(|error| error.to_string())?;
        let file = scoped_path(&root, path)?;
        let relative = file.strip_prefix(&root).map_err(|_| "文件路径超出工作区。")?;
        if relative.components().any(|part| {
            let name = part.as_os_str().to_string_lossy().to_lowercase();
            matches!(name.as_str(), ".git" | ".ssh" | ".aws" | ".azure" | ".gnupg" | ".codex" | ".pi" | ".claude" | ".npmrc" | ".netrc" | "credential" | "credentials" | "secret" | "secrets" | "id_rsa" | "id_ed25519")
                || name == ".env" || name.starts_with(".env.") || name.starts_with("credential.") || name.starts_with("credentials.") || name.starts_with("secret.") || name.starts_with("secrets.")
                || [".pem", ".key", ".p12", ".pfx"].iter().any(|suffix| name.ends_with(suffix))
        }) || !file.is_file() { return Err("无法显示敏感文件或非文件路径。".into()); }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if std::fs::metadata(&file).map_err(|error| error.to_string())?.nlink() > 1 { return Err("无法显示具有外部硬链接的产物。".into()); }
        }
        Ok(file)
}

#[tauri::command]
pub async fn reveal_workspace_file(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = artifact_file(&workspace_root(Some(&root))?, &path)?;
        // Select the artifact without opening or executing its contents.
        #[cfg(target_os = "macos")]
        let result = Command::new("/usr/bin/open").arg("-R").arg(&file).status();
        #[cfg(windows)]
        let result = Command::new("explorer.exe").arg(format!("/select,{}", file.display())).status();
        #[cfg(not(any(target_os = "macos", windows)))]
        return Err("当前系统尚未提供文件定位。".into());
        #[cfg(any(target_os = "macos", windows))]
        if result.map_err(|error| error.to_string())?.success() { Ok(()) } else { Err("无法在文件管理器中定位产物。".into()) }
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_workspace_file(root: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(Some(&root))?;
        let text = read_text(&scoped_path(&root, &path)?)?;
        Ok(json!({"text": text, "revision": revision(&text)}))
    }).await.map_err(|e| e.to_string())?
}

fn save_file(root: &Path, path: &str, text: &str, expected_revision: &str) -> Result<String, String> {
    if text.len() > 512 * 1024 || text.contains('\0') { return Err("文件过大或含有无效字符。".into()); }
    let path = scoped_path(root, path)?;
    if revision(&read_text(&path)?) != expected_revision { return Err("文件已被其他程序修改，请重新打开后再保存。当前草稿不会丢失。".into()); }
    let permissions = std::fs::metadata(&path).map_err(|e| e.to_string())?.permissions();
    super::atomic_write(&path, text.as_bytes())?;
    std::fs::set_permissions(&path, permissions).map_err(|e| e.to_string())?;
    Ok(revision(text))
}

#[tauri::command]
pub async fn save_workspace_file(root: String, path: String, text: String, expected_revision: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save_file(&workspace_root(Some(&root))?, &path, &text, &expected_revision))
        .await.map_err(|e| e.to_string())?
}

fn parse_status(bytes: &[u8]) -> Vec<Value> {
    let mut parts = bytes.split(|byte| *byte == 0).filter(|part| !part.is_empty());
    let mut changes = Vec::new();
    while let Some(record) = parts.next() {
        if record.len() < 4 { continue; }
        let index = record[0] as char;
        let worktree = record[1] as char;
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let renamed = index == 'R' || index == 'C' || worktree == 'R' || worktree == 'C';
        let old = if renamed { parts.next().map(|path| String::from_utf8_lossy(path).into_owned()) } else { None };
        changes.push(json!({"path": path, "oldPath": old, "index": index.to_string(), "worktree": worktree.to_string(), "untracked": index == '?'}));
    }
    changes
}

fn comparison_ref(base: Option<String>) -> Result<String, String> {
    let base = base.ok_or("请选择对比分支。")?;
    if base.is_empty() || base.starts_with('-') || !base.chars().all(|c| c.is_ascii_alphanumeric() || "/_.-".contains(c)) {
        return Err("对比分支无效。".into());
    }
    Ok(format!("{base}...HEAD"))
}

fn parse_branch_changes(bytes: &[u8]) -> Vec<Value> {
    let mut fields = bytes.split(|byte| *byte == 0).filter(|part| !part.is_empty());
    let mut changes = Vec::new();
    while let Some(status) = fields.next() {
        let Some(first_path) = fields.next() else { break };
        let status = String::from_utf8_lossy(status).chars().next().unwrap_or('M');
        let (path, old) = if matches!(status, 'R' | 'C') {
            let Some(new_path) = fields.next() else { break };
            (String::from_utf8_lossy(new_path).into_owned(), Some(String::from_utf8_lossy(first_path).into_owned()))
        } else { (String::from_utf8_lossy(first_path).into_owned(), None) };
        changes.push(json!({"path": path, "oldPath": old, "index": status.to_string(), "worktree": status.to_string(), "untracked": false}));
    }
    changes
}

// Review paths stay repository-relative, even when the selected workspace is a subdirectory.
struct GitWorkspace {
    repository: PathBuf,
    selected: PathBuf,
}

impl GitWorkspace {
    fn new(root: &str) -> Result<Self, String> {
        let selected = workspace_root(Some(root))?;
        let bytes = git(&selected, &["rev-parse", "--show-toplevel"])?;
        let path = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
        let path = path.strip_suffix('\n').unwrap_or(path);
        let repository = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
        if !selected.starts_with(&repository) { return Err("工作区不在 Git 仓库内。".into()); }
        Ok(Self { repository, selected })
    }

    fn contains(&self, path: &str) -> bool {
        validate_git_path(path).is_ok() && self.repository.join(path).starts_with(&self.selected)
    }

    fn path(&self, path: &str) -> Result<PathBuf, String> {
        if !self.contains(path) { return Err("Git 文件路径超出工作区。".into()); }
        let absolute = self.repository.join(path);
        // A deletion may have no remaining parent directory. Check the nearest existing
        // ancestor instead of requiring the file to exist, and still reject escaping links.
        let mut ancestor = absolute.as_path();
        loop {
            match std::fs::symlink_metadata(ancestor) {
                Ok(_) => {
                    let resolved = ancestor.canonicalize().map_err(|e| e.to_string())?;
                    if !resolved.starts_with(&self.selected) { return Err("链接指向工作区之外，无法访问。".into()); }
                    return Ok(absolute);
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    ancestor = ancestor.parent().ok_or("Git 文件路径无效。")?;
                },
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    fn changes(&self, changes: Vec<Value>) -> Vec<Value> {
        changes.into_iter().filter_map(|mut change| {
            let inside = self.contains(change["path"].as_str()?);
            let Some(old) = change["oldPath"].as_str() else { return inside.then_some(change) };
            let old_inside = self.contains(old);
            if inside && old_inside { return Some(change); }
            if !inside && !old_inside { return None; }
            if !inside {
                // Copies leave the source unchanged. Renames out of the workspace
                // expose only the source deletion; no command receives the outside path.
                if change["index"] != "R" && change["worktree"] != "R" { return None; }
                change["path"] = json!(old);
            }
            change["oldPath"] = Value::Null;
            for field in ["index", "worktree"] {
                if matches!(change[field].as_str(), Some("R" | "C")) {
                    change[field] = json!(if inside { "A" } else { "D" });
                } else if !inside {
                    change[field] = json!(" ");
                }
            }
            Some(change)
        }).collect()
    }
}

#[tauri::command]
pub async fn git_changes(root: String, mode: Option<String>, base: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = GitWorkspace::new(&root)?;
        let root = &workspace.repository;
        let changes = if mode.as_deref() == Some("branch") {
            parse_branch_changes(&git(&root, &["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", &comparison_ref(base)?, "--"])?)
        } else { parse_status(&git(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])? ) };
        let branch = git(&root, &["branch", "--show-current"]).map(|bytes| String::from_utf8_lossy(&bytes).trim().to_owned()).unwrap_or_default();
        let refs = git(&root, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
            .map(|bytes| String::from_utf8_lossy(&bytes).lines().take(100).map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default();
        Ok(json!({"changes": workspace.changes(changes), "branch": branch, "refs": refs}))
    }).await.map_err(|e| e.to_string())?
}

fn validate_git_path(path: &str) -> Result<(), String> {
    if path.is_empty() || Path::new(path).components().any(|part| !matches!(part, Component::Normal(_))) || path.contains('\0') {
        Err("Git 文件路径无效。".into())
    } else { Ok(()) }
}

#[tauri::command]
pub async fn git_diff(root: String, path: String, old_path: Option<String>, mode: String, base: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = GitWorkspace::new(&root)?;
        let file = workspace.path(&path)?;
        if let Some(ref old) = old_path { workspace.path(old)?; }
        if mode == "untracked" { return read_text(&file); }
        let root = &workspace.repository;
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
        let comparison;
        match mode.as_str() {
            "working" => {},
            "staged" => args.push("--cached"),
            "branch" => {
                comparison = comparison_ref(base)?;
                args.push(&comparison);
            },
            _ => return Err("审阅模式无效。".into()),
        }
        args.extend(["--", &path]);
        if let Some(ref old) = old_path { args.push(old); }
        let bytes = git(&root, &args)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage(root: String, path: String, old_path: Option<String>, stage: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = GitWorkspace::new(&root)?;
        workspace.path(&path)?;
        if let Some(ref old) = old_path { workspace.path(old)?; }
        let root = &workspace.repository;
        let mut args = if stage { vec!["add", "--", &path] }
            else if git(&root, &["rev-parse", "--verify", "HEAD"]).is_ok() { vec!["restore", "--staged", "--", &path] }
            else { vec!["rm", "--cached", "--", &path] };
        if let Some(ref old) = old_path { args.push(old); }
        git(&root, &args)?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn artifact_selection_rejects_sensitive_missing_outside_and_linked_files() {
        let repo = GitTestRepo::new();
        repo.write("report.md", "result");
        assert!(artifact_file(&repo.0, "report.md").is_ok());
        for path in [".env", "secret.json", "private.pem"] {
            repo.write(path, "private");
            assert!(artifact_file(&repo.0, path).is_err());
        }
        for path in ["../outside", ".git", "missing.md"] { assert!(artifact_file(&repo.0, path).is_err()); }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(repo.0.join(".env"), repo.0.join("alias.md")).unwrap();
            assert!(artifact_file(&repo.0, "alias.md").is_err());
            std::fs::hard_link(repo.0.join(".env"), repo.0.join("hardlink.md")).unwrap();
            assert!(artifact_file(&repo.0, "hardlink.md").is_err());
        }
    }
    #[test]
    fn git_environment_overrides_cannot_redirect_staging_into_another_project() {
        let first = GitTestRepo::new();
        let second = GitTestRepo::new();
        first.write("A.txt", "A");
        second.write("B.txt", "B");
        git(&second.0, &["add", "--", "B.txt"]).unwrap();
        let foreign_index = second.0.join(".git/index");
        let before = std::fs::read(&foreign_index).unwrap();
        let mut command = Command::new("git");
        command.env("GIT_INDEX_FILE", &foreign_index)
            .env("GIT_DIR", second.0.join(".git"))
            .env("GIT_WORK_TREE", &second.0)
            .env("GIT_CONFIG_COUNT", "1").env("GIT_CONFIG_KEY_0", "core.bare").env("GIT_CONFIG_VALUE_0", "true");
        clear_git_environment(&mut command);
        for (key, value) in command.get_envs() {
            if key.to_string_lossy().starts_with("GIT_") { assert!(value.is_none(), "{key:?}"); }
        }
        command.env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" }).env("GIT_CONFIG_NOSYSTEM", "1")
            .args(["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-C"])
            .arg(&first.0).args(["add", "--", "A.txt"]);
        git_output(&mut command, std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(std::fs::read(&foreign_index).unwrap(), before);
        assert_eq!(git(&first.0, &["ls-files"]).unwrap(), b"A.txt\n");
    }

    #[test]
    #[cfg(unix)]
    fn git_timeout_does_not_wait_for_a_stalled_process_or_inherited_pipe() {
        use std::time::{Duration, Instant};
        for script in ["exec /bin/sleep 3", "/bin/sleep 3 & exit 0"] {
            let started = Instant::now();
            let error = git_output(Command::new("/bin/sh").arg("-c").arg(script), Duration::from_millis(80)).unwrap_err();
            assert!(error.contains("超时"), "{error}");
            assert!(started.elapsed() < Duration::from_secs(2));
        }
    }
    #[test]
    #[cfg(unix)]
    fn git_output_bounds_both_streams_and_preserves_exit_errors() {
        use std::time::Duration;
        let timeout = Duration::from_secs(3);
        let error = git_output(Command::new("/bin/sh").arg("-c").arg("printf problem >&2; exit 1"), timeout).unwrap_err();
        assert_eq!(error, "problem");
        let bytes = git_output(Command::new("/bin/sh").arg("-c").arg("printf result"), timeout).unwrap();
        assert_eq!(bytes, b"result");
        let error = git_output(Command::new("/bin/sh").arg("-c").arg("/usr/bin/head -c 20000 /dev/zero >&2"), timeout).unwrap_err();
        assert!(error.contains("输出超过限制"), "{error}");
    }
    #[test]
    #[cfg(unix)]
    fn scope_rejects_parent_absolute_and_symlink_escape() {
        let root = super::super::tests::scratch();
        assert!(scoped_path(&root, "../outside").is_err());
        assert!(scoped_path(&root, "/etc/passwd").is_err());
        std::os::unix::fs::symlink("/etc", root.join("link")).unwrap();
        assert!(scoped_path(&root, "link/passwd").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn file_save_preserves_mode_and_refuses_stale_revision() {
        use std::os::unix::fs::PermissionsExt;
        let root = super::super::tests::scratch();
        let file = root.join("run.sh");
        std::fs::write(&file, "old").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(save_file(&root, "run.sh", "new", "stale").is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old");
        save_file(&root, "run.sh", "new", &revision("old")).unwrap();
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o755);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn git_status_handles_spaces_and_renames() {
        let changes = parse_status(b" M hello world.ts\0R  new name.ts\0old name.ts\0?? added.ts\0");
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0]["path"], "hello world.ts");
        assert_eq!(changes[1]["oldPath"], "old name.ts");
        assert_eq!(changes[2]["untracked"], true);
        assert!(validate_git_path("../escape").is_err());
    }
    #[test]
    fn session_summary_uses_pi_source_not_gui_metadata() {
        let root = super::super::tests::scratch();
        let file = root.join("session.jsonl");
        std::fs::write(&file, "{\"type\":\"session\",\"id\":\"real\",\"cwd\":\"/tmp\"}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"First prompt\"}]}}\n{\"type\":\"session_info\",\"name\":\"Renamed\"}\n").unwrap();
        let summary = session_summary(&file, 123).unwrap();
        assert_eq!(summary["id"], "real");
        assert_eq!(summary["title"], "Renamed");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn branch_changes_preserve_rename_paths_and_reject_invalid_refs() {
        let changes = parse_branch_changes(b"A\0one.ts\0R100\0old name.ts\0new name.ts\0");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[1]["path"], "new name.ts");
        assert_eq!(changes[1]["oldPath"], "old name.ts");
        assert!(comparison_ref(Some("--output=bad".into())).is_err());
        assert!(comparison_ref(Some("main;cmd".into())).is_err());
        assert_eq!(comparison_ref(Some("origin/main".into())).unwrap(), "origin/main...HEAD");
    }
    struct GitTestRepo(PathBuf);

    impl GitTestRepo {
        fn new() -> Self {
            let repo = Self(super::super::tests::scratch());
            git(&repo.0, &["init", "-q", "--initial-branch=main", "--template="]).unwrap();
            std::fs::create_dir_all(repo.workspace()).unwrap();
            repo
        }

        fn workspace(&self) -> PathBuf { self.0.join("selected workspace") }
        fn root_arg(&self) -> String { self.workspace().to_string_lossy().into_owned() }
        fn write(&self, path: &str, text: &str) {
            let file = self.0.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        fn commit(&self) {
            git(&self.0, &["add", "--all"]).unwrap();
            git(&self.0, &["-c", "user.name=Workbench Test", "-c", "user.email=workbench@example.invalid",
                "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]).unwrap();
        }
        fn changes(&self, branch: bool) -> Value {
            tauri::async_runtime::block_on(git_changes(self.root_arg(),
                branch.then(|| "branch".into()), branch.then(|| "main".into()))).unwrap()
        }
        fn diff(&self, path: &str, old: Option<&str>, mode: &str) -> Result<String, String> {
            tauri::async_runtime::block_on(git_diff(self.root_arg(), path.into(), old.map(str::to_owned),
                mode.into(), (mode == "branch").then(|| "main".into())))
        }
        fn stage(&self, path: &str, old: Option<&str>, stage: bool) -> Result<(), String> {
            tauri::async_runtime::block_on(git_stage(self.root_arg(), path.into(), old.map(str::to_owned), stage))
        }
        fn cached_paths(&self) -> Vec<String> {
            git(&self.0, &["diff", "--cached", "--name-only", "-z"]).unwrap()
                .split(|byte| *byte == 0).filter(|part| !part.is_empty())
                .map(|part| String::from_utf8(part.to_vec()).unwrap()).collect()
        }
        fn outside_index(&self) -> Vec<u8> {
            git(&self.0, &["ls-files", "--stage", "-z", "--", "outside.txt", "selected workspace sibling"]).unwrap()
        }
    }

    impl Drop for GitTestRepo {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn nested_git_diff_stage_and_unstage_use_literal_repository_paths() {
        let repo = GitTestRepo::new();
        let path = "selected workspace/src/[ab] note.txt";
        let other = "selected workspace/src/a note.txt";
        repo.write(path, "original literal\n");
        repo.write(other, "original neighbor\n");
        repo.write("outside.txt", "original outside\n");
        repo.commit();
        repo.write(path, "changed literal\n");
        repo.write(other, "changed neighbor\n");
        repo.write("outside.txt", "outside staged sentinel\n");
        git(&repo.0, &["add", "--", "outside.txt"]).unwrap();
        let outside = repo.outside_index();

        let working = repo.diff(path, None, "working").unwrap();
        assert!(working.contains("+changed literal"), "nested diff must address the status path: {working}");
        assert!(!working.contains("changed neighbor"));
        repo.stage(path, None, true).unwrap();
        assert_eq!(repo.cached_paths(), vec!["outside.txt", path]);
        assert!(repo.diff(path, None, "staged").unwrap().contains("+changed literal"));
        assert!(repo.diff(path, None, "working").unwrap().is_empty());
        repo.stage(path, None, false).unwrap();
        assert_eq!(repo.cached_paths(), vec!["outside.txt"]);
        assert!(repo.diff(path, None, "working").unwrap().contains("+changed literal"));
        assert_eq!(repo.outside_index(), outside);
        assert_eq!(std::fs::read_to_string(repo.0.join("outside.txt")).unwrap(), "outside staged sentinel\n");
    }

    #[test]
    fn nested_git_untracked_preview_and_unborn_stage_round_trip() {
        let repo = GitTestRepo::new();
        let path = "selected workspace/new [ab] file.txt";
        repo.write(path, "untracked literal contents\n");
        repo.write("selected workspace/new a file.txt", "unrelated\n");
        repo.write("outside.txt", "outside remains untracked\n");
        let changes = repo.changes(false);
        assert!(changes["changes"].as_array().unwrap().iter().any(|change| change["path"] == path && change["untracked"] == true));
        assert_eq!(repo.diff(path, None, "untracked").unwrap(), "untracked literal contents\n");
        repo.stage(path, None, true).unwrap();
        assert_eq!(repo.cached_paths(), vec![path]);
        repo.stage(path, None, false).unwrap();
        assert!(repo.cached_paths().is_empty());
        assert_eq!(repo.diff(path, None, "untracked").unwrap(), "untracked literal contents\n");
        assert_eq!(std::fs::read_to_string(repo.0.join("outside.txt")).unwrap(), "outside remains untracked\n");
    }

    #[test]
    fn nested_git_changes_filter_to_the_selected_workspace() {
        let repo = GitTestRepo::new();
        repo.write("selected workspace/inside file.txt", "before\n");
        repo.write("selected workspace sibling/outside.txt", "before\n");
        repo.write("outside.txt", "before\n");
        repo.commit();
        repo.write("selected workspace/inside file.txt", "after\n");
        repo.write("selected workspace/new file.txt", "new\n");
        repo.write("selected workspace sibling/outside.txt", "after\n");
        repo.write("outside.txt", "after\n");
        repo.write("outside new.txt", "new\n");
        let value = repo.changes(false);
        let paths: Vec<_> = value["changes"].as_array().unwrap().iter().map(|change| change["path"].as_str().unwrap()).collect();
        assert_eq!(paths, vec!["selected workspace/inside file.txt", "selected workspace/new file.txt"]);
        assert_eq!(value["branch"], "main");
        assert!(value["refs"].as_array().unwrap().iter().any(|value| value == "main"));
    }

    #[test]
    fn nested_git_rename_and_deleted_paths_round_trip_without_touching_outside() {
        let repo = GitTestRepo::new();
        let old = "selected workspace/old name.txt";
        let new = "selected workspace/new name.txt";
        let deleted = "selected workspace/deleted folder/deleted file.txt";
        repo.write(old, "rename contents\n");
        repo.write(deleted, "delete contents\n");
        repo.write("outside.txt", "before\n");
        repo.commit();
        std::fs::rename(repo.0.join(old), repo.0.join(new)).unwrap();
        std::fs::remove_dir_all(repo.0.join("selected workspace/deleted folder")).unwrap();
        repo.write("outside.txt", "outside staged sentinel\n");
        git(&repo.0, &["add", "--all"]).unwrap();
        let outside = repo.outside_index();
        let changes = repo.changes(false);
        let rename = changes["changes"].as_array().unwrap().iter().find(|change| change["path"] == new).unwrap();
        assert_eq!(rename["oldPath"], old);
        assert!(repo.diff(new, Some(old), "staged").unwrap().contains("rename from selected workspace/old name.txt"));
        assert!(repo.diff(deleted, None, "staged").unwrap().contains("-delete contents"));
        repo.stage(new, Some(old), false).unwrap();
        repo.stage(deleted, None, false).unwrap();
        assert_eq!(repo.cached_paths(), vec!["outside.txt"]);
        assert!(repo.diff(deleted, None, "working").unwrap().contains("-delete contents"));
        repo.stage(new, Some(old), true).unwrap();
        repo.stage(deleted, None, true).unwrap();
        assert!(repo.diff(new, Some(old), "staged").unwrap().contains("rename to selected workspace/new name.txt"));
        assert_eq!(repo.outside_index(), outside);
        assert_eq!(std::fs::read_to_string(repo.0.join("outside.txt")).unwrap(), "outside staged sentinel\n");
    }

    #[test]
    fn nested_git_branch_changes_and_diffs_keep_spaces_renames_and_deletions() {
        let repo = GitTestRepo::new();
        let old = "selected workspace/old branch name.txt";
        let new = "selected workspace/new branch name.txt";
        let deleted = "selected workspace/deleted branch file.txt";
        repo.write(old, "branch rename contents\n");
        repo.write(deleted, "branch delete contents\n");
        repo.write("selected workspace/modified branch file.txt", "before\n");
        repo.write("outside.txt", "before\n");
        repo.commit();
        git(&repo.0, &["checkout", "-qb", "feature"]).unwrap();
        std::fs::rename(repo.0.join(old), repo.0.join(new)).unwrap();
        std::fs::remove_file(repo.0.join(deleted)).unwrap();
        repo.write("selected workspace/modified branch file.txt", "branch after\n");
        repo.write("outside.txt", "outside branch change\n");
        repo.commit();
        let outside = repo.outside_index();
        let changes = repo.changes(true);
        let rows = changes["changes"].as_array().unwrap();
        assert_eq!(rows.len(), 3, "branch review must exclude outside changes: {changes}");
        assert!(rows.iter().all(|change| change["path"].as_str().unwrap().starts_with("selected workspace/")));
        assert_eq!(rows.iter().find(|change| change["path"] == new).unwrap()["oldPath"], old);
        assert!(repo.diff(new, Some(old), "branch").unwrap().contains("rename from selected workspace/old branch name.txt"));
        assert!(repo.diff(deleted, None, "branch").unwrap().contains("-branch delete contents"));
        assert!(repo.diff("selected workspace/modified branch file.txt", None, "branch").unwrap().contains("+branch after"));
        assert_eq!(repo.outside_index(), outside);
    }

    #[test]
    fn nested_git_cross_boundary_renames_are_scoped_additions_and_deletions() {
        let repo = GitTestRepo::new();
        let leaving = "selected workspace/leaving file.txt";
        let arriving = "selected workspace/arriving file.txt";
        repo.write(leaving, "unique leaving contents\n");
        repo.write("outside.txt", "unique arriving contents\n");
        repo.commit();
        git(&repo.0, &["checkout", "-qb", "feature"]).unwrap();
        std::fs::rename(repo.0.join(leaving), repo.0.join("outside renamed.txt")).unwrap();
        std::fs::rename(repo.0.join("outside.txt"), repo.0.join(arriving)).unwrap();
        git(&repo.0, &["add", "--all"]).unwrap();
        let outside_before = git(&repo.0, &["ls-files", "--stage", "-z", "--", "outside renamed.txt", "outside.txt"]).unwrap();
        for branch in [false, true] {
            if branch { repo.commit(); }
            let changes = repo.changes(branch);
            let rows = changes["changes"].as_array().unwrap();
            assert_eq!(rows.len(), 2, "both in-scope sides must be represented: {changes}");
            let addition = rows.iter().find(|change| change["path"] == arriving).expect("arrival must be an in-scope addition");
            assert_eq!(addition["index"], "A");
            assert!(addition["oldPath"].is_null());
            let deletion = rows.iter().find(|change| change["path"] == leaving).expect("departure must be an in-scope deletion");
            assert_eq!(deletion["index"], "D");
            assert!(deletion["oldPath"].is_null());
            let mode = if branch { "branch" } else { "staged" };
            assert!(repo.diff(arriving, None, mode).unwrap().contains("+unique arriving contents"));
            assert!(repo.diff(leaving, None, mode).unwrap().contains("-unique leaving contents"));
            if !branch {
                repo.stage(arriving, None, false).unwrap();
                repo.stage(leaving, None, false).unwrap();
                assert_eq!(git(&repo.0, &["ls-files", "--stage", "-z", "--", "outside renamed.txt", "outside.txt"]).unwrap(), outside_before);
                repo.stage(arriving, None, true).unwrap();
                repo.stage(leaving, None, true).unwrap();
            }
        }
        assert_eq!(git(&repo.0, &["ls-files", "--stage", "-z", "--", "outside renamed.txt", "outside.txt"]).unwrap(), outside_before);
    }

    #[test]
    fn nested_git_rejects_outside_and_malformed_paths_before_mutation() {
        let repo = GitTestRepo::new();
        let inside = "selected workspace/inside.txt";
        repo.write(inside, "before\n");
        repo.write("outside.txt", "before\n");
        repo.write("selected workspace sibling/outside.txt", "before\n");
        repo.commit();
        repo.write(inside, "after\n");
        repo.write("outside.txt", "after\n");
        let index = git(&repo.0, &["ls-files", "--stage", "-z"]).unwrap();
        for path in ["outside.txt", "selected workspace sibling/outside.txt", "../outside.txt", "/outside.txt", ":(glob)**", ""] {
            assert!(repo.diff(path, None, "working").is_err(), "accepted out-of-scope path {path:?}");
            assert!(repo.diff(path, None, "untracked").is_err());
            assert!(repo.stage(path, None, true).is_err());
            assert!(repo.stage(path, None, false).is_err());
        }
        assert!(repo.diff(inside, Some("outside.txt"), "working").is_err());
        assert!(repo.stage(inside, Some("outside.txt"), true).is_err());
        assert_eq!(git(&repo.0, &["ls-files", "--stage", "-z"]).unwrap(), index);
        assert_eq!(std::fs::read_to_string(repo.0.join("outside.txt")).unwrap(), "after\n");
    }

    #[test]
    #[cfg(unix)]
    fn nested_git_rejects_symlink_escape_even_for_missing_files() {
        let repo = GitTestRepo::new();
        repo.write("outside.txt", "outside secret\n");
        repo.commit();
        std::os::unix::fs::symlink(&repo.0, repo.workspace().join("escape")).unwrap();
        let before = git(&repo.0, &["ls-files", "--stage", "-z"]).unwrap();
        for path in ["selected workspace/escape/outside.txt", "selected workspace/escape/missing.txt"] {
            assert!(repo.diff(path, None, "working").is_err());
            assert!(repo.diff(path, None, "untracked").is_err());
            assert!(repo.stage(path, None, true).is_err());
        }
        assert!(scoped_path(&repo.workspace(), "escape/outside.txt").is_err());
        assert_eq!(git(&repo.0, &["ls-files", "--stage", "-z"]).unwrap(), before);
    }

    #[test]
    fn git_stage_uses_literal_paths_and_handles_an_unborn_repository() {
        let root = super::super::tests::scratch();
        git(&root, &["init", "-q"]).unwrap();
        std::fs::write(root.join("[ab].txt"), "literal").unwrap();
        std::fs::write(root.join("a.txt"), "unrelated").unwrap();
        git(&root, &["add", "--", "[ab].txt"]).unwrap();
        let staged = git(&root, &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(String::from_utf8(staged).unwrap().trim(), "[ab].txt");
        git(&root, &["rm", "--cached", "--", "[ab].txt"]).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("[ab].txt")).unwrap(), "literal");
        std::fs::remove_dir_all(root).unwrap();
    }
}
