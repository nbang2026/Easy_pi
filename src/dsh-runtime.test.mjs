import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createDshRuntime, profilePatches, childEnvironment, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_PROTOCOL } from "../agent-runtime/dsh-runtime.mjs";
const require = createRequire(new URL("../agent-runtime/package.json", import.meta.url));
const library = { async run(request) { if (request.kind === "context") return { memoryEnabled: true, memories: [{ title: "Note", content: "Reference" }] }; if (request.kind === "agent") return { id: request.id, title: "Role", content: "Selected role" }; return { settings: {} }; } };
const waitFor = async (predicate, ms = 30000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw Error("Timed out waiting for Agent event."); await new Promise((r) => setTimeout(r, 10)); } };
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "easy-pi-dsh-test-")), cwd = join(root, "project"), home = join(root, "home"); await mkdir(cwd);
  const events = [], runtime = await createDshRuntime({ cwd, home, environment: {}, emit: (e) => events.push(e), library, ...options });
  return { root, cwd, home, runtime, events, async close() { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
function fakeSdk({ includeAgents = false } = {}) {
  const calls = [], instances = [];
  class DeepSeekHarness {
    constructor(options) { this.options = options; this.client = {}; instances.push(this); calls.push(["construct", options]); }
    async start() { calls.push(["start"]); }
    session(id) { calls.push(["session", id]); return this.handle(id); }
    async resumeSession(id) { calls.push(["resume", id]); return this.handle(id); }
    handle(id) { return { getWorkingDirectory: async () => this.options.cwd, run: async (prompt, { onNotification }) => {
      calls.push(["run", id, prompt]);
      for (const [seq, type, data] of [[0, "assistant/message", { message: { content: [{ type: "reasoning", text: "Actual provider thinking" }, { type: "text", text: "Actual answer" }] }, usage: { inputTokens: 3, outputTokens: 4 } }], [1, "tool/call", { callId: "tool1", name: "read", arguments: '{"path":"/tmp/a"}' }], [2, "tool/result", { message: { toolCallId: "tool1", content: [{ type: "text", text: "tool content" }] } }], [3, "turn/end", { reason: { kind: "completed" } }]]) onNotification({ method: "session.event", params: { sessionId: id, event: { seq, type, data } } });
      if (includeAgents) {
        onNotification({ method: "subagent.started", params: { parentSessionId: id, childSessionId: "child-agent-1" } });
        onNotification({ method: "session.event", params: { sessionId: "child-agent-1", event: { type: "subagent/descriptor", data: { label: "Review API safety" } } } });
        onNotification({ method: "session.status", params: { sessionId: "child-agent-1", status: "running" } });
        onNotification({ method: "session.event", params: { sessionId: "child-agent-1", event: { type: "tool/call", data: { name: "read" } } } });
        onNotification({ method: "subagent.finished", params: { parentSessionId: id, childSessionId: "child-agent-1", status: "ok", lastAssistantMessage: [{ type: "text", text: "Found one issue." }] } });
        onNotification({ method: "session.status", params: { sessionId: "child-agent-1", status: "idle" } });
      }
      return { sessionId: id, finalResponse: "Actual answer" };
    } }; }
    async close() { calls.push(["close"]); }
  }
  return { sdk: { DeepSeekHarness }, calls, instances };
}

test("DSH full access handles current and future approvals, restores prompts and isolates projects", async () => {
  const fake = fakeSdk(), decisions = [];
  let callbacks, running = false, release, canDecide = true;
  const gate = new Promise(resolve => { release = resolve; });
  const original = fake.sdk.DeepSeekHarness.prototype.handle;
  fake.sdk.DeepSeekHarness.prototype.handle = function(id) {
    const handle = original.call(this, id);
    return { ...handle, run: async (...args) => { running = true; await gate; return handle.run(...args); } };
  };
  const f = await fixture({ loadSdk: async () => fake.sdk, createBridge: async options => {
    callbacks = options;
    return { path: "/tmp/test-bridge", token: "test", close: async () => {}, decide: (id, allow) => { decisions.push([id, allow]); return canDecide; } };
  } });
  try {
    await f.runtime.handle({ action: "configure", apiKey: "test-key" });
    const ack = await f.runtime.handle({ action: "submit", text: "simple task" });
    await waitFor(() => running);
    const frame = (id, toolName = "bash") => ({ id, sessionId: ack.sessionId, toolName, input: { command: "pwd" } });
    callbacks.onApproval(frame("pending"));
    assert.equal(f.runtime.status().waitingApproval, true);
    const target = { expectedWorkspace: f.runtime.status().cwd, expectedSessionId: ack.sessionId };
    await assert.rejects(f.runtime.handle({ action: "permissions", mode: "full", ...target, expectedSessionId: "old" }), /target changed/);
    await f.runtime.handle({ action: "permissions", mode: "full", ...target });
    assert.equal((await f.runtime.handle({action:"library",request:{kind:"list"}})).executionMode,"autonomous");
    assert.deepEqual(decisions, [["pending", true]]);
    callbacks.onApproval(frame("future"));
    assert.deepEqual(decisions.at(-1), ["future", true]);
    assert.equal(f.events.filter(event => event.type === "approval").length, 1);
    callbacks.onApproval(frame("question", "AskUserQuestion"));
    await f.runtime.handle({ action: "permissions", mode: "full", ...target });
    assert.equal(f.runtime.status().waitingApproval, true);
    assert.equal(decisions.some(([id]) => id === "question"), false);
    await f.runtime.handle({ action: "approval", approvalId: "question", allow: false });
    await f.runtime.handle({ action: "permissions", mode: "ask", ...target });
    assert.equal((await f.runtime.handle({action:"library",request:{kind:"list"}})).executionMode,"confirm");
    callbacks.onApproval(frame("restored"));
    assert.equal(f.runtime.status().waitingApproval, true);
    await f.runtime.handle({ action: "approval", approvalId: "restored", allow: false });
    assert.deepEqual(decisions.at(-1), ["restored", false]);
    callbacks.onApproval(frame("failed-full")); canDecide = false;
    await assert.rejects(f.runtime.handle({ action: "permissions", mode: "full", ...target }), /no longer pending/);
    assert.equal(f.runtime.status().permissionMode, "ask");
    assert.equal(f.runtime.status().waitingApproval, true);
    canDecide = true;
    await f.runtime.handle({ action: "approval", approvalId: "failed-full", allow: false });
    release(); await waitFor(() => !f.runtime.status().busy);
    await f.runtime.handle({ action: "permissions", mode: "full", ...target });
    const other = join(f.root, "other"); await mkdir(other);
    await f.runtime.handle({ action: "workspace", cwd: other });
    assert.equal(f.runtime.status().permissionMode, "ask");
  } finally { release(); await f.close(); }
});

test("stop finishes an uncooperative prompt and stale failure or bridge callbacks cannot stop its replacement", { timeout: 10000 }, async () => {
  const fake = fakeSdk(), callbacks = [];
  let rejectOld, finishNew, started = 0;
  const oldGate = new Promise((resolve, reject) => { rejectOld = reject; });
  const newGate = new Promise(resolve => { finishNew = resolve; });
  const original = fake.sdk.DeepSeekHarness.prototype.handle;
  fake.sdk.DeepSeekHarness.prototype.handle = function(id) {
    const handle = original.call(this, id);
    const first = fake.instances.indexOf(this) === 0;
    return { ...handle, run: async (...args) => { started++; await (first ? oldGate : newGate); return handle.run(...args); } };
  };
  const f = await fixture({ loadSdk: async () => fake.sdk, createBridge: async options => {
    callbacks.push(options);
    return { path: "/tmp/test-bridge", token: "test", close: async () => {}, decide: () => true };
  } });
  try {
    await f.runtime.handle({ action: "configure", apiKey: "test-key" });
    const first = await f.runtime.handle({ action: "submit", text: "first long task" });
    await waitFor(() => started === 1);
    const stopped = await f.runtime.handle({ action: "stop" });
    assert.equal(stopped.busy, false);
    assert.equal(f.events.filter(event => event.type === "result" && event.runId === first.runId).length, 1);
    const second = await f.runtime.handle({ action: "submit", text: "second task" });
    await waitFor(() => started === 2);
    assert.equal(f.runtime.status().busy, true);
    assert.equal(fake.instances.length, 2);
    callbacks[0].onDisconnect();
    rejectOld(new Error("Old task rejected after stop"));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.runtime.status().busy, true);
    assert.equal(fake.calls.filter(([action]) => action === "close").length, 1);
    assert.equal(f.events.filter(event => event.type === "result" && event.runId === first.runId).length, 1);
    assert.equal(f.events.some(event => event.type === "result" && event.runId === second.runId), false);
    finishNew(); await waitFor(() => !f.runtime.status().busy);
    assert.equal(f.events.filter(event => event.type === "result" && event.runId === second.runId).length, 1);
    assert.equal(f.events.find(event => event.type === "result" && event.runId === second.runId).error, undefined);
  } finally { rejectOld(new Error("Fixture cleanup")); finishNew(); await f.close(); }
});

test("stopping during resource lookup prevents a late lookup from launching any native task", { timeout: 10000 }, async () => {
  const fake = fakeSdk(); let releaseLookup, requested = false;
  const gate = new Promise(resolve => { releaseLookup = resolve; });
  const f = await fixture({ loadSdk: async () => fake.sdk, library: { ...library, async run(request, authority) {
    if (request.kind === "context") { requested = true; await gate; }
    return library.run(request, authority);
  } } });
  try {
    await f.runtime.handle({ action: "configure", apiKey: "test-key" });
    await f.runtime.handle({ action: "submit", text: "waiting for context" });
    await waitFor(() => requested);
    assert.equal((await f.runtime.handle({ action: "stop" })).busy, false);
    releaseLookup(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fake.instances.length, 0);
    assert.equal(f.runtime.status().busy, false);
  } finally { releaseLookup(); await f.close(); }
});

test("failed native process cleanup reports an error and prevents unsafe resubmission", { timeout: 10000 }, async () => {
  const fake = fakeSdk(); let started = false, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const original = fake.sdk.DeepSeekHarness.prototype.handle;
  fake.sdk.DeepSeekHarness.prototype.handle = function(id) {
    const handle = original.call(this, id);
    return { ...handle, run: async (...args) => { started = true; await gate; return handle.run(...args); } };
  };
  fake.sdk.DeepSeekHarness.prototype.close = async () => { throw new Error("Owned process cleanup failed"); };
  const f = await fixture({ loadSdk: async () => fake.sdk, createBridge: async () => ({
    path: "/tmp/test-bridge", token: "test", close: async () => {}, decide: () => true,
  }) });
  try {
    await f.runtime.handle({ action: "configure", apiKey: "test-key" });
    const first = await f.runtime.handle({ action: "submit", text: "first task" });
    await waitFor(() => started);
    await assert.rejects(f.runtime.handle({ action: "stop" }), /cleanup failed/);
    assert.equal(f.runtime.status().busy, false);
    assert.equal(f.runtime.status().ready, false);
    assert.match(f.runtime.status().error, /cleanup failed/);
    await assert.rejects(f.runtime.handle({ action: "submit", text: "unsafe replacement" }), /cleanup was not confirmed/);
    finish(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.events.filter(event => event.type === "result" && event.runId === first.runId).length, 1);
    assert.equal(fake.instances.length, 1);
  } finally { finish(); await f.close(); }
});

test("status/configure isolate explicit credentials and expose no secret", async () => {
  const f = await fixture({ environment: { ANTHROPIC_API_KEY: "do-not-inherit", OPENAI_API_KEY: "pi-key" } });
  try {
    assert.equal(f.runtime.status().configured, false); assert.equal(f.runtime.status().model, DEFAULT_MODEL);
    const status = await f.runtime.handle({ action: "configure", apiKey: "unique-secret-key", protocol: "deepseek-messages", baseUrl: DEFAULT_BASE_URL, thinking: "on", effort: "high" });
    assert.equal(status.configured, true); assert.equal(status.thinking, "on"); assert.equal(status.effort, "high"); assert.equal(status.protocol, "deepseek-messages");
    assert.doesNotMatch(JSON.stringify(status), /unique-secret-key/);
    assert.equal(f.runtime.errorText(Error("unique-secret-key")), "[redacted]");
    await assert.rejects(f.runtime.handle({ action: "configure", baseUrl: "https://key:secret@example.com" }), /Base URL/);
    await assert.rejects(f.runtime.handle({ action: "configure", baseUrl: "http://example.com" }), /Base URL/);
    await f.runtime.handle({ action: "configure", thinking: "on", effort: "max" });
    assert.equal((await f.runtime.handle({ action: "configure", thinking: "auto" })).effort, "", "Omitted effort restores the model default.");
    await f.runtime.handle({ action: "configure", thinking: "on", effort: "max" });
    const off = await f.runtime.handle({ action: "configure", thinking: "off" });
    assert.equal(off.thinking, "off"); assert.equal(off.effort, "", "Thinking off clears the prior effort override.");
    await assert.rejects(f.runtime.handle({ action: "configure", thinking: "off", effort: "high" }), /effort/);
  } finally { await f.close(); }
});

test("profile uses exact native DSH routes and env references only", () => {
  const p = profilePatches({ protocol: "deepseek-messages", model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL, thinking: "on", effort: "max" }, "/tmp/sessions");
  assert.equal(p.provider, "deepseek-official"); assert.equal(p.patches[0].config.thinking, "enabled"); assert.equal(p.patches[0].config.reasoningEffort, "max");
  assert.equal(p.patches[0].config.apiKeyEnv, "EASY_PI_DSH_API_KEY");
  const generic = profilePatches({ protocol: "openai-completions", model: "custom-model", baseUrl: "https://example.com/v1", thinking: "auto" }, "/tmp/sessions");
  assert.equal(generic.patches[0].disabled, true);
  const genericPlugins = generic.patches.find((patch) => patch.insert).insert;
  assert.equal(genericPlugins.find((plugin) => plugin.id === "easy-pi-provider").config.providers["easy-pi-agent"].api, "openai-completions");
  const env = childEnvironment({ PATH: "/bin", NODE_OPTIONS: "evil", DEEPSEEK_API_KEY: "foreign", OPENAI_API_KEY: "pi" }, "/isolated", { apiKey: "explicit" }, { path: "/socket", token: "token" });
  assert.equal(env.EASY_PI_DSH_API_KEY, "explicit"); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.DEEPSEEK_API_KEY, undefined);
  const skillPath = "/private/skills/runtime/code-review";
  const configured = profilePatches({ protocol: DEFAULT_PROTOCOL, model: DEFAULT_MODEL, maxActiveSubagents: 4 }, "/tmp/sessions", undefined, {
    enabledSkillPaths: [skillPath],
  });
  const plugins = configured.patches.find((patch) => patch.insert)?.insert;
  const skills = plugins.find((plugin) => plugin.id === "easy-pi-skill-filesystem");
  assert.deepEqual(skills.config.customSkillDirs, [dirname(skillPath)]);
  assert.equal(skills.config.includeDefaultRoots, false);
  assert.equal(plugins.find((plugin) => plugin.id === "easy-pi-subagents").config.maxActiveSubagents, 4);
  for (const paths of [[4], ["/tmp/skills\0bad"], Array(129).fill("/tmp/skill")]) {
    assert.throws(() => profilePatches({ protocol: DEFAULT_PROTOCOL, model: DEFAULT_MODEL }, "/tmp/sessions", undefined, { enabledSkillPaths: paths }), /Skill paths/);
  }
  for (const maxActiveSubagents of [0, 5, 1.5]) {
    assert.throws(() => profilePatches({ protocol: DEFAULT_PROTOCOL, model: DEFAULT_MODEL, maxActiveSubagents }, "/tmp/sessions"), /parallel Agent limit/);
  }
});

test("parallel Agent limit is configurable, bounded, and reported without exposing credentials", async () => {
  const f = await fixture();
  try {
    assert.equal(f.runtime.status().maxActiveSubagents, 3);
    const configured = await f.runtime.handle({ action: "configure", apiKey: "private-agent-key", maxActiveSubagents: 4 });
    assert.equal(configured.maxActiveSubagents, 4);
    assert.doesNotMatch(JSON.stringify(configured), /private-agent-key/);
    await assert.rejects(f.runtime.handle({ action: "configure", maxActiveSubagents: 0 }), /between 1 and 4/);
    await assert.rejects(f.runtime.handle({ action: "configure", maxActiveSubagents: 5 }), /between 1 and 4/);
    assert.equal(f.runtime.status().maxActiveSubagents, 4);
  } finally { await f.close(); }
});

test("enabled Skills are injected from one snapshot and a Skill revision reloads DSH on the next run", async () => {
  const fake = fakeSdk();
  const skillOne = "/tmp/skill-store/runtime/first-skill";
  const skillTwo = "/tmp/skill-store/runtime/second-skill";
  let snapshot = { revision: 1, paths: [skillOne] };
  const f = await fixture({
    loadSdk: async () => fake.sdk,
    createBridge: async () => ({ path: "/tmp/test-bridge", token: "test", close: async () => {}, decide: () => true }),
    library: { ...library, enabledSkillSnapshot: async () => structuredClone(snapshot) },
  });
  try {
    await f.runtime.handle({ action: "configure", apiKey: "private-agent-key", maxActiveSubagents: 2 });
    await f.runtime.handle({ action: "submit", text: "Use the first Skill." });
    await waitFor(() => !f.runtime.status().busy);
    const firstPatch = JSON.parse(await readFile(fake.instances[0].options.patches[0], "utf8"));
    const firstPlugins = firstPatch.find((patch) => patch.insert).insert;
    assert.deepEqual(firstPlugins.find((plugin) => plugin.id === "easy-pi-skill-filesystem").config.customSkillDirs, [dirname(skillOne)]);
    assert.equal(firstPlugins.some((plugin) => plugin.id === "easy-pi-subagents"), false, "simple tasks do not load subagent tools");
    snapshot = { revision: 2, paths: [skillOne, skillTwo] };
    await f.runtime.handle({ action: "submit", text: "Use the updated Skill set." });
    await waitFor(() => !f.runtime.status().busy);
    assert.equal(fake.instances.length, 2);
    const secondPatch = JSON.parse(await readFile(fake.instances[1].options.patches[0], "utf8"));
    const secondPlugins = secondPatch.find((patch) => patch.insert).insert;
    assert.deepEqual(secondPlugins.find((plugin) => plugin.id === "easy-pi-skill-filesystem").config.customSkillDirs, [dirname(skillOne)]);
    assert.equal(secondPlugins.some((plugin) => plugin.id === "easy-pi-subagents"), false, "simple tasks keep subagent tools disabled after a Skill reload");
  } finally { await f.close(); }
});

test("subagent notifications publish bounded labelled activity, terminal state and durable results", async () => {
  const fake = fakeSdk({ includeAgents: true });
  const f = await fixture({
    loadSdk: async () => fake.sdk,
    createBridge: async () => ({ path: "/tmp/test-bridge", token: "test", close: async () => {}, decide: () => true }),
  });
  try {
    await f.runtime.handle({ action: "configure", apiKey: "private-agent-key" });
    const submitted = await f.runtime.handle({ action: "submit", text: "Delegate a review." });
    await waitFor(() => !f.runtime.status().busy);
    const agentEvents = f.events.filter((event) => event.type === "agent");
    assert.ok(agentEvents.some((event) => event.status === "running"));
    assert.ok(agentEvents.some((event) => event.label === "Review API safety"));
    assert.ok(agentEvents.some((event) => event.activity === "Using read"));
    assert.ok(agentEvents.some((event) => event.status === "completed" && event.result === "Found one issue."));
    const replay = await f.runtime.handle({ action: "resume", sessionId: submitted.sessionId });
    assert.ok(replay.history.some((event) => event.type === "agent" && event.status === "completed" && event.result === "Found one issue."));
  } finally { await f.close(); }
});

test("official API injection drives real event normalization, persisted display and native resume", async () => {
  const fake = fakeSdk(), f = await fixture({
    loadSdk: async () => fake.sdk,
    createBridge: async () => ({ path: "/tmp/test-bridge", token: "test", close: async () => {}, decide: () => true }),
  });
  try {
    await f.runtime.handle({ action: "configure", apiKey: "unique-secret", thinking: "auto" });
    const submitted = await f.runtime.handle({ action: "submit", text: "Read selected file", roleId: "role1", attachments: [{ path: join(f.cwd, "a.txt"), name: "a.txt" }] });
    await waitFor(() => f.events.some((e) => e.type === "result")); await waitFor(() => !f.runtime.status().busy);
    assert.ok(f.events.some((e) => e.type === "thinking" && e.text === "Actual provider thinking"));
    assert.ok(f.events.some((e) => e.type === "tool" && e.toolId === "tool1" && e.status === "complete"));
    const options = fake.instances[0].options; assert.equal(options.profile, "sdk-minimal"); assert.equal(options.provider, "deepseek-official"); assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.match(fake.calls.find(([name]) => name === "run")[2], /Selected role/);
    const index = await readFile(join(f.home, "dsh/sidecar-sessions/index.json"), "utf8"); assert.doesNotMatch(index, /unique-secret/);
    await f.runtime.handle({ action: "resume", sessionId: submitted.sessionId });
    const replay = await f.runtime.handle({ action: "resume", sessionId: submitted.sessionId }); assert.ok(replay.history.some((e) => e.type === "text"));
    await f.runtime.handle({ action: "submit", text: "Continue" }); await waitFor(() => fake.calls.some(([name]) => name === "resume")); await waitFor(() => !f.runtime.status().busy);
    assert.equal(fake.calls.find(([name]) => name === "resume")[1], submitted.sessionId);
    await assert.rejects(f.runtime.handle({ action: "library", request: { kind: "settings", activeAgent: "pi-role" } }), /independent/);
    await assert.rejects(f.runtime.handle({ action: "unknown" }), /Unsupported/);
  } finally { await f.close(); }
});

function openAiMessage(response, first, filename, model) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "openai-message", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ role: "assistant", content: "" });
  if (first) {
    chunk({ reasoning_content: "OpenAI native reasoning_content." });
    chunk({ tool_calls: [{ index: 0, id: "openai-write", type: "function", function: { name: "write", arguments: JSON.stringify({ file_path: filename, content: "openai native tool output" }) } }] });
    chunk({}, "tool_calls");
  } else { chunk({ content: "OpenAI native loop finished." }); chunk({}, "stop"); }
  response.end("data: [DONE]\n\n");
}

function streamMessage(response, blocks, stop = "end_turn") {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const event = (value) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({ type: "message_start", message: { id: "msg-" + Math.random(), type: "message", role: "assistant", model: DEFAULT_MODEL, content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
  for (const [index, block] of blocks.entries()) {
    if (block.type === "thinking") {
      event({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      event({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.text } });
      event({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "native-signature" } });
    } else if (block.type === "tool_use") {
      event({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else {
      event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      event({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    }
    event({ type: "content_block_stop", index });
  }
  event({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }); event({ type: "message_stop" }); response.end();
}

for (const protocol of ["openai-completions", "anthropic-messages"]) test(`real DSH generic ${protocol} native tool loop and thinking replay`, { timeout: 45000 }, async () => {
  const requests = []; let filename;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const data = JSON.parse(body); requests.push({ url: request.url, data });
    if (protocol === "openai-completions") openAiMessage(response, requests.length === 1, filename, data.model);
    else streamMessage(response, requests.length === 1 ? [{ type: "thinking", text: "Compatible provider native thinking." }, { type: "tool_use", id: "openai-write", name: "write", input: { file_path: filename, content: "openai native tool output" } }] : [{ type: "text", text: "OpenAI native loop finished." }], requests.length === 1 ? "tool_use" : "end_turn");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const f = await fixture(); filename = join(f.cwd, "generic-output.txt");
  try {
    await f.runtime.handle({ action: "configure", apiKey: "offline-generic-placeholder", protocol, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "generic-test-model", thinking: "auto" });
    await f.runtime.handle({ action: "submit", text: "Write fixture output." });
    await waitFor(() => f.events.some((e) => e.type === "approval") || f.events.some((e) => e.type === "result"));
    const approval = f.events.find((e) => e.type === "approval"); assert.ok(approval, JSON.stringify(f.events));
    await assert.rejects(access(filename));
    await f.runtime.handle({ action: "approval", approvalId: approval.approvalId, allow: true });
    await waitFor(() => !f.runtime.status().busy);
    assert.equal(f.events.find((e) => e.type === "result").error, undefined, JSON.stringify(f.events));
    assert.equal(await readFile(filename, "utf8"), "openai native tool output");
    assert.ok(f.events.some((e) => e.type === "thinking" && e.text.includes(protocol === "openai-completions" ? "reasoning_content" : "native thinking")));
    assert.ok(f.events.some((e) => e.type === "tool" && e.toolId === "openai-write" && e.status === "complete"));
    assert.equal(requests.length, 2);
    if (protocol === "openai-completions") {
      assert.equal(requests[0].url, "/v1/chat/completions");
      assert.ok(requests[1].data.messages.some((m) => m.reasoning_content?.includes("reasoning_content")), JSON.stringify(requests[1].data.messages));
      assert.ok(requests[1].data.messages.some((m) => m.role === "tool" && m.tool_call_id === "openai-write"));
    } else assert.ok(requests[1].data.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "thinking" && c.thinking.includes("native thinking"))));
  } finally { await f.close(); await new Promise((done) => server.close(done)); }
});

test("actual official SDK boot initializes without credentials or model traffic", { timeout: 40000 }, async () => {
  const { DeepSeekHarness } = await import(require.resolve("@deepseek-ai/dsh-sdk-client"));
  const { createApprovalBridge } = await import("../agent-runtime/dsh-adapter.mjs");
  const root = await mkdtemp(join(tmpdir(), "easy-pi-dsh-boot-test-")); const bridge = await createApprovalBridge();
  const patch = join(root, "patch.json"); await writeFile(patch, JSON.stringify(profilePatches({ protocol: "deepseek-messages", model: DEFAULT_MODEL, thinking: "auto", baseUrl: DEFAULT_BASE_URL }, join(root, "sessions")).patches));
  const h = new DeepSeekHarness({ cwd: root, processCwd: root, dshHome: root, profile: "sdk-minimal", patches: [patch], initializeTimeoutMs: 20000, env: { PATH: process.env.PATH, HOME: root, DSH_TELEMETRY_DISABLED: "1", EASY_PI_DSH_BRIDGE: bridge.path, EASY_PI_DSH_BRIDGE_TOKEN: bridge.token } });
  try { await h.start(); assert.equal(await h.session().getWorkingDirectory(), root); } finally { await h.close(); await bridge.close(); await rm(root, { recursive: true, force: true }); }
});

for (const allow of [false, true, "stop"]) test(`real DSH native reasoning/tool/approval loop (allow=${allow}) uses only a local fake model`, { timeout: 45000 }, async () => {
  const requests = [], failures = [];
  let filename;
  const server = createServer(async (request, response) => {
    try {
      let body = ""; for await (const chunk of request) body += chunk;
      const data = JSON.parse(body); requests.push({ url: request.url, headers: request.headers, data });
      if (requests.length === 1) streamMessage(response, [{ type: "thinking", text: "Native reasoning from the local test provider." }, { type: "tool_use", id: "write-call", name: "write", input: { file_path: filename, content: "approved native tool output" } }], "tool_use");
      else streamMessage(response, [{ type: "text", text: "Native DSH loop finished." }]);
    } catch (error) { failures.push(error); response.writeHead(500); response.end("fixture error"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture(); filename = join(f.cwd, "native-output.txt");
  try {
    await f.runtime.handle({ action: "configure", apiKey: "offline-placeholder", baseUrl: `http://127.0.0.1:${server.address().port}/anthropic`, protocol: "deepseek-messages", model: DEFAULT_MODEL, thinking: "on", effort: "high" });
    await f.runtime.handle({ action: "submit", text: "Write the test file." });
    await waitFor(() => f.events.some((e) => e.type === "approval") || f.events.some((e) => e.type === "result"));
    const approval = f.events.find((e) => e.type === "approval");
    assert.ok(approval, JSON.stringify(f.events));
    await assert.rejects(access(filename)); assert.equal(f.runtime.status().waitingApproval, true);
    assert.equal(approval.toolName, "write");
    if (allow === "stop") {
      await f.runtime.handle({ action: "stop" }); await waitFor(() => !f.runtime.status().busy);
      await assert.rejects(access(filename));
      assert.ok(f.events.some((e) => e.type === "result" && /stopped/i.test(e.error)));
      await assert.rejects(f.runtime.handle({ action: "approval", approvalId: approval.approvalId, allow: true }), /expired/);
      return;
    }
    await f.runtime.handle({ action: "approval", approvalId: approval.approvalId, allow });
    await waitFor(() => !f.runtime.status().busy);
    const result = f.events.find((e) => e.type === "result"); assert.equal(result.error, undefined, JSON.stringify(f.events));
    assert.ok(f.events.some((e) => e.type === "thinking" && e.text.includes("Native reasoning")));
    assert.ok(f.events.some((e) => e.type === "text" && e.text.includes("Native DSH loop finished")));
    assert.ok(f.events.some((e) => e.type === "tool" && e.toolId === "write-call" && e.status === (allow ? "complete" : "error")), JSON.stringify(f.events));
    if (allow) assert.equal(await readFile(filename, "utf8"), "approved native tool output"); else await assert.rejects(access(filename));
    assert.equal(requests.length, 2); assert.equal(requests[0].url, "/anthropic/v1/messages");
    assert.equal(requests[0].headers["x-api-key"], "offline-placeholder");
    assert.equal(requests[0].data.thinking.type, "enabled");
    assert.ok(requests[1].data.messages.some((m) => m.content.some((c) => c.type === "thinking" && c.thinking.includes("Native reasoning"))));
    assert.deepEqual(failures, []);
    if (allow) {
      const id = f.runtime.status().sessionId;
      await f.runtime.handle({ action: "resume", sessionId: id });
      await f.runtime.handle({ action: "submit", text: "Continue persisted native history." });
      await waitFor(() => !f.runtime.status().busy);
      assert.equal(f.events.filter((e) => e.type === "result").at(-1).error, undefined, JSON.stringify(f.events));
      assert.equal(requests.length, 3);
      assert.ok(requests[2].data.messages.some((m) => m.content.some((c) => c.type === "tool_result" && c.tool_use_id === "write-call")));
    }
    await assert.rejects(f.runtime.handle({ action: "approval", approvalId: approval.approvalId, allow: true }), /expired/);
  } finally { await f.close(); await new Promise((resolve) => server.close(resolve)); }
});
