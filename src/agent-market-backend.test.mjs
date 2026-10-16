import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentLibrary } from "../src-tauri/src/gui-library.mjs";

const source = "https://github.com/example/agents/blob/main/reviewer.md";
const normalizedSource = "https://raw.githubusercontent.com/example/agents/main/reviewer.md";
const maxAgent = 256 * 1024;
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function fixture(fetcher = async () => assert.fail("Unexpected network request")) {
  const root = await mkdtemp(join(tmpdir(), "pi-market-backend-test-"));
  const directory = join(root, "library");
  const calls = [];
  const trackedFetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return fetcher(url, options);
  };
  const instance = () => createAgentLibrary({ directory, fetcher: trackedFetch });
  return { directory, filename: join(directory, "library.json"), calls, instance, library: instance(),
    close: () => rm(root, { recursive: true, force: true }) };
}

const previewBuiltin = (library, id = "code-reviewer") => library.run({ kind: "market", action: "preview", id });
const importRequest = (preview, overrides = {}) => ({ kind: "market", action: "import",
  ...(preview.id ? { id: preview.id } : { token: preview.token }), hash: preview.hash, accepted: true, ...overrides });
const missing = (path) => assert.rejects(stat(path), { code: "ENOENT" });

async function seed(f, agents = [], memories = []) {
  await mkdir(f.directory, { recursive: true });
  await writeFile(f.filename, JSON.stringify({ version: 1,
    settings: { memoryEnabled: true, autonomousDownloads: true }, agents, memories }));
}

test("market catalog and every built-in preview work offline without creating storage", async () => {
  const f = await fixture();
  try {
    const catalog = await f.library.run({ kind: "market", action: "list" });
    assert.ok(catalog.entries.length >= 8);
    assert.equal(new Set(catalog.entries.map((entry) => entry.id)).size, catalog.entries.length);
    assert.deepEqual(catalog.installed, []);
    assert.equal(catalog.activeAgent, "");
    for (const entry of catalog.entries) {
      assert.equal(entry.kind, "text-agent");
      assert.equal(entry.author, "easy_pi");
      assert.equal(entry.license, "CC0-1.0");
      assert.equal(entry.marketKey, `builtin:${entry.id}`);
      assert.equal(entry.source, `easy_pi://market/${entry.id}`);
      assert.equal(entry.installedId, "");
      assert.ok(entry.title && entry.description && entry.category && entry.version);
      assert.equal(Object.hasOwn(entry, "content"), false);
      assert.equal(Object.hasOwn(entry, "token"), false);
      const preview = await previewBuiltin(f.library, entry.id);
      assert.equal(preview.hash, sha256(preview.content));
      assert.match(preview.hash, /^[a-f0-9]{64}$/);
      assert.ok(preview.content.startsWith("# "));
      const { content, ...metadata } = preview;
      const { installedId, ...listed } = entry;
      assert.deepEqual(metadata, listed);
    }
    assert.equal((await f.library.run({ kind: "list" })).agents.length, 0);
    assert.equal((await f.library.run({ kind: "context" })).agent, null);
    assert.equal(f.calls.length, 0);
    await missing(f.directory);
  } finally { await f.close(); }
});

test("every market operation is user-only before networking or storage access", async () => {
  const f = await fixture();
  try {
    const preview = await previewBuiltin(f.library);
    const requests = [
      { kind: "market", action: "list" },
      { kind: "market", action: "preview", id: preview.id },
      { kind: "market", action: "preview", source },
      { kind: "market", action: "preview", installedId: randomUUID() },
      importRequest(preview),
      { kind: "market", action: "import", token: randomUUID(), hash: preview.hash, accepted: true },
      { kind: "market", action: "install", id: preview.id },
    ];
    for (const authority of ["model", "system", "USER", "", null]) {
      for (const request of requests) {
        await assert.rejects(f.library.run(request, authority), /只能由用户/, `${authority}: ${request.action}`);
      }
    }
    assert.equal(f.calls.length, 0);
    await missing(f.directory);
  } finally { await f.close(); }
});

test("unsupported market installs and non-catalog IDs cannot execute or import packages", async () => {
  const f = await fixture();
  try {
    const preview = await previewBuiltin(f.library);
    for (const action of ["install", "activate", "enable", "execute", "download", "save", "remove", "update", "", undefined]) {
      await assert.rejects(f.library.run({ ...importRequest(preview), action }), /仅支持/);
    }
    for (const id of ["missing", "../code-reviewer", "dsh:plugin", "npm:package", source, {}, 1]) {
      await assert.rejects(previewBuiltin(f.library, id), /兼容|请选择/);
      await assert.rejects(f.library.run(importRequest({ ...preview, id })), /兼容|请选择/);
    }
    assert.equal(f.calls.length, 0);
    await missing(f.filename);
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.close(); }
});

test("both built-in and remote imports require literal accepted:true", async () => {
  const f = await fixture(async () => new Response("# Remote reviewer"));
  try {
    const previews = [await previewBuiltin(f.library),
      await f.library.run({ kind: "market", action: "preview", source })];
    for (const preview of previews) {
      const withoutConsent = importRequest(preview);
      delete withoutConsent.accepted;
      await assert.rejects(f.library.run(withoutConsent), /确认导入/);
      for (const accepted of [false, null, "true", 1, {}, []]) {
        await assert.rejects(f.library.run(importRequest(preview, { accepted })), /确认导入/);
      }
    }
    await missing(f.filename);
    for (const preview of previews) {
      assert.equal((await f.library.run(importRequest(preview))).alreadyImported, false);
    }
    assert.equal((await f.library.run({ kind: "list" })).agents.length, 2);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("imports bind the exact hash and a remote token to its preview and library instance", async () => {
  const f = await fixture(async (url) => new Response(`# ${new URL(url).pathname}`));
  try {
    const builtin = await previewBuiltin(f.library);
    const remote = await f.library.run({ kind: "market", action: "preview", source });
    const other = await f.library.run({ kind: "market", action: "preview",
      source: "https://raw.githubusercontent.com/example/agents/main/other.txt" });
    assert.match(remote.token, uuid);
    assert.match(other.token, uuid);
    assert.notEqual(remote.token, other.token);
    for (const preview of [builtin, remote]) {
      for (const hash of [undefined, null, "", "0".repeat(64), preview.hash.toUpperCase(), 123]) {
        await assert.rejects(f.library.run(importRequest(preview, { hash })), /校验不一致/);
      }
    }
    await assert.rejects(f.library.run(importRequest(remote, { token: other.token })), /校验不一致/);
    for (const token of [undefined, null, "", randomUUID()]) {
      await assert.rejects(f.library.run(importRequest(remote, { token })), /预览已过期/);
    }
    await assert.rejects(f.instance().run(importRequest(remote)), /预览已过期/);
    await missing(f.filename);
    assert.equal((await f.library.run(importRequest(remote))).alreadyImported, false);
    assert.equal((await f.library.run(importRequest(builtin))).alreadyImported, false);
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test("built-in import persists only catalog text and metadata, without implicitly activating it", async () => {
  const f = await fixture();
  try {
    const preview = await previewBuiltin(f.library);
    const expected = { ...preview };
    preview.content = "Client-edited text must not replace the catalog definition";
    preview.title = "Client-edited title";
    const result = await f.library.run(importRequest(expected, { content: preview.content,
      title: preview.title, source: "https://evil.test/plugin.js", activeAgent: "self" }));
    assert.match(result.id, uuid);
    assert.equal(result.alreadyImported, false);
    const item = await f.instance().run({ kind: "agent", action: "read", id: result.id });
    for (const key of ["title", "content", "source", "marketKey"]) assert.equal(item[key], expected[key]);
    assert.equal(item.untrusted, true);
    assert.equal(item.importedHash, sha256(expected.content));
    assert.equal(item.marketVersion, expected.version);
    assert.ok(Number.isFinite(item.updatedAt));
    assert.deepEqual(await previewBuiltin(f.library), expected);
    const catalog = await f.library.run({ kind: "market", action: "list" });
    assert.equal(catalog.entries.find((entry) => entry.id === expected.id).installedId, result.id);
    assert.deepEqual(catalog.installed, [{ id: result.id, marketKey: expected.marketKey,
      title: expected.title, source: expected.source, hash: expected.hash }]);
    assert.equal(catalog.activeAgent, "");
    assert.equal((await f.library.run({ kind: "context" })).agent, null);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("all previews are read-only and neither preview nor import replaces an active local Agent", async () => {
  const f = await fixture(async () => new Response("# Remote reference"));
  try {
    const local = await f.library.run({ kind: "agent", action: "save", title: "Local", content: "# Keep me active" });
    await f.library.run({ kind: "settings", activeAgent: local.id });
    const before = await readFile(f.filename);
    const builtin = await previewBuiltin(f.library);
    const remote = await f.library.run({ kind: "market", action: "preview", source });
    await f.library.run({ kind: "market", action: "list" });
    assert.deepEqual(await readFile(f.filename), before);
    assert.equal((await f.library.run({ kind: "list" })).agents.length, 1);
    assert.equal((await f.library.run({ kind: "context" })).agent.id, local.id);
    await f.library.run(importRequest(builtin));
    const imported = await f.library.run(importRequest(remote));
    const afterImport = await readFile(f.filename);
    const installedPreview = await f.library.run({ kind: "market", action: "preview", installedId: imported.id });
    assert.equal(installedPreview.content, remote.content);
    assert.deepEqual(await readFile(f.filename), afterImport);
    assert.equal((await f.library.run({ kind: "list" })).agents.length, 3);
    assert.equal((await f.library.run({ kind: "context" })).agent.id, local.id);
    assert.equal((await f.library.run({ kind: "market", action: "list" })).activeAgent, local.id);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(await readdir(f.directory), ["library.json"]);
  } finally { await f.close(); }
});

test("activation requires explicit user settings, persists full context, and can be cleared", async () => {
  const f = await fixture();
  try {
    const preview = await previewBuiltin(f.library);
    const imported = await f.library.run(importRequest(preview));
    const before = await readFile(f.filename);
    await assert.rejects(f.library.run({ kind: "settings", activeAgent: imported.id }, "model"), /只能由用户/);
    await assert.rejects(f.library.run({ kind: "settings", activeAgent: randomUUID() }), /不存在/);
    await assert.rejects(f.library.run({ kind: "market", action: "activate", installedId: imported.id }), /仅支持/);
    assert.deepEqual(await readFile(f.filename), before);
    await f.library.run({ kind: "settings", activeAgent: imported.id });
    const restarted = f.instance();
    assert.ok(preview.content.length > 160);
    assert.deepEqual((await restarted.run({ kind: "context" }, "model")).agent,
      { id: imported.id, title: preview.title, content: preview.content, untrusted: true });
    assert.equal((await restarted.run({ kind: "market", action: "list" })).activeAgent, imported.id);
    await restarted.run({ kind: "settings", activeAgent: "" });
    assert.equal((await f.library.run({ kind: "context" })).agent, null);
    await restarted.run({ kind: "settings", activeAgent: imported.id });
    await restarted.run({ kind: "agent", action: "remove", id: imported.id });
    assert.equal((await f.library.run({ kind: "context" })).agent, null);
    const catalog = await f.library.run({ kind: "market", action: "list" });
    assert.equal(catalog.activeAgent, "");
    assert.deepEqual(catalog.installed, []);
    assert.equal(catalog.entries.find((entry) => entry.id === preview.id).installedId, "");
  } finally { await f.close(); }
});

test("concurrent duplicate imports across instances preserve user edits without rewriting storage", async () => {
  const f = await fixture();
  try {
    const other = f.instance();
    const preview = await previewBuiltin(f.library);
    const imports = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      (index % 2 ? other : f.library).run(importRequest(preview))));
    assert.equal(imports.filter((item) => !item.alreadyImported).length, 1);
    assert.equal(new Set(imports.map((item) => item.id)).size, 1);
    assert.equal((await f.library.run({ kind: "list" })).agents.length, 1);
    const id = imports[0].id;
    const edited = await other.run({ kind: "agent", action: "save", id, title: "My reviewer", content: "# User edits\nNever overwrite this." });
    await other.run({ kind: "settings", activeAgent: id });
    const before = await readFile(f.filename);
    const repeated = await Promise.all([f.library, other, f.instance(), f.library].map((library) => library.run(importRequest(preview))));
    for (const item of repeated) assert.deepEqual(item, { id, alreadyImported: true });
    assert.deepEqual(await readFile(f.filename), before);
    assert.deepEqual(await f.library.run({ kind: "agent", action: "read", id }), edited);
    const catalog = await other.run({ kind: "market", action: "list" });
    assert.equal(catalog.activeAgent, id);
    assert.equal(catalog.installed[0].hash, sha256(edited.content));
    assert.notEqual(catalog.installed[0].hash, preview.hash);
    assert.deepEqual(await readdir(f.directory), ["library.json"]);
  } finally { await f.close(); }
});

test("concurrent imports of different catalog Agents do not lose records", async () => {
  const f = await fixture();
  try {
    const libraries = [f.library, f.instance(), f.instance()];
    const previews = await Promise.all(["code-reviewer", "test-engineer", "bug-investigator"].map((id, index) => previewBuiltin(libraries[index], id)));
    const results = await Promise.all(previews.map((preview, index) => libraries[index].run(importRequest(preview))));
    assert.ok(results.every((result) => result.alreadyImported === false));
    const list = await f.library.run({ kind: "market", action: "list" });
    assert.equal(list.installed.length, 3);
    assert.deepEqual(new Set(list.installed.map((entry) => entry.marketKey)), new Set(previews.map((entry) => entry.marketKey)));
    assert.equal(new Set(list.installed.map((entry) => entry.id)).size, 3);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("remote import uses the exact UTF-8 preview snapshot and hash without refetching", async () => {
  const content = "# Remote reviewer\r\n\r\n中文 / café / é / 𝒙\r\nKeep  double spaces.\r\nEnd.";
  const bytes = Buffer.from(content);
  const split = Buffer.byteLength(content.slice(0, content.indexOf("中文"))) + 1;
  let upstream = bytes;
  const f = await fixture(async () => {
    assert.equal(f.calls.length, 1, "import must not fetch the changed upstream definition");
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(upstream.subarray(0, split));
      controller.enqueue(upstream.subarray(split));
      controller.close();
    } }));
  });
  try {
    const preview = await f.library.run({ kind: "market", action: "preview", source, title: "Remote reviewer" });
    assert.equal(preview.content, content);
    assert.equal(preview.hash, sha256(bytes));
    assert.equal(preview.source, normalizedSource);
    assert.equal(preview.marketKey, `github:${normalizedSource}`);
    assert.equal(preview.id, "");
    assert.equal(preview.kind, "text-agent");
    assert.equal(preview.license, "See source");
    assert.match(preview.token, uuid);
    assert.equal(f.calls[0].url, normalizedSource);
    assert.equal(f.calls[0].options.redirect, "error");
    assert.equal(f.calls[0].options.headers.Accept, "text/plain");
    assert.equal(f.calls[0].options.headers["User-Agent"], "Pi-GUI-Agent-Library");
    assert.ok(f.calls[0].options.signal instanceof AbortSignal);
    await missing(f.directory);
    const request = importRequest(preview);
    upstream = Buffer.from("# Changed after preview");
    preview.content = "Forged client text";
    preview.title = "Forged title";
    preview.source = "https://evil.test/not-a-definition.js";
    preview.hash = sha256(preview.content);
    const result = await f.library.run({ ...request, content: preview.content, title: preview.title, source: preview.source });
    const item = await f.instance().run({ kind: "agent", action: "read", id: result.id });
    assert.deepEqual(Buffer.from(item.content), bytes);
    assert.equal(item.importedHash, sha256(bytes));
    assert.equal(item.title, "Remote reviewer");
    assert.equal(item.source, normalizedSource);
    assert.equal(item.marketKey, `github:${normalizedSource}`);
    assert.equal(item.marketVersion, "");
    assert.equal(item.untrusted, true);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.library.run({ kind: "context" })).agent, null);
  } finally { await f.close(); }
});

test("concurrent remote imports share a canonical key and never overwrite edited local text", async () => {
  let revision = 0;
  const f = await fixture(async () => new Response(`# Remote revision ${++revision}`));
  try {
    const other = f.instance();
    const previews = await Promise.all([f.library.run({ kind: "market", action: "preview", source }),
      other.run({ kind: "market", action: "preview", source: normalizedSource })]);
    assert.equal(previews[0].marketKey, previews[1].marketKey);
    const results = await Promise.all([f.library.run(importRequest(previews[0])), other.run(importRequest(previews[1]))]);
    assert.equal(results.filter((item) => !item.alreadyImported).length, 1);
    assert.equal(results[0].id, results[1].id);
    const winner = results.findIndex((item) => !item.alreadyImported);
    const id = results[0].id;
    assert.equal((await other.run({ kind: "agent", action: "read", id })).content, previews[winner].content);
    const edited = await other.run({ kind: "agent", action: "save", id, title: "Edited remote", content: "# Keep local changes" });
    const before = await readFile(f.filename);
    const newPreview = await f.library.run({ kind: "market", action: "preview", source: normalizedSource });
    assert.notEqual(newPreview.content, edited.content);
    assert.deepEqual(await f.library.run(importRequest(newPreview)), { id, alreadyImported: true });
    assert.deepEqual(await readFile(f.filename), before);
    assert.deepEqual(await other.run({ kind: "agent", action: "read", id }), edited);
    assert.equal((await other.run({ kind: "market", action: "list" })).installed.length, 1);
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});

test("installed external cards and local previews survive restart and need no network", async () => {
  const f = await fixture(async () => new Response("# External original"));
  try {
    const remote = await f.library.run({ kind: "market", action: "preview", source });
    const imported = await f.library.run(importRequest(remote));
    assert.equal(remote.title, "reviewer");
    const edited = await f.library.run({ kind: "agent", action: "save", id: imported.id, title: "Local external title", content: "# Local external edits" });
    const restarted = f.instance();
    const before = await readFile(f.filename);
    const catalog = await restarted.run({ kind: "market", action: "list" });
    const card = catalog.entries.find((entry) => entry.installedId === imported.id);
    assert.equal(card.id, "");
    assert.equal(card.category, "external");
    assert.equal(card.title, edited.title);
    assert.equal(card.source, normalizedSource);
    assert.equal(card.marketKey, remote.marketKey);
    assert.equal(card.kind, "text-agent");
    assert.equal(card.author, "GitHub source");
    assert.equal(card.license, "See source");
    assert.equal(card.hash, sha256(edited.content));
    assert.equal(Object.hasOwn(card, "content"), false);
    const preview = await restarted.run({ kind: "market", action: "preview", installedId: imported.id });
    assert.equal(preview.id, "");
    assert.equal(preview.installedId, imported.id);
    assert.equal(preview.content, edited.content);
    assert.equal(preview.hash, card.hash);
    assert.equal(Object.hasOwn(preview, "token"), false);
    await assert.rejects(restarted.run({ kind: "market", action: "preview", installedId: randomUUID() }), /不存在/);
    assert.deepEqual(await readFile(f.filename), before);
    assert.equal(f.calls.length, 1);
    await restarted.run({ kind: "agent", action: "remove", id: imported.id });
    await assert.rejects(restarted.run({ kind: "market", action: "preview", installedId: imported.id }), /不存在/);
    assert.equal((await restarted.run({ kind: "market", action: "list" })).entries.some((entry) => entry.category === "external"), false);
  } finally { await f.close(); }
});

test("the ninth remote preview evicts only the oldest of eight tokens", async () => {
  const f = await fixture(async (url) => new Response(`# ${new URL(url).pathname}`));
  try {
    const previews = [];
    for (let index = 0; index < 9; index++) {
      previews.push(await f.library.run({ kind: "market", action: "preview",
        source: `https://raw.githubusercontent.com/example/agents/main/agent-${index}.md` }));
    }
    assert.equal(new Set(previews.map((entry) => entry.token)).size, 9);
    await missing(f.directory);
    await assert.rejects(f.library.run(importRequest(previews[0])), /预览已过期/);
    await missing(f.filename);
    for (const preview of previews.slice(1)) {
      assert.equal((await f.library.run(importRequest(preview))).alreadyImported, false);
    }
    assert.equal((await f.library.run({ kind: "market", action: "list" })).installed.length, 8);
    assert.equal(f.calls.length, 9);
  } finally { await f.close(); }
});

test("remote preview tokens expire after fifteen minutes and a new preview recovers", async () => {
  const f = await fixture(async () => new Response("# Timed preview"));
  const originalNow = Date.now;
  let now = originalNow();
  try {
    Date.now = () => now;
    const live = await f.library.run({ kind: "market", action: "preview", source });
    const expiring = await f.library.run({ kind: "market", action: "preview",
      source: "https://raw.githubusercontent.com/example/agents/main/expiring.md" });
    now += 15 * 60 * 1000 - 1;
    assert.equal((await f.library.run(importRequest(live))).alreadyImported, false);
    const before = await readFile(f.filename);
    now += 2;
    await assert.rejects(f.library.run(importRequest(expiring)), /预览已过期/);
    assert.deepEqual(await readFile(f.filename), before);
    const renewed = await f.library.run({ kind: "market", action: "preview", source: expiring.source });
    assert.notEqual(renewed.token, expiring.token);
    await assert.rejects(f.library.run(importRequest(expiring)), /预览已过期/);
    assert.equal((await f.library.run(importRequest(renewed))).alreadyImported, false);
    assert.equal((await f.library.run({ kind: "list" })).agents.length, 2);
    assert.equal(f.calls.length, 3);
  } finally { Date.now = originalNow; await f.close(); }
});

test("cancelled built-in and remote imports do not write and do not consume the preview", async () => {
  const f = await fixture(async () => new Response("# Cancel import"));
  try {
    const previews = [await previewBuiltin(f.library), await f.library.run({ kind: "market", action: "preview", source })];
    for (const preview of previews) {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(f.library.run(importRequest(preview), "user", controller.signal), /已取消/);
    }
    await missing(f.filename);
    assert.equal((await f.library.run({ kind: "context" })).agent, null);
    for (const preview of previews) assert.equal((await f.library.run(importRequest(preview))).alreadyImported, false);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("a queued import observes cancellation before it begins", async () => {
  const f = await fixture();
  try {
    const preview = await previewBuiltin(f.library);
    const controller = new AbortController();
    const listing = f.library.run({ kind: "market", action: "list" });
    const importing = assert.rejects(f.library.run(importRequest(preview), "user", controller.signal), /已取消/);
    controller.abort();
    await Promise.all([listing, importing]);
    await missing(f.filename);
    assert.equal((await f.library.run({ kind: "list" })).agents.length, 0);
  } finally { await f.close(); }
});

test("remote preview forwards abort signals and in-flight cancellation leaves no import", async () => {
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  let cancelCount = 0;
  const f = await fixture(async (_url, { signal }) => {
    signal.throwIfAborted();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelCount++; reject(signal.reason); }, { once: true });
      start(signal);
    });
  });
  const controller = new AbortController();
  try {
    const result = assert.rejects(f.library.run({ kind: "market", action: "preview", source }, "user", controller.signal), { name: "AbortError" });
    const forwarded = await started;
    assert.ok(forwarded instanceof AbortSignal);
    assert.equal(forwarded.aborted, false);
    controller.abort();
    await result;
    assert.equal(forwarded.aborted, true);
    assert.equal(cancelCount, 1);
    await missing(f.directory);
    assert.equal((await f.library.run({ kind: "market", action: "list" })).installed.length, 0);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(f.library.run({ kind: "market", action: "preview", source }, "user", alreadyAborted.signal), { name: "AbortError" });
    assert.equal(f.calls.length, 2);
    await missing(f.directory);
  } finally { controller.abort(); await f.close(); }
});

test("invalid, executable, local, credentialed and ambiguous remote URLs fail before fetch", async () => {
  const f = await fixture();
  try {
    const invalid = [undefined, null, 1, {}, "", "not a URL",
      "http://github.com/example/agents/blob/main/a.md", "file:///tmp/a.md", "data:text/plain,agent",
      "https://localhost/a.md", "https://127.0.0.1/a.md", "https://[::1]/a.md", "https://example.com/a.md",
      "https://raw.githubusercontent.com.evil.test/example/agents/main/a.md",
      "https://user:secret@github.com/example/agents/blob/main/a.md",
      "https://raw.githubusercontent.com:444/example/agents/main/a.md",
      `${source}?token=secret`, `${source}#fragment`, "https://github.com/example/agents",
      "https://github.com/example/agents/tree/main", "https://github.com/example/agents/blob/main/plugin.js",
      "https://github.com/example/agents/blob/main/package.json", "https://github.com/example/agents/blob/main/agent.ts",
      "https://raw.githubusercontent.com/example/agents/main/a%5Cb.md",
      "https://raw.githubusercontent.com/example/agents/main/a%00b.md",
      "https://raw.githubusercontent.com/example/agents/main/a%ZZ.md",
    ];
    for (const url of invalid) {
      await assert.rejects(f.library.run({ kind: "market", action: "preview", source: url }), `source: ${String(url)}`);
    }
    assert.equal(f.calls.length, 0);
    await missing(f.directory);
  } finally { await f.close(); }
});

test("GitHub raw and text URLs preview as text-only definitions", async () => {
  const f = await fixture(async () => new Response("# Valid text"));
  try {
    const raw = await f.library.run({ kind: "market", action: "preview",
      source: "https://github.com/example/agents/raw/main/reviewer.md" });
    assert.equal(raw.source, normalizedSource);
    const text = await f.library.run({ kind: "market", action: "preview",
      source: "https://raw.githubusercontent.com/example/agents/main/Reviewer.TXT" });
    assert.equal(text.title, "Reviewer");
    assert.equal(text.kind, "text-agent");
    assert.equal(f.calls.length, 2);
    await missing(f.directory);
  } finally { await f.close(); }
});

test("remote HTML, blank, control-byte and invalid UTF-8 responses cannot create previews", async () => {
  let body;
  const f = await fixture(async () => new Response(body));
  try {
    const invalid = ["<!doctype html><html>not an Agent</html>", "  <HTML>not text</HTML>",
      "<script>alert(1)</script>", "", " \r\n\t", "# Bad\0text", "# Bad\x07text",
      new Uint8Array([0xc3, 0x28]), new Uint8Array([0xf0, 0x9f])];
    for (body of invalid) {
      await assert.rejects(f.library.run({ kind: "market", action: "preview", source }));
    }
    assert.equal(f.calls.length, invalid.length);
    await missing(f.directory);
    assert.deepEqual((await f.library.run({ kind: "market", action: "list" })).installed, []);
  } finally { await f.close(); }
});

test("HTTP errors, missing bodies, rejected redirects and interrupted streams do not save", async () => {
  let fetcher;
  const f = await fixture((...args) => fetcher(...args));
  try {
    for (const status of [301, 403, 404, 500]) {
      fetcher = async () => new Response("not an Agent", { status });
      await assert.rejects(f.library.run({ kind: "market", action: "preview", source }), new RegExp(`HTTP ${status}`));
    }
    fetcher = async () => new Response(null);
    await assert.rejects(f.library.run({ kind: "market", action: "preview", source }), /HTTP 200/);
    fetcher = async () => { throw new TypeError("redirect rejected"); };
    await assert.rejects(f.library.run({ kind: "market", action: "preview", source }), /redirect rejected/);
    fetcher = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("stream interrupted")); } }));
    await assert.rejects(f.library.run({ kind: "market", action: "preview", source }), /stream interrupted/);
    assert.ok(f.calls.every(({ options }) => options.redirect === "error"));
    await missing(f.directory);
  } finally { await f.close(); }
});

test("oversize Content-Length and streamed bytes are rejected and their bodies cancelled", async () => {
  let fetcher;
  const f = await fixture((...args) => fetcher(...args));
  try {
    let cancelled = 0;
    fetcher = async () => new Response(new ReadableStream({ cancel() { cancelled++; } }),
      { headers: { "content-length": String(maxAgent + 1) } });
    await assert.rejects(f.library.run({ kind: "market", action: "preview", source }), /256 KB/);
    assert.equal(cancelled, 1);
    fetcher = async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.alloc(maxAgent, 97));
      controller.enqueue(Buffer.from("x"));
    }, cancel() { cancelled++; } }), { headers: { "content-length": "1" } });
    await assert.rejects(f.library.run({ kind: "market", action: "preview", source }), /256 KB/);
    assert.equal(cancelled, 2);
    fetcher = async () => new Response("界".repeat(Math.floor(maxAgent / 3) + 1));
    await assert.rejects(f.library.run({ kind: "market", action: "preview", source }), /256 KB/);
    assert.equal(f.calls.length, 3);
    await missing(f.directory);
  } finally { await f.close(); }
});

test("a text definition exactly at the byte limit can be previewed and imported", async () => {
  const content = `# ${"a".repeat(maxAgent - 2)}`;
  const f = await fixture(async () => new Response(content, { headers: { "content-length": String(maxAgent) } }));
  try {
    const preview = await f.library.run({ kind: "market", action: "preview", source });
    assert.equal(Buffer.byteLength(preview.content), maxAgent);
    assert.equal(preview.hash, sha256(content));
    const imported = await f.library.run(importRequest(preview));
    assert.equal((await f.library.run({ kind: "agent", action: "read", id: imported.id })).content, content);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("corrupt or invalid stores are never overwritten by market reads or imports", async () => {
  const f = await fixture();
  try {
    await seed(f);
    const preview = await previewBuiltin(f.library);
    const corrupt = ["{broken JSON\n", "null", JSON.stringify({ version: 2, settings: {}, agents: [], memories: [] }),
      JSON.stringify({ version: 1, settings: { memoryEnabled: true, autonomousDownloads: true }, agents: {}, memories: [] })];
    for (const bytes of corrupt) {
      await writeFile(f.filename, bytes);
      await assert.rejects(f.library.run({ kind: "market", action: "list" }));
      assert.deepEqual(await previewBuiltin(f.library), preview);
      await assert.rejects(f.library.run(importRequest(preview)));
      assert.equal(await readFile(f.filename, "utf8"), bytes);
      assert.deepEqual(await readdir(f.directory), ["library.json"]);
    }
    await seed(f);
    assert.equal((await f.library.run(importRequest(preview))).alreadyImported, false);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("market imports preserve damaged records while leaving valid records usable", async () => {
  const f = await fixture();
  try {
    const damagedAgent = { id: "not-a-uuid", title: "Broken agent", content: "Do not discard", updatedAt: 1 };
    const damagedMemory = { id: randomUUID(), title: "", content: "Keep damaged memory", updatedAt: 1 };
    await seed(f, [damagedAgent], [damagedMemory]);
    assert.deepEqual((await f.library.run({ kind: "market", action: "list" })).installed, []);
    const preview = await previewBuiltin(f.library);
    const imported = await f.library.run(importRequest(preview));
    const stored = JSON.parse(await readFile(f.filename, "utf8"));
    assert.deepEqual(stored.agents.find((item) => item.id === damagedAgent.id), damagedAgent);
    assert.deepEqual(stored.memories, [damagedMemory]);
    assert.equal(stored.agents.length, 2);
    const list = await f.library.run({ kind: "list" });
    assert.equal(list.skipped, 2);
    assert.deepEqual(list.agents.map((item) => item.id), [imported.id]);
    assert.equal((await f.library.run({ kind: "agent", action: "read", id: imported.id })).content, preview.content);
  } finally { await f.close(); }
});

for (const [label, marketKey] of [["numeric", 123], ["object", { source: "github:bad" }]]) {
  for (const action of ["list", "preview"]) {
    test(`malformed ${label} marketKey does not break market ${action}`, async () => {
        const f = await fixture();
        try {
          const malformed = { id: randomUUID(), title: "Otherwise valid local Agent",
            content: "# Preserve this local text", updatedAt: 1, marketKey };
          const external = { id: randomUUID(), title: "Valid external Agent", content: "# Valid external text",
            source: normalizedSource, marketKey: `github:${normalizedSource}`, updatedAt: 2 };
          await seed(f, [malformed, external]);
          const before = await readFile(f.filename);
          try {
            assert.equal((await f.library.run({ kind: "list" })).agents.length, 2);
            if (action === "list") {
              const catalog = await f.library.run({ kind: "market", action: "list" });
              assert.deepEqual(catalog.installed.map((item) => item.id), [external.id]);
              assert.ok(catalog.entries.some((entry) => entry.installedId === external.id));
              assert.ok(catalog.entries.some((entry) => entry.id === "code-reviewer"));
            } else {
              const preview = await f.library.run({ kind: "market", action: "preview", installedId: external.id });
              assert.equal(preview.content, external.content);
              await assert.rejects(f.library.run({ kind: "market", action: "preview", installedId: malformed.id }), /不存在/);
            }
          } finally {
            assert.deepEqual(await readFile(f.filename), before);
            assert.equal(f.calls.length, 0);
          }
        } finally { await f.close(); }
      });
  }
}

test("the forty-Agent cap permits the fortieth import but not the forty-first or concurrent overflow", async () => {
  const f = await fixture();
  try {
    const locals = Array.from({ length: 39 }, (_, index) => ({ id: randomUUID(), title: `Local ${index}`, content: `# Local ${index}`, updatedAt: index + 1 }));
    await seed(f, locals);
    const preview = await previewBuiltin(f.library);
    const otherPreview = await previewBuiltin(f.library, "test-engineer");
    const other = f.instance();
    const attempts = await Promise.allSettled([f.library.run(importRequest(preview)), other.run(importRequest(otherPreview))]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    const failed = attempts.find((result) => result.status === "rejected");
    assert.match(failed.reason.message, /40/);
    const winner = attempts.findIndex((result) => result.status === "fulfilled");
    const imported = attempts[winner].value;
    const previews = [preview, otherPreview];
    assert.equal((await f.library.run({ kind: "list" })).agents.length, 40);
    const before = await readFile(f.filename);
    await assert.rejects(f.library.run(importRequest(previews[1 - winner])), /40/);
    assert.deepEqual(await f.library.run(importRequest(previews[winner])), { id: imported.id, alreadyImported: true });
    assert.deepEqual(await readFile(f.filename), before);
    await other.run({ kind: "agent", action: "remove", id: locals[0].id });
    assert.equal((await f.library.run(importRequest(previews[1 - winner]))).alreadyImported, false);
    assert.equal((await f.library.run({ kind: "list" })).agents.length, 40);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("damaged preserved Agents still count toward the forty-Agent import cap", async () => {
  const f = await fixture();
  try {
    const agents = Array.from({ length: 39 }, (_, index) => ({ id: randomUUID(), title: `Local ${index}`, content: "# Existing", updatedAt: 1 }));
    agents.push({ id: "damaged", title: "", content: "Preserve me", updatedAt: 1 });
    await seed(f, agents);
    const before = await readFile(f.filename);
    const preview = await previewBuiltin(f.library);
    assert.equal((await f.library.run({ kind: "list" })).skipped, 1);
    await assert.rejects(f.library.run(importRequest(preview)), /40/);
    assert.deepEqual(await readFile(f.filename), before);
    assert.deepEqual((await f.library.run({ kind: "market", action: "list" })).installed, []);
  } finally { await f.close(); }
});
