export type Draft = { text: string; attachments: string[] };
export type AgentState = {
  ready: boolean; busy: boolean; pending?: boolean; connected?: boolean;
  nativeDraft?: boolean; compactEditor?: boolean; session?: string; sessionId?: string; cwd?: string; model?: string; name?: string;
  thinking?: string;
};

export function parseDraft(value: string | null): Draft {
  try {
    const data = JSON.parse(value || "{}");
    return {
      text: typeof data.text === "string" ? data.text.slice(0, 262144) : "",
      attachments: Array.isArray(data.attachments) ? [...new Set<string>(data.attachments
        .filter((path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !/[\0\r\n]/.test(path)))]
        .slice(0, 20) : [],
    };
  } catch { return { text: "", attachments: [] }; }
}

export function canSubmit(state: AgentState, draft: Draft, submitting: boolean, desktop: boolean): boolean {
  return desktop && state.ready && !state.nativeDraft && !submitting && !!(draft.text.trim() || draft.attachments.length);
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
  for (const key of ["pending", "connected", "nativeDraft"] as const) result[key] = data[key] === true;
  if ("compactEditor" in data) result.compactEditor = data.compactEditor === true;
  for (const key of ["session", "sessionId", "cwd", "model", "name", "thinking"] as const) {
    if (typeof data[key] === "string") result[key] = data[key];
  }
  return result;
}
