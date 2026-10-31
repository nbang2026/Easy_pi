import { listen } from "@tauri-apps/api/event";
import { setupClaudeView, type ClaudeViewEvent, type AgentProtocol, type AgentThinking, type AgentEffort } from "./claude-view";
import type { AgentSession } from "./agent-session-strip";
import { formatUserError } from "./utils.ts";

export type Engine = "pi" | "claude";
export type EngineChoice = Engine | "auto";
type State = { ready?: boolean; busy?: boolean; configured?: boolean; connected?: boolean; waitingApproval?: boolean; sessionId?: string; cwd?: string; model?: string; error?: string; roleId?: string; protocol?: AgentProtocol; thinking?: AgentThinking; effort?: AgentEffort; maxActiveSubagents?: number; baseUrl?: string; history?: ClaudeViewEvent[]; agents?: AgentSession[] };
type Workbench = { requireSwitch(forSubmission?: boolean): void; engineChanged(): void; setState(value: unknown): void; setRuntime(info: { cwd: string; bridgeId?: string }): void; runtimeId?(): string; getState?(): { busy?: boolean; pending?: boolean }; refreshStrings(): void; observeEvent?(value: unknown): void };
export function setupAgentRuntime(options: {
  desktop: boolean;
  invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T>;
  workbench(): Workbench | undefined;
  cwd(): string;
  stopPi(): Promise<void>;
  piConnecting?(): boolean;
  connectPi(cwd: string, session?: string): Promise<void>;
  changed(): void;
  status(info: { cwd: string; executable: string }): void;
  toast(message: string): void;
}) {
  const select = document.getElementById("agent-select") as HTMLSelectElement;
  const connection = document.getElementById("claude-connection") as HTMLButtonElement;
  const container = document.getElementById("claude-view")!;
  let engine: Engine = "pi";
  let selectedMode: EngineChoice = "pi";
  let autoProbeSucceeded = false;
  try {
    const stored = localStorage.getItem("easy_pi.engineMode");
    if (stored === "auto" || stored === "pi" || stored === "claude") selectedMode = stored;
  } catch { /* Optional preference. */ }
  let runtimeId = "";
  let runtimeAlive = false;
  let state: State = {};
  let switching = false;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const hiddenBeforeClaude = new Map<string, boolean>();
  let roleId = "";
  const agents = new Map<string, AgentSession>();
  try { roleId = localStorage.getItem("easy_pi.agentRole") || localStorage.getItem("easy_pi.claudeRole") || ""; } catch { /* Optional preference. */ }
  const call = <T = State>(action: string, payload: Record<string, unknown> = {}) => options.invoke<T>("claude_action", { action, payload });
  const applyState = (value: State) => {
    state = { ...state, ...value, waitingApproval: value.waitingApproval ?? false };
    if (engine !== "claude" || disposed) return;
    options.workbench()?.setState({ ready: !!state.ready && !state.busy && !state.waitingApproval && state.configured !== false,
      busy: !!state.busy || !!state.waitingApproval, connected: runtimeAlive, cwd: state.cwd || options.cwd(),
      session: state.sessionId ? `agent:${state.sessionId}` : "", sessionId: state.sessionId || "", model: state.model || "Agent", bridgeId: runtimeId,
      agents: [...agents.values()] });
    if (Array.isArray(value.history)) for (const event of value.history) {
      if (event.type === "tool") options.workbench()?.observeEvent?.(event);
    }
    options.status({ cwd: state.cwd || options.cwd(), executable: "Claude Agent SDK" });
  };
  const view = setupClaudeView({ container, invoke: async <T>(command: string, args?: Record<string, unknown>) => {
    const result = await options.invoke<T>(command, args);
    if (args?.action === "configure" || args?.action === "permissions") { const value = await call<State>("status"); applyState(value); view.handleEvent({ type: "status", ...value }); }
    return result;
  }, toast: options.toast });
  const show = () => {
    if (disposed) return;
    const english = document.documentElement.lang === "en";
    for (const [value, zh, en] of [["auto", "自动选择", "Auto"], ["pi", "Pi", "Pi"], ["claude", "Claude", "Claude"]] as const) {
      const option = [...select.options].find((item) => item.value === value);
      if (option) option.textContent = english ? en : zh;
    }
    const engineLabel = select.closest("label");
    if (engineLabel) engineLabel.title = english ? "Execution engine" : "执行引擎";
    document.body.dataset.agentEngine = engine;
    select.value = selectedMode;
    select.disabled = switching || !options.desktop;
    connection.hidden = engine !== "claude";
    connection.disabled = switching || !!state.busy;
    container.hidden = engine !== "claude";
    for (const id of ["terminal", "terminal-welcome", "scroll-bottom", "export-terminal"]) {
      const element = document.getElementById(id);
      if (!element) continue;
      if (engine === "claude") {
        if (!hiddenBeforeClaude.has(id)) hiddenBeforeClaude.set(id, element.hidden);
        element.hidden = true;
      } else if (hiddenBeforeClaude.has(id)) {
        element.hidden = hiddenBeforeClaude.get(id)!;
        hiddenBeforeClaude.delete(id);
      }
    }
    const thinking = document.getElementById("thinking-select") as HTMLSelectElement | null;
    if (thinking) thinking.disabled = engine === "claude";
    const composerToggle = document.getElementById("composer-toggle") as HTMLButtonElement | null;
    if (composerToggle) composerToggle.disabled = engine === "claude";
    const sendModeBar = document.getElementById("sendmode-bar");
    sendModeBar?.setAttribute("aria-disabled", String(engine === "claude"));
    sendModeBar?.querySelectorAll<HTMLButtonElement>(".sendmode").forEach((button) => { button.disabled = engine === "claude"; });
    connection.textContent = document.documentElement.lang === "en" ? "Agent connection" : "Agent 连接";
    document.getElementById("current-model")?.setAttribute("title", engine === "claude" ? (state.model || "Agent") : "Pi");
  };
  const start = async (cwd: string) => {
    const value = await options.invoke<{ runtimeId: string; status: State }>("start_claude", { cwd });
    if (disposed) { runtimeAlive = false; await options.invoke("stop_claude"); throw Error("Agent view closed"); }
    runtimeAlive = true;
    runtimeId = value.runtimeId; state = value.status;
    agents.clear();
    for (const item of value.status.agents || []) if (item?.id) agents.set(item.id, item);
    view.setSession(state);
    return value;
  };
  const chooseAuto = async (prompt?: string): Promise<Engine> => {
    const input = prompt ?? (document.getElementById("composer-input") as HTMLTextAreaElement | null)?.value ?? "";
    const complex = input.length > 700 || /\b(architect|architecture|refactor|migration|multi[- ]agent|review|security)\b|设计|架构|重构|迁移|多\s*agent|审查|安全/i.test(input);
    const probeClaude = async () => {
      await options.invoke("probe_claude", { cwd: options.cwd() || state.cwd || "~" });
      if (!runtimeId || !runtimeAlive) {
        if (runtimeId) {
          await options.invoke("stop_claude").catch(() => {});
          runtimeId = ""; runtimeAlive = false;
        }
        await start(options.cwd() || state.cwd || "~");
      }
      else state = await call<State>("status");
      if (!state.ready || state.configured !== true) throw Error("Claude 尚未配置。");
      autoProbeSucceeded = true;
      return "claude" as Engine;
    };
    if (complex) {
      try { return await probeClaude(); } catch { /* Fall back to the connected Pi runtime. */ }
    }
    try {
      const pi = await options.invoke<{ connected?: boolean; ready?: boolean }>("gui_status");
      if (pi.connected || pi.ready) return "pi";
    } catch { /* Try Claude when Pi is unavailable. */ }
    try { return await probeClaude(); } catch { return "pi"; }
  };
  const change = async (target?: EngineChoice, prompt?: string, forSubmission = false) => {
    const choice = target || select.value as EngineChoice;
    if (!["auto", "pi", "claude"].includes(choice)) throw Error("未知执行器。");
    select.value = selectedMode;
    if (disposed) throw Error("Agent view closed");
    if (!options.desktop) throw Error("执行器切换需要桌面应用。");
    if (switching) throw Error("正在切换执行引擎，请稍后。");
    switching = true; show();
    try {
    const next = choice === "auto" ? await chooseAuto(prompt) : choice;
    if (next === engine) {
      autoProbeSucceeded = false;
      selectedMode = choice;
      try { localStorage.setItem("easy_pi.engineMode", choice); } catch { /* Optional preference. */ }
      show(); return;
    }
      if (options.piConnecting?.()) throw Error("Pi 正在连接，请稍后再切换引擎。");
      options.workbench()?.requireSwitch(forSubmission);
      if (state.busy || state.waitingApproval) throw Error("请先停止当前任务并处理待批准操作。");
      const cwd = options.cwd() || state.cwd || "~";
      if (next === "claude") {
        if (!autoProbeSucceeded) await options.invoke("probe_claude", { cwd });
        autoProbeSucceeded = false;
        if (runtimeId) {
          try {
            state = await call<State>("status");
            if (state.ready === false) throw Error("Agent 进程已退出。");
            if (state.cwd !== cwd) { state = await call<State>("workspace", {cwd}); view.setSession(state); }
          } catch (error) {
            await options.invoke("stop_claude"); runtimeId = ""; runtimeAlive = false; state = {};
            await start(cwd);
          }
        } else await start(cwd);
        await options.stopPi();
        engine = "claude"; options.workbench()?.engineChanged();
        options.workbench()?.setRuntime({ cwd, bridgeId: runtimeId }); applyState(state);
      } else {
        try {
          await options.connectPi(cwd);
          const value = await options.invoke<{bridgeId?:string}>("gui_status");
          engine = "pi"; options.workbench()?.engineChanged();
          options.workbench()?.setRuntime({cwd,bridgeId:value.bridgeId}); options.workbench()?.setState(value);
        } catch (error) {
          options.workbench()?.engineChanged();
          options.workbench()?.setRuntime({cwd:state.cwd || cwd,bridgeId:runtimeId}); applyState(state);
          throw error;
        }
      }
      selectedMode = choice;
      try { localStorage.setItem("easy_pi.engineMode", choice); } catch { /* Optional preference. */ }
      switching = false; show(); options.changed();
      if (engine === "claude" && !state.configured) void view.configure().catch((error) => options.toast(formatUserError(error)));
    } finally { switching = false; if (!disposed) show(); }
  };
  const onConnection = () => { void view.configure().catch((error) => options.toast(formatUserError(error))); };
  const onChange = () => { void change().catch((error) => options.toast(formatUserError(error))); };
  select.addEventListener("change", onChange);
  connection.addEventListener("click", onConnection);
  if (options.desktop) void listen<Record<string, unknown>>("claude-agent-event", ({ payload }) => {
    if (disposed || payload.runtimeId !== runtimeId) return;
    if (engine !== "claude") {
      if (payload.type === "runtime_error") state = {...state,ready:false,busy:false,waitingApproval:false,error:formatUserError(payload.error || "Agent runtime exited", "Agent runtime exited")};
      return;
    }
    if (payload.type === "agent" && typeof payload.agentId === "string" && payload.agentId) {
      const previous = agents.get(payload.agentId);
      const allowed = ["pending", "running", "ready", "completed", "failed", "cancelled"];
      const status = allowed.includes(String(payload.status)) ? String(payload.status) as AgentSession["status"] : "running";
      agents.set(payload.agentId, {
        id: payload.agentId,
        label: typeof payload.label === "string" && payload.label.trim() ? payload.label.slice(0, 80) : previous?.label,
        title: typeof payload.activity === "string" ? payload.activity.slice(0, 180) : previous?.title,
        activity: typeof payload.activity === "string" ? payload.activity.slice(0, 160) : previous?.activity,
        status,
        kind: "subagent",
      });
      applyState({ agents: [...agents.values()] });
    }
    view.handleEvent(payload);
    if (payload.type === "tool") options.workbench()?.observeEvent?.(payload);
    if (payload.type === "runtime_error") {
      runtimeAlive = false;
      agents.clear();
      const runtimeError = formatUserError(payload.error || "Agent runtime exited", "Agent runtime exited");
      applyState({ ready:false, busy:false, waitingApproval:false, error:runtimeError, agents: [] });
      view.handleEvent({type:"result",error:runtimeError});
      show();
    }
    if (payload.type === "status") { applyState(payload as State); show(); }
    if (payload.type === "result") {
      void call<State>("status").then((value) => { if (!disposed && engine === "claude" && payload.runtimeId === runtimeId) { applyState(value); show(); } }).catch((error) => options.toast(formatUserError(error)));
    }
  }).then((remove) => { if (disposed) remove(); else unlisten = remove; }).catch((error) => options.toast(formatUserError(error)));
  show();
  return {
    async restoreStoredEngine() {
      if (!options.desktop || selectedMode !== "claude" || disposed) return false;
      try {
        await change("claude");
        return engine === "claude";
      } catch (error) {
        // A stale preference must never leave the picker claiming Claude while
        // the real runtime is still Pi. Keep the safe default and let startup
        // continue with Pi.
        selectedMode = "pi";
        try { localStorage.setItem("easy_pi.engineMode", "pi"); } catch { /* Optional preference. */ }
        show();
        options.toast(formatUserError(error, "Claude 启动失败，已恢复 Pi。"));
        return false;
      }
    },
    engine: () => engine,
    engineMode: () => selectedMode,
    async prepareForSubmit(text: string) {
      // Follow-ups belong to the active run. Re-routing one could stop Pi,
      // lose its queue or fail the send because engine switching is prohibited.
      const current = options.workbench()?.getState?.();
      if (current?.busy || current?.pending || (engine === "claude" && (state.busy || state.waitingApproval))) return;
      if (selectedMode === "auto" && text.trim()) await change("auto", text, true);
    },
    async selectEngine(target: EngineChoice) { await change(target); },
    busy: () => switching,
    refreshLanguage: show,
    async reconnect(cwd: string, session?: string) {
      if (engine !== "claude") return options.connectPi(cwd, session);
      if (state.busy || state.waitingApproval) throw Error("请先停止 Agent 当前任务。");
      if (state.ready === false) { runtimeAlive = false; await options.invoke("stop_claude"); runtimeId = ""; await start(cwd); }
      if (cwd !== state.cwd) {
        await options.invoke("probe_claude", { cwd });
        const moved = await call<State>("workspace", {cwd}); state = moved;
      }
      const value = await call<State>(session ? "resume" : "new_session", session ? { sessionId: session.replace(/^agent:/, "") } : {});
      agents.clear();
      if (typeof value.roleId === "string") { roleId = value.roleId; try { localStorage.setItem("easy_pi.agentRole",roleId); } catch { /* Optional. */ } }
      view.setSession(value); state = { ...value, cwd };
      options.workbench()?.setRuntime({ cwd, bridgeId: runtimeId }); applyState(state); options.changed();
    },
    async route<T>(command: string, args?: Record<string, unknown>): Promise<T | undefined> {
      if (disposed) throw Error("Agent view closed");
      if (switching) throw Error("正在切换执行引擎，请稍后。");
      if (engine !== "claude") return undefined;
      if (command === "gui_status") return { ...state, agents: [...agents.values()], connected: runtimeAlive, ready: !!state.ready && !state.busy && !state.waitingApproval && state.configured !== false, bridgeId: runtimeId, session: state.sessionId ? `agent:${state.sessionId}` : "" } as T;
      if (command === "gui_action") {
        const action = args?.action;
        if (action === "library") {
          const request = JSON.parse(String(args?.text || "{}"));
          if (request.kind === "settings" && typeof request.activeAgent === "string") {
            if (request.activeAgent) await call("library", { request: {kind:"agent",action:"read",id:request.activeAgent} });
            roleId = request.activeAgent;
            try { localStorage.setItem("easy_pi.agentRole", roleId); } catch { /* Optional. */ }
            return { data: { activeAgent: roleId } } as T;
          }
          const data = await call<Record<string, unknown>>("library", { request });
          if (request.kind === "agent" && request.action === "remove" && request.id === roleId) { roleId = ""; try { localStorage.removeItem("easy_pi.agentRole"); } catch { /* Optional. */ } }
          if (request.kind === "list") data.settings = { ...(data.settings as object), activeAgent: roleId };
          if (request.kind === "market" && request.action === "list") data.activeAgent = roleId;
          return { data } as T;
        }
        if (action === "submit") {
          if (state.busy || state.waitingApproval) throw Error("Agent 正在运行，请等待或停止。");
          agents.clear();
          applyState({ agents: [] });
          const result = await call<Record<string, unknown>>("submit", { text: args?.userText ?? args?.text, attachments: args?.attachments || [], roleId });
          const current = await call<State>("status"); applyState(current); return result as T;
        }
        if (action === "usage") {
          const request = JSON.parse(String(args?.text || "{}"));
          const data = await call<Record<string, unknown>>("usage", { request });
          return { data } as T;
        }
        if (action === "stop") { const value = await call<State>("stop"); applyState(value); return value as T; }
        if (action === "command" && String(args?.text).trim() === "/new") {
          options.workbench()?.requireSwitch(); const value = await call<State>("new_session"); state = value; view.setSession(value); applyState(value); return value as T;
        }
        if (action === "presentation") return {} as T;
        if (action === "dismiss") return { dismissed: false } as T;
        throw Error("此 Pi 指令不适用于 Claude Agent。请使用 Claude 连接设置。");
      }
      if (command === "list_sessions") {
        const value = await call<{ sessions: { sessionId: string; cwd: string; title?: string; updatedAt: number }[] }>("sessions");
        return { sessions: value.sessions.map((item) => ({ path: `agent:${item.sessionId}`, id: item.sessionId, cwd: item.cwd, title: item.title || "Agent", modified: item.updatedAt > 1e12 ? item.updatedAt / 1000 : item.updatedAt })) } as T;
      }
      if (command === "run_diagnostics") return { checkedAt: Date.now() / 1000, checks: [{ name: "Claude Agent SDK", ok: !!runtimeId, detail: state.configured ? "已配置 / Configured" : "请配置 Claude 连接 / Configure connection" }] } as T;
      if (["write_terminal", "resize_terminal", "install_package", "set_keybinding", "reset_keybinding", "list_models", "add_custom_model", "delete_custom_model", "delete_models", "edit_model", "get_model_edit_info", "restore_removed_models", "read_keybindings"].includes(command)) throw Error("此操作仅适用于 Pi 引擎。");
      return undefined;
    },
    dispose() { disposed = true; runtimeAlive = false; select.removeEventListener("change", onChange); unlisten?.(); connection.removeEventListener("click", onConnection); view.dispose(); },
  };
}
