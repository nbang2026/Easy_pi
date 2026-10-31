import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { Window } from "happy-dom";
import { setupClaudeView } from "./claude-view.ts";
import { setupLibrarySettings } from "./library-settings.ts";

const compiled = ts.transpileModule(readFileSync(new URL("./agent-runtime.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done)); };
function fixture({ probeError, switchError, stopPiError, connectPiError, startClaudeError, statusError, probeWait, storedMode, desktop = true } = {}) {
  const window = new Window({ url: "http://localhost:1423", settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  const document = window.document;
  document.write(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  // Legacy second-core controller remains tested in isolation, not in the active UI.
  const legacy = document.createElement("div");
  legacy.innerHTML = '<label hidden><select id="agent-select"><option value="auto">Auto</option><option value="pi">Pi</option><option value="claude">Legacy Agent</option></select></label><button id="claude-connection" hidden></button><div id="claude-view" hidden></div>';
  document.body.append(legacy);
  const previous = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage };
  Object.assign(globalThis, { document, window, localStorage: window.localStorage });
  if (storedMode) window.localStorage.setItem("easy_pi.engineMode", storedMode);
  else window.localStorage.removeItem("easy_pi.engineMode");
  const calls = [], toasts = [], workbenchCalls = [], lifecycle = [], trace = [];
  const failure = (value) => value instanceof Error ? value : Error(value);
  let eventCallback, removed = false, library, claudeAlive = false;
  let workbenchState = { busy: false, pending: false };
  let current = { ready: true, busy: false, configured: true, cwd: "/project", model: "claude-opus-5-5", sessionId: "s1" };
  const shared = { settings: { memoryEnabled: true, autonomousDownloads: true, activeAgent: "pi-role" }, memories: [], agents: [
    { id: "pi-role", title: "Pi role", content: "Pi instructions", updatedAt: 1 },
    { id: "claude-role", title: "Claude role", content: "Claude instructions", updatedAt: 2 },
  ] };
  const libraryRequest = (request) => {
    if (request.kind === "list") return structuredClone(shared);
    if (request.kind === "settings") { Object.assign(shared.settings, request); return structuredClone(shared.settings); }
    if (request.kind === "agent" && request.action === "read") {
      const result = shared.agents.find((item) => item.id === request.id);
      if (!result) throw Error("Role does not exist");
      return structuredClone(result);
    }
    if (request.kind === "market") return { activeAgent: shared.settings.activeAgent, installed: [] };
    return {};
  };
  const invoke = async (command, args) => {
    calls.push({ command, args: structuredClone(args) }); trace.push(command === "claude_action" ? `claude_action:${args.action}` : command);
    if (command === "probe_claude") { if (probeWait) await probeWait; if (probeError) throw failure(probeError); return { available: true }; }
    if (command === "start_claude") {
      if (startClaudeError) { const error = startClaudeError; startClaudeError = undefined; throw failure(error); }
      claudeAlive = true; return { runtimeId: "runtime-current", status: { ...current } };
    }
    if (command === "stop_claude") { claudeAlive = false; return {}; }
    if (command === "gui_status") return { ready: true, connected: true, cwd: "/project", model: "Pi model" };
    if (command === "gui_action" && args.action === "library") return { data: libraryRequest(JSON.parse(args.text)) };
    if (command === "claude_action") {
      if (args.action === "status") {
        if (statusError) { const error = statusError; statusError = undefined; throw failure(error); }
        if (!claudeAlive) throw Error("Claude sidecar exited; restart the runtime");
        return { ...current };
      }
      if (args.action === "library") return libraryRequest(args.payload.request);
      if (args.action === "submit") { current = { ...current, busy: true }; return { runId: "run-current", sessionId: current.sessionId }; }
      if (args.action === "stop") { current = { ...current, busy: false, waitingApproval: false }; return { ...current }; }
      if (args.action === "new_session") { current = { ...current, sessionId: "session-new", history: [] }; return { ...current }; }
      if (args.action === "resume") { current = { ...current, sessionId: args.payload.sessionId, history: [{ type: "text", runId: "old-run", messageId: "m1", blockId: "b1", append: false, text: "Resumed actual history" }] }; return { ...current }; }
      if (args.action === "workspace") { current = { ...current, cwd: args.payload.cwd }; return { ...current }; }
      if (args.action === "sessions") return { sessions: [{ sessionId: "history-session", cwd: "/project", title: "Claude history", updatedAt: 1792100000000 }] };
      return {};
    }
    return {};
  };
  const workbench = {
    getState: () => workbenchState,
    requireSwitch() { workbenchCalls.push({ action: "requireSwitch" }); if (switchError) throw failure(switchError); },
    engineChanged() { workbenchCalls.push({ action: "engineChanged" }); },
    setState(value) { workbenchCalls.push({ action: "setState", value }); },
    setRuntime(value) { workbenchCalls.push({ action: "setRuntime", value }); },
    refreshStrings() {},
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, document, localStorage: window.localStorage, console, require(name) {
    if (name === "./claude-view") return { setupClaudeView };
    if (name === "./utils.ts") return { formatUserError: (error) => error instanceof Error ? String(error) : typeof error?.message === "string" ? `Error: ${error.message}` : String(error || "操作失败") };
    if (name === "@tauri-apps/api/event") return { listen: async (event, callback) => {
      assert.equal(event, "claude-agent-event"); eventCallback = callback;
      return () => { removed = true; };
    } };
    throw Error(`Unexpected import: ${name}`);
  } });
  const runtime = exports.setupAgentRuntime({ desktop, invoke, workbench: () => workbench, cwd: () => "/project",
    stopPi: async () => { lifecycle.push("stopPi"); trace.push("stopPi"); if (stopPiError) { const error = stopPiError; stopPiError = undefined; throw failure(error); } },
    connectPi: async (cwd, session) => {
      lifecycle.push({ connectPi: cwd, session }); trace.push("connectPi");
      if (connectPiError) { const error = connectPiError; connectPiError = undefined; throw failure(error); }
    },
    changed: () => { lifecycle.push("changed"); library?.refresh(); },
    status: (value) => { lifecycle.push({ status: value }); }, toast: (message) => toasts.push(message),
  });
  const el = (id) => document.getElementById(id);
  const choose = async (engine) => { el("agent-select").value = engine; el("agent-select").dispatchEvent(new window.Event("change", { bubbles: true })); await flush(); };
  const lib = async (request) => runtime.route("gui_action", { action: "library", text: JSON.stringify(request) });
  return { window, document, runtime, calls, toasts, workbenchCalls, lifecycle, trace, shared, invoke, el, choose, lib,
    setWorkbenchState: value => { workbenchState = value; },
    actionCalls: (action) => calls.filter((item) => item.command === "claude_action" && (!action || item.args.action === action)),
    setState(value) { current = { ...current, ...value }; },
    crashClaude({ notify = true } = {}) {
      claudeAlive = false;
      if (notify) eventCallback?.({ payload: { runtimeId: "runtime-current", type: "runtime_error", error: "Claude sidecar exited; restart the runtime" } });
    },
    get claudeAlive() { return claudeAlive; },
    emit(value) { eventCallback?.({ payload: { runtimeId: "runtime-current", ...value } }); },
    attachLibrary() {
      library = setupLibrarySettings({ translate: (key) => key, invoke: async (command, args) => (await runtime.route(command, args)) ?? invoke(command, args) });
      library.refresh(); return library;
    },
    get removed() { return removed; },
    close() { library?.dispose(); runtime.dispose(); window.happyDOM.abort(); Object.assign(globalThis, previous); },
  };
}

test("engine picker and role picker remain separate through direct Claude library routing", async () => {
  const f = fixture();
  try {
    f.attachLibrary(); await flush();
    assert.equal(f.el("agent-select").value, "pi"); assert.equal(f.el("role-select").value, "pi-role");
    await f.choose("claude");
    assert.equal(f.runtime.engine(), "claude"); assert.equal(f.el("agent-select").value, "claude");
    assert.equal(f.el("role-select").value, "");
    assert.equal(f.el("terminal").hidden, true); assert.equal(f.el("claude-view").hidden, false);
    f.el("role-select").value = "claude-role"; f.el("role-select").dispatchEvent(new f.window.Event("change", { bubbles: true })); await flush();
    assert.equal(f.el("role-select").value, "claude-role"); assert.equal(f.el("agent-select").value, "claude");
    assert.equal(f.shared.settings.activeAgent, "pi-role");
    assert.equal(f.window.localStorage.getItem("easy_pi.agentRole"), "claude-role");
    assert.ok(f.actionCalls("library").some((item) => item.args.payload.request.kind === "agent" && item.args.payload.request.action === "read"));
    assert.equal(f.actionCalls("library").some((item) => item.args.payload.request.kind === "settings" && "activeAgent" in item.args.payload.request), false);
    await f.choose("pi");
    assert.equal(f.el("role-select").value, "pi-role"); assert.equal(f.el("agent-select").value, "pi");
  } finally { f.close(); }
});

test("failed Claude probe retains Pi, terminal visibility, and the composer draft", async () => {
  const f = fixture({ probeError: "Sidecar unavailable" });
  try {
    f.el("composer-input").value = "Keep the unsent message";
    await f.choose("claude");
    assert.equal(f.runtime.engine(), "pi"); assert.equal(f.el("agent-select").value, "pi");
    assert.equal(f.el("terminal").hidden, false); assert.equal(f.el("claude-view").hidden, true);
    assert.equal(f.el("composer-input").value, "Keep the unsent message");
    assert.equal(f.calls.some((item) => item.command === "start_claude"), false);
    assert.equal(f.lifecycle.includes("stopPi"), false); assert.match(f.toasts.join(" "), /Sidecar unavailable/);
  } finally { f.close(); }
});

test("requireSwitch failure blocks engine startup without mutating composer state", async () => {
  const f = fixture({ switchError: "Current task is busy" });
  try {
    f.el("composer-input").value = "Draft"; await f.choose("claude");
    assert.equal(f.runtime.engine(), "pi"); assert.equal(f.calls.length, 0);
    assert.equal(f.el("composer-input").value, "Draft"); assert.match(f.toasts.join(" "), /Current task is busy/);
  } finally { f.close(); }
});

test("Claude role preference does not overwrite shared Pi activeAgent when toggling library settings", async () => {
  const f = fixture();
  try {
    await f.choose("claude"); await f.lib({ kind: "settings", activeAgent: "claude-role" });
    await f.lib({ kind: "settings", memoryEnabled: false });
    const listed = await f.lib({ kind: "list" });
    assert.equal(listed.data.settings.activeAgent, "claude-role"); assert.equal(listed.data.settings.memoryEnabled, false);
    assert.equal(f.shared.settings.activeAgent, "pi-role"); assert.equal(f.shared.settings.memoryEnabled, false);
    const market = await f.lib({ kind: "market", action: "list" }); assert.equal(market.data.activeAgent, "claude-role");
    await assert.rejects(f.lib({ kind: "settings", activeAgent: "missing" }), /Role does not exist/);
    const retained = await f.lib({ kind: "list" }); assert.equal(retained.data.settings.activeAgent, "claude-role");
  } finally { f.close(); }
});

test("Claude submit forwards original text, attachment objects, and the engine-specific role", async () => {
  const f = fixture();
  try {
    assert.equal(await f.runtime.route("gui_action", { action: "submit", text: "Pi" }), undefined);
    await f.choose("claude"); await f.lib({ kind: "settings", activeAgent: "claude-role" });
    const attachments = [{ path: "/tmp/report.txt", name: "report.txt", mimeType: "text/plain" }];
    const result = await f.runtime.route("gui_action", { action: "submit", text: "expanded Pi context", userText: "Original user text", attachments });
    assert.equal(result.runId, "run-current");
    const submitted = f.actionCalls("submit")[0].args.payload;
    assert.deepEqual(submitted, { text: "Original user text", attachments, roleId: "claude-role" });
    assert.equal(f.workbenchCalls.filter((item) => item.action === "setState").at(-1).value.busy, true);
    await assert.rejects(f.runtime.route("gui_action", { action: "submit", text: "Duplicate" }), /正在运行/);
    await f.runtime.route("gui_action", { action: "stop" }); assert.equal(f.actionCalls("stop").length, 1);
  } finally { f.close(); }
});

test("Claude blocks Pi model and terminal actions while supporting explicit new-session and history routes", async () => {
  const f = fixture();
  try {
    await f.choose("claude");
    for (const command of ["write_terminal", "resize_terminal", "list_models", "add_custom_model", "delete_custom_model", "delete_models", "edit_model", "get_model_edit_info", "restore_removed_models", "install_package", "set_keybinding", "reset_keybinding", "read_keybindings"]) {
      await assert.rejects(f.runtime.route(command), /Pi/);
    }
    for (const action of ["model", "thinking", "command"]) await assert.rejects(f.runtime.route("gui_action", { action, text: "/model" }), /Pi/);
    await f.runtime.route("gui_action", { action: "command", text: "/new" }); assert.equal(f.actionCalls("new_session").length, 1);
    const history = await f.runtime.route("list_sessions");
    assert.equal(history.sessions[0].path, "agent:history-session"); assert.equal(history.sessions[0].modified, 1792100000);
    await f.runtime.reconnect("/project", "agent:history-session");
    assert.equal(f.actionCalls("resume")[0].args.payload.sessionId, "history-session");
    assert.match(f.el("claude-view").textContent, /Resumed actual history/);
    assert.equal(f.el("thinking-select").disabled, true);
  } finally { f.close(); }
});

test("busy Claude status blocks switching engines and reconnecting workspaces", async () => {
  const f = fixture();
  try {
    await f.choose("claude"); f.emit({ type: "status", busy: true, ready: false }); await flush();
    const stops = f.calls.filter((item) => item.command === "stop_claude").length;
    await f.choose("pi"); assert.equal(f.runtime.engine(), "claude");
    assert.equal(f.calls.filter((item) => item.command === "stop_claude").length, stops);
    await assert.rejects(f.runtime.reconnect("/other"), /停止/);
    assert.equal(f.lifecycle.some((item) => typeof item === "object" && "connectPi" in item), false);
  } finally { f.close(); }
});

test("runtime identity filters stale output and callbacks stop after disposal", async () => {
  const f = fixture();
  try {
    await f.choose("claude");
    f.emit({ runtimeId: "runtime-old", type: "text", messageId: "m1", blockId: "b1", text: "Stale secret", append: true });
    assert.doesNotMatch(f.el("claude-view").textContent, /Stale secret/);
    f.emit({ type: "text", messageId: "m1", blockId: "b1", text: "Current output", append: true });
    assert.match(f.el("claude-view").textContent, /Current output/);
    f.runtime.dispose(); assert.equal(f.removed, true);
    const count = f.calls.length;
    f.emit({ type: "result", sessionId: "late-session" }); f.emit({ type: "text", text: "Late" }); await flush();
    assert.equal(f.calls.length, count); assert.equal(f.el("claude-view").childElementCount, 0);
    await assert.rejects(f.runtime.route("gui_status"), /closed/);
  } finally { f.close(); }
});

test("Pi stop failure retains Pi state and draft, and a later switch reuses the idle Claude runtime", async () => {
  const f = fixture({ stopPiError: "Pi refused shutdown" });
  try {
    f.el("composer-input").value = "Keep the Pi draft";
    await f.choose("claude"); assert.equal(f.runtime.engine(), "pi");
    assert.equal(f.calls.filter((item) => item.command === "stop_claude").length, 0);
    assert.equal(f.workbenchCalls.some((item) => ["setRuntime", "setState", "engineChanged"].includes(item.action)), false);
    assert.equal(f.el("agent-select").value, "pi"); assert.match(f.toasts.join(" "), /Pi refused shutdown/);
    assert.equal(f.el("composer-input").value, "Keep the Pi draft");
    assert.equal(f.el("terminal").hidden, false); assert.equal(f.el("claude-view").hidden, true);
    await f.choose("claude"); assert.equal(f.runtime.engine(), "claude");
    assert.equal(f.calls.filter((item) => item.command === "start_claude").length, 1);
    assert.equal(f.el("composer-input").value, "Keep the Pi draft");
  } finally { f.close(); }
});

for (const [option, message] of [
  ["probeError", "Claude executable missing: install the sidecar"],
  ["startClaudeError", "Claude startup failed: check the executable path"],
  ["stopPiError", "Pi refused shutdown: stop the current task"],
  ["switchError", "Current task is busy: stop it before switching"],
]) {
  test(`public selectEngine preserves the original ${option} error`, async () => {
    const error = Error(message), f = fixture({ [option]: error });
    try {
      f.el("composer-input").value = "Keep the draft";
      await assert.rejects(f.runtime.selectEngine("claude"), (actual) => actual === error);
      assert.equal(f.runtime.engine(), "pi"); assert.equal(f.runtime.busy(), false);
      assert.equal(f.el("agent-select").value, "pi"); assert.equal(f.el("agent-select").disabled, false);
      assert.equal(f.el("terminal").hidden, false); assert.equal(f.el("claude-view").hidden, true);
      assert.equal(f.el("composer-input").value, "Keep the draft");
      assert.equal(f.workbenchCalls.some((item) => ["setRuntime", "setState", "engineChanged"].includes(item.action)), false);
      if (option !== "stopPiError") assert.equal(f.lifecycle.includes("stopPi"), false);
      assert.ok(f.toasts.length <= 1, "A switch failure must be reported at most once");
    } finally { f.close(); }
  });
}

test("engine picker reports a startup failure once and a later retry succeeds", async () => {
  const f = fixture({ startClaudeError: "Claude startup failed: check the executable path" });
  try {
    await f.choose("claude");
    assert.equal(f.runtime.engine(), "pi"); assert.equal(f.lifecycle.includes("stopPi"), false);
    assert.equal(f.toasts.length, 1); assert.match(f.toasts[0], /Claude startup failed: check the executable path/);
    await f.choose("claude");
    assert.equal(f.runtime.engine(), "claude"); assert.equal(f.toasts.length, 1);
    assert.equal(f.calls.filter((item) => item.command === "start_claude").length, 2);
    assert.ok(f.trace.lastIndexOf("start_claude") < f.trace.indexOf("stopPi"));
  } finally { f.close(); }
});

test("failed Pi startup retains Claude and restores its workbench before allowing a retry", async () => {
  const error = Error("Pi startup failed: check the Pi executable"), f = fixture({ connectPiError: error });
  try {
    await f.runtime.selectEngine("claude");
    const previousRuntime = f.workbenchCalls.filter((item) => item.action === "setRuntime").at(-1).value;
    const previousState = f.workbenchCalls.filter((item) => item.action === "setState").at(-1).value;
    const changes = f.lifecycle.filter((item) => item === "changed").length;
    const workbenchStart = f.workbenchCalls.length;
    f.el("composer-input").value = "Keep the Claude draft";
    await assert.rejects(f.runtime.selectEngine("pi"), (actual) => actual === error);
    assert.equal(f.runtime.engine(), "claude"); assert.equal(f.runtime.busy(), false);
    assert.equal(f.el("agent-select").value, "claude"); assert.equal(f.el("agent-select").disabled, false);
    assert.equal(f.el("terminal").hidden, true); assert.equal(f.el("claude-view").hidden, false);
    assert.equal(f.el("composer-input").value, "Keep the Claude draft");
    assert.deepEqual(f.workbenchCalls.filter((item) => item.action === "setRuntime").at(-1).value, previousRuntime);
    assert.deepEqual(f.workbenchCalls.filter((item) => item.action === "setState").at(-1).value, previousState);
    assert.equal(f.lifecycle.filter((item) => item === "changed").length, changes);
    assert.ok(f.workbenchCalls.slice(workbenchStart).some((item) => item.action === "setRuntime"), "Rollback must restore the Claude workbench runtime");
    assert.ok(f.workbenchCalls.slice(workbenchStart).some((item) => item.action === "setState"), "Rollback must restore the Claude workbench state");
    assert.equal(f.claudeAlive, true);
    await f.runtime.selectEngine("pi");
    assert.equal(f.runtime.engine(), "pi");
    assert.equal(f.lifecycle.filter((item) => typeof item === "object" && "connectPi" in item).length, 2);
  } finally { f.close(); }
});

for (const notify of [true, false]) {
  test(`Claude sidecar crash while Pi is active is recovered before switching (event=${notify})`, async () => {
    const f = fixture();
    try {
      await f.runtime.selectEngine("claude"); await f.runtime.selectEngine("pi");
      const states = f.workbenchCalls.length;
      f.crashClaude({ notify }); await flush();
      assert.equal(f.runtime.engine(), "pi"); assert.equal(f.workbenchCalls.length, states);
      const traceStart = f.trace.length;
      await f.runtime.selectEngine("claude");
      assert.equal(f.runtime.engine(), "claude"); assert.equal(f.claudeAlive, true);
      assert.equal(f.calls.filter((item) => item.command === "start_claude").length, 2);
      const trace = f.trace.slice(traceStart);
      assert.ok(trace.includes("start_claude"), "An inactive dead sidecar must be restarted");
      assert.ok(trace.indexOf("start_claude") < trace.indexOf("stopPi"), "Pi must run until Claude startup succeeds");
      const status = await f.runtime.route("gui_status");
      assert.equal(status.ready, true); assert.equal(status.connected, true);
      assert.equal(f.toasts.length, 0);
    } finally { f.close(); }
  });
}

test("a failed cached Claude status check is retried through startup before stopping Pi", async () => {
  const f = fixture({ statusError: "Claude status failed: restart the sidecar" });
  try {
    await f.runtime.selectEngine("claude"); await f.runtime.selectEngine("pi");
    const traceStart = f.trace.length;
    await f.runtime.selectEngine("claude");
    assert.equal(f.runtime.engine(), "claude"); assert.equal(f.claudeAlive, true);
    assert.equal(f.calls.filter((item) => item.command === "start_claude").length, 2);
    const trace = f.trace.slice(traceStart);
    assert.ok(trace.indexOf("claude_action:status") < trace.indexOf("start_claude"));
    assert.ok(trace.indexOf("start_claude") < trace.indexOf("stopPi"));
    assert.equal(f.toasts.length, 0);
  } finally { f.close(); }
});

for (const target of ["pi", "claude"]) {
  test(`concurrent selectEngine(${target}) rejects while another switch is in progress`, async () => {
    let release;
    const probeWait = new Promise((resolve) => { release = resolve; });
    const f = fixture({ probeWait });
    const pending = f.runtime.selectEngine("claude");
    try {
      await flush(); assert.equal(f.runtime.busy(), true); assert.equal(f.runtime.engine(), "pi");
      assert.equal(f.el("agent-select").disabled, true);
      await assert.rejects(f.runtime.selectEngine(target), /切换|switch/i);
      assert.equal(f.runtime.busy(), true); assert.equal(f.runtime.engine(), "pi");
      assert.equal(f.lifecycle.includes("stopPi"), false);
      assert.equal(f.calls.filter((item) => item.command === "probe_claude").length, 1);
      release(); await pending;
      assert.equal(f.runtime.engine(), "claude"); assert.equal(f.runtime.busy(), false);
      assert.equal(f.calls.filter((item) => item.command === "start_claude").length, 1);
    } finally { release(); await pending.catch(() => {}); f.close(); }
  });
}

test("browser preview disables engine changes and does not start an engine", async () => {
  const f = fixture({ desktop: false });
  try { assert.equal(f.el("agent-select").disabled, true); await f.choose("claude"); assert.equal(f.calls.length, 0); assert.equal(f.runtime.engine(), "pi"); }
  finally { f.close(); }
});

test("stored Claude mode restores the real runtime before Pi startup", async () => {
  const f = fixture({ storedMode: "claude" });
  try {
    assert.equal(f.runtime.engine(), "pi");
    assert.equal(await f.runtime.restoreStoredEngine(), true);
    assert.equal(f.runtime.engine(), "claude");
    assert.equal(f.el("agent-select").value, "claude");
    assert.equal(f.calls.filter((item) => item.command === "start_claude").length, 1);
    assert.equal(f.calls.some((item) => item.command === "stopPi"), false);
  } finally { f.close(); }
});

test("failed stored Claude restore rolls the picker back to the real Pi engine", async () => {
  const f = fixture({ storedMode: "claude", probeError: "Claude executable missing: install the sidecar" });
  try {
    assert.equal(await f.runtime.restoreStoredEngine(), false);
    assert.equal(f.runtime.engine(), "pi");
    assert.equal(f.runtime.engineMode(), "pi");
    assert.equal(f.el("agent-select").value, "pi");
    assert.equal(f.window.localStorage.getItem("easy_pi.engineMode"), "pi");
    assert.equal(f.toasts.length, 1);
    assert.match(f.toasts[0], /Claude executable missing/);
  } finally { f.close(); }
});

test("auto mode prefers Claude for complex work while keeping the selected mode visible", async () => {
  const f = fixture();
  try {
    f.el("composer-input").value = "Design a secure multi-agent architecture, review the migration plan, and refactor the task scheduler.";
    await f.choose("auto");
    assert.equal(f.runtime.engine(), "claude");
    assert.equal(f.runtime.engineMode(), "auto");
    assert.equal(f.el("agent-select").value, "auto");
    assert.equal(f.calls.filter((item) => item.command === "probe_claude").length, 1);
  } finally { f.close(); }
});

test("Auto pins follow-up messages to the engine of the active or queued task", async () => {
  const f = fixture();
  try {
    await f.choose("auto");
    assert.equal(f.runtime.engine(), "pi");
    const probes = f.calls.filter(item => item.command === "probe_claude").length;
    for (const state of [{ busy: true }, { pending: true }]) {
      f.setWorkbenchState(state);
      await f.runtime.prepareForSubmit("Review security and refactor a multi-agent architecture");
      assert.equal(f.runtime.engine(), "pi");
    }
    assert.equal(f.calls.filter(item => item.command === "probe_claude").length, probes);
    assert.equal(f.lifecycle.includes("stopPi"), false);
  } finally { f.close(); }
});

test("switching back to Pi restores controls hidden by the Claude engine", async () => {
  const f = fixture();
  try {
    const restored = ["terminal", "terminal-welcome", "scroll-bottom", "export-terminal"];
    const initial = Object.fromEntries(restored.map(id => [id, f.el(id).hidden]));
    await f.choose("claude");
    for (const id of restored) assert.equal(f.el(id).hidden, true, id);
    assert.equal(f.el("sendmode-bar").getAttribute("aria-disabled"), "true");
    assert.ok([...f.document.querySelectorAll(".sendmode")].every(button => button.disabled));
    await f.choose("pi");
    for (const id of restored) assert.equal(f.el(id).hidden, initial[id], id);
    assert.equal(f.el("sendmode-bar").getAttribute("aria-disabled"), "false");
    assert.ok([...f.document.querySelectorAll(".sendmode")].every(button => !button.disabled));
  } finally { f.close(); }
});

test("a Claude runtime crash reports a disconnected status until it is restarted", async () => {
  const f = fixture();
  try {
    await f.choose("claude");
    f.crashClaude(); await flush();
    const status = await f.runtime.route("gui_status");
    assert.equal(status.connected, false);
    assert.equal(status.ready, false);
  } finally { f.close(); }
});
