import { icon } from "./icons.ts";

type MarketEntry = { id: string; title: string; category: string; description?: string; author: string; license: string; kind: string; source: string; hash: string; marketKey: string; version: string; installedId?: string };
type Preview = MarketEntry & { content: string; token?: string };
type Installed = { id: string; marketKey: string; title: string; source?: string; hash: string };
type State = { entries: MarketEntry[]; installed: Installed[]; activeAgent: string };

export function setupAgentMarket(options: {
  invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T>;
  translate(key: string): string;
  changed(): void;
  openLibrary(): void;
}) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
  const list = el("market-list"); const search = el<HTMLInputElement>("market-search");
  const category = el<HTMLSelectElement>("market-category"); const installedOnly = el<HTMLInputElement>("market-installed-only");
  const refreshButton = el<HTMLButtonElement>("market-refresh"); const status = el("market-status");
  const source = el<HTMLInputElement>("market-source"); const remote = el<HTMLButtonElement>("market-preview-url");
  const detail = el("market-detail"); const title = el("market-detail-title"); const metadata = el("market-detail-meta");
  const content = el("market-content"); const agree = el<HTMLInputElement>("market-consent");
  const importButton = el<HTMLButtonElement>("market-import"); const activate = el<HTMLButtonElement>("market-activate");
  const close = el<HTMLButtonElement>("market-detail-close"); const deactivate = el<HTMLButtonElement>("market-deactivate");
  const activeLabel = el("market-active-label"); const library = el<HTMLButtonElement>("market-open-library");
  let state: State = { entries: [], installed: [], activeAgent: "" };
  let preview: Preview | null = null; let busy = false; let disposed = false; let generation = 0;
  let message = "market.connectHint"; let errorMessage = "";
  const subscriptions: (() => void)[] = [];
  const on = (element: HTMLElement, event: string, handler: EventListener) => { element.addEventListener(event, handler); subscriptions.push(() => element.removeEventListener(event, handler)); };
  const request = async <T>(data: Record<string, unknown>) => {
    if (disposed) throw Error("Market view disposed");
    const response = await options.invoke<{ data: T }>("gui_action", { action: "library", text: JSON.stringify(data) });
    if (disposed) throw Error("Market view disposed");
    return response.data;
  };
  const lookup = (key: string) => state.installed.find((item) => item.marketKey === key);
  const setMessage = (key: string) => { if (!disposed) { message = key; errorMessage = ""; } };
  const render = () => {
    if (disposed) return;
    const t = options.translate;
    const query = search.value.trim().toLowerCase();
    const items = state.entries.filter((item) => (category.value === "all" || item.category === category.value)
      && (!installedOnly.checked || !!lookup(item.marketKey)) && `${item.title} ${item.description || ""} ${item.author}`.toLowerCase().includes(query));
    list.replaceChildren();
    for (const item of items) {
      const installed = lookup(item.marketKey); const card = document.createElement("button");
      card.type = "button"; card.className = "market-card"; card.disabled = busy; card.dataset.marketId = item.id || item.installedId || "";
      const heading = document.createElement("strong"); heading.textContent = item.title;
      const summary = document.createElement("span"); summary.className = "market-card-description"; summary.textContent = item.description || "";
      const tags = document.createElement("span"); tags.className = "market-card-tags"; tags.textContent = `${t("market.category." + item.category)} · ${t("market.textOnly")} · ${installed ? t("market.installed") : t("market.available")}`;
      card.append(icon("bot"), heading, summary, tags);
      card.addEventListener("click", () => { void operation(async () => {
        clearPreview(); setMessage("market.loadingPreview"); render();
        preview = await request<Preview>({ kind: "market", action: "preview", id: item.id || undefined, installedId: item.id ? undefined : item.installedId });
        setMessage("market.previewReady");
      }); });
      list.append(card);
    }
    if (!items.length) { const empty = document.createElement("p"); empty.className = "model-empty"; empty.textContent = t(state.entries.length ? "market.noMatch" : "market.connectHint"); list.append(empty); }
    list.setAttribute("aria-busy", String(busy));
    status.textContent = errorMessage || t(message); status.classList.toggle("is-error", !!errorMessage);
    refreshButton.disabled = remote.disabled = busy; source.disabled = busy;
    deactivate.disabled = busy; deactivate.hidden = !state.activeAgent;
    const active = state.installed.find((item) => item.id === state.activeAgent);
    activeLabel.textContent = `${t("market.active")}: ${active?.title || (state.activeAgent ? t("market.localAgentActive") : t("library.noAgent"))}`;
    detail.hidden = !preview; close.disabled = busy; agree.disabled = busy;
    importButton.disabled = true; activate.hidden = true; activate.disabled = true;
    if (preview) {
      title.textContent = preview.title;
      const installed = lookup(preview.marketKey);
      metadata.textContent = `${preview.author} · ${preview.license} · ${preview.version || "GitHub"}\n${preview.source}\nSHA-256: ${preview.hash}${installed && installed.hash !== preview.hash ? `\n${t("market.localEdited")}` : ""}`;
      content.textContent = preview.content;
      importButton.textContent = t(installed ? "market.installed" : "market.import");
      importButton.disabled = busy || !!installed || !agree.checked;
      activate.hidden = !installed; activate.disabled = busy || installed?.id === state.activeAgent;
      activate.textContent = t(installed?.id === state.activeAgent ? "market.activeNow" : "market.activate");
    }
    library.disabled = busy;
  };
  const clearPreview = () => {
    preview = null; agree.checked = false;
    title.textContent = metadata.textContent = content.textContent = "";
  };
  const readState = async () => {
    const current = ++generation; const value = await request<State>({ kind: "market", action: "list" });
    if (disposed || current !== generation) return;
    state = value; render();
  };
  const operation = async (action: () => Promise<void>) => {
    if (busy || disposed) return; busy = true; render();
    try { await action(); }
    catch (error) { if (!disposed) errorMessage = `${options.translate("market.failed")}: ${String(error)}`; }
    finally { busy = false; if (!disposed) render(); }
  };
  on(search, "input", render); on(category, "change", render); on(installedOnly, "change", render); on(agree, "change", render);
  on(refreshButton, "click", () => { void operation(async () => { await readState(); setMessage("market.refreshed"); }); });
  on(remote, "click", () => { void operation(async () => {
    clearPreview(); setMessage("market.loadingPreview"); render();
    preview = await request<Preview>({ kind: "market", action: "preview", source: source.value.trim() }); setMessage("market.previewReady");
  }); });
  on(close, "click", () => { if (!busy && !disposed) { clearPreview(); render(); } });
  on(importButton, "click", () => { if (!preview || !agree.checked || lookup(preview.marketKey)) return; const chosen = preview;
    void operation(async () => { await request({ kind: "market", action: "import", id: chosen.id || undefined, token: chosen.token, hash: chosen.hash, accepted: true });
      if (!disposed) options.changed(); await readState(); if (!disposed) { setMessage("market.imported"); } });
  });
  on(activate, "click", () => { const installed = preview && lookup(preview.marketKey); if (!installed || installed.id === state.activeAgent) return;
    void operation(async () => { await request({ kind: "settings", activeAgent: installed.id }); if (!disposed) options.changed(); await readState(); if (!disposed) { setMessage("library.activated"); } });
  });
  on(deactivate, "click", () => { if (!state.activeAgent) return; void operation(async () => { await request({ kind: "settings", activeAgent: "" }); if (!disposed) options.changed(); await readState(); if (!disposed) { setMessage("library.deactivated"); } }); });
  on(library, "click", () => { if (!busy && !disposed) options.openLibrary(); });
  render();
  return {
    refresh: () => operation(async () => { await readState(); setMessage("market.refreshed"); }),
    refreshLanguage: render,
    dispose() { disposed = true; generation++; subscriptions.forEach((remove) => remove()); },
  };
}
