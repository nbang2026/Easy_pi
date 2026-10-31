#!/usr/bin/env node
import { format } from "node:util";
import { resolve } from "node:path";
import { createClaudeRuntime, createFrameDecoder, MAX_FRAME } from "./runtime.mjs";

// stdout belongs exclusively to JSONL, including when a dependency uses console.
for (const method of ["log", "info", "warn", "error", "debug"]) {
  console[method] = (...values) => process.stderr.write(format(...values) + "\n");
}
const stdout = process.stdout;
let runtime;
let stopped = false;
function writeFrame(value) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > MAX_FRAME) throw new Error("Outgoing JSON frame exceeds 1 MiB.");
  if (stdout.writableLength + Buffer.byteLength(line) > 8 * MAX_FRAME) throw new Error("Protocol output consumer is too slow.");
  stdout.write(line + "\n");
}
function fail(error, id = null) {
  writeFrame({ id, ok: false, error: runtime ? runtime.errorText(error) : "Agent sidecar could not initialize. Check its configured working and state directories." });
}
async function close(exitCode = 0) {
  if (stopped) return;
  stopped = true;
  process.stdin.pause();
  try { await runtime?.close(); } catch {}
  process.exitCode = exitCode;
  stdout.end();
}
try {
  const args = process.argv.slice(2);
  let cwd = process.env.EASY_PI_CLAUDE_CWD || process.cwd();
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--cwd") throw new Error("Usage: claude-sidecar.mjs [--cwd <directory>]");
    cwd = resolve(args[1]);
  }
  runtime = await createClaudeRuntime({ cwd, home: process.env.EASY_PI_CLAUDE_HOME,
    emit: (event) => writeFrame({ type: "event", event }) });
  let pending = 0;
  let lifecycleQueue = Promise.resolve();
  let inputEpoch = 0;
  const execute = async (request, epoch = inputEpoch) => {
    try {
      if (["submit", "resume", "workspace", "new_session"].includes(request.action) && epoch !== inputEpoch)
        throw new Error("Operation cancelled before dispatch.");
      const data = await runtime.handle(request);
      writeFrame({ id: request.id, ok: true, data });
      if (request.action === "shutdown") await close();
    } catch (error) { fail(error, request.id); }
    finally { pending--; }
  };
  const decoder = createFrameDecoder((request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)
      || !(Number.isSafeInteger(request.id) || (typeof request.id === "string" && request.id.length <= 128))) {
      fail(new Error("Expected a request object with a numeric or string ID.")); return;
    }
    const control = ["stop", "shutdown", "approval", "permissions"].includes(request.action);
    // Keep bounded capacity for cancellation/approval when slow ordinary requests pile up.
    if (pending >= (control ? 64 : 60)) { fail(new Error("Too many pending sidecar requests."), request.id); return; }
    pending++;
    // Stop must cancel preparation immediately, including queued old inputs.
    if (["stop", "shutdown"].includes(request.action)) {
      inputEpoch++;
      void execute(request);
    } else if (["submit", "configure", "permissions", "new_session", "resume", "workspace"].includes(request.action)) {
      const epoch = inputEpoch;
      lifecycleQueue = lifecycleQueue.then(() => execute(request, epoch));
    } else void execute(request);
  }, (error) => fail(error));
  process.stdin.on("data", (chunk) => decoder.push(chunk));
  process.stdin.on("end", () => { decoder.end(); void close(); });
  process.stdin.on("error", () => { void close(1); });
  stdout.on("error", () => { void close(1); });
  process.on("SIGTERM", () => { void close(); });
  process.on("SIGINT", () => { void close(); });
} catch (error) {
  fail(error);
  await close(1);
}
