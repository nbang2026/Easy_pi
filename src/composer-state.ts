import type { AgentSession } from "./agent-session-strip";
import type { ToolApproval } from "./pi-permissions";

export type Draft = { text: string; attachments: string[] };
export type AgentState = {
  ready: boolean; busy: boolean; pending?: boolean; connected?: boolean;
  nativeDraft?: boolean; compactEditor?: boolean; session?: string; sessionId?: string; cwd?: string; model?: string; name?: string;
  commandPending?: boolean; inputRecovery?: boolean;
  thinking?: string; thinkingSupported?: boolean; thinkingLevels?: string[];
  usage?: { tokens: number; cost: number | null };
  skills?: string[]; skillError?: string; extensionCommands?: number;
  task?: unknown; harnessError?: string; usageError?: string;
  agents?: AgentSession[];
  approvals?: ToolApproval[];
  startupPhase?: "initializing" | "project_trust" | "session";
  coreUpdate?: unknown;
};

export function isAbsoluteAttachmentPath(path: unknown): path is string {
  if (typeof path !== "string" || /[\0\r\n]/.test(path)) return false;
  // A drive letter without a separator and a single leading backslash are drive-relative.
  if (path.startsWith("/")) return true;
  if (/^[a-z]:[\\/]/i.test(path)) return true;
  const windows = path.replace(/\//g, "\\");
  if (windows.startsWith("\\\\?\\")) {
    const extended = windows.slice(4);
    return /^[a-z]:\\/i.test(extended) || /^UNC\\[^\\]+\\[^\\]+(?:\\|$)/i.test(extended);
  }
  return /^\\\\[^\\?.][^\\]*\\[^\\]+(?:\\|$)/.test(windows);
}

export function parseDraft(value: string | null): Draft {
  try {
    const data = JSON.parse(value || "{}");
    return {
      text: typeof data.text === "string" ? data.text.slice(0, 262144) : "",
      attachments: Array.isArray(data.attachments) ? [...new Set<string>(data.attachments
        .filter(isAbsoluteAttachmentPath))]
        .slice(0, 20) : [],
    };
  } catch { return { text: "", attachments: [] }; }
}

export function canSubmit(state: AgentState, draft: Draft, submitting: boolean, desktop: boolean): boolean {
  return desktop && state.connected !== false && state.ready && !state.commandPending && !state.inputRecovery && !state.nativeDraft && !submitting && !!(draft.text.trim() || draft.attachments.length);
}

export function shouldSendOnEnter(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }, composing: boolean): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229;
}

export function isGuiShortcut(event: {metaKey: boolean; altKey: boolean}): boolean {
  return event.metaKey && !event.altKey;
}

export function sameDraft(a: Draft, b: Draft): boolean {
  return a.text === b.text && a.attachments.length === b.attachments.length && a.attachments.every((path, index) => path === b.attachments[index]);
}

export function normalizedState(value: unknown): AgentState {
  if (!value || typeof value !== "object") return { ready: false, busy: false };
  const data = value as Record<string, unknown>;
  const result: AgentState = { ready: data.ready === true, busy: data.busy === true };
  if (data.coreUpdate && typeof data.coreUpdate === "object") result.coreUpdate = data.coreUpdate;
  if (["initializing", "project_trust", "session"].includes(data.startupPhase as string)) result.startupPhase = data.startupPhase as AgentState["startupPhase"];
  for (const key of ["pending", "connected", "nativeDraft", "commandPending", "inputRecovery"] as const) result[key] = data[key] === true;
  if (typeof data.thinkingSupported === "boolean") result.thinkingSupported = data.thinkingSupported;
  if (Array.isArray(data.thinkingLevels)) result.thinkingLevels = data.thinkingLevels.filter((level): level is string => typeof level === "string");
  if ("compactEditor" in data) result.compactEditor = data.compactEditor === true;
  if (Array.isArray(data.skills)) result.skills = data.skills.filter((value): value is string => typeof value === "string");
  if (typeof data.skillError === "string") result.skillError = data.skillError;
  for (const key of ["harnessError", "usageError"] as const) if (typeof data[key] === "string") result[key] = data[key];
  if (data.task === null || data.task && typeof data.task === "object") result.task = data.task;
  if (Array.isArray(data.agents)) result.agents = data.agents.filter((item): item is AgentSession => !!item && typeof item === "object");
  if (Array.isArray(data.approvals)) result.approvals = data.approvals.filter((item): item is ToolApproval =>
    !!item && typeof item === "object" && typeof item.requestId === "string" && typeof item.sessionId === "string" && item.type === "approval");
  if (typeof data.extensionCommands === "number" && Number.isSafeInteger(data.extensionCommands) && data.extensionCommands >= 0) result.extensionCommands = data.extensionCommands;
  if (data.usage && typeof data.usage === "object") {
    const usage = data.usage as { tokens?: unknown; cost?: unknown };
    if (typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0) {
      result.usage = { tokens: usage.tokens, cost: typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null };
    }
  }
  for (const key of ["session", "sessionId", "cwd", "model", "name", "thinking"] as const) {
    if (typeof data[key] === "string") result[key] = data[key];
  }
  return result;
}
