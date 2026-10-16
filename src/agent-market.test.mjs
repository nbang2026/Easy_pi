import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { setupAgentMarket } from "./agent-market.ts";
import { MARKET_CATALOG } from "../src-tauri/src/gui-market.mjs";
import { UI_STRINGS } from "./ui-strings.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
function fixture(handler) {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  const previous = globalThis.document; globalThis.document = window.document;
  window.document.body.innerHTML = html.slice(html.indexOf('<section id="pane-market"'), html.indexOf('<section id="pane-agents"'));
  const calls = []; let changed = 0; let opened = 0; let language = "en";
  let state = { entries: MARKET_CATALOG.map(({ content, ...item }) => ({ ...item })), installed: [], activeAgent: "" };
  const ui = setupAgentMarket({
    translate: (key) => UI_STRINGS[language][key] || key,
    changed: () => { changed++; }, openLibrary: () => { opened++; },
    invoke: async (command, args) => {
      assert.equal(command, "gui_action"); assert.equal(args.action, "library");
      const request = JSON.parse(args.text); calls.push(request);
      if (handler) { const value = await handler(request); if (value !== undefined) return { data: value }; }
      if (request.kind === "market" && request.action === "list") return { data: structuredClone(state) };
      if (request.kind === "market" && request.action === "preview" && request.id) return { data: { ...MARKET_CATALOG.find((item) => item.id === request.id) } };
      if (request.kind === "market" && request.action === "import") {
        const item = MARKET_CATALOG.find((item) => item.id === request.id);
        state.installed.push({ ...item, id: "local-agent" }); return { data: { id: "local-agent", alreadyImported: false } };
      }
      if (request.kind === "settings") { state.activeAgent = request.activeAgent; return { data: { activeAgent: state.activeAgent } }; }
      throw Error("Unexpected request");
    },
  });
  const el = (id) => window.document.getElementById("market-" + id);
  return { window, ui, calls, el, get changed() { return changed; }, get opened() { return opened; },
    set state(value) { state = value; }, language(value) { language = value; ui.refreshLanguage(); },
    cards() { return [...el("list").querySelectorAll(".market-card")]; },
    event(id, type, value) { const element = el(id); if (typeof value === "boolean") element.checked = value; else if (value !== undefined) element.value = value; element.dispatchEvent(new window.Event(type, { bubbles: true })); },
    close() { ui.dispose(); window.happyDOM.abort(); globalThis.document = previous; },
  };
}

test("market has no startup network request and filters real catalog by category/search/imported", async () => {
  const f = fixture(); try {
    assert.deepEqual(f.calls, []); await f.ui.refresh(); assert.equal(f.cards().length, 8);
    f.event("category", "change", "engineering"); assert.equal(f.cards().length, 4);
    f.event("search", "input", "bug investigator"); assert.equal(f.cards().length, 1);
    f.event("installed-only", "change", true); assert.equal(f.cards().length, 0);
    assert.equal(f.el("list").textContent, UI_STRINGS.en["market.noMatch"]);
    f.language("zh"); assert.equal(f.el("list").textContent, UI_STRINGS.zh["market.noMatch"]);
  } finally { f.close(); }
});

test("full preview requires consent and import is distinct from explicit activation", async () => {
  const f = fixture(); try {
    await f.ui.refresh(); f.cards()[0].click(); await flush();
    assert.equal(f.el("content").textContent, MARKET_CATALOG[0].content); assert.equal(f.el("import").disabled, true);
    f.el("import").dispatchEvent(new f.window.Event("click")); await flush();
    assert.equal(f.calls.filter((r) => r.action === "import").length, 0);
    f.event("consent", "change", true); f.el("import").click(); await flush();
    const imports = f.calls.filter((r) => r.action === "import"); assert.equal(imports.length, 1);
    assert.equal(imports[0].accepted, true); assert.equal(imports[0].hash, MARKET_CATALOG[0].hash);
    assert.equal(f.calls.filter((r) => r.kind === "settings").length, 0); assert.equal(f.changed, 1);
    assert.equal(f.el("import").disabled, true); assert.equal(f.el("activate").hidden, false);
    f.el("activate").click(); await flush();
    assert.deepEqual(f.calls.filter((r) => r.kind === "settings"), [{ kind: "settings", activeAgent: "local-agent" }]);
    assert.equal(f.el("activate").disabled, true); assert.equal(f.el("deactivate").hidden, false);
    f.el("deactivate").click(); await flush(); assert.equal(f.calls.at(-2).activeAgent, "");
    assert.equal(f.changed, 3); assert.equal(f.el("deactivate").hidden, true);
  } finally { f.close(); }
});

test("changing preview resets consent and failed preview cannot import obsolete content", async () => {
  const f = fixture(async (r) => { if (r.action === "preview" && r.id === MARKET_CATALOG[1].id) throw Error("offline"); }); try {
    await f.ui.refresh(); f.cards()[0].click(); await flush(); f.event("consent", "change", true);
    f.cards()[1].click(); await flush();
    assert.equal(f.el("detail").hidden, true); assert.equal(f.el("consent").checked, false); assert.equal(f.el("content").textContent, "");
    assert.equal(f.el("import").disabled, true); assert.match(f.el("status").textContent, /offline/);
    f.el("import").dispatchEvent(new f.window.Event("click")); await flush(); assert.equal(f.calls.filter((r) => r.action === "import").length, 0);
  } finally { f.close(); }
});

test("untrusted preview and error messages render as text, never HTML", async () => {
  const payload = '<img src=x onerror=alert(1)><script>globalThis.bad=1</script>';
  const f = fixture(async (r) => {
    if (r.action === "preview" && r.source) return { ...MARKET_CATALOG[0], id: "", title: payload, content: payload, source: r.source, marketKey: 'github:' + r.source, token: "opaque" };
  }); try {
    await f.ui.refresh(); f.el("source").value = "https://github.com/a/b/blob/main/AGENT.md"; f.el("preview-url").click(); await flush();
    assert.equal(f.el("content").textContent, payload); assert.equal(f.el("detail-title").textContent, payload);
    assert.equal(f.el("detail").querySelector("script,img"), null); assert.equal(f.el("import").disabled, true);
    f.el("detail-close").click(); assert.equal(f.el("content").textContent, "");
  } finally { f.close(); }
});

test("remote import submits preview token and hash without source instructions or installers", async () => {
  const f = fixture(async (r) => {
    if (r.action === "preview" && r.source) return { ...MARKET_CATALOG[0], id: "", token: "server-preview-token", hash: "server-hash", marketKey: 'github:' + r.source };
    if (r.action === "import") return { id: "remote-local", alreadyImported: false };
  }); try {
    await f.ui.refresh(); f.el("source").value = "https://github.com/a/b/blob/main/role.md"; f.el("preview-url").click(); await flush();
    f.event("consent", "change", true); f.el("import").click(); await flush();
    assert.deepEqual(f.calls.find((r) => r.action === "import"), { kind: "market", action: "import", token: "server-preview-token", hash: "server-hash", accepted: true });
    assert.equal(f.calls.some((r) => /install|plugin|mcp|execute/.test(r.action || "")), false);
  } finally { f.close(); }
});

test("external imported cards use local preview and explicit activation, not another download", async () => {
  const entry = { ...MARKET_CATALOG[0], id: "", installedId: "remote-local", marketKey: "github:https://raw.githubusercontent.com/a/b/main/role.md", category: "external" };
  const f = fixture(async (r) => { if (r.installedId) return { ...entry, content: "Local edited definition" }; }); try {
    f.state = { entries: [entry], installed: [{ ...entry, id: "remote-local" }], activeAgent: "" };
    await f.ui.refresh(); f.event("category", "change", "external"); f.event("installed-only", "change", true); assert.equal(f.cards().length, 1);
    f.cards()[0].click(); await flush(); assert.deepEqual(f.calls.at(-1), { kind: "market", action: "preview", installedId: "remote-local" });
    assert.equal(f.el("content").textContent, "Local edited definition"); assert.equal(f.el("import").disabled, true);
    assert.equal(f.el("activate").hidden, false);
  } finally { f.close(); }
});

test("single-flight operation prevents double import and preserves consent on failure for retry", async () => {
  const wait = deferred(); let attempts = 0;
  const f = fixture(async (r) => { if (r.action === "import") { attempts++; if (attempts === 1) return wait.promise; return { id: "retry" }; } }); try {
    await f.ui.refresh(); f.cards()[0].click(); await flush(); f.event("consent", "change", true); f.el("import").click();
    f.el("import").dispatchEvent(new f.window.Event("click")); f.el("refresh").dispatchEvent(new f.window.Event("click"));
    assert.equal(attempts, 1); assert.equal(f.el("list").getAttribute("aria-busy"), "true");
    wait.reject(Error("<img src=x> disk full")); await flush();
    assert.match(f.el("status").textContent, /disk full/); assert.equal(f.el("status").querySelector("img"), null); assert.equal(f.el("import").disabled, false);
    f.el("import").click(); await flush(); assert.equal(attempts, 2);
  } finally { f.close(); }
});

test("disposing an in-flight preview ignores response and detached card handlers", async () => {
  const wait = deferred();
  const f = fixture(async (r) => { if (r.action === "preview") return wait.promise; }); try {
    await f.ui.refresh(); const card = f.cards()[0]; card.click(); const calls = f.calls.length;
    f.ui.dispose(); const before = f.el("detail").outerHTML;
    wait.resolve({ ...MARKET_CATALOG[0] }); await flush();
    assert.equal(f.el("detail").outerHTML, before); assert.equal(f.changed, 0);
    card.dispatchEvent(new f.window.Event("click")); await f.ui.refresh(); f.ui.refreshLanguage(); assert.equal(f.calls.length, calls);
  } finally { f.close(); }
});

test("disposing an in-flight import sends no follow-up request or callback", async () => {
  const wait = deferred();
  const f = fixture(async (r) => { if (r.action === "import") return wait.promise; }); try {
    await f.ui.refresh(); f.cards()[0].click(); await flush(); f.event("consent", "change", true); f.el("import").click();
    const count = f.calls.length; f.ui.dispose(); wait.resolve({ id: "done" }); await flush();
    assert.equal(f.calls.length, count); assert.equal(f.changed, 0);
  } finally { f.close(); }
});

test("local edited Agent is not overwritten; library navigation remains usable", async () => {
  const f = fixture(); try {
    f.state = { entries: [{ ...MARKET_CATALOG[0] }], installed: [{ ...MARKET_CATALOG[0], id: "edited", hash: "edited-hash" }], activeAgent: "" };
    await f.ui.refresh(); f.cards()[0].click(); await flush();
    assert.match(f.el("detail-meta").textContent, /local|edited/i);
    f.event("consent", "change", true); f.el("import").dispatchEvent(new f.window.Event("click")); await flush();
    assert.equal(f.calls.filter((r) => r.action === "import").length, 0);
    f.el("open-library").click(); assert.equal(f.opened, 1);
  } finally { f.close(); }
});

test("market markup has unique required IDs and complete bilingual strings", () => {
  const f = fixture(); try {
    const ids = [...f.window.document.querySelectorAll("[id]")].map((el) => el.id); assert.equal(new Set(ids).size, ids.length);
    for (const element of f.window.document.querySelectorAll("[data-i18n]")) for (const lang of ["zh", "en"]) assert.ok(UI_STRINGS[lang][element.dataset.i18n], element.dataset.i18n);
    for (const lang of ["zh", "en"]) for (const key of ["market.localEdited", "market.loadingPreview", "ui.selectModel"]) assert.ok(UI_STRINGS[lang][key], `${lang}:${key}`);
  } finally { f.close(); }
});
