import { icon } from "./icons.ts";

type Entry = { id: string; title: string; content: string; source?: string; updatedAt: number };
type Library = { settings: { memoryEnabled: boolean; autonomousDownloads: boolean; activeAgent?: string }; memories: Entry[]; agents: Entry[] };
export function setupLibrarySettings(options: {
  invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T>;
  translate(key: string): string;
  toast?(message: string): void;
}) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
  const kind = el<HTMLSelectElement>("library-kind");
  const search = el<HTMLInputElement>("library-search");
  const list = el("library-list");
  const title = el<HTMLInputElement>("library-title");
  const content = el<HTMLTextAreaElement>("library-content");
  const source = el<HTMLInputElement>("agent-source");
  const sourceRow = el("agent-download-row");
  const status = el("library-status");
  const enabled = el<HTMLInputElement>("memory-switch");
  const downloads = el<HTMLInputElement>("agent-download-switch");
  const activate = el<HTMLButtonElement>("library-activate");
  const activateLabel = el("library-activate-label");
  // The input-bar picker is optional so the settings pane works on its own.
  const picker = document.getElementById("agent-select") as HTMLSelectElement | null;
  let data: Library = { settings: { memoryEnabled: true, autonomousDownloads: true }, memories: [], agents: [] };
  let selected = "";
  let original = "";
  let loading = false;
  let disposed = false;
  let generation = 0;
  let statusKey = "";
  const request = async <T>(value: Record<string, unknown>) =>
    (await options.invoke<{ data: T }>("gui_action", { action: "library", text: JSON.stringify(value) })).data;
  const message = (key: string) => { statusKey = key; status.textContent = options.translate(key); };
  const dirty = () => original !== JSON.stringify([title.value, content.value]);
  const active = () => data.settings.activeAgent || "";
  const renderPicker = () => {
    if (!picker) return;
    const none = document.createElement("option"); none.value = ""; none.textContent = options.translate("library.noAgent");
    const choices = data.agents.slice().sort((a, b) => a.title.localeCompare(b.title)).map((item) => {
      const option = document.createElement("option"); option.value = item.id; option.textContent = item.title; return option;
    });
    picker.replaceChildren(none, ...choices);
    picker.value = active();
    picker.disabled = loading;
    const label = picker.closest("label");
    label?.classList.toggle("is-active", !!active());
    if (label) label.title = `${options.translate("library.activeTitle")}: ${picker.selectedOptions[0]?.textContent || ""}`;
  };
  const render = () => {
    renderPicker();
    list.replaceChildren();
    sourceRow.hidden = kind.value !== "agent";
    enabled.checked = data.settings.memoryEnabled;
    downloads.checked = data.settings.autonomousDownloads;
    const query = search.value.trim().toLowerCase();
    const entries = kind.value === "memory" ? data.memories : data.agents;
    for (const item of entries.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(query)).sort((a, b) => b.updatedAt - a.updatedAt)) {
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
    for (const id of ["library-new", "library-save", "library-refresh", "agent-download", "memory-switch", "agent-download-switch"]) (el(id) as HTMLButtonElement).disabled = loading;
    el<HTMLButtonElement>("library-remove").disabled = loading || !selected;
    activate.hidden = kind.value !== "agent" || !selected;
    activate.disabled = loading;
    activateLabel.textContent = options.translate(selected && selected === active() ? "library.deactivate" : "library.activate");
    title.disabled = content.disabled = kind.disabled = loading;
    if (statusKey) status.textContent = options.translate(statusKey);
  };
  const select = (item?: Entry) => {
    selected = item?.id || "";
    title.value = item?.title || "";
    content.value = item?.content || "";
    original = JSON.stringify([title.value, content.value]);
    render();
  };
  const refresh = async () => {
    const version = ++generation;
    const value = await request<Library>({ kind: "list" });
    if (disposed || generation !== version) return;
    data = value;
    render();
  };
  const operation = (action: () => Promise<void>) => {
    if (loading || disposed) return;
    loading = true; render();
    void action().catch((error) => { if (!disposed) { statusKey = ""; status.textContent = String(error); } })
      .finally(() => { loading = false; if (!disposed) render(); });
  };
  select();
  search.addEventListener("input", render);
  kind.addEventListener("change", () => {
    if (dirty()) { kind.value = kind.value === "memory" ? "agent" : "memory"; message("library.unsaved"); return; }
    select(); message("");
  });
  el("library-new").addEventListener("click", () => { if (dirty()) { message("library.unsaved"); return; } select(); title.focus(); });
  el("library-save").addEventListener("click", () => operation(async () => {
    const value = await request<Entry>({ kind: kind.value, action: "save", id: selected || undefined, title: title.value, content: content.value });
    await refresh(); if (disposed) return; select(value); message("library.saved");
  }));
  el("library-refresh").addEventListener("click", () => operation(async () => { await refresh(); message("library.refreshed"); }));
  el("library-remove").addEventListener("click", () => {
    if (!selected || dirty()) { message("library.unsaved"); return; }
    if (!window.confirm(options.translate("library.deleteConfirm"))) return;
    operation(async () => { await request({ kind: kind.value, action: "remove", id: selected }); await refresh(); if (!disposed) { select(); message("library.removed"); } });
  });
  el("agent-download").addEventListener("click", () => {
    if (dirty()) { message("library.unsaved"); return; }
    operation(async () => {
      message("library.downloading");
      const value = await request<Entry>({ kind: "agent", action: "download", source: source.value });
      await refresh(); if (disposed) return; source.value = ""; select(value); message("library.downloaded");
    });
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
    refresh: () => { if (!disposed) operation(async () => { await refresh(); }); },
    refreshLanguage: render,
    dispose() { disposed = true; generation++; },
  };
}
