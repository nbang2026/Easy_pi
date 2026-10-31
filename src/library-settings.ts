import { icon } from "./icons.ts";
import { formatUserError } from "./utils.ts";

type Entry = { id: string; title: string; content: string; source?: string; updatedAt: number; scope?: string };
type EntrySummary = Omit<Entry, "content">;
type Library = { workspace?: string; executionMode?: string; builtinAgents?: {id:string;title:string}[]; settings: { memoryEnabled: boolean; autonomousDownloads: boolean; activeAgent?: string }; memories: Entry[]; agents: Entry[] };
export function setupLibrarySettings(options: {
  invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T>;
  translate(key: string): string;
  toast?(message: string): void;
  openMarket?(): void;
}) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
  const kind = el<HTMLSelectElement>("library-kind");
  const search = el<HTMLInputElement>("library-search");
  const list = el("library-list");
  const title = el<HTMLInputElement>("library-title");
  const content = el<HTMLTextAreaElement>("library-content");
  const sourceRow = el("agent-download-row");
  const status = el("library-status");
  const scope = el<HTMLSelectElement>("memory-scope");
  let selectedUpdatedAt: number | undefined;
  const enabled = el<HTMLInputElement>("memory-switch");
  const downloads = el<HTMLInputElement>("agent-download-switch");
  const activate = el<HTMLButtonElement>("library-activate");
  const activateLabel = el("library-activate-label");
  // The input-bar picker is optional so the settings pane works on its own.
  const picker = document.getElementById("role-select") as HTMLSelectElement | null;
  let data: Library = { settings: { memoryEnabled: true, autonomousDownloads: true }, memories: [], agents: [] };
  let selected = "";
  let original = "";
  let loading = false;
  let disposed = false;
  let generation = 0;
  let searchGeneration = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchResults: { kind: string; entries: EntrySummary[] } | undefined;
  let searching = false;
  let statusKey = "";
  let workspace = "";
  const drafts = new Map<string, { kind: string; selected: string; updatedAt?: number; title: string; content: string; scope: string; original: string }>();
  const request = async <T>(value: Record<string, unknown>) => {
    const expectedWorkspace = workspace;
    const result = await options.invoke<{ data: T }>("gui_action", { action: "library", text: JSON.stringify({ ...value, expectedWorkspace }) });
    if (disposed || workspace !== expectedWorkspace) throw Error(options.translate("library.projectChanged"));
    const responseWorkspace = (result.data as { workspace?: unknown } | null)?.workspace;
    if (expectedWorkspace && typeof responseWorkspace === "string" && responseWorkspace !== expectedWorkspace)
      throw Error(options.translate("library.projectChanged"));
    return result.data;
  };
  const message = (key: string) => { statusKey = key; status.textContent = options.translate(key); };
  const dirty = () => original !== JSON.stringify([title.value, content.value, scope.value]);
  const active = () => data.settings.activeAgent || "";
  const activeRole = () => active().startsWith("engine:") ? "" : active();
  const renderPicker = () => {
    if (!picker) return;
    const none = document.createElement("option"); none.value = ""; none.textContent = options.translate("library.noAgent");
    const choices = data.agents.filter((item) => !item.id.startsWith("engine:")).slice().sort((a, b) => a.title.localeCompare(b.title)).map((item) => {
      const option = document.createElement("option"); option.value = item.id; option.textContent = item.title; return option;
    });
    const builtins = (data.builtinAgents || []).filter((item) => !item.id.startsWith("engine:")).map((item) => { const option = document.createElement("option"); option.value = item.id; option.textContent = item.title; return option; });
    picker.replaceChildren(none, ...builtins, ...choices);
    picker.value = activeRole();
    picker.disabled = loading;
    const label = picker.closest("label");
    label?.classList.toggle("is-active", !!activeRole());
    if (label) label.title = `${options.translate("library.activeTitle")}: ${picker.selectedOptions[0]?.textContent || ""}`;
  };
  const render = () => {
    renderPicker();
    list.replaceChildren();
    sourceRow.hidden = kind.value !== "agent";
    el("memory-scope-row").hidden = kind.value !== "memory";
    scope.disabled = loading;
    enabled.checked = data.settings.memoryEnabled;
    downloads.checked = data.settings.autonomousDownloads;
    const restricted = data.executionMode !== "autonomous";
    const modeKnown = ["readonly", "confirm", "project", "autonomous"].includes(data.executionMode || "");
    el("memory-effective").textContent = options.translate(!data.settings.memoryEnabled ? "library.memoryOff"
      : !modeKnown ? "library.permissionsPending" : restricted ? "library.memoryReadOnly" : "library.memoryWritable");
    el("download-effective").textContent = options.translate(!data.settings.autonomousDownloads ? "library.downloadOff"
      : !modeKnown ? "library.permissionsPending" : restricted ? "library.downloadRestricted" : "library.downloadEffective");
    el("library-workspace").textContent = workspace;
    list.setAttribute("aria-busy", String(loading || searching));
    const entries = search.value.trim() && searchResults?.kind === kind.value
      ? searchResults.entries : kind.value === "memory" ? data.memories : data.agents;
    for (const item of entries.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
      const button = document.createElement("button"); button.type = "button"; button.disabled = loading;
      button.setAttribute("aria-pressed", String(selected === item.id)); button.title = item.source || item.title;
      const label = document.createElement("span"); label.textContent = item.title;
      button.append(icon(kind.value === "memory" ? "notebook-pen" : "bot"), label);
      if (kind.value === "agent" && item.id === active()) {
        const mark = icon("check"); mark.classList.add("library-active-mark"); button.append(mark);
        button.dataset.active = "true";
      }
      button.addEventListener("click", () => {
        if (dirty()) { message("library.unsaved"); return; }
        operation(async () => {
          const value = await request<Entry>({ kind: kind.value, action: "read", id: item.id });
          if (!disposed) select(value);
        });
      });
      list.append(button);
    }
    if (!list.childElementCount) { const empty = document.createElement("div"); empty.className = "model-empty"; empty.textContent = options.translate("library.empty"); list.append(empty); }
    for (const id of ["library-new", "library-save", "library-refresh", "library-open-market", "memory-switch", "agent-download-switch"]) (el(id) as HTMLButtonElement).disabled = loading;
    el<HTMLButtonElement>("library-remove").disabled = loading || !selected;
    activate.hidden = kind.value !== "agent" || !selected;
    activate.disabled = loading;
    activateLabel.textContent = options.translate(selected && selected === active() ? "library.deactivate" : "library.activate");
    title.disabled = content.disabled = kind.disabled = loading;
    if (statusKey) status.textContent = options.translate(statusKey);
  };
  const select = (item?: Entry) => {
    selected = item?.id || "";
    selectedUpdatedAt = item?.updatedAt;
    scope.value = item ? item.scope || "global" : "project";
    title.value = item?.title || "";
    content.value = item?.content || "";
    original = JSON.stringify([title.value, content.value, scope.value]);
    render();
  };
  const cancelSearch = () => {
    searchGeneration++;
    clearTimeout(searchTimer);
    searchTimer = undefined;
    searching = false;
  };
  const updateSearch = (debounce = true) => {
    if (disposed) return;
    cancelSearch();
    const query = search.value.trim();
    if (!query) { searchResults = undefined; render(); return; }
    const version = searchGeneration;
    const searchKind = kind.value;
    searching = true;
    render();
    const run = async () => {
      searchTimer = undefined;
      try {
        const entries = await request<EntrySummary[]>({ kind: searchKind, action: "list", query });
        if (disposed || version !== searchGeneration) return;
        searchResults = { kind: searchKind, entries };
      } catch (error) {
        if (disposed || version !== searchGeneration) return;
        statusKey = ""; status.textContent = formatUserError(error);
      } finally {
        if (!disposed && version === searchGeneration) { searching = false; render(); }
      }
    };
    if (debounce) searchTimer = setTimeout(() => { void run(); }, 200);
    else void run();
  };
  const refresh = async () => {
    const version = ++generation;
    cancelSearch();
    const value = await request<Library>({ kind: "list" });
    if (disposed || generation !== version) return;
    if (value.workspace && value.workspace !== workspace) setWorkspace(value.workspace);
    data = value;
    updateSearch(false);
  };
  const operation = (action: () => Promise<void>) => {
    if (loading || disposed) return;
    loading = true; render();
    const operationWorkspace = workspace;
    void action().catch((error) => { if (!disposed && workspace === operationWorkspace) { statusKey = ""; status.textContent = formatUserError(error); } })
      .finally(() => { if (workspace === operationWorkspace) { loading = false; if (!disposed) render(); } });
  };
  const setWorkspace = (cwd: string) => {
    if (cwd === workspace || disposed) return;
    if (dirty()) drafts.set(workspace, { kind: kind.value, selected, updatedAt: selectedUpdatedAt, title: title.value, content: content.value, scope: scope.value, original });
    workspace = cwd; generation++; cancelSearch(); searchResults = undefined; loading = false;
    data = { ...data, executionMode: undefined, memories: [] };
    const draft = drafts.get(workspace);
    if (draft) {
      kind.value = draft.kind;
      selected = draft.selected; selectedUpdatedAt = draft.updatedAt;
      title.value = draft.title; content.value = draft.content; scope.value = draft.scope; original = draft.original;
      render();
    } else select();
    message("");
  };
  select();
  search.addEventListener("input", () => updateSearch());
  kind.addEventListener("change", () => {
    if (disposed) return;
    if (dirty()) { kind.value = kind.value === "memory" ? "agent" : "memory"; message("library.unsaved"); return; }
    select(); message(""); updateSearch();
  });
  el("library-new").addEventListener("click", () => { if (dirty()) { message("library.unsaved"); return; } select(); title.focus(); });
  el("library-save").addEventListener("click", () => operation(async () => {
    const value = await request<Entry>({ kind: kind.value, action: "save", id: selected || undefined,
      title: title.value, content: content.value, ...(kind.value === "memory" ? { scope: scope.value, expectedUpdatedAt: selectedUpdatedAt } : {}) });
    await refresh(); if (disposed) return; drafts.delete(workspace); select(value); message("library.saved");
  }));
  scope.addEventListener("change", () => {
    if (!selected || kind.value !== "memory") return;
    const targetScope = scope.value, previous = JSON.parse(original) as string[];
    scope.value = previous[2];
    if (dirty()) { message("library.unsaved"); return; }
    if (!window.confirm(options.translate(targetScope === "global" ? "library.moveGlobalConfirm" : "library.moveProjectConfirm"))) return;
    operation(async () => {
      const value = await request<Entry>({ kind: "memory", action: "move", id: selected, targetScope, confirmed: true, expectedUpdatedAt: selectedUpdatedAt });
      await refresh(); if (disposed) return; select(value); message("library.saved");
    });
  });
  el("library-refresh").addEventListener("click", () => operation(async () => { await refresh(); message("library.refreshed"); }));
  el("library-remove").addEventListener("click", () => {
    if (!selected || dirty()) { message("library.unsaved"); return; }
    if (!window.confirm(options.translate("library.deleteConfirm"))) return;
    operation(async () => { await request({ kind: kind.value, action: "remove", id: selected }); await refresh(); if (!disposed) { select(); message("library.removed"); } });
  });
  el("library-open-market").addEventListener("click", () => {
    if (dirty()) { message("library.unsaved"); return; }
    if (!disposed && !loading) options.openMarket?.();
  });
  const setActive = (id: string) => operation(async () => {
    await request({ kind: "settings", activeAgent: id });
    await refresh(); if (disposed) return;
    const key = id ? "library.activated" : "library.deactivated";
    message(key); options.toast?.(options.translate(key));
  });
  activate.addEventListener("click", () => {
    if (!selected || dirty()) { message("library.unsaved"); return; }
    setActive(selected === active() ? "" : selected);
  });
  picker?.addEventListener("change", () => {
    const value = picker.value;
    picker.value = active();
    setActive(value);
  });
  for (const [control, key] of [[enabled, "memoryEnabled"], [downloads, "autonomousDownloads"]] as const) {
    control.addEventListener("change", () => {
      const checked = control.checked;
      operation(async () => { await request({ kind: "settings", [key]: checked }); await refresh(); message("library.saved"); });
    });
  }
  return {
    setWorkspace,
    refresh: () => { if (!disposed) operation(async () => { await refresh(); }); },
    refreshLanguage: render,
    dispose() { disposed = true; generation++; cancelSearch(); },
  };
}
