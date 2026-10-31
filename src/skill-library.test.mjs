import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { setupSkillLibrary } from "./skill-library.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let n = 0; n < 5; n++) await tick(); }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const entry = { id: "upstream", name: "Real skill", description: "Useful files", source: "skills-sh", url: "https://skills.sh/owner/repo/real", repoUrl: "https://github.com/owner/repo", license: "MIT" };
const skill = { ...entry, id: "downloaded-1", enabled: false, commit: "c0ffee" };
const preview = { ...entry, token: "review-token", hash: "sha256-review", commit: "c0ffee", files: [{ path: "SKILL.md", size: 24 }, { path: "scripts/task.sh", size: 10 }], totalBytes: 34, content: "# Real skill\n<script>globalThis.pwned=true</script>", warnings: ["Review scripts before use"] };
function fixture(handler = async () => undefined, reload, reconnect = async () => {}) {
  const window = new Window({ settings: { enableJavaScriptEvaluation: false } });
  const previous = globalThis.document; globalThis.document = window.document;
  const root = window.document.createElement("section"); root.id = "pane-skills"; window.document.body.append(root);
  const calls = []; let records = [{ ...skill }], lang = "en";
  const api = setupSkillLibrary({
    language: () => lang, reload, reconnect,
    async invoke(command, args) {
      assert.equal(command, "skill_store_action"); assert.deepEqual(Object.keys(args), ["text"]);
      const data = JSON.parse(args.text); assert.equal(data.kind, "skills"); calls.push(data);
      const custom = await handler(data); if (custom !== undefined) return { data: custom };
      switch (data.action) {
        case "list": return { data: { skills: records, revision: 1 } };
        case "browse": case "search": return { data: { entries: [{ ...entry, source: data.source }], sources: [{ source: data.source, ok: true }], page: data.page, hasMore: false } };
        case "preview": case "update": return { data: { jobId: "job-1" } };
        case "job": return { data: { id: data.jobId, state: "ready", preview } };
        case "cancel": return { data: { cancelled: true } };
        case "install": records = [{ ...skill }]; return { data: { skill: records[0], revision: 2, reloadRequired: true } };
        case "enable": records = records.map((item) => ({ ...item, enabled: data.enabled })); return { data: { enabled: data.enabled, reloadRequired: true } };
        case "read": return { data: { skill: records[0], content: preview.content, files: preview.files } };
        case "remove": records = []; return { data: { removed: true, reloadRequired: true } };
        default: throw new Error(`Unexpected action ${data.action}`);
      }
    },
  });
  return {
    api, root, window, calls,
    $(selector) { const node = root.querySelector(selector); assert.ok(node, selector); return node; },
    language(value) { lang = value; api.refreshLanguage(); },
    async close() { api.dispose(); await settle(); globalThis.document = previous; await window.happyDOM.abort(); },
  };
}
async function search(f) { f.$(".skill-query").value = "real"; f.$(".skill-search").click(); await settle(); }
async function openPreview(f) { await search(f); f.$(".skill-preview-entry").click(); await settle(); }
function agree(f) { const checkbox = f.$(".skill-consent"); checkbox.checked = true; checkbox.dispatchEvent(new f.window.Event("change", { bubbles: true })); }

test("builds from an empty parent pane; bilingual search is explicit and URLs contain only inert text", async () => {
  const f = fixture();
  try {
    assert.equal(f.calls.length, 0); assert.match(f.root.textContent, /No account or API key/);
    f.$(".skill-query").value = "typed"; f.$(".skill-query").dispatchEvent(new f.window.Event("input")); await settle(); assert.equal(f.calls.length, 0);
    assert.deepEqual([...f.$(".skill-source").options].map((item) => item.textContent), ["All sources", "skillstore.io", "skills.sh", "skillsmp.com"]);
    f.language("zh-CN"); assert.match(f.$(".skill-tab-discover").textContent, /在线商店/); assert.equal(f.$(".skill-query").value, "typed");
    f.language("en"); await search(f); assert.equal(f.calls[0].query, "real"); assert.equal(f.calls[0].source, "skillstore"); assert.equal(f.calls[0].page, 1);
    assert.equal(f.$(".skill-result h3").textContent, "Real skill");
    f.$(".skill-url").value = "https://github.com/owner/repo"; f.$(".skill-preview-url").click(); await settle();
    assert.equal(f.calls.find((item) => item.action === "preview").url, "https://github.com/owner/repo");
    assert.equal(f.root.querySelector("script"), null); assert.equal(globalThis.pwned, undefined);
  } finally { await f.close(); }
});

test("preview files are selectable with bound credentials; late reads cannot replace a newer selection", async () => {
  const pending = deferred();
  const f = fixture(async (data) => {
    if (data.action === "preview_read") return pending.promise;
  });
  try {
    await openPreview(f);
    f.$('.skill-file[data-path="scripts/task.sh"]').click(); await settle();
    const request = f.calls.find((data) => data.action === "preview_read");
    assert.deepEqual(request, { kind: "skills", action: "preview_read", token: preview.token, hash: preview.hash, path: "scripts/task.sh" });
    f.$('.skill-file[data-path="SKILL.md"]').click(); await settle();
    pending.resolve({ path: "scripts/task.sh", content: "<script>late</script>" }); await settle();
    assert.equal(f.$(".skill-content").textContent, preview.content);
    assert.equal(f.$('.skill-file[data-path="SKILL.md"]').getAttribute("aria-pressed"), "true");
    assert.equal(f.root.querySelector("script"), null);
  } finally { pending.resolve({ content: "late" }); await f.close(); }
});

test("local companion files are read by path and failed reads show an error instead of stale content", async () => {
  let fail = false;
  const f = fixture(async (data) => {
    if (data.action === "read" && data.path) {
      if (fail) throw new Error("Binary skill files are not returned through the library.");
      return { skill, files: preview.files, path: data.path, content: "<script>inert</script>" };
    }
  });
  try {
    await f.api.refresh(); f.$(".skill-read").click(); await settle();
    f.$('.skill-file[data-path="scripts/task.sh"]').click(); await settle();
    assert.equal(f.$(".skill-content").textContent, "<script>inert</script>");
    assert.equal(f.calls.at(-1).id, skill.id);
    assert.equal(f.root.querySelector("script"), null);
    f.$('.skill-file[data-path="SKILL.md"]').click(); fail = true;
    f.$('.skill-file[data-path="scripts/task.sh"]').click(); await settle();
    assert.match(f.$(".skill-content").textContent, /Binary/);
    assert.doesNotMatch(f.$(".skill-content").textContent, /inert/);
  } finally { await f.close(); }
});

test("polls real preview jobs, requires explicit consent and downloads without enabling; selects installed row", async () => {
  let polls = 0;
  const f = fixture(async (data) => data.action === "job" && ++polls === 1 ? { id: data.jobId, state: "running", progress: { phase: "fetching", completed: 1, total: 2, totalBytes: 34 } } : undefined);
  try {
    await openPreview(f); assert.equal(polls, 1); assert.match(f.$(".skill-job").textContent, /fetching.*1\/2/);
    await new Promise((resolve) => setTimeout(resolve, 440)); await settle(); assert.equal(polls, 2);
    assert.equal(f.$(".skill-content").textContent, preview.content); assert.equal(f.root.querySelector("script"), null);
    assert.match(f.$(".skill-provenance").textContent, /c0ffee.*sha256-review.*MIT/s); assert.equal(f.$(".skill-files").children.length, 2);
    assert.equal(f.$(".skill-install").disabled, true); f.$(".skill-install").click(); await settle(); assert.equal(f.calls.some((item) => item.action === "install"), false);
    agree(f); f.$(".skill-install").click(); await settle();
    assert.deepEqual(f.calls.find((item) => item.action === "install"), { kind: "skills", action: "install", token: preview.token, hash: preview.hash, accepted: true });
    assert.equal(f.calls.some((item) => item.action === "enable"), false); assert.equal(f.$(".skill-enable").checked, false);
    assert.equal(f.$(".skill-installed-row").classList.contains("is-selected"), true); assert.match(f.$(".skill-reload-status").textContent, /pending/);
    assert.equal(f.$(".skill-tab-downloaded").getAttribute("aria-selected"), "true");
  } finally { await f.close(); }
});

test("source failures are isolated, honor retryAfter seconds, and per-source pagination uses submitted query", async () => {
  const clock = Date.now;
  let now = clock(); Date.now = () => now;
  let limited = true;
  const f = fixture(async (data) => {
    if (data.action !== "search") return;
    if (data.source === "skillsmp" && limited) return { entries: [], sources: [{ source: "skillsmp", ok: false, error: "Rate limited <img src=x>", retryAfter: 0.05 }], page: 1, hasMore: false };
    return { entries: [{ ...entry, id: `${data.source}-${data.page}`, url: `${entry.url}-${data.page}`, source: data.source }], sources: [{ source: data.source, ok: true }], page: data.page, hasMore: data.source === "skills-sh" && data.page === 1 };
  });
  try {
    await search(f); assert.equal(f.root.querySelectorAll(".skill-result").length, 2); assert.match(f.$('.skill-source-panel[data-source="skillsmp"]').textContent, /Rate limited <img src=x>/);
    assert.equal(f.root.querySelector("img"), null); assert.equal(f.$(".skill-source-retry").disabled, true);
    f.$(".skill-query").value = "unsent draft"; f.$('.skill-load-more[data-source="skills-sh"]').click(); await settle();
    assert.equal(f.calls.at(-1).query, "real"); assert.equal(f.calls.at(-1).page, 2); assert.equal(f.calls.at(-1).source, "skills-sh"); assert.equal(f.root.querySelectorAll(".skill-result").length, 3);
    now += 1000; f.api.refreshLanguage(); limited = false;
    assert.equal(f.$(".skill-source-retry").disabled, false); f.$(".skill-source-retry").click(); await settle();
    assert.equal(f.calls.at(-1).source, "skillsmp"); assert.equal(f.root.querySelectorAll(".skill-source-error").length, 0); assert.equal(f.root.querySelectorAll(".skill-result").length, 4);
    assert.equal(f.$('.skill-source-panel[data-source="skills-sh"]').querySelectorAll(".skill-result").length, 2);
  } finally { Date.now = clock; await f.close(); }
});

for (const mode of ["browse", "search"]) {
  test(`${mode} keeps same-ID catalog URLs on the first page and across pagination, with each card previewing its own entry`, async () => {
    const entries = ["alice/tools", "bob/skills", "carol/toolbox"].map((repository) => ({
      ...entry, id: "pdf", name: "pdf", url: `https://skills.sh/${repository}/pdf`,
      repoUrl: `https://github.com/${repository}`, repository,
    }));
    const nextPage = deferred(), jobs = new Map();
    const f = fixture(async (data) => {
      if (data.action === mode) {
        if (data.page === 2) return nextPage.promise;
        return { entries: [entries[0], entries[1], { ...entries[0] }], sources: [], page: 1, hasMore: true };
      }
      if (data.action === "preview") {
        jobs.set(data.url, data.entry);
        return { jobId: data.url };
      }
      if (data.action === "job") return {
        id: data.jobId, state: "ready",
        preview: { ...preview, ...jobs.get(data.jobId), content: `Preview of ${data.jobId}` },
      };
    });
    const panel = () => f.$('.skill-source-panel[data-source="skills-sh"]');
    const cards = () => [...panel().querySelectorAll(".skill-result")];
    const checkPreviews = async (expected) => {
      assert.deepEqual(cards().map((card) => card.querySelector(".skill-result-metadata").textContent), expected.map((item) => item.repository));
      for (let index = 0; index < expected.length; index++) {
        cards()[index].querySelector(".skill-preview-entry").click(); await settle();
        const call = f.calls.filter((item) => item.action === "preview").at(-1);
        assert.equal(call.source, "skills-sh"); assert.equal(call.url, expected[index].url); assert.deepEqual(call.entry, expected[index]);
        assert.equal(f.$(".skill-detail").hidden, false);
        assert.equal(f.$(".skill-content").textContent, `Preview of ${expected[index].url}`);
        assert.ok(f.$(".skill-provenance").textContent.includes(expected[index].url));
      }
    };
    try {
      f.$(".skill-source").value = "skills-sh";
      if (mode === "browse") { f.$(".skill-source").dispatchEvent(new f.window.Event("change")); await settle(); }
      else await search(f);
      assert.equal(cards().length, 2, "different owner/repository URLs sharing an ID must survive the first page");
      const firstPage = [entries[0], entries[1]];
      await checkPreviews(firstPage);
      f.$('.skill-load-more[data-source="skills-sh"]').click(); await settle();
      assert.equal(panel().getAttribute("aria-busy"), "true");
      assert.equal(f.$('.skill-load-more[data-source="skills-sh"]').disabled, true);
      assert.equal(cards().length, 2);
      const updatedBob = { ...entries[1], id: "bob-alias", description: "Updated catalog description" };
      nextPage.resolve({ entries: [updatedBob, entries[2], entries[2]], sources: [], page: 2, hasMore: false }); await settle();
      assert.deepEqual(f.calls.filter((item) => item.action === mode).map((item) => item.page), [1, 2]);
      assert.equal(cards().length, 3, "repeated URLs deduplicate while a new URL with the same ID survives pagination");
      assert.equal(panel().getAttribute("aria-busy"), "false");
      assert.equal(f.$('.skill-load-more[data-source="skills-sh"]').hidden, true);
      await checkPreviews([firstPage[0], updatedBob, entries[2]]);
    } finally { await f.close(); }
  });
}

test("catalog entries without URLs use repository and ID together, retaining entries with no repository identity", async () => {
  const entries = [
    { ...entry, id: "pdf", url: undefined, repoUrl: "https://github.com/alice/tools" },
    { ...entry, id: "pdf", url: undefined, repoUrl: "https://github.com/bob/skills" },
    { ...entry, id: "word", url: undefined, repoUrl: "https://github.com/alice/tools" },
    { ...entry, id: "pdf", url: undefined, repoUrl: undefined, repository: "carol/tools" },
    { ...entry, id: "pdf", url: undefined, repoUrl: undefined, repository: "dave/skills" },
    { ...entry, id: "pdf", url: undefined, repoUrl: undefined, description: "Unknown repository A" },
    { ...entry, id: "pdf", url: undefined, repoUrl: undefined, description: "Unknown repository B" },
  ];
  const f = fixture(async (data) => data.action === "search" ? { entries: [...entries, { ...entries[0] }, { ...entries[3] }], sources: [], page: 1, hasMore: false } : undefined);
  try {
    f.$(".skill-source").value = "skills-sh"; await search(f);
    assert.equal(f.root.querySelectorAll(".skill-result").length, entries.length);
    assert.deepEqual([...f.root.querySelectorAll(".skill-result > p:first-of-type")].map((node) => node.textContent), entries.map((item) => item.description));
  } finally { await f.close(); }
});

test("superseded searches discard stale responses and source switches browse immediately", async () => {
  const first = deferred(), second = deferred();
  const f = fixture(async (data) => data.action === "search" ? (data.query === "first" ? first.promise : second.promise) : undefined);
  try {
    f.$(".skill-source").value = "skillsmp";
    f.$(".skill-query").value = "first"; f.$(".skill-search").click(); await settle();
    f.$(".skill-query").value = "second"; f.$(".skill-search").click(); await settle();
    second.resolve({ entries: [{ ...entry, name: "Latest", source: "skillsmp" }], sources: [], page: 1, hasMore: false }); await settle();
    first.resolve({ entries: [{ ...entry, name: "Stale", source: "skillsmp" }], sources: [], page: 1, hasMore: true }); await settle();
    assert.match(f.$(".skill-search-results").textContent, /Latest/); assert.doesNotMatch(f.$(".skill-search-results").textContent, /Stale/); assert.equal(f.$(".skill-load-more").hidden, true);
    f.$(".skill-source").value = "skills-sh"; f.$(".skill-source").dispatchEvent(new f.window.Event("change")); await settle();
    assert.equal(f.calls.at(-1).action, "browse"); assert.equal(f.calls.at(-1).source, "skills-sh");
    assert.equal(f.$(".skill-query").value, ""); assert.match(f.$(".skill-view-title").textContent, /Home/); assert.match(f.$(".skill-search-results").textContent, /Real skill/);
  } finally { await f.close(); }
});

test("read, enabled group, idle reload, update preview and native DOM removal follow user actions", async () => {
  let ready = false, reloads = 0;
  const f = fixture(undefined, async () => { reloads++; if (!ready) throw new Error("Runtime busy"); });
  try {
    await f.api.refresh(); f.$(".skill-tab-downloaded").click(); await settle();
    const toggle = f.$(".skill-enable"); toggle.checked = true; toggle.dispatchEvent(new f.window.Event("change")); await settle();
    assert.equal(f.calls.find((item) => item.action === "enable").enabled, true); assert.equal(reloads, 1); assert.match(f.$(".skill-reload-status").textContent, /pending/);
    assert.match(f.$(".skill-library-status").textContent, /Runtime busy/); assert.equal(f.$(".skill-library-status").classList.contains("is-error"), true);
    ready = true; f.$(".skill-reload").click(); await settle(); assert.match(f.$(".skill-reload-status").textContent, /Runtime reloaded/);
    assert.doesNotMatch(f.$(".skill-library-status").textContent, /Runtime busy/); assert.equal(f.$(".skill-library-status").classList.contains("is-error"), false);
    f.$(".skill-read").click(); await settle(); assert.equal(f.$(".skill-content").textContent, preview.content); assert.equal(f.$(".skill-install").hidden, true);
    f.$(".skill-update").click(); await settle(); assert.equal(f.calls.find((item) => item.action === "update").id, skill.id); assert.equal(f.$(".skill-consent").checked, false);
    assert.equal(f.calls.some((item) => item.action === "install"), false);
    f.window.confirm = () => { throw new Error("Must not use window.confirm"); };
    f.$(".skill-remove").click(); assert.equal(f.$(".skill-remove-confirm").hidden, false); assert.match(f.$(".skill-remove-confirm").textContent, /Real skill/);
    f.$(".skill-remove-cancel").click(); assert.equal(f.calls.some((item) => item.action === "remove"), false);
    f.$(".skill-remove").click(); f.$(".skill-remove-accept").click(); await settle();
    assert.equal(f.calls.find((item) => item.action === "remove").accepted, true); assert.equal(f.root.querySelectorAll(".skill-installed-row").length, 0);
  } finally { await f.close(); }
});

test("cancel before preview creation cancels its eventual job and stale local reads cannot replace a new preview", async () => {
  const job = deferred(), read = deferred();
  const f = fixture(async (data) => data.action === "preview" ? job.promise : data.action === "read" ? read.promise : undefined);
  try {
    await search(f); f.$(".skill-preview-entry").click(); await settle(); f.$(".skill-cancel-job").click();
    job.resolve({ jobId: "late-job" }); await settle(); assert.equal(f.calls.find((item) => item.action === "cancel").jobId, "late-job"); assert.equal(f.$(".skill-detail").hidden, true);
    await f.api.refresh(); f.$(".skill-read").click(); await settle(); f.$(".skill-update").click(); await settle();
    read.resolve({ skill: { ...skill, name: "Stale read" }, content: "old", files: [] }); await settle();
    assert.equal(f.$(".skill-detail h3").textContent, preview.name); assert.equal(f.$(".skill-content").textContent, preview.content);
  } finally { await f.close(); }
});

test("dispose clears timers, cancels active network jobs and ignores late responses", async () => {
  const late = deferred(); let polls = 0;
  const f = fixture(async (data) => {
    if (data.action === "job") { polls++; return { id: data.jobId, state: "running", progress: "fetching" }; }
    if (data.action === "list") return late.promise;
  });
  try {
    await openPreview(f); const refresh = f.api.refresh(); await settle(); f.api.dispose();
    late.resolve({ skills: [skill], revision: 4 }); await refresh; await settle();
    assert.equal(f.root.children.length, 0); assert.equal(f.calls.filter((item) => item.action === "cancel").length, 1);
    await new Promise((resolve) => setTimeout(resolve, 440)); assert.equal(polls, 1); assert.equal(f.root.children.length, 0);
    await f.api.refresh(); assert.equal(f.calls.filter((item) => item.action === "list").length, 1);
  } finally { await f.close(); }
});

for (const action of ["close", "replace", "dispose"]) {
  test(`a ready preview releases its retained job on ${action}`, async () => {
    const f = fixture();
    try {
      await openPreview(f);
      assert.equal(f.$(".skill-job").hidden, true, "ready previews must not remain in the running-job UI");
      assert.equal(f.$(".skill-detail").hidden, false);
      assert.equal(f.calls.some((item) => item.action === "cancel"), false);
      if (action === "close") f.$(".skill-close-detail").click();
      else if (action === "replace") f.$(".skill-preview-entry").click();
      else f.api.dispose();
      await settle();
      assert.deepEqual(f.calls.filter((item) => item.action === "cancel").map((item) => item.jobId), ["job-1"]);
      if (action === "close") {
        assert.equal(f.$(".skill-detail").hidden, true);
        f.api.dispose(); await settle();
        assert.equal(f.calls.filter((item) => item.action === "cancel").length, 1);
      }
      if (action === "replace") {
        assert.equal(f.calls.filter((item) => item.action === "preview").length, 2);
        assert.equal(f.$(".skill-detail").hidden, false);
        assert.equal(f.$(".skill-consent").checked, false);
      }
    } finally { await f.close(); }
  });
}

test("a successfully installed preview clears the ready job without cancelling its consumed token", async () => {
  const f = fixture();
  try {
    await openPreview(f); agree(f); f.$(".skill-install").click(); await settle();
    assert.equal(f.calls.filter((item) => item.action === "install").length, 1);
    f.api.dispose(); await settle();
    assert.equal(f.calls.some((item) => item.action === "cancel"), false);
  } finally { await f.close(); }
});

test("a failed install retains its ready preview for retry and releases it when closed", async () => {
  const f = fixture(async (data) => { if (data.action === "install") throw new Error("Save failed"); });
  try {
    await openPreview(f); agree(f); f.$(".skill-install").click(); await settle();
    assert.match(f.$(".skill-library-status").textContent, /Save failed/);
    assert.equal(f.$(".skill-install").disabled, false);
    assert.equal(f.calls.some((item) => item.action === "cancel"), false);
    f.$(".skill-close-detail").click(); await settle();
    assert.deepEqual(f.calls.filter((item) => item.action === "cancel").map((item) => item.jobId), ["job-1"]);
  } finally { await f.close(); }
});

test("disposing an in-flight accepted install does not cancel its committed write or call reload", async () => {
  const saved = deferred(); let reloads = 0;
  const f = fixture(async (data) => data.action === "install" ? saved.promise : undefined, async () => { reloads++; });
  try {
    await openPreview(f); agree(f); f.$(".skill-install").click(); await settle(); f.api.dispose();
    saved.resolve({ skill, revision: 2, reloadRequired: true }); await settle();
    assert.equal(f.calls.some((item) => item.action === "cancel"), false); assert.equal(reloads, 0); assert.equal(f.root.children.length, 0);
  } finally { await f.close(); }
});

test("a list snapshot started before an enable write cannot restore the old toggle", async () => {
  const oldList = deferred(); let lists = 0;
  const f = fixture(async (data) => data.action === "list" && ++lists === 2 ? oldList.promise : undefined);
  try {
    await f.api.refresh(); const staleRefresh = f.api.refresh(); await settle();
    const toggle = f.$(".skill-enable"); toggle.checked = true; toggle.dispatchEvent(new f.window.Event("change")); await settle();
    oldList.resolve({ skills: [{ ...skill, enabled: false }], revision: 1 }); await staleRefresh; await settle();
    assert.equal(f.$(".skill-enable").checked, true); assert.match(f.$(".skill-reload-status").textContent, /pending/);
  } finally { await f.close(); }
});

test("removing a skill invalidates its pending read and preview consent resets for every new job", async () => {
  const reading = deferred();
  const f = fixture(async (data) => data.action === "read" ? reading.promise : undefined);
  try {
    await openPreview(f); agree(f); assert.equal(f.$(".skill-install").disabled, false);
    f.$(".skill-preview-entry").click(); await settle(); assert.equal(f.$(".skill-consent").checked, false); assert.equal(f.$(".skill-install").disabled, true);
    await f.api.refresh(); f.$(".skill-read").click(); await settle();
    f.$(".skill-remove").click(); f.$(".skill-remove-accept").click(); await settle();
    reading.resolve({ skill, content: "Removed skill stale content", files: [] }); await settle();
    assert.equal(f.$(".skill-detail").hidden, true); assert.doesNotMatch(f.root.textContent, /Removed skill stale content/);
  } finally { await f.close(); }
});

test("successful installation and removal retain backend preservation warnings as safe visible text", async () => {
  const f = fixture(async (data) => {
    if (data.action === "install") return { skill, revision: 2, warnings: ["Modified scripts/task.sh preserved <script>bad()</script>"] };
    if (data.action === "remove") return { removed: true, warnings: ["Locally modified SKILL.md preserved"] };
  });
  try {
    await openPreview(f); agree(f); f.$(".skill-install").click(); await settle();
    assert.equal(f.$(".skill-operation-warnings").hidden, false); assert.match(f.$(".skill-operation-warnings").textContent, /Modified scripts\/task.sh preserved/);
    assert.equal(f.root.querySelector("script"), null);
    f.$(".skill-remove").click(); assert.match(f.$(".skill-remove-confirm").textContent, /modified files may be preserved/);
    f.$(".skill-remove-accept").click(); await settle();
    assert.match(f.$(".skill-operation-warnings").textContent, /Locally modified SKILL.md preserved/);
    f.language("zh"); assert.match(f.$(".skill-operation-warnings").textContent, /注意事项/);
  } finally { await f.close(); }
});

test("preload starts three storefronts in parallel without waiting for inventory and reopening uses cached home", async () => {
  const slow = deferred(), inventory = deferred();
  const f = fixture(async (data) => data.action === "list" ? inventory.promise : data.action === "browse" && data.source === "skillsmp" ? slow.promise : undefined);
  try {
    const loading = f.api.preload(); await settle();
    assert.deepEqual(f.calls.filter((call) => call.action === "browse").map((call) => call.source), ["skillstore", "skills-sh", "skillsmp"]);
    assert.equal(f.root.querySelectorAll(".skill-result").length, 2);
    assert.equal(f.$('.skill-source-panel[data-source="skillsmp"]').dataset.state, "loading");
    assert.equal(f.$('.skill-source-panel[data-source="skillstore"]').dataset.state, "connected");
    assert.equal(f.$(".skill-query").value, ""); assert.equal(f.calls.some((call) => call.action === "search"), false);
    slow.resolve({ entries: [{ ...entry, source: "skillsmp", author: "owner", repository: "owner/repo", stars: 42, installs: 1200 }], sources: [{ source: "skillsmp", ok: true }], page: 1, hasMore: false });
    inventory.resolve({ skills: [skill] }); await loading;
    assert.equal(f.root.querySelectorAll(".skill-result").length, 3); assert.match(f.$('.skill-source-panel[data-source="skillsmp"]').textContent, /Author: owner.*owner\/repo.*Stars: 42.*Installs: 1,200/s);
    const count = f.calls.length; await f.api.open(); await f.api.preload(); assert.equal(f.calls.length, count);
    f.$(".skill-refresh-store").click(); await settle();
    assert.equal(f.calls.filter((call) => call.action === "browse" && call.refresh === true).length, 3);
  } finally { await f.close(); }
});

test("blank submit and home browse cached real collections; restarting service retries failed sources", async () => {
  let reconnects = 0, connected = false;
  const f = fixture(async () => { if (!connected) throw Error("Skill service not connected"); }, undefined, async () => { reconnects++; connected = true; });
  try {
    await f.api.open(); assert.equal(f.$(".skill-retry-connection").hidden, false);
    assert.equal(f.calls.filter((call) => call.action === "browse").length, 3);
    f.$(".skill-retry-connection").click(); await settle();
    assert.equal(reconnects, 1); assert.equal(f.$(".skill-retry-connection").hidden, true);
    assert.equal(f.root.querySelectorAll(".skill-result").length, 3); assert.equal(f.calls.some((call) => call.action === "search"), false);
    await search(f); const searches = f.calls.filter((call) => call.action === "search").length;
    f.$(".skill-query").value = "  "; f.$(".skill-search").click(); await settle();
    assert.equal(f.calls.filter((call) => call.action === "search").length, searches); assert.match(f.$(".skill-view-title").textContent, /Home/);
    assert.equal(f.root.querySelectorAll(".skill-result").length, 3);
  } finally { await f.close(); }
});

test("a slow failed home source stays isolated and retries without refetching healthy sources", async () => {
  const slow = deferred(); let failed = true;
  const f = fixture(async (data) => data.action === "browse" && data.source === "skillsmp" && failed ? slow.promise : undefined);
  try {
    const loading = f.api.open(); await settle(); assert.equal(f.root.querySelectorAll(".skill-result").length, 2);
    slow.reject(new Error("Upstream timeout <script>bad()</script>")); await loading;
    assert.equal(f.$('.skill-source-panel[data-source="skillsmp"]').dataset.state, "error"); assert.equal(f.root.querySelectorAll(".skill-result").length, 2);
    assert.equal(f.root.querySelector("script"), null); assert.match(f.$(".skill-source-error").textContent, /Upstream timeout/);
    const count = f.calls.length; failed = false; f.$(".skill-source-retry").click(); await settle();
    assert.equal(f.calls.length, count + 1); assert.equal(f.calls.at(-1).source, "skillsmp"); assert.equal(f.calls.at(-1).refresh, true);
    assert.equal(f.root.querySelectorAll(".skill-result").length, 3);
  } finally { await f.close(); }
});

test("source UI deadline is 18 seconds and late source responses cannot overwrite its timeout", async (context) => {
  const slow = deferred();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(async (data) => data.action === "browse" && data.source === "skillsmp" ? slow.promise : undefined);
  try {
    const loading = f.api.open(); await settle();
    context.mock.timers.tick(17_999); await settle();
    assert.equal(f.$('.skill-source-panel[data-source="skillsmp"]').dataset.state, "loading");
    context.mock.timers.tick(1); await loading;
    assert.equal(f.$('.skill-source-panel[data-source="skillsmp"]').dataset.state, "error");
    assert.match(f.$(".skill-source-error").textContent, /18 seconds/); assert.equal(f.root.querySelectorAll(".skill-result").length, 2);
    slow.resolve({ entries: [{ ...entry, source: "skillsmp", name: "Too late" }], sources: [], page: 1, hasMore: false }); await settle();
    assert.doesNotMatch(f.$(".skill-search-results").textContent, /Too late/);
  } finally { context.mock.timers.reset(); await f.close(); }
});

test("disposing during home loading clears deadline waits and ignores late source content", async () => {
  const slow = deferred();
  const f = fixture(async (data) => data.action === "browse" ? slow.promise : undefined);
  try {
    const loading = f.api.preload(); await settle(); f.api.dispose(); await loading;
    slow.resolve({ entries: [{ ...entry, name: "Disposed content" }], sources: [], page: 1, hasMore: true }); await settle();
    assert.equal(f.root.children.length, 0); await f.api.open(); assert.equal(f.calls.filter((call) => call.action === "browse").length, 3);
  } finally { await f.close(); }
});

test("runtime failures are meaningful and retryable; failed previews never allow installation", async () => {
  let unavailable = true;
  const f = fixture(async (data) => {
    if (data.action === "list" && unavailable) throw new Error("RPC is not connected");
    if (data.action === "job") return { id: data.jobId, state: "failed", error: "Upstream unavailable" };
  });
  try {
    await f.api.refresh(); assert.match(f.$(".skill-library-status").textContent, /Skill service is not connected.*RPC is not connected/); assert.equal(f.$(".skill-retry-connection").hidden, false);
    unavailable = false; await f.api.refresh(); assert.equal(f.$(".skill-library-status").classList.contains("is-error"), false); assert.equal(f.$(".skill-retry-connection").hidden, true);
    await openPreview(f); assert.match(f.$(".skill-library-status").textContent, /Upstream unavailable/); assert.equal(f.$(".skill-install").disabled, true);
    assert.equal(f.calls.some((item) => item.action === "install"), false);
  } finally { await f.close(); }
});
