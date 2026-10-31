import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createHarness, HARNESS_DEFAULTS } from "../src-tauri/src/gui-harness.mjs";
import { createUsageLog } from "../src-tauri/src/gui-usage.mjs";

const report = { version: 1, scope: "deterministic local harness scenarios; no model-quality score",
  modelRequests: 0, scenarios: [], passed: true };
const scratch = await mkdtemp(join(tmpdir(), "pi-harness-eval-"));
async function configure(harness, settings) {
  const status = await harness.run({ action: "status" });
  await harness.run({ action: "configure", settings, expectedWorkspace: status.workspace, expectedRevision: status.revision });
}
async function scenario(name, execute) {
  const root = join(scratch, name); await mkdir(root);
  const workspace = join(root, "project"); await mkdir(workspace);
  const harness = createHarness({ directory: join(root, "records") });
  const started = performance.now();
  try {
    await harness.attach(workspace, "eval");
    await execute(harness, workspace, root);
    report.scenarios.push({ name, passed: true, durationMs: Math.round(performance.now() - started) });
  } catch (error) {
    report.passed = false;
    report.scenarios.push({ name, passed: false, error: String(error.message), durationMs: Math.round(performance.now() - started) });
  } finally { await harness.dispose(); }
}
try {
  await scenario("project-write-and-explicit-acceptance", async (harness, workspace) => {
    await configure(harness, { ...HARNESS_DEFAULTS, mode: "project" });
    await harness.start();
    const operation = { toolCallId: "write-1", toolName: "write", input: { path: "answer.txt", content: "42" } };
    assert.equal((await harness.beforeTool(operation)).block, undefined);
    await writeFile(operation.input.path, operation.input.content);
    await harness.toolResult({ toolCallId: "write-1", isError: false });
    await harness.end("ended");
    assert.equal(harness.snapshot().state, "awaiting_verification");
    assert.equal(await readFile(join(workspace, "answer.txt"), "utf8"), "42");
    await harness.run({ action: "verify", id: harness.snapshot().id, result: "passed", note: "Expected answer.txt = 42" });
    assert.equal(harness.snapshot().state, "verified");
  });
  await scenario("readonly-prevents-file-modification", async (harness, workspace) => {
    await writeFile(join(workspace, "keep.txt"), "original");
    await configure(harness, { ...HARNESS_DEFAULTS, mode: "readonly" });
    await harness.start();
    const result = await harness.beforeTool({ toolCallId: "x", toolName: "write", input: { path: "keep.txt", content: "changed" } });
    assert.equal(result.block, true);
    assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "original");
  });
  await scenario("interrupt-does-not-repeat-side-effect", async (harness, workspace, root) => {
    await configure(harness, { ...HARNESS_DEFAULTS, mode: "autonomous" });
    await harness.start();
    assert.equal((await harness.beforeTool({ toolCallId: "x", toolName: "bash", input: { command: "synthetic append" } })).block, undefined);
    await writeFile(join(workspace, "side-effect.txt"), "once");
    await harness.dispose();
    const restarted = createHarness({ directory: join(root, "records") });
    await restarted.attach(workspace, "eval");
    const runs = await restarted.run({ action: "history" });
    assert.equal(runs[0].state, "interrupted"); assert.equal(runs[0].pending.length, 1);
    assert.equal(restarted.snapshot(), null);
    assert.equal(await readFile(join(workspace, "side-effect.txt"), "utf8"), "once");
    await restarted.dispose();
  });
  await scenario("tool-limit-stops-before-next-action", async harness => {
    await configure(harness, { ...HARNESS_DEFAULTS, mode: "autonomous", maxToolCalls: 1 });
    await harness.start();
    await harness.beforeTool({ toolCallId: "1", toolName: "bash", input: { command: "synthetic" } });
    await harness.toolResult({ toolCallId: "1", isError: false });
    assert.equal((await harness.beforeTool({ toolCallId: "2", toolName: "bash", input: {} })).terminate, true);
    assert.equal(harness.snapshot().state, "limited");
  });
  await scenario("usage-reload-and-fork-do-not-double-count", async (_harness, _workspace, root) => {
    const log = createUsageLog({ directory: join(root, "usage") });
    const entry = { type: "message", id: "paid", message: { role: "assistant", timestamp: Date.now(),
      provider: "eval", model: "fixture", usage: { input: 10, output: 5, cost: { total: 0.01 } } } };
    await log.record([entry], "first"); await log.record([entry], "fork");
    const restarted = createUsageLog({ directory: join(root, "usage") });
    await restarted.record([entry], "reload");
    const summary = await restarted.run({ action: "summary" });
    assert.equal(summary.all.records, 1); assert.equal(summary.all.tokens, 15);
  });
} finally { await rm(scratch, { recursive: true, force: true }); }
const argument = process.argv.find(value => value.startsWith("--report="));
if (argument) {
  const file = resolve(argument.slice("--report=".length));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
