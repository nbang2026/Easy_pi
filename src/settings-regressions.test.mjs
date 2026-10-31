import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, realpath, readdir, writeFile, utimes } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { setupHarnessSettings } from "./harness-settings.ts";
import { setupLibrarySettings } from "./library-settings.ts";
import { setupSystemSettings } from "./system-settings.ts";
import { setupSettingsNavigation } from "./settings-navigation.ts";
import { createHarness, HARNESS_DEFAULTS, harnessToolAllowed } from "../src-tauri/src/gui-harness.mjs";
import { createAgentLibrary } from "../src-tauri/src/gui-library.mjs";

const until = async predicate => {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("Timed out waiting for UI operation");
};
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  window.document.write(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const old = { document: globalThis.document, window: globalThis.window, Element: globalThis.Element };
  Object.assign(globalThis, { document: window.document, window, Element: window.Element });
  window.confirm = () => true;
  return { window, el: id => window.document.getElementById(id),
    close() { window.happyDOM.abort(); Object.assign(globalThis, old); } };
}
async function configure(harness, changes) {
  const status = await harness.run({ action: "status" });
  return harness.run({ action: "configure", settings: { ...status.settings, ...changes },
    expectedWorkspace: status.workspace, expectedRevision: status.revision });
}

test("permission drafts stay with their project and backend rejects stale or misdirected saves", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-settings-regression-"))), f = fixture();
  await mkdir(join(root, "A")); await mkdir(join(root, "B"));
  const a = createHarness({ directory: join(root, "records") }), b = createHarness({ directory: join(root, "records") });
  await a.attach(join(root, "A"), "A"); await b.attach(join(root, "B"), "B");
  await configure(b, { mode: "readonly" });
  let active = a;
  const ui = setupHarnessSettings({ language: () => "zh", invoke: async (_cmd, args) => ({ data: await active.run(JSON.parse(args.text)) }) });
  try {
    await ui.refresh();
    const statusA = await a.run({ action: "status" });
    f.el("harness-mode").value = "autonomous";
    f.el("harness-mode").dispatchEvent(new f.window.Event("input", { bubbles: true }));
    active = b; ui.observe(null, join(root, "B")); await ui.refresh();
    assert.equal(f.el("harness-mode").value, "readonly");
    assert.equal((await b.run({ action: "status" })).settings.mode, "readonly");
    await assert.rejects(b.run({ action: "configure", settings: { ...HARNESS_DEFAULTS, mode: "autonomous" },
      expectedWorkspace: statusA.workspace, expectedRevision: statusA.revision }), /项目/);
    active = a; ui.observe(null, join(root, "A")); await ui.refresh();
    assert.equal(f.el("harness-mode").value, "autonomous", "A's draft is restored only in A");
    await configure(a, { maxTurns: 3 });
    await assert.rejects(a.run({ action: "configure", settings: HARNESS_DEFAULTS,
      expectedWorkspace: statusA.workspace, expectedRevision: statusA.revision }), /其他窗口/);
    assert.equal((await a.run({ action: "status" })).settings.maxTurns, 3);
  } finally { ui.dispose(); await a.dispose(); await b.dispose(); f.close(); await rm(root, { recursive: true, force: true }); }
});

test("late permission responses cannot restore a previous project's controls", async () => {
  const f = fixture(), pending = [];
  const ui = setupHarnessSettings({ language: () => "zh", invoke: (_cmd, args) => {
    if (JSON.parse(args.text).action === "history") return Promise.resolve({ data: [] });
    return new Promise(resolve => pending.push(resolve));
  } });
  try {
    const first = ui.refresh();
    ui.observe(null, "/B");
    const second = ui.refresh();
    pending[1]({ data: { settings: { ...HARNESS_DEFAULTS, mode: "readonly" }, workspace: "/B", revision: "B", current: null } }); await second;
    pending[0]({ data: { settings: { ...HARNESS_DEFAULTS, mode: "autonomous" }, workspace: "/A", revision: "A", current: null } }); await first;
    assert.equal(f.el("harness-mode").value, "readonly");
    assert.equal(f.el("harness-workspace").textContent, "/B");
  } finally { ui.dispose(); f.close(); }
});

test("configuration locks recover after process exit and competing saves cannot overwrite a revision", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-config-lock-")));
  const directory = join(root, "records");
  const a = createHarness({ directory }), b = createHarness({ directory });
  try {
    await a.attach(root, "A"); await b.attach(root, "B");
    await configure(a, { maxTurns: 4 });
    const file = (await readdir(join(directory, "settings"))).find(name => name.endsWith(".json"));
    const lock = join(directory, "settings", `${file}.lock`);
    const deadPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
    await writeFile(lock, JSON.stringify({ pid: deadPid }));
    await configure(a, { maxTurns: 5 });
    await writeFile(lock, "");
    await utimes(lock, new Date(0), new Date(0));
    await configure(a, { maxTurns: 6 });
    await writeFile(lock, JSON.stringify({ pid: process.pid }));
    await assert.rejects(configure(a, { maxTurns: 7 }), /其他窗口/);
    await rm(lock);
    const status = await a.run({ action: "status" });
    const save = (controller, maxTurns) => controller.run({ action: "configure", expectedWorkspace: status.workspace,
      expectedRevision: status.revision, settings: { ...status.settings, maxTurns } });
    const results = await Promise.allSettled([save(a, 8), save(b, 9)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.ok([8, 9].includes((await a.run({ action: "status" })).settings.maxTurns));
    assert.equal((await readdir(join(directory, "settings"))).some(name => name.endsWith(".lock")), false);
  } finally { await a.dispose(); await b.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("memory lists isolate projects and ordinary edits preserve owner and scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-regression-"));
  const library = createAgentLibrary({ directory: root });
  try {
    const memory = await library.run({ kind: "memory", action: "save", title: "A note", content: "private A", scope: "project", workspace: "/A" });
    assert.equal((await library.run({ kind: "list", workspace: "/B" })).memories.length, 0);
    assert.equal((await library.run({ kind: "memory", action: "list", workspace: "/B" })).length, 0);
    await assert.rejects(library.run({ kind: "memory", action: "save", id: memory.id, title: "x", content: "y", scope: "project", workspace: "/B" }), /其他项目/);
    await assert.rejects(library.run({ kind: "memory", action: "save", id: memory.id, title: "x", content: "y", scope: "global", workspace: "/A" }), /普通保存/);
    const item = await library.run({ kind: "memory", action: "save", id: memory.id, title: "A edited", content: "still A", workspace: "/A" });
    assert.equal(item.workspace, "/A"); assert.equal(item.scope, "project");
    await assert.rejects(library.run({ kind: "memory", action: "move", id: item.id, workspace: "/A", targetScope: "global", expectedUpdatedAt: item.updatedAt }), /明确确认/);
    const shared = await library.run({ kind: "memory", action: "move", id: item.id, workspace: "/A", targetScope: "global", expectedUpdatedAt: item.updatedAt, confirmed: true });
    assert.equal(shared.scope, "global"); assert.equal(shared.workspace, undefined);
    assert.equal((await library.run({ kind: "list", workspace: "/B" })).memories.length, 1);
    await assert.rejects(library.run({ kind: "memory", action: "move", id: item.id, workspace: "/A", targetScope: "project", expectedUpdatedAt: shared.updatedAt, confirmed: true }, "model"), /明确确认/);
  } finally { library.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("library drafts and mutation context are isolated, and effective permissions stay explicit", async () => {
  const f = fixture(), calls = [];
  let mode = "project", currentWorkspace = "/A";
  const ui = setupLibrarySettings({ translate: key => key, invoke: async (_cmd, args) => {
    const value = JSON.parse(args.text); calls.push(value);
    if (value.kind === "list") return { data: { workspace: currentWorkspace, executionMode: mode,
      settings: { memoryEnabled: true, autonomousDownloads: true }, memories: [], agents: [] } };
    throw Error("write rejected");
  } });
  try {
    ui.setWorkspace("/A"); ui.refresh(); await until(() => calls.length && !f.el("library-save").disabled);
    assert.equal(f.el("memory-effective").textContent, "library.memoryReadOnly");
    assert.equal(f.el("download-effective").textContent, "library.downloadRestricted");
    f.el("library-title").value = "A draft"; f.el("library-content").value = "A only";
    currentWorkspace = "/B"; ui.setWorkspace("/B");
    assert.equal(f.el("library-content").value, "");
    f.el("library-title").value = "B draft"; f.el("library-content").value = "B only";
    f.el("library-save").click(); await until(() => calls.some(call => call.action === "save"));
    assert.equal(calls.find(call => call.action === "save").expectedWorkspace, "/B");
    await until(() => !f.el("library-save").disabled);
    currentWorkspace = "/A"; ui.setWorkspace("/A");
    assert.equal(f.el("library-content").value, "A only");
    mode = "autonomous"; ui.refresh(); await until(() => f.el("download-effective").textContent === "library.downloadEffective");
    assert.equal(f.el("memory-effective").textContent, "library.memoryWritable");
    assert.equal(await harnessToolAllowed("project", { toolName: "gui_memory", input: { action: "save" } }, "/A"), false);
    assert.equal(await harnessToolAllowed("project", { toolName: "bash", input: {} }, "/A"), false);
  } finally { ui.dispose(); f.close(); }
});

test("a file chosen while diagnostics are pending is queued and controls reflect the busy state", async () => {
  const f = fixture(); let resolve, reads = 0, language = "zh";
  const ui = setupSystemSettings({ language: () => language, invoke: () => new Promise(done => { resolve = done; }) });
  try {
    const pending = ui.refresh(); await flush();
    assert.equal(f.el("system-manifest").disabled, true);
    assert.equal(f.el("system-export").disabled, true);
    const manifest = { schema: 1, product: "easy_pi", version: "1.0.11", publishedAt: "2026-10-17",
      artifacts: [{ name: "app.zip", platform: "macOS", arch: "arm64", bytes: 1, sha256: "a".repeat(64) }] };
    Object.defineProperty(f.el("system-manifest"), "files", { configurable: true, value: [{
      size: 1024, text: async () => { reads++; return JSON.stringify(manifest); },
    }] });
    f.el("system-manifest").dispatchEvent(new f.window.Event("change"));
    language = "en"; ui.refreshLanguage();
    assert.equal(reads, 0);
    resolve({ version: "1.0.10-fix.1", checkedAt: 1, checks: [] }); await pending;
    await until(() => f.el("system-manifest").disabled === false);
    assert.equal(reads, 1); assert.ok(f.el("system-release").textContent.includes("1.0.11"));
    assert.ok(f.el("system-export").textContent.includes("Export"));
  } finally { ui.dispose(); f.close(); }
});

test("reselecting a category preserves scroll and history evidence survives actual refreshes", async () => {
  const f = fixture();
  const run = { id: "00000000-0000-4000-a000-000000000001", state: "awaiting_verification", startedAt: 1, updatedAt: 1,
    usage: { turns: 1, toolCalls: 1, tokens: 1, cost: 0, costKnown: true }, pending: [], events: [] };
  let loads = 0;
  const ui = setupHarnessSettings({ language: () => "zh", invoke: async (_cmd, args) => {
    const value = JSON.parse(args.text); if (value.action === "status") loads++;
    return { data: value.action === "history" ? { runs: [run], warnings: [] } :
      { workspace: "/A", revision: "A", settings: HARNESS_DEFAULTS, current: run } };
  } });
  const nav = setupSettingsNavigation(f.el("settings-panel"), tab => { if (tab === "harness") void ui.refresh(); });
  try {
    nav.select("harness"); await until(() => f.el("harness-history").querySelector("textarea"));
    const note = f.el("harness-history").querySelector("textarea");
    note.value = "Evidence draft"; note.dispatchEvent(new f.window.Event("input"));
    f.el("settings-panel").querySelector(".settings-content").scrollTop = 200;
    f.el("settings-panel").querySelector('[data-settings-group="execution"]').click();
    assert.equal(loads, 1); assert.equal(note.isConnected, true);
    assert.equal(f.el("settings-panel").querySelector(".settings-content").scrollTop, 200);
    await ui.refresh();
    assert.equal(f.el("harness-history").querySelector("textarea").value, "Evidence draft");
    f.el("harness-evidence").value = "Current evidence";
    f.el("harness-evidence").dispatchEvent(new f.window.Event("input"));
    ui.observe({ ...run, id: "other" });
    assert.equal(f.el("harness-evidence").value, "");
    ui.observe(run); assert.equal(f.el("harness-evidence").value, "Current evidence");
    nav.select("appearance"); nav.select("harness");
    assert.equal(f.el("settings-panel").querySelector(".settings-content").scrollTop, 200);
  } finally { nav.dispose(); ui.dispose(); f.close(); }
});
