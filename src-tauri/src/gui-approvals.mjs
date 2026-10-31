import { randomUUID } from "node:crypto";
import { redactWorkspaceText } from "./task-scheduler.mjs";

// Only live, session-bound requests may be answered; approvals are never restored.
export function createToolApprovals({ emit, timeoutMs = 120000 } = {}) {
  const pending = new Map();
  const finish = (id, allow) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    entry.resolve(allow === true);
    try { emit?.({ type: "approval_resolved", requestId: id, sessionId: entry.value.sessionId }); } catch { /* Already denied locally. */ }
    return true;
  };
  return {
    list: () => [...pending.values()].map(entry => ({ ...entry.value })),
    request(value) {
      if (value.signal?.aborted || pending.size >= 8) return Promise.resolve(false);
      const operation = JSON.stringify(value.input);
      if (!operation || operation.length > 30000) return Promise.resolve(false);
      // Redact string values before JSON escaping hides shell quotes and PEM lines.
      const visibleOperation = JSON.stringify(value.input, (key, item) => {
        if (typeof item !== "string") return item;
        if (/password|passwd|pwd|secret|token|api[_-]?key|authorization|private[_-]?key|webhook/i.test(key)) return "[redacted]";
        return redactWorkspaceText(item, 32000);
      });
      const requestId = randomUUID();
      const visible = { type: "approval", requestId, sessionId: value.sessionId, runId: value.runId,
        scope: value.scope === "project_trust" ? "project_trust" : "tool",
        tool: value.toolName, operation: visibleOperation,
        risk: value.scope === "project_trust" || value.toolName === "bash" ? "high" : "medium", expiresAt: Date.now() + timeoutMs };
      return new Promise(resolve => {
        const entry = { value: visible, resolve, signal: value.signal, abort: () => finish(requestId, false), timer: undefined };
        pending.set(requestId, entry);
        entry.timer = setTimeout(entry.abort, timeoutMs);
        entry.timer.unref?.();
        entry.signal?.addEventListener("abort", entry.abort, { once: true });
        if (entry.signal?.aborted) return entry.abort();
        try { emit?.(visible); } catch { entry.abort(); }
      });
    },
    decide(value, sessionId) {
      const entry = pending.get(value?.requestId);
      if (!entry || typeof value.allow !== "boolean" || value.sessionId !== sessionId || entry.value.sessionId !== sessionId)
        throw Error("审批已失效或不属于当前会话。");
      if (Date.now() >= entry.value.expiresAt || entry.signal?.aborted) {
        finish(value.requestId, false);
        throw Error("审批已过期，请重新发起操作。");
      }
      finish(value.requestId, value.allow);
      return { accepted: true };
    },
    cancelAll() { for (const id of [...pending.keys()]) finish(id, false); },
    allowAll(sessionId) {
      for (const [id, entry] of [...pending]) {
        if (entry.value.scope !== "project_trust" && entry.value.sessionId === sessionId && !entry.signal?.aborted && Date.now() < entry.value.expiresAt) finish(id, true);
      }
    },
  };
}
