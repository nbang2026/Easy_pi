import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { MARKET_CATALOG, MARKET_VERSION, marketEntry, contentHash } from "../src-tauri/src/gui-market.mjs";

const expectedCategories = { engineering: 16, writing: 8, planning: 8, analysis: 8, design: 6, operations: 6, business: 6, productivity: 6 };
const originalHashes = {
  "code-reviewer": "7632cc197889caf92b894a6c60fa53341c5fe84485e1585e5d4e71056d5507f3",
  "bug-investigator": "1a0c0846b403d0806974909a6db7ecfcc53e5b3a07eb00f0e1e7a68b4c714e4e",
  "test-engineer": "e03d3dc84d5f7de574ea9d0c37365d4aa76b73617485a0dd383ffa47b1e0c470",
  documentation: "b894d79d8a6875cad9826995f865c6e935691f9d0c4195f163c2fd3ed6d77c16",
  architecture: "bd3856a251156086cb32125e9226de3e68e0c379c05c3932a6259bc6b0aef718",
  "release-checker": "d979c595d0d38c75663e4f6bc8c7f0d094f8eba196e1543d6e3990973c012381",
  "data-analyst": "bc9f8ed5e132df03ee513add737052348d45c924667d100e34d1708638233a88",
  "task-planner": "3cb4d001dee5c6d69181153100d2bd25cea10edbc893173d4f265e8ec2d9222e",
};

test("catalog offers exactly 64 distinct roles across eight purposeful categories", () => {
  assert.equal(MARKET_VERSION, "2");
  assert.equal(MARKET_CATALOG.length, 64);
  const counts = {};
  for (const item of MARKET_CATALOG) counts[item.category] = (counts[item.category] || 0) + 1;
  assert.deepEqual(counts, expectedCategories);
  for (const field of ["id", "title", "content", "marketKey", "hash"]) {
    assert.equal(new Set(MARKET_CATALOG.map((item) => item[field])).size, 64, field);
  }
});

test("every role has meaningful text, bilingual discovery labels and deterministic provenance", () => {
  for (const item of MARKET_CATALOG) {
    assert.match(item.id, /^[a-z][a-z0-9-]+$/);
    assert.match(item.title, /[一-鿿]/);
    assert.match(item.title, /[A-Za-z]/);
    assert.match(item.description, /[一-鿿]/);
    assert.match(item.description, /[A-Za-z]/);
    assert.ok(item.content.length >= 300, item.id);
    assert.ok(Buffer.byteLength(item.content) < 256 * 1024, item.id);
    assert.ok(item.content.startsWith("# "), item.id);
    assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(item.content), item.id);
    assert.equal(item.marketKey, `builtin:${item.id}`);
    assert.equal(item.source, `easy_pi://market/${item.id}`);
    assert.equal(item.author, "easy_pi");
    assert.equal(item.license, "CC0-1.0");
    assert.equal(item.kind, "text-agent");
    assert.equal(item.version, MARKET_VERSION);
    assert.equal(item.hash, createHash("sha256").update(item.content).digest("hex"));
    assert.equal(contentHash(item.content), item.hash);
    assert.equal(marketEntry(item.id), item);
    assert.ok(Object.isFrozen(item));
    assert.equal(item.install, undefined);
    assert.equal(item.command, undefined);
    if (!Object.hasOwn(originalHashes, item.id)) {
      assert.ok(item.content.split("\n\n").length >= 3, item.id);
    }
  }
  assert.ok(Object.isFrozen(MARKET_CATALOG));
});

test("original eight IDs and exact prompt hashes remain compatible with old imports", () => {
  assert.deepEqual(MARKET_CATALOG.slice(0, 8).map((entry) => entry.id), Object.keys(originalHashes));
  for (const [id, hash] of Object.entries(originalHashes)) {
    assert.equal(marketEntry(id).hash, hash);
    assert.equal(marketEntry(id).marketKey, `builtin:${id}`);
  }
});

test("unknown IDs and installation references never resolve into catalog entries", () => {
  for (const id of ["", "missing", "../code-reviewer", "npm:package", "https://example.com/agent.md", undefined, null, 12, {}]) {
    assert.throws(() => marketEntry(id));
  }
});
