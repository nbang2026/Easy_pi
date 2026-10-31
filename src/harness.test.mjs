import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, harnessSettings, HARNESS_DEFAULTS, harnessToolAllowed } from "../src-tauri/src/gui-harness.mjs";

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-"));
  const workspace = join(root, "project"), directory = join(root, "records");
  await mkdir(workspace);
  await writeFile(join(workspace, "a.txt"), "fixture");
  let clock = 100000;
  const harness = createHarness({ directory, now: () => clock });
  await harness.attach(workspace, "session");
  const status = await harness.run({ action: "status" });
  await harness.run({ action: "configure", settings: { ...HARNESS_DEFAULTS, ...options }, expectedWorkspace: status.workspace, expectedRevision: status.revision });
  return { root, workspace, directory, harness, advance: value => { clock += value; },
    close: async () => { await harness.dispose(); await rm(root, { recursive: true, force: true }); } };
}
const call = (id, toolName = "read", input = { path: "a.txt" }) => ({ toolCallId: id, toolName, input });
test("workbench reports only real workspace artifacts and never grants model permissions", async () => {
  const f=await fixture();
  try {
    await f.harness.start();
    assert.equal(await harnessToolAllowed("readonly",call("p","gui_workbench",{}),f.workspace),true);
    const plan=[{title:"Inspect",status:"completed"},{title:"Fix",status:"in_progress"}];
    const state=await f.harness.run({action:"progress",steps:plan,artifacts:["a.txt"]},"model");
    assert.equal(state.plan.length,2); assert.deepEqual(state.artifacts,["a.txt"]);
    await writeFile(join(f.workspace,".env"),"API_KEY=private");
    for (const path of [".env","../records","missing.txt"]) await assert.rejects(f.harness.run({action:"progress",artifacts:[path]},"model"),/产物/);
    await assert.rejects(f.harness.run({action:"progress",steps:[{title:"x",status:"verified"}]},"model"),/进度/);
    await f.harness.beforeTool(call("write","write",{path:"output.md"}));
    await writeFile(join(f.workspace,"output.md"),"result");
    await f.harness.toolResult({toolCallId:"write",isError:false});
    assert.deepEqual(f.harness.snapshot().artifacts,["a.txt","output.md"]);
    const event=f.harness.snapshot().events.find(item=>item.type==="tool_end");
    assert.equal(event.toolCallId,"write"); assert.equal(event.path,"output.md");
    await f.harness.beforeTool(call("failed","write",{path:"failed.md"}));
    await f.harness.toolResult({toolCallId:"failed",isError:true});
    assert.equal(f.harness.snapshot().artifacts.includes("failed.md"),false);
    assert.equal(f.harness.snapshot().limits.mode,"project");
    assert.equal(f.harness.snapshot().verification,null);
  } finally {await f.close();}
});
test("restricted modes protect secrets and Git internals and require bounded recursive tools", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.workspace, ".git"));
    await writeFile(join(f.workspace, ".env"), "API_KEY=private");
    await writeFile(join(f.workspace, ".git", "config"), "private config");
    for (const mode of ["readonly", "project"]) {
      for (const path of [".env", ".git/config", ".git/hooks/pre-commit"]) {
        for (const tool of ["read", "write", "edit", "workspace_read"])
          assert.equal(await harnessToolAllowed(mode, call(`${tool}-${path}`, tool, { path }), f.workspace), false);
      }
      for (const tool of ["grep", "find", "ls"])
        assert.equal(await harnessToolAllowed(mode, call(tool, tool, { path: "." }), f.workspace), false);
      assert.equal(await harnessToolAllowed(mode, call("safe", "workspace_search", { path: "." }), f.workspace), true);
    }
  } finally { await f.close(); }
});

test("serialized message identities count usage once and checkpoint notes redact credentials", async () => {
  const f = await fixture();
  try {
    await f.harness.start();
    const message = { id: "msg-1", role: "assistant", usage: { input: 12, output: 2, cost: { total: 0.001 } } };
    await f.harness.message(message);
    await f.harness.message(structuredClone(message));
    assert.equal(f.harness.snapshot().usage.tokens, 14);
    await f.harness.run({ action: "checkpoint", note: "API_KEY=should-not-persist" });
    const files = await readdir(join(f.directory, "runs"));
    const journal = await readFile(join(f.directory, "runs", files[0]), "utf8");
    assert.equal(journal.includes("should-not-persist"), false);
    assert.match(journal, /redacted/);
  } finally { await f.close(); }
});
test("corrupt task history is preserved without hiding healthy runs", async () => {
  const f = await fixture();
  try {
    await f.harness.start(); await f.harness.end("ended");
    const bad = join(f.directory, "runs", `${"f".repeat(8)}-${"f".repeat(4)}-${"f".repeat(4)}-${"f".repeat(4)}-${"f".repeat(12)}.json`);
    await writeFile(bad, "broken");
    const report = await f.harness.run({ action: "history", report: true });
    assert.equal(report.runs.length, 1); assert.equal(report.warnings.length, 1);
    assert.equal(await readFile(bad, "utf8"), "broken");
  } finally { await f.close(); }
});

test("failed durable start stays closed until the controller is attached again", async () => {
  const f = await fixture();
  try {
    await rm(join(f.directory, "runs"), { recursive: true });
    await writeFile(join(f.directory, "runs"), "not a directory");
    await assert.rejects(f.harness.start());
    assert.notEqual(f.harness.snapshot().state, "running");
    await rm(join(f.directory, "runs"));
    await mkdir(join(f.directory, "runs"));
    await assert.rejects(f.harness.start(), /尚未就绪/);
    assert.equal((await f.harness.beforeTool(call("blocked"))).block, true);
    await f.harness.attach(f.workspace, "session");
    assert.equal((await f.harness.start()).state, "running");
  } finally { await f.close(); }
});

test("canonical paths cannot bypass repeated failure limits and malformed calls are denied", async () => {
  const f = await fixture({ maxRepeatedFailures: 1 });
  try {
    await f.harness.start();
    for (const malformed of [{ ...call(""), toolCallId: "" }, { ...call("array"), input: [] }]) {
      assert.equal((await f.harness.beforeTool(malformed)).block, true);
    }
    assert.deepEqual(await f.harness.beforeTool(call("relative")), {});
    await f.harness.toolResult({ toolCallId: "relative", isError: true });
    assert.equal((await f.harness.beforeTool(call("absolute", "read", { path: join(f.workspace, "a.txt") }))).terminate, true);
    assert.equal(f.harness.snapshot().reason, "repeatedFailures");
  } finally { await f.close(); }
});

test("run end never implies verification; model cannot modify limits or accept its own output", async () => {
  const f = await fixture();
  try {
    await f.harness.start(); await f.harness.end("ended");
    assert.equal(f.harness.snapshot().state, "awaiting_verification");
    const id = f.harness.snapshot().id;
    await assert.rejects(f.harness.run({ action: "verify", id, result: "passed", note: "trust me" }, "model"));
    await assert.rejects(f.harness.run({ action: "configure", settings: HARNESS_DEFAULTS }, "model"));
    await f.harness.run({ action: "verify", id, result: "passed", note: "Checked expected output" });
    assert.equal(f.harness.snapshot().state, "verified");
    assert.equal(f.harness.snapshot().verification.authority, "user");
  } finally { await f.close(); }
});
test("readonly and project policies reject shells, unknown tools, traversal and symlink escapes", async t => {
  const f = await fixture({ mode: "readonly" });
  try {
    assert.equal(await harnessToolAllowed("readonly", call("a"), f.workspace), true);
    for (const event of [call("b", "bash", { command: "cat a.txt" }), call("c", "write"), call("d", "custom"),
      call("e", "read", { path: "../private.txt" }), call("f", "gui_memory", { action: "save" }),
      call("g", "gui_agent_library", { action: "download" })]) {
      assert.equal(await harnessToolAllowed("readonly", event, f.workspace), false);
    }
    assert.equal(await harnessToolAllowed("project", call("w", "write", { path: "new/nested.txt" }), f.workspace), true);
    assert.equal(await harnessToolAllowed("project", call("b", "bash"), f.workspace), false);
    try { await symlink(f.root, join(f.workspace, "outside")); }
    catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.diagnostic("Symlink portion requires Windows privilege"); return; } throw error; }
    assert.equal(await harnessToolAllowed("project", call("w", "write", { path: "outside/secret.txt" }), f.workspace), false);
  } finally { await f.close(); }
});
test("tool intent is persisted before execution, completed calls clear pending and repeated IDs cannot replay", async () => {
  const f = await fixture();
  try {
    await f.harness.start();
    assert.deepEqual(await f.harness.beforeTool(call("once", "write", { path: "a", content: "secret-body-not-for-journal" })), {});
    const files = await readdir(join(f.directory, "runs"));
    const bytes = await readFile(join(f.directory, "runs", files[0]), "utf8");
    assert.equal(JSON.parse(bytes).pending.length, 1);
    assert.ok(!bytes.includes("secret-body-not-for-journal"));
    await f.harness.toolResult({ toolCallId: "once", isError: false });
    assert.equal(f.harness.snapshot().pending.length, 0);
    assert.equal((await f.harness.beforeTool(call("once"))).block, true);
    assert.equal(f.harness.snapshot().reason, "duplicateCall");
  } finally { await f.close(); }
});
test("tool and turn limits block before the next operation and settings cannot change mid-run", async () => {
  const f = await fixture({ maxToolCalls: 1, maxTurns: 1 });
  try {
    await f.harness.start();
    await assert.rejects(f.harness.run({ action: "configure", settings: HARNESS_DEFAULTS }));
    assert.equal(await f.harness.beforeTurn(), "");
    assert.equal(await f.harness.beforeTurn(), "turns");
    await f.harness.start();
    assert.equal((await f.harness.beforeTool(call("1"))).block, undefined);
    assert.equal((await f.harness.beforeTool(call("2"))).terminate, true);
    assert.equal(f.harness.snapshot().usage.toolCalls, 1);
  } finally { await f.close(); }
});
test("elapsed time, tokens and known cost stop a run; missing cost is explicitly incomplete", async () => {
  for (const [limits, message, reason] of [
    [{ maxTokens: 100 }, { usage: { input: 100, output: 2, cost: { total: 0 } } }, "tokens"],
    [{ maxCost: 0.01 }, { usage: { input: 1, cost: { total: 0.02 } } }, "cost"],
  ]) {
    const f = await fixture(limits);
    try {
      await f.harness.start(); await f.harness.message({ role: "assistant", ...message });
      assert.equal(f.harness.snapshot().reason, reason);
      assert.equal((await f.harness.beforeTool(call("x"))).block, true);
    } finally { await f.close(); }
  }
  const f = await fixture({ maxMinutes: 1 });
  try {
    await f.harness.start();
    await f.harness.message({ role: "assistant", usage: { input: 2 } });
    assert.equal(f.harness.snapshot().usage.costKnown, false);
    f.advance(60000); assert.equal(await f.harness.tick(), "time");
  } finally { await f.close(); }
});
test("zero quotas allow multi-day runs beyond former defaults while retaining stop and permission controls", async () => {
  const f = await fixture({ maxRepeatedFailures: 0 });
  try {
    await f.harness.start();
    f.advance(3 * 24 * 60 * 60000);
    assert.equal(await f.harness.tick(), "");
    for (let i = 0; i < 105; i++) assert.equal(await f.harness.beforeTurn(), "");
    await f.harness.message({ role: "assistant", usage: { input: 1000000, cost: { total: 10 } } });
    for (let i = 0; i < 205; i++) {
      assert.notEqual((await f.harness.beforeTool(call(`long-${i}`))).block, true);
      await f.harness.toolResult({ toolCallId: `long-${i}`, isError: i < 5 });
    }
    assert.equal(f.harness.snapshot().state, "running");
    assert.equal(f.harness.snapshot().limits.mode, "project");
    const denied = await f.harness.beforeTool(call("secret", "read", { path: ".env" }));
    assert.equal(denied.block, true);
    await f.harness.end("cancelled");
    assert.equal(f.harness.snapshot().state, "cancelled");
    assert.equal((await f.harness.beforeTool(call("after-stop"))).block, true);
  } finally { await f.close(); }
});

test("repeated identical failures stop, successful results reset the failure sequence", async () => {
  const f = await fixture({ maxRepeatedFailures: 2 });
  try {
    await f.harness.start();
    for (let i = 0; i < 2; i++) {
      await f.harness.beforeTool(call(String(i)));
      await f.harness.toolResult({ toolCallId: String(i), isError: true });
    }
    assert.equal((await f.harness.beforeTool(call("3"))).terminate, true);
    assert.equal(f.harness.snapshot().reason, "repeatedFailures");
    await f.harness.start();
    for (let i = 0; i < 3; i++) {
      assert.equal((await f.harness.beforeTool(call(String(i)))).block, undefined);
      await f.harness.toolResult({ toolCallId: String(i), isError: i !== 1 });
    }
    assert.equal(f.harness.snapshot().state, "running");
  } finally { await f.close(); }
});
test("interrupted in-flight operations survive restart as unknown; no replay or takeover occurs", async () => {
  const f = await fixture();
  try {
    await f.harness.start(); await f.harness.beforeTool(call("pending", "write"));
    const second = createHarness({ directory: f.directory });
    await second.attach(f.workspace, "session");
    const history = await second.run({ action: "history" });
    assert.equal(history[0].observation, "unconfirmed");
    assert.equal(history[0].pending[0].tool, "write");
    assert.equal(second.snapshot(), null);
    await f.harness.dispose();
    const after = await second.run({ action: "history" });
    assert.equal(after[0].state, "interrupted");
    await second.dispose();
  } finally { await f.close(); }
});
test("corrupt settings fail closed, invalid limits are rejected, journal files are private", async () => {
  const f = await fixture();
  try {
    for (const change of [{ mode: "bad" }, { maxCost: NaN }, { maxTokens: -1 }, { maxTurns: 1.5 }])
      assert.throws(() => harnessSettings({ ...HARNESS_DEFAULTS, ...change }));
    await f.harness.start();
    const runFile = join(f.directory, "runs", (await readdir(join(f.directory, "runs")))[0]);
    if (process.platform !== "win32") assert.equal((await stat(runFile)).mode & 0o777, 0o600);
    await f.harness.end("cancelled");
    const settingsFile = join(f.directory, "settings", (await readdir(join(f.directory, "settings")))[0]);
    await writeFile(settingsFile, "broken");
    await assert.rejects(f.harness.attach(f.workspace, "session"));
    await assert.rejects(f.harness.start());
    assert.equal(await readFile(settingsFile, "utf8"), "broken");
  } finally { await f.close(); }
});
test("model errors, aborts and unsettled tools cannot become an accepted run", async () => {
  const f = await fixture();
  try {
    await f.harness.start(); await f.harness.message({ role: "assistant", stopReason: "error" }); await f.harness.end("ended");
    assert.equal(f.harness.snapshot().state, "failed");
    await f.harness.start(); await f.harness.beforeTool(call("unknown")); await f.harness.end("ended");
    assert.equal(f.harness.snapshot().state, "interrupted");
    await assert.rejects(f.harness.run({ action: "verify", id: f.harness.snapshot().id, result: "passed", note: "not checked" }));
    await f.harness.start(); await f.harness.end("cancelled");
    assert.equal(f.harness.snapshot().state, "cancelled");
  } finally { await f.close(); }
});
test("historical verification leaves the current run unchanged and transient errors can recover", async () => {
  const f = await fixture();
  try {
    await f.harness.start(); await f.harness.end("ended");
    const historical = f.harness.snapshot().id;
    await f.harness.start();
    const active = f.harness.snapshot().id;
    await f.harness.run({ action: "verify", id: historical, result: "passed", note: "Reviewed saved output" });
    assert.equal(f.harness.snapshot().id, active);
    assert.equal(f.harness.snapshot().state, "running");
    const history = await f.harness.run({ action: "history" });
    assert.equal(history.find(row => row.id === historical).state, "verified");
    await f.harness.message({ role: "assistant", stopReason: "error" });
    await f.harness.message({ role: "assistant", stopReason: "stop", usage: { input: 1 } });
    await f.harness.end("ended");
    assert.equal(f.harness.snapshot().state, "awaiting_verification");
  } finally { await f.close(); }
});
test("checked paths stay canonical and project writes reject hardlinked files", async () => {
  const f = await fixture({ mode: "project" });
  try {
    const event = call("canonical");
    assert.equal(await harnessToolAllowed("project", event, f.workspace), true);
    assert.equal(event.input.path, await realpath(join(f.workspace, "a.txt")));
    await link(join(f.workspace, "a.txt"), join(f.root, "shared.txt"));
    assert.equal(await harnessToolAllowed("project", call("hardlink", "write", { path: "a.txt" }), f.workspace), false);
    assert.equal(await harnessToolAllowed("project", call("edit", "edit", { path: "missing.txt" }), f.workspace), false);
  } finally { await f.close(); }
});
