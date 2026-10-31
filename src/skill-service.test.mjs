import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createSkillLibrary } from "../src-tauri/src/gui-skills.mjs";
import { serveSkillService, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from "../src-tauri/src/skill-service.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function bundle() {
  const bytes = Buffer.from("---\nname: service-test\ndescription: Exercise the dedicated service.\nallowed-tools: Bash\n---\n# Complete skill\n");
  const files = [{ path: "SKILL.md", bytes, sha256: hash(bytes) }];
  return { source: "github", url: "https://github.com/example/skills/tree/main/service-test", repoUrl: "https://github.com/example/skills", owner: "example", repo: "skills", path: "service-test", commit: "a".repeat(40), totalBytes: bytes.length, treeHash: hash(`SKILL.md\0${hash(bytes)}\n`), files };
}
function transport(library) {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = new Map();
  const frames = [];
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      frames.push(frame);
      responses.get(frame.id)?.(frame);
      responses.delete(frame.id);
    }
  });
  const service = serveSkillService({ input, output, library });
  let sequence = 0;
  return {
    input, output, service, frames,
    action(request) {
      const id = String(++sequence);
      const result = new Promise((resolve) => responses.set(id, resolve));
      input.write(`${JSON.stringify({ id, text: JSON.stringify(request) })}\n`);
      return result.then((response) => { if (!response.ok) throw new Error(response.error.message); return response.data; });
    },
    async close() { service.close(); await service.settled(); input.destroy(); output.destroy(); },
  };
}
async function ready(client) {
  const { jobId } = await client.action({ action: "preview", source: "github", url: bundle().url });
  for (let i = 0; i < 200; i++) {
    const job = await client.action({ action: "job", jobId });
    if (job.state !== "running") return job;
    await new Promise((done) => setTimeout(done, 1));
  }
  throw new Error("Preview did not finish.");
}

test("dedicated transport retains previews through install/read/enable and shares durable runtime paths", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-service-store-"));
  const sources = { resolveBundle: async () => bundle() };
  let library = createSkillLibrary({ directory, sources });
  let client = transport(library);
  try {
    assert.deepEqual(await client.action({ action: "status" }), { revision: 0, installed: 0, enabled: [] });
    assert.deepEqual(await readdir(directory), []);
    const preview = await ready(client);
    assert.equal(preview.state, "ready", preview.error);
    assert.deepEqual(await client.action({ action: "preview_read", token: preview.preview.token, hash: preview.preview.hash, path: "SKILL.md" }),
      { path: "SKILL.md", content: bundle().files[0].bytes.toString() });
    await assert.rejects(client.action({ action: "preview_read", token: preview.preview.token, hash: "wrong", path: "SKILL.md" }), /hash mismatch/);
    const installed = await client.action({ action: "install", token: preview.preview.token, hash: preview.preview.hash, accepted: true });
    await assert.rejects(client.action({ action: "preview_read", token: preview.preview.token, hash: preview.preview.hash, path: "SKILL.md" }), /expired|cancelled/);
    assert.equal(installed.skill.enabled, false);
    assert.equal((await client.action({ action: "read", id: installed.skill.id })).content, bundle().files[0].bytes.toString());
    await client.action({ action: "enable", id: installed.skill.id, enabled: true });
    const piLibrary = createSkillLibrary({ directory });
    const [runtimePath] = await piLibrary.enabledPaths();
    assert.match(runtimePath, /service-test$/);
    assert.ok(!(await readFile(join(runtimePath, "SKILL.md"), "utf8")).includes("allowed-tools"));
    const transient = await ready(client);
    await client.close();
    library = createSkillLibrary({ directory, sources });
    client = transport(library);
    assert.equal((await client.action({ action: "list" })).skills.length, 1);
    await assert.rejects(client.action({ action: "job", jobId: transient.id }), /does not exist/);
    await assert.rejects(client.action({ action: "install", token: transient.preview.token, hash: transient.preview.hash, accepted: true }), /expired|missing|exist|cancel/i);
    assert.deepEqual(await library.enabledPaths(), [runtimePath]);
    await client.action({ action: "enable", id: installed.skill.id, enabled: false });
    assert.deepEqual(await piLibrary.enabledPaths(), []);
    await client.action({ action: "remove", id: installed.skill.id, accepted: true });
    assert.equal((await client.action({ action: "status" })).installed, 0);
    piLibrary.dispose();
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test("responses correlate asynchronous requests without blocking a fast status behind browse", async () => {
  let release;
  const slow = new Promise((done) => { release = done; });
  let disposed = 0;
  const client = transport({ run: async (text) => { const request = JSON.parse(text); if (request.action === "browse") await slow; return { action: request.action }; }, dispose: () => disposed++ });
  try {
    const browse = client.action({ action: "browse" });
    assert.deepEqual(await client.action({ action: "status" }), { action: "status" });
    assert.deepEqual(client.frames.map((frame) => frame.id), ["2"]);
    release();
    assert.deepEqual(await browse, { action: "browse" });
  } finally { release(); await client.close(); }
  assert.equal(disposed, 1);
});

test("bounded JSONL accepts fragmented frames and closes on duplicate ids or oversized input", async () => {
  for (const mode of ["duplicate", "oversized", "invalid"]) {
    let aborted = false;
    const client = transport({ run: (_text, _authority, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); })), dispose() {} });
    const line = JSON.stringify({ id: "1", text: '{"action":"preview"}' });
    client.input.write(line.slice(0, 5));
    client.input.write(`${line.slice(5)}\n`);
    await new Promise((done) => setImmediate(done));
    if (mode === "duplicate") client.input.write(`${line}\n`);
    if (mode === "oversized") client.input.write(Buffer.alloc(MAX_REQUEST_BYTES + 1, 120));
    if (mode === "invalid") client.input.write("not json\n");
    assert.equal(client.service.closed, true);
    assert.equal(aborted, true);
    await client.close();
  }
});

test("oversized responses are errors and action errors do not terminate the store", async () => {
  let attempts = 0;
  const client = transport({ run: async () => { attempts++; if (attempts === 1) return "x".repeat(MAX_RESPONSE_BYTES); if (attempts === 2) throw new Error("Invalid skill"); return { ok: true }; }, dispose() {} });
  try {
    await assert.rejects(client.action({ action: "read" }), /size limit/);
    await assert.rejects(client.action({ action: "read" }), /Invalid skill/);
    assert.deepEqual(await client.action({ action: "status" }), { ok: true });
  } finally { await client.close(); }
});

test("service error responses redact credentials and local filesystem paths", async () => {
  const client = transport({ run: async () => { throw new Error("failed /Users/alice/private/project with sk-ant-abcdefghijklmnop"); }, dispose() {} });
  try {
    await assert.rejects(client.action({ action: "read" }), (error) => {
      assert.equal(error.message.includes("/Users/alice"), false);
      assert.equal(error.message.includes("sk-ant-abcdefghijklmnop"), false);
      return true;
    });
  } finally { await client.close(); }
});

test("real Node process serves status/list without Pi or a model and exits on stdin EOF", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-service-home-"));
  const script = fileURLToPath(new URL("../src-tauri/src/skill-service.mjs", import.meta.url));
  const child = spawn(process.execPath, [script], { cwd: directory, env: { HOME: directory, USERPROFILE: directory, PATH: directory, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value) => stdout += value);
  child.stderr.setEncoding("utf8").on("data", (value) => stderr += value);
  const exited = once(child, "exit");
  try {
    child.stdin.write(`${JSON.stringify({ id: "1", text: '{"action":"status"}' })}\n${JSON.stringify({ id: "2", text: '{"action":"list"}' })}\n`);
    for (let i = 0; i < 200 && stdout.split("\n").length < 3; i++) await new Promise((done) => setTimeout(done, 10));
    const frames = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(frames.length, 2, stderr);
    assert.deepEqual(frames[0], { id: "1", ok: true, data: { revision: 0, enabled: [], installed: 0 } });
    assert.deepEqual(frames[1], { id: "2", ok: true, data: { skills: [], revision: 0 } });
    assert.deepEqual(await readdir(directory), []);
    child.stdin.end();
    assert.equal((await exited)[0], 0, stderr);
  } finally { child.kill(); await exited; await rm(directory, { recursive: true, force: true }); }
});
