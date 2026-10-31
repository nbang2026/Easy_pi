// App-owned transport glue for the MIT-licensed DeepSeek Harness plugin API.
// No model calls or tool loop live here; DSH owns generation, dispatch and audit.
import { connect, createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIMIT = 1024 * 1024;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function lines(socket, receive) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > LIMIT && !buffer.includes(10)) return socket.destroy();
    let end;
    while ((end = buffer.indexOf(10)) >= 0) {
      if (end > LIMIT) return socket.destroy();
      const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      try { const value = JSON.parse(frame.toString("utf8")); if (!record(value)) throw Error(); receive(value); }
      catch { socket.destroy(); return; }
    }
  });
}
function send(socket, value) {
  const frame = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(frame) > LIMIT || socket.destroyed) throw Error("DSH bridge unavailable or frame too large.");
  socket.write(frame);
}

/** Private, authenticated IPC. Closing the bridge withdraws every outstanding ask. */
export async function createApprovalBridge({ onApproval, onStream, onWithdraw, onDisconnect } = {}) {
  const token = randomBytes(32).toString("hex");
  const directory = await mkdtemp(join(tmpdir(), "easy-pi-dsh-"));
  await chmod(directory, 0o700);
  const path = process.platform === "win32" ? `\\\\.\\pipe\\easy-pi-dsh-${randomUUID()}` : join(directory, "bridge.sock");
  const sockets = new Set(), pending = new Map();
  let peer, closed = false;
  const server = createServer((socket) => {
    sockets.add(socket); let authenticated = false;
    const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
    lines(socket, (frame) => {
      if (!authenticated) {
        if (frame.type !== "hello" || frame.token !== token || peer) return socket.destroy();
        authenticated = true; peer = socket; clearTimeout(timer); send(socket, { type: "ready" }); return;
      }
      if (frame.type === "approval" && typeof frame.id === "string" && typeof frame.sessionId === "string" && typeof frame.toolName === "string") {
        if (pending.has(frame.id)) return socket.destroy();
        pending.set(frame.id, socket);
        try { onApproval?.(frame); } catch { pending.delete(frame.id); send(socket, { type: "decision", id: frame.id, allow: false }); }
      } else if (frame.type === "withdraw" && typeof frame.id === "string") {
        pending.delete(frame.id); onWithdraw?.(frame.id);
      } else if (frame.type === "stream") onStream?.(frame);
      else socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer); sockets.delete(socket);
      if (peer === socket) {
        peer = undefined;
        for (const id of pending.keys()) onWithdraw?.(id);
        pending.clear(); if (!closed) onDisconnect?.();
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  if (process.platform !== "win32") await chmod(path, 0o600);
  return {
    path, token,
    decide(id, allow) {
      const socket = pending.get(id);
      if (!socket || typeof allow !== "boolean") return false;
      pending.delete(id); send(socket, { type: "decision", id, allow }); return true;
    },
    async close() {
      if (closed) return; closed = true;
      for (const socket of sockets) socket.destroy(); pending.clear();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// Cordis entry point, loaded exclusively by our explicit SDK profile overlay.
export const name = "easy-pi-dsh-bridge";
export const inject = ["tools", "approval"];
export function apply(ctx) {
  const endpoint = process.env.EASY_PI_DSH_BRIDGE;
  const token = process.env.EASY_PI_DSH_BRIDGE_TOKEN;
  delete process.env.EASY_PI_DSH_BRIDGE_TOKEN;
  // The official adapters read their immutable launch environment snapshot.
  // Avoid exposing the configured key to tool subprocesses via process.env.
  delete process.env.EASY_PI_DSH_API_KEY;
  if (!endpoint || !token) throw Error("The private Agent approval bridge is required.");
  const socket = connect(endpoint), pending = new Map(), inputs = new Map(), grants = new WeakSet();
  let ready = false, closed = false;
  let acceptReady, rejectReady;
  const connected = new Promise((resolve, reject) => { acceptReady = resolve; rejectReady = reject; });
  connected.catch(() => {});
  const connectionTimer = setTimeout(() => socket.destroy(), 5000); connectionTimer.unref();
  const fail = () => {
    if (closed) return; closed = true; ready = false; clearTimeout(connectionTimer);
    rejectReady(Error("The Agent approval bridge disconnected."));
    for (const entry of pending.values()) entry.finish("unavailable");
    pending.clear();
  };
  socket.on("error", fail); socket.on("close", fail);
  socket.on("connect", () => send(socket, { type: "hello", token }));
  lines(socket, (frame) => {
    if (frame.type === "ready") { ready = true; clearTimeout(connectionTimer); acceptReady(); }
    else if (frame.type === "decision" && typeof frame.allow === "boolean") pending.get(frame.id)?.finish(frame.allow ? "allowed-once" : "rejected");
    else socket.destroy();
  });
  ctx.on("tools/pre-execute", async (exec) => {
    if (!exec.agent || exec.signal.aborted || closed) return { kind: "deny", reason: "Agent approval unavailable." };
    const key = `${exec.agent.session.id}:${exec.callId}`;
    inputs.set(key, exec.arguments);
    try {
      // Use the actual native service: it records approval/asked and decided.
      const outcome = await ctx.approval.request({ agent: exec.agent, callId: exec.callId, toolName: exec.name,
        reason: "User approval is required for every Agent tool call.", signal: exec.signal });
      if (outcome === "allowed-once" && ready && !closed && !exec.signal.aborted) { grants.add(exec); return { kind: "allow" }; }
      return outcome === "cancelled" ? { kind: "cancel" } : { kind: "deny", reason: "User denied the tool call or approval is unavailable." };
    } finally { inputs.delete(key); }
  });
  const unguard = ctx.tools.guard((exec) => grants.has(exec) && ready && !closed ? undefined : "Tool execution requires a live, explicit one-time approval.");
  ctx.on("approval/request", async (request) => {
    try { await connected; } catch { return "unavailable"; }
    if (!ready || closed || request.signal?.aborted) return "cancelled";
    const id = randomUUID();
    return new Promise((resolve) => {
      const finish = (outcome) => {
        const entry = pending.get(id); if (!entry) return;
        pending.delete(id); clearTimeout(entry.timer); request.signal?.removeEventListener("abort", abort); resolve(outcome);
      };
      const withdraw = (outcome) => { try { send(socket, { type: "withdraw", id }); } catch {} finish(outcome); };
      const abort = () => withdraw("cancelled");
      const timer = setTimeout(() => withdraw("unavailable"), 10 * 60 * 1000); timer.unref();
      pending.set(id, { finish, timer }); request.signal?.addEventListener("abort", abort, { once: true });
      try { send(socket, { type: "approval", id, sessionId: request.agent.session.id, toolName: request.toolName,
        callId: request.callId, input: inputs.get(`${request.agent.session.id}:${request.callId}`) ?? {}, reason: request.reason }); }
      catch { finish("unavailable"); }
      if (request.signal?.aborted) abort();
    });
  });
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    if (!ready || closed) return;
    try { send(socket, { type: "stream", sessionId: agent.session.id, frame }); }
    catch { socket.destroy(); }
  });
  ctx.on("dispose", () => { unguard(); fail(); socket.destroy(); });
}
