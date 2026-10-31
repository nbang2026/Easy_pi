import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { setupSettingsNavigation } from "./settings-navigation.ts";
import { setupSystemSettings } from "./system-settings.ts";

function fixture() {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  window.document.write(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const previous = { document: globalThis.document, Element: globalThis.Element };
  Object.assign(globalThis, { document: window.document, Element: window.Element });
  const panel = window.document.getElementById("settings-panel");
  panel.hidden = false;
  const selected = [], nav = setupSettingsNavigation(panel, tab => selected.push(tab));
  const el = id => window.document.getElementById(id);
  const category = group => panel.querySelector(`[data-settings-group="${group}"]`);
  const visible = () => [...panel.querySelectorAll("[data-tab]")].filter(button => !button.hidden).map(button => button.dataset.tab);
  return { window, panel, selected, nav, el, category, visible,
    close() { nav.dispose(); window.happyDOM.abort(); Object.assign(globalThis, previous); } };
}

test("five categories expose only related pages and preserve the last page in each category", () => {
  const f = fixture();
  try {
    assert.equal(f.panel.querySelectorAll("[data-settings-group]").length, 5);
    f.nav.select("models"); assert.deepEqual(f.visible(), ["models"]);
    f.category("personal").click();
    assert.deepEqual(f.visible(), ["appearance", "sounds", "shortcuts"]);
    f.el("tab-sounds").click(); assert.equal(f.el("pane-sounds").hidden, false);
    assert.equal(f.el("pane-appearance").hidden, true);
    f.category("execution").click();
    assert.deepEqual(f.visible(), ["harness", "usage"]);
    f.category("personal").click(); assert.equal(f.selected.at(-1), "sounds");
    f.nav.select("market");
    assert.deepEqual(f.visible(), ["agents", "market", "skills", "extensions"]);
    assert.equal(f.category("resources").getAttribute("aria-current"), "true");
    assert.equal(f.el("tab-market").tabIndex, 0);
    assert.equal(f.panel.querySelectorAll('[data-tab][aria-selected="true"]').length, 1);
    assert.equal([...f.panel.querySelectorAll("[data-pane]")].filter(pane => !pane.hidden).length, 1);
    f.nav.select("unknown"); assert.equal(f.selected.at(-1), "models");
  } finally { f.close(); }
});

test("keyboard navigation stays within the category, focuses selected controls and leaves form arrows alone", () => {
  const f = fixture();
  const key = (target, value) => target.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  try {
    f.nav.select("appearance");
    key(f.el("tab-appearance"), "ArrowRight");
    assert.equal(f.selected.at(-1), "sounds"); assert.equal(f.window.document.activeElement, f.el("tab-sounds"));
    key(f.el("tab-sounds"), "End"); assert.equal(f.selected.at(-1), "shortcuts");
    key(f.el("tab-shortcuts"), "ArrowDown"); assert.equal(f.selected.at(-1), "appearance");
    key(f.category("personal"), "ArrowDown"); assert.equal(f.selected.at(-1), "agents");
    const count = f.selected.length;
    key(f.el("library-content"), "Home"); assert.equal(f.selected.length, count);
    f.nav.dispose(); f.category("system").click(); assert.equal(f.selected.length, count);
  } finally { f.close(); }
});

test("relocated controls stay unique and runtime details survive diagnostics and language refresh", async () => {
  const f = fixture();
  const ui = setupSystemSettings({ language: () => "en", invoke: async () => ({ checkedAt: 1, version: "1.0.10-fix.1", checks: [] }) });
  try {
    const ids = [...f.window.document.querySelectorAll("[id]")].map(node => node.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(f.el("sound-switch").closest("[data-pane]").dataset.pane, "sounds");
    assert.equal(f.el("renderer-switch").closest("[data-pane]").dataset.pane, "system");
    assert.equal(f.el("persona-text").closest("[data-pane]").dataset.pane, "agents");
    const runtime = f.el("runtime-executable"), renderer = f.el("renderer-switch");
    runtime.textContent = "/test/pi"; renderer.checked = true;
    let changes = 0; renderer.addEventListener("change", () => changes++);
    await ui.refresh(); ui.refreshLanguage();
    assert.equal(f.el("runtime-executable"), runtime); assert.equal(runtime.textContent, "/test/pi");
    assert.equal(f.el("renderer-switch"), renderer); assert.equal(renderer.checked, true);
    renderer.dispatchEvent(new f.window.Event("change")); assert.equal(changes, 1);
  } finally { ui.dispose(); f.close(); }
});
