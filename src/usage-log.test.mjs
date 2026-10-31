import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUsageLog, usageRecord, aggregateUsage, usageCsv, usageDay } from "../src-tauri/src/gui-usage.mjs";
const at = new Date(2026, 9, 17, 12).getTime();
const entry = (id = "1", usage = { input: 10, output: 5, cacheRead: 30, cacheWrite: 10, cost: { total: 0.1 } }) =>
  ({ id, type: "message", timestamp: new Date(at).toISOString(),
    message: { role: "assistant", timestamp: at, provider: "test", model: "model", usage, content: [{ type: "text", text: "secret-prompt-not-for-usage" }] } });
test("one corrupt event is preserved and reported while valid rows remain readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-corrupt-"));
  try {
    await createUsageLog({ directory }).record([entry()], "s");
    const bad = join(directory, `${"f".repeat(64)}.json`); await writeFile(bad, "broken");
    const log = createUsageLog({ directory }), summary = await log.run({ action: "summary" });
    assert.equal(summary.all.records, 1); assert.equal(summary.incomplete, true); assert.equal(summary.warnings.length, 1);
    assert.equal(await readFile(bad, "utf8"), "broken");
    await assert.rejects(log.run({ action: "export", format: "csv" }), /JSON/);
    assert.equal(JSON.parse((await log.run({ action: "export", format: "json" })).content).warnings.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("usage normalizes four buckets, local-day boundaries and prompt-side cache rate", () => {
  const row = usageRecord(entry(), "s");
  const totals = aggregateUsage([row], {}, at);
  assert.equal(totals.today.tokens, 55);
  assert.equal(totals.today.cacheHit, 30 / 50);
  assert.equal(totals.today.cost, 0.1);
  assert.equal(totals.days[0].name, usageDay(at));
  assert.equal(totals.tasks[0].name, "unassigned");
});
test("unknown costs remain null even when other events have known prices; zero cost remains known", () => {
  const rows = [usageRecord(entry(), "s"), usageRecord(entry("2", { input: 10 }), "s")];
  const value = aggregateUsage(rows, {}, at);
  assert.equal(value.all.cost, null); assert.equal(value.all.unknownCost, 1);
  assert.equal(aggregateUsage([usageRecord(entry("3", { input: 1, cost: { total: 0 } }), "s")], {}, at).all.cost, 0);
});
test("provider, model, date and session/task grouping use the same normalized events", () => {
  const first = usageRecord(entry(), "one", { id: "task", startedAt: at - 1 });
  const second = { ...usageRecord(entry("2"), "two"), provider: "other", at: at - 86400000 };
  const result = aggregateUsage([first, second], { provider: "test", from: usageDay(at), to: usageDay(at) }, at);
  assert.equal(result.selected.records, 1); assert.equal(result.sessions[0].name, "one"); assert.equal(result.tasks[0].name, "task");
  assert.equal(usageRecord(entry(), "s", { id: "new-task", startedAt: at + 1 }).taskId, "");
});
test("usage analytics build model-by-day trends and use an exact rolling 24-hour window", () => {
  const record = (id, model, time, usage) => {
    const value = usageRecord({ ...entry(id, usage), message: { ...entry(id, usage).message, model, timestamp: time } }, "s");
    return { ...value, at: time };
  };
  const rows = [
    record("a", "alpha", at, { input: 10, output: 2, cost: { total: 0.1 } }),
    record("b", "beta", at, { input: 20, output: 3, cost: { total: 0.2 } }),
    record("c", "unknown-price", at - 1, { input: 7 }),
    record("d", "alpha", at - 25 * 60 * 60 * 1000, { input: 50, cost: { total: 0.5 } }),
  ];
  const value = aggregateUsage(rows, {}, at);
  assert.equal(value.last24Hours.records, 3);
  assert.equal(value.last24Hours.unknownCost, 1);
  assert.equal(value.last24Hours.cost, null);
  assert.ok(Math.abs(value.last24Hours.knownCost - 0.3) < 1e-12);
  assert.deepEqual(value.modelBreakdown.map(model => model.model), ["alpha", "beta", "unknown-price"]);
  assert.equal(value.modelBreakdown.find(model => model.model === "alpha").records, 2);
  assert.equal(value.trend.length, 2);
  assert.equal(value.trend.at(-1).models.find(model => model.model === "beta").records, 1);
  assert.equal(value.trend.at(-1).models.find(model => model.model === "unknown-price").knownCost, 0);
});
test("invalid usage and dates are rejected; messages and credentials never enter normalized rows", () => {
  assert.equal(usageRecord(entry("x", { input: -1 }), "s"), null);
  assert.equal(usageRecord({ ...entry(), message: { ...entry().message, timestamp: "invalid" } }, "s"), null);
  assert.equal(usageRecord({ ...entry(), message: { role: "user", usage: {} } }, "s"), null);
  assert.ok(!JSON.stringify(usageRecord(entry(), "s")).includes("secret-prompt-not-for-usage"));
});
test("immutable logs deduplicate refreshes, session forks and concurrent windows without losing distinct calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-"));
  try {
    const first = createUsageLog({ directory }), second = createUsageLog({ directory });
    await Promise.all([first.record([entry()], "original"), second.record([entry(), entry("2")], "fork")]);
    await first.record([entry(), entry("2")], "original");
    const summary = await createUsageLog({ directory }).run({ action: "summary" });
    assert.equal(summary.all.records, 2); assert.equal(summary.all.tokens, 110);
    for (const name of await readdir(directory)) {
      const file = join(directory, name);
      assert.ok(!String(await readFile(file)).includes("secret-prompt-not-for-usage"));
      if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("CSV preserves Unicode, quotes and missing costs while blocking spreadsheet formulas", () => {
  const row = usageRecord(entry(), "会话");
  row.provider = "=HYPERLINK(\"bad\")"; row.model = "中文,\"模型\""; row.cost = null;
  const csv = usageCsv([row]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("\"'=HYPERLINK(")); assert.ok(csv.includes("中文,\"\"模型\"\""));
  assert.ok(csv.includes('"","会话"'));
});
test("exports share filters with the dashboard and contain no full transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-export-"));
  try {
    const log = createUsageLog({ directory });
    await log.record([entry()], "s");
    const out = await log.run({ action: "export", format: "json", filter: { provider: "missing" } });
    assert.equal(JSON.parse(out.content).selected.records, 0);
    assert.equal(JSON.parse(out.content).rows.length, 0);
    const json = await log.run({ action: "export", format: "json" });
    assert.ok(!json.content.includes("secret-prompt-not-for-usage"));
    await assert.rejects(log.run({ action: "export", format: "exe" }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
