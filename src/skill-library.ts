import { formatUserError } from "./utils.ts";

type StoreSource = "skillstore" | "skills-sh" | "skillsmp";
type Source = "all" | StoreSource;
type SkillFile = { path: string; size: number };
type Entry = { id: string; name: string; description?: string; source: Source; url?: string; repoUrl?: string; license?: string; author?: string; repository?: string; stars?: number; installs?: number };
type SourcePanel = { source: StoreSource; entries: Entry[]; phase: "idle" | "loading" | "connected" | "error"; page: number; hasMore: boolean; error: string; retryUntil: number; request: number; failedPage: number };
const storeSources: StoreSource[] = ["skillstore", "skills-sh", "skillsmp"];
const sourceRequestTimeout = 18_000;
type Skill = Omit<Entry, "source"> & { source?: string; enabled?: boolean; commit?: string; hash?: string; treeHash?: string; files?: SkillFile[] };
type Preview = Entry & { token: string; hash: string; commit?: string; files: SkillFile[]; totalBytes: number; content: string; warnings?: string[] };
type SourceStatus = { source: string; ok: boolean; error?: string; retryAfter?: number };
type SearchResult = { entries: Entry[]; sources: SourceStatus[]; page: number; hasMore: boolean };
type Job = { id: string; state: "running" | "ready" | "failed" | "cancelled"; progress?: unknown; preview?: Preview; error?: string };
type Options = {
  invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T>;
  language?: () => string;
  toast?: (message: string) => void;
  /** Resolve only after an idle runtime has actually reloaded; reject while unavailable or busy. */
  reload?: () => Promise<void>;
  reconnect?: () => Promise<void>;
};

const words = {
  title: ["Skill store", "Skill 商店"], subtitle: ["Browse live storefronts. Read the full files before downloading; enable separately.", "浏览实时商店内容。下载前阅读完整文件，再单独启用。"],
  discover: ["Online store", "在线商店"], downloaded: ["Downloaded", "已下载"], all: ["All sources", "全部来源"], source: ["Source", "来源"],
  home: ["Home / browse", "首页 / 浏览"], refreshStore: ["Refresh store", "刷新商店"], browsing: ["Loading storefront…", "正在加载商店…"], connected: ["Connected", "已连接"], browseReady: ["Browse source collections or search for a skill. No account or API key is required.", "浏览各来源内容，或搜索技能。无需账户或 API 密钥。"],
  sourceIdle: ["Ready to browse", "等待浏览"], sourceEmpty: ["This source returned no skills.", "此来源暂无技能。"], searchResults: ["Search results", "搜索结果"], timeout: ["Source timed out after 18 seconds. Retry this source.", "来源请求超过 18 秒，请重试此来源。"], author: ["Author", "作者"], stars: ["Stars", "星标"], installs: ["Installs", "安装量"], details: ["View details / download", "查看详情 / 下载"],
  query: ["Search skills", "搜索技能"], search: ["Search", "搜索"], url: ["Skill or repository URL", "技能或仓库链接"], previewUrl: ["Preview URL", "预览链接"],
  refresh: ["Refresh downloaded", "刷新已下载"], start: ["Search a source or paste a skill URL to begin. No account or API key is required.", "搜索来源或粘贴技能链接开始。无需账户或 API 密钥。"],
  empty: ["No downloaded skills yet.", "尚未下载技能。"], noResults: ["No matching skills found.", "未找到匹配的技能。"], searching: ["Searching sources…", "正在搜索来源…"],
  loading: ["Loading downloaded skills…", "正在加载已下载技能…"], more: ["Load more", "加载更多"], retry: ["Retry", "重试"], wait: ["Retry in", "重试等待"], seconds: ["seconds", "秒"],
  preview: ["Preview", "预览"], preparing: ["Downloading files for preview…", "正在下载文件以供预览…"], cancel: ["Cancel", "取消"], cancelled: ["Preview cancelled.", "已取消预览。"],
  ready: ["Review the files and provenance before installing.", "请先核对文件与来源信息，再确认安装。"], files: ["Files", "文件"], provenance: ["Provenance", "来源信息"],
  repository: ["Repository", "仓库"], commit: ["Commit", "提交"], license: ["License", "许可证"], unknownLicense: ["Not provided — review upstream terms.", "未提供，请核对上游许可条款。"],
  warnings: ["Warnings", "注意事项"], content: ["Skill content (untrusted text)", "技能内容（不可信文本）"],
  consent: ["I reviewed these files and their source and agree to download this skill. New skills stay disabled; updates keep the saved enable setting.", "我已核对文件及来源，并同意下载此技能。新技能保持未启用；更新保留已保存的启用设置。"],
  install: ["Download reviewed files", "下载已确认的文件"], installing: ["Saving reviewed files…", "正在保存已确认的文件…"], installed: ["Downloaded. Review the enable settings below.", "已下载。请核对下方启用设置。"],
  close: ["Close preview", "关闭预览"], enabled: ["Enabled for next reload", "下次重载时启用"], disabled: ["Disabled", "未启用"],
  enabledGroup: ["Downloaded skills and enable settings", "已下载技能与启用设置"], read: ["Read files", "查看文件"], update: ["Preview update", "预览更新"], remove: ["Remove", "移除"],
  removeTitle: ["Remove this downloaded skill?", "移除此已下载技能？"], removeHint: ["Its library entry and enable setting will be removed. Locally modified files may be preserved; review any result warnings.", "将移除库记录及启用设置。本地修改过的文件可能会保留，请核对操作结果中的提示。"], removed: ["Skill removed.", "技能已移除。"],
  pending: ["Changes saved. Runtime reload pending; enabled settings are not yet confirmed loaded.", "更改已保存，等待运行时重载；尚未确认启用设置已加载。"],
  applied: ["Runtime reloaded with the saved skill settings.", "运行时已重载并加载保存的技能设置。"], reload: ["Reload when idle", "空闲时重载"],
  failed: ["Skill service is not connected. Restart the download service, then retry.", "Skill 下载服务尚未连接，请重启下载服务后重试。"], selected: ["Selected", "已选中"],
  reconnect: ["Reconnect download service", "重新连接下载服务"], reconnecting: ["Connecting download service…", "正在连接下载服务…"],
  reading: ["Reading local files…", "正在读取本地文件…"], saved: ["Enable setting saved.", "启用设置已保存。"], missingUrl: ["Enter a skill or repository URL first.", "请先输入技能或仓库链接。"],
  readingFile: ["Reading file…", "正在读取文件…"],
  bytes: ["bytes", "字节"], error: ["Request failed", "请求失败"], noPreview: ["The source returned no reviewable preview.", "来源未返回可供确认的预览。"],
} as const;
type Word = keyof typeof words;
const sourceNames: Record<string, string> = { skillstore: "skillstore.io", "skills-sh": "skills.sh", skillsmp: "skillsmp.com" };
const catalogIdentity = (entry: Entry) => {
  if (entry.url) return JSON.stringify([entry.source, "url", entry.url]);
  const repository = entry.repoUrl || entry.repository;
  if (repository && entry.id) return JSON.stringify([entry.source, "repository", repository, entry.id]);
  // Without provenance, matching IDs or names cannot establish that two skills are the same.
  return entry;
};

/** Owns only the contents of the parent's empty #pane-skills section. No model API is involved. */
export function setupSkillLibrary(options: Options) {
  const root = document.getElementById("pane-skills");
  if (!root) throw new Error("Skill library requires #pane-skills");
  const t = (key: Word) => words[key][options.language?.().toLowerCase().startsWith("zh") ? 1 : 0];
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const button = (className: string, run: () => void) => {
    const node = make("button", className); node.type = "button"; node.addEventListener("click", run); return node;
  };
  let disposed = false, listGeneration = 0, searchGeneration = 0, detailGeneration = 0;
  let skills: Skill[] = [];
  let selectedId = "", tab: "discover" | "downloaded" = "discover", view: "browse" | "search" = "browse";
  let listing = false, mutation = false, reading = false, opened = false;
  let connectionFailed = false, reconnecting = false;
  let preview: Preview | null = null, localDetail: { skill: Skill; content: string; files: SkillFile[] } | null = null;
  let filePath = "SKILL.md", fileContent = "", fileError = "", fileLoading = false, fileGeneration = 0;
  let jobId: string | null = null, readyJobId: string | null = null, jobStarting = false, jobProgress = "", pollTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const sourceWaits = new Map<SourcePanel, () => void>();
  const requests = new Map<SourcePanel, Promise<void>>();
  const newPanels = () => new Map<StoreSource, SourcePanel>(storeSources.map((source) => [source, { source, entries: [], phase: "idle", page: 0, hasMore: false, error: "", retryUntil: 0, request: 0, failedPage: 1 }]));
  const homePanels = newPanels();
  let searchPanels = newPanels();
  let submitted = { source: "all" as Source, query: "" };
  let message: Word = "browseReady", errorText = "", pendingReload = false, applied = false, reloading = false, changeVersion = 0;

  root.classList.add("skill-library");
  const heading = make("h2"), subtitle = make("p", "skill-library-subtitle");
  const tabs = make("div", "skill-library-tabs"); tabs.setAttribute("role", "tablist");
  const discoverTab = button("skill-tab-discover", () => { tab = "discover"; render(); void open(); });
  const downloadedTab = button("skill-tab-downloaded", () => { tab = "downloaded"; render(); void refresh(); });
  discoverTab.setAttribute("role", "tab"); downloadedTab.setAttribute("role", "tab"); tabs.append(discoverTab, downloadedTab);
  const status = make("p", "skill-library-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const retryConnection = button("skill-retry-connection", () => { void reconnect(); });
  const operationWarnings = make("div", "skill-operation-warnings skill-warnings"); operationWarnings.setAttribute("role", "status");
  let resultWarnings: string[] = [];
  const reloadStatus = make("div", "skill-reload-status");
  const reloadText = make("span"), reloadButton = button("skill-reload", () => { void tryReload(); }); reloadStatus.append(reloadText, reloadButton);
  const discover = make("div", "skill-discover"); discover.setAttribute("role", "tabpanel");
  const form = make("form", "skill-search-form");
  const sourceLabel = make("label"), sourceCaption = make("span"), source = make("select", "skill-source");
  for (const value of ["all", "skillstore", "skills-sh", "skillsmp"] as Source[]) { const option = make("option", "", sourceNames[value] || t("all")); option.value = value; source.append(option); }
  sourceLabel.append(sourceCaption, source);
  const query = make("input", "skill-query"); query.type = "search";
  const searchButton = make("button", "skill-search"); searchButton.type = "submit";
  const homeButton = button("skill-home", () => { query.value = ""; void browse(); });
  const storeRefresh = button("skill-refresh-store", () => { void refreshStore(); });
  const viewHeading = make("h3", "skill-view-title");
  form.append(sourceLabel, query, searchButton, homeButton, storeRefresh);
  form.addEventListener("submit", (event) => { event.preventDefault(); void search(); });
  source.addEventListener("change", () => { query.value = ""; void browse(); });
  const urlForm = make("form", "skill-url-form"), url = make("input", "skill-url"); url.type = "url";
  const urlButton = make("button", "skill-preview-url"); urlButton.type = "submit"; urlForm.append(url, urlButton);
  urlForm.addEventListener("submit", (event) => {
    event.preventDefault(); if (!url.value.trim()) { message = "missingUrl"; errorText = ""; render(); return; }
    void startJob({ action: "preview", source: source.value, url: url.value.trim() });
  });
  const sourceErrors = make("div", "skill-source-errors"), results = make("div", "skill-search-results");
  discover.append(form, urlForm, viewHeading, sourceErrors, results);
  const downloaded = make("div", "skill-downloaded"); downloaded.setAttribute("role", "tabpanel");
  const refreshButton = button("skill-refresh", () => { void refresh(); });
  const rows = make("div", "skill-installed-list"); rows.setAttribute("role", "group");
  downloaded.append(refreshButton, rows);
  const jobPanel = make("div", "skill-job"), progress = make("span");
  const cancelJobButton = button("skill-cancel-job", () => { cancelPreview(); message = "cancelled"; errorText = ""; render(); }); jobPanel.append(progress, cancelJobButton);
  const detail = make("section", "skill-detail"); detail.setAttribute("aria-label", t("preview"));
  const detailHeading = make("div", "skill-detail-heading"), detailTitle = make("h3");
  const closeDetail = button("skill-close-detail", () => { if (mutation) return; cancelPreview(); localDetail = null; render(); }); detailHeading.append(detailTitle, closeDetail);
  const description = make("p", "skill-description"), metadata = make("dl", "skill-provenance"), warnings = make("div", "skill-warnings");
  const fileHeading = make("h4"), fileList = make("ul", "skill-files"), contentHeading = make("h4"), content = make("pre", "skill-content");
  const consentLabel = make("label", "skill-consent-label"), consent = make("input", "skill-consent"), consentText = make("span"); consent.type = "checkbox";
  consent.addEventListener("change", () => { installButton.disabled = !consent.checked || mutation || !preview; });
  consentLabel.append(consent, consentText);
  const installButton = button("skill-install", () => { void install(); });
  detail.append(detailHeading, description, metadata, warnings, fileHeading, fileList, contentHeading, content, consentLabel, installButton);
  const confirmation = make("section", "skill-remove-confirm"); confirmation.hidden = true; confirmation.setAttribute("role", "dialog"); confirmation.setAttribute("aria-labelledby", "skill-remove-title");
  const confirmTitle = make("h3"); confirmTitle.id = "skill-remove-title";
  const confirmName = make("p"), confirmHint = make("p");
  let removeTarget: Skill | null = null, removeFocus: HTMLElement | null = null;
  const dismissRemove = () => { removeTarget = null; confirmation.hidden = true; removeFocus?.focus(); };
  const removeCancel = button("skill-remove-cancel", dismissRemove), removeConfirm = button("skill-remove-accept", () => { void remove(); });
  confirmation.addEventListener("keydown", (event) => { if (event.key === "Escape" && !mutation) { event.preventDefault(); event.stopPropagation(); dismissRemove(); } });
  confirmation.append(confirmTitle, confirmName, confirmHint, removeCancel, removeConfirm);
  root.replaceChildren(heading, subtitle, tabs, status, retryConnection, operationWarnings, reloadStatus, discover, downloaded, jobPanel, detail, confirmation);

  const transport = async <T>(data: Record<string, unknown>): Promise<T> => {
    const response = await options.invoke<{ data: T }>("skill_store_action", { text: JSON.stringify({ ...data, kind: "skills" }) });
    if (!response || !Object.prototype.hasOwnProperty.call(response, "data") || response.data == null) throw new Error(t("failed"));
    return response.data;
  };
  const fail = (error: unknown) => {
    if (disposed) return;
    const detail = formatUserError(error);
    connectionFailed = /skill service|skill store service|Skill 商店服务|Node\.js|Node 22|not connected|not authenticated|bridge/i.test(detail);
    errorText = `${t(connectionFailed ? "failed" : "error")} ${detail}`; render();
  };
  const notify = (key: Word) => { message = key; errorText = ""; connectionFailed = false; options.toast?.(t(key)); };
  async function reconnect() {
    if (disposed || reconnecting || mutation) return;
    cancelPreview();
    reconnecting = true; connectionFailed = false; errorText = ""; message = "reconnecting"; render();
    try {
      await options.reconnect?.();
      await Promise.all([refresh(), refreshStore()]);
    } catch (error) {
      connectionFailed = true; errorText = `${t("failed")} ${formatUserError(error)}`;
    } finally { if (!disposed) { reconnecting = false; render(); } }
  }
  const cancelRemote = (id: string) => { void transport({ action: "cancel", jobId: id }).catch(() => {}); };
  function cancelPreview() {
    fileGeneration++; filePath = "SKILL.md"; fileContent = ""; fileError = ""; fileLoading = false;
    detailGeneration++; clearTimeout(pollTimer); pollTimer = undefined;
    if (jobId) cancelRemote(jobId);
    if (readyJobId) cancelRemote(readyJobId);
    jobId = readyJobId = null; jobStarting = false; preview = null; consent.checked = false; jobProgress = "";
  }
  function render() {
    if (disposed) return;
    const panels = visiblePanels();
    const searching = panels.some((panel) => panel.phase === "loading");
    heading.textContent = t("title"); subtitle.textContent = t("subtitle");
    discoverTab.textContent = t("discover"); downloadedTab.textContent = `${t("downloaded")} (${skills.length})`;
    for (const [node, value] of [[discoverTab, "discover"], [downloadedTab, "downloaded"]] as const) {
      node.setAttribute("aria-selected", String(tab === value)); node.tabIndex = tab === value ? 0 : -1;
    }
    discover.hidden = tab !== "discover"; downloaded.hidden = tab !== "downloaded";
    status.textContent = errorText || t(message); status.classList.toggle("is-error", !!errorText);
    retryConnection.textContent = t(reconnecting ? "reconnecting" : "reconnect");
    retryConnection.hidden = !connectionFailed || !options.reconnect;
    retryConnection.disabled = reconnecting || searching || mutation;
    operationWarnings.replaceChildren(); operationWarnings.hidden = !resultWarnings.length;
    if (resultWarnings.length) { operationWarnings.append(make("h4", "", t("warnings"))); for (const warning of resultWarnings) operationWarnings.append(make("p", "", warning)); }
    sourceCaption.textContent = t("source"); source.options[0].textContent = t("all");
    query.placeholder = t("query"); query.setAttribute("aria-label", t("query")); searchButton.textContent = t("search"); searchButton.disabled = false;
    homeButton.textContent = t("home"); homeButton.setAttribute("aria-pressed", String(view === "browse"));
    storeRefresh.textContent = t("refreshStore"); storeRefresh.disabled = searching;
    viewHeading.textContent = view === "browse" ? t("home") : `${t("searchResults")}: ${submitted.query}`;
    url.placeholder = t("url"); url.setAttribute("aria-label", t("url")); urlButton.textContent = t("previewUrl"); urlButton.disabled = mutation;
    refreshButton.textContent = t("refresh"); refreshButton.disabled = listing; rows.setAttribute("aria-label", t("enabledGroup")); rows.setAttribute("aria-busy", String(listing));
    reloadStatus.hidden = !pendingReload && !applied; reloadText.textContent = t(pendingReload ? "pending" : "applied"); reloadButton.textContent = t("reload");
    reloadButton.hidden = !pendingReload || !options.reload; reloadButton.disabled = reloading || mutation;
    results.replaceChildren(); results.setAttribute("aria-busy", String(searching));
    sourceErrors.replaceChildren(); sourceErrors.hidden = true; clearTimeout(retryTimer); retryTimer = undefined;
    let waiting = false;
    for (const panel of panels) {
      const section = make("section", "skill-source-panel"); section.dataset.source = panel.source; section.dataset.state = panel.phase;
      section.setAttribute("aria-label", sourceNames[panel.source]); section.setAttribute("aria-busy", String(panel.phase === "loading"));
      const header = make("div", "skill-source-heading"), title = make("h4", "", sourceNames[panel.source]);
      const connection = make("span", `skill-source-state is-${panel.phase}`, t(panel.phase === "loading" ? "browsing" : panel.phase === "connected" ? "connected" : panel.phase === "error" ? "error" : "sourceIdle"));
      header.append(title, connection); section.append(header);
      if (panel.error) {
        const seconds = Math.max(0, Math.ceil((panel.retryUntil - Date.now()) / 1000));
        const row = make("div", "skill-source-error"); row.setAttribute("role", "status");
        const text = make("span", "", `${panel.error}${seconds ? ` · ${t("wait")} ${seconds} ${t("seconds")}` : ""}`);
        const retry = button("skill-source-retry", () => { void requestSource(panel, view, panel.failedPage, true); });
        retry.textContent = t("retry"); retry.disabled = panel.phase === "loading" || seconds > 0;
        row.append(text, retry); section.append(row); waiting ||= seconds > 0;
      }
      const cards = make("div", "skill-source-cards");
      for (const entry of panel.entries) {
        const card = make("article", "skill-result"), name = make("h3", "", entry.name), summary = make("p", "", entry.description || "");
        const origin = make("p", "skill-result-source", sourceNames[entry.source] || entry.source);
        const info = [entry.author ? `${t("author")}: ${entry.author}` : "", entry.repository || entry.repoUrl || "", typeof entry.stars === "number" ? `${t("stars")}: ${entry.stars.toLocaleString()}` : "", typeof entry.installs === "number" ? `${t("installs")}: ${entry.installs.toLocaleString()}` : ""].filter(Boolean);
        const metadata = make("p", "skill-result-metadata", info.join(" · "));
        const open = button("skill-preview-entry", () => { void startJob({ action: "preview", source: entry.source, url: entry.url, entry }); });
        open.textContent = t("details"); open.disabled = mutation; card.append(name, summary, origin, metadata, open); cards.append(card);
      }
      if (!panel.entries.length) cards.append(make("p", "skill-empty", t(panel.phase === "loading" ? "browsing" : panel.phase === "idle" ? "sourceIdle" : view === "search" ? "noResults" : "sourceEmpty")));
      section.append(cards);
      const more = button("skill-load-more", () => { void requestSource(panel, view, panel.page + 1, false); });
      more.textContent = t("more"); more.hidden = !panel.hasMore; more.disabled = panel.phase === "loading" || !!panel.error; more.dataset.source = panel.source;
      section.append(more); results.append(section);
    }
    if (waiting) retryTimer = setTimeout(() => { if (!disposed) render(); }, 1000);
    rows.replaceChildren();
    for (const skill of skills) {
      const row = make("div", "skill-installed-row"); row.dataset.skillId = skill.id; row.classList.toggle("is-selected", skill.id === selectedId);
      const select = button("skill-select", () => { selectedId = skill.id; render(); });
      select.textContent = skill.name || skill.id; select.setAttribute("aria-pressed", String(skill.id === selectedId));
      const enableLabel = make("label", "skill-enable-label"), toggle = make("input", "skill-enable"); toggle.type = "checkbox"; toggle.checked = !!skill.enabled; toggle.disabled = mutation;
      toggle.setAttribute("aria-label", `${t("enabled")}: ${skill.name || skill.id}`);
      toggle.addEventListener("change", () => { void enable(skill, toggle.checked); }); enableLabel.append(toggle, make("span", "", t(skill.enabled ? "enabled" : "disabled")));
      const read = button("skill-read", () => { selectedId = skill.id; void readSkill(skill); }); read.textContent = t("read"); read.disabled = mutation;
      const update = button("skill-update", () => { selectedId = skill.id; void startJob({ action: "update", id: skill.id }); }); update.textContent = t("update"); update.disabled = mutation;
      const remove = button("skill-remove", () => {
        if (disposed || mutation) return; removeTarget = skill; removeFocus = remove; confirmName.textContent = skill.name || skill.id; confirmation.hidden = false; removeCancel.focus();
      }); remove.textContent = t("remove"); remove.disabled = mutation;
      row.append(select, enableLabel, read, update, remove); rows.append(row);
    }
    if (!skills.length) rows.append(make("p", "skill-empty", t(listing ? "loading" : "empty")));
    jobPanel.hidden = !jobStarting && !jobId; progress.textContent = `${t("preparing")}${jobProgress ? ` ${jobProgress}` : ""}`;
    cancelJobButton.textContent = t("cancel"); cancelJobButton.disabled = mutation;
    detail.hidden = !preview && !localDetail; closeDetail.textContent = t("close"); closeDetail.disabled = mutation;
    detail.setAttribute("aria-label", t("preview"));
    const current = preview || localDetail?.skill;
    if (current) {
      detailTitle.textContent = current.name || current.id; description.textContent = current.description || ""; metadata.replaceChildren();
      const meta = (label: string, value: string | undefined) => { metadata.append(make("dt", "", label), make("dd", "", value || "—")); };
      meta(t("source"), sourceNames[current.source || ""] || current.source); meta("URL", current.url); meta(t("repository"), current.repoUrl);
      meta(t("commit"), current.commit); meta("SHA-256", current.hash || ("treeHash" in current ? current.treeHash : undefined)); meta(t("license"), current.license || t("unknownLicense"));
      warnings.replaceChildren();
      if (preview?.warnings?.length) { warnings.append(make("h4", "", t("warnings"))); for (const warning of preview.warnings) warnings.append(make("p", "", warning)); }
      fileHeading.textContent = `${t("files")}${preview ? ` (${preview.totalBytes} ${t("bytes")})` : ""}`; fileList.replaceChildren();
      for (const file of preview?.files || localDetail?.files || []) {
        const row = make("li"), open = button("skill-file", () => { void readFile(file.path); });
        open.dataset.path = file.path; open.textContent = `${file.path} · ${file.size} ${t("bytes")}`;
        open.setAttribute("aria-pressed", String(file.path === filePath)); open.disabled = mutation;
        row.append(open); fileList.append(row);
      }
      contentHeading.textContent = `${t("content")} · ${filePath}`;
      content.textContent = fileLoading ? t("readingFile") : fileError || (filePath === "SKILL.md" ? preview?.content ?? localDetail?.content ?? "" : fileContent);
      content.classList.toggle("is-error", Boolean(fileError));
      content.setAttribute("aria-busy", String(fileLoading));
    }
    consentText.textContent = t("consent"); consentLabel.hidden = installButton.hidden = !preview; consent.disabled = mutation;
    installButton.textContent = t(mutation && preview ? "installing" : "install"); installButton.disabled = !preview || !consent.checked || mutation;
    confirmTitle.textContent = t("removeTitle"); confirmHint.textContent = t("removeHint"); removeCancel.textContent = t("cancel"); removeConfirm.textContent = t("remove");
    removeCancel.disabled = removeConfirm.disabled = mutation;
  }

  async function refresh() {
    if (disposed) return false;
    const generation = ++listGeneration; listing = true; render();
    try {
      const value = await transport<{ skills: Skill[]; revision?: unknown }>({ action: "list" });
      if (disposed || generation !== listGeneration) return false;
      if (!Array.isArray(value.skills)) throw new Error(t("failed"));
      skills = value.skills; if (!skills.some((item) => item.id === selectedId)) selectedId = skills[0]?.id || "";
      errorText = ""; connectionFailed = false;
      return true;
    } catch (error) { if (!disposed && generation === listGeneration) fail(error); return false; }
    finally { if (!disposed && generation === listGeneration) { listing = false; render(); } }
  }
  function visiblePanels() {
    const panels = view === "browse" ? homePanels : searchPanels;
    return storeSources.filter((item) => source.value === "all" || source.value === item).map((item) => panels.get(item)!);
  }
  function discardSearch() {
    searchGeneration++;
    for (const panel of searchPanels.values()) sourceWaits.get(panel)?.();
  }
  async function open() {
    if (disposed) return;
    if (opened) { await Promise.all([...requests.values()]); return; }
    opened = true;
    // Local inventory and each storefront load independently; no slow source gates another.
    await Promise.all([refresh(), ...storeSources.map((item) => requestSource(homePanels.get(item)!, "browse", 1, false))]);
  }
  async function browse() {
    if (disposed) return;
    discardSearch(); view = "browse"; message = "browseReady"; errorText = ""; render();
    await Promise.all(visiblePanels().map((panel) => panel.phase === "idle" ? requestSource(panel, "browse", 1, false) : requests.get(panel)));
  }
  async function refreshStore() {
    if (disposed) return;
    errorText = "";
    await Promise.all(visiblePanels().map((panel) => requestSource(panel, view, 1, true)));
  }
  async function search() {
    if (disposed) return;
    if (!query.value.trim()) { await browse(); return; }
    discardSearch(); submitted = { source: source.value as Source, query: query.value.trim() };
    searchPanels = newPanels(); view = "search"; message = "searchResults"; errorText = ""; render();
    await Promise.all(visiblePanels().map((panel) => requestSource(panel, "search", 1, false)));
  }
  function requestSource(panel: SourcePanel, mode: "browse" | "search", page: number, force: boolean): Promise<void> {
    if (disposed) return Promise.resolve();
    if (panel.phase === "loading") {
      if (!force) return requests.get(panel) || Promise.resolve();
      panel.request++; sourceWaits.get(panel)?.();
    }
    const generation = searchGeneration, request = ++panel.request, queryText = submitted.query;
    panel.phase = "loading"; panel.error = ""; panel.retryUntil = 0; panel.failedPage = page; render();
    const current = () => !disposed && request === panel.request && (mode === "browse" || generation === searchGeneration);
    const pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await new Promise<SearchResult>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(t("timeout"))), sourceRequestTimeout);
          sourceWaits.set(panel, () => reject(new Error("Request superseded")));
          const data = mode === "browse" ? { action: "browse", source: panel.source, page, refresh: force } : { action: "search", source: panel.source, query: queryText, page, refresh: force };
          void transport<SearchResult>(data).then(resolve, reject);
        });
        if (!current()) return;
        if (!Array.isArray(result.entries) || !Array.isArray(result.sources)) throw new Error(t("failed"));
        const status = result.sources.find((item) => item.source === panel.source);
        if (status && !status.ok) {
          panel.retryUntil = Date.now() + Math.max(0, status.retryAfter || 0) * 1000;
          throw new Error(status.error || t("error"));
        }
        const incoming = result.entries.filter((entry) => entry.source === panel.source);
        panel.entries = [...new Map((page === 1 ? incoming : [...panel.entries, ...incoming]).map((entry) => [catalogIdentity(entry), entry])).values()];
        panel.page = Number.isFinite(result.page) && result.page > 0 ? result.page : page;
        panel.hasMore = !!result.hasMore; panel.phase = "connected"; panel.error = "";
      } catch (error) {
        if (!current()) return;
        panel.phase = "error"; panel.error = formatUserError(error);
        if (/skill service|skill store service|Skill 商店服务|Node\.js|Node 22|not connected|not authenticated|bridge|尚未连接|disabled|desktop|browser/i.test(panel.error)) connectionFailed = true;
      } finally {
        clearTimeout(timer);
        if (request === panel.request) { sourceWaits.delete(panel); requests.delete(panel); }
        if (current()) render();
      }
    })();
    requests.set(panel, pending); return pending;
  }
  async function startJob(data: Record<string, unknown>) {
    if (disposed || mutation) return;
    cancelPreview(); localDetail = null; reading = false; const generation = detailGeneration;
    jobStarting = true; message = "preparing"; errorText = ""; render();
    try {
      const result = await transport<{ jobId: string }>(data);
      if (disposed || generation !== detailGeneration) { if (result.jobId) cancelRemote(result.jobId); return; }
      if (!result.jobId) throw new Error(t("noPreview"));
      jobId = result.jobId; jobStarting = false; render(); await poll(result.jobId, generation);
    } catch (error) { if (!disposed && generation === detailGeneration) { jobStarting = false; jobId = null; fail(error); } }
  }
  async function poll(id: string, generation: number) {
    if (disposed || generation !== detailGeneration) return;
    try {
      const job = await transport<Job>({ action: "job", jobId: id });
      if (disposed || generation !== detailGeneration) return;
      if (job.state === "running") {
        const value = job.progress;
        const info = value && typeof value === "object" ? value as { phase?: string; message?: string; files?: number; totalFiles?: number; completed?: number; total?: number; bytes?: number; totalBytes?: number } : null;
        const totalFiles = info?.totalFiles ?? info?.total;
        jobProgress = typeof value === "number" ? `${Math.round(value * (value <= 1 ? 100 : 1))}%` : typeof value === "string" ? value : info
          ? [info.message || info.phase, totalFiles ? `${info.files ?? info.completed ?? 0}/${totalFiles}` : "", info.totalBytes ? `${info.bytes === undefined ? info.totalBytes : `${info.bytes}/${info.totalBytes}`} ${t("bytes")}` : ""].filter(Boolean).join(" · ") : "";
        render(); pollTimer = setTimeout(() => { void poll(id, generation); }, 400); return;
      }
      jobId = null; jobStarting = false;
      if (job.state === "cancelled") { message = "cancelled"; render(); return; }
      if (job.state !== "ready" || !job.preview?.token || !job.preview.hash || !Array.isArray(job.preview.files)) throw new Error(job.error || t("noPreview"));
      readyJobId = id; preview = job.preview; consent.checked = false; message = "ready"; errorText = ""; render();
    } catch (error) { if (!disposed && generation === detailGeneration) { jobId = null; jobStarting = false; fail(error); } }
  }
  async function readSkill(skill: Skill) {
    if (disposed || mutation) return;
    cancelPreview(); localDetail = null; reading = true; const generation = detailGeneration; message = "reading"; errorText = ""; render();
    try {
      const value = await transport<{ skill: Skill; content: string; files: SkillFile[] }>({ action: "read", id: skill.id });
      if (disposed || generation !== detailGeneration) return;
      localDetail = value; message = "read";
    } catch (error) { if (!disposed && generation === detailGeneration) fail(error); }
    finally { if (!disposed && generation === detailGeneration) { reading = false; render(); } }
  }
  async function readFile(path: string) {
    if (disposed || mutation || (!preview && !localDetail)) return;
    const generation = ++fileGeneration, detailVersion = detailGeneration;
    filePath = path; fileContent = ""; fileError = ""; fileLoading = path !== "SKILL.md"; render();
    if (!fileLoading) return;
    const request = preview
      ? { action: "preview_read", token: preview.token, hash: preview.hash, path }
      : { action: "read", id: localDetail!.skill.id, path };
    try {
      const result = await transport<{ content: string }>(request);
      if (disposed || generation !== fileGeneration || detailVersion !== detailGeneration) return;
      fileContent = result.content;
    } catch (error) {
      if (disposed || generation !== fileGeneration || detailVersion !== detailGeneration) return;
      fileError = formatUserError(error);
    } finally {
      if (!disposed && generation === fileGeneration && detailVersion === detailGeneration) { fileLoading = false; render(); }
    }
  }
  function beginMutation() {
    // A snapshot requested before this write must not restore old enable flags or removed rows.
    listGeneration++; listing = false; mutation = true;
  }
  function savedChange() { listGeneration++; listing = false; pendingReload = true; applied = false; changeVersion++; }
  async function tryReload() {
    if (disposed || !pendingReload || !options.reload || reloading) return;
    const version = changeVersion; reloading = true; render();
    try {
      await options.reload();
      if (disposed || version !== changeVersion) return;
      pendingReload = false; applied = true; errorText = "";
    } catch (error) {
      if (!disposed && version === changeVersion) errorText = formatUserError(error);
    }
    finally { if (!disposed) { reloading = false; render(); } }
  }
  async function install() {
    if (disposed || mutation || !preview || !consent.checked) return;
    const reviewed = preview; beginMutation(); message = "installing"; errorText = ""; render();
    try {
      const value = await transport<Skill | { skill: Skill; warnings?: string[] }>({ action: "install", token: reviewed.token, hash: reviewed.hash, accepted: true });
      if (disposed) return;
      resultWarnings = "warnings" in value && Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === "string") : [];
      const skill = "skill" in value ? value.skill : value;
      selectedId = skill.id; readyJobId = null; preview = null; consent.checked = false; tab = "downloaded"; savedChange(); notify("installed"); await refresh();
    } catch (error) { if (!disposed) fail(error); }
    finally { if (!disposed) { mutation = false; render(); void tryReload(); } }
  }
  async function enable(skill: Skill, enabled: boolean) {
    if (disposed || mutation) return;
    beginMutation(); errorText = ""; render();
    try {
      const result = await transport<{ enabled: boolean; reloadRequired: boolean }>({ action: "enable", id: skill.id, enabled });
      if (disposed) return;
      skills = skills.map((item) => item.id === skill.id ? { ...item, enabled: result.enabled } : item); savedChange(); notify("saved");
    } catch (error) { if (!disposed) fail(error); }
    finally { if (!disposed) { mutation = false; render(); void tryReload(); } }
  }
  async function remove() {
    if (disposed || mutation || !removeTarget) return;
    const target = removeTarget; cancelPreview(); localDetail = null; beginMutation(); render();
    try {
      const result = await transport<{ warnings?: string[] }>({ action: "remove", id: target.id, accepted: true });
      if (disposed) return;
      resultWarnings = Array.isArray(result.warnings) ? result.warnings.filter((item): item is string => typeof item === "string") : [];
      dismissRemove();
      savedChange(); notify("removed"); await refresh();
    } catch (error) { if (!disposed) fail(error); }
    finally { if (!disposed) { mutation = false; render(); void tryReload(); } }
  }
  // Left/right keyboard navigation stays within the two library tabs.
  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault(); tab = tab === "discover" ? "downloaded" : "discover"; render(); (tab === "discover" ? discoverTab : downloadedTab).focus();
    if (tab === "downloaded") void refresh(); else void open();
  });
  render();
  return {
    refresh,
    open,
    preload: open,
    refreshLanguage() { render(); },
    dispose() {
      if (disposed) return;
      disposed = true; listGeneration++; searchGeneration++; detailGeneration++;
      clearTimeout(pollTimer); clearTimeout(retryTimer);
      for (const stop of sourceWaits.values()) stop();
      sourceWaits.clear(); requests.clear();
      // A committed install is never cancelled; only an outstanding preview download is.
      if (!mutation) {
        if (jobId) cancelRemote(jobId);
        if (readyJobId) cancelRemote(readyJobId);
      }
      jobId = readyJobId = null;
      root.replaceChildren(); root.classList.remove("skill-library");
    },
  };
}
