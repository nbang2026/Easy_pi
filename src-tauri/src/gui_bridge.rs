use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use serde_json::{json, Value};
use tauri::Emitter;

#[cfg(unix)]
use std::os::unix::net::{UnixListener as BridgeListener, UnixStream as BridgeStream};
#[cfg(windows)]
use std::net::{TcpListener as BridgeListener, TcpStream as BridgeStream};

const MAX_FRAME: u64 = 1_048_576;

pub struct GuiBridge {
    pub directory: PathBuf,
    pub socket: String,
    pub extension: PathBuf,
    pub token: String,
    writer: Mutex<Option<BridgeStream>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    latest: Mutex<Value>,
    closed: AtomicBool,
    next: AtomicU64,
}

fn read_frame(reader: &mut BufReader<BridgeStream>) -> Result<Value, String> {
    let mut bytes = Vec::new();
    let count = reader.take(MAX_FRAME + 1).read_until(b'\n', &mut bytes).map_err(|e| e.to_string())?;
    if count == 0 { return Err("Input bridge disconnected.".into()); }
    if count as u64 > MAX_FRAME || bytes.last() != Some(&b'\n') { return Err("Invalid input bridge frame.".into()); }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

impl GuiBridge {
    pub fn create(app: tauri::AppHandle) -> Result<Arc<Self>, String> {
        Self::create_with_emitter(move |event, value| { let _ = app.emit(event, value); })
    }

    fn create_with_emitter(emit: impl Fn(&str, Value) + Send + 'static) -> Result<Arc<Self>, String> {
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).map_err(|e| format!("Input bridge randomness: {e}"))?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        // Keep the Unix socket path below macOS's 104-byte limit.
        let directory = std::env::temp_dir().join(format!("pi-gui-{}-{}", std::process::id(), &token[..12]));
        std::fs::create_dir(&directory).map_err(|e| format!("Input bridge directory: {e}"))?;
        #[cfg(unix)]
        {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        }
        let extension = directory.join("input.ts");
        super::atomic_write(&extension, include_str!("gui-extension.ts").as_bytes())?;
        super::atomic_write(&directory.join("gui-library.mjs"), include_str!("gui-library.mjs").as_bytes())?;
        super::atomic_write(&directory.join("gui-market.mjs"), include_str!("gui-market.mjs").as_bytes())?;
        #[cfg(unix)]
        let (listener, socket) = {
            let path = directory.join("input.sock");
            let listener = BridgeListener::bind(&path).map_err(|e| format!("Input bridge socket: {e}"))?;
            (listener, path.to_string_lossy().into_owned())
        };
        #[cfg(windows)]
        let (listener, socket) = {
            let listener = BridgeListener::bind(("127.0.0.1", 0)).map_err(|e| format!("Input bridge socket: {e}"))?;
            let address = listener.local_addr().map_err(|e| e.to_string())?;
            (listener, format!("tcp://127.0.0.1:{}", address.port()))
        };
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let bridge = Arc::new(Self {
            directory, socket, extension, token, writer: Mutex::new(None), pending: Mutex::new(HashMap::new()),
            latest: Mutex::new(json!({"ready": false, "busy": false})), closed: AtomicBool::new(false),
            next: AtomicU64::new(1),
        });
        let instance = Arc::clone(&bridge);
        std::thread::spawn(move || {
            while !instance.closed.load(Ordering::Relaxed) {
                let stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(80));
                        continue;
                    }
                    // ECONNABORTED, EINTR or EMFILE are transient (e.g. Pi exits mid-connect during /reload).
                    // Keep listening so the extension's reconnect loop can still reach the GUI.
                    Err(_) => {
                        std::thread::sleep(Duration::from_millis(250));
                        continue;
                    }
                };
                // macOS can inherit the listener's nonblocking mode on accepted sockets.
                if stream.set_nonblocking(false).is_err() { continue; }
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut reader = BufReader::new(stream);
                if !matches!(read_frame(&mut reader), Ok(value) if value["type"] == "hello" && value["token"] == instance.token) {
                    continue;
                }
                let _ = reader.get_ref().set_read_timeout(None);
                let _ = reader.get_ref().set_write_timeout(Some(Duration::from_secs(2)));
                if let Ok(writer) = reader.get_ref().try_clone() {
                    *instance.writer.lock().unwrap() = Some(writer);
                }
                while !instance.closed.load(Ordering::Relaxed) {
                    let mut value = match read_frame(&mut reader) { Ok(value) => value, Err(_) => break };
                    if let Some(id) = value.get("id").and_then(Value::as_str) {
                        if let Some(sender) = instance.pending.lock().unwrap().remove(id) { let _ = sender.send(value); }
                    } else if value["type"] == "state" {
                        value["bridgeId"] = json!(instance.id());
                        *instance.latest.lock().unwrap() = value.clone();
                        emit("pi-gui-state", value);
                    } else if value["type"] == "error" {
                        emit("pi-gui-error", value);
                    }
                }
                instance.writer.lock().unwrap().take();
                *instance.latest.lock().unwrap() = json!({"ready": false, "busy": false});
                emit("pi-gui-state", json!({"ready": false, "busy": false, "connected": false, "bridgeId": instance.id()}));
                instance.pending.lock().unwrap().clear();
            }
        });
        Ok(bridge)
    }

    pub fn status(&self) -> Value {
        let mut state = self.latest.lock().unwrap().clone();
        state["connected"] = json!(self.writer.lock().unwrap().is_some());
        state["bridgeId"] = json!(self.id());
        state
    }

    pub fn id(&self) -> String { self.directory.file_name().unwrap().to_string_lossy().into_owned() }

    pub fn request(&self, action: &str, text: Option<String>, mode: Option<String>) -> Result<Value, String> {
        if !matches!(action, "submit" | "command" | "stop" | "status" | "dismiss" | "presentation" | "keybindings" | "library") { return Err("Unknown Pi action.".into()); }
        let limit = if action == "library" { 524288 } else { 262144 };
        if text.as_ref().is_some_and(|value| value.len() > limit || value.contains('\0')) { return Err("Input exceeds the action's transfer limit.".into()); }
        let id = format!("request-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let payload = json!({"id": id, "action": action, "text": text, "mode": mode});
        let (send, receive) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.clone(), send);
        let result = (|| {
            let mut guard = self.writer.lock().unwrap();
            let writer = guard.as_mut().ok_or("Pi 输入桥接尚未连接，请稍后重试或使用终端输入。")?;
            let bytes = format!("{payload}\n");
            if bytes.len() as u64 > MAX_FRAME { return Err("Input bridge frame exceeds 1 MB.".into()); }
            writer.write_all(bytes.as_bytes()).map_err(|e| e.to_string())
        })();
        if let Err(error) = result {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        match receive.recv_timeout(Duration::from_secs(if action == "library" { 22 } else { 8 })) {
            Ok(response) if response["ok"] == true => Ok(response),
            Ok(response) => Err(response["error"].as_str().unwrap_or("Pi rejected the input.").into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err("Pi 未确认输入结果。草稿保留；请检查终端，不要重复发送同一条。".into())
            }
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        if let Some(stream) = self.writer.lock().unwrap().take() { let _ = stream.shutdown(std::net::Shutdown::Both); }
        self.pending.lock().unwrap().clear();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

impl Drop for GuiBridge {
    fn drop(&mut self) { self.close(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pair() -> (BridgeStream, BufReader<BridgeStream>) {
        #[cfg(unix)]
        let (writer, reader) = BridgeStream::pair().unwrap();
        #[cfg(windows)]
        let (writer, reader) = {
            let listener = BridgeListener::bind(("127.0.0.1", 0)).unwrap();
            let writer = BridgeStream::connect(listener.local_addr().unwrap()).unwrap();
            let (reader, _) = listener.accept().unwrap();
            (writer, reader)
        };
        (writer, BufReader::new(reader))
    }
    #[test]
    fn frames_require_complete_valid_json() {
        let (mut writer, mut reader) = pair();
        writer.write_all(b"{\"ok\":true}\n").unwrap();
        assert_eq!(read_frame(&mut reader).unwrap()["ok"], true);
        writer.write_all(b"broken\n").unwrap();
        assert!(read_frame(&mut reader).is_err());
    }
    #[test]
    fn truncated_frame_is_rejected() {
        let (mut writer, mut reader) = pair();
        writer.write_all(b"{}").unwrap();
        drop(writer);
        assert!(read_frame(&mut reader).is_err());
    }
    #[test]
    fn oversized_frame_is_rejected() {
        let (mut writer, mut reader) = pair();
        let job = std::thread::spawn(move || { let _ = writer.write_all(&vec![b'x'; MAX_FRAME as usize + 2]); });
        assert!(read_frame(&mut reader).is_err());
        drop(reader);
        job.join().unwrap();
    }

    #[test]
    fn socket_handshake_waits_for_a_delayed_client_and_publishes_state() {
        let (send, receive) = mpsc::channel();
        let bridge = GuiBridge::create_with_emitter(move |event, value| {
            let _ = send.send((event.to_string(), value));
        }).unwrap();
        #[cfg(unix)]
        let mut client = BridgeStream::connect(&bridge.socket).unwrap();
        #[cfg(windows)]
        let mut client = BridgeStream::connect(bridge.socket.trim_start_matches("tcp://")).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        client.write_all(format!("{}\n{}\n",
            json!({"type":"hello","token":bridge.token}),
            json!({"type":"state","ready":true,"busy":false,"connected":true})
        ).as_bytes()).unwrap();
        let (event, state) = receive.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(event, "pi-gui-state");
        assert_eq!(state["ready"], true);
        assert_eq!(bridge.status()["connected"], true);
        bridge.close();
    }

    #[test]
    #[ignore = "requires a local Pi CLI; never uses real user configuration or makes model requests"]
    fn real_pi_launch_uses_the_app_transport() {
        use portable_pty::{native_pty_system, PtySize};
        let runtime = if let Some(resources) = std::env::var_os("PI_GUI_SMOKE_RUNTIME") {
            super::super::runtime::resolve(None, Some(std::path::Path::new(&resources)), || Err("Bundled smoke runtime missing".into())).unwrap()
        } else {
            super::super::runtime::Runtime::External(PathBuf::from(std::env::var("PI_GUI_SMOKE_EXECUTABLE").expect("Set PI_GUI_SMOKE_EXECUTABLE or PI_GUI_SMOKE_RUNTIME")))
        };
        let spec = runtime.command(std::iter::empty::<std::ffi::OsString>());
        let bridge = GuiBridge::create_with_emitter(|_, _| {}).unwrap();
        let home = bridge.directory.join("test-home");
        let agent = home.join(".pi/agent");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(agent.join("models.json"), json!({
            "providers": {"gui-smoke": {
                "baseUrl": "http://127.0.0.1:1/v1",
                "api": "openai-completions", "apiKey": "test-only",
                "models": [{"id": "keyboard-a"}, {"id": "keyboard-b"}]
            }}
        }).to_string()).unwrap();
        let pair = native_pty_system().openpty(PtySize { rows: 34, cols: 120, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = super::super::pty_pi_command(&spec);
        cmd.env_clear();
        cmd.cwd(&home);
        cmd.env("HOME", &home);
        let inherited = std::env::var_os("PI_GUI_SMOKE_PATH").unwrap_or_else(|| "/usr/bin:/bin".into());
        let mut paths = spec.path_prefix.clone();
        paths.extend(std::env::split_paths(&inherited));
        cmd.env("PATH", std::env::join_paths(paths).unwrap());
        #[cfg(windows)]
        {
            for key in ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"] {
                if let Some(value) = std::env::var_os(key) { cmd.env(key, value); }
            }
            cmd.env("USERPROFILE", &home);
            cmd.env("APPDATA", home.join("AppData/Roaming"));
            cmd.env("LOCALAPPDATA", home.join("AppData/Local"));
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("PI_OFFLINE", "1");
        cmd.env("PI_CODING_AGENT_DIR", &agent);
        cmd.env("PI_GUI_SOCKET", &bridge.socket);
        cmd.env("PI_GUI_TOKEN", &bridge.token);
        for arg in ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--provider", "gui-smoke", "--model", "keyboard-a", "--extension"] {
            cmd.arg(arg);
        }
        cmd.arg(&bridge.extension);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
        let captured_output = Arc::clone(&captured);
        let probe_writer = Arc::clone(&writer);
        let reading = std::thread::spawn(move || {
            let mut bytes = [0; 65536];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 { break; }
                captured_output.lock().unwrap().extend_from_slice(&bytes[..count]);
                let output = &bytes[..count];
                let mut writer = probe_writer.lock().unwrap();
                if output.windows(4).any(|part| part == b"\x1b[6n") { let _ = writer.write_all(b"\x1b[1;1R"); }
                if output.windows(3).any(|part| part == b"\x1b[c") { let _ = writer.write_all(b"\x1b[?1;2c"); }
            }
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while bridge.status()["ready"] != true && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let wait_for = |check: &dyn Fn(&Value) -> bool| -> Result<Value, String> {
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            loop {
                let state = bridge.status();
                if check(&state) { return Ok(state); }
                if std::time::Instant::now() >= deadline { return Err(format!("Unexpected Pi state: {state}")); }
                std::thread::sleep(Duration::from_millis(25));
            }
        };
        let result = (|| -> Result<(), String> {
            if bridge.status()["ready"] != true {
                return Err(format!("Bridge state: {}; Pi output: {}", bridge.status(), String::from_utf8_lossy(&captured.lock().unwrap())));
            }
            if bridge.status()["transparentInput"] != true {
                return Err("The actual Pi input presentation is not transparent.".into());
            }
            let library = |value: Value| -> Result<Value, String> {
                bridge.request("library", Some(value.to_string()), None).map(|response| response["data"].clone())
            };
            let market = library(json!({"kind":"market","action":"list"}))?;
            if market["entries"].as_array().map_or(0, Vec::len) != 8 {
                return Err(format!("Embedded text market catalog is missing: {market}"));
            }
            let preview = library(json!({"kind":"market","action":"preview","id":"code-reviewer"}))?;
            let imported = library(json!({"kind":"market","action":"import","id":"code-reviewer","hash":preview["hash"],"accepted":true}))?;
            if library(json!({"kind":"context"}))?["agent"].is_object() {
                return Err("Import unexpectedly activated an Agent.".into());
            }
            library(json!({"kind":"settings","activeAgent":imported["id"]}))?;
            let context = library(json!({"kind":"context"}))?;
            if context["agent"]["content"] != preview["content"] || context["agent"]["untrusted"] != true {
                return Err(format!("Imported text Agent was not preserved as untrusted context: {context}"));
            }
            library(json!({"kind":"settings","activeAgent":""}))?;
            bridge.request("command", Some("/name App transport verified".into()), None)?;
            wait_for(&|state| state["name"] == "App transport verified")?;
            bridge.request("presentation", Some("compact".into()), None)?;
            wait_for(&|state| state["compactEditor"] == true)?;
            bridge.request("command", Some("/model".into()), None)?;
            wait_for(&|state| state["ready"] == false)?;
            if bridge.request("submit", Some("must not reach any model".into()), Some("send".into())).is_ok() {
                return Err("A native selector failed to block submission.".into());
            }
            bridge.request("command", Some("/settings".into()), None)?;
            bridge.request("dismiss", None, None)?;
            wait_for(&|state| state["ready"] == true)?;
            let previous_session = bridge.status()["sessionId"].clone();
            bridge.request("command", Some("/new".into()), None)?;
            wait_for(&|state| state["ready"] == true && state["sessionId"] != previous_session)?;
            bridge.request("command", Some("/reload".into()), None)?;
            std::thread::sleep(Duration::from_secs(2));
            wait_for(&|state| state["ready"] == true && state["connected"] == true)?;
            bridge.request("command", Some("/name Reload transport verified".into()), None)?;
            wait_for(&|state| state["name"] == "Reload transport verified")?;
            bridge.request("presentation", Some("native".into()), None)?;
            bridge.request("stop", None, None)?;
            Ok(())
        })();
        let _ = writer.lock().unwrap().write_all(b"\x1b[200~/quit\x1b[201~\r");
        std::thread::sleep(Duration::from_millis(500));
        let _ = child.kill();
        let _ = child.wait();
        drop(pair.master);
        let _ = reading.join();
        bridge.close();
        assert!(result.is_ok(), "{}", result.unwrap_err());
    }
}
