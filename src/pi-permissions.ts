import type { PermissionRequest } from "./permission-dialog";

export type ToolApproval = {
  type: "approval" | "approval_resolved";
  requestId: string; sessionId: string; bridgeId?: string;
  scope?: "tool" | "project_trust";
  tool?: string; operation?: string; risk?: "low" | "medium" | "high"; expiresAt?: number;
};
type Target = { bridgeId: string; sessionId: string };

export function createPiPermissions(options: {
  request(value: PermissionRequest): Promise<boolean>;
  answer(value: { requestId: string; sessionId: string; allow: boolean }): Promise<unknown>;
  notice(message: string): void;
  language(): string;
}) {
  let target: Target | undefined;
  let disposed = false;
  const pending = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>();
  const cancel = (id: string) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer); entry.controller.abort();
  };
  const clear = () => { for (const id of [...pending.keys()]) cancel(id); };
  const receive = (value: ToolApproval) => {
    if (disposed || !target || value.bridgeId !== target.bridgeId || value.sessionId !== target.sessionId || !value.requestId) return;
    if (!target.sessionId && value.type === "approval" && value.scope !== "project_trust") return;
    if (value.type === "approval_resolved") { cancel(value.requestId); return; }
    if (value.type !== "approval" || pending.has(value.requestId) || pending.size >= 8 ||
      !Number.isFinite(value.expiresAt) || value.expiresAt! <= Date.now()) return;
    const identity = target;
    const controller = new AbortController();
    pending.set(value.requestId, { controller, timer: setTimeout(() => cancel(value.requestId), Math.min(value.expiresAt! - Date.now(), 120000)) });
    const projectTrust = value.scope === "project_trust";
    void options.request({ title: projectTrust ? (options.language() === "en" ? "Trust this project?" : "是否信任此项目？")
      : (options.language() === "en" ? "Tool permission request" : "工具权限申请"),
      operation: `${value.tool || "tool"}: ${value.operation || ""}`, risk: value.risk || "high",
      signal: controller.signal, toolApproval: !projectTrust, projectTrust }).then(async allow => {
      if (disposed || controller.signal.aborted || target !== identity || Date.now() >= value.expiresAt!) return;
      await options.answer({ requestId: value.requestId, sessionId: value.sessionId, allow });
    }).catch(() => {
      if (!controller.signal.aborted && !disposed) options.notice(options.language() === "en"
        ? "Could not deliver the approval. The tool remains blocked; stop and retry."
        : "审批结果未能送达，工具仍受阻止；请停止后重试。");
    });
  };
  return {
    receive,
    observe(next?: Target, requests?: ToolApproval[]) {
      if (disposed) return;
      if (!next || target?.bridgeId !== next.bridgeId || target?.sessionId !== next.sessionId) {
        clear(); target = next;
      }
      if (target && Array.isArray(requests)) {
        const ids = new Set(requests.map(value => value.requestId));
        for (const id of [...pending.keys()]) if (!ids.has(id)) cancel(id);
        for (const value of requests) receive({ ...value, bridgeId: target.bridgeId });
      }
    },
    dispose() { disposed = true; clear(); target = undefined; },
  };
}
