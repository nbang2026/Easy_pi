import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import ts from "typescript";
import { CODING_AGENT } from "../src-tauri/src/gui-market.mjs";
import { createHarness } from "../src-tauri/src/gui-harness.mjs";
import { createToolApprovals } from "../src-tauri/src/gui-approvals.mjs";
import { createUsageLog } from "../src-tauri/src/gui-usage.mjs";
import { safeUserError } from "../src-tauri/src/privacy.mjs";
import { classifyTask, taskRoutingPrompt } from "../src-tauri/src/task-routing.mjs";
import { createTaskScheduler, createTaskWorkspaceTools } from "../src-tauri/src/task-scheduler.mjs";
import { createPiUpdateChecker } from "../src-tauri/src/pi-core-update.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync(new URL("../src-tauri/src/gui-extension.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture(existingFactory, memories = [], agent = null, options = {}) {
  const scratch = fs.mkdtempSync(join(tmpdir(), "pi-harness-extension-"));
  const personaPath = join(scratch, "pi-agent", "APPEND_SYSTEM.md");
  if (typeof options.persona === "string") {
    fs.mkdirSync(join(scratch, "pi-agent"), { recursive:true });
    fs.writeFileSync(personaPath, options.persona);
  }
  const handlers = new Map();
  const frames = [];
  const thinkingCalls = [];
  const capabilityModels = [];
  let thinking = options.thinking ?? "medium";
  const supportedThinkingLevels = (model) => {
    capabilityModels.push(model);
    if (!model.reasoning) return ["off"];
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      return mapped !== null && (!["xhigh", "max"].includes(level) || mapped !== undefined);
    });
  };
  let editor;
  let focus;
  let submitCalls = [];
  let reloads = 0;
  class MockTheme {
    bg(color, text) { return `<bg:${color}>${text}`; }
    fg(color, text) { return `<fg:${color}>${text}`; }
  }
  const originalBg = MockTheme.prototype.bg;
  const originalFg = MockTheme.prototype.fg;
  class MockEditor {
    actionHandlers = new Map();
    value = "";
    constructor() { editor = this; }
    getText() { return this.value; }
    setText(text) { this.value = text; }
    render(width) { return [`top:${width}`, this.value || "cursor", `bottom:${width}`]; }
  }
  class Socket extends EventEmitter {
    writable = true;
    destroyed = false;
    connecting = options.deferConnect === true;
    referenced = false;
    write(bytes) { frames.push(JSON.parse(bytes)); }
    unref() {}
    ref() { this.referenced = true; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  const socket = new Socket();
  const exports = {};
  const tui = { getFocusedComponent: () => focus, requestRender() {} };
  const context = {
    hasUI: true, isIdle: () => true, hasPendingMessages: () => false, cwd: scratch, model: options.model ?? {provider:"test",id:"model",reasoning:true},
    sessionManager: { getSessionFile: () => join(scratch, "real.jsonl"), getSessionId: () => "real", getEntries: () => options.entries ?? [], getBranch: () => options.branch ?? options.entries ?? [] },
    abort() { context.aborted = true; },
    ui: {
      getEditorComponent: () => existingFactory,
      setEditorComponent(factory) {
        editor = factory(tui, {}, {reload(){reloads++;}});
        editor.onSubmit = async (text) => { submitCalls.push(text); };
        editor.actionHandlers ??= new Map();
        editor.actionHandlers.set("app.message.followUp", async () => { submitCalls.push(`queue:${editor.getText()}`); editor.setText(""); });
        focus = editor;
      },
    },
  };
  const timers = [];
  const timer = (callback, ms) => {
    const value = { callback, ms, cleared: false, unref() {} }; timers.push(value); return value;
  };
  const intervals = [];
  let runtimeReady = false;
  const tools = new Map();
  const libraryRequests = [];
  let childSessions = 0, activeChildSessions = 0, maxActiveChildSessions = 0;
  const piSdk = {
    SettingsManager: { create: () => ({ getDefaultProjectTrust: () => options.trustPolicy ?? "ask" }) },
    ProjectTrustStore: class { get() { if (options.trustError) throw Error("unreadable"); return options.trustDecision ?? null; } },
    CustomEditor: MockEditor,
    Theme: MockTheme,
    ModelRuntime: { create: async () => ({ getModel: () => context.model }) },
    DefaultResourceLoader: class {
      constructor(options) { this.options = options; }
      async reload() {}
    },
    SessionManager: { inMemory: (cwd) => ({ cwd }) },
    createAgentSession: options.createAgentSession || (async (sdkOptions) => {
      childSessions++;
      return { session: {
        subscribe(listener) { this.listener = listener; return () => { this.listener = undefined; }; },
        async prompt() {
          const childHandlers = new Map();
          for (const factory of sdkOptions.resourceLoader.options.extensionFactories || []) {
            factory({ on: (event, handler) => childHandlers.set(event, handler) });
          }
          await childHandlers.get("before_provider_request")?.({}, context);
          activeChildSessions++;
          maxActiveChildSessions = Math.max(maxActiveChildSessions, activeChildSessions);
          const reader = sdkOptions.customTools.find(({ name }) => name === "workspace_read");
          await reader.execute(`child-read-${childSessions}`, { path: "service.ts" });
          await new Promise((resolve) => setTimeout(resolve, options.childDelay ?? 1));
          this.listener?.({ type: "message_end", message: { role: "assistant", provider: "test", model: "model",
            timestamp: Date.now(), usage: { input: 2, output: 3, cost: { total: 0.001 } } } });
          activeChildSessions--;
        },
        getLastAssistantText() { return "Checked src/service.ts; no unsafe path handling found."; },
        dispose() {},
      } };
    }),
  };
  vm.runInNewContext(compiled, {
    exports, require: (name) => name === "node:net" ? {createConnection: () => socket}
      : name === "@earendil-works/pi-coding-agent" ? piSdk
      : name === "@earendil-works/pi-ai" ? {Type:{Object:(value)=>value,String:()=>({type:"string"}),Number:()=>({type:"number"}),Array:(value)=>({items:value}),Optional:(value)=>value},getSupportedThinkingLevels:supportedThinkingLevels}
      : name === "./gui-library.mjs" ? {createAgentLibrary:(policy)=>(options.onLibraryOptions?.(policy),{run:async(request,authority)=>{libraryRequests.push([request,authority]);if(options.libraryRun && (request.kind!=="skills" || options.discoveryLibraryRun))return options.libraryRun(request,authority);return request.kind==="context"?{memoryEnabled:true,memories,agent}:request.kind==="skills"?{skills:[],revision:options.skillRevision ?? 0}:{settings:{memoryEnabled:true},memories:[]};},
        routeTask:async(request)=>options.routeTask?options.routeTask(request):{...classifyTask(request.prompt),agent:request.roleId?agent:null,manualAgent:!!request.roleId,skills:[],subagents:[]},
        enabledSkillPaths:async()=>options.enabledSkillPaths?options.enabledSkillPaths():["/tmp/app-skills/example"]})}
      : name === "./gui-harness.mjs" ? {createHarness:(settings)=>{const value=createHarness({...settings,directory:join(scratch,"harness")});options.onHarness?.(value);return value;}}
      : name === "./gui-approvals.mjs" ? {createToolApprovals}
      : name === "./gui-usage.mjs" ? {createUsageLog:()=>createUsageLog({directory:join(scratch,"usage")})}
      : name === "./task-routing.mjs" ? {taskRoutingPrompt}
      : name === "./task-scheduler.mjs" ? {createTaskScheduler,createTaskWorkspaceTools}
      : name === "./privacy.mjs" ? {safeUserError}
      : name === "./pi-core-update.mjs" ? {createPiUpdateChecker:(config)=>createPiUpdateChecker({...config,
        currentVersion:options.piVersion || "",env:options.piUpdateEnv || {},fetch:options.piUpdateFetch || (async()=>new Response(JSON.stringify({version:"1.4.0"})))})}
      : name === "./pi-paths.mjs" ? {agentConfigDirectory:()=>join(scratch,"pi-agent")}
      : require(name),
    process: {env:{PI_GUI_SOCKET:"tcp://127.0.0.1:43210",PI_GUI_TOKEN:"secret"}},
    AbortController, AbortSignal,
    Buffer, URL, setInterval(callback){intervals.push(callback);return timer();}, setTimeout:timer, clearInterval(){},clearTimeout(value){if(value)value.cleared=true;},
  });
  const pi = {
    on:(name,handler) => handlers.set(name,handler),
    registerTool:(tool) => tools.set(tool.name, tool),
    getCommands:() => {
      if (!runtimeReady && options.deferSession) throw Error("Runtime is not bound");
      return options.getCommands ? options.getCommands() : [{name:"skill:example",source:"skill",sourceInfo:{path:"/tmp/app-skills/example/SKILL.md"}}];
    },
    getThinkingLevel() {
      if (!runtimeReady) throw new Error("Extension runtime not initialized");
      return thinking;
    },
    setThinkingLevel(level) {
      if (!runtimeReady) throw new Error("Extension runtime not initialized");
      thinkingCalls.push(level);
      thinking = options.confirmThinking ? options.confirmThinking(level, context.model) : level;
    },
  };
  exports.default(pi);
  if (!options.deferConnect) socket.emit("connect");
  const startSession = async () => {
    runtimeReady = true;
    await handlers.get("session_start")({}, context);
    if (!options.deferDiscovery) await handlers.get("resources_discover")({type:"resources_discover",cwd:context.cwd,reason:"startup"},context);
  };
  if (!options.deferSession) await startSession();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const send = async (id, action, text, mode = "send") => {
    socket.emit("data", Buffer.from(JSON.stringify({id,action,text,mode}) + "\n"));
    await flush();
    if (["harness", "usage", "prepare_shutdown", "library", "approval", "stop", "check_update"].includes(action)) for (let attempt = 0; attempt < 100 && !frames.some(frame => frame.id === id); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    return frames.findLast((frame) => frame.id === id);
  };
  let shutdownPromise;
  return {frames,socket,handlers,context,tui,pi,thinkingCalls,capabilityModels,tools,libraryRequests,intervals,timers,startSession,theme:new MockTheme(),MockTheme,originalBg,originalFg,personaPath,get childSessions(){return childSessions;},get maxActiveChildSessions(){return maxActiveChildSessions;},get editor(){return editor;},get reloads(){return reloads;},submitCalls,flush,send,
    focus: (value) => {focus=value;},shutdown: () => {
      if (shutdownPromise) return shutdownPromise;
      const done = handlers.get("session_shutdown")({},context);
      return shutdownPromise = Promise.resolve(done).then(()=>fs.rmSync(scratch,{recursive:true,force:true}));
    }};
}

test("Pi core update status crosses the GUI bridge without commands or editor changes", async () => {
  let requests = 0;
  const f = await fixture(undefined, [], null, { piVersion: "1.3.0", piUpdateFetch: async () => {
    requests++; return new Response(JSON.stringify({version:"1.4.0"}));
  } });
  try {
    await f.flush();
    assert.equal((await f.send("update-state", "status")).state.coreUpdate.status, "available");
    const checked = await f.send("update-check", "check_update");
    assert.equal(checked.ok, true); assert.equal(checked.data.latestVersion, "1.4.0");
    assert.equal(requests, 2);
    assert.equal(f.editor.getText(), ""); assert.equal(f.submitCalls.length, 0);
    assert.equal((await f.send("still-ready", "status")).state.ready, true);
  } finally { await f.shutdown(); }
});

test("startup snapshots and explicit project trust work before Pi binds its runtime", async () => {
  for (const allow of [true, false]) {
    const f = await fixture(undefined, [], null, { deferSession: true });
    try {
      assert.equal(f.frames.findLast(frame => frame.type === "state").ready, false);
      const waiting = f.handlers.get("project_trust")({ cwd: f.context.cwd });
      const state = (await f.send("startup", "status")).state;
      assert.equal(state.startupPhase, "project_trust");
      assert.equal(state.sessionId, "");
      assert.equal(state.approvals.length, 1);
      assert.equal(state.approvals[0].scope, "project_trust");
      assert.equal((await f.send("trust", "approval", JSON.stringify({ ...state.approvals[0], allow }))).ok, true);
      assert.deepEqual(JSON.parse(JSON.stringify(await waiting)), { trusted: allow ? "yes" : "no", remember: false });
      await f.startSession();
      assert.equal((await f.send("ready", "status")).state.ready, true);
    } finally { await f.shutdown(); }
  }
});

test("disconnects deny pending project trust and reject stale decisions", async () => {
  const f = await fixture(undefined, [], null, { deferSession: true });
  try {
    const waiting = f.handlers.get("project_trust")({ cwd: f.context.cwd });
    const request = f.frames.findLast(frame => frame.type === "approval");
    f.socket.destroy();
    assert.equal((await waiting).trusted, "no");
    f.socket.destroyed = false;
    f.socket.emit("connect");
    assert.equal((await f.send("stale", "approval", JSON.stringify({ ...request, allow: true }))).ok, false);
    f.socket.destroy();
    assert.equal((await f.handlers.get("project_trust")({ cwd: f.context.cwd })).trusted, "no");
  } finally { await f.shutdown(); }
});

test("saved trust decisions remain authoritative and unreadable trust never auto-allows", async () => {
  for (const options of [{ trustDecision: true }, { trustDecision: false }, { trustError: true }, { trustPolicy: "never" }, { trustPolicy: "always" }, { trustDecision: false, trustPolicy: "always" }]) {
    const f = await fixture(undefined, [], null, { ...options, deferSession: true });
    try {
      const result = await f.handlers.get("project_trust")({ cwd: f.context.cwd });
      assert.equal(result.trusted, options.trustDecision === true || options.trustDecision === undefined && options.trustPolicy === "always" ? "yes" : "no");
      assert.equal(f.frames.some(frame => frame.type === "approval"), false);
    } finally { await f.shutdown(); }
  }
});

test("project trust keeps startup alive and authenticates before sending a request", async () => {
  const f = await fixture(undefined, [], null, { deferSession: true, deferConnect: true });
  try {
    const waiting = f.handlers.get("project_trust")({ cwd: f.context.cwd });
    assert.equal(f.socket.referenced, true);
    assert.equal(f.frames.length, 0);
    f.socket.connecting = false; f.socket.emit("connect"); await f.flush();
    assert.equal(f.frames[0].type, "hello");
    const request = f.frames.find(frame => frame.type === "approval");
    assert.ok(request);
    await f.send("allow-startup", "approval", JSON.stringify({ ...request, allow: true }));
    assert.equal((await waiting).trusted, "yes");
  } finally { await f.shutdown(); }
});

test("stream batches extraction, transmits suffixes and does not duplicate the final answer", async () => {
  const f = await fixture();
  try {
    const message = { role: "assistant", id: "long-answer", text: "start" };
    f.handlers.get("message_start")({ type: "message_start", message }, f.context);
    let reads = 0;
    for (let i = 1; i <= 100; i++) {
      const text = "start" + " tail".repeat(i);
      f.handlers.get("message_update")({ type: "message_update", message: {
        role: "assistant", id: message.id, get text() { reads++; return text; },
      } }, f.context);
    }
    assert.equal(reads, 0);
    const flush = f.timers.findLast(timer => timer.ms === 50 && !timer.cleared);
    flush.callback();
    assert.ok(reads <= 2);
    const messages = () => f.frames.filter(frame => frame.type === "message");
    assert.equal(messages().length, 2);
    assert.equal(messages()[1].append, true);
    assert.equal(messages()[1].text, " tail".repeat(100));
    await f.handlers.get("message_end")({ message: { ...message, text: "start" + " tail".repeat(100) } }, f.context);
    assert.equal(messages().length, 2);
    f.handlers.get("message_update")({ type: "message_update", message: { ...message, text: "corrected" } }, f.context);
    await f.handlers.get("message_end")({ message: { ...message, text: "corrected" } }, f.context);
    assert.equal(messages().at(-1).append, false);
    assert.equal(messages().at(-1).text, "corrected");
  } finally { await f.shutdown(); }
});

test("status totals include compacted and forked session usage, tool usage and separately recorded usage", async () => {
  const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.01 } };
  const f = await fixture(undefined, [], null, { entries: [
    { type: "message", message: { role: "assistant", usage } },
    { type: "message", message: { role: "toolResult", usage } },
    { type: "compaction", usage }, { type: "branch_summary", usage }, { type: "usage", usage },
    { type: "message", message: { role: "user", usage } },
  ] });
  try {
    const state = (await f.send("totals", "status")).state;
    assert.equal(state.usage.tokens, 100);
    assert.equal(state.usage.cost, 0.05);
  } finally { await f.shutdown(); }
});

test("native shutdown persists an interrupted task before acknowledging cleanup", async () => {
  const f = await fixture();
  try {
    await f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.context);
    const response = await f.send("closing", "prepare_shutdown");
    assert.equal(response.ok, true); assert.equal(f.context.aborted, true);
    const state = await f.send("after-closing", "harness", JSON.stringify({ action: "status" }));
    assert.equal(state.data.current.state, "interrupted");
  } finally { await f.shutdown(); }
});

test("harness GUI settings reach real tool hooks, shell entry and pre-call limits", async () => {
  const f = await fixture();
  try {
    const status = (await f.send("h-status", "harness", JSON.stringify({ action: "status" }))).data;
    assert.equal((await f.send("h-config", "harness", JSON.stringify({ action: "configure", expectedWorkspace: status.workspace,
      expectedRevision: status.revision, settings: { ...status.settings, mode: "readonly", maxToolCalls: 1 } }))).ok, true);
    await f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.context);
    const blocked = await f.handlers.get("tool_call")({ toolName: "bash", toolCallId: "blocked", input: { command: "touch should-not-exist" } }, f.context);
    assert.equal(blocked.block, true);
    const shell = await f.handlers.get("user_bash")({ command: "touch should-not-exist" }, f.context);
    assert.equal(shell.result.exitCode, 1);
    const limited = await f.handlers.get("tool_call")({ toolName: "ls", toolCallId: "after-limit", input: {} }, f.context);
    assert.equal(limited.terminate, true); assert.equal(f.context.aborted, true);
    assert.equal((await f.send("h-final", "harness", JSON.stringify({ action: "status" }))).data.current.state, "limited");
  } finally { await f.shutdown(); }
});

test("Pi tool approval reaches the GUI, binds the session and unblocks only after a one-time answer", async () => {
  const f = await fixture();
  try {
    await f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.context);
    let settled = false;
    const waiting = f.handlers.get("tool_call")({ toolName: "bash", toolCallId: "approval-test", input: { command: "printf safe" } }, f.context)
      .then(value => { settled = true; return value; });
    for (let n = 0; n < 100 && !f.frames.some(frame => frame.type === "approval"); n++) await new Promise(resolve => setTimeout(resolve, 5));
    const approval = f.frames.find(frame => frame.type === "approval");
    assert.ok(approval); assert.equal(settled, false);
    const status = await f.send("pending-status", "status");
    assert.equal(status.state.approvals.length, 1);
    const spoof = await f.send("spoofed", "approval", JSON.stringify({ requestId: approval.requestId, sessionId: "wrong", allow: true }));
    assert.equal(spoof.ok, false); assert.equal(settled, false);
    const granted = await f.send("grant", "approval", JSON.stringify({ requestId: approval.requestId, sessionId: "real", allow: true }));
    assert.equal(granted.ok, true); assert.deepEqual({ ...await waiting }, {});
    assert.ok(f.frames.some(frame => frame.type === "approval_resolved"));
    const duplicate = await f.send("duplicate-grant", "approval", JSON.stringify({ requestId: approval.requestId, sessionId: "real", allow: true }));
    assert.equal(duplicate.ok, false);
  } finally { await f.shutdown(); }
});

test("Pi one-click permissions persist first and release pending and future tools through the GUI bridge", async () => {
  const f = await fixture();
  try {
    await f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.context);
    const waiting = f.handlers.get("tool_call")({ toolName: "bash", toolCallId: "full-pending", input: { command: "printf safe" } }, f.context);
    for (let n = 0; n < 100 && !f.frames.some(frame => frame.type === "approval"); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(f.frames.some(frame => frame.type === "approval"));
    const before = (await f.send("full-status", "harness", JSON.stringify({ action: "status" }))).data;
    const granted = await f.send("full-grant", "harness", JSON.stringify({ action: "permissions", mode: "autonomous",
      expectedWorkspace: before.workspace, expectedRevision: before.revision }));
    assert.equal(granted.ok, true);
    assert.deepEqual({ ...await waiting }, {});
    const future = await f.handlers.get("tool_call")({ toolName: "bash", toolCallId: "full-future", input: { command: "printf safe" } }, f.context);
    assert.deepEqual({ ...future }, {});
    assert.equal(f.frames.filter(frame => frame.type === "approval").length, 1);
    assert.ok(f.frames.some(frame => frame.type === "approval_resolved"));
    assert.equal(granted.data.settings.maxToolCalls, before.settings.maxToolCalls);
    assert.equal((await f.send("full-after", "status")).state.approvals.length, 0);
  } finally { await f.shutdown(); }
});

test("Pi automatic download authorization follows live permissions and expires on stop", async () => {
  let host,harness;
  const f=await fixture(undefined,[],null,{onLibraryOptions:policy=>{host=policy;},onHarness:value=>{harness=value;}});
  try {
    await f.handlers.get("before_agent_start")({prompt:"Inspect frontend",systemPrompt:"base"},f.context);
    assert.equal(await host.canModelDownload(),false);
    const set=async mode=>{
      const before=(await f.send(`before-${mode}-${Date.now()}`,"harness",JSON.stringify({action:"status"}))).data;
      const response=await f.send(`set-${mode}-${Date.now()}`,"harness",JSON.stringify({action:"permissions",mode,expectedWorkspace:before.workspace,expectedRevision:before.revision}));
      assert.equal(response.ok,true);
    };
    await set("autonomous"); assert.equal(harness.snapshot().limits.mode,"autonomous");assert.equal(await host.canModelDownload(),true);
    await set("confirm"); assert.equal(harness.snapshot().limits.mode,"confirm");assert.equal(await host.canModelDownload(),false);
    await set("autonomous"); assert.equal(await host.canModelDownload(),true);
    await f.send("stop-downloads","stop"); assert.equal(await host.canModelDownload(),false);
  } finally {await f.shutdown();}
});

test("Pi stop and bridge disconnect dismiss outstanding requests without running the tool", async () => {
  for (const kind of ["stop", "disconnect"]) {
    const f = await fixture();
    try {
      await f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.context);
      const waiting = f.handlers.get("tool_call")({ toolName: "bash", toolCallId: kind, input: { command: "printf safe" } }, f.context);
      for (let n = 0; n < 100 && !f.frames.some(frame => frame.type === "approval"); n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(f.frames.some(frame => frame.type === "approval"));
      if (kind === "stop") assert.equal((await f.send("stop-waiting", "stop")).ok, true);
      else f.socket.destroy();
      assert.equal((await waiting).block, true);
    } finally { await f.shutdown(); }
  }
});

test("memory mutations reject stale GUI project context before reaching storage", async () => {
  const f = await fixture();
  try {
    const before = f.libraryRequests.length;
    const stale = await f.send("stale-memory", "library", JSON.stringify({ kind: "memory", action: "save",
      title: "draft A", content: "A", expectedWorkspace: "/different-project" }));
    assert.equal(stale.ok, false); assert.equal(f.libraryRequests.length, before);
    const current = await f.send("current-memory", "library", JSON.stringify({ kind: "memory", action: "save",
      title: "draft", content: "current", expectedWorkspace: f.context.cwd }));
    assert.equal(current.ok, true);
    assert.equal(f.libraryRequests.at(-1)[0].workspace, f.context.cwd);
  } finally { await f.shutdown(); }
});

test("library settings report the policy actually used to evaluate model tools", async () => {
  const f = await fixture();
  try {
    const list = await f.send("policy-default", "library", JSON.stringify({ kind: "list" }));
    assert.equal(list.data.executionMode, "project");
    const status = (await f.send("policy-status", "harness", JSON.stringify({ action: "status" }))).data;
    await f.send("policy-change", "harness", JSON.stringify({ action: "configure", expectedWorkspace: status.workspace,
      expectedRevision: status.revision, settings: { ...status.settings, mode: "autonomous" } }));
    const changed = await f.send("policy-new", "library", JSON.stringify({ kind: "list" }));
    assert.equal(changed.data.executionMode, "autonomous");
  } finally { await f.shutdown(); }
});

test("message persistence feeds secret-free usage logs once and task settlement remains unverified", async () => {
  const entries = [];
  const f = await fixture(undefined, [], null, { entries });
  try {
    await f.handlers.get("before_agent_start")({ systemPrompt: "base" }, f.context);
    const message = { role: "assistant", provider: "test", model: "real-model", timestamp: Date.now(),
      content: [{ type: "text", text: "private conversation" }], usage: { input: 9, output: 3, cost: { total: 0.02 } } };
    f.handlers.get("message_end")({ message }, f.context);
    entries.push({ id: "paid-once", type: "message", message, timestamp: new Date(message.timestamp).toISOString() });
    f.intervals[0]();
    const first = await f.send("usage-a", "usage", JSON.stringify({ action: "summary" }));
    assert.equal(first.data.all.tokens, 12); assert.equal(first.data.all.records, 1);
    const second = await f.send("usage-b", "usage", JSON.stringify({ action: "export", format: "json" }));
    assert.equal(JSON.parse(second.data.content).all.records, 1);
    assert.ok(!second.data.content.includes("private conversation"));
    f.handlers.get("agent_settled")({ aborted: false }, f.context);
    const task = await f.send("settled", "harness", JSON.stringify({ action: "status" }));
    assert.equal(task.data.current.state, "awaiting_verification");
  } finally { await f.shutdown(); }
});

test("usage waits for message persistence, caches unchanged snapshots and clears on session switch", async () => {
  const f = await fixture();
  let entries = [], reads = 0;
  f.context.sessionManager.getEntries = () => { reads++; return entries; };
  try {
    await f.handlers.get("message_end")({},f.context);
    entries = [{type:"message",message:{role:"assistant",usage:{input:7,output:3,cost:{total:0.2}}}}];
    f.intervals[0]();
    assert.equal(f.frames.findLast(frame => frame.type === "state").usage.tokens,10);
    assert.equal(reads,1);
    f.intervals[0](); f.intervals[0]();
    assert.equal(reads,1);
    entries = [{type:"message",message:{role:"assistant",usage:{input:1,output:2}}}];
    await f.handlers.get("session_start")({},f.context);
    assert.equal(f.frames.findLast(frame => frame.type === "state").usage.tokens,3);
    assert.equal(f.frames.findLast(frame => frame.type === "state").usage.cost,null);
  } finally { f.shutdown(); }
});

test("native user input is transparent while other theme tokens and shutdown remain unchanged", async () => {
  const f=await fixture();
  assert.equal(f.theme.bg("userMessageBg","hi"),"\x1b[49mhi\x1b[49m");
  assert.equal(f.theme.fg("userMessageText","hi"),"\x1b[39mhi\x1b[39m");
  assert.equal(f.theme.bg("toolSuccessBg","result"),"<bg:toolSuccessBg>result");
  assert.equal(f.theme.fg("error","error"),"<fg:error>error");
  assert.equal(f.frames.findLast((frame) => frame.type==="state").transparentInput,true);
  f.shutdown();
  assert.equal(f.MockTheme.prototype.bg,f.originalBg);
  assert.equal(f.MockTheme.prototype.fg,f.originalFg);
});
test("native keybindings reload immediately without clearing the editor or reloading the session", async () => {
  const f=await fixture();f.editor.setText("keep draft");
  assert.equal((await f.send("keys","keybindings")).ok,true);
  assert.equal(f.reloads,1);assert.equal(f.editor.getText(),"keep draft");
  assert.deepEqual(f.submitCalls,[]);f.shutdown();
});
test("memory and Agent tools distinguish model authority from GUI permission edits", async () => {
  const f=await fixture();
  assert.equal(f.tools.size,9);
  assert.ok(f.tools.has("gui_workbench"));
  await f.tools.get("gui_memory").execute("id",{action:"save",title:"Preference",content:"Use Chinese"});
  assert.equal(f.libraryRequests.at(-1)[1],"model");
  await assert.rejects(f.tools.get("gui_agent_library").execute("id",{action:"settings"}));
  const response=await f.send("library","library",JSON.stringify({kind:"settings",autonomousDownloads:false}));
  assert.equal(response.ok,true);assert.equal(f.libraryRequests.at(-1)[1],"user");
  f.shutdown();
});

test("Pi scheduler launches bounded in-memory child sessions on the current model and aggregates their usage", async () => {
  const f = await fixture(undefined, [], null, {
    childDelay: 10,
    routeTask: async (request) => ({
      ...classifyTask(request.prompt),
      agent: request.excludeAgentIds?.length
        ? { id: `child-${request.excludeAgentIds.length}`, title: "Task specialist", content: "Inspect evidence." }
        : { id: "primary-role", title: "Primary specialist", content: "Coordinate the project." },
      manualAgent: false, skills: [], subagents: [],
    }),
  });
  try {
    const prompt = "Implement an end-to-end multi-module frontend, security and testing workflow.";
    await f.handlers.get("before_agent_start")({ prompt, systemPrompt: "base" }, f.context);
    fs.writeFileSync(join(f.context.cwd, "service.ts"), "export const ready = true;\n");
    await f.handlers.get("turn_start")({}, f.context);
    const tool = f.tools.get("gui_delegate");
    const toolCallInput = { tasks: [
      { id: "security", title: "Security review", domain: "security", prompt: "Inspect path handling and report concrete risks." },
      { id: "tests", title: "Test review", domain: "testing", prompt: "Inspect current tests and identify missing regression cases." },
    ] };
    await f.handlers.get("tool_call")({ toolName: "gui_delegate", toolCallId: "outer-delegate", input: toolCallInput }, f.context);
    const updates = [];
    const response = await tool.execute("delegate", toolCallInput, undefined, (event) => updates.push(event));
    await f.handlers.get("tool_result")({ toolCallId: "outer-delegate", isError: false }, f.context);
    const result = JSON.parse(response.content[0].text);
    assert.equal(response.isError, undefined);
    assert.equal(result.completed, 2);
    assert.equal(f.childSessions, 2);
    assert.ok(f.maxActiveChildSessions <= 3);
    assert.deepEqual(result.tasks.map(({ status }) => status), ["completed", "completed"]);
    assert.match(result.tasks[0].result, /src\/service\.ts/);
    assert.ok(updates.some((event) => event.details.status === "running"));
    assert.equal(f.context.aborted, undefined);
    const status = (await f.send("delegation-budget", "harness", JSON.stringify({ action: "status" }))).data;
    assert.equal(status.current.usage.turns, 3);
    assert.equal(status.current.usage.tokens, 10);
    assert.equal(status.current.usage.toolCalls, 3);
  } finally { await f.shutdown(); }
});

test("Pi scheduler refuses child work for simple prompts", async () => {
  const f = await fixture();
  try {
    await f.handlers.get("before_agent_start")({ prompt: "Summarize this paragraph", systemPrompt: "base" }, f.context);
    await assert.rejects(f.tools.get("gui_delegate").execute("delegate", { tasks: [
      { id: "review", title: "Review", domain: "review", prompt: "Review the code." },
    ] }), /未达到 Agent 协同调度条件/);
    assert.equal(f.childSessions, 0);
  } finally { await f.shutdown(); }
});

test("thinking snapshots use current model capabilities and remain safe before session initialization", async () => {
  const model = {provider:"test",id:"reasoner",reasoning:true,thinkingLevelMap:{minimal:null,xhigh:"xhigh",max:null}};
  const f = await fixture(undefined, [], null, {model});
  try {
    assert.equal(f.frames[1].thinking, "");
    assert.equal(f.frames[1].thinkingSupported, false);
    assert.deepEqual(f.frames[1].thinkingLevels, []);
    const response = await f.send("capabilities", "status");
    assert.equal(response.state.thinkingSupported, true);
    assert.deepEqual(response.state.thinkingLevels, ["off", "low", "medium", "high", "xhigh"]);
    assert.ok(f.capabilityModels.length > 0);
    assert.ok(f.capabilityModels.every((value) => value === model));
  } finally { f.shutdown(); }
});

test("thinking action sets Pi directly and acknowledges the confirmed native level without submitting text", async () => {
  const f = await fixture();
  try {
    f.editor.setText("keep native draft");
    const model = f.context.model;
    const high = await f.send("thinking-high", "thinking", "high");
    assert.equal(high.ok, true);
    assert.deepEqual(high.data, {thinking:"high",thinkingSupported:true,thinkingLevels:["off","minimal","low","medium","high"]});
    assert.equal(high.state.thinking, high.data.thinking);
    assert.equal(high.state.thinkingSupported, high.data.thinkingSupported);
    assert.deepEqual(high.state.thinkingLevels, high.data.thinkingLevels);
    assert.equal(high.state.busy, false);
    assert.equal((await f.send("thinking-high", "thinking", "high")).ok, true);
    assert.deepEqual(f.thinkingCalls, ["high"]);
    const off = await f.send("thinking-off", "thinking", "off");
    assert.equal(off.ok, true);
    assert.equal(off.data.thinking, "off");
    assert.equal(off.state.thinking, "off");
    assert.equal(f.frames.findLast((frame) => frame.type === "state").thinking, "off");
    assert.deepEqual(f.thinkingCalls, ["high", "off"]);
    assert.deepEqual(f.submitCalls, []);
    assert.equal(f.editor.getText(), "keep native draft");
    assert.equal(f.context.model, model);
  } finally { f.shutdown(); }
});

test("thinking acknowledgment reads Pi's actual level when the setter downgrades the request", async () => {
  const f = await fixture(undefined, [], null, {confirmThinking:() => "low"});
  try {
    const response = await f.send("downgrade", "thinking", "high");
    assert.equal(response.ok, true);
    assert.deepEqual(f.thinkingCalls, ["high"]);
    assert.equal(response.data.thinking, "low");
    assert.equal(response.state.thinking, "low");
    assert.equal(f.pi.getThinkingLevel(), "low");
  } finally { f.shutdown(); }
});

test("invalid or model-disabled thinking levels preserve the previous Pi level", async () => {
  const model = {provider:"test",id:"limited",reasoning:true,thinkingLevelMap:{high:null}};
  const f = await fixture(undefined, [], null, {model});
  try {
    const invalid = [undefined, null, 1, {}, "", "HIGH", " high", "high", "xhigh", "max", "/thinking high", "low\nhigh"];
    for (const [index, level] of invalid.entries()) {
      const response = await f.send(`invalid-${index}`, "thinking", level);
      assert.equal(response.ok, false);
      assert.match(response.error, /不支持该思考等级/);
      assert.equal(f.pi.getThinkingLevel(), "medium");
    }
    assert.deepEqual(f.thinkingCalls, []);
    assert.deepEqual(f.submitCalls, []);
  } finally { f.shutdown(); }
});

test("model selection refreshes thinking support and rejects every action on non-reasoning models", async () => {
  const f = await fixture();
  try {
    await f.send("high", "thinking", "high");
    f.context.model = {provider:"test",id:"plain",reasoning:false};
    f.pi.setThinkingLevel("off");
    f.thinkingCalls.length = 0;
    f.handlers.get("model_select")({}, f.context);
    const state = f.frames.findLast((frame) => frame.type === "state");
    assert.equal(state.model, "test/plain");
    assert.equal(state.thinking, "off");
    assert.equal(state.thinkingSupported, false);
    assert.deepEqual(state.thinkingLevels, ["off"]);
    for (const level of ["high", "off"]) {
      const response = await f.send(`unsupported-${level}`, "thinking", level);
      assert.equal(response.ok, false);
      assert.match(response.error, /不支持深度思考/);
      assert.equal(f.pi.getThinkingLevel(), "off");
    }
    assert.deepEqual(f.thinkingCalls, []);
    f.context.model = {provider:"test",id:"off-only",reasoning:true,thinkingLevelMap:{minimal:null,low:null,medium:null,high:null}};
    f.handlers.get("model_select")({}, f.context);
    assert.equal(f.frames.findLast((frame) => frame.type === "state").thinkingSupported, false);
    assert.equal((await f.send("off-only", "thinking", "off")).ok, false);
    f.context.model = {provider:"test",id:"reasoner",reasoning:true};
    f.handlers.get("model_select")({}, f.context);
    assert.equal((await f.send("restored", "thinking", "high")).data.thinking, "high");
  } finally { f.shutdown(); }
});

test("thinking remains blocked through agent_end and cancellation until agent_settled", async () => {
  const f = await fixture();
  try {
    f.handlers.get("agent_start")({}, f.context);
    assert.equal((await f.send("running", "thinking", "high")).ok, false);
    f.handlers.get("agent_end")({}, f.context);
    assert.equal((await f.send("between-turns", "thinking", "high")).ok, false);
    assert.equal((await f.send("cancel", "stop")).ok, true);
    assert.equal(f.context.aborted, true);
    assert.equal((await f.send("cancelling", "thinking", "high")).ok, false);
    assert.equal(f.pi.getThinkingLevel(), "medium");
    assert.deepEqual(f.thinkingCalls, []);
    f.handlers.get("agent_settled")({}, f.context);
    assert.equal((await f.send("settled", "thinking", "high")).ok, true);
    assert.deepEqual(f.thinkingCalls, ["high"]);
    f.context.isIdle = () => false;
    assert.equal((await f.send("native-busy", "thinking", "off")).ok, false);
    assert.equal(f.pi.getThinkingLevel(), "high");
  } finally { f.shutdown(); }
});

test("thinking requires a focused ready editor and no pending submission", async () => {
  const f = await fixture();
  let complete;
  try {
    let escapes = 0;
    f.focus({handleInput() { escapes++; }});
    assert.equal((await f.send("selector", "thinking", "high")).ok, false);
    assert.equal(escapes, 0);
    f.focus(f.editor);
    f.editor.onSubmit = () => new Promise((resolve) => {complete = resolve;});
    assert.equal(await f.send("pending-submit", "submit", "message"), undefined);
    assert.equal((await f.send("submitting", "thinking", "high")).ok, false);
    assert.deepEqual(f.thinkingCalls, []);
    assert.equal(f.pi.getThinkingLevel(), "medium");
    complete();
    await f.flush();
    assert.equal((await f.send("ready", "thinking", "high")).ok, true);
  } finally { complete?.(); f.shutdown(); }
});

test("unavailable or failed native thinking APIs return errors without a false success", async () => {
  const f = await fixture();
  try {
    const setter = f.pi.setThinkingLevel;
    f.pi.setThinkingLevel = undefined;
    assert.equal((await f.send("unavailable", "thinking", "high")).ok, false);
    assert.equal(f.pi.getThinkingLevel(), "medium");
    f.pi.setThinkingLevel = () => { throw new Error("Native thinking update failed"); };
    const response = await f.send("failed", "thinking", "high");
    assert.equal(response.ok, false);
    assert.match(response.error, /Native thinking update failed/);
    assert.equal(f.pi.getThinkingLevel(), "medium");
    f.pi.setThinkingLevel = setter;
    const getter = f.pi.getThinkingLevel;
    f.pi.getThinkingLevel = undefined;
    assert.equal((await f.send("no-readback", "thinking", "high")).ok, false);
    assert.deepEqual(f.thinkingCalls, []);
    f.pi.getThinkingLevel = getter;
    assert.equal(f.pi.getThinkingLevel(), "medium");
  } finally { f.shutdown(); }
});

test("bridge hello authenticates and native submit acknowledges once", async () => {
  const f = await fixture();
  assert.deepEqual(f.frames[0], {type:"hello",token:"secret"});
  assert.equal(f.frames[1].thinking, "");
  assert.equal(f.frames.findLast((frame) => frame.type === "state").thinking, "medium");
  assert.equal((await f.send("a","submit","中文输入")).ok, true);
  assert.deepEqual(f.submitCalls, ["中文输入"]);
  assert.equal((await f.send("a","submit","中文输入")).ok, true);
  assert.equal(f.submitCalls.length, 1);
  f.shutdown();
});
test("native acceptance acknowledges a long-running submission without blocking later input or clearing a new draft", async () => {
  const f = await fixture(); const completion = deferred();
  try {
    f.editor.onSubmit = text => { f.submitCalls.push(text); return completion.promise; };
    assert.equal(await f.send("long", "submit", "long task"), undefined);
    f.handlers.get("message_start")({ type: "message_start", message: { role: "user", id: "user-long", text: "different input" } }, f.context);
    await f.flush();
    assert.equal(f.frames.some(frame => frame.id === "long"), false);
    f.editor.setText("new native draft");
    f.handlers.get("message_start")({ type: "message_start", message: { role: "user", id: "accepted-long", text: "long task" } }, f.context);
    await f.flush();
    assert.equal(f.frames.find(frame => frame.id === "long").ok, true);
    assert.equal(f.editor.getText(), "new native draft");
    await f.send("long", "submit", "long task");
    assert.equal(f.submitCalls.length, 1);
    f.editor.setText(""); f.handlers.get("agent_start")({}, f.context);
    assert.equal((await f.send("queued-next", "submit", "next", "queue")).delivery, "followUp");
    completion.resolve();
  } finally { completion.resolve(); await f.shutdown(); }
});

test("accepted native queue input preserves a later editor draft instead of reporting a false rejection", async () => {
  const f = await fixture(); const completion = deferred();
  try {
    f.handlers.get("agent_start")({}, f.context);
    f.editor.actionHandlers.set("app.message.followUp", () => completion.promise);
    assert.equal(await f.send("deferred-queue", "submit", "queued request", "queue"), undefined);
    f.editor.setText("new native input");
    f.handlers.get("message_start")({ type: "message_start", message: { role: "user", id: "accepted-queue", text: "queued request" } }, f.context);
    await f.flush();
    assert.equal(f.frames.find(frame => frame.id === "deferred-queue").ok, true);
    assert.equal(f.editor.getText(), "new native input");
  } finally { completion.resolve(); await f.shutdown(); }
});

test("an unacknowledged native submit times out without allowing duplicate execution and recovers when settled", async () => {
  const f = await fixture(); const completion = deferred();
  try {
    f.editor.onSubmit = text => { f.submitCalls.push(text); return completion.promise; };
    assert.equal(await f.send("stalled-send", "submit", "long request"), undefined);
    const timer = f.timers.findLast(timer => timer.ms === 6000 && !timer.cleared);
    assert.ok(timer); timer.callback(); await f.flush();
    const failed = f.frames.find(frame => frame.id === "stalled-send");
    assert.equal(failed.ok, false); assert.match(failed.error, /6 秒.*草稿/);
    const blocked = await f.send("recovery-status", "status");
    assert.equal(blocked.state.inputRecovery, true); assert.equal(blocked.state.ready, false);
    assert.equal((await f.send("duplicate-attempt", "submit", "long request")).ok, false);
    assert.equal(f.submitCalls.length, 1);
    completion.resolve(); await f.flush();
    const recovered = await f.send("recovered-status", "status");
    assert.equal(recovered.state.inputRecovery, false); assert.equal(recovered.state.ready, true);
    assert.equal((await f.send("after-recovery", "submit", "new request")).ok, true);
    assert.equal(f.submitCalls.length, 2);
  } finally { completion.resolve(); await f.shutdown(); }
});

test("late native acceptance clears recovery but accepted long tasks have no admission deadline", async () => {
  const f = await fixture(); const completion = deferred();
  try {
    f.editor.onSubmit = () => completion.promise;
    await f.send("late-admission", "submit", "long request");
    const timer = f.timers.findLast(timer => timer.ms === 6000 && !timer.cleared);
    timer.callback(); await f.flush();
    f.context.isIdle = () => false;
    f.handlers.get("agent_start")({}, f.context);
    f.handlers.get("message_start")({ type: "message_start", message: { role: "user", text: "long request" } }, f.context);
    await f.flush();
    assert.equal((await f.send("late-confirmed-status", "status")).state.inputRecovery, false);
    assert.equal(f.context.aborted, undefined);
    assert.equal(f.frames.filter(frame => frame.id === "late-admission").length, 1);
    assert.equal(timer.cleared, true);
    for (let i = 0; i < 10; i++) f.intervals[0]();
    assert.equal((await f.send("still-running", "status")).state.busy, true);
    assert.equal(f.context.aborted, undefined);
  } finally { completion.resolve(); await f.shutdown(); }
});

test("stopping an uncertain submission keeps it quarantined only until native completion", async () => {
  const f = await fixture(); const completion = deferred();
  try {
    f.editor.onSubmit = () => completion.promise;
    await f.send("pending-before-stop", "submit", "pending");
    assert.equal((await f.send("stop-uncertain", "stop")).ok, true);
    const status = await f.send("after-uncertain-stop", "status");
    assert.equal(status.state.inputRecovery, true);
    assert.equal((await f.send("not-yet-safe", "submit", "retry")).ok, false);
    completion.reject(new Error("Native operation cancelled")); await f.flush();
    assert.equal((await f.send("safe-after-stop", "status")).state.inputRecovery, false);
    f.editor.onSubmit = async text => f.submitCalls.push(text);
    assert.equal((await f.send("safe-retry", "submit", "continue")).ok, true);
  } finally { completion.resolve(); await f.shutdown(); }
});

test("disconnect releases an unconfirmed submit and reconnect returns its cached failure without replay", async () => {
  const f = await fixture(); const completion = deferred();
  try {
    f.editor.onSubmit = text => { f.submitCalls.push(text); return completion.promise; };
    await f.send("disconnect-submit", "submit", "pending input");
    f.socket.writable = false; f.socket.emit("close"); await f.flush();
    f.socket.writable = true; f.socket.emit("connect");
    const cached = await f.send("disconnect-submit", "submit", "pending input");
    assert.equal(cached.ok, false); assert.match(cached.error, /桥接已断开/);
    assert.equal(f.submitCalls.length, 1);
    assert.equal((await f.send("disconnect-recovery", "status")).state.inputRecovery, true);
    completion.resolve(); await f.flush();
    assert.equal((await f.send("disconnect-recovered", "status")).state.inputRecovery, false);
  } finally { completion.resolve(); await f.shutdown(); }
});

test("a session switch cancels the old submission without clearing the new session's matching draft", async () => {
  const f = await fixture(); const completion = deferred();
  try {
    f.editor.onSubmit = () => completion.promise;
    await f.send("old-session-submit", "submit", "matching text");
    f.context.sessionManager.getSessionId = () => "new-session";
    const switched = f.handlers.get("session_start")({}, f.context);
    f.editor.setText("matching text");
    await switched; await f.flush();
    assert.equal(f.frames.find(frame => frame.id === "old-session-submit").ok, false);
    assert.equal(f.editor.getText(), "matching text");
    f.editor.setText("");
    f.editor.onSubmit = async text => f.submitCalls.push(text);
    assert.equal((await f.send("new-session-submit", "submit", "new task")).ok, true);
    completion.resolve(); await f.flush();
    assert.equal((await f.send("new-session-status", "status")).state.inputRecovery, false);
  } finally { completion.resolve(); await f.shutdown(); }
});

test("stop releases an unaccepted pending submit and identical state publishes are coalesced", async () => {
  const f = await fixture(); const completion = deferred();
  try {
    const states = () => f.frames.filter(frame => frame.type === "state").length;
    await f.send("status-1", "status"); const before = states();
    await f.send("status-2", "status");
    assert.equal(states(), before);
    f.editor.onSubmit = () => completion.promise;
    await f.send("pending-submit", "submit", "pending");
    assert.equal((await f.send("stop-pending", "stop")).ok, true);
    await f.flush();
    assert.equal(f.frames.find(frame => frame.id === "pending-submit").ok, false);
    assert.match(f.frames.find(frame => frame.id === "pending-submit").error, /取消/);
  } finally { completion.resolve(); await f.shutdown(); }
});

test("selectors and native drafts reject GUI input without replacing text", async () => {
  const f = await fixture();
  f.focus({});
  assert.equal((await f.send("a","submit","message")).ok, false);
  f.focus(f.editor);
  f.editor.setText("native draft");
  assert.equal((await f.send("b","submit","message")).ok, false);
  assert.equal(f.editor.getText(), "native draft");
  assert.equal(f.submitCalls.length, 0);
  f.shutdown();
});
test("busy follow-up uses the real editor action and stop calls abort", async () => {
  const f = await fixture();
  f.handlers.get("agent_start")({},f.context);
  assert.equal((await f.send("a","submit","next","queue")).ok, true);
  assert.deepEqual(f.submitCalls, ["queue:next"]);
  assert.equal((await f.send("b","stop")).ok, true);
  assert.equal(f.context.aborted, true);
  f.shutdown();
});
test("invalid input and async failures preserve the GUI-owned draft", async () => {
  const f = await fixture();
  assert.equal((await f.send("a","submit","/new")).ok, false);
  assert.equal((await f.send("b","command","/new\n/model")).ok, false);
  f.editor.onSubmit = async () => {throw new Error("blocked by Pi");};
  const response = await f.send("c","submit","Keep this");
  assert.equal(response.ok, false);
  assert.match(response.error, /blocked by Pi/);
  assert.equal(f.editor.getText(), "");
  f.shutdown();
});
test("UTF-8 messages split across transport chunks are preserved", async () => {
  const f = await fixture();
  const bytes = Buffer.from(JSON.stringify({id:"a",action:"submit",text:"中文",mode:"send"})+"\n");
  const split = bytes.indexOf(Buffer.from("中")) + 1;
  f.socket.emit("data", bytes.subarray(0, split));
  f.socket.emit("data", bytes.subarray(split));
  await f.flush();
  assert.deepEqual(f.submitCalls, ["中文"]);
  f.shutdown();
});
test("a pending request cannot be submitted twice", async () => {
  const f = await fixture();
  let complete;
  f.editor.onSubmit = () => new Promise((resolve) => {f.submitCalls.push("one");complete=resolve;});
  await f.send("a","submit","one");
  await f.send("a","submit","one");
  assert.equal(f.submitCalls.length, 1);
  complete();
  await f.flush();
  assert.equal(f.frames.filter((frame) => frame.id === "a").length, 1);
  f.shutdown();
});
test("commands reject while running and dispatch native selectors while idle", async () => {
  const f = await fixture();
  f.handlers.get("agent_start")({},f.context);
  assert.equal((await f.send("a","command","/model")).ok, false);
  f.handlers.get("agent_settled")({},f.context);
  assert.equal((await f.send("b","command","/model")).ok, true);
  assert.deepEqual(f.submitCalls, ["/model"]);
  f.shutdown();
});
test("a pending explicit model command gates input without blocking library, status, dismiss or stop", async () => {
  const f = await fixture();
  const native = deferred();
  try {
    const nextModel = {provider:"test",id:"loaded-model",reasoning:true};
    f.editor.onSubmit = (text) => {
      assert.equal(f.frames.findLast((frame) => frame.type === "state").commandPending, true);
      f.submitCalls.push(text);
      return native.promise.then(() => { f.context.model = nextModel; });
    };
    assert.equal((await f.send("model", "command", "/model test/loaded-model")).ok, true);
    const pending = (await f.send("pending", "status")).state;
    assert.equal(pending.commandPending, true);
    assert.equal(pending.ready, false);
    assert.equal(pending.busy, false);
    assert.equal(pending.model, "test/model");
    assert.equal((await f.send("model", "command", "/model test/loaded-model")).ok, true);
    for (const [id, action, text] of [
      ["second-command", "command", "/settings"],
      ["send", "submit", "do something"],
      ["queue", "submit", "another task"],
      ["thinking", "thinking", "high"],
    ]) {
      const response = await f.send(id, action, text, id === "queue" ? "queue" : "send");
      assert.equal(response.ok, false);
      assert.match(response.error, /Pi 指令仍在执行/);
    }
    assert.deepEqual(f.submitCalls, ["/model test/loaded-model"]);
    assert.deepEqual(f.thinkingCalls, []);
    const dismissed = await f.send("dismiss", "dismiss");
    assert.equal(dismissed.ok, true);
    assert.equal(dismissed.dismissed, false);
    assert.equal((await f.send("library", "library", JSON.stringify({kind:"settings",memoryEnabled:false}))).ok, true);
    assert.equal(f.libraryRequests.at(-1)[1], "user");
    assert.equal((await f.send("stop", "stop")).ok, true);
    assert.equal(f.context.aborted, true);
    const stopped = (await f.send("after-stop", "status")).state;
    assert.equal(stopped.commandPending, true);
    assert.equal(stopped.ready, false);
    assert.equal(stopped.busy, false);
    native.resolve();
    await f.flush();
    const settled = (await f.send("settled", "status")).state;
    assert.equal(settled.commandPending, false);
    assert.equal(settled.ready, true);
    assert.equal(settled.busy, false);
    assert.equal(settled.model, "test/loaded-model");
    assert.equal((await f.send("thinking-ready", "thinking", "high")).ok, true);
    f.editor.onSubmit = async (text) => { f.submitCalls.push(text); };
    assert.equal((await f.send("send-ready", "submit", "now send")).ok, true);
    assert.equal((await f.send("command-ready", "command", "/settings")).ok, true);
  } finally { native.resolve(); f.shutdown(); }
});

test("failed native commands clear pending and publish their asynchronous error", async () => {
  const f = await fixture();
  const native = deferred();
  try {
    f.editor.onSubmit = () => native.promise;
    assert.equal((await f.send("model", "command", "/model unavailable")).ok, true);
    assert.equal((await f.send("pending", "status")).state.commandPending, true);
    native.reject(new Error("Native model load failed"));
    await f.flush();
    assert.equal(f.frames.filter((frame) => frame.type === "error").length, 1);
    assert.match(f.frames.find((frame) => frame.type === "error").message, /Native model load failed/);
    const settled = (await f.send("settled", "status")).state;
    assert.equal(settled.commandPending, false);
    assert.equal(settled.ready, true);
    assert.equal(settled.busy, false);
    f.editor.onSubmit = () => { throw new Error("Synchronous command failure"); };
    const failed = await f.send("sync", "command", "/settings");
    assert.equal(failed.ok, false);
    assert.match(failed.error, /Synchronous command failure/);
    assert.equal(f.frames.findLast((frame) => frame.type === "state").commandPending, false);
    assert.equal((await f.send("thinking", "thinking", "high")).ok, true);
  } finally { native.resolve(); f.shutdown(); }
});

test("native selectors acknowledge immediately and dismiss using focus while their promise remains pending", async () => {
  for (const command of ["/model", "/settings", "/tree"]) {
    const f = await fixture();
    const native = deferred();
    let escapes = 0;
    try {
      f.editor.onSubmit = () => {
        f.focus({handleInput(data) {
          assert.equal(data, "\x1b");
          escapes++;
          f.focus(f.editor);
        }});
        return native.promise;
      };
      assert.equal((await f.send("selector", "command", command)).ok, true);
      assert.equal((await f.send("pending", "status")).state.commandPending, true);
      assert.equal((await f.send("duplicate", "command", "/settings")).ok, false);
      assert.equal(escapes, 0);
      const dismissed = await f.send("dismiss", "dismiss");
      assert.equal(dismissed.ok, true);
      assert.equal(dismissed.dismissed, true);
      assert.equal(escapes, 1);
      const pending = (await f.send("after-dismiss", "status")).state;
      assert.equal(pending.commandPending, true);
      assert.equal(pending.ready, false);
      assert.equal((await f.send("already-dismissed", "dismiss")).dismissed, false);
      native.resolve();
      await f.flush();
      const settled = (await f.send("settled", "status")).state;
      assert.equal(settled.commandPending, false);
      assert.equal(settled.ready, true);
    } finally { native.resolve(); f.shutdown(); }
  }
});

test("a quick command replaces an existing selector using its actual Escape handler", async () => {
  const f = await fixture();
  let escapes = 0;
  f.focus({handleInput(data) {
    assert.equal(data, "\x1b");
    escapes++;
    f.focus(f.editor);
  }});
  assert.equal((await f.send("a","command","/settings")).ok, true);
  assert.equal(escapes, 1);
  assert.deepEqual(f.submitCalls, ["/settings"]);
  f.shutdown();
});
test("dismissing an already closed selector never interrupts an active task", async () => {
  const f = await fixture();
  f.handlers.get("agent_start")({},f.context);
  const response = await f.send("a","dismiss");
  assert.equal(response.ok, true);
  assert.equal(response.dismissed, false);
  assert.equal(f.context.aborted, undefined);
  f.shutdown();
});
test("pending requests settle silently after shutdown without reading the invalidated native context", async () => {
  for (const action of ["library", "dismiss", "command", "submit", "replace-selector"]) {
    for (const outcome of ["resolve", "reject"]) {
      const native = deferred();
      const f = await fixture(undefined, [], null, {libraryRun:() => native.promise});
      try {
        f.editor.onSubmit = () => native.promise;
        if (action === "dismiss" || action === "replace-selector") {
          f.focus({handleInput:() => native.promise});
        }
        const actualAction = action === "replace-selector" ? "command" : action;
        const text = action === "library" ? JSON.stringify({kind:"settings"})
          : actualAction === "command" ? "/model test/new-model" : "message";
        const ack = await f.send("pending", actualAction, text);
        assert.equal(ack?.ok, action === "command" ? true : undefined);
        if (action === "library") {
          assert.equal((await f.send("status", "status")).ok, true);
          assert.equal((await f.send("stop", "stop")).ok, true);
        }
        let staleReads = 0;
        const invalid = () => { staleReads++; throw new Error("Extension context is no longer active"); };
        for (const key of Object.keys(f.context)) {
          Object.defineProperty(f.context, key, {configurable:true,get:invalid});
        }
        f.editor.getText = invalid;
        f.editor.setText = invalid;
        f.tui.getFocusedComponent = invalid;
        f.tui.requestRender = invalid;
        const frameCount = f.frames.length;
        assert.doesNotThrow(() => f.shutdown());
        native[outcome](outcome === "reject" ? new Error("Operation settled after reload") : undefined);
        await f.flush();
        // Already queued callbacks and late old-session events must also remain inert.
        assert.doesNotThrow(() => f.intervals.forEach((callback) => callback()));
        assert.doesNotThrow(() => f.handlers.get("model_select")({}, f.context));
        assert.doesNotThrow(() => f.handlers.get("session_start")({}, f.context));
        await f.send("late", "status");
        assert.equal(staleReads, 0, `${action} ${outcome} accessed the old context`);
        assert.equal(f.frames.length, frameCount, `${action} ${outcome} published after shutdown`);
        assert.equal(f.socket.destroyed, true);
      } finally { native.resolve(); f.shutdown(); }
    }
  }
});

test("snapshot publication tolerates a native context invalidated during reload", async () => {
  const f = await fixture();
  const model = f.context.model;
  try {
    Object.defineProperty(f.context, "model", {configurable:true,get() { throw new Error("Context reloading"); }});
    const frameCount = f.frames.length;
    assert.doesNotThrow(() => f.intervals[0]());
    assert.equal(f.frames.length, frameCount);
    const failed = await f.send("during-reload", "status");
    assert.equal(failed.ok, false);
    assert.match(failed.error, /Context reloading/);
    Object.defineProperty(f.context, "model", {configurable:true,writable:true,value:model});
    assert.equal((await f.send("restored", "status")).state.ready, true);
  } finally { f.shutdown(); }
});

test("compact presentation hides only the unused native input and can restore it", async () => {
  const f = await fixture();
  assert.equal(f.editor.render(80).length, 3);
  assert.equal((await f.send("compact", "presentation", "compact")).ok, true);
  assert.equal(f.editor.render(80).length, 0);
  f.editor.setText("terminal draft");
  assert.equal(f.editor.render(80).length, 3);
  f.editor.setText(" ");
  assert.equal(f.editor.render(80).length, 3);
  f.editor.setText("");
  assert.equal((await f.send("invalid", "presentation", "unknown")).ok, false);
  assert.equal((await f.send("native", "presentation", "native")).ok, true);
  assert.equal(f.editor.render(80).length, 3);
  f.shutdown();
});
test("a disconnected bridge restores native input without changing its keyboard handlers", async () => {
  const f = await fixture();
  const submit = f.editor.onSubmit;
  await f.send("compact", "presentation", "compact");
  f.socket.destroy();
  assert.equal(f.editor.render(80).length, 3);
  assert.equal(f.editor.onSubmit, submit);
  f.shutdown();
});

test("saved notes reach the system prompt in full, stay valid JSON and never pile up as session messages", async () => {
  const long="x".repeat(400);
  const memories=Array.from({length:8},(_,i)=>({id:`id-${i}`,title:`note ${i}`,content:`${long}${i}`}));
  const f=await fixture(undefined, memories);
  const first=await f.handlers.get("before_agent_start")({systemPrompt:"BASE"},f.context);
  assert.equal(first.message,undefined);
  assert.ok(first.systemPrompt.startsWith("BASE\n\n"));
  const noteMarker="More notes can be searched with gui_memory.\n";
  const notes=JSON.parse(first.systemPrompt.slice(first.systemPrompt.indexOf(noteMarker)+noteMarker.length).split("\n\n")[0]);
  assert.equal(notes[0].content,`${long}0`);
  const big=await fixture(undefined, Array.from({length:8},(_,i)=>({id:`b-${i}`,title:"t".repeat(240),content:"y".repeat(5000)})));
  const result=await big.handlers.get("before_agent_start")({systemPrompt:""},big.context);
  const trimmed=JSON.parse(result.systemPrompt.slice(result.systemPrompt.indexOf(noteMarker)+noteMarker.length).split("\n\n")[0]);
  assert.ok(trimmed.length>=1 && trimmed.length<8);
  assert.equal(f.libraryRequests.at(-1)[0].kind,"context");
  f.shutdown();big.shutdown();
});
test("the active Agent definition becomes the turn's role with safety framing and a size cap", async () => {
  const f=await fixture(undefined, [], {id:"a1",title:"Reviewer",content:"# Reviewer\nReview diffs.",untrusted:false});
  const result=await f.handlers.get("before_agent_start")({systemPrompt:"BASE"},f.context);
  assert.ok(result.systemPrompt.startsWith("BASE\n\n"));
  const reference=JSON.parse(result.systemPrompt.split("<task-routing-reference>\n")[1].split("\n</task-routing-reference>")[0]);
  assert.equal(reference.role.title,"Reviewer");
  assert.equal(reference.role.content,"# Reviewer\nReview diffs.");
  assert.match(result.systemPrompt,/untrusted reference data/);
  const web=await fixture(undefined, [], {id:"a2",title:"Web",content:"z".repeat(60000),untrusted:true});
  const big=await web.handlers.get("before_agent_start")({systemPrompt:"BASE"},web.context);
  const largeReference=JSON.parse(big.systemPrompt.split("<task-routing-reference>\n")[1].split("\n</task-routing-reference>")[0]);
  assert.match(largeReference.role.content,/\[Definition truncated\]/);
  assert.ok(big.systemPrompt.length<50000);
  const none=await fixture();
  const noRole=await none.handlers.get("before_agent_start")({systemPrompt:"BASE"},none.context);
  assert.match(noRole.systemPrompt,/Task routing selected/);
  f.shutdown();web.shutdown();none.shutdown();
});
test("a saved Pi persona applies on the next turn and replaces or clears startup text without restart", async () => {
  const startup = "Old persona";
  const f = await fixture(undefined, [], null, { persona:startup });
  try {
    const run = (systemPrompt) => f.handlers.get("before_agent_start")({ prompt:"Help with this project", systemPrompt }, f.context);
    const first = await run(`BASE\n\n${startup}`);
    assert.equal(first.systemPrompt.split(startup).length - 1, 1);
    fs.writeFileSync(f.personaPath, "New persona");
    const updated = await run(`BASE\n\n${startup}`);
    assert.ok(updated.systemPrompt.includes("New persona"));
    assert.ok(!updated.systemPrompt.includes(startup));
    assert.equal(updated.systemPrompt.split("New persona").length - 1, 1);
    fs.rmSync(f.personaPath);
    const cleared = await run(`BASE\n\n${startup}`);
    assert.ok(!cleared.systemPrompt.includes(startup));
    assert.ok(!cleared.systemPrompt.includes("New persona"));
  } finally { await f.shutdown(); }
});
test("busy survives agent_end between follow-up turns and delivery reflects the state at submit time", async () => {
  const f=await fixture();
  f.handlers.get("agent_start")({},f.context);
  f.handlers.get("agent_end")({},f.context);
  assert.equal(f.frames.findLast((frame)=>frame.type==="state").busy,true);
  assert.equal((await f.send("c","command","/model")).ok,false);
  f.editor.onSubmit=async()=>{f.handlers.get("agent_settled")({},f.context);};
  assert.equal((await f.send("s","submit","steer this")).delivery,"steer");
  assert.equal(f.frames.findLast((frame)=>frame.type==="state").busy,false);
  f.shutdown();
});

test("missed settled event recovers from native idle, but silent runs and pending queues stay busy", async () => {
  const f = await fixture(); let idle = false, pending = false;
  try {
    f.context.isIdle = () => idle; f.context.hasPendingMessages = () => pending;
    f.handlers.get("agent_start")({}, f.context);
    for (let i = 0; i < 5; i++) f.intervals[0]();
    assert.equal((await f.send("silent-status", "status")).state.busy, true);
    assert.equal(f.context.aborted, undefined);
    idle = true; pending = true;
    for (let i = 0; i < 3; i++) f.intervals[0]();
    assert.equal((await f.send("queue-status", "status")).state.busy, true);
    pending = false; f.intervals[0]();
    assert.equal((await f.send("one-idle-observation", "status")).state.busy, true);
    f.intervals[0](); await f.flush();
    assert.equal((await f.send("idle-recovered", "status")).state.busy, false);
    assert.equal((await f.send("submit-after-interruption", "submit", "continue after interruption")).ok, true);
  } finally { await f.shutdown(); }
});

test("settled failed runs report their model error once and a native retry clears the old error", async () => {
  const f = await fixture();
  try {
    f.handlers.get("agent_start")({}, f.context);
    f.handlers.get("message_end")({ message: { role: "assistant", stopReason: "error", errorMessage: "Provider connection reset" } }, f.context);
    await f.flush();
    assert.equal(f.frames.some(frame => frame.type === "error" && /Provider connection reset/.test(frame.message)), false);
    f.handlers.get("agent_settled")({}, f.context); await f.flush();
    assert.equal(f.frames.filter(frame => frame.type === "error" && /Provider connection reset/.test(frame.message)).length, 1);
    assert.equal((await f.send("after-provider-error", "status")).state.busy, false);
    assert.equal((await f.send("retry-provider-request", "submit", "continue")).ok, true);
    f.handlers.get("agent_start")({}, f.context);
    f.handlers.get("message_end")({ message: { role: "assistant", stopReason: "error", errorMessage: "Transient failure" } }, f.context);
    await f.flush();
    f.handlers.get("agent_start")({}, f.context);
    f.handlers.get("agent_settled")({}, f.context); await f.flush();
    assert.equal(f.frames.some(frame => frame.type === "error" && /Transient failure/.test(frame.message)), false);
    f.handlers.get("session_compact_failed")({ error: "Compaction model unavailable" }, f.context);
    assert.ok(f.frames.some(frame => frame.type === "error" && /Compaction model unavailable/.test(frame.message)));
  } finally { await f.shutdown(); }
});

test("coding role augments the current model context without selecting Claude or replacing tools", async () => {
  const f=await fixture(undefined,[],CODING_AGENT);try{
    f.context.model={provider:"custom-openai",id:"qwen-tool-model"};
    const before=JSON.stringify(f.context.model);
    const result=await f.handlers.get("before_agent_start")({systemPrompt:"BASE TOOLS"},f.context);
    assert.ok(result.systemPrompt.startsWith("BASE TOOLS"));
    const reference=JSON.parse(result.systemPrompt.split("<task-routing-reference>\n")[1].split("\n</task-routing-reference>")[0]);
    assert.ok(reference.role.content.includes(CODING_AGENT.content));
    assert.equal(JSON.stringify(f.context.model),before);
    assert.equal(f.frames.some((frame)=>frame.type==="submit"),false);
  }finally{f.shutdown();}
});

test("readiness waits for discovery and loaded revision requires exact native skill provenance", async () => {
 let commands=[];
 const f=await fixture(undefined,[],null,{deferDiscovery:true,skillRevision:7,getCommands:()=>commands});
 try {
  let status=await f.send("before-discovery","status");
  assert.equal(status.state.ready,false);assert.equal(status.state.skillRevision,-1);
  const paths=await f.handlers.get("resources_discover")({reason:"startup"},f.context);
  assert.deepEqual(Array.from(paths.skillPaths),["/tmp/app-skills/example"]);
  commands=[{name:"skill:example",source:"skill",sourceInfo:{path:"/tmp/manual/example/SKILL.md"}}];
  status=await f.send("collision","status");
  assert.equal(status.state.ready,true,"a collision must leave management controls usable");
  assert.equal(status.state.skillRevision,-1);assert.match(status.state.skillError,/同名冲突/);
  commands=[{name:"skill:example",source:"skill",sourceInfo:{path:"/tmp/app-skills/example/SKILL.md"}}];
  status=await f.send("loaded","status");
  assert.equal(status.state.skillRevision,7);assert.equal(status.state.skillError,"");
 }finally{f.shutdown();}
});

test("failed or disposed discovery does not claim a loaded revision or keep the editor locked", async () => {
 const failure=await fixture(undefined,[],null,{enabledSkillPaths:async()=>{throw Error("corrupt skill registry");}});
 try{
  const state=(await failure.send("failed-discovery","status")).state;
  assert.equal(state.ready,true);assert.equal(state.skillRevision,-1);assert.match(state.skillError,/corrupt/);
 }finally{failure.shutdown();}
 const loading=deferred();
 const f=await fixture(undefined,[],null,{deferDiscovery:true,enabledSkillPaths:()=>loading.promise});
 const pending=f.handlers.get("resources_discover")({reason:"reload"},f.context);
 await f.flush();f.shutdown();const count=f.frames.length;
 loading.resolve(["/tmp/app-skills/example"]);
 const result=await pending;
 assert.deepEqual(Array.from(result.skillPaths),[]);assert.equal(f.frames.length,count);
});

test("skill discovery errors and collisions do not expose absolute user paths", async () => {
 const f=await fixture(undefined,[],null,{enabledSkillPaths:async()=>{throw Error("cannot read /Users/alice/Library/Application Support/easy_pi/SKILL.md");}});
 try {
  const state=(await f.send("private-path","status")).state;
  assert.doesNotMatch(state.skillError,/\/Users\/alice/);
  assert.match(state.skillError,/Skill 库无法加载/);
 } finally { f.shutdown(); }
});

test("Skill discovery uses only enabled app paths and model tool cannot install or enable", async () => {
 const f=await fixture();try{
  const result=await f.handlers.get("resources_discover")({cwd:"/tmp",reason:"reload"},f.context);
  assert.deepEqual(Array.from(result.skillPaths),["/tmp/app-skills/example"]);
  const tool=f.tools.get("gui_skills");assert.ok(tool);
  for(const action of ["install","preview","enable","remove","search","update"]) await assert.rejects(tool.execute("call",{action,id:"x"}),/用户/);
  await tool.execute("read",{action:"read",id:"x"});
  assert.equal(f.libraryRequests.at(-1)[0].kind,"skills");assert.equal(f.libraryRequests.at(-1)[1],"model");
 }finally{f.shutdown();}
});
