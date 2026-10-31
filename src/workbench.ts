import { listen } from "@tauri-apps/api/event";
import { icon } from "./icons";
import { formatUserError, toReference } from "./utils.ts";
import { canSubmit, isAbsoluteAttachmentPath, isGuiShortcut, normalizedState, parseDraft, sameDraft, shouldSendOnEnter, type AgentState, type Draft } from "./composer-state";
import { normalizeFileText, preserveFileLineEndings } from "./file-text";
import { createWorkProgress } from "./work-progress";

type Session = { path: string; id: string; cwd: string; title: string; modified: number };
type FileEntry = { path: string; name: string; directory: boolean };
type Change = { path: string; oldPath?: string; index: string; worktree: string; untracked: boolean };
type Panel = "work" | "files" | "history" | "review" | "diagnostics";
type Options = {
  desktop: boolean;
  engine?: () => "pi" | "claude";
  invoke: <T = void>(command: string, args?: Record<string, unknown>) => Promise<T>;
  language: () => string;
  mode: () => string;
  toast: (message: string, duration?: number) => void;
  resize: () => void;
  focusTerminal: () => void;
  reconnect: (cwd: string, session?: string) => Promise<void>;
  settings: () => void;
  panelOpened: () => void;
  stateChanged?: (state: AgentState) => void;
  conversationSubmit?: (text: string, attachments: string[]) => void;
  beforeSubmit?: (text: string) => Promise<void>;
  prepareCommand?: () => void;
  matchesShortcut?: (id: string, event: KeyboardEvent) => boolean;
};

const words: Record<string, [string, string]> = {
  history: ["会话历史", "Sessions"], files: ["文件", "Files"], review: ["审阅", "Review"],
  diagnostics: ["自动检验", "Diagnostics"], work: ["工作台", "Work panel"], palette: ["指令面板", "Command palette"],
  placeholder: ["向 Pi 发送消息…", "Message Pi…"], attach: ["添加文件", "Attach files"],
  command: ["Pi 指令", "Pi commands"], stop: ["停止任务", "Stop task"], send: ["发送消息", "Send message"],
  refresh: ["刷新", "Refresh"], close: ["关闭", "Close"], save: ["保存", "Save"],
  reference: ["加入输入", "Attach to message"], disconnected: ["未连接", "Disconnected"],
  blocked: ["请先处理终端弹窗", "Resolve the terminal dialog"], nativeDraft: ["终端草稿未清空", "Terminal draft is not empty"],
  initializing: ["Pi 初始化中，首次启动可能下载辅助工具", "Pi is initializing; first launch may download helper tools"],
  projectTrust: ["请确认项目信任弹窗", "Review the project trust dialog"],
  ready: ["就绪", "Ready"], working: ["运行中", "Working"], submitting: ["提交中", "Submitting"],
  queued: ["有排队输入", "Messages queued"], preview: ["浏览器预览", "Browser preview"],
  noSessions: ["暂无会话", "No sessions"], noFiles: ["没有找到文件", "No files found"],
  noChanges: ["没有改动", "No changes"], currentWorkspace: ["当前工作区", "Current workspace"],
  allWorkspaces: ["全部工作区", "All workspaces"], archived: ["已归档", "Archived"],
  searchFiles: ["搜索文件…", "Search files…"], searchSessions: ["搜索会话…", "Search sessions…"],
  searchCommands: ["搜索指令、会话…", "Search commands and sessions…"], workingTree: ["未暂存", "Unstaged"],
  staged: ["已暂存", "Staged"], stage: ["暂存文件", "Stage file"], unstage: ["取消暂存", "Unstage file"],
  branch: ["分支对比", "Branch comparison"],
  pin: ["置顶", "Pin"], unpin: ["取消置顶", "Unpin"], archive: ["归档", "Archive"],
  restore: ["恢复", "Restore"], current: ["当前", "Current"], new: ["新建会话", "New session"],
  workspace: ["选择工作区", "Open workspace"], model: ["选择模型", "Select model"],
  tree: ["会话树", "Session tree"], fork: ["分支会话", "Fork session"],
  compact: ["压缩上下文", "Compact context"], reload: ["重载扩展", "Reload extensions"],
  settings: ["设置", "Settings"], fullscreen: ["切换全屏", "Toggle fullscreen"],
  workTools: ["工作工具", "Work tools"], overview: ["概览", "Overview"],
  showMoreArtifacts: ["展开更多", "Show more"], showLessArtifacts: ["收起", "Show less"],
  wallpaper: ["切换壁纸", "Toggle wallpaper"], frame: ["收起或恢复边框", "Toggle frame"],
  input: ["独立输入栏", "GUI composer"], noMatches: ["没有匹配项", "No matches"],
  pendingDraft: ["请先处理正在发送的输入。", "Finish the pending submission first."],
  dirtyFile: ["文件草稿尚未保存。请先保存，或关闭文件确认放弃。", "Save or close the modified file first."],
  discard: ["放弃未保存的文件改动？", "Discard unsaved file changes?"],
  saved: ["已保存", "Saved"], verify: ["检验中…", "Checking…"],
  recent: ["最近", "Recents"], allSessions: ["全部会话", "All sessions"],
};

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be unavailable. */ } };
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const button = (name: string, title: string, run: () => void) => {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "icon-button";
  element.title = title;
  element.setAttribute("aria-label", title);
  element.append(icon(name));
  element.addEventListener("click", run);
  return element;
};

export function setupWorkbench(options: Options) {
  const isClaude = () => options.engine?.() === "claude";
  const draftNamespace = () => isClaude() ? "agent.guiDraft:" : "pi.guiDraft:";
  const text = (key: string) => words[key]?.[options.language() === "en" ? 1 : 0] ?? key;
  const progress = createWorkProgress();
  let progressSession = "";
  let state: AgentState = { ready: false, busy: false };
  let bridgeId = "";
  let runtimeVersion = 0;
  let automaticallyChecked = "";
  let cwd = "";
  let draftKey = "pi.guiDraft:initial";
  let draft: Draft = parseDraft(read(draftKey));
  let submitting = false;
  let preparingSubmission = false;
  let switching = false;
  let commandRunning = false;
  let presentationKey = "";
  let presentationPending = "";
  let composing = false;
  let disposed = false;
  let sessions: Session[] = [];
  let sessionsLoading: Promise<void> | undefined;
  let recentsLoadedFor = "";
  let recentsSignature = "";
  const recents = el<HTMLDetailsElement>("sidebar-recents");
  recents.open = read("pi.historyCollapsed") !== "true";
  let panel: Panel | undefined;
  let archived = false;
  let artifactsExpanded = false;
  let fileDirectory = "";
  let currentFile = "";
  let fileRevision = "";
  let fileOriginal = "";
  let fileNativeOriginal = "";
  let fileNativeText = "";
  let fileDocument = 0;
  let fileEditVersion = 0;
  let changes: Change[] = [];
  let selectedChange: Change | undefined;
  let generation = 0;
  let fileGeneration = 0;
  let refreshGeneration = 0;
  let lastCompletion = false;
  let notificationEnabled = read("pi.notifications") === "true";
  let gitGeneration = 0, gitRoot = "", gitBranch = "", gitCount = 0, gitError = "", gitPending = false;
  const refreshHeader = () => {
    const english = options.language() === "en";
    const project = el("header-project"), git = el("header-git"), usage = el("header-usage"), extensions = el("header-extensions");
    project.textContent = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd || (english ? "Workbench" : "工作台");
    project.title = cwd;
    git.textContent = gitError ? (english ? "Git unavailable" : "Git 不可用") : gitBranch ? `${gitBranch} · ${gitCount} ${english ? "changed" : "项变更"}` : gitPending ? "…" : "";
    git.title = gitError || gitBranch;
    usage.textContent = state.connected && state.usage
      ? `${state.usage.tokens.toLocaleString(english ? "en-US" : "zh-CN")} tokens · ${state.usage.cost === null ? (english ? "cost unavailable" : "费用未提供") : `$${state.usage.cost.toFixed(4)}`}` : "";
    usage.title = english ? "Recorded session totals, including compacted and branched history. USD cost uses model pricing; it is not a provider invoice." : "会话累计用量，含压缩和分支历史。美元费用来自模型价格记录，并非供应商账单。";
    extensions.textContent = !state.connected ? "" : state.skillError ? (english ? "Skill load failed" : "Skill 加载异常")
      : `${state.skills?.length ?? 0} Skills · ${state.extensionCommands ?? 0} ${english ? "extension commands" : "扩展指令"}`;
    extensions.title = state.skillError || state.skills?.join("\n") || "";
    extensions.classList.toggle("is-error", !!state.skillError);
  };
  const refreshHeaderGit = async () => {
    if (!options.desktop || disposed || !cwd) return;
    const generation = ++gitGeneration, root = cwd;
    gitRoot = root; gitPending = true; gitBranch = ""; gitCount = 0; gitError = ""; refreshHeader();
    try {
      const result = await options.invoke<{ branch: string; changes: Change[] }>("git_changes", { root, mode: "working" });
      if (disposed || generation !== gitGeneration || root !== cwd) return;
      gitBranch = result.branch || "HEAD"; gitCount = result.changes.length;
    } catch (error) {
      if (disposed || generation !== gitGeneration || root !== cwd) return;
      gitError = formatUserError(error);
    } finally { if (!disposed && generation === gitGeneration) { gitPending = false; refreshHeader(); } }
  };
  const unlisteners: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let meta: Record<string, { pin?: boolean; archived?: boolean }> = {};
  try { meta = JSON.parse(read("pi.sessionPresentation") || "{}"); } catch { /* Use defaults. */ }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
  const input = el<HTMLTextAreaElement>("composer-input");
  const commandSuggestions = el<HTMLDivElement>("composer-command-suggestions");
  const send = el<HTMLButtonElement>("composer-send");
  const composer = el("composer");
  const palette = el("command-palette");
  const paletteInput = el<HTMLInputElement>("palette-search");
  const toolsMenu = el("work-tools-menu");
  const toolsToggle = el("work-tools-toggle");
  const fileEditor = el<HTMLTextAreaElement>("file-editor-text");
  const fileDirty = () => !!currentFile && fileEditor.value !== fileOriginal;
  const selectAgent = (id: string) => {
    if (!id || id === "main") {
      if (!composer.hidden && !document.body.classList.contains("frame-hidden") && !document.body.classList.contains("terminal-view")) input.focus();
      else options.focusTerminal();
      return;
    }
    const target = [...document.querySelectorAll<HTMLElement>("[data-agent-session-id]")].find((node) => node.dataset.agentSessionId === id);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.focus?.();
      return;
    }
    options.toast(options.language() === "en" ? "This Agent has no visible transcript yet." : "该 Agent 暂无可定位的结果。", 2600);
  };
  const report = (error: unknown) => {
    const message = formatUserError(error);
    options.toast(message, 5000);
    if (panel) { el("tool-message").textContent = message; el("tool-message").hidden = false; }
  };
  const autoHeight = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(200, Math.max(56, input.scrollHeight))}px`;
    options.resize();
  };
  const commandCatalog = () => {
    const english = options.language() === "en";
    const base = [
      ["/new", english ? "Start a new session" : "新建会话"],
      ["/model", english ? "Choose or switch model" : "选择或切换模型"],
      ["/tree", english ? "Show the session tree" : "查看会话树"],
      ["/fork", english ? "Fork the current session" : "创建分支会话"],
      ["/compact", english ? "Compact the current context" : "压缩当前上下文"],
      ["/reload", english ? "Reload Pi extensions" : "重载 Pi 扩展"],
      ["/help", english ? "Show available Pi commands" : "查看可用 Pi 指令"],
    ] as const;
    return isClaude() ? base.filter(([command]) => command === "/new") : base;
  };
  let commandSuggestionIndex = 0;
  const closeCommandSuggestions = () => {
    commandSuggestions.hidden = true;
    commandSuggestions.replaceChildren();
    input.removeAttribute("aria-activedescendant");
  };
  const chooseCommandSuggestion = (command: string) => {
    input.value = `${command} `;
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    closeCommandSuggestions();
    input.focus();
  };
  const refreshCommandSuggestions = () => {
    const match = input.value.match(/^\s*(\/[^\s]*)$/);
    if (!match || !state.ready || submitting || commandRunning) { closeCommandSuggestions(); return; }
    const query = match[1].toLowerCase();
    const choices = commandCatalog().filter(([command]) => command.startsWith(query));
    if (!choices.length) { closeCommandSuggestions(); return; }
    commandSuggestionIndex = Math.min(commandSuggestionIndex, choices.length - 1);
    commandSuggestions.replaceChildren();
    for (const [index, [command, description]] of choices.entries()) {
      const item = document.createElement("button");
      item.type = "button"; item.role = "option"; item.id = `composer-command-option-${index}`;
      item.setAttribute("aria-selected", String(index === commandSuggestionIndex));
      const code = document.createElement("code"); code.textContent = command;
      const hint = document.createElement("small"); hint.textContent = description;
      item.append(code, hint);
      item.addEventListener("mousedown", event => event.preventDefault());
      item.addEventListener("click", () => chooseCommandSuggestion(command));
      commandSuggestions.append(item);
    }
    commandSuggestions.hidden = false;
    input.setAttribute("aria-activedescendant", `composer-command-option-${commandSuggestionIndex}`);
  };
  const saveDraft = () => store(draftKey, draft);
  const refreshComposer = () => {
    send.disabled = !canSubmit(state, draft, submitting, options.desktop);
    el("composer-stop").hidden = !state.busy && !state.inputRecovery && !submitting;
    el("queued-status").hidden = !state.pending;
    el("agent-status").textContent = text(!options.desktop ? "preview" : state.commandPending ? "submitting" : submitting ? "submitting"
      : !state.connected ? "disconnected" : !state.ready ? state.startupPhase === "project_trust" ? "projectTrust"
        : state.startupPhase === "initializing" ? "initializing" : "blocked" : state.nativeDraft ? "nativeDraft" : state.busy ? "working" : "ready");
    el("agent-status").dataset.state = state.busy ? "busy" : state.ready ? "ready" : "blocked";
    send.title = text("send");
    send.setAttribute("aria-label", send.title);
    composer.classList.toggle("is-submitting", submitting);
  };
  const refreshAttachments = () => {
    const list = el("composer-attachments");
    list.replaceChildren();
    for (const path of draft.attachments) {
      const chip = document.createElement("span");
      chip.className = "attachment-chip";
      chip.title = path;
      chip.append(icon("file"));
      const label = document.createElement("span");
      label.textContent = path.split(/[\\/]/).pop() || path;
      chip.append(label, button("x", `${text("close")} ${label.textContent}`, () => {
        draft.attachments = draft.attachments.filter((value) => value !== path);
        saveDraft(); refreshAttachments(); refreshComposer(); options.resize();
      }));
      list.append(chip);
    }
  };
  const switchDraft = (key: string) => {
    if (key === draftKey) return;
    saveDraft();
    draftKey = key;
    draft = parseDraft(read(key));
    input.value = draft.text;
    refreshAttachments(); refreshComposer(); autoHeight();
  };
  const addPaths = (paths: string[]): number => {
    if (disposed) return 0;
    const previousCount = draft.attachments.length;
    draft.attachments = [...new Set([...draft.attachments, ...paths.filter(isAbsoluteAttachmentPath)])].slice(0, 20);
    const added = draft.attachments.length - previousCount;
    saveDraft(); refreshAttachments(); refreshComposer(); composer.hidden = false;
    el("composer-toggle").setAttribute("aria-pressed", "true");
    el("composer-toggle").setAttribute("aria-checked", "true");
    syncPresentation();
    autoHeight(); input.focus();
    return added;
  };
  const syncPresentation = () => {
    if (isClaude() || !options.desktop || !bridgeId || !state.connected || !state.ready || disposed) return;
    const mode = composer.hidden ? "native" : "compact";
    const key = `${bridgeId}:${mode}`;
    const matches = state.compactEditor === undefined || state.compactEditor === (mode === "compact");
    if ((presentationKey === key && matches) || presentationPending === key) return;
    const currentBridge = bridgeId;
    presentationPending = key;
    void options.invoke("gui_action", { action: "presentation", text: mode }).then(() => {
      if (!disposed && currentBridge === bridgeId) presentationKey = key;
    }).catch(() => {}).finally(() => {
      if (presentationPending === key) presentationPending = "";
    });
  };
  const setState = (value: unknown) => {
    const incomingId = value && typeof value === "object" ? (value as {bridgeId?: string}).bridgeId : undefined;
    if (bridgeId && incomingId && incomingId !== bridgeId) return;
    const next = normalizedState(value);
    if (state.busy && !next.busy && lastCompletion && !document.hasFocus()) {
      options.toast(options.language() === "en" ? "The run ended; check its result before acceptance." : "本次运行已结束，请核对结果后验收。");
      if (notificationEnabled && "Notification" in window && Notification.permission === "granted") {
        new Notification("Pi", { body: options.language() === "en" ? "The current run has ended." : "当前运行已结束。", silent: true });
      }
    }
    if (next.busy) lastCompletion = true;
    const started = !state.busy && next.busy;
    const completed = state.busy && !next.busy;
    if (completed) { lastCompletion = false; if (panel === "review") void refreshPanel(); }
    state = next;
    options.stateChanged?.(state);
    if (state.cwd) cwd = state.cwd;
    if (next.session && next.session !== progressSession) { progress.reset(); progressSession = next.session; }
    progress.task(state.task, cwd);
    if (started && !panel && cwd && !document.body.classList.contains("sidebar-open")) openPanel("work");
    if (panel === "work") renderWorkPanel();
    refreshHeader();
    if (gitRoot !== cwd || completed) void refreshHeaderGit();
    if (state.session) switchDraft(`${draftNamespace()}${state.session}`);
    refreshComposer();
    renderSidebarHistory();
    if (options.desktop && state.ready && state.session && recents.open && recentsLoadedFor !== state.session) {
      recentsLoadedFor = state.session;
      void loadSessions().catch(report);
    }
    if (!state.connected) { presentationKey = ""; automaticallyChecked = ""; }
    syncPresentation();
    const model = el("current-model");
    if (state.model) { model.textContent = state.model; model.title = state.model; }
    if (!isClaude() && state.ready && options.desktop && automaticallyChecked !== bridgeId) {
      automaticallyChecked = bridgeId;
      const checkedBridge = bridgeId;
      void options.invoke<{checks: {ok: boolean}[]}>("run_diagnostics").then((result) => {
        if (disposed || checkedBridge !== bridgeId) return;
        const warnings = result.checks.filter((check) => !check.ok).length;
        el("diagnostics-open").dataset.state = warnings ? "warning" : "ok";
        el("diagnostics-count").textContent = warnings ? String(warnings) : "";
      }).catch(() => {});
    }
  };
  const executeCommand = async (command: string) => {
    if (isClaude() && command !== "/new") throw new Error(options.language() === "en" ? "This command is only available in Pi." : "此指令仅适用于 Pi 引擎。");
    if (commandRunning) throw new Error(options.language() === "en" ? "A Pi command is still opening." : "上一条 Pi 指令仍在打开，请稍后。");
    if (fileDirty()) throw new Error(text("dirtyFile"));
    closePanel();
    options.prepareCommand?.();
    commandRunning = true;
    try {
      await options.invoke("gui_action", { action: "command", text: command });
      options.focusTerminal();
    } finally { commandRunning = false; }
  };
  const submit = async (forceSteer = false, forceQueue = false) => {
    if (!canSubmit(state, draft, submitting, options.desktop)) return;
    const snapshot = { text: draft.text, attachments: [...draft.attachments] };
    if (/^\s*\//.test(snapshot.text)) {
      if (snapshot.attachments.length) {
        el("composer-error").hidden = false;
        el("composer-error").textContent = options.language() === "en"
          ? "Pi commands cannot be sent with file attachments."
          : "Pi 指令不能与文件附件一起发送。";
        return;
      }
      const submittedKey = draftKey;
      let commandSucceeded = false;
      submitting = true;
      el("composer-error").hidden = true;
      refreshComposer();
      try {
        await executeCommand(snapshot.text.trim());
        commandSucceeded = true;
        if (sameDraft(draft, snapshot) && draftKey === submittedKey) {
          draft = { text: "", attachments: [] };
          input.value = "";
          saveDraft(); refreshAttachments(); autoHeight();
        }
      } catch (error) {
        el("composer-error").hidden = false;
        el("composer-error").textContent = formatUserError(error);
      } finally {
        submitting = false;
        if (state.session || cwd) switchDraft(`${draftNamespace()}${state.session || cwd}`);
        refreshComposer();
        if (commandSucceeded) options.focusTerminal();
        else if (!composer.hidden) input.focus();
      }
      return;
    }
    if (/^\s*!/.test(snapshot.text)) {
      el("composer-error").hidden = false;
      el("composer-error").textContent = options.language() === "en"
        ? "Use the native terminal for shell commands."
        : "终端命令请使用原版输入框。";
      return;
    }
    const message = [snapshot.text.trim(), ...snapshot.attachments.map(toReference)].filter(Boolean).join("\n");
    const submittedKey = draftKey;
    const mode = forceQueue ? "queue" : forceSteer ? "control" : options.mode();
    submitting = true;
    el("composer-error").hidden = true;
    refreshComposer();
    try {
      preparingSubmission = true;
      try { if (options.beforeSubmit) await options.beforeSubmit(snapshot.text); }
      finally { preparingSubmission = false; }
      // Render the user turn before dispatching so a fast runtime response
      // cannot appear above its originating message.
      options.conversationSubmit?.(snapshot.text.trim(), snapshot.attachments);
      await options.invoke("gui_action", { action: "submit", text: message, attachments: snapshot.attachments, userText: snapshot.text.trim(), mode });
      if (sameDraft(draft, snapshot) && draftKey === submittedKey) {
        draft = { text: "", attachments: [] };
        input.value = "";
        saveDraft(); refreshAttachments(); autoHeight();
      } else if (draftKey !== submittedKey && sameDraft(parseDraft(read(submittedKey)), snapshot)) {
        // Auto may route an idle submission to the other engine. Only consume
        // the original unchanged draft; never overwrite the new engine's input.
        store(submittedKey, { text: "", attachments: [] });
      }
    } catch (error) {
      el("composer-error").hidden = false;
      el("composer-error").textContent = formatUserError(error);
    } finally {
      submitting = false;
      if (state.session || cwd) switchDraft(`${draftNamespace()}${state.session || cwd}`);
      refreshComposer();
      if (!composer.hidden) input.focus(); else options.focusTerminal();
    }
  };
  input.value = draft.text;
  input.addEventListener("input", () => {
    draft.text = input.value; saveDraft(); autoHeight(); refreshComposer();
    el("composer-error").hidden = true;
    commandSuggestionIndex = 0;
    refreshCommandSuggestions();
  });
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", (event) => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (!commandSuggestions.hidden) {
      const options = [...commandSuggestions.querySelectorAll<HTMLButtonElement>("button")];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        commandSuggestionIndex = Math.max(0, Math.min(options.length - 1, commandSuggestionIndex + (event.key === "ArrowDown" ? 1 : -1)));
        options.forEach((item, index) => item.setAttribute("aria-selected", String(index === commandSuggestionIndex)));
        input.setAttribute("aria-activedescendant", `composer-command-option-${commandSuggestionIndex}`);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const command = options[commandSuggestionIndex]?.querySelector("code")?.textContent;
        if (command) chooseCommandSuggestion(command);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); closeCommandSuggestions(); return; }
    }
    if (options.matchesShortcut && !composing && !event.isComposing && event.keyCode !== 229) {
      if (options.matchesShortcut("tui.input.newLine", event)) {
        if (event.key !== "Enter") {
          event.preventDefault();
          input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      }
      const plainEnter = { key: "Enter", code: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false } as KeyboardEvent;
      const steer = event.key === "Enter" && !event.shiftKey && !event.altKey && (event.ctrlKey || event.metaKey)
        && options.matchesShortcut("tui.input.submit", plainEnter);
      const queue = options.matchesShortcut("app.message.followUp", event);
      if (!options.matchesShortcut("tui.input.submit", event) && !queue && !steer) return;
      event.preventDefault();
      if (event.repeat) return;
      void submit(steer, queue);
    } else if (shouldSendOnEnter(event, composing)) {
      event.preventDefault();
      if (event.repeat) return;
      void submit(event.metaKey || event.ctrlKey, event.altKey);
    }
  });
  composer.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    if (!options.desktop) { report(options.language() === "en" ? "Image attachments require the desktop app." : "图片附件需要桌面应用。"); return; }
    const key = draftKey;
    void (async () => {
      const paths: string[] = [];
      for (const file of files.slice(0, 5)) {
        if (file.size > 8 * 1024 * 1024) throw new Error("图片不能超过 8 MB。");
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        paths.push(await options.invoke<string>("store_image_attachment", { bytes }));
      }
      if (key !== draftKey) { throw new Error("会话已切换，图片未加入当前输入。"); }
      addPaths(paths);
    })().catch(report);
  });
  el("attach-file").addEventListener("click", () => {
    const key = draftKey;
    void options.invoke<string[]>("choose_attachments").then((paths) => {
      if (key === draftKey) addPaths(paths);
    }).catch(report);
  });
  send.addEventListener("click", () => { void submit(); });
  el("composer-stop").addEventListener("click", () => {
    void options.invoke("gui_action", { action: "stop" }).catch(report);
  });
  const toggleComposer = () => {
    if (isClaude()) { composer.hidden = false; input.focus(); return; }
    composer.hidden = !composer.hidden;
    store("pi.guiComposer", !composer.hidden);
    el("composer-toggle").setAttribute("aria-pressed", String(!composer.hidden));
    el("composer-toggle").setAttribute("aria-checked", String(!composer.hidden));
    syncPresentation();
    options.resize();
    if (composer.hidden) options.focusTerminal(); else { autoHeight(); input.focus(); }
  };
  composer.hidden = read("pi.guiComposer") === "false";
  el("composer-toggle").setAttribute("aria-pressed", String(!composer.hidden));
  el("composer-toggle").setAttribute("aria-checked", String(!composer.hidden));
  el("composer-toggle").addEventListener("click", toggleComposer);
  const closeTools = (restoreFocus = false) => {
    toolsMenu.hidden = true;
    toolsToggle.setAttribute("aria-expanded", "false");
    if (restoreFocus) toolsToggle.focus();
  };
  const outsideTools = (event: Event) => {
    const target = event.target as Node;
    if (!toolsMenu.contains(target) && !toolsToggle.contains(target)) closeTools();
  };
  toolsToggle.addEventListener("click", () => {
    if (!toolsMenu.hidden) { closeTools(true); return; }
    toolsMenu.hidden = false; toolsToggle.setAttribute("aria-expanded", "true");
    toolsMenu.querySelector<HTMLButtonElement>("button")?.focus();
  });
  toolsMenu.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button")) closeTools();
  }, true);
  el("work-tools-settings").addEventListener("click", options.settings);
  el("sidebar-history-open").addEventListener("click", () => openPanel("history"));
  document.addEventListener("pointerdown", outsideTools, true);

  const closePanel = () => {
    if (fileDirty()) { report(text("dirtyFile")); return; }
    panel = undefined; generation++;
    el("tool-panel").hidden = true; el("work-open").setAttribute("aria-expanded", "false"); options.resize();
  };
  const empty = (list: HTMLElement, message: string) => {
    const label = document.createElement("div");
    label.className = "tool-empty"; label.textContent = message; list.append(label);
  };
  const openPanel = (view: Panel) => {
    if (fileDirty() && view !== "files") { report(text("dirtyFile")); return; }
    closeTools();
    panel = view; generation++;
    options.panelOpened();
    el("tool-panel").hidden = false;
    el("work-open").setAttribute("aria-expanded", String(view === "work"));
    el("tool-panel-title").textContent = text(view);
    for (const name of ["work", "files", "history", "review", "diagnostics"]) el(`${name}-view`).hidden = name !== view;
    el("tool-message").hidden = true;
    options.resize(); void refreshPanel();
  };
  const requireSwitch = (forSubmission = false) => {
    if (switching) throw new Error(options.language() === "en" ? "A session switch is in progress." : "正在切换会话，请稍后。");
    if (submitting && !(forSubmission && preparingSubmission)) throw new Error(text("pendingDraft"));
    if (state.busy || state.nativeDraft || state.commandPending || state.inputRecovery) throw new Error(options.language() === "en"
      ? "Stop the current task and resolve the terminal draft before switching." : "请先停止当前任务并处理终端草稿，再切换。");
    if (fileDirty()) throw new Error(text("dirtyFile"));
  };
  const openWorkspace = async () => {
    requireSwitch();
    const selected = await options.invoke<string | null>("choose_workspace");
    if (!selected || selected === cwd) return;
    requireSwitch();
    switching = true;
    try {
      await options.reconnect(selected);
      currentFile = ""; fileDirectory = "";
      el("file-editor").hidden = true;
      if (panel) void refreshPanel();
    } finally { switching = false; }
  };
  const resumeSession = async (session: Session) => {
    if (session.path === state.session) { closePanel(); return; }
    requireSwitch();
    switching = true;
    try {
      await options.reconnect(session.cwd, session.path);
      currentFile = ""; fileDirectory = ""; el("file-editor").hidden = true;
      closePanel();
    } finally { switching = false; }
  };
  const renderHistory = () => {
    renderSidebarHistory();
    const list = el("history-list"); list.replaceChildren();
    const query = el<HTMLInputElement>("history-search").value.toLowerCase();
    const all = el<HTMLSelectElement>("history-scope").value === "all";
    const rows = sessions.filter((session) => (all || session.cwd === cwd)
      && !!meta[session.path]?.archived === archived
      && `${session.title} ${session.cwd}`.toLowerCase().includes(query))
      .sort((a, b) => Number(!!meta[b.path]?.pin) - Number(!!meta[a.path]?.pin) || b.modified - a.modified);
    let date = "";
    for (const session of rows) {
      const group = meta[session.path]?.pin ? text("pin") : new Date(session.modified * 1000).toLocaleDateString(options.language() === "en" ? "en-US" : "zh-CN");
      if (group !== date) {
        const heading = document.createElement("h3"); heading.textContent = group; list.append(heading); date = group;
      }
      const row = document.createElement("div"); row.className = "session-row";
      if (session.path === state.session) row.classList.add("active");
      const open = document.createElement("button"); open.type = "button"; open.className = "session-open";
      const title = document.createElement("span"); title.textContent = session.title;
      const detail = document.createElement("small"); detail.textContent = session.path === state.session ? text("current") : session.cwd;
      detail.title = session.cwd;
      open.append(title, detail); open.addEventListener("click", () => { void resumeSession(session).catch(report); });
      row.append(open, button("pin", text(meta[session.path]?.pin ? "unpin" : "pin"), () => {
        meta[session.path] = { ...meta[session.path], pin: !meta[session.path]?.pin };
        store("pi.sessionPresentation", meta); renderHistory();
      }), button("archive", text(archived ? "restore" : "archive"), () => {
        meta[session.path] = { ...meta[session.path], archived: !meta[session.path]?.archived };
        store("pi.sessionPresentation", meta); renderHistory();
      }));
      list.append(row);
    }
    if (!rows.length) empty(list, text("noSessions"));
  };
  const renderSidebarHistory = () => {
    const recent = sessions.filter((session) => !meta[session.path]?.archived)
      .sort((a, b) => Number(!!meta[b.path]?.pin) - Number(!!meta[a.path]?.pin) || b.modified - a.modified).slice(0, 12)
      .map((session) => session.path === state.session && state.name ? { ...session, title: state.name } : session);
    const signature = JSON.stringify([recent, state.session, state.busy, options.language()]);
    if (recentsSignature === signature) return;
    recentsSignature = signature;
    const list = el("sidebar-recents-list"); list.replaceChildren();
    list.setAttribute("aria-label", text("recent"));
    for (const session of recent) {
      const row = document.createElement("button"); row.type = "button"; row.title = `${session.title}\n${session.cwd}`;
      row.dataset.session = session.path;
      row.setAttribute("aria-current", String(session.path === state.session));
      const title = document.createElement("span"); title.textContent = session.title; row.append(title);
      if (state.busy && session.path === state.session) {
        const busy = document.createElement("span"); busy.className = "session-busy";
        busy.setAttribute("aria-label", text("working")); row.append(busy);
      }
      row.addEventListener("click", () => { void resumeSession(session).catch(report); });
      list.append(row);
    }
    if (!recent.length) { const empty = document.createElement("div"); empty.className = "sidebar-empty"; empty.textContent = text("noSessions"); list.append(empty); }
  };
  const loadSessions = () => {
    if (sessionsLoading) return sessionsLoading;
    const engine = options.engine?.() || "pi";
    const loading = options.invoke<{ sessions: Session[] }>("list_sessions").then((result) => {
      if (disposed || engine !== (options.engine?.() || "pi")) return;
      sessions = result.sessions;
      renderSidebarHistory();
      if (panel === "history") renderHistory();
    }).finally(() => { if (sessionsLoading === loading) sessionsLoading = undefined; });
    sessionsLoading = loading; return loading;
  };
  recents.addEventListener("toggle", () => {
    store("pi.historyCollapsed", !recents.open);
    if (recents.open && options.desktop) void loadSessions().catch(report);
  });
  el("sidebar-recents-refresh").addEventListener("click", () => { void loadSessions().catch(report); });
  const openFile = async (path: string) => {
    if (fileDirty()) throw new Error(text("dirtyFile"));
    const key = ++fileGeneration;
    const root = cwd;
    const runtime = runtimeVersion; const view = generation; const editVersion = fileEditVersion;
    const value = await options.invoke<{ text: string; revision: string }>("read_workspace_file", { root, path });
    if (key !== fileGeneration || root !== cwd || disposed || runtime !== runtimeVersion || view !== generation) return;
    // The old editor stays usable during the read. Never replace edits made while awaiting it,
    // even if a concurrent save has since made those edits clean.
    if (fileDirty()) throw new Error(text("dirtyFile"));
    if (editVersion !== fileEditVersion) return;
    fileDocument++;
    currentFile = path; fileRevision = value.revision; fileOriginal = normalizeFileText(value.text);
    fileNativeOriginal = fileNativeText = value.text;
    fileEditor.value = fileOriginal;
    el("file-editor-name").textContent = path; el("file-editor-name").title = path;
    el("file-editor").hidden = false;
    el<HTMLButtonElement>("file-save").disabled = true;
  };
  const renderFiles = async () => {
    const root = cwd;
    const version = ++fileGeneration;
    const query = el<HTMLInputElement>("file-search").value.trim();
    let files: FileEntry[];
    if (query) {
      const result = await options.invoke<{ files: string[] }>("search_workspace_files", { root, query });
      files = result.files.map((path) => ({ name: path, path, directory: false }));
    } else {
      files = await options.invoke<FileEntry[]>("list_workspace_files", { root, path: fileDirectory });
    }
    if (version !== fileGeneration || root !== cwd || panel !== "files" || disposed) return;
    const list = el("file-list"); list.replaceChildren();
    const breadcrumb = el("file-breadcrumb");
    breadcrumb.replaceChildren(button("folder-open", cwd, () => { fileDirectory = ""; void renderFiles().catch(report); }));
    const label = document.createElement("span"); label.textContent = fileDirectory || cwd.split("/").pop() || cwd; breadcrumb.append(label);
    if (fileDirectory && !query) {
      const back = document.createElement("button"); back.type = "button"; back.className = "file-row"; back.textContent = "..";
      back.addEventListener("click", () => { fileDirectory = fileDirectory.split("/").slice(0, -1).join("/"); void renderFiles().catch(report); });
      list.append(back);
    }
    for (const file of files) {
      const row = document.createElement("button");
      row.className = "file-row"; row.type = "button"; row.title = file.path;
      const name = document.createElement("span"); name.textContent = file.name;
      row.append(icon(file.directory ? "folder" : "file"), name);
      row.addEventListener("click", () => {
        if (file.directory) { fileDirectory = file.path; void renderFiles().catch(report); }
        else void openFile(file.path).catch(report);
      });
      list.append(row);
    }
    if (!files.length) empty(list, text("noFiles"));
  };
  fileEditor.addEventListener("input", () => {
    fileEditVersion++;
    fileNativeText = fileEditor.value === fileOriginal ? fileNativeOriginal : preserveFileLineEndings(fileNativeText, fileEditor.value);
    el<HTMLButtonElement>("file-save").disabled = saving || !fileDirty();
  });
  // A second save while one is in flight would reuse the old revision and be rejected as an external edit.
  let saving = false;
  const saveFile = async () => {
    if (disposed || saving || !currentFile || !fileDirty()) return;
    const root = cwd; const path = currentFile; const snapshot = fileEditor.value;
    const document = fileDocument; const runtime = runtimeVersion;
    const nativeSnapshot = preserveFileLineEndings(fileNativeText, snapshot);
    fileNativeText = nativeSnapshot;
    const save = el<HTMLButtonElement>("file-save"); save.disabled = true;
    saving = true;
    try {
      const value = await options.invoke<string>("save_workspace_file", { root, path, text: nativeSnapshot, expectedRevision: fileRevision });
      if (disposed || document !== fileDocument || runtime !== runtimeVersion || path !== currentFile || root !== cwd) return;
      fileRevision = value; fileOriginal = snapshot; fileNativeOriginal = nativeSnapshot;
      options.toast(text("saved"));
    } finally { saving = false; if (!disposed) save.disabled = !fileDirty(); }
  };
  el("file-save").addEventListener("click", () => { void saveFile().catch(report); });
  el("file-reference").addEventListener("click", () => { if (currentFile) addPaths([`${cwd}/${currentFile}`]); });
  el("file-editor-close").addEventListener("click", () => {
    if (fileDirty() && !window.confirm(text("discard"))) return;
    fileGeneration++; fileDocument++; currentFile = ""; fileOriginal = fileNativeOriginal = fileNativeText = "";
    el("file-editor").hidden = true;
  });
  const openDiff = async (change: Change) => {
    const root = cwd;
    const mode = el<HTMLSelectElement>("review-mode").value;
    selectedChange = change;
    el("diff-filename").textContent = change.path;
    const diff = await options.invoke<string>("git_diff", {
      root, path: change.path, oldPath: change.oldPath,
      mode: change.untracked ? "untracked" : mode, base: el<HTMLSelectElement>("review-base").value || undefined,
    });
    if (selectedChange !== change || root !== cwd || panel !== "review") return;
    const content = el("diff-content"); content.replaceChildren();
    if (!diff) { content.textContent = options.language() === "en" ? "No text diff (possibly binary or a directory)." : "无文本差异（可能是二进制文件或目录）。"; }
    else for (const line of diff.split("\n")) {
      const span = document.createElement("span");
      span.className = line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : "";
      span.textContent = line + "\n"; content.append(span);
    }
    const stage = el<HTMLButtonElement>("diff-stage"); stage.hidden = mode === "branch";
    stage.title = text(mode === "staged" ? "unstage" : "stage");
    stage.setAttribute("aria-label", stage.title);
    stage.replaceChildren(icon(mode === "staged" ? "minus" : "plus"));
  };
  const renderChanges = () => {
    const mode = el<HTMLSelectElement>("review-mode").value;
    const rows = changes.filter((change) => mode === "branch" ? true : mode === "staged" ? change.index !== " " && !change.untracked
      : change.worktree !== " " || change.untracked);
    const list = el("review-list"); list.replaceChildren();
    for (const change of rows) {
      const row = document.createElement("button"); row.type = "button"; row.className = "file-row";
      const status = document.createElement("small"); status.className = "change-status";
      status.textContent = change.untracked ? "U" : mode === "staged" ? change.index : change.worktree;
      const path = document.createElement("span"); path.textContent = change.path;
      row.append(status, path); row.title = change.path;
      row.addEventListener("click", () => { void openDiff(change).catch(report); }); list.append(row);
    }
    if (!rows.length) empty(list, text("noChanges"));
    selectedChange = undefined;
    el("diff-content").textContent = ""; el("diff-filename").textContent = ""; el("diff-stage").hidden = true;
  };
  const loadChanges = async () => {
    const root = cwd;
    const mode = el<HTMLSelectElement>("review-mode").value;
    const baseSelect = el<HTMLSelectElement>("review-base");
    const result = await options.invoke<{ changes: Change[]; branch: string; refs: string[] }>("git_changes", {
      root, mode, base: baseSelect.value || undefined,
    });
    if (root !== cwd || disposed || mode !== el<HTMLSelectElement>("review-mode").value) return;
    changes = result.changes;
    if (mode !== "branch") { gitGeneration++; gitPending = false; gitRoot = root; gitBranch = result.branch || "HEAD"; gitCount = changes.length; gitError = ""; refreshHeader(); }
    el("change-count").textContent = changes.length ? String(changes.length) : "";
    el("review-branch").textContent = result.branch || "HEAD";
    const previous = baseSelect.value;
    baseSelect.replaceChildren();
    for (const ref of result.refs.filter((ref) => /^[a-zA-Z0-9/_.-]+$/.test(ref))) {
      const option = document.createElement("option"); option.value = ref; option.textContent = ref; baseSelect.append(option);
    }
    if (result.refs.includes(previous)) baseSelect.value = previous;
    else baseSelect.value = ["origin/main", "main", "origin/master", "master"].find((ref) => result.refs.includes(ref)) || result.refs[0] || "";
    if (panel === "review") renderChanges();
  };
  el("diff-stage").addEventListener("click", () => {
    const change = selectedChange;
    if (!change) return;
    const stage = el<HTMLButtonElement>("diff-stage");
    stage.disabled = true;
    void options.invoke("git_stage", { root: cwd, path: change.path, oldPath: change.oldPath, stage: el<HTMLSelectElement>("review-mode").value !== "staged" })
      .then(loadChanges).catch(report).finally(() => { stage.disabled = false; });
  });
  const diagnostics = async () => {
    const key = ++refreshGeneration;
    el("tool-message").textContent = text("verify"); el("tool-message").hidden = false;
    let checks: { name: string; ok: boolean; detail: string }[] = [];
    let checkedAt = Date.now() / 1000;
    if (options.desktop) {
      const result = await options.invoke<{ checks: typeof checks; checkedAt: number }>("run_diagnostics");
      checks = result.checks; checkedAt = result.checkedAt;
    } else {
      checks = [{ name: text("preview"), ok: false, detail: options.language() === "en" ? "The local Pi process is not available in browser preview." : "浏览器预览未连接本地 Pi 进程。" }];
    }
    const video = el<HTMLVideoElement>("wallpaper");
    checks.push({ name: options.language() === "en" ? "Native wallpaper player" : "原生壁纸播放器",
      ok: video.autoplay && video.loop && video.muted && video.playsInline && !video.error,
      detail: video.error ? formatUserError(video.error.message) : options.language() === "en" ? "Native video / image, no frame conversion" : "原生视频 / 图片，没有逐帧转换" });
    const terminalBounds = el("terminal-stage").getBoundingClientRect();
    const inputBounds = composer.getBoundingClientRect();
    const visible = inputBounds.width > 0 && inputBounds.height > 0;
    checks.push({ name: options.language() === "en" ? "Input layout" : "输入布局",
      ok: !visible || terminalBounds.bottom <= inputBounds.top + 1,
      detail: !visible ? (options.language() === "en" ? "Composer is collapsed" : "输入栏已收起")
        : options.language() === "en" ? "Terminal and composer do not overlap" : "已检查终端和输入栏的实际位置" });
    if (key !== refreshGeneration || panel !== "diagnostics") return;
    el("tool-message").hidden = true;
    const list = el("diagnostics-list"); list.replaceChildren();
    for (const check of checks) {
      const row = document.createElement("div"); row.className = `diagnostic-row ${check.ok ? "ok" : "warning"}`;
      const body = document.createElement("div");
      const name = document.createElement("strong"); name.textContent = check.name;
      const detail = document.createElement("small"); detail.textContent = check.detail;
      body.append(name, detail); row.append(icon(check.ok ? "check" : "circle-alert"), body); list.append(row);
    }
    const notify = document.createElement("label"); notify.className = "notification-setting";
    const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.checked = notificationEnabled;
    const label = document.createElement("span"); label.textContent = options.language() === "en" ? "Background completion notifications" : "后台完成通知";
    toggle.addEventListener("change", () => {
      void (async () => {
        if (toggle.checked && "Notification" in window && Notification.permission !== "granted") await Notification.requestPermission();
        notificationEnabled = toggle.checked && "Notification" in window && Notification.permission === "granted";
        toggle.checked = notificationEnabled; store("pi.notifications", notificationEnabled);
      })().catch(report);
    });
    notify.append(toggle, label); list.append(notify);
    el("diagnostics-time").textContent = new Date(checkedAt * 1000).toLocaleString();
  };
  async function refreshPanel() {
    const view = panel; const version = generation;
    el("tool-message").hidden = true;
    try {
      if (!cwd && view !== "diagnostics" && view !== "work") throw new Error(text("disconnected"));
      if (view === "work") renderWorkPanel();
      else if (view === "files") await renderFiles();
      else if (view === "history") await loadSessions();
      else if (view === "review") await loadChanges();
      else if (view === "diagnostics") await diagnostics();
    } catch (error) { if (view === panel && version === generation) report(error); }
  }
  const renderWorkPanel = () => {
    const stateLabel = state.busy ? text("working") : state.connected ? text("ready") : text("disconnected");
    const stateNode = el("work-panel-state");
    const dot = el("work-panel-dot");
    stateNode.textContent = stateLabel;
    dot.className = state.busy ? "is-running" : state.connected ? "is-complete" : "is-error";
    el("work-panel-task").textContent = state.busy
      ? (options.language() === "en" ? "The current task is running. You can keep reading the answer while monitoring progress here." : "当前任务正在运行，可继续查看回答，并在这里监控进度。")
      : (options.language() === "en" ? "No active task. Start a message to monitor it here." : "当前没有运行中的任务，发送消息后将在这里显示进度。");
    const task = state.task && typeof state.task === "object" ? state.task as { events?: { type?: string; note?: string }[] } : undefined;
    const notes = Array.isArray(task?.events) ? task.events.filter(event => event?.type === "checkpoint" && typeof event.note === "string") : [];
    const checkpoint = notes[notes.length - 1];
    if (checkpoint?.note) el("work-panel-task").textContent = checkpoint.note.slice(0, 500);
    el("work-panel-model").textContent = state.model || "—";
    el("work-panel-usage").textContent = state.usage
      ? `${state.usage.tokens.toLocaleString()} tokens${state.usage.cost === null ? "" : ` · $${state.usage.cost.toFixed(4)}`}` : "—";
    el("work-panel-cwd").textContent = cwd || "—";
    const snapshot = progress.snapshot(), english = options.language() === "en";
    const list = el("work-progress-list");
    const signature = JSON.stringify(snapshot);
    if (list.dataset.signature !== signature + options.language()) {
      list.dataset.signature = signature + options.language(); list.replaceChildren();
      el("work-progress-count").textContent = snapshot.steps.length ? `${snapshot.steps.filter(step => step.status === "completed").length}/${snapshot.steps.length}` : "";
      for (const step of snapshot.steps) {
        const row = document.createElement("li"); row.dataset.status = step.status;
        const mark = document.createElement("span"); mark.className = "work-step-mark"; mark.setAttribute("aria-label", step.status);
        mark.append(icon(step.status === "completed" ? "check" : step.status === "failed" ? "x" : "circle"));
        const label = document.createElement("span"); label.textContent = step.title;
        row.append(mark, label); list.append(row);
      }
      if (!snapshot.steps.length) empty(list, english ? "Waiting for a plan or tool activity." : "等待任务计划或工具执行记录。");
    }
    const artifacts = el("work-artifact-list");
    const more = el<HTMLButtonElement>("work-artifact-more");
    if (snapshot.artifacts.length <= 5) artifactsExpanded = false;
    const artifactsSignature = `${JSON.stringify(snapshot.artifacts)}:${english}:${artifactsExpanded}`;
    if (artifacts.dataset.signature !== artifactsSignature) {
      artifacts.dataset.signature = artifactsSignature;
      artifacts.replaceChildren();
      const visibleArtifacts = artifactsExpanded ? snapshot.artifacts : snapshot.artifacts.slice(0, 5);
      for (const path of visibleArtifacts) {
        const wrapper = document.createElement("div"); wrapper.className = "work-artifact-row";
        const row = document.createElement("button"); row.type = "button"; row.className = "file-row"; row.title = path;
        const label = document.createElement("span"); label.textContent = path;
        row.append(icon("file"), label);
        const reveal = () => options.invoke("reveal_workspace_file", { root: cwd, path }).catch(report);
        row.addEventListener("click", () => {
          if (/\.(?:md|txt|json|jsonl|ya?ml|toml|csv|tsv|log|[cm]?[jt]sx?|css|html?|rs|py|sh|swift|xml|sql)$/i.test(path)) {
            openPanel("files"); void openFile(path).catch(report);
          } else void reveal();
        });
        const locate = document.createElement("button"); locate.type = "button"; locate.className = "icon-button";
        locate.title = english ? "Show in file manager" : "在文件管理器中显示"; locate.setAttribute("aria-label", locate.title);
        locate.append(icon("folder-open")); locate.addEventListener("click", () => { void reveal(); });
        wrapper.append(row, locate); artifacts.append(wrapper);
      }
      if (!snapshot.artifacts.length) empty(artifacts, english ? "Files appear after successful writes." : "文件成功生成后显示在这里。");
    }
    el("work-artifact-count").textContent = snapshot.artifacts.length ? String(snapshot.artifacts.length) : "";
    more.hidden = snapshot.artifacts.length <= 5;
    more.setAttribute("aria-expanded", String(artifactsExpanded));
    more.textContent = artifactsExpanded
      ? text("showLessArtifacts")
      : `${text("showMoreArtifacts")} (${Math.max(0, snapshot.artifacts.length - 5)})`;
    for (const [key, zh, en] of [["overview", "概览", "Overview"], ["progress", "任务进程", "Task progress"], ["artifacts", "产物", "Artifacts"], ["details", "运行详情", "Run details"]]) {
      el("work-view").querySelector<HTMLElement>(`[data-work-label="${key}"]`)!.textContent = english ? en : zh;
    }
    const agents = el("work-panel-agents"); agents.replaceChildren();
    for (const agent of state.agents || []) {
      const row = document.createElement("div"); row.className = `work-panel-agent${agent.status === "running" ? " is-running" : ""}`;
      const dot = document.createElement("span");
      const label = document.createElement("span"); label.textContent = agent.label || agent.id || "Agent";
      const status = document.createElement("small"); status.textContent = agent.status || "";
      row.append(dot, label, status); agents.append(row);
    }
    el<HTMLButtonElement>("work-panel-stop").disabled = !state.busy;
  };
  el("work-artifact-more").addEventListener("click", () => {
    artifactsExpanded = !artifactsExpanded;
    renderWorkPanel();
  });
  for (const view of ["work", "files", "history", "review", "diagnostics"] as const) el(`${view}-open`).addEventListener("click", () => {
    if (view === "work" && panel === "work") closePanel(); else openPanel(view);
  });
  el("work-panel-stop").addEventListener("click", () => { void options.invoke("gui_action", { action: "stop" }).catch(report); });
  el("work-panel-focus").addEventListener("click", () => { closePanel(); options.focusTerminal(); });
  el("workspace-choose").addEventListener("click", () => { void openWorkspace().catch(report); });
  el("tool-close").addEventListener("click", closePanel);
  el("tool-refresh").addEventListener("click", () => { void refreshPanel(); });
  el("history-search").addEventListener("input", renderHistory);
  el("history-scope").addEventListener("change", renderHistory);
  el("archive-toggle").addEventListener("click", () => {
    archived = !archived; el("archive-toggle").setAttribute("aria-pressed", String(archived)); renderHistory();
  });
  el("review-mode").addEventListener("change", () => {
    el("review-base").hidden = el<HTMLSelectElement>("review-mode").value !== "branch";
    selectedChange = undefined; el("diff-stage").hidden = true;
    void loadChanges().catch(report);
  });
  el("review-base").addEventListener("change", () => { void loadChanges().catch(report); });
  el("file-search").addEventListener("input", () => {
    clearTimeout(timer); timer = setTimeout(() => { void renderFiles().catch(report); }, 150);
  });
  type Action = { title: string; symbol: string; run: () => void };
  let paletteActions: Action[] = [];
  let paletteIndex = 0;
  const renderPalette = () => {
    const actions: Action[] = [
      { title: text("new"), symbol: "square-pen", run: () => { void executeCommand("/new").catch(report); } },
      { title: text("workspace"), symbol: "folder-open", run: () => { void openWorkspace().catch(report); } },
      ...(["work", "files", "history", "review", "diagnostics"] as Panel[]).map((view) => ({
        title: text(view), symbol: view === "review" ? "git-pull-request" : view === "diagnostics" ? "shield-check" : view,
        run: () => openPanel(view),
      })),
      ...(isClaude() ? [] : ["model", "tree", "fork", "compact", "reload"] as const).map((command) => ({
        title: text(command), symbol: command === "model" ? "box" : "git-branch",
        run: () => { void executeCommand(`/${command}`).catch(report); },
      })),
      { title: text("input"), symbol: "text-cursor-input", run: toggleComposer },
      { title: text("settings"), symbol: "settings-2", run: options.settings },
      ...(["fullscreen", "wallpaper", "frame"] as const).map((name) => ({
        title: text(name), symbol: name === "fullscreen" ? "maximize" : name === "wallpaper" ? "image" : "panel-top-close",
        run: () => el(`${name}-toggle`).click(),
      })),
      ...sessions.filter((session) => !meta[session.path]?.archived).map((session) => ({
        title: `${session.title} · ${session.cwd}`, symbol: "history",
        run: () => { void resumeSession(session).catch(report); },
      })),
    ];
    const query = paletteInput.value.trim().toLowerCase();
    paletteActions = actions.filter((action) => action.title.toLowerCase().includes(query)).slice(0, 70);
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteActions.length - 1));
    const list = el("palette-results"); list.replaceChildren();
    for (const [index, action] of paletteActions.entries()) {
      const item = document.createElement("button"); item.type = "button"; item.role = "option";
      item.setAttribute("aria-selected", String(index === paletteIndex));
      item.id = `palette-option-${index}`;
      const title = document.createElement("span"); title.textContent = action.title;
      item.append(icon(action.symbol), title);
      item.addEventListener("click", () => { closePalette(); action.run(); }); list.append(item);
    }
    if (!paletteActions.length) empty(list, text("noMatches"));
    paletteInput.setAttribute("aria-activedescendant", paletteActions.length ? `palette-option-${paletteIndex}` : "");
  };
  const openPalette = () => {
    closeTools();
    palette.hidden = false; paletteInput.value = ""; paletteIndex = 0;
    renderPalette(); paletteInput.focus();
    if (options.desktop) void loadSessions().then(() => { if (!palette.hidden) renderPalette(); }).catch(() => {});
  };
  const closePalette = () => { palette.hidden = true; if (!composer.hidden) input.focus(); else options.focusTerminal(); };
  el("palette-open").addEventListener("click", openPalette);
  el("composer-command").addEventListener("click", openPalette);
  el("palette-close").addEventListener("click", closePalette);
  palette.addEventListener("mousedown", (event) => { if (event.target === palette) closePalette(); });
  paletteInput.addEventListener("input", () => { paletteIndex = 0; renderPalette(); });
  paletteInput.addEventListener("keydown", (event) => {
    // WebKit delivers the IME-commit Enter with isComposing=false and keyCode 229.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); paletteIndex = Math.max(0, Math.min(paletteActions.length - 1, paletteIndex + (event.key === "ArrowDown" ? 1 : -1)));
      renderPalette(); el(`palette-option-${paletteIndex}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") { event.preventDefault(); const action = paletteActions[paletteIndex]; if (action) { closePalette(); action.run(); } }
  });
  const keyboard = (event: KeyboardEvent) => {
    if (event.isComposing || composing || !el("settings-panel").hidden) return;
    if (!toolsMenu.hidden) {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeTools(true); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        const items = [...toolsMenu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus(); return;
      }
      if (event.key === "Tab") closeTools();
    }
    if (!palette.hidden) {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closePalette(); }
      if (event.key === "Tab") {
        event.preventDefault(); (document.activeElement === paletteInput ? el("palette-close") : paletteInput).focus();
      }
      return;
    }
    if (document.querySelector(".claude-view-modal") || !el("settings-panel").hidden || event.isComposing || event.repeat) return;
    const match = (id: string, key: string) => options.matchesShortcut
      ? options.matchesShortcut(id, event) : isGuiShortcut(event) && event.key.toLowerCase() === key;
    if (match("gui.palette", "k")) { event.preventDefault(); event.stopImmediatePropagation(); openPalette(); }
    else if (match("gui.files", "p")) { event.preventDefault(); event.stopImmediatePropagation(); openPanel("files"); el("file-search").focus(); }
    else if (match("gui.review", "r")) { event.preventDefault(); event.stopImmediatePropagation(); openPanel("review"); }
    else if (match("gui.composer", "j")) { event.preventDefault(); event.stopImmediatePropagation(); toggleComposer(); }
    else if (match("gui.save", "s") && panel === "files" && currentFile) { event.preventDefault(); event.stopImmediatePropagation(); void saveFile().catch(report); }
  };
  document.addEventListener("keydown", keyboard, true);
  const refreshStrings = () => {
    refreshHeader();
    renderSidebarHistory();
    document.querySelectorAll<HTMLElement>("[data-feature]").forEach((element) => { element.textContent = text(element.dataset.feature!); });
    for (const [id, key] of Object.entries({
      "attach-file": "attach", "composer-command": "command", "composer-stop": "stop", "composer-toggle": "input",
      "palette-open": "palette", "palette-close": "close", "tool-refresh": "refresh", "tool-close": "close",
      "file-save": "save", "file-reference": "reference", "file-editor-close": "close", "archive-toggle": "archived",
      "workspace-choose": "workspace",
      "work-open": "work",
      "work-tools-toggle": "workTools", "work-tools-settings": "settings",
    })) { const element = el(id); element.title = text(key); element.setAttribute("aria-label", text(key)); }
    const placeholder = isClaude() ? (options.language() === "en" ? "Message Agent…" : "向 Agent 发送消息…") : text("placeholder");
    input.placeholder = placeholder; input.setAttribute("aria-label", placeholder);
    for (const [id, key] of [["file-search", "searchFiles"], ["history-search", "searchSessions"], ["palette-search", "searchCommands"]]) {
      el<HTMLInputElement>(id).placeholder = text(key); el(id).setAttribute("aria-label", text(key));
    }
    el("queued-status").textContent = text("queued");
    const scope = el<HTMLSelectElement>("history-scope"); scope.options[0].textContent = text("currentWorkspace"); scope.options[1].textContent = text("allWorkspaces");
    const mode = el<HTMLSelectElement>("review-mode"); mode.options[0].textContent = text("workingTree"); mode.options[1].textContent = text("staged");
    mode.options[2].textContent = text("branch");
    if (panel) { el("tool-panel-title").textContent = text(panel); if (panel === "work") renderWorkPanel(); }
    refreshComposer();
  };
  if (options.desktop) {
    void listen("pi-gui-state", (event) => { if (!isClaude()) setState(event.payload); }).then((unlisten) => {
      if (disposed) unlisten(); else unlisteners.push(unlisten);
    }).catch(report);
    void listen<{ message: string; bridgeId?: string }>("pi-gui-error", (event) => {
      if (!isClaude() && (!bridgeId || !event.payload.bridgeId || event.payload.bridgeId === bridgeId)) report(event.payload.message);
    }).then((unlisten) => {
      if (disposed) unlisten(); else unlisteners.push(unlisten);
    }).catch(report);
  }
  refreshStrings(); refreshAttachments(); autoHeight();
  return {
    observeEvent(value: unknown) { if (disposed) return; progress.event(value, cwd); if (panel === "work") renderWorkPanel(); },
    addPaths, setState, refreshStrings, executeCommand, requireSwitch, selectAgent,
    getState: () => state,
    engineChanged() {
      progress.reset(); progressSession = "";
      bridgeId = ""; sessions = []; recentsSignature = ""; recentsLoadedFor = ""; sessionsLoading = undefined;
      state = {ready:false,busy:false,connected:false};
      switchDraft(`${draftNamespace()}${cwd || "initial"}`);
      if (isClaude()) composer.hidden = false;
      refreshStrings(); renderSidebarHistory();
    },
    async dismissSelector() {
      options.prepareCommand?.();
      const result = await options.invoke<{dismissed: boolean}>("gui_action", {action: "dismiss"});
      options.focusTerminal();
      return result.dismissed;
    },
    focusInput() {
      if (!composer.hidden && !document.body.classList.contains("frame-hidden") && !document.body.classList.contains("terminal-view")
        && state.ready && !state.nativeDraft) input.focus();
      else options.focusTerminal();
    },
    setRuntime(info: { cwd: string; bridgeId?: string }) {
      if (info.cwd !== cwd || info.bridgeId !== bridgeId) { progress.reset(); progressSession = ""; }
      runtimeVersion++;
      cwd = info.cwd;
      void refreshHeaderGit();
      bridgeId = info.bridgeId || "";
      presentationKey = ""; presentationPending = "";
      switchDraft(`${draftNamespace()}${cwd}`);
      syncPresentation();
    },
    runtimeId: () => bridgeId,
    disconnected() { runtimeVersion++; setState({ ready: false, busy: false, connected: false }); },
    async synchronize() {
      const version = runtimeVersion;
      if (options.desktop) { const value = await options.invoke("gui_status"); if (!disposed && version === runtimeVersion) setState(value); }
    },
    openDiagnostics: () => openPanel("diagnostics"),
    dispose() {
      disposed = true; saveDraft(); clearTimeout(timer);
      generation++; fileGeneration++; refreshGeneration++; gitGeneration++;
      unlisteners.forEach((unlisten) => unlisten()); document.removeEventListener("keydown", keyboard, true);
      document.removeEventListener("pointerdown", outsideTools, true);
    },
  };
}
