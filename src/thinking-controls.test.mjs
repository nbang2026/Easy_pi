import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";
import { setupThinkingControls } from "./thinking-controls.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
const ready = (changes = {}) => ({ connected: true, ready: true, busy: false, model: "test/reasoner",
  thinking: "off", thinkingSupported: true, thinkingLevels: ["off", "low", "medium", "high"], ...changes });
function fixture(t) {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  window.document.write(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const previous = globalThis.document;
  globalThis.document = window.document;
  const calls = [], errors = [];
  let language = "en";
  const ui = setupThinkingControls({ language: () => language, error: error => errors.push(error),
    invoke(command, args) {
      assert.equal(command, "gui_action");
      return new Promise((resolve, reject) => calls.push({ args, resolve, reject }));
    } });
  const select = window.document.getElementById("thinking-select");
  t.after(async () => { ui.dispose(); calls.forEach(call => call.resolve({ data: {} })); await tick(); globalThis.document = previous; await window.happyDOM.abort(); });
  return { ui, select, calls, errors, window,
    choose(level) { select.value = level; select.dispatchEvent(new window.Event("change")); },
    language(value) { language = value; ui.refreshLanguage(); } };
}

test("the input toolbar has one thinking control and a separate work-mode picker", t => {
  const f = fixture(t), document = f.window.document;
  assert.equal(document.querySelectorAll("#thinking-select").length, 1);
  assert.equal(document.querySelectorAll("#deep-thinking").length, 0);
  assert.equal(document.querySelectorAll("#role-select").length, 1);
  assert.equal(document.querySelectorAll("#agent-select").length, 1);
  assert.equal(document.querySelectorAll(".claude-view-modal").length, 0);
  const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  assert.match(main, /thinkingControls\?\.update\(state\)/);
  assert.match(main, /import .*agent-runtime/);
});

test("one selector enables, adjusts and disables thinking after acknowledgements", async t => {
  const f = fixture(t); f.ui.update(ready());
  for (const level of ["high", "medium", "off"]) {
    const old = f.select.value;
    f.choose(level);
    assert.deepEqual(f.calls.at(-1).args, { action: "thinking", text: level });
    assert.equal(f.select.disabled, true);
    assert.equal(f.select.value, old);
    f.calls.at(-1).resolve({ data: { thinking: level } }); await tick();
    assert.equal(f.select.value, level);
    assert.equal(f.select.disabled, false);
  }
  assert.deepEqual(f.errors, []);
});

test("failed changes restore the confirmed level and surface errors", async t => {
  const f = fixture(t); f.ui.update(ready({ thinking: "low" }));
  f.choose("high"); f.calls[0].reject(Error("fixture rejected")); await tick();
  assert.equal(f.select.value, "low"); assert.equal(f.select.disabled, false);
  assert.match(String(f.errors[0]), /fixture rejected/);
});

test("unsupported, busy and disconnected states cannot send synthetic actions", t => {
  const f = fixture(t);
  for (const change of [{ connected: false }, { ready: false }, { busy: true },
    { thinkingSupported: false }, { thinkingLevels: [] }, { thinkingLevels: ["off"] }]) {
    f.ui.update(ready(change)); assert.equal(f.select.disabled, true); f.choose("off");
  }
  assert.equal(f.calls.length, 0);
});

test("rapid selections cannot duplicate a pending request", async t => {
  const f = fixture(t); f.ui.update(ready());
  f.choose("high"); f.choose("low"); f.ui.update(ready()); f.choose("medium");
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve({ data: { thinking: "high" } }); await tick();
  assert.equal(f.select.value, "high");
});

test("old-model and disconnected acknowledgements cannot overwrite replacement state", async t => {
  const f = fixture(t); f.ui.update(ready()); f.choose("high");
  f.ui.update(ready({ model: "new", thinking: "low", thinkingLevels: ["off", "low"] }));
  f.calls[0].resolve({ data: { thinking: "high", thinkingLevels: ["off", "high"] } }); await tick();
  assert.equal(f.select.value, "low"); assert.deepEqual([...f.select.options].map(option => option.value), ["off", "low"]);
  f.choose("off"); f.ui.update(ready({ connected: false })); f.ui.update(ready({ thinking: "medium" }));
  f.calls[1].reject(Error("old connection")); await tick();
  assert.equal(f.select.value, "medium"); assert.deepEqual(f.errors, []);
});

test("always-thinking models retain supported levels without inventing an off option", async t => {
  const f = fixture(t); f.ui.update(ready({ thinking: "low", thinkingLevels: ["low", "high", "xhigh", "max"] }));
  assert.deepEqual([...f.select.options].map(option => option.value), ["low", "high", "xhigh", "max"]);
  assert.equal(f.select.disabled, false); f.choose("max");
  f.calls[0].resolve({ data: { thinking: "xhigh" } }); await tick();
  assert.equal(f.select.value, "xhigh");
});

test("language refresh updates accessible names and options without actions", t => {
  const f = fixture(t); f.ui.update(ready({ thinking: "medium" }));
  assert.equal(f.select.selectedOptions[0].textContent, "Medium");
  f.language("zh");
  assert.equal(f.select.getAttribute("aria-label"), "思考强度");
  assert.equal(f.select.selectedOptions[0].textContent, "中");
  assert.equal(f.calls.length, 0);
});

test("disposed thinking controls ignore pending success, errors and later input", async t => {
  const f = fixture(t); f.ui.update(ready()); f.choose("high"); f.ui.dispose();
  const before = f.select.outerHTML;
  f.calls[0].resolve({ data: { thinking: "high" } }); await tick();
  f.ui.update(ready({ thinking: "low" })); f.language("zh");
  assert.equal(f.select.outerHTML, before);
  f.choose("low"); assert.equal(f.calls.length, 1); assert.deepEqual(f.errors, []);
});
