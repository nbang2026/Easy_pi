import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { setupSystemSettings, normalizePiCoreUpdate } from "./system-settings.ts";
import { confirmSessionResume } from "./model-dialog.ts";
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
  window.document.write(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const old = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, { document: window.document, window });
  return { window, el: id => window.document.getElementById(id),
    close() { window.happyDOM.abort(); Object.assign(globalThis, old); } };
}
test("environment checks use text rendering and exported reports omit private details", async () => {
  const f = fixture(), calls = [];
  const ui = setupSystemSettings({ language: () => "zh", invoke: async (command, args) => {
    calls.push([command, args]);
    return command === "run_diagnostics" ? { version: "1.0.10-fix.1", checkedAt: 100, checks: [
      { name: "<img src=x>", ok: false, detail: "/private/user/path secret-value" },
    ] } : "/Downloads/health.json";
  } });
  try {
    await ui.refresh();
    assert.ok(f.el("system-checks").textContent.includes("<img src=x>"));
    assert.equal(f.el("system-checks").querySelector("img"), null);
    f.el("system-export").click(); await flush();
    const exported = calls.find(([command]) => command === "export_usage_log")[1].text;
    assert.ok(!exported.includes("secret-value")); assert.ok(!exported.includes("/private/user/path"));
    assert.equal(JSON.parse(exported).checks[0].ok, false);
  } finally { ui.dispose(); f.close(); }
});

test("native diagnostics use privacy-safe status text instead of local paths", () => {
  const source = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(source, /"正在运行的应用",\s*"ok":true,\s*"detail":"easy_pi"/);
  assert.doesNotMatch(source, /"正在运行的应用"[^\\n]*current_exe\(\)/);
  assert.match(source, /let pi_detail = match &pi/);
  assert.match(source, /let node_detail = match &node/);
  assert.match(source, /let config_detail = if config\.is_ok\(\)/);
});

const piUpdate = (extra = {}) => ({ status: "available", currentVersion: "1.3.0", latestVersion: "1.4.0", checkedAt: 1000, runtimeKind: "external", ...extra });
test("Pi update notices keep app/core versions separate, notify once, and open settings without changing the view", async () => {
  const f = fixture(), notices = []; let opened = 0;
  const ui = setupSystemSettings({ language: () => "zh", invoke: async () => ({ version: "1.1.0", checkedAt: 1, checks: [] }),
    notice: message => notices.push(message), openPiUpdates: () => { opened++; } });
  try {
    await ui.refresh();
    ui.observePiUpdate(piUpdate()); ui.observePiUpdate(piUpdate());
    assert.match(f.el("system-version").textContent, /1\.1\.0/);
    assert.match(f.el("pi-core-version").textContent, /1\.3\.0.*1\.4\.0/);
    assert.equal(notices.length, 1);
    assert.equal(f.el("pi-update-notice").hidden, false);
    f.el("pi-update-notice").click(); assert.equal(opened, 1);
    assert.equal(f.window.document.body.classList.contains("terminal-view"), false);
    assert.equal(f.el("pi-update-copy").hidden, false);
  } finally { ui.dispose(); f.close(); }
});

test("Pi checks are manual single-flight and never submit or execute an update command", async () => {
  const f = fixture(), calls = []; let complete;
  const ui = setupSystemSettings({ language: () => "zh", invoke: async (...args) => calls.push(args),
    checkPiUpdate: () => { calls.push(["checkPiUpdate"]); return new Promise(resolve => { complete = resolve; }); } });
  try {
    f.el("pi-update-check").click(); f.el("pi-update-check").click(); await flush();
    assert.equal(calls.length, 1); assert.equal(f.el("pi-update-check").disabled, true);
    complete(piUpdate()); await flush();
    assert.match(f.el("pi-update-status").textContent, /新.*版本/);
    assert.equal(f.el("pi-update-check").disabled, false);
    assert.deepEqual(calls, [["checkPiUpdate"]]);
  } finally { ui.dispose(); f.close(); }
});

test("bundled Pi directs users to app updates rather than modifying its embedded runtime", () => {
  const f = fixture();
  const ui = setupSystemSettings({ language: () => "zh", invoke: async () => {} });
  try {
    ui.observePiUpdate(piUpdate({ runtimeKind: "bundled" }));
    assert.equal(f.el("pi-update-copy").hidden, true);
    assert.match(f.el("pi-update-instructions").textContent, /内置.*easy_pi/);
    assert.doesNotMatch(f.el("pi-update-instructions").textContent, /pi update/);
  } finally { ui.dispose(); f.close(); }
});

test("invalid remote metadata cannot create markup, show a notice, or suggest a downgrade", () => {
  const f = fixture(), notices = [];
  const ui = setupSystemSettings({ language: () => "zh", invoke: async () => {}, notice: message => notices.push(message) });
  try {
    for (const value of [piUpdate({ latestVersion: "<img src=x>" }), piUpdate({ latestVersion: "1.2.0" }),
      piUpdate({ latestVersion: "1.3.0" }), piUpdate({ currentVersion: "1.3.0\n" }),
      piUpdate({ latestVersion: "1.4.0-01" }), piUpdate({ currentVersion: "1.3.0-01" })]) {
      assert.equal(normalizePiCoreUpdate(value), undefined); ui.observePiUpdate(value);
    }
    assert.equal(f.el("pi-update-notice").hidden, true);
    assert.equal(notices.length, 0); assert.equal(f.el("system-settings-content").querySelector("img"), null);
  } finally { ui.dispose(); f.close(); }
});

test("Pi update errors and offline states are non-disruptive and language changes preserve version data", () => {
  const f = fixture(); let language = "zh";
  const ui = setupSystemSettings({ language: () => language, invoke: async () => {} });
  try {
    ui.observePiUpdate(piUpdate({ status: "error", latestVersion: "", error: "timeout" }));
    assert.match(f.el("pi-update-status").textContent, /超时/);
    assert.equal(f.el("pi-update-notice").hidden, true);
    ui.observePiUpdate(piUpdate({ status: "disabled", latestVersion: "" }));
    assert.match(f.el("pi-update-status").textContent, /离线/);
    language = "en"; ui.refreshLanguage();
    assert.match(f.el("pi-core-version").textContent, /Installed Pi: 1\.3\.0/);
    assert.match(f.el("pi-update-status").textContent, /disabled/);
  } finally { ui.dispose(); f.close(); }
});

test("disposed settings ignore update responses and remove the notice button handler", async () => {
  const f = fixture(); let complete, opened = 0;
  const ui = setupSystemSettings({ language: () => "zh", invoke: async () => {},
    checkPiUpdate: () => new Promise(resolve => { complete = resolve; }), openPiUpdates: () => { opened++; } });
  try {
    f.el("pi-update-check").click(); await flush(); ui.dispose();
    complete(piUpdate()); await flush(); ui.observePiUpdate(piUpdate());
    assert.equal(f.el("pi-update-notice").hidden, true);
    f.el("pi-update-notice").click(); assert.equal(opened, 0);
  } finally { f.close(); }
});
test("late diagnostic responses cannot replace a disposed settings pane", async () => {
  const f = fixture(); let resolve;
  const ui = setupSystemSettings({ language: () => "zh", invoke: () => new Promise(done => { resolve = done; }) });
  try {
    const pending = ui.refresh(); await flush(); ui.dispose();
    resolve({ version: "1.0.11", checkedAt: 1, checks: [] }); await pending;
    assert.ok(!f.el("system-version").textContent.includes("1.0.11"));
  } finally { f.close(); }
});
test("session resume dialog requires a deliberate choice and treats project names as text", async () => {
  const f = fixture();
  try {
    const pending = confirmSessionResume(key => key, false, "/project/<img src=x>", 1000);
    const dialog = f.window.document.querySelector(".model-dialog");
    assert.equal(dialog.querySelector("img"), null);
    dialog.querySelector(".primary-button").click(); assert.equal(await pending, true);
    const fresh = confirmSessionResume(key => key, false, "/project", 1000);
    f.window.document.querySelector(".model-dialog-cancel").click(); assert.equal(await fresh, false);
  } finally { f.close(); }
});
