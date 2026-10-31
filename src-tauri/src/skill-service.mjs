import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { createSkillLibrary } from "./gui-skills.mjs";
import { createAgentLibrary } from "./gui-library.mjs";
import { safeUserError } from "./privacy.mjs";

export function createStoreLibrary(options = {}) {
  const skills = createSkillLibrary(options);
  const agents = createAgentLibrary({ directory: options.agentDirectory, fetcher: options.fetcher });
  return {
    run(text, authority, signal) {
      const request = JSON.parse(text);
      if (request.kind === "market") return agents.run(request, authority, signal);
      if (request.kind === "settings" && Object.keys(request).every(key => ["kind", "activeAgent"].includes(key))
        && typeof request.activeAgent === "string") return agents.run(request, authority, signal);
      if (request.kind && request.kind !== "skills") throw Error("Unsupported store operation.");
      return skills.run(text, authority, signal);
    },
    dispose() { skills.dispose(); agents.dispose(); },
  };
}

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 32;

// One library owns preview tokens and jobs for the whole desktop application.
// The transport is deliberately independent of Pi, extensions and model runtimes.
export function serveSkillService({ input, output, library = createStoreLibrary() }) {
  let buffered = Buffer.alloc(0);
  let closed = false;
  const pending = new Map();
  const writes = new Set();
  function reply(value) {
    if (closed || output.destroyed) return;
    let frame = JSON.stringify(value);
    if (Buffer.byteLength(frame) > MAX_RESPONSE_BYTES) frame = JSON.stringify({ id: value.id, ok: false, error: { message: "Skill service response exceeds its size limit." } });
    if (output.writableLength > MAX_RESPONSE_BYTES * 2) { close(); return; }
    const write = new Promise((done) => output.write(`${frame}\n`, () => done()));
    writes.add(write);
    void write.finally(() => writes.delete(write));
  }
  function accept(bytes) {
    let request;
    try {
      request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.id !== "string" || !/^[0-9]{1,20}$/.test(request.id) || typeof request.text !== "string") throw new Error();
    } catch { close(); return; }
    if (pending.has(request.id)) { close(); return; }
    if (pending.size >= MAX_PENDING) { reply({ id: request.id, ok: false, error: { message: "Skill service is busy; try again after pending actions finish." } }); return; }
    const controller = new AbortController();
    const task = Promise.resolve().then(() => library.run(request.text, "user", controller.signal)).then(
      (data) => reply({ id: request.id, ok: true, data }),
      (error) => reply({ id: request.id, ok: false, error: { message: safeUserError(error, "Skill action failed.", 4096), ...(typeof error?.code === "string" ? { code: error.code.slice(0, 100) } : {}) } }),
    ).finally(() => pending.delete(request.id));
    pending.set(request.id, { controller, task });
  }
  function onData(chunk) {
    if (closed) return;
    // Process chunks incrementally: a hostile producer cannot grow the buffer
    // beyond one bounded frame, even when many lines arrive in a single chunk.
    for (let offset = 0; offset < chunk.length && !closed;) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (buffered.length + end - offset > MAX_REQUEST_BYTES) { close(); return; }
      buffered = Buffer.concat([buffered, chunk.subarray(offset, end)]);
      if (newline < 0) break;
      const frame = buffered;
      buffered = Buffer.alloc(0);
      accept(frame);
      offset = newline + 1;
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    buffered = Buffer.alloc(0);
    input.off("data", onData);
    input.pause();
    for (const { controller } of pending.values()) controller.abort();
    library.dispose();
  }
  input.on("data", onData);
  input.once("end", close);
  input.once("error", close);
  output.once("error", close);
  return {
    close,
    async settled() { await Promise.allSettled([...pending.values()].map(({ task }) => task)); await Promise.allSettled([...writes]); },
    get closed() { return closed; },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const service = serveSkillService({ input: process.stdin, output: process.stdout });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    service.close();
    const deadline = setTimeout(() => process.exit(0), 1000);
    void service.settled().finally(() => { clearTimeout(deadline); process.exit(0); });
  };
  process.stdin.once("end", stop);
  process.stdin.once("error", stop);
  process.stdout.once("error", stop);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
