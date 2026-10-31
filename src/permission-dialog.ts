export type PermissionRequest = {
  title?: string;
  detail?: string;
  operation?: string;
  risk?: "low" | "medium" | "high";
  signal?: AbortSignal;
  toolApproval?: boolean;
  projectTrust?: boolean;
};

type PermissionDialog = {
  request(value: PermissionRequest): Promise<boolean>;
  dispose(): void;
};

const redact = (value: unknown): string => typeof value === "string"
  ? value
    .replace(/\bsk-[\w-]+/gi, "[已隐藏]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, "[已隐藏]")
    .replace(/\b(?:ghp_|github_pat_|glpat-|npm_)[\w-]+/gi, "[已隐藏]")
    .replace(/((?:api[_-]?key|authorization|auth[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[已隐藏]")
    .slice(0, 32000)
  : "";

export const isPermissionError = (error: unknown): boolean => {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /\b(?:eacces|eperm|permission denied|operation not permitted|access denied|not authorized)\b|需要权限|权限不足|拒绝访问|未授权/i.test(text);
};

export function setupPermissionDialog(options: {
  root?: HTMLElement;
  language: () => string;
  allowAll?(): Promise<void>;
}): PermissionDialog {
  const root = options.root || document.body;
  type Pending = { resolve: (value: boolean) => void; request: PermissionRequest; cleanup(): void };
  const pending: Pending[] = [];
  let disposed = false;
  let overlay: HTMLElement | undefined;
  let previousFocus: HTMLElement | null = null;

  const text = (zh: string, en: string) => options.language() === "en" ? en : zh;
  const close = (allow: boolean) => {
    const entry = pending.shift();
    overlay?.remove();
    overlay = undefined;
    entry?.cleanup();
    entry?.resolve(allow);
    if (previousFocus?.isConnected) previousFocus.focus();
    if (!disposed && pending.length) render();
  };
  const render = () => {
    const entry = pending[0];
    if (!entry || overlay || disposed) return;
    const request = entry.request;
    previousFocus = document.activeElement as HTMLElement | null;
    overlay = document.createElement("div");
    overlay.className = "permission-request-backdrop";
    overlay.setAttribute("role", "presentation");
    const dialog = document.createElement("section");
    dialog.className = "permission-request-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "permission-request-title");
    const heading = document.createElement("h2");
    heading.id = "permission-request-title";
    heading.textContent = request.title || text("需要额外权限", "Additional permission required");
    const risk = document.createElement("span");
    risk.className = `permission-request-risk risk-${request.risk || "medium"}`;
    risk.textContent = request.risk === "high" ? text("高风险", "High risk")
      : request.risk === "low" ? text("低风险", "Low risk") : text("需确认", "Review");
    heading.append(" ", risk);
    const body = document.createElement("div");
    body.className = "permission-request-body";
    const intro = document.createElement("p");
    intro.textContent = request.projectTrust
      ? text("信任后，Pi 可读取此项目的配置、安装项目依赖并执行项目扩展。请只信任你了解的项目。仅本次启动有效；拒绝或超时后将跳过这些项目资源，继续启动。此操作不授予系统权限。", "Trust lets Pi load this project's settings, install project packages and execute project extensions. Trust only projects you know. This decision lasts for this launch only. Denying or timing out skips those resources and continues startup; it does not grant OS permissions.")
      : request.toolApproval
      ? text("工具尚未执行，正在等待你确认。仅允许本次不会修改权限设置。Shell 可访问项目之外的文件和网络，请检查命令后再决定；此弹窗不授予系统级权限。", "The tool is paused until you decide. Allow once does not change your settings. Shell commands can access files and networks beyond the project; review carefully. This does not grant OS permissions.")
      : text("当前操作被系统或工作区权限拦截。请确认后再继续，应用不会自动授予系统级权限。", "The system or workspace blocked this operation. Confirm before continuing; the app cannot grant system-level permissions automatically.");
    body.append(intro);
    if (request.operation) {
      const operation = document.createElement("p");
      operation.className = "permission-request-operation";
      operation.textContent = `${text("操作", "Operation")}: ${redact(request.operation)}`;
      body.append(operation);
    }
    if (request.detail) {
      const detail = document.createElement("p");
      detail.textContent = redact(request.detail);
      body.append(detail);
    }
    const actions = document.createElement("footer");
    actions.className = "permission-request-actions";
    const deny = document.createElement("button");
    deny.type = "button"; deny.textContent = text("拒绝", "Deny");
    const allow = document.createElement("button");
    allow.type = "button"; allow.className = "primary-button";
    allow.textContent = request.projectTrust ? text("仅本次信任", "Trust for this launch") : text("仅允许本次", "Allow once");
    deny.addEventListener("click", () => close(false));
    allow.addEventListener("click", () => close(true));
    actions.append(deny, allow);
    let applying = false;
    if (request.toolApproval && !request.projectTrust && options.allowAll) {
      const hint = document.createElement("p");
      hint.textContent = text("一键放行会为当前项目的 Pi 开启文件、命令和联网工具访问。Agent 与 Skill 自动下载仍由独立开关控制。当前及后续工具不再逐次确认，可在权限设置恢复；系统隐私授权仍需系统确认。", "Allow all enables file, command and network tools for this Pi project. Automatic Agent/Skill downloads still follow their separate setting. Pending and future tools no longer ask individually. Restore approvals in settings; OS privacy access still requires system confirmation.");
      body.append(hint);
      const full = document.createElement("button");
      full.type = "button"; full.textContent = text("一键放行所有权限", "Allow all tool permissions");
      const warning = document.createElement("p");
      warning.setAttribute("role", "alert"); body.append(warning);
      full.addEventListener("click", async () => {
        if (applying || pending[0] !== entry) return;
        applying = true;
        actions.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
        try {
          // Backend resolution dismisses this request through its abort signal; do not send a second decision.
          await options.allowAll!();
        } catch (error) {
          if (pending[0] === entry) warning.textContent = redact(error instanceof Error ? error.message : String(error));
        } finally {
          applying = false;
          if (pending[0] === entry) actions.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = false; });
        }
      });
      actions.append(full);
    }
    dialog.append(heading, body, actions);
    overlay.append(dialog); root.append(overlay);
    overlay.addEventListener("click", event => { if (!applying && event.target === overlay) close(false); });
    dialog.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); if (!applying) close(false); }
      if (event.key === "Tab") {
        event.preventDefault();
        const buttons = [...actions.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    });
    deny.focus();
  };
  const request = (value: PermissionRequest): Promise<boolean> => {
    if (disposed || value.signal?.aborted) return Promise.resolve(false);
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    const abort = () => {
      const index = pending.indexOf(entry);
      if (index === 0) close(false);
      else if (index > 0) { pending.splice(index, 1); entry.cleanup(); resolve(false); }
    };
    const entry: Pending = { resolve, request: value, cleanup: () => value.signal?.removeEventListener("abort", abort) };
    pending.push(entry);
    value.signal?.addEventListener("abort", abort, { once: true });
    if (value.signal?.aborted) abort();
    render();
    return promise;
  };
  return {
    request,
    dispose() {
      disposed = true;
      overlay?.remove();
      overlay = undefined;
      while (pending.length) { const entry = pending.shift()!; entry.cleanup(); entry.resolve(false); }
      if (previousFocus?.isConnected) previousFocus.focus();
    },
  };
}
