import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentLibrary } from "../src-tauri/src/gui-library.mjs";
import { MARKET_CATALOG } from "../src-tauri/src/gui-market.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "easy-pi-expanded-catalog-"));
  const filename = join(directory, "library.json");
  const create = () => createAgentLibrary({ directory, fetcher: async () => new Response("# Remote role\nReview supplied evidence before making recommendations.") });
  return { directory, filename, library: create(), create, close: () => rm(directory, { recursive: true, force: true }) };
}

test("all 64 market roles fit in the local library, survive restart and do not auto-activate", async () => {
  const f = await fixture(); try {
    assert.equal(MARKET_CATALOG.length, 64);
    for (const entry of MARKET_CATALOG) {
      const result = await f.library.run({ kind: "market", action: "import", id: entry.id, hash: entry.hash, accepted: true });
      assert.equal(result.alreadyImported, false);
    }
    const restarted = f.create();
    const state = await restarted.run({ kind: "market", action: "list" });
    assert.equal(state.entries.length, 64); assert.equal(state.installed.length, 64);
    assert.ok(state.entries.every((item) => item.installedId));
    assert.equal(state.activeAgent, "");
    const before = await readFile(f.filename);
    for (const entry of MARKET_CATALOG) {
      const result = await restarted.run({ kind: "market", action: "import", id: entry.id, hash: entry.hash, accepted: true });
      assert.equal(result.alreadyImported, true);
    }
    assert.deepEqual(await readFile(f.filename), before);
    const last = state.installed.at(-1);
    await restarted.run({ kind: "settings", activeAgent: last.id });
    assert.equal((await restarted.run({ kind: "context" })).agent.id, last.id);
  } finally { await f.close(); }
});

test("manual and GitHub additions share the 128-Agent cap without modifying a full library", async () => {
  const f = await fixture(); try {
    const agents = Array.from({ length: 128 }, (_, index) => ({ id: randomUUID(), title: `Existing ${index}`, content: "# Existing definition", updatedAt: 1 }));
    await writeFile(f.filename, JSON.stringify({ version: 1, settings: { memoryEnabled: true, autonomousDownloads: true }, memories: [], agents }));
    const before = await readFile(f.filename);
    await assert.rejects(f.library.run({ kind: "agent", action: "save", title: "Overflow", content: "# Overflow" }), /上限/);
    await assert.rejects(f.library.run({ kind: "agent", action: "download", source: "https://raw.githubusercontent.com/example/agents/main/role.md" }), /128/);
    assert.deepEqual(await readFile(f.filename), before);
    await f.library.run({ kind: "agent", action: "save", id: agents[0].id, title: "Edited", content: "# Existing edited" });
    assert.equal((await f.create().run({ kind: "list" })).agents.length, 128);
    await f.library.run({ kind: "agent", action: "remove", id: agents[1].id });
    await f.library.run({ kind: "agent", action: "download", source: "https://raw.githubusercontent.com/example/agents/main/role.md" });
    assert.equal((await f.create().run({ kind: "list" })).agents.length, 128);
  } finally { await f.close(); }
});

test("over-cap stored libraries are rejected without destructive repair", async () => {
  const f = await fixture(); try {
    const agents = Array.from({ length: 129 }, (_, index) => ({ id: randomUUID(), title: `Existing ${index}`, content: "# Existing", updatedAt: 1 }));
    await writeFile(f.filename, JSON.stringify({ version: 1, settings: { memoryEnabled: true, autonomousDownloads: true }, memories: [], agents }));
    const before = await readFile(f.filename);
    await assert.rejects(f.library.run({ kind: "market", action: "list" }), /格式无效/);
    await assert.rejects(f.library.run({ kind: "agent", action: "save", title: "New", content: "# New" }), /格式无效/);
    assert.deepEqual(await readFile(f.filename), before);
  } finally { await f.close(); }
});
