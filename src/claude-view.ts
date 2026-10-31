export type AgentProtocol = "deepseek-messages" | "openai-completions" | "anthropic-messages";
export type AgentThinking = "off" | "on" | "auto";
export type AgentEffort = "low" | "high" | "max";

export interface ClaudeStatus {
  engine?: "claude" | "dsh";
  ready?: boolean;
  busy?: boolean;
  configured?: boolean;
  cwd?: string;
  sessionId?: string | null;
  model?: string;
  baseUrl?: string;
  protocol?: AgentProtocol;
  thinking?: AgentThinking;
  effort?: AgentEffort | null;
  maxActiveSubagents?: number;
  waitingApproval?: boolean | string | null;
  permissionMode?: "ask" | "full";
  error?: string | null;
}

export interface ClaudeQuestion {
  header?: string;
  question: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export type ClaudeViewEvent =
  | ({ type: "status" } & ClaudeStatus)
  | { type: "route"; runId?: string; level: "simple" | "moderate" | "complex"; complexityScore?: number; domains: string[]; agent?: string; manualAgent?: boolean; skills: string[]; parallelAgents: number; warnings?: string[] }
  | { type: "agent"; runId?: string; agentId: string; parentId?: string; label?: string; status: "running" | "ready" | "completed" | "failed" | "cancelled"; activity?: string; result?: string }
  | { type: "text" | "thinking"; runId?: string; messageId?: string; blockId?: string | number; text: string; append?: boolean; eventId?: string }
  | { type: "tool"; runId?: string; toolId: string; name?: string; input?: unknown; result?: unknown; status?: string }
  | { type: "approval"; runId?: string; approvalId: string; toolName: string; input?: unknown; questions?: ClaudeQuestion[] }
  | { type: "approval_resolved"; approvalId: string }
  | { type: "result"; runId?: string; sessionId?: string; usage?: Record<string, unknown>; cost?: number; error?: string | null }
  | { type: "user"; text: string; attachments?: unknown[]; messageId?: string; runId?: string };

export interface ClaudeSessionState extends ClaudeStatus {
  history?: readonly ClaudeViewEvent[];
  messages?: readonly { text: string; attachments?: unknown[]; messageId?: string; runId?: string }[];
}

export interface ClaudeViewOptions {
  container: HTMLElement;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  translate?(key: string): string;
  toast?(message: string): void;
  onStatus?(status: ClaudeStatus): void;
  onUserInput?(text: string, attachments?: unknown[]): void;
}

export interface ClaudeView {
  handleEvent(event: unknown): void;
  setSession(state: ClaudeSessionState | null): void;
  reset(): void;
  configure(): Promise<void>;
  openConnection(): Promise<void>;
  dispose(): void;
}

const words = {
  en: {
    transcript: "Agent conversation", empty: "Your Agent conversation will appear here.",
    route: "Task routing", routeSimple: "Simple", routeModerate: "Moderate", routeComplex: "Complex",
    routeAuto: "Auto", routeManual: "Manual", routeSkills: "Skills", routeSubagents: "Subagents",
    unconfigured: "Connect Agent to start. This independent Agent connection supports DeepSeek and compatible services; Pi API keys are not inherited.",
    ready: "Ready", busy: "Working…", waiting: "Waiting for your response", disconnected: "Not connected",
    thinking: "Thinking", user: "You", tool: "Tool", input: "Input", output: "Result",
    subagent: "Subagent", agentLimit: "Maximum active subagents", keepKey: "Leave blank to keep the current key",
    agentRunning: "Running", agentReady: "Waiting", agentCompleted: "Completed", agentFailed: "Failed", agentCancelled: "Cancelled",
    pending: "Pending", running: "Running", completed: "Completed", failed: "Failed", denied: "Denied", cancelled: "Cancelled",
    approval: "Permission required", ask: "Agent has a question", review: "Review", allow: "Allow once", deny: "Deny",
    allowAll: "Allow all tool permissions", fullAccess: "Full access is active for this project. OS permissions still require system authorization.",
    fullAccessHint: "Allow all approves this project's file, command and network tools during this app session. Automatic Agent/Skill downloads still follow their separate setting. Restore approvals in settings; OS privacy access still requires system confirmation.",
    submit: "Send answers", other: "Other", otherHint: "Enter your answer", answerRequired: "Please answer every question before sending.",
    sending: "Sending…", resolved: "Response recorded", approvalFailed: "The response could not be sent. Check the connection before continuing.",
    close: "Close", cancel: "Cancel", configure: "Connect Agent", save: "Save connection", saving: "Saving…",
    connectionHelp: "Independent Agent connection for DeepSeek and compatible services. The API key stays in memory for this app session and is never saved to browser storage. Pi credentials are not inherited.",
    apiKey: "API key", keyRequired: "Enter an Agent API key.", model: "Model", modelPlaceholder: "模型ID / model ID", modelRequired: "Enter a model ID.",
    protocol: "API protocol", deepseekProtocol: "DeepSeek (native Messages)", openaiProtocol: "OpenAI compatible (Chat Completions)", anthropicProtocol: "Anthropic compatible (Messages)",
    thinkingMode: "Thinking mode", thinkingOff: "Off", thinkingOn: "On", thinkingAuto: "Auto (model default)",
    effort: "Reasoning effort (optional)", effortDefault: "Model default", effortLow: "Low", effortHigh: "High", effortMax: "Max",
    effortHint: "Only applies when thinking is enabled and the selected model and service support reasoning effort.",
    thinkingHint: "Thinking depends on the current model’s native capabilities and the service’s support. Only thinking content actually returned by the service is displayed; Agent cannot create native thinking for a model that does not support it.",
    baseUrl: "Base URL", baseUrlOptional: "Base URL (optional)", baseRequired: "Enter a Base URL for the selected service.",
    baseHint: "Use HTTPS, or HTTP on a local loopback address. Enter the service’s Chat Completions base URL, including /v1 if required.",
    deepseekBaseHint: "DeepSeek native Messages uses https://api.deepseek.com/anthropic. Use HTTPS, or HTTP on a local loopback address.",
    anthropicBaseHint: "Use HTTPS, or HTTP on a local loopback address. Leave blank for the default Anthropic endpoint.",
    invalidUrl: "Use an HTTPS URL, or HTTP with localhost, 127.0.0.1, or [::1]. Do not include credentials, query parameters, or a fragment.",
    configureFailed: "Could not save the Agent connection. Check the key, protocol, endpoint, and model, then try again.",
    configured: "Agent connection saved for this app session.", reviewFirst: "Respond to the pending request first.",
    usage: "Usage", inputTokens: "input", outputTokens: "output", cacheRead: "cache read", cacheWrite: "cache write", cost: "Cost", attachment: "Attachment",
  },
  zh: {
    transcript: "Agent 对话", empty: "Agent 对话将在这里显示。",
    route: "任务路由", routeSimple: "简单", routeModerate: "中等", routeComplex: "复杂",
    routeAuto: "自动", routeManual: "手动", routeSkills: "Skill", routeSubagents: "子 Agent",
    unconfigured: "请先连接 Agent。独立 Agent 连接，可用 DeepSeek 和兼容服务，不会继承 Pi 的 API 密钥。",
    ready: "就绪", busy: "正在处理…", waiting: "等待你的回复", disconnected: "未连接",
    thinking: "思考", user: "你", tool: "工具", input: "输入", output: "结果",
    subagent: "子 Agent", agentLimit: "最大并行 Agent 数", keepKey: "留空则保持当前密钥",
    agentRunning: "执行中", agentReady: "待命", agentCompleted: "已完成", agentFailed: "失败", agentCancelled: "已取消",
    pending: "等待中", running: "执行中", completed: "已完成", failed: "失败", denied: "已拒绝", cancelled: "已取消",
    approval: "需要授权", ask: "Agent 有问题需要你回答", review: "查看请求", allow: "仅允许本次", deny: "拒绝",
    allowAll: "一键放行所有权限", fullAccess: "当前项目的完全访问已生效。系统隐私权限仍需系统授权。",
    fullAccessHint: "一键放行会在本次应用会话中批准当前项目的文件、命令和联网工具。Agent 与 Skill 自动下载仍由独立开关控制。可在权限设置恢复；系统隐私权限仍需系统确认。",
    submit: "发送回答", other: "其他", otherHint: "输入你的回答", answerRequired: "请回答所有问题后再发送。",
    sending: "正在发送…", resolved: "回复已记录", approvalFailed: "无法发送回复，请检查连接后再继续。",
    close: "关闭", cancel: "取消", configure: "连接 Agent", save: "保存连接", saving: "正在保存…",
    connectionHelp: "独立 Agent 连接，可用 DeepSeek 和兼容服务。密钥仅在本次应用会话的内存中使用，不会保存到浏览器存储，也不会继承 Pi 的凭据。",
    apiKey: "API 密钥", keyRequired: "请输入 Agent API 密钥。", model: "模型", modelPlaceholder: "模型ID / model ID", modelRequired: "请输入模型 ID。",
    protocol: "API 协议", deepseekProtocol: "DeepSeek（原生 Messages）", openaiProtocol: "OpenAI 兼容（Chat Completions）", anthropicProtocol: "Anthropic 兼容（Messages）",
    thinkingMode: "思考模式", thinkingOff: "关闭", thinkingOn: "开启", thinkingAuto: "自动（模型默认）",
    effort: "推理强度（可选）", effortDefault: "模型默认", effortLow: "低", effortHigh: "高", effortMax: "最高",
    effortHint: "仅在启用思考且所选模型与服务支持推理强度时生效。",
    thinkingHint: "思考能力取决于当前模型的原生能力与服务支持。仅显示服务实际返回的思考内容；Agent 无法为不支持的模型生成原生思考能力。",
    baseUrl: "Base URL", baseUrlOptional: "Base URL（可选）", baseRequired: "请输入所选服务的 Base URL。",
    baseHint: "请使用 HTTPS，或本地回环地址的 HTTP。填写服务的 Chat Completions 基础地址；如服务要求，请包含 /v1。",
    deepseekBaseHint: "DeepSeek 原生 Messages 使用 https://api.deepseek.com/anthropic。请使用 HTTPS，或本地回环地址的 HTTP。",
    anthropicBaseHint: "请使用 HTTPS，或本地回环地址的 HTTP。留空使用 Anthropic 默认地址。",
    invalidUrl: "请使用 HTTPS，或 localhost、127.0.0.1、[::1] 的 HTTP 地址。地址中不能包含凭据、查询参数或片段。",
    configureFailed: "无法保存 Agent 连接。请检查密钥、协议、地址和模型后重试。",
    configured: "Agent 连接已保存，仅在本次应用会话中使用。", reviewFirst: "请先回复当前待处理的请求。",
    usage: "用量", inputTokens: "输入", outputTokens: "输出", cacheRead: "缓存读取", cacheWrite: "缓存写入", cost: "费用", attachment: "附件",
  },
};
type Word = keyof typeof words.en;
let nextViewId = 0;

/** DOM-only renderer. The parent owns runtime routing, composition, and engine lifetime. */
export function setupClaudeView(options: ClaudeViewOptions): ClaudeView {
  const document = options.container.ownerDocument;
  const id = `claude-view-${++nextViewId}`;
  const t = (key: Word): string => {
    const translationKey = `claude.${key}`;
    const translated = options.translate?.(translationKey);
    return translated && translated !== translationKey ? translated : words[document.documentElement.lang.toLowerCase().startsWith("zh") ? "zh" : "en"][key];
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className: string, text: string, action: () => void): HTMLButtonElement => {
    const node = el("button", className, text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  };
  const root = el("section", "claude-view");
  const transcript = el("div", "claude-view-transcript");
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-label", t("transcript"));
  transcript.setAttribute("aria-live", "polite");
  const empty = el("p", "claude-view-empty", t("empty"));
  const bottom = el("footer", "claude-view-bottom");
  const statusText = el("span", "claude-view-status");
  statusText.setAttribute("role", "status");
  const metadata = el("span", "claude-view-metadata");
  const usageText = el("span", "claude-view-usage");
  const errorText = el("p", "claude-view-error");
  errorText.setAttribute("role", "alert");
  const connectionHint = el("p", "claude-view-connection-hint", t("unconfigured"));
  bottom.append(statusText, metadata, usageText, errorText, connectionHint);
  transcript.append(empty);
  root.append(transcript, bottom);
  options.container.append(root);

  let disposed = false;
  let generation = 0;
  let replaying = false;
  let status: ClaudeStatus = {};
  let connectionPromise: Promise<void> | undefined;
  let connectionModel = "deepseek-v4-flash";
  let connectionBaseUrl = "https://api.deepseek.com/anthropic";
  let connectionProtocol: AgentProtocol = "deepseek-messages";
  let connectionThinking: AgentThinking = "auto";
  let connectionEffort: AgentEffort | undefined;
  let connectionMaxActiveSubagents = 3;
  const blocks = new Map<string, { node: HTMLElement; text: string; wrapper: HTMLElement }>();
  const messages = new Map<string, HTMLElement>();
  const users = new Set<string>();
  const seenEvents = new Set<string>();
  const tools = new Map<string, { node: HTMLElement; title: HTMLElement; input: HTMLElement; output: HTMLElement; state: HTMLElement }>();
  const agentCards = new Map<string, { node: HTMLDetailsElement; label: HTMLElement; state: HTMLElement; activity: HTMLElement; result: HTMLElement }>();
  const routeCards = new Map<string, HTMLElement>();
  const resolvedApprovals = new Set<string>();
  type ApprovalEvent = Extract<ClaudeViewEvent, { type: "approval" }>;
  type Approval = { event: ApprovalEvent; node: HTMLElement; label: HTMLElement; review: HTMLButtonElement; submitted: boolean; done: boolean };
  const approvals = new Map<string, Approval>();
  type Dialog = { kind: "connection" | "approval"; approvalId?: string; panel: HTMLElement; body: HTMLElement; footer: HTMLElement; closeButton: HTMLButtonElement; close(): void };
  let dialog: Dialog | undefined;

  // Errors may come from remote hosts. Never insert markup or display standard secret formats.
  const safeError = (value: unknown): string => typeof value === "string" ? value
    .replace(/\bsk-[\w-]+/gi, "[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted]")
    .replace(/((?:api[_-]?key|authorization|auth[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]") : "";
  const format = (value: unknown): string => {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, 2) ?? ""; } catch { return ""; }
  };
  function rememberConnection(state: ClaudeStatus): void {
    if (state.model) connectionModel = state.model;
    if (typeof state.baseUrl === "string") connectionBaseUrl = state.baseUrl;
    if (state.protocol === "deepseek-messages" || state.protocol === "openai-completions" || state.protocol === "anthropic-messages") connectionProtocol = state.protocol;
    if (state.thinking === "off" || state.thinking === "on" || state.thinking === "auto") connectionThinking = state.thinking;
    if (state.effort === "low" || state.effort === "high" || state.effort === "max") connectionEffort = state.effort;
    else if ("effort" in state) connectionEffort = undefined;
    if (Number.isSafeInteger(state.maxActiveSubagents) && state.maxActiveSubagents! >= 1 && state.maxActiveSubagents! <= 4) {
      connectionMaxActiveSubagents = state.maxActiveSubagents!;
    }
    if (state.engine === "claude") {
      connectionProtocol = "anthropic-messages";
      connectionBaseUrl = state.baseUrl || "";
    }
  }
  function renderStatus(notify = true): void {
    statusText.textContent = t(status.waitingApproval ? "waiting" : status.busy ? "busy" : status.ready ? "ready" : "disconnected");
    metadata.textContent = [status.model, status.cwd].filter(Boolean).join(" · ");
    errorText.textContent = safeError(status.error);
    connectionHint.hidden = !!status.ready;
    root.setAttribute("aria-busy", String(!!status.busy && !status.waitingApproval));
    if (notify && !disposed && !replaying) options.onStatus?.({ ...status });
  }
  function append(node: HTMLElement): void {
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
    empty.hidden = true;
    transcript.append(node);
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
  }
  function message(event: { runId?: string; messageId?: string }): HTMLElement {
    const key = JSON.stringify([event.runId ?? "", event.messageId ?? "assistant"]);
    let body = messages.get(key);
    if (!body || body.parentElement !== transcript.lastElementChild) {
      const node = el("article", "claude-view-message claude-view-assistant");
      node.dataset.role = "assistant";
      node.append(el("div", "claude-view-message-label", "Agent"));
      body = el("div", "claude-view-message-body");
      node.append(body);
      messages.set(key, body);
      append(node);
    }
    return body;
  }
  function focusables(panel: HTMLElement): HTMLElement[] {
    return Array.from(panel.querySelectorAll<HTMLElement>("button, input, textarea, select, summary, [tabindex]"))
      .filter((node) => !node.hasAttribute("disabled") && node.tabIndex >= 0 && !node.hidden && !node.closest("[hidden]"));
  }
  function makeDialog(kind: Dialog["kind"], title: string, cancel: () => void): Dialog {
    const previous = document.activeElement as HTMLElement | null;
    const overlay = el("div", "claude-view-modal");
    const panel = el("section", "claude-view-dialog");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.tabIndex = -1;
    const heading = el("h2", "claude-view-dialog-title", title);
    heading.id = `${id}-dialog-title`;
    panel.setAttribute("aria-labelledby", heading.id);
    const closeButton = button("claude-view-close", "×", cancel);
    closeButton.setAttribute("aria-label", t("close"));
    const header = el("header", "claude-view-dialog-header");
    header.append(heading, closeButton);
    const body = el("div", "claude-view-dialog-body");
    const footer = el("footer", "claude-view-dialog-footer");
    panel.append(header, body, footer);
    overlay.append(panel);
    root.append(overlay);
    let closed = false;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); cancel();
      } else if (event.key === "Tab") {
        const items = focusables(panel);
        const current = items.indexOf(document.activeElement as HTMLElement);
        const target = event.shiftKey ? (current <= 0 ? items.length - 1 : current - 1) : (current < 0 || current === items.length - 1 ? 0 : current + 1);
        event.preventDefault(); event.stopImmediatePropagation();
        (items[target] ?? panel).focus();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (!closed && !panel.contains(event.target as Node)) (focusables(panel)[0] ?? panel).focus();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);
    const result: Dialog = { kind, panel, body, footer, closeButton, close() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      overlay.remove();
      if (dialog === result) dialog = undefined;
      if (!disposed && previous?.isConnected) previous.focus();
    } };
    dialog = result;
    panel.focus();
    return result;
  }
  function nextApproval(): void {
    if (disposed || replaying || dialog) return;
    const entry = Array.from(approvals.values()).find((item) => !item.submitted && !item.done);
    if (entry) showApproval(entry);
  }
  function finishApproval(entry: Approval, label: string): void {
    entry.done = true;
    resolvedApprovals.add(entry.event.approvalId);
    entry.label.textContent = label;
    entry.review.disabled = true;
    if (dialog?.approvalId === entry.event.approvalId) dialog.close();
    status.waitingApproval = Array.from(approvals.values()).some((item) => !item.done);
    renderStatus();
    nextApproval();
  }
  function questionsFor(event: ApprovalEvent): ClaudeQuestion[] {
    const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
    const candidates = event.questions ?? input.questions;
    return Array.isArray(candidates) ? candidates.filter((item): item is ClaudeQuestion => !!item && typeof item === "object" && typeof item.question === "string") : [];
  }
  function showApproval(entry: Approval): void {
    if (disposed || entry.done || entry.submitted) return;
    if (dialog) { dialog.panel.focus(); return; }
    const questions = questionsFor(entry.event);
    const asking = entry.event.toolName === "AskUserQuestion" || questions.length > 0;
    const current = makeDialog("approval", t(asking ? "ask" : "approval"), () => { void respond(false); });
    current.approvalId = entry.event.approvalId;
    current.body.append(el("p", "claude-view-tool-name", entry.event.toolName));
    const warning = el("p", "claude-view-error");
    warning.setAttribute("role", "alert");
    const reads: (() => [string, string] | null)[] = [];
    if (asking) {
      questions.forEach((question, questionIndex) => {
        const fieldset = el("fieldset", "claude-view-question");
        if (question.header) fieldset.append(el("div", "claude-view-question-header", question.header));
        fieldset.append(el("legend", "claude-view-question-title", question.question));
        const choices = Array.isArray(question.options) ? question.options.filter((item) => item && typeof item.label === "string") : [];
        const inputs: { node: HTMLInputElement; label: string }[] = [];
        choices.forEach((choice) => {
          const label = el("label", "claude-view-choice");
          const node = el("input", "claude-view-choice-input");
          node.type = question.multiSelect ? "checkbox" : "radio";
          node.name = `${id}-${entry.event.approvalId}-question-${questionIndex}`;
          const text = el("span", "claude-view-choice-copy");
          text.append(el("span", "claude-view-choice-label", choice.label));
          if (choice.description) text.append(el("span", "claude-view-choice-description", choice.description));
          label.append(node, text); fieldset.append(label);
          inputs.push({ node, label: choice.label });
        });
        const otherLabel = el("label", "claude-view-choice");
        const other = el("input", "claude-view-choice-input");
        other.type = question.multiSelect ? "checkbox" : "radio";
        other.name = `${id}-${entry.event.approvalId}-question-${questionIndex}`;
        otherLabel.append(other, el("span", "claude-view-choice-label", t("other")));
        const free = el("input", "claude-view-other");
        free.type = "text"; free.placeholder = t("otherHint");
        free.setAttribute("aria-label", `${question.question} — ${t("other")}`);
        free.addEventListener("input", () => { if (free.value.trim()) other.checked = true; });
        other.addEventListener("change", () => { if (other.checked) free.focus(); });
        if (!choices.length) { other.checked = true; otherLabel.hidden = true; }
        fieldset.append(otherLabel, free); current.body.append(fieldset);
        reads.push(() => {
          const selected = inputs.filter((item) => item.node.checked).map((item) => item.label);
          if (other.checked) {
            if (!free.value.trim()) return null;
            selected.push(free.value.trim());
          }
          return selected.length ? [question.question, selected.join(", ")] : null;
        });
      });
    } else {
      current.body.append(el("pre", "claude-view-code", format(entry.event.input)));
    }
    current.body.append(warning);
    const deny = button("claude-view-deny", t(asking ? "cancel" : "deny"), () => { void respond(false); });
    const allow = button("claude-view-primary", t(asking ? "submit" : "allow"), () => { void respond(true); });
    current.footer.append(deny, allow);
    if (!asking) {
      current.body.append(el("p", "claude-view-connection-help", t("fullAccessHint")));
      current.footer.append(button("claude-view-full-access", t("allowAll"), () => { void allowAll(); }));
    }
    deny.focus();
    async function allowAll(): Promise<void> {
      if (disposed || entry.submitted || entry.done) return;
      entry.submitted = true;
      const epoch = generation;
      for (const node of current.panel.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")) node.disabled = true;
      try {
        await options.invoke("claude_action", { action: "permissions", payload: {
          mode: "full", expectedWorkspace: status.cwd, expectedSessionId: status.sessionId || null,
        } });
        if (!disposed && generation === epoch) {
          status.permissionMode = "full";
          if (!entry.done) finishApproval(entry, t("resolved"));
          options.toast?.(t("fullAccess"));
        }
      } catch {
        if (!disposed && generation === epoch && !entry.done) {
          entry.submitted = false;
          warning.textContent = t("approvalFailed");
          for (const node of current.panel.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")) node.disabled = false;
        }
      }
    }
    async function respond(allowResponse: boolean): Promise<void> {
      if (disposed || entry.submitted || entry.done) return;
      let answers: Record<string, string> | undefined;
      if (allowResponse && asking) {
        const values = reads.map((read) => read());
        if (!values.length || values.some((value) => value === null)) {
          warning.textContent = t("answerRequired");
          return;
        }
        answers = Object.fromEntries(values as [string, string][]);
      }
      entry.submitted = true;
      entry.review.disabled = true;
      entry.label.textContent = t("sending");
      for (const node of current.panel.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")) node.disabled = true;
      const epoch = generation;
      try {
        await options.invoke("claude_action", { action: "approval", payload: { approvalId: entry.event.approvalId, allow: allowResponse, ...(answers ? { answers } : {}) } });
        if (!disposed && generation === epoch && !entry.done) finishApproval(entry, t(allowResponse ? "resolved" : "denied"));
      } catch {
        if (!disposed && generation === epoch && !entry.done) {
          // A transport failure can follow a successful send. Never send a conflicting second decision.
          finishApproval(entry, t("approvalFailed"));
          options.toast?.(t("approvalFailed"));
        }
      }
    }
  }
  function handleEvent(value: unknown): void {
    if (disposed || !value || typeof value !== "object") return;
    const event = value as ClaudeViewEvent;
    switch (event.type) {
      case "status": {
        const fields: (keyof ClaudeStatus)[] = ["engine", "ready", "busy", "configured", "cwd", "sessionId", "model", "baseUrl", "protocol", "thinking", "effort", "maxActiveSubagents", "waitingApproval", "permissionMode", "error"];
        for (const field of fields) if (field in event) Object.assign(status, { [field]: event[field] });
        rememberConnection(status);
        renderStatus(); break;
      }
      case "route": {
        if (!["simple", "moderate", "complex"].includes(event.level) || !Array.isArray(event.domains) || !Array.isArray(event.skills)) return;
        const key = event.runId || "current";
        let card = routeCards.get(key);
        if (!card) {
          card = el("section", "claude-view-route");
          card.append(el("strong", "claude-view-route-title", t("route")));
          card.append(el("p", "claude-view-route-detail"));
          routeCards.set(key, card);
          append(card);
        }
        const level = event.level === "complex" ? "routeComplex" : event.level === "moderate" ? "routeModerate" : "routeSimple";
        const details = [
          t(level),
          ...event.domains.slice(0, 6).map((domain) => String(domain).slice(0, 40)),
          event.agent ? `${event.manualAgent ? t("routeManual") : t("routeAuto")}: ${event.agent.slice(0, 120)}` : "",
          event.skills.length ? `${t("routeSkills")}: ${event.skills.slice(0, 3).map((skill) => String(skill).slice(0, 64)).join(", ")}` : "",
          `${t("routeSubagents")}: ${Math.max(0, Math.min(4, Number(event.parallelAgents) || 0))}`,
          ...(Array.isArray(event.warnings) ? event.warnings.slice(0, 2).filter(value => typeof value === "string").map(value => value.slice(0, 200)) : []),
        ].filter(Boolean);
        (card.lastElementChild as HTMLElement).textContent = details.join(" · ");
        break;
      }
      case "agent": {
        if (typeof event.agentId !== "string" || !event.agentId || event.agentId.length > 256) return;
        const key = JSON.stringify([event.runId ?? "", event.agentId]);
        let card = agentCards.get(key);
        if (!card) {
          const node = el("details", "claude-view-agent");
          const summary = el("summary", "claude-view-agent-summary");
          const label = el("span", "claude-view-agent-label");
          const state = el("span", "claude-view-agent-state");
          summary.append(label, state);
          const activity = el("p", "claude-view-agent-activity");
          const result = el("pre", "claude-view-code claude-view-agent-result");
          node.append(summary, activity, result);
          card = { node, label, state, activity, result };
          agentCards.set(key, card);
          append(node);
        }
        card.node.dataset.agentSessionId = event.agentId;
        card.node.tabIndex = 0;
        if (typeof event.label === "string" && event.label.trim()) card.label.textContent = event.label.slice(0, 120);
        else if (!card.label.textContent) card.label.textContent = `${t("subagent")} · ${event.agentId.slice(0, 8)}`;
        const agentStatus = ["running", "ready", "completed", "failed", "cancelled"].includes(event.status) ? event.status : "running";
        const agentStatusWord: Record<string, Word> = {
          running: "agentRunning", ready: "agentReady", completed: "agentCompleted", failed: "agentFailed", cancelled: "agentCancelled",
        };
        card.node.dataset.status = agentStatus;
        card.state.textContent = t(agentStatusWord[agentStatus]);
        if (typeof event.activity === "string") card.activity.textContent = event.activity.slice(0, 160);
        if (typeof event.result === "string") card.result.textContent = event.result.slice(0, 16000);
        card.activity.hidden = !card.activity.textContent;
        card.result.hidden = !card.result.textContent;
        break;
      }
      case "text":
      case "thinking": {
        if (typeof event.text !== "string") return;
        if (event.eventId) {
          const key = JSON.stringify([event.runId, event.eventId]);
          if (seenEvents.has(key)) return;
          seenEvents.add(key);
        }
        const key = JSON.stringify([event.runId ?? "", event.messageId ?? "assistant", event.blockId ?? "default", event.type]);
        let block = blocks.get(key);
        if (!block && !event.text) return;
        const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
        if (!block) {
          const node = el("div", `claude-view-${event.type}-content`);
          let wrapper: HTMLElement = node;
          if (event.type === "thinking") {
            const details = el("details", "claude-view-thinking");
            details.append(el("summary", "claude-view-thinking-label", t("thinking")), node);
            wrapper = details;
          }
          block = { node, wrapper, text: "" }; blocks.set(key, block);
          message(event).append(wrapper);
        }
        block.text = event.append ? block.text + event.text : event.text;
        const textNode = block.node.firstChild;
        if (event.append && textNode?.nodeType === 3) (textNode as Text).appendData(event.text);
        else block.node.textContent = block.text;
        block.wrapper.hidden = !block.text;
        if (atBottom) transcript.scrollTop = transcript.scrollHeight;
        break;
      }
      case "user": {
        if (typeof event.text !== "string") return;
        const key = event.messageId ? JSON.stringify([event.runId, event.messageId]) : undefined;
        if (key && users.has(key)) return;
        if (key) users.add(key);
        const node = el("article", "claude-view-message claude-view-user");
        node.dataset.role = "user";
        node.append(el("div", "claude-view-message-label", t("user")), el("div", "claude-view-text-content", event.text));
        if (Array.isArray(event.attachments) && event.attachments.length) {
          const list = el("ul", "claude-view-attachments");
          for (const attachment of event.attachments) {
            const item = attachment && typeof attachment === "object" ? attachment as Record<string, unknown> : {};
            const name = typeof attachment === "string" ? attachment : item.name ?? item.fileName ?? item.path;
            list.append(el("li", "claude-view-attachment", typeof name === "string" ? name : t("attachment")));
          }
          node.append(list);
        }
        append(node); break;
      }
      case "tool": {
        if (!event.toolId) return;
        const key = JSON.stringify([event.runId ?? "", event.toolId]);
        let tool = tools.get(key);
        if (!tool) {
          const node = el("details", "claude-view-tool");
          const summary = el("summary", "claude-view-tool-summary");
          const title = el("span", "claude-view-tool-name", event.name || t("tool"));
          const state = el("span", "claude-view-tool-state");
          const input = el("pre", "claude-view-code claude-view-tool-input");
          input.setAttribute("aria-label", t("input"));
          const output = el("pre", "claude-view-code claude-view-tool-output");
          output.setAttribute("aria-label", t("output"));
          summary.append(title, state); node.append(summary, input, output);
          tool = { node, title, state, input, output }; tools.set(key, tool); append(node);
        }
        if (event.name) tool.title.textContent = event.name;
        if ("input" in event) tool.input.textContent = format(event.input);
        if ("result" in event) tool.output.textContent = format(event.result);
        tool.input.hidden = !tool.input.textContent;
        tool.output.hidden = !tool.output.textContent;
        const toolStatus = event.status || tool.node.dataset.status || "pending";
        const labels: Record<string, Word> = { pending: "pending", running: "running", started: "running", completed: "completed", complete: "completed", success: "completed", done: "completed", error: "failed", failed: "failed", denied: "denied", cancelled: "cancelled" };
        tool.node.dataset.status = toolStatus;
        tool.state.textContent = labels[toolStatus] ? t(labels[toolStatus]) : toolStatus;
        break;
      }
      case "approval": {
        if (!event.approvalId || resolvedApprovals.has(event.approvalId) || approvals.has(event.approvalId)) return;
        const node = el("article", "claude-view-approval");
        const label = el("span", "claude-view-approval-state", t("waiting"));
        const review = button("claude-view-review", t("review"), () => showApproval(entry));
        const entry: Approval = { event, node, label, review, submitted: false, done: false };
        node.append(el("span", "claude-view-tool-name", event.toolName), label, review);
        approvals.set(event.approvalId, entry); append(node);
        status.waitingApproval = true; renderStatus(); nextApproval(); break;
      }
      case "approval_resolved": {
        resolvedApprovals.add(event.approvalId);
        const entry = approvals.get(event.approvalId);
        if (entry) finishApproval(entry, t("resolved"));
        break;
      }
      case "result": {
        status.busy = false;
        if (event.sessionId) status.sessionId = event.sessionId;
        status.error = safeError(event.error);
        const parts: string[] = [];
        const usageFields: [string, Word][] = [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"], ["cache_read_input_tokens", "cacheRead"], ["cache_creation_input_tokens", "cacheWrite"]];
        for (const [field, label] of usageFields) {
          const count = event.usage?.[field];
          if (typeof count === "number" && Number.isFinite(count)) parts.push(`${t(label)} ${count.toLocaleString()}`);
        }
        if (typeof event.cost === "number" && Number.isFinite(event.cost)) parts.push(`${t("cost")} $${event.cost.toFixed(4)}`);
        usageText.textContent = parts.length ? `${t("usage")}: ${parts.join(" · ")}` : "";
        for (const entry of approvals.values()) {
          if (!entry.done && (!event.runId || entry.event.runId === event.runId)) finishApproval(entry, t("cancelled"));
        }
        renderStatus(); break;
      }
    }
  }
  function reset(): void {
    if (disposed) return;
    generation++;
    // Session switching is managed by the parent; no new engine writes on teardown.
    dialog?.close();
    transcript.replaceChildren(empty); empty.hidden = false;
    blocks.clear(); messages.clear(); users.clear(); seenEvents.clear(); tools.clear(); agentCards.clear(); routeCards.clear(); approvals.clear(); resolvedApprovals.clear();
    status = {}; usageText.textContent = "";
    renderStatus();
  }
  function setSession(state: ClaudeSessionState | null): void {
    if (disposed) return;
    replaying = true;
    reset();
    if (state) {
      for (const item of state.messages ?? []) handleEvent({ ...item, type: "user" });
      for (const event of state.history ?? []) handleEvent(event);
      const { history: _history, messages: _messages, ...fields } = state;
      status = { ...status, ...fields };
      rememberConnection(status);
    }
    replaying = false;
    renderStatus(); nextApproval();
  }
  function configure(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (connectionPromise) { dialog?.panel.focus(); return connectionPromise; }
    if (dialog) { options.toast?.(t("reviewFirst")); dialog.panel.focus(); return Promise.resolve(); }
    const epoch = generation;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    connectionPromise = promise;
    let pending = false;
    let closed = false;
    let keyInput: HTMLInputElement;
    const close = () => {
      if (closed) return;
      closed = true;
      keyInput.value = "";
      current.close();
      connectionPromise = undefined;
      resolve();
      nextApproval();
    };
    const current = makeDialog("connection", t("configure"), close);
    // Reset/dispose use the same cleanup as closing the connection dialog.
    const removeDialog = current.close;
    current.close = () => {
      if (!closed) { closed = true; keyInput.value = ""; connectionPromise = undefined; resolve(); }
      removeDialog();
    };
    const nativeClaude = status.engine === "claude";
    current.body.append(el("p", "claude-view-connection-help", nativeClaude
      ? (document.documentElement.lang.startsWith("zh")
        ? "Claude 独立连接。密钥仅在本次应用会话中使用，不继承 Pi 凭据。"
        : "Independent Claude connection. The key is kept in memory for this app session. Pi credentials are not inherited.")
      : t("connectionHelp")));
    const form = el("form", "claude-view-connection-form");
    form.noValidate = true;
    function field(name: string, labelText: string, type: string, value: string): HTMLInputElement {
      const label = el("label", "claude-view-field");
      const input = el("input", "claude-view-field-input");
      input.type = type; input.name = name; input.value = value;
      input.autocomplete = name === "apiKey" ? "new-password" : "off";
      input.spellcheck = false;
      label.append(el("span", "claude-view-field-label", labelText), input); form.append(label);
      return input;
    }
    keyInput = field("apiKey", t("apiKey"), "password", "");
    keyInput.required = !status.configured;
    if (status.configured) keyInput.placeholder = t("keepKey");
    const controls = el("div", "claude-view-connection-controls");
    form.append(controls);
    function selectField(name: string, labelText: string, choices: readonly (readonly [string, string])[], value: string, parent: HTMLElement = controls): HTMLSelectElement {
      const label = el("label", "claude-view-field");
      const select = el("select", "claude-view-field-input");
      select.name = name;
      for (const [value, text] of choices) {
        const option = el("option", "", text);
        option.value = value;
        select.append(option);
      }
      select.value = value;
      label.append(el("span", "claude-view-field-label", labelText), select);
      parent.append(label);
      return select;
    }
    const protocolInput = selectField("protocol", t("protocol"), [
      ["deepseek-messages", t("deepseekProtocol")], ["openai-completions", t("openaiProtocol")], ["anthropic-messages", t("anthropicProtocol")],
    ].filter(([value]) => !nativeClaude || value === "anthropic-messages") as [string, string][], connectionProtocol);
    const thinkingInput = selectField("thinking", t("thinkingMode"), [
      ["off", t("thinkingOff")], ["on", t("thinkingOn")], ["auto", t("thinkingAuto")],
    ], connectionThinking);
    const thinkingHint = el("p", "claude-view-field-hint", t("thinkingHint"));
    thinkingHint.id = `${id}-thinking-hint`;
    thinkingInput.setAttribute("aria-describedby", thinkingHint.id);
    form.append(thinkingHint);
    const effortInput = selectField("effort", t("effort"), [
      ["", t("effortDefault")], ["low", t("effortLow")], ["high", t("effortHigh")], ["max", t("effortMax")],
    ], connectionEffort ?? "", form);
    const agentLimitInput = selectField("maxActiveSubagents", t("agentLimit"), [
      ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"],
    ], String(connectionMaxActiveSubagents), form);
    if (nativeClaude) {
      protocolInput.closest("label")!.hidden = true;
      agentLimitInput.closest("label")!.hidden = true;
    }
    const effortHint = el("p", "claude-view-field-hint", t("effortHint"));
    effortHint.id = `${id}-effort-hint`;
    effortInput.setAttribute("aria-describedby", effortHint.id);
    form.append(effortHint);
    const updateThinking = () => { effortInput.disabled = thinkingInput.value === "off"; };
    thinkingInput.addEventListener("change", updateThinking);
    updateThinking();
    const modelInput = field("model", t("model"), "text", connectionModel);
    modelInput.placeholder = t("modelPlaceholder");
    modelInput.required = true;
    const baseInput = field("baseUrl", t("baseUrl"), "url", connectionBaseUrl);
    const baseLabel = baseInput.previousElementSibling!;
    const baseHint = el("p", "claude-view-field-hint");
    baseHint.id = `${id}-base-hint`;
    baseInput.setAttribute("aria-describedby", baseHint.id);
    const defaultEndpoints: Record<AgentProtocol, string> = {
      "deepseek-messages": "https://api.deepseek.com/anthropic",
      "openai-completions": "https://api.deepseek.com/v1",
      "anthropic-messages": "",
    };
    let previousProtocol = connectionProtocol;
    function updateProtocol(): void {
      const protocol = protocolInput.value as AgentProtocol;
      if (protocol !== previousProtocol && baseInput.value.trim() === defaultEndpoints[previousProtocol]) {
        baseInput.value = defaultEndpoints[protocol];
      }
      previousProtocol = protocol;
      const anthropic = protocol === "anthropic-messages";
      baseInput.required = !anthropic;
      baseLabel.textContent = t(anthropic ? "baseUrlOptional" : "baseUrl");
      baseHint.textContent = t(anthropic ? "anthropicBaseHint" : protocol === "deepseek-messages" ? "deepseekBaseHint" : "baseHint");
    }
    protocolInput.addEventListener("change", updateProtocol);
    updateProtocol();
    form.append(baseHint);
    const warning = el("p", "claude-view-error"); warning.setAttribute("role", "alert");
    form.append(warning); current.body.append(form);
    const cancel = button("claude-view-cancel", t("cancel"), close);
    const save = button("claude-view-primary", t("save"), () => { void submit(); });
    current.footer.append(cancel, save);
    form.addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
    keyInput.focus();
    async function submit(): Promise<void> {
      if (disposed || closed || pending) return;
      const apiKey = keyInput.value.trim();
      if (!apiKey && !status.configured) { warning.textContent = t("keyRequired"); keyInput.focus(); return; }
      const model = modelInput.value.trim();
      if (!model) { warning.textContent = t("modelRequired"); modelInput.focus(); return; }
      const protocol = protocolInput.value as AgentProtocol;
      const thinking = thinkingInput.value as AgentThinking;
      const effort = thinking !== "off" && effortInput.value ? effortInput.value as AgentEffort : undefined;
      const baseUrl = baseInput.value.trim();
      if (protocol !== "anthropic-messages" && !baseUrl) { warning.textContent = t("baseRequired"); baseInput.focus(); return; }
      if (baseUrl) {
        let valid = false;
        try {
          const url = new URL(baseUrl);
          const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
          valid = (url.protocol === "https:" || (url.protocol === "http:" && loopback)) && !url.username && !url.password && !url.search && !url.hash;
        } catch { /* Validation is shown without repeating user-entered values. */ }
        if (!valid) { warning.textContent = t("invalidUrl"); baseInput.focus(); return; }
      }
      const maxActiveSubagents = Number(agentLimitInput.value);
      if (!Number.isSafeInteger(maxActiveSubagents) || maxActiveSubagents < 1 || maxActiveSubagents > 4) {
        warning.textContent = t("configureFailed"); agentLimitInput.focus(); return;
      }
      pending = true;
      warning.textContent = "";
      save.disabled = true; save.textContent = t("saving");
      modelInput.disabled = true; baseInput.disabled = true; keyInput.disabled = true;
      protocolInput.disabled = true; thinkingInput.disabled = true; effortInput.disabled = true; agentLimitInput.disabled = true;
      const payload: Record<string, unknown> = {
        ...(apiKey ? { apiKey } : {}),
        baseUrl, model, protocol, thinking,
        ...(effort ? { effort } : {}),
        ...(!nativeClaude && maxActiveSubagents !== connectionMaxActiveSubagents ? { maxActiveSubagents } : {}),
      };
      keyInput.value = "";
      try {
        const result = await options.invoke<unknown>("claude_action", { action: "configure", payload });
        if (disposed || generation !== epoch || closed) return;
        if (result && typeof result === "object" && (result as { ok?: boolean }).ok === false) throw new Error("configure failed");
        rememberConnection({ model, baseUrl, protocol, thinking, effort: effort ?? null, maxActiveSubagents });
        close(); options.toast?.(t("configured"));
      } catch {
        // Deliberately do not render the host's error: proxy errors can contain the submitted key.
        if (!disposed && generation === epoch && !closed) warning.textContent = t("configureFailed");
      } finally {
        if (typeof payload.apiKey === "string") payload.apiKey = "";
        if (!disposed && generation === epoch && !closed) {
          pending = false; save.disabled = false; save.textContent = t("save");
          modelInput.disabled = false; baseInput.disabled = false; keyInput.disabled = false;
          protocolInput.disabled = false; thinkingInput.disabled = false; agentLimitInput.disabled = false; updateThinking();
          keyInput.focus();
        }
      }
    }
    return promise;
  }
  renderStatus(false);
  return {
    handleEvent, setSession, reset, configure, openConnection: configure,
    dispose() {
      if (disposed) return;
      disposed = true; generation++;
      dialog?.close(); root.remove();
      blocks.clear(); messages.clear(); users.clear(); seenEvents.clear(); tools.clear(); routeCards.clear(); approvals.clear(); resolvedApprovals.clear();
    },
  };
}
