import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { normalizeThemePreference, resolveTheme, setupThemePreference } from "./theme.ts";

test("theme preference resolves explicit and system modes", () => {
  assert.equal(normalizeThemePreference("dark"), "dark");
  assert.equal(normalizeThemePreference("light"), "light");
  assert.equal(normalizeThemePreference("invalid"), "system");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("theme preference persists, updates the document and tracks system changes", () => {
  const window = new Window({ url: "http://localhost" });
  const mediaListeners = new Set();
  const media = {
    matches: true,
    addEventListener(_type, listener) { mediaListeners.add(listener); },
    removeEventListener(_type, listener) { mediaListeners.delete(listener); },
  };
  window.matchMedia = () => media;
  window.document.head.innerHTML = '<meta name="theme-color" content="#f7f8fa">';
  const controller = setupThemePreference(window.document.documentElement, window);
  try {
    assert.equal(window.document.documentElement.dataset.theme, "dark");
    assert.equal(controller.preference, "system");
    assert.equal(window.document.querySelector('meta[name="theme-color"]').content, "#141719");

    controller.setPreference("light");
    assert.equal(window.document.documentElement.dataset.theme, "light");
    assert.equal(window.localStorage.getItem("pi.theme"), "light");

    media.matches = true;
    for (const listener of mediaListeners) listener();
    assert.equal(window.document.documentElement.dataset.theme, "light");

    controller.setPreference("system");
    assert.equal(window.document.documentElement.dataset.theme, "dark");
    media.matches = false;
    for (const listener of mediaListeners) listener();
    assert.equal(window.document.documentElement.dataset.theme, "light");

    controller.setPreference("not-a-theme");
    assert.equal(controller.preference, "system");
    assert.equal(window.localStorage.getItem("pi.theme"), "system");
  } finally {
    controller.dispose();
    window.happyDOM.abort();
  }
});

test("theme preference reacts to changes from another application window", () => {
  const window = new Window({ url: "http://localhost" });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const controller = setupThemePreference(window.document.documentElement, window);
  try {
    window.dispatchEvent(new window.StorageEvent("storage", { key: "pi.theme", newValue: "dark" }));
    assert.equal(controller.preference, "dark");
    assert.equal(window.document.documentElement.dataset.theme, "dark");
    window.dispatchEvent(new window.StorageEvent("storage", { key: "unrelated", newValue: "light" }));
    assert.equal(controller.preference, "dark");
  } finally {
    controller.dispose();
    window.happyDOM.abort();
  }
});

test("dark appearance adapts UI surfaces and states without changing typography", () => {
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  for (const selector of [
    '.agent-session-item.is-active',
    '.agent-session-item.is-failed',
    '.diff-add',
    '.diff-remove',
    '.market-card-tags',
    'body[data-agent-engine="claude"] #claude-view',
  ]) {
    assert.ok(css.includes(`html[data-theme="dark"] ${selector}`), `missing dark UI treatment for ${selector}`);
  }
  assert.doesNotMatch(css, /html\[data-theme="dark"\][^{]*\{[^}]*font-(?:size|family)\s*:/s);
});

test("dark appearance does not turn the inline answer actions into a separate panel", () => {
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /html\[data-theme="dark"\][^{]*\.conversation-actions/);
});
