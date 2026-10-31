import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { isPermissionError, setupPermissionDialog } from "./permission-dialog.ts";

test("project trust explains executable resources and never offers blanket tool permission", async () => {
  const window = new Window(), old = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, { document: window.document, window });
  let blanketCalls = 0;
  const dialog = setupPermissionDialog({ language: () => "zh", allowAll: async () => { blanketCalls++; } });
  try {
    const result = dialog.request({ projectTrust: true, toolApproval: true });
    const panel = window.document.querySelector('[role="dialog"]');
    assert.match(panel.textContent, /执行项目扩展/);
    assert.doesNotMatch(panel.textContent, /一键放行/);
    panel.querySelector(".primary-button").click();
    assert.equal(await result, true);
    assert.equal(blanketCalls, 0);
  } finally { dialog.dispose(); await window.happyDOM.abort(); Object.assign(globalThis, old); }
});

test("allow-all button relies on backend resolution rather than submitting a duplicate approval", async () => {
  const window = new Window(), old = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, { document: window.document, window });
  const controller = new AbortController(); let calls = 0;
  const dialog = setupPermissionDialog({ language: () => "zh", allowAll: async () => { calls++; controller.abort(); } });
  try {
    const result = dialog.request({ toolApproval: true, signal: controller.signal });
    const panel = window.document.querySelector('[role="dialog"]');
    panel.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    assert.equal(window.document.activeElement.textContent, "一键放行所有权限");
    window.document.activeElement.click();
    assert.equal(await result, false);
    assert.equal(calls, 1);
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    const os = dialog.request({});
    assert.doesNotMatch(window.document.querySelector('[role="dialog"]').textContent, /一键放行/);
    dialog.dispose(); await os;
  } finally { dialog.dispose(); await window.happyDOM.abort(); Object.assign(globalThis, old); }
});

test("permission errors are recognized without treating ordinary failures as permission prompts", () => {
  assert.equal(isPermissionError(new Error("EACCES: permission denied")), true);
  assert.equal(isPermissionError("Operation not permitted"), true);
  for (const message of ["需要权限", "权限不足，无法执行", "拒绝访问", "操作未授权"])
    assert.equal(isPermissionError(message), true);
  assert.equal(isPermissionError("Pi 尚未连接。"), false);
});

test("aborting active and queued dialogs denies requests, restores focus and keeps safe keyboard defaults", async () => {
  const window = new Window();
  const old = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, { document: window.document, window });
  const dialog = setupPermissionDialog({ language: () => "zh" });
  try {
    const origin = window.document.createElement("button"); window.document.body.append(origin); origin.focus();
    const first = new AbortController(), second = new AbortController();
    const a = dialog.request({ signal: first.signal, operation: "bash: printf test", toolApproval: true });
    const b = dialog.request({ signal: second.signal });
    let panel = window.document.querySelector('[role="dialog"]');
    assert.match(panel.textContent, /工具尚未执行/);
    assert.equal(window.document.activeElement.textContent, "拒绝");
    panel.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    assert.equal(window.document.activeElement.textContent, "仅允许本次");
    second.abort(); assert.equal(await b, false);
    first.abort(); assert.equal(await a, false);
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    assert.equal(window.document.activeElement, origin);
    const c = dialog.request({}); dialog.dispose(); assert.equal(await c, false);
  } finally { dialog.dispose(); await window.happyDOM.abort(); Object.assign(globalThis, old); }
});

test("permission dialog resolves a one-time approval and redacts sensitive details", () => {
  const window = new Window();
  const old = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, { document: window.document, window });
  try {
    const dialog = setupPermissionDialog({ language: () => "zh" });
    const result = dialog.request({
      operation: "write_file",
      detail: "api_key=sk-secret-value",
      risk: "high",
    });
    const panel = window.document.querySelector('[role="dialog"]');
    assert.ok(panel);
    assert.match(panel.textContent, /需要权限确认|需要额外权限/);
    assert.doesNotMatch(panel.textContent, /sk-secret-value/);
    panel.querySelector(".primary-button").click();
    return result.then(value => assert.equal(value, true)).finally(() => {
      dialog.dispose();
      window.happyDOM.abort();
      Object.assign(globalThis, old);
    });
  } catch (error) {
    window.happyDOM.abort();
    Object.assign(globalThis, old);
    throw error;
  }
});
