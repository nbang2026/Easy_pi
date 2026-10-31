import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, HARNESS_DEFAULTS } from "../src-tauri/src/gui-harness.mjs";
import {
  createTaskScheduler,
  createTaskWorkspaceTools,
  normalizeScheduleTasks,
} from "../src-tauri/src/task-scheduler.mjs";

const task = (id, overrides = {}) => ({
  id, title: `Review ${id}`, domain: "engineering", prompt: `Inspect ${id} and report evidence.`,
  ...overrides,
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const schema = {
  Object: (properties) => ({ properties }),
  String: (options) => ({ type: "string", ...options }),
  Number: (options) => ({ type: "number", ...options }),
  Array: (items) => ({ items }),
  Optional: (value) => ({ optional: value }),
};

test("normalizes task plans and rejects duplicate IDs, duplicate work and invalid dependency graphs", () => {
  assert.deepEqual(normalizeScheduleTasks([task("review"), task("tests")], { maxTasks: 2 }).map(({ id }) => id), ["review", "tests"]);
  assert.throws(() => normalizeScheduleTasks([task("same"), task("same")]), /ID/);
  assert.throws(() => normalizeScheduleTasks([task("a"), task("b", {
    title: "Review a", prompt: "Inspect a and report evidence.",
  })]), /重复/);
  assert.throws(() => normalizeScheduleTasks([task("a", { dependsOn: ["missing"] })]), /不存在/);
  assert.throws(() => normalizeScheduleTasks([
    task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] }),
  ]), /循环/);
  assert.throws(() => normalizeScheduleTasks([task("bad/id")]), /格式无效/);
});

test("runs independent tasks within the concurrency cap and preserves result attribution", async () => {
  let active = 0;
  let highWater = 0;
  const scheduler = createTaskScheduler({
    async runTask(value) {
      active++;
      highWater = Math.max(highWater, active);
      await delay(15);
      active--;
      return { agent: `${value.domain} reviewer`, skills: ["review"], result: `Evidence for ${value.id}` };
    },
  });
  const result = await scheduler.run([task("api"), task("security"), task("tests")], { maxTasks: 3, maxConcurrency: 2 });
  assert.equal(highWater, 2);
  assert.equal(result.ok, true);
  assert.equal(result.completed, 3);
  assert.ok(result.runId);
  assert.equal(new Set(result.tasks.map(({ executionId }) => executionId)).size, 3);
  assert.ok(result.tasks.every(({ executionId }) => executionId.startsWith(`${result.runId}:`)));
  assert.deepEqual(result.tasks.map(({ status }) => status), ["completed", "completed", "completed"]);
  assert.equal(result.tasks[1].agent, "engineering reviewer");
  assert.deepEqual(result.tasks[1].skills, ["review"]);
  assert.match(result.tasks[1].result, /security/);
});

test("respects dependencies, continues unrelated work after failure and skips dependent tasks", async () => {
  const order = [];
  const scheduler = createTaskScheduler({
    async runTask(value) {
      order.push(`start:${value.id}`);
      await delay(5);
      order.push(`end:${value.id}`);
      if (value.id === "root") throw new Error("child failure");
      return `done ${value.id}`;
    },
  });
  const result = await scheduler.run([
    task("root"),
    task("after-root", { dependsOn: ["root"] }),
    task("independent"),
  ], { maxTasks: 3, maxConcurrency: 2 });
  assert.equal(result.tasks[0].status, "failed");
  assert.match(result.tasks[0].error, /child failure/);
  assert.equal(result.tasks[1].status, "skipped");
  assert.equal(result.tasks[2].status, "completed");
  assert.ok(!order.includes("start:after-root"));
  assert.ok(order.includes("start:independent"));

  let dependencyContext = [];
  const successful = createTaskScheduler({
    async runTask(value, options) {
      if (value.id === "follow-up") dependencyContext = options.dependencies;
      return value.id === "root" ? "verified API contract" : options.dependencies[0].result;
    },
  });
  const dependent = await successful.run([
    task("root"), task("follow-up", { dependsOn: ["root"] }),
  ], { maxTasks: 2 });
  assert.equal(dependent.tasks[1].result, "verified API contract");
  assert.deepEqual(dependencyContext, [{
    id: "root", title: "Review root", domain: "engineering", result: "verified API contract",
  }]);
});

test("cancellation aborts active children and marks queued work cancelled", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const controller = new AbortController();
  const scheduler = createTaskScheduler({
    runTask(_value, { signal }) {
      started();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason || new Error("cancelled")), { once: true });
      });
    },
  });
  const pending = scheduler.run([task("first"), task("second")], {
    maxTasks: 2, maxConcurrency: 1, signal: controller.signal,
  });
  await startedPromise;
  controller.abort(new Error("user stopped"));
  const result = await pending;
  assert.equal(result.cancelled, 2);
  assert.deepEqual(result.tasks.map(({ status }) => status), ["cancelled", "cancelled"]);
});

test("zero task timeout has no deadline and still cancels an uncooperative child", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let childSignal;
  const scheduler = createTaskScheduler({ runTask(_task, { signal }) {
    childSignal = signal; started(); return new Promise(() => {});
  } });
  const pending = scheduler.run([task("unlimited"), task("queued")], {
    taskTimeoutMs: 0, maxConcurrency: 1, signal: controller.signal,
  });
  await ready;
  t.mock.timers.tick(3 * 24 * 60 * 60 * 1000);
  assert.equal(childSignal.aborted, false);
  controller.abort(new Error("user stopped unlimited work"));
  const result = await pending;
  assert.equal(result.cancelled, 2);
  assert.equal(childSignal.aborted, true);
  await assert.rejects(scheduler.run([task("invalid")], { taskTimeoutMs: -1 }), /超时/);
});

test("child workspace tools are audited, read-only, bounded and reject private or external paths", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-child-agent-"));
  const workspace = join(temporary, "project");
  const outside = join(temporary, "outside.txt");
  const harness = createHarness({ directory: join(temporary, "records") });
  await mkdir(workspace);
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "app.ts"), [
    "export const state = 'ready'; const token = 'sk-12345678901234567890'; const config = {\"api_key\": \"plain-secret-value\", \"AWS_SESSION_TOKEN\": \"session-secret\"};",
    "-----BEGIN PRIVATE KEY-----",
    "private-key-content",
    "-----END PRIVATE KEY-----",
  ].join("\n"));
  await writeFile(join(workspace, ".env"), "API_KEY=sk-12345678901234567890\n");
  await writeFile(outside, "outside secret");
  await symlink(outside, join(workspace, "escape.txt"));
  await harness.attach(workspace, "parent-session");
  await harness.start();
  try {
    const tools = await createTaskWorkspaceTools({ workspace, Type: schema, harness });
    const read = tools.find(({ name }) => name === "workspace_read");
    const search = tools.find(({ name }) => name === "workspace_search");
    const readResult = await read.execute("read-1", { path: "src/app.ts" });
    assert.match(readResult.content[0].text, /state = 'ready'/);
    const searchResult = await search.execute("search-1", { query: "ready" });
    assert.match(searchResult.content[0].text, /src\/app\.ts:1/);
    assert.doesNotMatch(searchResult.content[0].text, /API_KEY|sk-123/);
    assert.match(searchResult.content[0].text, /token = '\[redacted\]'/);
    assert.match(searchResult.content[0].text, /"api_key": "\[redacted\]"/);
    assert.doesNotMatch(searchResult.content[0].text, /plain-secret-value/);
    assert.doesNotMatch(searchResult.content[0].text, /session-secret/);
    assert.doesNotMatch(readResult.content[0].text, /private-key-content/);
    assert.match(readResult.content[0].text, /redacted private key/);
    await assert.rejects(read.execute("secret-1", { path: ".env" }), /凭据和私密配置/);
    await assert.rejects(read.execute("escape-1", { path: "escape.txt" }), /工作区|权限/);
    await assert.rejects(read.execute("outside-1", { path: "../outside.txt" }), /工作区|权限/);
    const usage = harness.snapshot().usage;
    assert.equal(usage.toolCalls, 5);
    assert.equal(harness.snapshot().pending.length, 0);
  } finally {
    await harness.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("workspace excerpts and both search paths redact whole secrets before selecting lines", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-excerpt-"));
  try {
    await writeFile(join(workspace, "notes.txt"), [
      "public header",
      "-----BEGIN PRIVATE KEY-----",
      "sensitive-key-body",
      "-----END PRIVATE KEY-----",
      "public tail",
      `DB_PASSWORD="${"x".repeat(510)} secret tail"`,
    ].join("\n"));
    const tools = await createTaskWorkspaceTools({ workspace, Type: schema, trackCalls: false });
    const read = tools.find(({ name }) => name === "workspace_read");
    const search = tools.find(({ name }) => name === "workspace_search");
    const excerpt = await read.execute("middle", { path: "notes.txt", startLine: 3, endLine: 5 });
    assert.doesNotMatch(excerpt.content[0].text, /sensitive-key-body/);
    assert.match(excerpt.content[0].text, /5: public tail/);
    assert.equal(excerpt.content[0].text.split("\n").length, 3);
    for (const path of [".", "notes.txt"]) {
      const result = await search.execute("search", { path, query: "sensitive-key-body" });
      assert.doesNotMatch(result.content[0].text, /sensitive-key-body/);
      const password = await search.execute("password", { path, query: "DB_PASSWORD" });
      assert.doesNotMatch(password.content[0].text, /xxxx|secret tail/);
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("workspace tools independently protect private directories and aliases in autonomous runs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-private-directories-"));
  try {
    await writeFile(join(workspace, "visible.txt"), "public marker");
    for (const name of [".codex", ".claude"]) {
      await mkdir(join(workspace, name));
      await writeFile(join(workspace, name, "config.json"), "private marker");
    }
    await symlink("visible.txt", join(workspace, ".env"));
    const tools = await createTaskWorkspaceTools({ workspace, Type: schema, trackCalls: false });
    const read = tools.find(({ name }) => name === "workspace_read");
    const search = tools.find(({ name }) => name === "workspace_search");
    const list = tools.find(({ name }) => name === "workspace_list");
    for (const name of [".codex", ".claude"]) {
      await assert.rejects(read.execute("private", { path: `${name}/config.json` }), /私密/);
      await assert.rejects(list.execute("private", { path: name }), /私密/);
    }
    await assert.rejects(read.execute("alias", { path: ".env" }), /私密/);
    assert.doesNotMatch((await list.execute("root", {})).content[0].text, /\.codex|\.claude|\.env/);
    assert.doesNotMatch((await search.execute("root", { query: "marker" })).content[0].text, /private marker/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("explicit workspace search reports an unreadable binary file instead of no matches", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-search-error-"));
  try {
    await writeFile(join(workspace, "binary.dat"), Buffer.from([65, 0, 66]));
    const tools = await createTaskWorkspaceTools({ workspace, Type: schema, trackCalls: false });
    const search = tools.find(({ name }) => name === "workspace_search");
    await assert.rejects(search.execute("binary", { path: "binary.dat", query: "missing" }), /文本文件/);
    const result = await search.execute("directory", { query: "missing" });
    assert.equal(result.details.skipped, 1);
    assert.equal(result.details.truncated, true);
    assert.match(result.content[0].text, /Search incomplete/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("uncooperative children cannot hold cancellation or overwrite a settled result", async () => {
  const controller = new AbortController();
  let release, childSignal;
  const updates = [];
  const scheduler = createTaskScheduler({ runTask(_task, { signal }) {
    childSignal = signal;
    return new Promise((resolve) => { release = resolve; });
  } });
  const pending = scheduler.run([task("stuck"), task("queued")], {
    signal: controller.signal, maxConcurrency: 1, onUpdate: value => updates.push(value),
  });
  await delay(5);
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, 2);
  assert.equal(childSignal.aborted, true);
  const count = updates.length;
  release("late result");
  await delay(5);
  assert.equal(updates.length, count);
  assert.equal(result.tasks[0].result, "");
});

test("per-task timeout releases the queue and skips dependent work", async () => {
  const scheduler = createTaskScheduler({ runTask(value) {
    return value.id === "stuck" ? new Promise(() => {}) : "ok";
  } });
  const result = await scheduler.run([
    task("stuck"), task("dependent", { dependsOn: ["stuck"] }), task("next"),
  ], { taskTimeoutMs: 15, maxConcurrency: 1 });
  assert.deepEqual(result.tasks.map(value => value.status), ["failed", "skipped", "completed"]);
  assert.match(result.tasks[0].error, /超时/);
});

test("subagent model calls count toward the harness token, cost and turn limits", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-child-budget-"));
  const workspace = join(temporary, "project");
  const harness = createHarness({ directory: join(temporary, "records") });
  await mkdir(workspace);
  await harness.attach(workspace, "parent-session");
  const status = await harness.run({ action: "status" });
  await harness.run({
    action: "configure",
    expectedWorkspace: status.workspace,
    expectedRevision: status.revision,
    settings: { ...HARNESS_DEFAULTS, maxTurns: 2, maxTokens: 100, maxCost: 0.1 },
  });
  try {
    await harness.start();
    assert.equal(await harness.beforeSubagentTurn(), "");
    assert.equal(await harness.externalUsage({
      input: 50, output: 55, cacheRead: 0, cacheWrite: 0, cost: { total: 0.11 },
    }), "tokens");
    assert.equal(harness.snapshot().state, "limited");
    assert.equal(harness.snapshot().usage.turns, 1);
    assert.equal(harness.snapshot().usage.tokens, 105);
    assert.equal(harness.snapshot().usage.cost, 0.11);
    assert.equal(harness.snapshot().reason, "tokens");
  } finally {
    await harness.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
