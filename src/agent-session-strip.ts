export type AgentSessionStatus = "pending" | "running" | "ready" | "completed" | "failed" | "cancelled";

export type AgentSession = {
  id: string;
  label?: string;
  title?: string;
  status?: AgentSessionStatus | string;
  color?: string;
  kind?: "main" | "subagent" | string;
  activity?: string;
};

export type AgentSessionStripOptions = {
  root: HTMLElement;
  language: () => string;
  onSelect?: (id: string) => void;
};

const palette = ["#7662e8", "#43b9e7", "#7bc682", "#e66e72", "#d69a47", "#57a9a0"];
const validStatuses = new Set<AgentSessionStatus>(["pending", "running", "ready", "completed", "failed", "cancelled"]);

const clean = (value: unknown, limit = 120) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
const hash = (value: string) => [...value].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
const colorFor = (id: string, fallback?: string) => /^#[0-9a-f]{6}$/i.test(fallback || "") ? fallback! : palette[hash(id) % palette.length];
const shortId = (id: string) => {
  const normalized = id.replace(/^subagent:/, "").replace(/[^a-zA-Z0-9_-]/g, "");
  return normalized.slice(-8) || "local";
};

function normalizeStatus(value: unknown): AgentSessionStatus {
  const status = String(value || "").toLowerCase();
  if (validStatuses.has(status as AgentSessionStatus)) return status as AgentSessionStatus;
  if (status === "done" || status === "success" || status === "complete") return "completed";
  if (status === "error") return "failed";
  if (status === "skipped") return "cancelled";
  return "ready";
}

export function normalizeAgentSessions(value: unknown, language = "zh"): AgentSession[] {
  const input = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const result: AgentSession[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const id = clean(source.id ?? source.agentId, 160);
    if (!id || seen.has(id) || id === "main") continue;
    seen.add(id);
    const suppliedLabel = clean(source.label ?? source.name, 80);
    const fallback = `agent-${shortId(id)}`;
    result.push({
      id,
      label: suppliedLabel || fallback,
      title: clean(source.title ?? source.activity, 200),
      status: normalizeStatus(source.status),
      color: colorFor(id, clean(source.color, 20)),
      kind: "subagent",
      activity: clean(source.activity, 160),
    });
  }
  return result;
}

export function setupAgentSessionStrip(options: AgentSessionStripOptions) {
  const { root } = options;
  let activeId = "main";
  let lastSignature = "";
  let lastState: Record<string, unknown> = {};
  let disposed = false;

  const label = (key: "main" | "running" | "pending" | "ready" | "completed" | "failed" | "cancelled") => {
    const english = options.language() === "en";
    return ({
      main: english ? "Main session" : "主会话",
      running: english ? "Running" : "运行中",
      pending: english ? "Pending" : "等待中",
      ready: english ? "Ready" : "待命",
      completed: english ? "Completed" : "已完成",
      failed: english ? "Failed" : "失败",
      cancelled: english ? "Cancelled" : "已取消",
    })[key];
  };

  const statusText = (status: AgentSessionStatus) => label(status === "pending" ? "pending" : status);
  const render = (state: Record<string, unknown> = {}) => {
    if (disposed) return;
    lastState = state;
    const connected = state.connected !== false;
    const busy = state.busy === true;
    const main: AgentSession = {
      id: "main",
      label: label("main"),
      title: clean(state.name) || clean(state.sessionId) || clean(state.session),
      status: connected ? (busy ? "running" : "completed") : "failed",
      color: "#e7a72f",
      kind: "main",
    };
    const children = state.connected === false ? [] : normalizeAgentSessions(state.agents, options.language());
    const sessions = children.length ? [main, ...children] : [];
    if (!sessions.some((session) => session.id === activeId)) activeId = "main";
    const signature = JSON.stringify([activeId, options.language(), sessions]);
    if (signature === lastSignature) return;
    lastSignature = signature;
    root.replaceChildren();
    for (const session of sessions) {
      const status = normalizeStatus(session.status);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agent-session-item";
      if (session.id === activeId) button.classList.add("is-active");
      if (status === "running" || status === "pending") button.classList.add("is-running");
      if (status === "failed" || status === "cancelled") button.classList.add("is-failed");
      button.dataset.agentSession = session.id;
      button.setAttribute("aria-current", String(session.id === activeId));
      const description = session.title || session.activity || statusText(status);
      button.title = `${session.label || `agent-${shortId(session.id)}`} · ${description}`;
      button.setAttribute("aria-label", `${session.label || `agent-${shortId(session.id)}`} · ${statusText(status)}`);

      const avatar = document.createElement("span");
      avatar.className = "agent-session-avatar";
      avatar.style.backgroundColor = colorFor(session.id, session.color);
      avatar.textContent = session.kind === "main" ? (options.language() === "en" ? "M" : "主") : (session.label || "a").slice(0, 1).toLowerCase();
      avatar.setAttribute("aria-hidden", "true");

      const name = document.createElement("span");
      name.className = "agent-session-name";
      name.textContent = session.label || `agent-${shortId(session.id)}`;

      const statusNode = document.createElement("span");
      statusNode.className = "agent-session-status";
      statusNode.dataset.status = status;
      statusNode.textContent = status === "completed" || status === "ready" ? "✓" : status === "failed" ? "!" : status === "cancelled" ? "×" : "•";
      statusNode.setAttribute("aria-label", statusText(status));

      button.append(avatar, name, statusNode);
      button.addEventListener("click", () => {
        activeId = session.id;
        render(state);
        options.onSelect?.(session.id);
      });
      root.append(button);
    }
    root.hidden = sessions.length === 0;
  };

  return {
    update(state: unknown) {
      render(state && typeof state === "object" ? state as Record<string, unknown> : {});
    },
    setActive(id: string) {
      if (!id || id === activeId) return;
      activeId = id;
      lastSignature = "";
      render(lastState);
    },
    refreshLanguage() {
      lastSignature = "";
      render(lastState);
    },
    dispose() {
      disposed = true;
      root.replaceChildren();
    },
  };
}
