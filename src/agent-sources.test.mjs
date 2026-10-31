import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSources } from "../src-tauri/src/agent-sources.mjs";
import { createAgentLibrary } from "../src-tauri/src/gui-library.mjs";
import { createStoreLibrary } from "../src-tauri/src/skill-service.mjs";

const content = "---\nname: reviewer\n---\n# Complete remote Agent\nUse evidence.\n";
const bytes = Buffer.from(content);
const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const commit = "a".repeat(40), treeSha = "b".repeat(40);
function fixture(changes = {}) {
  const calls = [];
  const paths = Array.from({ length: 24 }, (_, index) => `engineering/engineering-reviewer-${String(index).padStart(2, "0")}.md`);
  const tree = paths.map(path => ({ path, type: "blob", mode: "100644", sha: blob, size: bytes.length }));
  tree.push({ path: "README.md", type: "blob", mode: "100644", sha: blob, size: 1 },
    { path: "engineering/README.md", type: "blob", mode: "100644", sha: blob, size: 1 },
    { path: "engineering/link.md", type: "blob", mode: "120000", sha: blob, size: 1 },
    { path: "engineering/install.sh", type: "blob", mode: "100755", sha: blob, size: 1 });
  const fetcher = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    if (changes.response) return changes.response(url);
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/commits/main")) return Response.json({ sha: commit, commit: { tree: { sha: treeSha } } });
    if (pathname.includes("/git/trees/")) return Response.json({ truncated: changes.truncated || false, tree: changes.tree || tree });
    if (pathname.includes("/git/blobs/")) return Response.json({ encoding: "base64", size: bytes.length, content: (changes.corrupt ? Buffer.from("wrong") : bytes).toString("base64") });
    return Response.json({ private: false, default_branch: "main", license: { spdx_id: "MIT" } });
  };
  return { calls, paths, fetcher, sources: createAgentSources({ fetcher }) };
}

test("online catalogs paginate and search real text paths, cache metadata and pin commits", async () => {
  const f = fixture();
  const first = await f.sources.browse();
  assert.equal(first.entries.length, 20); assert.equal(first.total, 24); assert.equal(first.hasMore, true);
  assert.equal(f.calls.length, 3);
  assert.equal(first.entries[0].source, `https://raw.githubusercontent.com/msitarzewski/agency-agents/${commit}/${f.paths[0]}`);
  assert.equal(first.entries[0].license, "MIT");
  const second = await f.sources.browse({ page: 2 });
  assert.equal(second.entries.length, 4); assert.equal(second.hasMore, false);
  assert.equal(f.calls.length, 3);
  assert.equal((await f.sources.browse({ query: "reviewer 03" })).entries.length, 1);
  assert.equal((await f.sources.browse({ category: "writing" })).entries.length, 0);
  await f.sources.browse({ refresh: true }); assert.equal(f.calls.length, 6);
});

test("VoltAgent only exposes concrete category definitions", async () => {
  const f = fixture({ tree: [
    { path: "categories/01-core-development/api-designer.md", type: "blob", mode: "100644", sha: blob, size: bytes.length },
    { path: "categories/01-core-development/README.md", type: "blob", mode: "100644", sha: blob, size: bytes.length },
  ] });
  const result = await f.sources.browse({ provider: "voltagent" });
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].category, "engineering");
  assert.equal(result.entries[0].title, "api designer"); assert.equal(result.entries[0].author, "VoltAgent");
});

test("unsafe providers, paths, incomplete trees, HTTP failures and oversized streams are rejected", async () => {
  const f = fixture();
  await assert.rejects(f.sources.browse({ provider: "https://localhost" }), /未知/);
  await assert.rejects(f.sources.browse({ provider: "constructor" }), /未知/);
  await assert.rejects(f.sources.entry("agency", "../README.md"), /无效/);
  await assert.rejects(f.sources.browse({ page: 0 }), /无效/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(fixture({ truncated: true }).sources.browse(), /不完整/);
  await assert.rejects(fixture({ response: () => new Response("", { status: 429 }) }).sources.browse(), /受限/);
  await assert.rejects(fixture({ response: () => new Response("x".repeat(4 * 1024 * 1024 + 1)) }).sources.browse(), /大小限制/);
});

test("online preview uses server-selected pinned blob, verifies bytes and imports once without activation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-online-agent-")), f = fixture();
  const library = createAgentLibrary({ directory, fetcher: f.fetcher });
  try {
    const { entries } = await library.run({ kind: "market", action: "browse" });
    const entry = entries[0];
    const preview = await library.run({ kind: "market", action: "preview", catalogSource: "agency", path: entry.path,
      source: "https://localhost/private", content: "forged", title: "forged" });
    assert.equal(preview.source, entry.source); assert.equal(preview.title, entry.title);
    assert.equal(preview.content, content.trim()); assert.equal(preview.version, commit);
    assert.equal((await library.run({ kind: "list" })).agents.length, 0);
    const request = { kind: "market", action: "import", token: preview.token, hash: preview.hash, accepted: true };
    const saved = await library.run(request);
    assert.equal((await library.run(request)).id, saved.id);
    assert.equal((await library.run({ kind: "context" })).agent, null);
    const stored = await library.run({ kind: "agent", action: "read", id: saved.id });
    assert.equal(stored.content, content.trim());
    assert.equal(stored.marketAuthor, entry.author); assert.equal(stored.marketLicense, entry.license);
    const restarted = createAgentLibrary({ directory, fetcher: f.fetcher });
    const local = await restarted.run({ kind: "market", action: "preview", installedId: saved.id });
    assert.equal(local.author, entry.author); assert.equal(local.license, entry.license); assert.equal(local.version, commit);
    restarted.dispose();
    assert.equal(f.calls.some(url => !url.startsWith("https://api.github.com/repos/")), false);
    await assert.rejects(library.run({ kind: "market", action: "browse" }, "model"), /只能由用户/);
  } finally { library.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("changed blob bytes cannot be previewed or persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-corrupt-")), f = fixture({ corrupt: true });
  const library = createAgentLibrary({ directory, fetcher: f.fetcher });
  try {
    await assert.rejects(library.run({ kind: "market", action: "preview", catalogSource: "agency", path: f.paths[0] }), /不一致/);
    assert.equal((await library.run({ kind: "list" })).agents.length, 0);
  } finally { library.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("dedicated store routes Agent and Skill operations without Pi and rejects unrelated settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-store-routing-")), f = fixture();
  const store = createStoreLibrary({ directory: join(root, "skills"), agentDirectory: join(root, "agents"), fetcher: f.fetcher });
  const run = request => store.run(JSON.stringify(request), "user");
  try {
    assert.equal((await run({ kind: "skills", action: "status" })).installed, 0);
    const { entries } = await run({ kind: "market", action: "browse" });
    const preview = await run({ kind: "market", action: "preview", catalogSource: "agency", path: entries[0].path });
    const saved = await run({ kind: "market", action: "import", token: preview.token, hash: preview.hash, accepted: true });
    await run({ kind: "settings", activeAgent: saved.id });
    assert.equal((await run({ kind: "market", action: "list" })).activeAgent, saved.id);
    assert.throws(() => run({ kind: "settings", autonomousDownloads: true }), /Unsupported/);
    assert.throws(() => run({ kind: "memory", action: "save" }), /Unsupported/);
  } finally { store.dispose(); await rm(root, { recursive: true, force: true }); }
});
