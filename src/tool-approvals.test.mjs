import test from "node:test";
// Trusting executable project resources is separate from blanket tool access.
test("allow all tools never approves project trust; explicit trust is session-bound", async () => {
  const approvals = createToolApprovals();
  try {
    const waiting = approvals.request({ scope: "project_trust", toolName: "project_trust", input: { workspace: "project" }, sessionId: "", runId: "" });
    approvals.allowAll("");
    assert.equal(approvals.list().length, 1);
    const request = approvals.list()[0];
    assert.throws(() => approvals.decide({ ...request, allow: true }, "wrong-session"));
    approvals.decide({ ...request, allow: false }, "");
    assert.equal(await waiting, false);
  } finally { approvals.cancelAll(); }
});
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, HARNESS_DEFAULTS } from "../src-tauri/src/gui-harness.mjs";
import { createToolApprovals } from "../src-tauri/src/gui-approvals.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await tick(); } assert.fail("Approval did not arrive"); }
async function fixture(mode = "project") {
  const root = await mkdtemp(join(tmpdir(), "pi-approval-"));
  const workspace = join(root, "project");
  await mkdir(workspace); await writeFile(join(workspace, "file.txt"), "original");
  const events = [];
  const approvals = createToolApprovals({ emit: value => events.push(value) });
  const harness = createHarness({ directory: join(root, "records"), requestApproval: value => approvals.request(value) });
  await harness.attach(workspace, "session-1");
  const status = await harness.run({ action: "status" });
  await harness.run({ action: "configure", settings: { ...HARNESS_DEFAULTS, mode }, expectedWorkspace: status.workspace, expectedRevision: status.revision });
  await harness.start();
  return { root, workspace, harness, approvals, events, close: async () => { approvals.cancelAll(); await harness.dispose(); await rm(root, { recursive: true, force: true }); } };
}
const shell = id => ({ toolCallId: id, toolName: "bash", input: { command: "printf safe" } });

test("user can change live permissions without resetting budgets; stale or model changes fail", async () => {
  const f = await fixture();
  try {
    const before = await f.harness.run({ action: "status" });
    const request = { action: "permissions", mode: "autonomous", expectedWorkspace: before.workspace, expectedRevision: before.revision };
    await assert.rejects(f.harness.run(request, "model"), /用户/);
    await assert.rejects(f.harness.run({ ...request, expectedWorkspace: "/other" }), /变化/);
    await assert.rejects(f.harness.run({ ...request, expectedRevision: "old" }), /修改/);
    const waiting = f.harness.beforeTool(shell("pending-full"));
    await until(() => f.approvals.list().length === 1);
    const updated = await f.harness.run(request);
    assert.deepEqual(updated.current.limits, { ...before.current.limits, mode: "autonomous" });
    f.approvals.allowAll("wrong-session"); assert.equal(f.approvals.list().length, 1);
    f.approvals.allowAll("session-1"); assert.deepEqual(await waiting, {});
    assert.deepEqual(await f.harness.beforeTool(shell("future-full")), {});
    assert.equal(f.approvals.list().length, 0);
    assert.equal(f.harness.snapshot().usage.toolCalls, 2);
    assert.ok(updated.current.events.some(event => event.type === "permission_mode"));
    await f.harness.run({ ...request, mode: "confirm", expectedRevision: updated.revision });
    const restored = f.harness.beforeTool(shell("restored"));
    await until(() => f.approvals.list().length === 1);
    f.approvals.decide({ ...f.approvals.list()[0], allow: false }, "session-1");
    assert.equal((await restored).block, true);
  } finally { await f.close(); }
});

test("project shell waits for approval without blocking status and each invocation needs a new grant", async () => {
  const f = await fixture();
  try {
    let done = false;
    const first = f.harness.beforeTool(shell("one")).then(value => { done = true; return value; });
    await until(() => f.approvals.list().length === 1);
    assert.equal(done, false);
    assert.equal((await f.harness.run({ action: "status" })).current.pending.length, 0);
    const [approval] = f.approvals.list();
    assert.throws(() => f.approvals.decide({ ...approval, allow: true }, "wrong-session"));
    assert.equal(done, false);
    f.approvals.decide({ ...approval, allow: true }, "session-1");
    assert.deepEqual(await first, {});
    assert.throws(() => f.approvals.decide({ ...approval, allow: true }, "session-1"));
    assert.equal(f.harness.snapshot().pending.length, 1);
    const second = f.harness.beforeTool(shell("two"));
    await until(() => f.approvals.list().length === 1);
    f.approvals.decide({ ...f.approvals.list()[0], allow: false }, "session-1");
    assert.equal((await second).block, true);
  } finally { await f.close(); }
});

test("stop cancels a pending approval immediately and a stale allow cannot restart the tool", async () => {
  const f = await fixture();
  try {
    const waiting = f.harness.beforeTool(shell("stop"));
    await until(() => f.approvals.list().length);
    const approval = f.approvals.list()[0];
    await f.harness.end("cancelled");
    assert.equal((await waiting).block, true);
    assert.equal(f.approvals.list().length, 0);
    assert.throws(() => f.approvals.decide({ ...approval, allow: true }, "session-1"));
    assert.equal(f.harness.snapshot().pending.length, 0);
  } finally { await f.close(); }
});

test("readonly hard denies edits and shell; confirm mode approves edits but not secret paths", async () => {
  for (const mode of ["readonly", "confirm"]) {
    const f = await fixture(mode);
    try {
      await writeFile(join(f.workspace, ".env"), "SECRET=private");
      assert.equal((await f.harness.beforeTool({ toolCallId: "secret", toolName: "edit", input: { path: ".env" } })).block, true);
      assert.equal(f.approvals.list().length, 0);
      const write = f.harness.beforeTool({ toolCallId: "edit", toolName: "write", input: { path: "file.txt", content: "changed" } });
      if (mode === "readonly") {
        assert.equal((await write).block, true);
        assert.equal((await f.harness.beforeTool(shell("shell"))).block, true);
      } else {
        await until(() => f.approvals.list().length);
        assert.equal(await readFile(join(f.workspace, "file.txt"), "utf8"), "original");
        f.approvals.decide({ ...f.approvals.list()[0], allow: true }, "session-1");
        assert.deepEqual(await write, {});
      }
    } finally { await f.close(); }
  }
});

test("session switches cancel pending approvals and changed arguments fail closed", async () => {
  const f = await fixture();
  try {
    const call = shell("mutated");
    const waiting = f.harness.beforeTool(call);
    await until(() => f.approvals.list().length);
    call.input.command = "rm -rf unexpected";
    f.approvals.decide({ ...f.approvals.list()[0], allow: true }, "session-1");
    assert.equal((await waiting).block, true);
    const switching = f.harness.beforeTool(shell("switching"));
    await until(() => f.approvals.list().length);
    await f.harness.attach(f.workspace, "session-2");
    assert.equal((await switching).block, true);
    assert.equal(f.approvals.list().length, 0);
  } finally { await f.close(); }
});

test("paths are revalidated after approval and cannot escape through a replacement symlink", async () => {
  const f = await fixture("confirm");
  try {
    const waiting = f.harness.beforeTool({ toolCallId: "path", toolName: "edit", input: { path: "file.txt" } });
    await until(() => f.approvals.list().length);
    const outside = join(f.root, "outside.txt"); await writeFile(outside, "outside");
    await rename(join(f.workspace, "file.txt"), join(f.workspace, "saved.txt"));
    await symlink(outside, join(f.workspace, "file.txt"));
    f.approvals.decide({ ...f.approvals.list()[0], allow: true }, "session-1");
    assert.equal((await waiting).block, true);
  } finally { await f.close(); }
});

test("approval timeout and abort deny; visible commands redact credentials", async () => {
  const events = [], approvals = createToolApprovals({ emit: value => events.push(value), timeoutMs: 15 });
  const timed = approvals.request({ ...shell("secret"), input: { command: "API_KEY=sk-private-secret-value curl -H 'Authorization: Bearer secret-token-value' https://example.test" }, sessionId: "s" });
  const [visible] = approvals.list();
  assert.doesNotMatch(visible.operation, /sk-private-secret-value|secret-token-value/);
  await tick(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(await timed, false);
  const controller = new AbortController();
  const aborted = approvals.request({ ...shell("abort"), sessionId: "s", signal: controller.signal });
  controller.abort(); assert.equal(await aborted, false);
  assert.equal(approvals.list().length, 0);
  assert.equal(events.filter(value => value.type === "approval_resolved").length, 2);
});

test("approval commands redact quoted secrets before JSON escaping", async () => {
  const approvals = createToolApprovals({});
  const waiting = approvals.request({
    ...shell("quoted"),
    input: { command: 'DB_PASSWORD="first secret second secret" printf safe', password: "another private value" },
    sessionId: "s",
  });
  try {
    const [visible] = approvals.list();
    assert.doesNotMatch(visible.operation, /first secret|second secret|another private value/);
    assert.match(visible.operation, /printf safe/);
    assert.equal(JSON.parse(visible.operation).password, "[redacted]");
  } finally { approvals.cancelAll(); }
  assert.equal(await waiting, false);
});
