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
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(PathBuf::from(home).join(".pi/agent/sessions"))
}

pub fn session_path(path: &str) -> Result<PathBuf, String> {
    let root = sessions_root()?.canonicalize().map_err(|e| e.to_string())?;
    let path = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(&root) || path.extension().is_none_or(|ext| ext != "jsonl") || !path.is_file() {
        return Err("会话文件必须来自 Pi 的会话目录。".into());
    }
    Ok(path)
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
    let mut child = Command::new("git").arg("--no-pager").arg("--literal-pathspecs").arg("-c").arg("core.fsmonitor=false")
        .arg("-C").arg(root).args(arguments).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("Git 不可用: {e}"))?;
    let stderr = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || {
        let mut output = Vec::new();
        let _ = stderr.take(16384).read_to_end(&mut output);
        output
    });
    let mut output = Vec::new();
    child.stdout.take().unwrap().take(2 * 1024 * 1024 + 1).read_to_end(&mut output).map_err(|e| e.to_string())?;
    if output.len() > 2 * 1024 * 1024 {
        let _ = child.kill();
        let _ = child.wait();
        let _ = errors.join();
        return Err("Git 输出超过 2 MB，请缩小审阅范围。".into());
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let error = errors.join().unwrap_or_default();
    if status.success() { Ok(output) } else { Err(String::from_utf8_lossy(&error).trim().to_owned()) }
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

#[tauri::command]
pub async fn git_changes(root: String, mode: Option<String>, base: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(Some(&root))?;
        let changes = if mode.as_deref() == Some("branch") {
            parse_branch_changes(&git(&root, &["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", &comparison_ref(base)?, "--"])?)
        } else { parse_status(&git(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])? ) };
        let branch = git(&root, &["branch", "--show-current"]).map(|bytes| String::from_utf8_lossy(&bytes).trim().to_owned()).unwrap_or_default();
        let refs = git(&root, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
            .map(|bytes| String::from_utf8_lossy(&bytes).lines().take(100).map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default();
        Ok(json!({"changes": changes, "branch": branch, "refs": refs}))
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
        let root = workspace_root(Some(&root))?;
        validate_git_path(&path)?;
        if mode == "untracked" { return read_text(&scoped_path(&root, &path)?); }
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
        if let Some(ref old) = old_path { validate_git_path(old)?; args.push(old); }
        let bytes = git(&root, &args)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage(root: String, path: String, old_path: Option<String>, stage: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = workspace_root(Some(&root))?;
        validate_git_path(&path)?;
        let mut args = if stage { vec!["add", "--", &path] }
            else if git(&root, &["rev-parse", "--verify", "HEAD"]).is_ok() { vec!["restore", "--staged", "--", &path] }
            else { vec!["rm", "--cached", "--", &path] };
        if let Some(ref old) = old_path { validate_git_path(old)?; args.push(old); }
        git(&root, &args)?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
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
