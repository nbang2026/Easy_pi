import { icon } from "./icons.ts";
import { formatUserError } from "./utils.ts";
import { compareVersions, parseReleaseManifest, type ReleaseManifest } from "./release-manifest.ts";
type Check = { name: string; ok: boolean; detail: string };
type Health = { checkedAt: number; version: string; checks: Check[] };
export type PiCoreUpdate = { status: "unchecked" | "unavailable" | "checking" | "disabled" | "available" | "current" | "error";
  currentVersion: string; latestVersion: string; checkedAt: number; runtimeKind: "bundled" | "external" | "unknown"; error?: string };
export function normalizePiCoreUpdate(value: unknown): PiCoreUpdate | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, unknown>;
  if (!["unchecked", "unavailable", "checking", "disabled", "available", "current", "error"].includes(data.status as string)) return;
  const version = (item: unknown) => {
    if (typeof item !== "string" || item !== item.trim() || item.length > 64) return "";
    const match = item.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9a-z-]+(?:\.[0-9a-z-]+)*))?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i);
    return match && !match[4]?.split(".").some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === "0") ? item : "";
  };
  const currentVersion = version(data.currentVersion), latestVersion = version(data.latestVersion);
  if (data.status === "available" && (!currentVersion || !latestVersion || compareVersions(latestVersion.split("+")[0], currentVersion.split("+")[0]) <= 0)) return;
  return { status: data.status as PiCoreUpdate["status"], currentVersion, latestVersion,
    checkedAt: typeof data.checkedAt === "number" && Number.isFinite(data.checkedAt) && data.checkedAt >= 0 ? data.checkedAt : 0,
    runtimeKind: data.runtimeKind === "bundled" || data.runtimeKind === "external" ? data.runtimeKind : "unknown",
    error: ["network", "timeout", "invalid"].includes(data.error as string) ? data.error as string : undefined };
}
export function setupSystemSettings(options: {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>; language(): string;
  checkPiUpdate?(): Promise<unknown>;
  openPiUpdates?(): void;
  notice?(message: string, duration?: number): void;
}) {
  const pane = document.getElementById("pane-system")!;
  const text = (zh: string, en: string) => options.language() === "en" ? en : zh;
  let disposed = false, pending = 0, languagePending = false, health: Health | undefined, manifest: ReleaseManifest | undefined;
  let queue = Promise.resolve();
  let piUpdate: PiCoreUpdate | undefined;
  const updateNotice = document.getElementById("pi-update-notice") as HTMLButtonElement | null;
  const notified = new Set<string>();
  const openPiUpdates = () => options.openPiUpdates?.();
  updateNotice?.addEventListener("click", openPiUpdates);
  const el = <T extends HTMLElement>(id: string) => pane.querySelector<T>(`#${id}`)!;
  const renderPiUpdate = () => {
    const available = piUpdate?.status === "available";
    if (updateNotice) {
      updateNotice.hidden = !available;
      updateNotice.title = available ? `${text("Pi 核心有更新", "Pi core update available")}: ${piUpdate!.currentVersion} → ${piUpdate!.latestVersion}` : text("Pi 核心更新", "Pi core updates");
      updateNotice.setAttribute("aria-label", updateNotice.title);
    }
    el("pi-core-version").textContent = `${text("Pi 当前版本", "Installed Pi")}: ${piUpdate?.currentVersion || "—"} · ${text("最新版本", "Latest")}: ${piUpdate?.latestVersion || "—"}`;
    const messages: Record<string, string> = {
      unchecked: text("Pi 启动后会在后台检查更新。", "Pi checks for updates in the background after startup."),
      unavailable: text("尚未识别 Pi 核心版本，不会将 App 版本当作 Pi 版本。", "Pi core version is unavailable; the app version is not used as the Pi version."),
      checking: text("正在检查 Pi 官方版本信息，不影响当前任务…", "Checking official Pi version metadata without interrupting your task…"),
      disabled: text("离线模式或 Pi 禁用版本检查时，不会联网检查更新。", "Update checks are disabled by Pi offline/version-check settings."),
      available: text("有新的 Pi 核心版本可用。", "A newer Pi core version is available."),
      current: text("没有更新的 Pi 版本。", "No newer Pi version is available."),
      error: piUpdate?.error === "timeout" ? text("检查超时，可稍后重试；当前任务不受影响。", "Update check timed out. Retry later; your task is unaffected.") :
        piUpdate?.error === "invalid" ? text("官方版本信息格式异常，未显示更新提示。", "Official version metadata was invalid; no update is recommended.") :
        text("暂时无法获取官方版本信息，可稍后重试。", "Official version information is temporarily unavailable. Try again later."),
    };
    el("pi-update-status").textContent = piUpdate ? messages[piUpdate.status] : text("Pi 连接后会自动检查；这里只检查 Pi 核心，不是 easy_pi 应用更新。", "Checks start when Pi connects. This is for Pi core, not easy_pi app updates.");
    el("pi-update-instructions").textContent = !available ? "" : piUpdate?.runtimeKind === "bundled"
      ? text("当前 Pi 随应用内置，请通过新版 easy_pi 更新。不会直接修改内置环境。", "This Pi is bundled with the app. Update through a new easy_pi release; bundled files will not be modified.")
      : text("可在系统终端执行 pi update，完成后重新启动 Pi。这里只提供提示，不会自动执行升级。", "Run pi update in your system terminal, then restart Pi. This notice never runs the upgrade automatically.");
    el("pi-update-copy").hidden = !available || piUpdate?.runtimeKind !== "external";
    el("pi-update-source").textContent = `${text("版本信息与更新说明", "Official release information")}: https://pi.dev/changelog`;
  };
  const observePiUpdate = (value: unknown) => {
    if (disposed) return;
    const parsed = normalizePiCoreUpdate(value);
    if (!parsed) return;
    piUpdate = parsed; renderPiUpdate(); syncBusy();
    if (parsed.status !== "available" || !options.notice || notified.has(parsed.latestVersion)) return;
    notified.add(parsed.latestVersion);
    try {
      if (window.localStorage.getItem("pi.coreUpdate.notified") === parsed.latestVersion) return;
      window.localStorage.setItem("pi.coreUpdate.notified", parsed.latestVersion);
    } catch { /* In-memory deduplication still prevents repeated notices. */ }
    options.notice(`${text("Pi 核心有更新", "Pi core update available")}: ${parsed.currentVersion} → ${parsed.latestVersion}。${text("可在设置 → 版本与检查查看。", "See Settings → Version & checks.")}`, 8000);
  };
  const render = () => {
    el("system-version").textContent = `${text("当前版本", "Installed")}: ${health?.version || "—"}`;
    const list = el("system-checks"); list.replaceChildren();
    for (const check of health?.checks || []) {
      const row = document.createElement("div"); row.className = `diagnostic-row ${check.ok ? "ok" : "warning"}`;
      const name = document.createElement("strong"); name.textContent = check.name;
      const detail = document.createElement("small"); detail.textContent = check.detail;
      const body = document.createElement("div"); body.append(name, detail); row.append(icon(check.ok ? "check" : "circle-alert"), body); list.append(row);
    }
    if (manifest) {
      const comparison = health ? compareVersions(manifest.version, health.version) : undefined;
      el("system-release").textContent = `${manifest.version} · ${comparison === undefined ? text("请先检查环境", "Check environment first") :
        comparison > 0 ? text("有更新版本", "Newer version") : comparison < 0 ? text("早于当前版本", "Older version") : text("与当前版本相同", "Same version")}\n${manifest.artifacts.map(item => `${item.platform} ${item.arch} · ${item.name}`).join("\n")}`;
    }
    renderPiUpdate();
  };
  const syncBusy = () => {
    pane.setAttribute("aria-busy", String(pending > 0));
    pane.querySelectorAll<HTMLInputElement | HTMLButtonElement>("#system-settings-content input, #system-settings-content button")
      .forEach(control => { control.disabled = pending > 0; });
    el<HTMLButtonElement>("pi-update-check").disabled = pending > 0 || !options.checkPiUpdate || piUpdate?.status === "checking";
  };
  const operation = (fn: () => Promise<void>) => {
    if (disposed) return Promise.resolve();
    if (pending >= 8) {
      el("system-message").textContent = text("等待中的操作过多，请稍后重试。", "Too many pending operations. Try again shortly.");
      return Promise.resolve();
    }
    pending++; syncBusy();
    const result = queue.then(async () => {
      try { if (!disposed) await fn(); }
      catch (error) { if (!disposed) el("system-message").textContent = formatUserError(error); }
      finally {
        pending--;
        if (!disposed) {
          if (!pending && languagePending) {
            const message = el("system-message").textContent;
            languagePending = false; build(); el("system-message").textContent = message;
          }
          syncBusy();
        }
      }
    });
    queue = result.catch(() => {});
    return result;
  };
  const refresh = () => operation(async () => {
    const result = await options.invoke<Health>("run_diagnostics");
    if (disposed) return; health = result; render();
    el("system-message").textContent = text("检查完成", "Checks complete");
  });
  const build = () => {
    pane.querySelector("#system-settings-content")!.innerHTML = `<div class="section-heading"><h3>${text("版本与检查", "Version & checks")}</h3><button id="system-refresh" type="button" class="icon-button"></button></div>
      <p id="system-version"></p><div id="system-checks"></div>
      <section class="pi-core-update-section">
        <div class="section-heading"><h4>${text("Pi 核心更新", "Pi core updates")}</h4><button id="pi-update-check" type="button">${text("检查更新", "Check for updates")}</button></div>
        <p id="pi-core-version"></p><p id="pi-update-status" class="settings-hint" role="status"></p>
        <p id="pi-update-instructions" class="settings-hint"></p>
        <div class="settings-options"><button id="pi-update-copy" type="button" hidden>${text("复制更新命令", "Copy update command")}</button></div>
        <p id="pi-update-source" class="settings-hint"></p>
      </section>
      <div class="settings-options"><button id="system-export" type="button">${text("导出检查结果", "Export checks")}</button><label class="settings-file-label">${text("导入版本清单", "Import release manifest")}<input id="system-manifest" type="file" accept=".json" /></label></div>
      <pre id="system-release" class="system-release"></pre>
      <label class="harness-field">${text("核对安装包", "Verify package")}<input id="system-package" type="file" accept=".zip,.dmg,.msi,.exe" /></label>
      <p class="settings-hint">${text("安装包按清单核对 SHA-256。清单与安装包的发布者仍需确认；当前尚未配置在线更新源。", "Package checks use manifest SHA-256. Publisher authenticity must still be verified; no online update feed is configured.")}</p>
      <p id="system-message" class="settings-hint" role="status"></p>`;
    el("system-refresh").append(icon("refresh-cw")); el("system-refresh").title = text("检查环境", "Check environment");
    el("system-refresh").setAttribute("aria-label", text("检查环境", "Check environment"));
    el("system-refresh").addEventListener("click", () => { void refresh(); });
    el("pi-update-check").addEventListener("click", () => { void operation(async () => {
      if (!options.checkPiUpdate) return;
      const result = await options.checkPiUpdate();
      if (disposed) return;
      if (!normalizePiCoreUpdate(result)) throw Error(text("Pi 未返回有效的版本信息，请确认 Pi 已连接。", "Pi did not return valid version information. Check the Pi connection."));
      observePiUpdate(result);
    }); });
    el("pi-update-copy").addEventListener("click", () => { void operation(async () => {
      if (piUpdate?.status !== "available" || piUpdate.runtimeKind !== "external") return;
      if (!window.navigator.clipboard?.writeText) throw Error(text("无法访问剪贴板，请在系统终端输入 pi update。", "Clipboard unavailable. Enter pi update in your system terminal."));
      await window.navigator.clipboard.writeText("pi update");
      if (!disposed) el("system-message").textContent = text("已复制 pi update；尚未执行升级。", "Copied pi update; no upgrade was executed.");
    }); });
    el("system-export").addEventListener("click", () => { void operation(async () => {
      if (!health) throw Error(text("请先检查环境", "Check environment first"));
      const safe = { version: health.version, checkedAt: health.checkedAt,
        checks: health.checks.map(({ name, ok }) => ({ name, ok })) };
      const path = await options.invoke<string>("export_usage_log", { format: "json", text: JSON.stringify({ type: "easy_pi-health", ...safe }, null, 2) });
      if (!disposed) {
        const filename = typeof path === "string" ? path.split(/[\\/]/).pop() || path : "";
        el("system-message").textContent = `${text("已导出", "Exported")}: ${filename || text("下载目录", "Downloads folder")}`;
      }
    }); });
    el<HTMLInputElement>("system-manifest").addEventListener("change", event => {
      const input = event.currentTarget as HTMLInputElement, file = input.files?.[0]; input.value = "";
      if (!file) return;
      void operation(async () => {
        manifest = undefined; el("system-release").textContent = "";
        if (file.size > 65536) throw Error(text("版本清单过大", "Manifest too large"));
        const result = parseReleaseManifest(await file.text());
        if (disposed) return; manifest = result; render(); el("system-message").textContent = "";
      });
    });
    el<HTMLInputElement>("system-package").addEventListener("change", event => {
      const input = event.currentTarget as HTMLInputElement, file = input.files?.[0]; input.value = "";
      if (!file) return;
      void operation(async () => {
        const artifact = manifest?.artifacts.find(item => item.name === file.name);
        if (!artifact) throw Error(text("请导入包含此文件的版本清单", "Import a manifest containing this file"));
        if (file.size !== artifact.bytes) throw Error(text("文件大小不匹配", "File size mismatch"));
        if (file.size > 256 * 1024 * 1024) throw Error(text("超过 256 MiB，请使用系统工具核验 SHA-256", "Over 256 MiB; verify SHA-256 with system tools"));
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        if (hash !== artifact.sha256) throw Error(text("校验失败，请勿安装此文件", "Checksum mismatch; do not install"));
        if (!disposed) el("system-message").textContent = text("文件与清单一致；仍需核对发布者签名", "File matches manifest; publisher signature still requires verification");
      });
    });
    render(); syncBusy();
  };
  build();
  return { refresh, observePiUpdate, refreshLanguage() {
    if (disposed) return;
    if (pending) languagePending = true;
    else { const message = el("system-message").textContent; build(); el("system-message").textContent = message; }
  }, dispose() { disposed = true; updateNotice?.removeEventListener("click", openPiUpdates); } };
}
