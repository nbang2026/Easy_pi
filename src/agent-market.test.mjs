import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { setupAgentMarket } from "./agent-market.ts";
import { createAgentLibrary } from "../src-tauri/src/gui-library.mjs";
import { MARKET_CATALOG } from "../src-tauri/src/gui-market.mjs";
import { UI_STRINGS } from "./ui-strings.ts";

const flush = async () => { for (let tick = 0; tick < 3; tick++) await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
function installPreview(state, preview, id) {
  state.installed.push({ ...preview, id });
  if (!state.entries.some((item) => item.marketKey === preview.marketKey)) {
    const { content, token, ...entry } = preview;
    state.entries.push({ ...entry, installedId: id, category: "external" });
  }
  return { id, alreadyImported: false };
}
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
      assert.equal(command, "skill_store_action");
      const request = JSON.parse(args.text); calls.push(request);
      if (handler) { const value = await handler(request, state); if (value !== undefined) return { data: value }; }
      if (request.kind === "market" && request.action === "list") return { data: structuredClone(state) };
      if (request.kind === "market" && request.action === "preview" && request.id) return { data: { ...MARKET_CATALOG.find((item) => item.id === request.id) } };
      if (request.kind === "market" && request.action === "import") {
        const item = MARKET_CATALOG.find((item) => item.id === request.id);
        assert.ok(item, "Remote imports need a matching preview fixture");
        return { data: installPreview(state, item, "local-agent") };
      }
      if (request.kind === "settings") { state.activeAgent = request.activeAgent; return { data: { activeAgent: state.activeAgent } }; }
      throw Error("Unexpected request");
    },
  });
  const el = (id) => window.document.getElementById("market-" + id);
  return { window, ui, calls, el, get changed() { return changed; }, get opened() { return opened; },
    get state() { return state; }, set state(value) { state = value; }, language(value) { language = value; ui.refreshLanguage(); },
    cards() { return [...el("list").querySelectorAll(".market-card")]; },
    event(id, type, value) { const element = el(id); if (typeof value === "boolean") element.checked = value; else if (value !== undefined) element.value = value; element.dispatchEvent(new window.Event(type, { bubbles: true })); },
    async idle() {
      const deadline = Date.now() + 5000;
      await flush();
      while (el("list").getAttribute("aria-busy") === "true" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(el("list").getAttribute("aria-busy"), "false", "Market operation did not finish");
      await flush();
    },
    close() { ui.dispose(); window.happyDOM.abort(); globalThis.document = previous; },
  };
}

test("market has no startup network request and filters real catalog by category/search/imported", async () => {
  const f = fixture(); try {
    assert.deepEqual(f.calls, []); await f.ui.refresh(); assert.equal(f.cards().length, MARKET_CATALOG.length);
    f.event("category", "change", "engineering"); assert.equal(f.cards().length, MARKET_CATALOG.filter((item) => item.category === "engineering").length);
    f.event("search", "input", "bug investigator"); assert.equal(f.cards().length, 1);
    f.el("downloaded").click(); await flush(); assert.equal(f.cards().length, 0);
    assert.equal(f.el("list").textContent, UI_STRINGS.en["market.noMatch"]);
    f.language("zh"); assert.equal(f.el("list").textContent, UI_STRINGS.zh["market.noMatch"]);
  } finally { f.close(); }
});

test("one card click previews and downloads the full definition without activating it", async () => {
  const f = fixture(); try {
    await f.ui.refresh(); f.cards()[0].click(); await flush();
    assert.equal(f.el("consent"), null);
    assert.equal(f.el("detail").hidden, false); assert.equal(f.el("content").textContent, MARKET_CATALOG[0].content);
    assert.deepEqual(f.calls, [
      { kind: "market", action: "list" },
      { kind: "market", action: "preview", id: MARKET_CATALOG[0].id },
      { kind: "market", action: "import", id: MARKET_CATALOG[0].id, hash: MARKET_CATALOG[0].hash, accepted: true },
      { kind: "market", action: "list" },
    ]);
    assert.equal(f.changed, 1); assert.equal(f.state.activeAgent, "");
    assert.equal(f.el("import").disabled, true); assert.equal(f.el("import").textContent, UI_STRINGS.en["market.installed"]);
    assert.equal(f.el("activate").hidden, false); assert.equal(f.el("activate").disabled, false);
    f.event("import", "click"); await flush(); assert.equal(f.calls.filter((r) => r.action === "import").length, 1);
    f.el("activate").click(); await flush();
    assert.deepEqual(f.calls.filter((r) => r.kind === "settings"), [{ kind: "settings", activeAgent: "local-agent" }]);
    assert.equal(f.el("activate").disabled, true); assert.equal(f.el("deactivate").hidden, false);
    f.el("deactivate").click(); await flush(); assert.equal(f.calls.at(-2).activeAgent, "");
    assert.equal(f.changed, 3); assert.equal(f.el("deactivate").hidden, true);
  } finally { f.close(); }
});

test("a failed new preview clears obsolete detail and cannot download the previous selection", async () => {
  const f = fixture(async (r) => { if (r.action === "preview" && r.id === MARKET_CATALOG[1].id) throw Error("offline"); }); try {
    await f.ui.refresh(); f.cards()[0].click(); await flush();
    const imports = f.calls.filter((r) => r.action === "import"); assert.equal(imports.length, 1);
    f.cards()[1].click(); await flush();
    assert.equal(f.el("detail").hidden, true); assert.equal(f.el("content").textContent, "");
    assert.equal(f.el("import").disabled, true); assert.match(f.el("status").textContent, /offline/);
    f.event("import", "click"); await flush();
    assert.deepEqual(f.calls.filter((r) => r.action === "import"), imports); assert.equal(f.changed, 1);
  } finally { f.close(); }
});

test("untrusted downloaded preview and error messages render as text, never HTML", async () => {
  const payload = '<img src=x onerror=alert(1)><script>globalThis.bad=1</script>';
  let preview;
  const f = fixture(async (r, state) => {
    if (r.action === "preview" && r.source) return preview = { ...MARKET_CATALOG[0], id: "", title: payload, content: payload, source: r.source, marketKey: 'github:' + r.source, token: "opaque" };
    if (r.action === "import") return installPreview(state, preview, "untrusted-local");
  }); try {
    await f.ui.refresh(); f.el("source").value = "https://github.com/a/b/blob/main/AGENT.md"; f.el("preview-url").click(); await flush();
    assert.equal(f.el("content").textContent, payload); assert.equal(f.el("detail-title").textContent, payload);
    assert.equal(f.el("detail").querySelector("script,img"), null); assert.equal(f.el("import").disabled, true);
    assert.equal(f.el("list").querySelector("script,img"), null); assert.equal(f.changed, 1);
    f.el("detail-close").click(); assert.equal(f.el("content").textContent, "");
  } finally { f.close(); }
});

test("the URL download button automatically saves the preview token and hash without activating or installing code", async () => {
  let preview;
  const f = fixture(async (r, state) => {
    if (r.action === "preview" && r.source) return preview = { ...MARKET_CATALOG[0], id: "", source: r.source, token: "server-preview-token", hash: "server-hash", marketKey: 'github:' + r.source };
    if (r.action === "import") return installPreview(state, preview, "remote-local");
  }); try {
    const source = "https://github.com/a/b/blob/main/role.md";
    await f.ui.refresh(); f.el("source").value = `  ${source}  `; f.el("preview-url").click(); await flush();
    assert.deepEqual(f.calls, [
      { kind: "market", action: "list" }, { kind: "market", action: "preview", source },
      { kind: "market", action: "import", token: "server-preview-token", hash: "server-hash", accepted: true },
      { kind: "market", action: "list" },
    ]);
    assert.equal(f.calls.some((r) => /install|plugin|mcp|execute/.test(r.action || "")), false);
    assert.equal(f.changed, 1); assert.equal(f.state.activeAgent, "");
    assert.equal(f.el("import").disabled, true); assert.equal(f.el("activate").hidden, false);
    f.event("category", "change", "external"); f.el("downloaded").click(); await flush(); assert.equal(f.cards().length, 1);
  } finally { f.close(); }
});

test("external downloaded cards use local preview and explicit activation without another download", async () => {
  const entry = { ...MARKET_CATALOG[0], id: "", installedId: "remote-local", marketKey: "github:https://raw.githubusercontent.com/a/b/main/role.md", category: "external" };
  const f = fixture(async (r) => { if (r.installedId) return { ...entry, content: "Local edited definition" }; }); try {
    f.state = { entries: [entry], installed: [{ ...entry, id: "remote-local" }], activeAgent: "" };
    await f.ui.refresh(); f.event("category", "change", "external"); f.el("downloaded").click(); await flush(); assert.equal(f.cards().length, 1);
    f.cards()[0].click(); await flush(); assert.deepEqual(f.calls.at(-1), { kind: "market", action: "preview", installedId: "remote-local" });
    assert.equal(f.calls.filter((r) => r.action === "import").length, 0); assert.equal(f.changed, 0);
    assert.equal(f.el("content").textContent, "Local edited definition"); assert.equal(f.el("import").disabled, true);
    assert.equal(f.el("activate").hidden, false);
    f.el("activate").click(); await flush();
    assert.deepEqual(f.calls.find((r) => r.kind === "settings"), { kind: "settings", activeAgent: "remote-local" });
    assert.equal(f.el("activate").disabled, true); assert.equal(f.changed, 1);
  } finally { f.close(); }
});

test("rapid card and detail button clicks share one preview and one automatic download", async () => {
  const previewWait = deferred(); const importWait = deferred();
  const f = fixture(async (r) => {
    if (r.action === "preview") return previewWait.promise;
    if (r.action === "import") await importWait.promise;
  }); try {
    await f.ui.refresh(); const [card, other] = f.cards(); card.click();
    card.dispatchEvent(new f.window.Event("click")); other.dispatchEvent(new f.window.Event("click")); f.event("import", "click");
    assert.equal(f.calls.filter((r) => r.action === "preview").length, 1);
    assert.equal(f.calls.filter((r) => r.action === "import").length, 0);
    previewWait.resolve({ ...MARKET_CATALOG[0] }); await flush();
    assert.equal(f.calls.filter((r) => r.action === "import").length, 1);
    assert.equal(f.el("list").getAttribute("aria-busy"), "true"); assert.equal(f.el("import").disabled, true);
    const count = f.calls.length;
    f.event("import", "click"); f.event("import", "click"); f.event("refresh", "click"); f.event("preview-url", "click");
    card.dispatchEvent(new f.window.Event("click")); other.dispatchEvent(new f.window.Event("click")); await flush();
    assert.equal(f.calls.length, count); assert.equal(f.changed, 0);
    importWait.resolve(); await flush();
    assert.equal(f.calls.filter((r) => r.action === "preview").length, 1);
    assert.equal(f.calls.filter((r) => r.action === "import").length, 1);
    assert.equal(f.changed, 1); assert.equal(f.el("import").disabled, true); assert.equal(f.el("list").getAttribute("aria-busy"), "false");
  } finally { f.close(); }
});

for (const remote of [false, true]) {
  test(`failed ${remote ? "URL" : "card"} download retains the preview for a single-flight detail button retry`, async () => {
    const wait = deferred(); let attempts = 0; let preview;
    const f = fixture(async (r, state) => {
      if (r.action === "preview" && r.source) return preview = { ...MARKET_CATALOG[0], id: "", source: r.source, token: "retry-token", marketKey: 'github:' + r.source };
      if (r.action === "import") {
        attempts++; if (attempts === 1) return wait.promise;
        if (remote) return installPreview(state, preview, "remote-retry");
      }
    }); try {
      await f.ui.refresh();
      if (remote) { f.el("source").value = "https://github.com/a/b/blob/main/retry.md"; f.el("preview-url").click(); }
      else f.cards()[0].click();
      await flush(); assert.equal(attempts, 1); assert.equal(f.el("list").getAttribute("aria-busy"), "true");
      wait.reject(Error("<img src=x> disk full")); await flush();
      assert.match(f.el("status").textContent, /<img src=x> disk full/); assert.equal(f.el("status").querySelector("img"), null);
      assert.equal(f.el("detail").hidden, false); assert.equal(f.el("content").textContent, MARKET_CATALOG[0].content);
      assert.equal(f.el("import").disabled, false); assert.equal(f.el("import").textContent, UI_STRINGS.en["market.import"]); assert.equal(f.changed, 0);
      const original = f.calls.find((r) => r.action === "import");
      f.el("import").click(); f.event("import", "click"); await flush();
      assert.equal(attempts, 2); assert.equal(f.calls.filter((r) => r.action === "preview").length, 1);
      assert.deepEqual(f.calls.filter((r) => r.action === "import"), [original, original]);
      assert.equal(f.changed, 1); assert.equal(f.el("import").disabled, true); assert.equal(f.el("activate").hidden, false);
      assert.equal(f.el("status").textContent, UI_STRINGS.en["market.imported"]);
      assert.equal(f.calls.some((r) => r.kind === "settings"), false);
    } finally { f.close(); }
  });
}

test("disposing an in-flight preview prevents automatic import and ignores detached card handlers", async () => {
  const wait = deferred();
  const f = fixture(async (r) => { if (r.action === "preview") return wait.promise; }); try {
    await f.ui.refresh(); const card = f.cards()[0]; card.click(); const calls = f.calls.length;
    f.ui.dispose(); const before = f.el("detail").outerHTML;
    wait.resolve({ ...MARKET_CATALOG[0] }); await flush();
    assert.equal(f.el("detail").outerHTML, before); assert.equal(f.changed, 0);
    assert.equal(f.calls.filter((r) => r.action === "import").length, 0);
    card.dispatchEvent(new f.window.Event("click")); await f.ui.refresh(); f.ui.refreshLanguage(); assert.equal(f.calls.length, calls);
  } finally { f.close(); }
});

test("disposing an automatic in-flight import sends no follow-up request or callback", async () => {
  const wait = deferred();
  const f = fixture(async (r) => { if (r.action === "import") return wait.promise; }); try {
    await f.ui.refresh(); f.cards()[0].click(); await flush();
    assert.equal(f.calls.filter((r) => r.action === "import").length, 1);
    const count = f.calls.length; f.ui.dispose(); const before = f.el("detail").outerHTML;
    wait.resolve({ id: "done" }); await flush();
    assert.equal(f.calls.length, count); assert.equal(f.changed, 0); assert.equal(f.el("detail").outerHTML, before);
  } finally { f.close(); }
});

test("a local edited Agent is previewed without another import and library navigation remains usable", async () => {
  const f = fixture(); try {
    const edited = { ...MARKET_CATALOG[0], id: "edited", hash: "edited-hash", content: "Keep local edits" };
    f.state = { entries: [{ ...MARKET_CATALOG[0] }], installed: [edited], activeAgent: "" };
    await f.ui.refresh(); f.cards()[0].click(); await flush();
    assert.match(f.el("detail-meta").textContent, /local|edited/i);
    f.event("import", "click"); await flush();
    assert.equal(f.calls.filter((r) => r.action === "import").length, 0); assert.equal(f.changed, 0);
    assert.deepEqual(f.state.installed, [edited]); assert.equal(f.el("import").disabled, true);
    f.el("open-library").click(); assert.equal(f.opened, 1);
  } finally { f.close(); }
});

test("one card click persists a complete Agent across library restart without activating, duplicating or overwriting edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-market-ui-test-"));
  const fetcher = async () => assert.fail("Built-in card downloads must not use the network");
  const library = createAgentLibrary({ directory, fetcher });
  let f;
  try {
    f = fixture((request) => library.run(request));
    await f.ui.refresh(); f.cards()[0].click(); await f.idle();
    const expected = MARKET_CATALOG[0];
    assert.ok(expected.content.length > 160, "Fixture must detect a truncated library preview being saved");
    assert.equal(f.changed, 1); assert.equal(f.el("content").textContent, expected.content); assert.equal(f.el("import").disabled, true);
    const filename = join(directory, "library.json");
    const persisted = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(persisted.agents.length, 1);
    const saved = persisted.agents[0];
    for (const key of ["title", "content", "source", "marketKey"]) assert.equal(saved[key], expected[key], key);
    assert.equal(saved.importedHash, expected.hash); assert.equal(saved.marketVersion, expected.version); assert.equal(saved.untrusted, true);
    assert.equal(persisted.settings.activeAgent || "", "");
    const restarted = createAgentLibrary({ directory, fetcher });
    const list = await restarted.run({ kind: "list" });
    assert.deepEqual(list.agents.map((item) => item.id), [saved.id]); assert.equal(list.settings.activeAgent, "");
    assert.equal((await restarted.run({ kind: "agent", action: "read", id: saved.id })).content, expected.content);
    assert.equal((await restarted.run({ kind: "context" })).agent, null);
    const market = await restarted.run({ kind: "market", action: "list" });
    assert.equal(market.entries.find((entry) => entry.id === expected.id).installedId, saved.id);
    assert.equal(market.installed[0].id, saved.id); assert.equal(market.activeAgent, "");
    const beforeRepeat = await readFile(filename, "utf8");
    f.cards()[0].click(); await f.idle();
    assert.equal(await readFile(filename, "utf8"), beforeRepeat);
    assert.equal(f.calls.filter((request) => request.action === "import").length, 1); assert.equal(f.changed, 1);
    const edited = await restarted.run({ kind: "agent", action: "save", id: saved.id, title: "My local Agent", content: "# Local edits\nKeep every word of this custom definition." });
    const beforeEditedPreview = await readFile(filename, "utf8");
    await f.ui.refresh(); f.cards()[0].click(); await f.idle();
    assert.match(f.el("detail-meta").textContent, /local|edited/i);
    f.event("import", "click"); await f.idle();
    assert.equal(await readFile(filename, "utf8"), beforeEditedPreview);
    assert.equal(f.calls.filter((request) => request.action === "import").length, 1); assert.equal(f.changed, 1);
    const finalLibrary = createAgentLibrary({ directory, fetcher });
    assert.deepEqual(await finalLibrary.run({ kind: "agent", action: "read", id: saved.id }), edited);
    const finalList = await finalLibrary.run({ kind: "list" });
    assert.deepEqual(finalList.agents.map((item) => item.id), [saved.id]); assert.equal(finalList.settings.activeAgent, "");
    assert.equal((await finalLibrary.run({ kind: "context" })).agent, null);
    assert.equal(f.calls.some((request) => request.kind === "settings"), false);
  } finally { f?.close(); library.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("market removes the scope banner and offers every catalog category", async () => {
  const f = fixture(); try {
    assert.equal(f.window.document.querySelector(".market-scope,[data-i18n='market.scope']"), null);
    assert.equal(f.window.document.body.textContent.includes("不安装 DSH"), false);
    await f.ui.refresh();
    for (const category of new Set(MARKET_CATALOG.map((item) => item.category))) {
      assert.ok([...f.el("category").options].some((option) => option.value === category), category);
      for (const language of ["zh", "en"]) assert.ok(UI_STRINGS[language]["market.category." + category]);
      f.event("category", "change", category);
      assert.equal(f.cards().length, MARKET_CATALOG.filter((item) => item.category === category).length);
      assert.equal(f.el("count").textContent, `${f.cards().length} / ${MARKET_CATALOG.length}`);
    }
  } finally { f.close(); }
});

test("market markup has unique required IDs, no consent checkbox and complete bilingual download strings", () => {
  const f = fixture(); try {
    const ids = [...f.window.document.querySelectorAll("[id]")].map((el) => el.id); assert.equal(new Set(ids).size, ids.length);
    assert.equal(f.window.document.querySelector("#market-consent,.market-consent,[data-i18n='market.consent']"), null);
    for (const id of ["list", "content", "import", "activate", "source", "preview-url"]) assert.ok(f.el(id), id);
    for (const element of f.window.document.querySelectorAll("[data-i18n]")) for (const lang of ["zh", "en"]) assert.ok(UI_STRINGS[lang][element.dataset.i18n], element.dataset.i18n);
    for (const lang of ["zh", "en"]) for (const key of ["market.localEdited", "market.loadingPreview", "market.import", "market.installed", "ui.selectModel"]) assert.ok(UI_STRINGS[lang][key], `${lang}:${key}`);
    assert.equal(UI_STRINGS.en["market.import"], "Download and save"); assert.equal(UI_STRINGS.en["market.installed"], "Downloaded");
  } finally { f.close(); }
});

test("opening the market browses online without a model and previews before a single explicit download", async () => {
  const online = { ...MARKET_CATALOG[0], id: "", catalogSource: "agency", path: "engineering/reviewer.md",
    marketKey: "github:online-reviewer", source: "https://raw.githubusercontent.com/example/agents/" + "a".repeat(40) + "/reviewer.md" };
  let preview;
  const f = fixture(async (r, state) => {
    if (r.action === "browse") return { entries: [online], total: 1, page: r.page, hasMore: false };
    if (r.action === "preview" && r.catalogSource) return preview = { ...online, content: "# Full online reviewer", token: "online-token", hash: "verified" };
    if (r.action === "import") return installPreview(state, preview, "online-local");
  });
  try {
    await f.ui.open(); assert.equal(f.el("online").getAttribute("aria-selected"), "true");
    assert.equal(f.cards().length, 1); assert.equal(f.el("online-controls").hidden, false);
    f.cards()[0].click(); await flush();
    assert.equal(f.calls.filter(call => call.action === "import").length, 0);
    assert.equal(f.el("content").textContent, "# Full online reviewer"); assert.equal(f.el("import").disabled, false);
    f.el("import").click(); f.el("import").click(); await flush();
    assert.equal(f.calls.filter(call => call.action === "import").length, 1);
    assert.equal(f.state.activeAgent, ""); assert.equal(f.changed, 1);
    assert.equal(f.el("import").disabled, true);
    f.el("downloaded").click(); await flush();
    assert.equal(f.cards().length, 1);
  } finally { f.close(); }
});

test("online pagination deduplicates entries and source errors leave built-in picks usable", async () => {
  const first = { ...MARKET_CATALOG[0], id: "", catalogSource: "agency", path: "a.md", marketKey: "github:a" };
  const second = { ...first, path: "b.md", marketKey: "github:b", title: "Other" };
  const f = fixture(async r => {
    if (r.action === "browse") {
      if (r.provider === "voltagent") throw Error("fixture offline");
      return { entries: r.page === 1 ? [first] : [first, second], total: 2, page: r.page, hasMore: r.page === 1 };
    }
  });
  try {
    await f.ui.open(); assert.equal(f.el("more").hidden, false);
    f.el("more").click(); await flush();
    assert.equal(f.cards().length, 2); assert.equal(f.el("more").hidden, true);
    f.event("provider", "change", "voltagent"); await flush();
    assert.match(f.el("status").textContent, /fixture offline/);
    f.el("builtin").click(); await flush();
    assert.equal(f.cards().length, MARKET_CATALOG.length);
    assert.equal(f.el("online-controls").hidden, true);
    assert.equal(f.el("installed-only"), null);
  } finally { f.close(); }
});

test("late online results cannot replace a newer source or a disposed market", async () => {
  const old = deferred(), fresh = deferred();
  const f = fixture(async r => {
    if (r.action === "browse") return r.provider === "agency" ? old.promise : fresh.promise;
  });
  try {
    const opening = f.ui.open(); await flush();
    f.event("provider", "change", "voltagent");
    const entry = { ...MARKET_CATALOG[0], title: "New source", catalogSource: "voltagent", path: "new.md" };
    fresh.resolve({ entries: [entry], total: 1, page: 1, hasMore: false }); await flush();
    old.resolve({ entries: [], total: 0, page: 1, hasMore: false }); await opening;
    assert.equal(f.cards().length, 1); assert.match(f.cards()[0].textContent, /New source/);
    f.ui.dispose(); const before = f.el("list").outerHTML;
    f.event("provider", "change", "agency"); await flush();
    assert.equal(f.el("list").outerHTML, before);
  } finally { old.resolve({ entries: [], total: 0 }); fresh.resolve({ entries: [], total: 0 }); f.close(); }
});

test("online search waits for typing and submits the selected category to the source", async t => {
  const f = fixture(async r => r.action === "browse" ? { entries: [], total: 0, page: 1, hasMore: false } : undefined);
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await f.ui.open();
    const count = f.calls.length;
    f.event("search", "input", "front"); f.event("search", "input", "frontend");
    t.mock.timers.tick(200); await flush(); assert.equal(f.calls.length, count);
    t.mock.timers.tick(100); await flush();
    assert.equal(f.calls.at(-1).query, "frontend");
    f.event("category", "change", "engineering"); await flush();
    assert.equal(f.calls.at(-1).category, "engineering");
  } finally { f.close(); }
});
