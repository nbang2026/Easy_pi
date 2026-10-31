import { icon } from "./icons.ts";
import { formatUserError } from "./utils.ts";

type MarketEntry = { id: string; title: string; category: string; description?: string; author: string; license: string; kind: string; source: string; hash: string; marketKey: string; version: string; installedId?: string; catalogSource?: string; path?: string };
type Preview = MarketEntry & { content: string; token?: string };
type Installed = { id: string; marketKey: string; title: string; source?: string; hash: string };
type State = { entries: MarketEntry[]; installed: Installed[]; activeAgent: string };

export function setupAgentMarket(options: {
  invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T>;
  translate(key: string): string;
  changed(): void;
  openLibrary(): void;
  reconnect?(): Promise<void>;
}) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
  const list = el("market-list"); const search = el<HTMLInputElement>("market-search");
  const category = el<HTMLSelectElement>("market-category");
  const refreshButton = el<HTMLButtonElement>("market-refresh"); const status = el("market-status");
  const source = el<HTMLInputElement>("market-source"); const remote = el<HTMLButtonElement>("market-preview-url");
  const detail = el("market-detail"); const title = el("market-detail-title"); const metadata = el("market-detail-meta");
  const content = el("market-content");
  const importButton = el<HTMLButtonElement>("market-import"); const activate = el<HTMLButtonElement>("market-activate");
  const close = el<HTMLButtonElement>("market-detail-close"); const deactivate = el<HTMLButtonElement>("market-deactivate");
  const activeLabel = el("market-active-label"); const library = el<HTMLButtonElement>("market-open-library");
  const provider = el<HTMLSelectElement>("market-provider"), more = el<HTMLButtonElement>("market-more");
  const onlineControls = el("market-online-controls"), onlineState = el("market-online-state");
  const reconnect = el<HTMLButtonElement>("market-reconnect");
  const tabs = ["online", "builtin", "downloaded"] as const;
  let tab: typeof tabs[number] = "builtin", opened = false;
  let onlineEntries: MarketEntry[] = [], onlineTotal = 0, page = 0, hasMore = false, catalogBusy = false;
  let catalogGeneration = 0, catalogError = "", searchTimer: ReturnType<typeof setTimeout> | undefined;
  const onlineCache = new Map<string, { entries: MarketEntry[]; total: number; page: number; hasMore: boolean }>();
  let state: State = { entries: [], installed: [], activeAgent: "" };
  let preview: Preview | null = null; let busy = false; let disposed = false; let generation = 0;
  let message = "market.connectHint"; let errorMessage = "";
  const subscriptions: (() => void)[] = [];
  const on = (element: HTMLElement, event: string, handler: EventListener) => { element.addEventListener(event, handler); subscriptions.push(() => element.removeEventListener(event, handler)); };
  const request = async <T>(data: Record<string, unknown>) => {
    if (disposed) throw Error("Market view disposed");
    const response = await options.invoke<{ data: T }>("skill_store_action", { text: JSON.stringify(data) });
    if (disposed) throw Error("Market view disposed");
    return response.data;
  };
  const lookup = (key: string) => state.installed.find((item) => item.marketKey === key);
  const setMessage = (key: string) => { if (!disposed) { message = key; errorMessage = ""; } };
  const render = () => {
    if (disposed) return;
    const t = options.translate;
    const query = search.value.trim().toLowerCase();
    const base = tab === "online" ? onlineEntries : state.entries;
    const items = base.filter((item) => (category.value === "all" || item.category === category.value)
      && (tab !== "downloaded" || !!lookup(item.marketKey))
      && (tab === "online" || `${item.title} ${item.description || ""} ${item.author}`.toLowerCase().includes(query)));
    for (const value of tabs) {
      el("market-" + value).setAttribute("aria-selected", String(tab === value));
      el("market-" + value).tabIndex = tab === value ? 0 : -1;
      el<HTMLButtonElement>("market-" + value).disabled = busy;
    }
    provider.disabled = search.disabled = category.disabled = busy;
    onlineControls.hidden = tab !== "online";
    onlineState.textContent = t(catalogBusy ? "market.onlineLoading" : catalogError ? "market.onlineError" : "market.onlineReady");
    more.hidden = tab !== "online" || !hasMore; more.disabled = busy || catalogBusy;
    reconnect.hidden = !catalogError || !options.reconnect; reconnect.disabled = busy || catalogBusy;
    list.replaceChildren();
    for (const item of items) {
      const installed = lookup(item.marketKey); const card = document.createElement("button");
      card.type = "button"; card.className = "market-card"; card.disabled = busy; card.dataset.marketId = item.id || item.installedId || item.path || "";
      const heading = document.createElement("strong"); heading.textContent = item.title;
      const summary = document.createElement("span"); summary.className = "market-card-description"; summary.textContent = item.description || "";
      const tags = document.createElement("span"); tags.className = "market-card-tags"; tags.textContent = `${t("market.category." + item.category)} · ${t("market.textOnly")} · ${installed ? t("market.installed") : t("market.available")}`;
      card.append(icon("bot"), heading, summary, tags);
      card.addEventListener("click", () => { void operation(async () => {
        clearPreview(); setMessage("market.loadingPreview"); render();
        preview = await request<Preview>(item.catalogSource ? { kind: "market", action: "preview", catalogSource: item.catalogSource, path: item.path }
          : { kind: "market", action: "preview", id: item.id || undefined, installedId: item.id ? undefined : item.installedId });
        if (item.catalogSource) setMessage("market.reviewReady"); else await savePreview();
      }); });
      list.append(card);
    }
    const total = tab === "online" ? onlineTotal : state.entries.length;
    const count = el("market-count"); count.textContent = total ? `${items.length} / ${total}` : "";
    count.setAttribute("aria-label", options.translate("market.count"));
    if (!items.length) { const empty = document.createElement("p"); empty.className = "model-empty"; empty.textContent = t(catalogBusy ? "market.onlineLoading" : "market.noMatch"); list.append(empty); }
    list.setAttribute("aria-busy", String(busy));
    status.textContent = errorMessage || catalogError || t(message); status.classList.toggle("is-error", !!errorMessage || !!catalogError);
    refreshButton.disabled = busy || catalogBusy; remote.disabled = busy; source.disabled = busy;
    deactivate.disabled = busy; deactivate.hidden = !state.activeAgent;
    const active = state.installed.find((item) => item.id === state.activeAgent);
    activeLabel.textContent = `${t("market.active")}: ${active?.title || (state.activeAgent ? t("market.localAgentActive") : t("library.noAgent"))}`;
    detail.hidden = !preview; close.disabled = busy;
    importButton.disabled = true; activate.hidden = true; activate.disabled = true;
    if (preview) {
      title.textContent = preview.title;
      const installed = lookup(preview.marketKey);
      metadata.textContent = `${preview.author} · ${preview.license} · ${preview.version || "GitHub"}\n${preview.source}\nSHA-256: ${preview.hash}${installed && installed.hash !== preview.hash ? `\n${t("market.localEdited")}` : ""}`;
      content.textContent = preview.content;
      importButton.textContent = t(installed ? "market.installed" : "market.import");
      importButton.disabled = busy || !!installed;
      activate.hidden = !installed; activate.disabled = busy || installed?.id === state.activeAgent;
      activate.textContent = t(installed?.id === state.activeAgent ? "market.activeNow" : "market.activate");
    }
    library.disabled = busy;
  };
  const clearPreview = () => {
    preview = null;
    title.textContent = metadata.textContent = content.textContent = "";
  };
  const readState = async () => {
    const current = ++generation; const value = await request<State>({ kind: "market", action: "list" });
    if (disposed || current !== generation) return;
    state = value; render();
  };
  const browse = async (append = false, refresh = false) => {
    clearTimeout(searchTimer);
    const current = ++catalogGeneration;
    const key = JSON.stringify([provider.value, search.value.trim(), category.value]);
    const targetPage = append ? page + 1 : 1;
    const cached = onlineCache.get(key);
    if (!append && !refresh && cached) {
      onlineEntries = cached.entries; onlineTotal = cached.total; page = cached.page; hasMore = cached.hasMore;
      catalogError = ""; catalogBusy = false; render(); return;
    }
    if (!append) { onlineEntries = []; onlineTotal = 0; page = 0; hasMore = false; }
    catalogBusy = true; catalogError = ""; render();
    try {
      const result = await request<{ entries: MarketEntry[]; total: number; page: number; hasMore: boolean }>({
        kind: "market", action: "browse", provider: provider.value, query: search.value.trim(),
        category: category.value, page: targetPage, refresh });
      if (disposed || current !== catalogGeneration) return;
      onlineEntries = append ? [...new Map([...onlineEntries, ...result.entries].map(item => [item.marketKey, item])).values()] : result.entries;
      onlineTotal = result.total; page = result.page; hasMore = result.hasMore;
      onlineCache.set(key, { entries: onlineEntries, total: onlineTotal, page, hasMore });
      while (onlineCache.size > 30) onlineCache.delete(onlineCache.keys().next().value!);
      setMessage("market.onlineReady");
    } catch (error) { if (!disposed && current === catalogGeneration) catalogError = `${tError()}: ${formatUserError(error)}`; }
    finally { if (!disposed && current === catalogGeneration) { catalogBusy = false; render(); } }
  };
  const tError = () => options.translate("market.onlineError");
  const changeTab = (value: typeof tab) => {
    if (disposed || busy || tab === value) return;
    clearTimeout(searchTimer); catalogGeneration++; catalogBusy = false;
    tab = value; clearPreview(); errorMessage = ""; catalogError = ""; render();
    if (tab === "online") void browse(); else void operation(readState);
  };
  const operation = async (action: () => Promise<void>) => {
    if (busy || disposed) return; busy = true; render();
    try { await action(); }
    catch (error) { if (!disposed) errorMessage = `${options.translate("market.failed")}: ${formatUserError(error)}`; }
    finally { busy = false; if (!disposed) render(); }
  };
  const savePreview = async () => {
    if (disposed || !preview) return;
    if (lookup(preview.marketKey)) { setMessage("market.previewReady"); return; }
    const chosen = preview;
    setMessage("market.downloading"); render();
    await request({ kind: "market", action: "import", id: chosen.id || undefined, token: chosen.token, hash: chosen.hash, accepted: true });
    if (!disposed) options.changed();
    await readState();
    setMessage("market.imported");
  };
  for (const value of tabs) on(el("market-" + value), "click", () => changeTab(value));
  on(el("market-tabs"), "keydown", event => {
    const key = (event as KeyboardEvent).key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    event.preventDefault();
    const index = key === "Home" ? 0 : key === "End" ? 2 : (tabs.indexOf(tab) + (key === "ArrowRight" ? 1 : 2)) % 3;
    changeTab(tabs[index]); el("market-" + tab).focus();
  });
  on(search, "input", () => {
    if (tab !== "online") { render(); return; }
    clearTimeout(searchTimer); catalogGeneration++; catalogBusy = false; onlineEntries = []; onlineTotal = 0; hasMore = false; render();
    searchTimer = setTimeout(() => { void browse(); }, 250);
  });
  on(category, "change", () => { if (tab === "online") void browse(); else render(); });
  on(provider, "change", () => { clearPreview(); void browse(); });
  on(more, "click", () => { if (!catalogBusy && !busy && hasMore) void browse(true); });
  on(reconnect, "click", () => { void operation(async () => { await options.reconnect?.(); clearPreview(); await readState(); await browse(false, true); }); });
  on(refreshButton, "click", () => { void operation(async () => { await readState(); if (tab === "online") await browse(false, true); else setMessage("market.refreshed"); }); });
  on(remote, "click", () => { void operation(async () => {
    clearPreview(); setMessage("market.loadingPreview"); render();
    preview = await request<Preview>({ kind: "market", action: "preview", source: source.value.trim() }); await savePreview();
  }); });
  on(close, "click", () => { if (!busy && !disposed) { clearPreview(); render(); } });
  on(importButton, "click", () => { if (!preview || lookup(preview.marketKey)) return;
    void operation(savePreview);
  });
  on(activate, "click", () => { const installed = preview && lookup(preview.marketKey); if (!installed || installed.id === state.activeAgent) return;
    void operation(async () => { await request({ kind: "settings", activeAgent: installed.id }); if (!disposed) options.changed(); await readState(); if (!disposed) { setMessage("library.activated"); } });
  });
  on(deactivate, "click", () => { if (!state.activeAgent) return; void operation(async () => { await request({ kind: "settings", activeAgent: "" }); if (!disposed) options.changed(); await readState(); if (!disposed) { setMessage("library.deactivated"); } }); });
  on(library, "click", () => { if (!busy && !disposed) options.openLibrary(); });
  render();
  return {
    open: async () => {
      if (disposed) return;
      if (!opened) { opened = true; tab = "online"; render(); }
      await operation(readState);
      if (tab === "online") await browse();
    },
    refresh: () => operation(async () => { await readState(); setMessage("market.refreshed"); }),
    refreshLanguage: render,
    dispose() { disposed = true; generation++; catalogGeneration++; clearTimeout(searchTimer); subscriptions.forEach((remove) => remove()); },
  };
}
