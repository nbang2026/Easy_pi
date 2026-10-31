import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { MAX_PERSONA_BYTES, setupPersonaSettings, validatePersona } from "./persona-settings.ts";

const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function fixture(invoke) {
  const window = new Window({ settings:{ disableJavaScriptEvaluation:true, disableCSSFileLoading:true } });
  window.document.write(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const previous = { document:globalThis.document, window:globalThis.window };
  Object.assign(globalThis, { document:window.document, window });
  const ui = setupPersonaSettings({ invoke, translate:key => ({
    "persona.loading":"loading", "persona.importing":"importing", "persona.saving":"applying",
    "persona.pending":"pending auto-apply", "persona.unsaved":"unsaved", "persona.saved":"applied for next turn", "persona.cleared":"cleared for next turn",
    "persona.loaded":"imported and applied for next turn", "persona.tooLarge":"too large",
    "persona.invalid":"invalid", "persona.failed":"failed",
  })[key] || key, formatError:error => error instanceof Error ? error.message : "failed" });
  const el = id => window.document.getElementById(id);
  return { window, ui, el, close() { ui.dispose(); window.happyDOM.abort(); Object.assign(globalThis, previous); } };
}

test("persona content is bounded by UTF-8 bytes and rejects null characters", () => {
  assert.equal(validatePersona("人设"), "人设");
  assert.throws(() => validatePersona("x".repeat(MAX_PERSONA_BYTES + 1)), /persona\.tooLarge/);
  assert.throws(() => validatePersona("x\0y"), /persona\.invalid/);
});

test("persona edits auto-apply and flush before the next Pi turn without a reload", async () => {
  let stored = "old";
  const calls = [];
  const f = fixture(async (command, args) => {
    calls.push([command, args]);
    if (command === "read_persona") return stored;
    if (command === "save_persona") { stored = args.text; return; }
  });
  try {
    await flush();
    assert.equal(f.el("persona-text").value, "old");
    f.el("persona-text").value = "new role";
    f.el("persona-text").dispatchEvent(new f.window.Event("input"));
    assert.equal(f.el("persona-save-btn").disabled, false);
    await delay(400);
    assert.equal(stored, "new role");
    assert.equal(f.el("persona-status").textContent, "applied for next turn");
    assert.equal(calls.some(([command]) => command === "gui_action"), false);
    assert.equal(f.el("persona-save-btn").disabled, true);

    f.el("persona-text").value = "latest role";
    f.el("persona-text").dispatchEvent(new f.window.Event("input"));
    await f.ui.flush();
    assert.equal(stored, "latest role");
  } finally { f.close(); }
});

test("persona import is size-checked, editable, and applied immediately", async () => {
  let stored = "";
  const f = fixture(async (command, args) => {
    if (command === "read_persona") return stored;
    if (command === "save_persona") { stored = args.text; return; }
  });
  try {
    await flush();
    const fileInput = f.el("persona-file");
    Object.defineProperty(fileInput, "files", { configurable:true, value:[{ size:8, text:async() => "imported" }] });
    fileInput.dispatchEvent(new f.window.Event("change"));
    await flush();
    assert.equal(f.el("persona-text").value, "imported");
    assert.equal(f.el("persona-status").textContent, "imported and applied for next turn");
    assert.equal(stored, "imported");

    Object.defineProperty(fileInput, "files", { configurable:true, value:[{ size:MAX_PERSONA_BYTES + 1, text:async() => "not read" }] });
    fileInput.dispatchEvent(new f.window.Event("change"));
    assert.equal(f.el("persona-status").textContent, "too large");
    assert.equal(stored, "imported");
  } finally { f.close(); }
});

test("clearing a persona persists immediately and a failed save preserves the draft", async () => {
  let stored = "configured persona";
  let rejectSave = false;
  const f = fixture(async (command, args) => {
    if (command === "read_persona") return stored;
    if (command === "save_persona") {
      if (rejectSave) throw new Error("write failed");
      stored = args.text;
    }
  });
  try {
    await flush();
    rejectSave = true;
    f.el("persona-text").value = "draft to keep";
    f.el("persona-text").dispatchEvent(new f.window.Event("input"));
    await assert.rejects(f.ui.flush(), /write failed/);
    assert.equal(f.el("persona-text").value, "draft to keep");
    assert.equal(f.el("persona-status").textContent, "write failed");
    rejectSave = false;
    f.el("persona-clear-btn").click();
    await f.ui.flush();
    assert.equal(stored, "");
    assert.equal(f.el("persona-text").value, "");
    assert.equal(f.el("persona-status").textContent, "cleared for next turn");
  } finally { f.close(); }
});
