import "@xterm/xterm/css/xterm.css";
import "./style.css";
import "./workbench.css";
import { Channel } from "@tauri-apps/api/core";
import { invoke as bridgeInvoke, isDesktop } from "./bridge";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { icon, renderIcons } from "./icons";
import { UI_STRINGS } from "./ui-strings";
import { clampNumber, isHttpUrl, normalizeSendMode, parseLanguagePack } from "./utils";
import { normalizeWallpaperInk, wallpaperFontSize, wallpaperUiSize, wallpaperTheme } from "./wallpaper-appearance";
import { createOutputBatcher, createSizeReporter } from "./terminal-flow";
import { createRendererController } from "./terminal-renderer";
import { setupWorkbench } from "./workbench";
import { setupSoundSettings } from "./sound-settings";
import { DEFAULT_WALLPAPER_ID, presetInk, setupWallpaperPresets, wallpaperPreset, type WallpaperPreset } from "./wallpaper-presets";
import { setupKeybindingSettings, terminalKeySequence } from "./keybinding-settings";
import { setupLibrarySettings } from "./library-settings";
import { setupAgentMarket } from "./agent-market";
import { bindModelList, renderModelRows, type ModelInfo } from "./model-list";
import { confirmModelRemoval, confirmModelBatch, editModelDialog, type ModelEditInfo } from "./model-dialog";
import { setupModelBulk } from "./model-bulk";

/** Bottom-bar send mode: send (Enter), control (Enter/steer), queue (Alt+Enter follow-up). */
let sendMode: "send" | "control" | "queue" = "send";

/** Extra UI to refresh after a language change (set later). */
let onLanguageChange: (() => void) | null = null;

// —— UI 多语言 ——
const I18N_BUILTIN: Record<string, Record<string, string>> = {
  zh: {
    "title.wallpaperToggle": "切换动态壁纸",
    "title.settings": "设置",
    "title.quickbar": "快捷指令",
    "title.hideCode": "隐藏代码",
    "title.showCode": "显示代码",
    "title.thinking": "模型强度",
    "title.wallpaperOn": "关闭壁纸（保持全黑）",
    "title.wallpaperOff": "开启动态壁纸",
    "quickbar.title": "快捷指令",
    "quickbar.label": "名称",
    "quickbar.cmd": "指令，如 /model",
    "quickbar.add": "＋ 添加快捷指令",
    "quickbar.reset": "↺ 恢复默认快捷指令",
    "quickbar.hint": "单击执行 / 再点返回 · 双击删除 · 右键改绑定",
    "btn.delete": "删除",
    "quickbar.deleteConfirm": "确定删除这条快捷指令？",
    "btn.save": "保存",
    "btn.cancel": "取消",
    "btn.add": "添加",
    "btn.import": "导入",
    "btn.importFile": "导入文件",
    "btn.importLang": "导入语言包",
    "btn.clear": "清除",
    "btn.addRelay": "添加中转站",
    "btn.pickFile": "选择文件…",
    "btn.resetDefault": "恢复默认",
    "sendmode.label": "发送模式",
    "sendmode.send": "发送",
    "sendmode.control": "控制",
    "sendmode.queue": "排队任务",
    "settings.title": "设置",
    "settings.language": "语言",
    "settings.model": "模型",
    "settings.search": "搜索模型…",
    "settings.wallpaper": "动态壁纸",
    "settings.on": "开",
    "settings.off": "关",
    "settings.persona": "导入模型人设",
    "settings.personaWarn": "⚠️ 人设会占用上下文，可能降低使用性能与指令遵循度，请谨慎导入。",
    "settings.personaPh": "在这里粘贴人设/系统提示词…",
    "settings.addModel": "添加模型",
    "settings.importPlugin": "导入插件",
    "settings.relay": "中转站（OpenAI 兼容）",
    "settings.customWallpaper": "自定义壁纸",
    "settings.fontSize": "字体大小",
    "settings.small": "小",
    "settings.medium": "中",
    "settings.large": "大",
    "settings.opacity": "透明度",
    "settings.escDouble": "ESC 双击中断",
    "esc.hint": "再按一次 ESC 中断/关闭",
    "cmd.model": "模型",
    "cmd.new": "新会话",
    "cmd.compact": "压缩上下文",
    "cmd.tree": "会话树",
    "cmd.reload": "重载",
    "cmd.settings": "设置",
    "cmd.trust": "信任目录",
    "cmd.login": "登录",
    "cmd.hotkeys": "快捷键",
    "settings.keybindings": "快捷键设置",
    "settings.keybindSearch": "搜索动作…",
    "settings.keybindHint": "点击右侧按键改键；右键重置；改完执行 /reload 或重启生效。",
    "ph.provider": "供应商，如 ollama",
    "ph.baseurl": "Base URL，如 http://localhost:11434/v1",
    "ph.apikey": "API Key（可留空）",
    "ph.apikey2": "API Key",
    "ph.modelid": "模型 ID，如 qwen2.5-coder:7b",
    "ph.modelname": "显示名称（可选）",
    "ph.pluginSource": "npm:@foo/bar 或 git:… 或 URL 或本地路径",
    "ph.relayName": "供应商名（默认 relay）",
    "ph.relayBaseurl": "地址，如 https://api.xxx.com/v1",
    "ph.relayModels": "模型 ID，多个用逗号分隔",
    "persona.saved": "已保存，执行 /reload 或重启 pi 后生效",
    "persona.cleared": "已清除人设",
    "persona.loaded": "已导入文件内容，记得点保存",
    "lang.importFailed": "语言包导入失败",
  },
  en: {
    "title.wallpaperToggle": "Toggle wallpaper",
    "title.settings": "Settings",
    "title.quickbar": "Quick commands",
    "title.hideCode": "Hide terminal",
    "title.showCode": "Show terminal",
    "title.thinking": "Model effort",
    "title.wallpaperOn": "Turn off wallpaper (keep black)",
    "title.wallpaperOff": "Turn on live wallpaper",
    "quickbar.title": "Quick Commands",
    "quickbar.label": "Label",
    "quickbar.cmd": "Command, e.g. /model",
    "quickbar.add": "+ Add quick command",
    "quickbar.reset": "↺ Restore default commands",
    "quickbar.hint": "Click to run / click again to return · double-click to delete · right-click to rebind",
    "btn.delete": "Delete",
    "quickbar.deleteConfirm": "Delete this quick command?",
    "btn.save": "Save",
    "btn.cancel": "Cancel",
    "btn.add": "Add",
    "btn.import": "Import",
    "btn.importFile": "Import file",
    "btn.importLang": "Import pack",
    "btn.clear": "Clear",
    "btn.addRelay": "Add relay",
    "btn.pickFile": "Choose file…",
    "btn.resetDefault": "Reset",
    "sendmode.label": "Send mode",
    "sendmode.send": "Send",
    "sendmode.control": "Control",
    "sendmode.queue": "Queue task",
    "settings.title": "Settings",
    "settings.language": "Language",
    "settings.model": "Model",
    "settings.search": "Search models…",
    "settings.wallpaper": "Live wallpaper",
    "settings.on": "On",
    "settings.off": "Off",
    "settings.persona": "Import model persona",
    "settings.personaWarn": "⚠️ Personas consume context and can reduce performance and instruction-following. Import with care.",
    "settings.personaPh": "Paste the persona / system prompt here…",
    "settings.addModel": "Add model",
    "settings.importPlugin": "Import plugin",
    "settings.relay": "Relay (OpenAI compatible)",
    "settings.customWallpaper": "Custom wallpaper",
    "settings.fontSize": "Font size",
    "settings.small": "S",
    "settings.medium": "M",
    "settings.large": "L",
    "settings.opacity": "Opacity",
    "settings.escDouble": "Double-ESC to interrupt",
    "esc.hint": "Press ESC again to interrupt/close",
    "cmd.model": "Model",
    "cmd.new": "New session",
    "cmd.compact": "Compact",
    "cmd.tree": "Tree",
    "cmd.reload": "Reload",
    "cmd.settings": "Settings",
    "cmd.trust": "Trust dir",
    "cmd.login": "Login",
    "cmd.hotkeys": "Hotkeys",
    "settings.keybindings": "Keybindings",
    "settings.keybindSearch": "Search actions…",
    "settings.keybindHint": "Click the key to rebind; right-click to reset; run /reload or restart to apply.",
    "ph.provider": "Provider, e.g. ollama",
    "ph.baseurl": "Base URL, e.g. http://localhost:11434/v1",
    "ph.apikey": "API key (optional)",
    "ph.apikey2": "API key",
    "ph.modelid": "Model ID, e.g. qwen2.5-coder:7b",
    "ph.modelname": "Display name (optional)",
    "ph.pluginSource": "npm:@foo/bar or git:… or URL or local path",
    "ph.relayName": "Provider name (default relay)",
    "ph.relayBaseurl": "URL, e.g. https://api.xxx.com/v1",
    "ph.relayModels": "Model IDs, comma separated",
    "persona.saved": "Saved. Run /reload or restart pi to apply.",
    "persona.cleared": "Persona cleared",
    "persona.loaded": "File loaded, remember to save",
    "lang.importFailed": "Failed to import language pack",
  },
};

for (const [lang, strings] of Object.entries(UI_STRINGS)) {
  Object.assign(I18N_BUILTIN[lang], strings);
}

type LangPack = { name: string; strings: Record<string, string> };
const readLangPacks = (): Record<string, LangPack> => {
  try {
    const v = JSON.parse(localStorage.getItem("pi.langPacks") || "{}");
    return v && typeof v === "object" ? (v as Record<string, LangPack>) : {};
  } catch {
    return {};
  }
};
const writeLangPacks = (packs: Record<string, LangPack>) => {
  try {
    localStorage.setItem("pi.langPacks", JSON.stringify(packs));
  } catch {
    /* ignore */
  }
};
let langPacks: Record<string, LangPack> = readLangPacks();
let currentLang = "zh";
try {
  currentLang = localStorage.getItem("pi.lang") || "zh";
} catch {
  /* ignore */
}
const langStrings = (lang: string): Record<string, string> => ({
  ...(I18N_BUILTIN[lang] || {}),
  ...(langPacks[lang]?.strings || {}),
});
const t = (key: string): string => langStrings(currentLang)[key] ?? I18N_BUILTIN.zh[key] ?? key;

async function main() {
  renderIcons();
  const toastEl = document.getElementById("toast")!;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const showToast = (msg: string, ms = 3000) => {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  };
  let sounds: ReturnType<typeof setupSoundSettings> | undefined;
  let connected = false;
  let connecting = false;
  let workbench: ReturnType<typeof setupWorkbench> | undefined;
  let keybinds: ReturnType<typeof setupKeybindingSettings> | undefined;
  let librarySettings: ReturnType<typeof setupLibrarySettings> | undefined;
  let agentMarket: ReturnType<typeof setupAgentMarket> | undefined;
  const invoke = <T = void>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const result = command === "write_terminal" && !connected
      ? Promise.reject(new Error(t(isDesktop ? "ui.disconnected" : "ui.previewOnly")))
      : bridgeInvoke<T>(command, args);
    return result.catch((error) => {
      if (command === "write_terminal") showToast(String(error), 4500);
      throw error;
    });
  };
  const term = new Terminal({
    fontFamily: '"SFMono-Regular", Menlo, Monaco, "PingFang SC", "Microsoft YaHei", monospace',
    fontSize: 14,
    fontWeight: "400",
    fontWeightBold: "700",
    cursorBlink: true,
    // 允许透明画布，这样背后的动态壁纸能透出来
    allowTransparency: true,
    theme: {
      background: "rgba(0, 0, 0, 0)",
      foreground: "#dbe0e4",
      brightWhite: "#ffffff",
      cursor: "#91c6ad",
      selectionBackground: "#4a786660",
      black: "#24282c",
      red: "#dc8d87",
      green: "#95c2a3",
      yellow: "#d6bd8c",
      blue: "#8db2d1",
      magenta: "#b7a1cd",
      cyan: "#8ec6c7",
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById("terminal")!);
  try {
    sounds = setupSoundSettings({ translate: t, terminalCanScroll: (delta) => {
      const buffer = term.buffer.active;
      return buffer.type === "alternate" || (delta < 0 ? buffer.viewportY > 0 : buffer.viewportY < buffer.baseY);
    } });
  } catch { document.getElementById("sound-status")!.textContent = t("sound.audioUnavailable"); }
  fitAddon.fit();
  const workbenchTheme = { ...term.options.theme };
  let outputBatcher = createOutputBatcher((bytes, done) => term.write(bytes, done));

  let lastEscAt = 0;
  term.onData((data) => {
    // ESC 单击只提示，双击才真正中断/关闭（可在设置里关掉）
    if (data === "\x1b" && escDouble) {
      const now = Date.now();
      if (now - lastEscAt < 500) {
        lastEscAt = 0;
        invoke("write_terminal", { data: "\x1b" }).catch(() => {});
      } else {
        lastEscAt = now;
        showToast(t("esc.hint"), 1600);
      }
      return;
    }
    // 排队任务模式：把回车改为 Alt+Enter（pi 的 follow-up，等当前任务做完再执行）
    const out = data === "\r" && sendMode === "queue" ? "\x1b[13;3u" : data;
    invoke("write_terminal", { data: out }).catch(() => {});
  });

  // Coalesce size changes without postponing updates for an entire window drag.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const sizeReporter = createSizeReporter((rows, cols) => invoke("resize_terminal", { rows, cols }));
  const sendResize = () => {
    fitAddon.fit();
    const size = `${term.cols} × ${term.rows}`;
    const label = document.getElementById("terminal-size")!;
    if (label.textContent !== size) label.textContent = size;
    if (connected) sizeReporter.report(term.rows, term.cols);
  };
  const scheduleResize = () => {
    if (resizeTimer !== undefined) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      sendResize();
    }, 32);
  };

  window.addEventListener("resize", scheduleResize);
  // 实时跟踪容器尺寸变化（Tauri webview 的 resize 事件有时不够及时）
  const ro = new ResizeObserver(scheduleResize);
  ro.observe(document.getElementById("terminal")!);
  // 首帧布局可能还没稳定，分几个时间点校准
  const initialFitFrame = requestAnimationFrame(sendResize);
  const initialFitTimers = [setTimeout(sendResize, 300), setTimeout(sendResize, 1000)];
  sendResize();

  // 点击任意位置都把键盘焦点收回终端（pi 的对话框支持鼠标点击选择）
  document.getElementById("terminal")!.addEventListener("mousedown", () => {
    // 注意：这里不取消快捷指令高亮，否则在浮层里点一下就会丢掉状态，
    // 再点快捷按钮就无法正确"回首页"了。
    setTimeout(() => term.focus(), 0);
  });
  term.focus();

  // —— 右上角：壁纸快捷开关 + 设置面板（壁纸 / 字体大小）——
  const wallpaperToggle = document.getElementById("wallpaper-toggle") as HTMLButtonElement;
  const settingsToggle = document.getElementById("settings-toggle") as HTMLButtonElement;
  const settingsPanel = document.getElementById("settings-panel") as HTMLDivElement;
  const wallpaperVideo = document.getElementById("wallpaper") as HTMLVideoElement;

  const readStored = (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const writeStored = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  };

  let wallpaperOn = readStored("pi.wallpaper") === "on";
  let fontSize = clampNumber(readStored("pi.fontSize"), 10, 28, 14);
  let wallpaperFont = wallpaperFontSize(readStored("pi.wallpaperFontSize"));
  let wallpaperUiFont = wallpaperUiSize(readStored("pi.wallpaperUiFontSize"));
  let wallpaperInk = normalizeWallpaperInk(readStored("pi.wallpaperInk"));
  const wallpaperDensity = document.getElementById("wallpaper-density") as HTMLSelectElement;
  wallpaperDensity.value = readStored("pi.wallpaperDensity") === "compact" ? "compact" : "comfortable";
  const rendererSwitch = document.getElementById("renderer-switch") as HTMLInputElement;
  rendererSwitch.checked = readStored("pi.gpuTerminal") !== "0";
  let accelerated = false;
  const refreshRendererStatus = () => {
    document.getElementById("renderer-status")!.textContent = t(accelerated ? "ui.rendererFast" : "ui.rendererFallback");
  };
  const renderer = createRendererController(
    (addon) => term.loadAddon(addon),
    () => new WebglAddon(),
    (enabled) => {
      accelerated = enabled;
      document.body.classList.toggle("terminal-accelerated", enabled);
      refreshRendererStatus();
    },
  );
  rendererSwitch.addEventListener("change", () => {
    writeStored("pi.gpuTerminal", rendererSwitch.checked ? "1" : "0");
    renderer.setEnabled(rendererSwitch.checked);
  });
  const applyWallpaperUi = () => {
    document.body.style.setProperty("--wallpaper-ui-font-size", `${wallpaperUiFont}px`);
    document.body.dataset.wallpaperDensity = wallpaperDensity.value;
    document.getElementById("ui-font-size-value")!.textContent = `${wallpaperUiFont} px`;
    (document.getElementById("ui-font-decrease") as HTMLButtonElement).disabled = wallpaperUiFont <= 12;
    (document.getElementById("ui-font-increase") as HTMLButtonElement).disabled = wallpaperUiFont >= 18;
  };
  const changeUiFont = (delta: number) => {
    wallpaperUiFont = wallpaperUiSize(wallpaperUiFont + delta);
    writeStored("pi.wallpaperUiFontSize", String(wallpaperUiFont));
    applyWallpaperUi();
  };
  document.getElementById("ui-font-decrease")!.addEventListener("click", () => changeUiFont(-1));
  document.getElementById("ui-font-increase")!.addEventListener("click", () => changeUiFont(1));
  wallpaperDensity.addEventListener("change", () => {
    writeStored("pi.wallpaperDensity", wallpaperDensity.value);
    applyWallpaperUi();
    scheduleResize();
  });
  applyWallpaperUi();
  let escDouble = readStored("pi.escDouble") === "1";
  const wallpaperSwitch = document.getElementById("wallpaper-switch") as HTMLInputElement;
  const escSwitch = document.getElementById("esc-switch") as HTMLInputElement;
  const focusTerminal = () => {
    if (settingsPanel.hidden && !document.body.classList.contains("hide-terminal")) term.focus();
  };
  let onWorkspaceLayoutChange: (() => void) | null = null;

  const fullscreenToggle = document.getElementById("fullscreen-toggle") as HTMLButtonElement;
  const frameToggle = document.getElementById("frame-toggle") as HTMLButtonElement;
  const nativeWindow = isDesktop ? getCurrentWindow() : null;
  let fullscreen = false;
  let fullscreenTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshWindowControls = () => {
    fullscreenToggle.replaceChildren(icon(fullscreen ? "minimize" : "maximize"));
    fullscreenToggle.title = t(fullscreen ? "ui.exitFullscreen" : "ui.enterFullscreen");
    fullscreenToggle.setAttribute("aria-label", fullscreenToggle.title);
    fullscreenToggle.setAttribute("aria-pressed", String(fullscreen));
    const hidden = document.body.classList.contains("frame-hidden");
    frameToggle.replaceChildren(icon(hidden ? "panel-top-open" : "panel-top-close"));
    frameToggle.title = t(hidden ? "ui.showFrame" : "ui.hideFrame");
    frameToggle.setAttribute("aria-label", frameToggle.title);
    frameToggle.setAttribute("aria-pressed", String(hidden));
  };
  const syncFullscreen = async () => {
    try {
      fullscreen = nativeWindow ? await nativeWindow.isFullscreen() : !!document.fullscreenElement;
      refreshWindowControls();
    } catch (error) { console.warn("Could not read fullscreen state", error); }
  };
  const onFullscreenResize = () => {
    clearTimeout(fullscreenTimer);
    fullscreenTimer = setTimeout(() => { void syncFullscreen(); }, 100);
  };
  fullscreenToggle.addEventListener("click", async () => {
    if (fullscreenToggle.disabled) return;
    fullscreenToggle.disabled = true;
    try {
      if (nativeWindow) await nativeWindow.setFullscreen(!(await nativeWindow.isFullscreen()));
      else if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      await syncFullscreen();
      scheduleResize();
    } catch (error) { showToast(`${t("ui.fullscreenFailed")}: ${String(error)}`, 4500); }
    finally { fullscreenToggle.disabled = false; focusTerminal(); }
  });
  const applyFrameHidden = async (hidden: boolean, persist = true) => {
    document.body.classList.toggle("frame-hidden", hidden);
    document.body.classList.remove("sidebar-open");
    onWorkspaceLayoutChange?.();
    refreshWindowControls();
    scheduleResize();
    if (persist) writeStored("pi.frameHidden", hidden ? "1" : "0");
    if (nativeWindow) {
      try { await nativeWindow.setDecorations(!hidden); }
      catch (error) { showToast(`${t("ui.frameFailed")}: ${String(error)}`, 4500); }
    }
  };
  frameToggle.addEventListener("click", async () => {
    frameToggle.disabled = true;
    try { await applyFrameHidden(!document.body.classList.contains("frame-hidden")); }
    finally { frameToggle.disabled = false; focusTerminal(); }
  });
  window.addEventListener("resize", onFullscreenResize);
  document.addEventListener("fullscreenchange", onFullscreenResize);
  void syncFullscreen();
  if (readStored("pi.frameHidden") === "1") void applyFrameHidden(true, false);
  else refreshWindowControls();

  const refreshSettingsUI = () => {
    wallpaperSwitch.checked = wallpaperOn;
    escSwitch.checked = escDouble;
    wallpaperToggle.setAttribute("aria-pressed", String(wallpaperOn));
    const activeFont = wallpaperOn ? wallpaperFont : fontSize;
    document.getElementById("font-size-value")!.textContent = `${activeFont} px`;
    (document.getElementById("font-decrease") as HTMLButtonElement).disabled = activeFont <= (wallpaperOn ? 12 : 10);
    (document.getElementById("font-increase") as HTMLButtonElement).disabled = activeFont >= 28;
    document.querySelectorAll<HTMLButtonElement>("[data-ink]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.ink === wallpaperInk));
    });
    settingsPanel.querySelectorAll<HTMLButtonElement>("button[data-setting]").forEach((btn) => {
      const active =
        (btn.dataset.setting === "wallpaper" && btn.dataset.value === (wallpaperOn ? "on" : "off")) ||
        (btn.dataset.setting === "fontsize" && btn.dataset.value === String(fontSize)) ||
        (btn.dataset.setting === "escdouble" && btn.dataset.value === (escDouble ? "on" : "off"));
      btn.classList.toggle("active", active);
    });
  };

  const applyTerminalTypography = () => {
    document.body.dataset.wallpaperInk = wallpaperInk;
    term.options = {
      theme: wallpaperOn ? wallpaperTheme(wallpaperInk, workbenchTheme) : workbenchTheme,
      minimumContrastRatio: wallpaperOn ? 7 : 1,
      fontSize: wallpaperOn ? wallpaperFont : fontSize,
      fontWeight: wallpaperOn ? "500" : "400",
      lineHeight: wallpaperOn ? 1.15 : 1,
    };
    scheduleResize();
  };
  document.getElementById("wallpaper-ink")!.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-ink]");
    if (!button) return;
    wallpaperInk = normalizeWallpaperInk(button.dataset.ink);
    writeStored("pi.wallpaperInk", wallpaperInk);
    applyTerminalTypography();
    refreshSettingsUI();
  });

  const applyWallpaper = (on: boolean, persist = true) => {
    const layoutChanged = document.body.classList.contains("wallpaper-mode") !== on;
    wallpaperOn = on;
    document.body.classList.toggle("no-wallpaper", !on);
    document.body.classList.toggle("wallpaper-mode", on);
    wallpaperToggle.replaceChildren(icon("image"));
    wallpaperToggle.title = t(on ? "title.wallpaperOn" : "title.wallpaperOff");
    wallpaperToggle.setAttribute("aria-label", wallpaperToggle.title);
    playActiveVideo();
    if (layoutChanged) {
      document.body.classList.remove("sidebar-open");
      applyTerminalTypography();
      onWorkspaceLayoutChange?.();
    }
    if (persist) writeStored("pi.wallpaper", on ? "on" : "off");
    refreshSettingsUI();
  };

  const applyFontSize = (size: number, persist = true) => {
    if (wallpaperOn) {
      wallpaperFont = wallpaperFontSize(size);
      if (persist) writeStored("pi.wallpaperFontSize", String(wallpaperFont));
    } else {
      fontSize = clampNumber(size, 10, 28, 14);
      if (persist) writeStored("pi.fontSize", String(fontSize));
    }
    applyTerminalTypography();
    refreshSettingsUI();
  };
  document.getElementById("font-decrease")!.addEventListener("click", () => applyFontSize((wallpaperOn ? wallpaperFont : fontSize) - 1));
  document.getElementById("font-increase")!.addEventListener("click", () => applyFontSize((wallpaperOn ? wallpaperFont : fontSize) + 1));
  wallpaperSwitch.addEventListener("change", () => applyWallpaper(wallpaperSwitch.checked));
  escSwitch.addEventListener("change", () => {
    escDouble = escSwitch.checked;
    writeStored("pi.escDouble", escDouble ? "1" : "0");
    refreshSettingsUI();
  });

  // —— 自定义壁纸：文件存进 IndexedDB，重启后自动恢复 ——
  const wallpaperImage = document.getElementById("wallpaper-image") as HTMLImageElement;
  const wallpaperName = document.getElementById("wallpaper-name") as HTMLDivElement;
  const wallpaperPick = document.getElementById("wallpaper-pick") as HTMLButtonElement;
  const wallpaperReset = document.getElementById("wallpaper-reset") as HTMLButtonElement;
  const wallpaperFile = document.getElementById("wallpaper-file") as HTMLInputElement;
  const wallpaperLabel = document.getElementById("wallpaper-preview-label")!;

  const idbOpen = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open("pi-wallpaper", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("Wallpaper storage is busy"));
    });
  const idbTx = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await idbOpen();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction("files", mode);
        const req = run(tx.objectStore("files"));
        tx.oncomplete = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Storage transaction aborted"));
      });
    } finally {
      db.close();
    }
  };
  const idbPut = (key: string, value: Blob) => idbTx<unknown>("readwrite", (s) => s.put(value, key));
  const idbGet = (key: string) => idbTx<Blob | undefined>("readonly", (s) => s.get(key));
  const idbDelete = (key: string) => idbTx<unknown>("readwrite", (s) => s.delete(key));
  let storageQueue = Promise.resolve();
  const storeWallpaper = (operation: () => Promise<unknown>) => {
    const result = storageQueue.then(operation);
    storageQueue = result.then(() => {}, () => {});
    return result;
  };

  let customWallpaperUrl: string | null = null;
  let wallpaperPreviewUrl: string | null = null;
  let wallpaperSelectionVersion = 0;
  let selectedWallpaper = DEFAULT_WALLPAPER_ID;
  const refreshWallpaperName = () => {
    const name = selectedWallpaper === "custom" ? readStored("pi.wallpaperName") || t("ui.customWallpaper")
      : t(`wallpaper.${selectedWallpaper}`);
    wallpaperName.textContent = name;
    wallpaperLabel.textContent = name;
    presets.refreshLanguage();
  };
  const presets = setupWallpaperPresets({
    container: document.getElementById("wallpaper-presets")!, translate: t,
    onSelect: (preset) => { showPresetWallpaper(preset); applyWallpaper(true); },
  });
  const previewImages = [...document.querySelectorAll<HTMLImageElement>(
    ".wallpaper-preview > img, .appearance-shortcut > img",
  )];
  const resetWallpaperPreview = (poster = "/wallpaper-poster.jpg") => {
    previewImages.forEach((image) => { image.src = poster; });
    if (wallpaperPreviewUrl) URL.revokeObjectURL(wallpaperPreviewUrl);
    wallpaperPreviewUrl = null;
  };
  const captureWallpaperPreview = (media: HTMLImageElement | HTMLVideoElement, width: number, height: number) => {
    if (!customWallpaperUrl || media.getAttribute("src") !== customWallpaperUrl) return;
    const version = wallpaperSelectionVersion;
    const canvas = document.createElement("canvas");
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const scale = Math.min(320 / width, 180 / height, 1);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    try {
      context.drawImage(media, 0, 0, canvas.width, canvas.height);
      // Capture thumbnails only once; the background remains native video/image playback.
      canvas.toBlob((blob) => {
        if (!blob || wallpaperSelectionVersion !== version) return;
        const oldPreview = wallpaperPreviewUrl;
        wallpaperPreviewUrl = URL.createObjectURL(blob);
        previewImages.forEach((image) => { image.src = wallpaperPreviewUrl!; });
        if (oldPreview) URL.revokeObjectURL(oldPreview);
      }, "image/jpeg", 0.85);
    } catch (error) {
      console.warn("Could not capture wallpaper thumbnail", error);
    }
  };
  wallpaperImage.addEventListener("load", () => {
    captureWallpaperPreview(wallpaperImage, wallpaperImage.naturalWidth, wallpaperImage.naturalHeight);
  });
  wallpaperVideo.addEventListener("loadeddata", () => {
    captureWallpaperPreview(wallpaperVideo, wallpaperVideo.videoWidth, wallpaperVideo.videoHeight);
  });

  const setMediaVisible = (kind: "video" | "image") => {
    wallpaperVideo.style.display = kind === "video" ? "" : "none";
    wallpaperImage.style.display = kind === "image" ? "" : "none";
  };

  const playActiveVideo = () => {
    if (wallpaperVideo.style.display !== "none" && wallpaperOn) {
      const playing = wallpaperVideo.play();
      if (playing && typeof playing.catch === "function") playing.catch(() => {});
    }
  };

  const setVideoSource = (source: string) => {
    if (wallpaperVideo.getAttribute("src") !== source) {
      wallpaperVideo.src = source;
    }
    playActiveVideo();
  };
  wallpaperVideo.addEventListener("error", () => {
    if (wallpaperOn) showToast(t("ui.wallpaperFailed"), 4000);
  });

  const showPresetWallpaper = (preset: WallpaperPreset, persist = true) => {
    wallpaperSelectionVersion++;
    selectedWallpaper = preset.id;
    const oldUrl = customWallpaperUrl;
    customWallpaperUrl = null;
    setMediaVisible("video");
    wallpaperImage.removeAttribute("src");
    wallpaperVideo.poster = preset.poster;
    setVideoSource(preset.video);
    resetWallpaperPreview(preset.poster);
    presets.select(preset.id);
    if (persist) {
      writeStored("pi.wallpaperPreset", preset.id);
      wallpaperInk = presetInk(preset);
      writeStored("pi.wallpaperInk", wallpaperInk);
      applyTerminalTypography();
      refreshSettingsUI();
    }
    refreshWallpaperName();
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  };
  const showDefaultWallpaper = () => showPresetWallpaper(wallpaperPreset(DEFAULT_WALLPAPER_ID)!);

  const showCustomWallpaper = (blob: Blob, name?: string, persistName = true) => {
    wallpaperSelectionVersion++;
    selectedWallpaper = "custom";
    presets.select("custom");
    const oldUrl = customWallpaperUrl;
    customWallpaperUrl = URL.createObjectURL(blob);
    resetWallpaperPreview();
    wallpaperVideo.removeAttribute("poster");
    if (blob.type.startsWith("video")) {
      setMediaVisible("video");
      wallpaperImage.removeAttribute("src");
      setVideoSource(customWallpaperUrl);
    } else {
      wallpaperVideo.pause();
      setMediaVisible("image");
      wallpaperImage.src = customWallpaperUrl;
    }
    if (persistName) {
      writeStored("pi.wallpaperPreset", "custom");
      if (name) writeStored("pi.wallpaperName", name);
    }
    wallpaperName.textContent = name || t("ui.customWallpaper");
    wallpaperLabel.textContent = wallpaperName.textContent;
    invoke("log_debug", { msg: `custom wallpaper: ${name || "?"} (${blob.type})` }).catch(() => {});
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  };

  wallpaperPick.addEventListener("click", () => wallpaperFile.click());
  wallpaperFile.addEventListener("change", async () => {
    const file = wallpaperFile.files?.[0];
    wallpaperFile.value = "";
    if (!file) return;
    if (!file.type.startsWith("video") && !file.type.startsWith("image")) {
      showToast("只支持视频或图片文件", 4000);
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      showToast(currentLang === "en" ? "Wallpaper exceeds 100 MB." : "壁纸文件不能超过 100 MB。", 4000);
      return;
    }
    showCustomWallpaper(file, file.name);
    applyWallpaper(true);
    const selection = wallpaperSelectionVersion;
    try {
      await storeWallpaper(() => idbPut("custom", file));
    } catch {
      if (wallpaperSelectionVersion === selection) showToast("保存失败（文件可能太大）", 4000);
    }
  });

  wallpaperReset.addEventListener("click", async () => {
    showDefaultWallpaper();
    try {
      localStorage.removeItem("pi.wallpaperName");
    } catch {
      /* ignore */
    }
    try {
      await storeWallpaper(() => idbDelete("custom"));
    } catch {
      /* ignore */
    }
  });

  const savedPreset = wallpaperPreset(readStored("pi.wallpaperPreset"));
  if (savedPreset) showPresetWallpaper(savedPreset, false);
  refreshWallpaperName();
  applyWallpaper(wallpaperOn, false);
  applyTerminalTypography();
  refreshSettingsUI();
  renderer.setEnabled(rendererSwitch.checked);
  idbGet("custom")
    .then((blob) => {
      if (wallpaperSelectionVersion !== 0) return;
      if (blob) showCustomWallpaper(blob, readStored("pi.wallpaperName") || undefined, false);
      else showPresetWallpaper(wallpaperPreset(DEFAULT_WALLPAPER_ID)!, false);
    })
    .catch(() => {
      if (wallpaperSelectionVersion === 0) showPresetWallpaper(wallpaperPreset(DEFAULT_WALLPAPER_ID)!, false);
    });

  wallpaperToggle.addEventListener("click", (e) => {
    e.preventDefault();
    applyWallpaper(!wallpaperOn);
    setTimeout(focusTerminal, 0);
  });

  let previousFocus: HTMLElement | null = null;
  let currentTab = "models";
  const selectTab = (tab: string) => {
    currentTab = tab;
    keybinds?.cancel();
    if (tab === "agents") librarySettings?.refresh();
    if (tab === "market") void agentMarket?.refresh();
    settingsPanel.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    settingsPanel.querySelectorAll<HTMLElement>("[data-pane]").forEach((pane) => {
      pane.hidden = pane.dataset.pane !== tab;
    });
    settingsPanel.querySelector(".settings-content")!.scrollTop = 0;
  };
  const openSettings = (tab = currentTab) => {
    previousFocus = document.activeElement as HTMLElement;
    settingsPanel.hidden = false;
    document.getElementById("app-main")!.inert = true;
    document.getElementById("quickbar")!.inert = true;
    selectTab(tab);
    document.getElementById(`tab-${tab}`)!.focus();
  };
  const closeSettings = () => {
    keybinds?.cancel();
    settingsPanel.hidden = true;
    document.getElementById("app-main")!.inert = false;
    document.getElementById("quickbar")!.inert = false;
    syncSidebar();
    if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus();
    else focusTerminal();
  };
  settingsToggle.addEventListener("click", () => openSettings());
  document.getElementById("settings-close")!.addEventListener("click", closeSettings);
  document.getElementById("model-open")!.addEventListener("click", () => openSettings("models"));
  document.getElementById("welcome-model")!.addEventListener("click", () => openSettings("models"));
  document.getElementById("error-settings")!.addEventListener("click", () => openSettings("models"));
  document.getElementById("appearance-open")!.addEventListener("click", () => openSettings("appearance"));
  document.getElementById("wallpaper-type")!.addEventListener("click", () => openSettings("appearance"));
  settingsPanel.addEventListener("click", (event) => {
    if (event.target === settingsPanel) closeSettings();
    const tab = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tab]");
    if (tab) selectTab(tab.dataset.tab!);
  });
  settingsPanel.querySelector(".settings-tabs")!.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    event.preventDefault();
    const tabs = [...settingsPanel.querySelectorAll<HTMLButtonElement>("[data-tab]")];
    const current = tabs.findIndex((tab) => tab.dataset.tab === currentTab);
    const next = key === "Home" ? 0 : key === "End" ? tabs.length - 1
      : (current + (key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next].dataset.tab!);
    tabs[next].focus();
  });
  selectTab(currentTab);

  settingsPanel.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-setting]") as HTMLButtonElement | null;
    if (!btn) return;
    if (btn.dataset.setting === "wallpaper") applyWallpaper(btn.dataset.value === "on");
    else if (btn.dataset.setting === "fontsize") applyFontSize(Number(btn.dataset.value));
    else if (btn.dataset.setting === "escdouble") {
      escDouble = btn.dataset.value === "on";
      writeStored("pi.escDouble", escDouble ? "1" : "0");
      refreshSettingsUI();
    }
  });

  // —— 模型快捷选择（在设置面板里）——
  const modelSearch = document.getElementById("model-search") as HTMLInputElement;
  const modelList = document.getElementById("model-list") as HTMLDivElement;
  let allModels: ModelInfo[] = [];
  let currentModelRef = "";
  let modelsLoading = true;
  let modelsFailed = false;
  let modelBulk: ReturnType<typeof setupModelBulk> | undefined;
  const refreshCurrentModel = () => {
    const model = allModels.find((entry) => entry.value === currentModelRef);
    const label = document.getElementById("current-model")!;
    label.removeAttribute("data-i18n");
    label.textContent = model?.name || (currentModelRef && currentModelRef !== "/" ? currentModelRef : t("ui.chooseModel"));
    document.getElementById("model-open")!.title = currentModelRef || t("ui.chooseModel");
  };

  const renderModelList = () => {
    const query = modelSearch.value.trim().toLowerCase();
    const filtered = query
      ? allModels.filter((m) => m.value.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
      : allModels;
    modelList.textContent = "";
    if (filtered.length === 0) {
      modelBulk?.update(allModels, filtered, modelsLoading);
      const empty = document.createElement("div");
      empty.className = "model-empty";
      empty.textContent = t(modelsLoading ? "ui.modelLoading" : modelsFailed ? "ui.modelFailed"
        : allModels.length === 0 ? "ui.modelEmpty" : "ui.modelNoMatch");
      modelList.appendChild(empty);
      return;
    }
    renderModelRows(modelList, filtered, currentModelRef, t, modelBulk?.selected);
    modelBulk?.update(allModels, filtered, modelsLoading);
  };

  modelSearch.addEventListener("input", renderModelList);
  modelSearch.addEventListener("keydown", (e) => {
    // 在搜索框里按 Esc 就收起面板
    if (e.key === "Escape") closeSettings();
  });
  bindModelList(modelList, {
    confirm: (name, value) => confirmModelRemoval(name, value, t),
    translate: t,
    remove: async (provider, modelid) => {
      await invoke("delete_custom_model", { provider, modelid });
      await loadModels(true);
      showToast(t("ui.modelDeleted"));
    },
    edit: async (provider, modelid) => {
      const info = await invoke<ModelEditInfo>("get_model_edit_info", { provider, modelid });
      await editModelDialog(info, t, async (values) => {
        await invoke("edit_model", { provider, originalid: modelid, modelid: values.id, modelname: values.name, api: values.api, baseurl: values.baseurl, apikey: values.apikey });
        await loadModels(true);
        showToast(t("ui.modelSaved"));
      });
    },
    select: async (value) => {
      closeSettings();
      await workbench!.executeCommand(`/model ${value}`);
      showToast(currentLang === "en" ? "Model switch sent to Pi." : "模型切换指令已发送到 Pi。");
    },
    error: (error) => showToast(String(error), 4500),
  });

  renderModelList();
  let modelLoadGeneration = 0;
  const loadModels = async (throwOnError = false) => {
    const generation = ++modelLoadGeneration;
    modelsLoading = true;
    modelsFailed = false;
    renderModelList();
    try {
      const data = await invoke<{ current: string; models: ModelInfo[]; removedCount?: number }>("list_models");
      if (generation !== modelLoadGeneration) return;
      const restore = document.getElementById("models-restore") as HTMLButtonElement;
      restore.hidden = !data.removedCount;
      allModels = data.models || [];
      currentModelRef = data.current || currentModelRef;
      modelsLoading = false;
      renderModelList();
      refreshCurrentModel();
    } catch (error) {
      if (generation !== modelLoadGeneration) return;
      allModels = [];
      modelsLoading = false;
      modelsFailed = true;
      renderModelList();
      if (throwOnError) throw error;
    }
  };
  document.getElementById("models-restore")!.addEventListener("click", async () => {
    const button = document.getElementById("models-restore") as HTMLButtonElement;
    button.disabled = true;
    try { await invoke("restore_removed_models"); await loadModels(true); showToast(t("ui.modelsRestored")); }
    catch (error) { showToast(String(error), 4500); }
    finally { button.disabled = false; }
  });
  void loadModels();
  document.getElementById("models-refresh")!.addEventListener("click", () => { void loadModels(); });
  const modelsSelectedCount = document.getElementById("models-selected-count")!;
  modelBulk = setupModelBulk({
    list: modelList,
    all: document.getElementById("models-select-all") as HTMLInputElement,
    remove: document.getElementById("models-remove-selected") as HTMLButtonElement,
    clear: document.getElementById("models-clear") as HTMLButtonElement,
    count: modelsSelectedCount,
    translate: t,
    confirm: (models, clear) => confirmModelBatch(models, clear, t),
    deleteModels: async (models) => { await invoke("delete_models", { models }); await loadModels(true); },
    changed: () => { renderModelList(); showToast(t("ui.modelDeleted")); },
    error: (error) => showToast(String(error), 4500),
  });
  renderModelList();

  // —— 添加模型：写入 ~/.pi/agent/models.json ——
  const modelAddBtn = document.getElementById("model-add-btn") as HTMLButtonElement;
  const modelAddStatus = document.getElementById("model-add-status") as HTMLDivElement;
  const inputValue = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
  modelAddBtn.addEventListener("click", async () => {
    const provider = inputValue("model-add-provider");
    const api = (document.getElementById("model-add-api") as HTMLSelectElement).value;
    const baseurl = inputValue("model-add-baseurl");
    const apikey = inputValue("model-add-apikey");
    const modelid = inputValue("model-add-id");
    const modelname = inputValue("model-add-name");
    if (!provider || !modelid) {
      modelAddStatus.textContent = "请至少填写供应商和模型 ID";
      return;
    }
    if (baseurl && !isHttpUrl(baseurl)) {
      modelAddStatus.textContent = t("ui.invalidUrl");
      return;
    }
    modelAddBtn.disabled = true;
    modelAddStatus.textContent = "添加中…";
    try {
      await invoke("add_custom_model", { provider, api, baseurl, apikey, modelids: modelid, modelname });
      modelAddStatus.textContent = `已添加 ${provider}/${modelid} · 在 pi 里执行 /model 或重启后可用`;
      const data = await invoke<{ current: string; models: ModelInfo[] }>("list_models");
      allModels = data.models || [];
      currentModelRef = data.current || currentModelRef;
      renderModelList();
      (document.getElementById("model-add-apikey") as HTMLInputElement).value = "";
    } catch (e) {
      modelAddStatus.textContent = `添加失败：${String(e)}`;
    } finally {
      modelAddBtn.disabled = false;
    }
  });

  // —— 快速导入插件（npm / git / URL / 本地路径，调用 pi install）——
  const pluginInstallBtn = document.getElementById("plugin-install-btn") as HTMLButtonElement;
  const pluginStatus = document.getElementById("plugin-status") as HTMLDivElement;
  pluginInstallBtn.addEventListener("click", async () => {
    const source = inputValue("plugin-source");
    if (!source) {
      pluginStatus.textContent = "请输入插件来源";
      return;
    }
    pluginStatus.textContent = "安装中…（可能需要联网，请稍等）";
    pluginInstallBtn.disabled = true;
    try {
      const out = await invoke<string>("install_package", { source });
      pluginStatus.textContent = `已导入，执行 /reload 或重启 pi 后生效${out ? `：${out}` : ""}`.slice(0, 500);
      invoke("log_debug", { msg: `install_package ok: ${source}` }).catch(() => {});
    } catch (e) {
      pluginStatus.textContent = `导入失败：${String(e)}`.slice(0, 500);
      invoke("log_debug", { msg: `install_package failed: ${source} :: ${String(e)}` }).catch(() => {});
    } finally {
      pluginInstallBtn.disabled = false;
    }
  });

  // —— 中转站（OpenAI 兼容 relay）——
  const relayAddBtn = document.getElementById("relay-add-btn") as HTMLButtonElement;
  const relayStatus = document.getElementById("relay-status") as HTMLDivElement;
  relayAddBtn.addEventListener("click", async () => {
    const provider = "relay";
    const baseurl = inputValue("relay-baseurl");
    const apikey = inputValue("relay-apikey");
    const modelids = inputValue("relay-models");
    if (!baseurl) {
      relayStatus.textContent = "请填写中转站地址";
      return;
    }
    if (!modelids) {
      relayStatus.textContent = "请填写至少一个模型 ID";
      return;
    }
    if (!isHttpUrl(baseurl)) {
      relayStatus.textContent = t("ui.invalidUrl");
      return;
    }
    relayAddBtn.disabled = true;
    relayStatus.textContent = "添加中…";
    try {
      await invoke("add_custom_model", {
        provider,
        api: "openai-completions",
        baseurl,
        apikey,
        modelids,
        modelname: "",
      });
      relayStatus.textContent = `已添加中转站「${provider}」· 点模型列表即可切换`;
      const data = await invoke<{ current: string; models: ModelInfo[] }>("list_models");
      allModels = data.models || [];
      currentModelRef = data.current || currentModelRef;
      renderModelList();
      (document.getElementById("relay-apikey") as HTMLInputElement).value = "";
    } catch (e) {
      relayStatus.textContent = `添加失败：${String(e)}`;
    } finally {
      relayAddBtn.disabled = false;
    }
  });

  // —— 左侧快捷指令栏 ——
  const quickbar = document.getElementById("quickbar") as HTMLDivElement;
  const quickbarToggle = document.getElementById("quickbar-toggle") as HTMLButtonElement;
  const quickbarList = document.getElementById("quickbar-list") as HTMLDivElement;
  const quickbarAddBtn = document.getElementById("quickbar-add-btn") as HTMLButtonElement;
  const quickbarResetBtn = document.getElementById("quickbar-reset-btn") as HTMLButtonElement;
  const quickbarEdit = document.getElementById("quickbar-edit") as HTMLDivElement;
  const quickbarEditLabel = document.getElementById("quickbar-edit-label") as HTMLInputElement;
  const quickbarEditCmd = document.getElementById("quickbar-edit-cmd") as HTMLInputElement;
  const quickbarEditSave = document.getElementById("quickbar-edit-save") as HTMLButtonElement;
  const quickbarEditCancel = document.getElementById("quickbar-edit-cancel") as HTMLButtonElement;
  const quickbarConfirm = document.getElementById("quickbar-confirm") as HTMLDivElement;
  const quickbarConfirmText = document.getElementById("quickbar-confirm-text") as HTMLDivElement;
  const quickbarConfirmOk = document.getElementById("quickbar-confirm-ok") as HTMLButtonElement;
  const quickbarConfirmCancel = document.getElementById("quickbar-confirm-cancel") as HTMLButtonElement;

  type QuickCommand = { label: string; cmd: string; key?: string };
  const DEFAULT_COMMANDS: QuickCommand[] = [
    { label: "压缩上下文", cmd: "/compact", key: "cmd.compact" },
    { label: "会话树", cmd: "/tree", key: "cmd.tree" },
    { label: "重载", cmd: "/reload", key: "cmd.reload" },
    { label: "设置", cmd: "/settings", key: "cmd.settings" },
    { label: "信任目录", cmd: "/trust", key: "cmd.trust" },
    { label: "登录", cmd: "/login", key: "cmd.login" },
    { label: "快捷键", cmd: "/hotkeys", key: "cmd.hotkeys" },
  ];

  const readQuickCommands = (): QuickCommand[] => {
    try {
      const raw = localStorage.getItem("pi.quickCommands");
      if (raw === null) return DEFAULT_COMMANDS.map((c) => ({ ...c }));
      const v = JSON.parse(raw);
      if (!Array.isArray(v)) return DEFAULT_COMMANDS.map((c) => ({ ...c }));
      return v
        .filter((x) => x && typeof x.label === "string" && typeof x.cmd === "string")
        .map((x) => {
          const entry: QuickCommand = { label: x.label as string, cmd: x.cmd as string };
          if (typeof x.key === "string") {
            entry.key = x.key;
          } else {
            const d = DEFAULT_COMMANDS.find((c) => c.cmd === entry.cmd);
            if (d?.key && d.label === entry.label) entry.key = d.key;
          }
          return entry;
        });
    } catch {
      return DEFAULT_COMMANDS.map((c) => ({ ...c }));
    }
  };
  const writeQuickCommands = (list: QuickCommand[]) => writeStored("pi.quickCommands", JSON.stringify(list));
  const quickCommands: QuickCommand[] = readQuickCommands();
  let editingIndex = -1;
  const runQuickCommand = (cmd: string) => {
    return cmd.startsWith("/") && workbench
      ? workbench.executeCommand(cmd)
      : invoke("gui_action", { action: "submit", text: cmd, mode: sendMode });
  };

  let activeQuickBtn: HTMLButtonElement | null = null;
  const setActiveQuick = (btn: HTMLButtonElement | null) => {
    if (activeQuickBtn) activeQuickBtn.classList.remove("active");
    activeQuickBtn = btn;
    if (btn) btn.classList.add("active");
  };

  let pendingDeleteIndex = -1;
  const closeDeleteConfirm = () => {
    pendingDeleteIndex = -1;
    quickbarConfirm.hidden = true;
  };
  const openDeleteConfirm = (index: number) => {
    const c = quickCommands[index];
    if (!c) return;
    pendingDeleteIndex = index;
    quickbarConfirmText.textContent = `${t("quickbar.deleteConfirm")} 「${c.key ? t(c.key) : c.label}」`;
    quickbarEdit.hidden = true;
    quickbarConfirm.hidden = false;
  };

  const closeQuickEdit = () => {
    editingIndex = -1;
    quickbarEdit.hidden = true;
    quickbarEditLabel.value = "";
    quickbarEditCmd.value = "";
  };
  const openQuickEdit = (index: number) => {
    closeDeleteConfirm();
    editingIndex = index;
    if (index >= 0) {
      quickbarEditLabel.value = quickCommands[index].label;
      quickbarEditCmd.value = quickCommands[index].cmd;
    } else {
      quickbarEditLabel.value = "";
      quickbarEditCmd.value = "";
    }
    quickbarEdit.hidden = false;
    quickbarEditLabel.focus();
  };

  const renderQuickbar = () => {
    setActiveQuick(null);
    quickbarList.textContent = "";
    const query = (document.getElementById("quick-search") as HTMLInputElement).value.trim().toLowerCase();
    const commandIcons: Record<string, string> = {
      "/model": "box", "/new": "square-pen", "/compact": "minimize-2", "/tree": "git-branch",
      "/reload": "refresh-cw", "/settings": "settings-2", "/trust": "shield-check",
      "/login": "log-in", "/hotkeys": "keyboard",
    };
    quickCommands.forEach((c, i) => {
      if (c.cmd.trim() === "/model" || c.cmd.trim() === "/new") return;
      const label = c.key ? t(c.key) : c.label;
      if (query && !`${label} ${c.cmd}`.toLowerCase().includes(query)) return;
      const row = document.createElement("div");
      row.className = "quick-command-row";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "quick-cmd";
      b.dataset.index = String(i);
      b.dataset.cmd = c.cmd;
      b.title = c.cmd;
      const name = document.createElement("span");
      name.textContent = label;
      const command = document.createElement("code");
      command.textContent = c.cmd;
      b.append(icon(commandIcons[c.cmd] || "terminal-square"), name, command);
      const actions = document.createElement("div");
      actions.className = "quick-actions";
      for (const [action, image, key] of [
        ["edit", "pencil", "ui.editCommand"], ["delete", "trash-2", "ui.deleteCommand"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "icon-button";
        button.dataset.index = String(i);
        button.dataset.action = action;
        button.title = t(key);
        button.setAttribute("aria-label", `${t(key)} ${label}`);
        button.append(icon(image));
        actions.append(button);
      }
      row.append(b, actions);
      quickbarList.appendChild(row);
    });
    if (!quickbarList.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "model-empty";
      empty.textContent = t("ui.commandEmpty");
      quickbarList.append(empty);
    }
  };
  document.getElementById("quick-search")!.addEventListener("input", renderQuickbar);

  // 这些指令会打开 pi 的浮层，需要用 Esc 才能退回首页。
  const OVERLAY_COMMANDS = new Set(["/model", "/settings", "/tree", "/trust", "/login", "/hotkeys"]);
  let quickCommandRunning = false;
  const handleQuickToggle = (b: HTMLButtonElement) => {
    if (quickCommandRunning) return;
    const cmd = b.dataset.cmd!;
    quickCommandRunning = true;
    b.disabled = true;
    void (async () => {
      if (activeQuickBtn === b && OVERLAY_COMMANDS.has(cmd) && await workbench!.dismissSelector()) {
        setActiveQuick(null);
      } else {
        await runQuickCommand(cmd);
        setActiveQuick(b);
      }
      closeMobileSidebar();
      focusTerminal();
    })().catch((error) => showToast(String(error), 5000)).finally(() => {
      quickCommandRunning = false; b.disabled = false;
    });
  };

  quickbarList.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button[data-index]") as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.action === "edit") openQuickEdit(Number(b.dataset.index));
    else if (b.dataset.action === "delete") openDeleteConfirm(Number(b.dataset.index));
    else handleQuickToggle(b);
  });

  quickbarList.addEventListener("contextmenu", (e) => {
    const b = (e.target as HTMLElement).closest("button[data-index]") as HTMLButtonElement | null;
    if (!b) return;
    e.preventDefault();
    openQuickEdit(Number(b.dataset.index));
  });

  quickbarConfirmOk.addEventListener("click", () => {
    if (pendingDeleteIndex >= 0) {
      quickCommands.splice(pendingDeleteIndex, 1);
      writeQuickCommands(quickCommands);
      renderQuickbar();
    }
    closeDeleteConfirm();
  });
  quickbarConfirmCancel.addEventListener("click", () => closeDeleteConfirm());

  quickbarAddBtn.addEventListener("click", () => openQuickEdit(-1));
  quickbarResetBtn.addEventListener("click", () => {
    if (!window.confirm(t("ui.restoreConfirm"))) return;
    quickCommands.length = 0;
    quickCommands.push(...DEFAULT_COMMANDS.map((c) => ({ ...c })));
    writeQuickCommands(quickCommands);
    closeDeleteConfirm();
    closeQuickEdit();
    renderQuickbar();
  });
  quickbarEditSave.addEventListener("click", () => {
    const label = quickbarEditLabel.value.trim();
    const cmd = quickbarEditCmd.value.trim();
    if (!cmd || /[\x00-\x1f\x7f]/.test(cmd)) {
      quickbarEditCmd.focus();
      return;
    }
    const entry = { label: label || cmd, cmd };
    if (editingIndex >= 0) quickCommands[editingIndex] = entry;
    else quickCommands.push(entry);
    writeQuickCommands(quickCommands);
    closeQuickEdit();
    renderQuickbar();
  });
  quickbarEditCancel.addEventListener("click", () => closeQuickEdit());
  // Confirming a Chinese IME candidate must not save or advance the editor.
  const imeKey = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229;
  quickbarEditCmd.addEventListener("keydown", (e) => {
    if (imeKey(e)) return;
    if (e.key === "Enter") quickbarEditSave.click();
    if (e.key === "Escape") closeQuickEdit();
  });
  quickbarEditLabel.addEventListener("keydown", (e) => {
    if (imeKey(e)) return;
    if (e.key === "Enter") quickbarEditCmd.focus();
    if (e.key === "Escape") closeQuickEdit();
  });
  const narrowWindow = window.matchMedia("(max-width: 780px)");
  const sidebarBackdrop = document.getElementById("sidebar-backdrop")!;
  const syncSidebar = () => {
    const overlay = narrowWindow.matches || wallpaperOn || document.body.classList.contains("frame-hidden");
    const open = overlay ? document.body.classList.contains("sidebar-open")
      : !document.body.classList.contains("sidebar-hidden");
    sidebarBackdrop.hidden = !overlay || !open;
    quickbarToggle.setAttribute("aria-expanded", String(open));
    quickbar.inert = (!open || !settingsPanel.hidden);
  };
  const closeMobileSidebar = () => {
    document.body.classList.remove("sidebar-open");
    syncSidebar();
  };
  quickbarToggle.addEventListener("click", () => {
    if (narrowWindow.matches || wallpaperOn || document.body.classList.contains("frame-hidden")) {
      document.body.classList.toggle("sidebar-open");
    }
    else {
      document.body.classList.toggle("sidebar-hidden");
      writeStored("pi.quickbar", document.body.classList.contains("sidebar-hidden") ? "closed" : "open");
    }
    syncSidebar();
    scheduleResize();
  });
  document.getElementById("sidebar-close")!.addEventListener("click", closeMobileSidebar);
  sidebarBackdrop.addEventListener("click", closeMobileSidebar);
  narrowWindow.addEventListener("change", () => { closeMobileSidebar(); scheduleResize(); });
  if (readStored("pi.quickbar") === "closed") document.body.classList.add("sidebar-hidden");
  onWorkspaceLayoutChange = syncSidebar;
  syncSidebar();
  renderQuickbar();
  const runSessionCommand = (cmd: string) => {
    void runQuickCommand(cmd).then(() => {
      setActiveQuick(null);
      closeMobileSidebar();
      focusTerminal();
    }).catch((error) => showToast(String(error), 5000));
  };
  document.getElementById("new-session")!.addEventListener("click", () => runSessionCommand("/new"));
  document.getElementById("welcome-session")!.addEventListener("click", () => runSessionCommand("/new"));
  document.getElementById("welcome-resume")!.addEventListener("click", () => runSessionCommand("/resume"));

  // —— 底部发送模式：发送 / 控制 / 排队任务 ——
  const sendmodeBar = document.getElementById("sendmode-bar") as HTMLDivElement;
  const applySendMode = (mode: string) => {
    sendMode = normalizeSendMode(mode);
    sendmodeBar.querySelectorAll<HTMLButtonElement>(".sendmode").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === sendMode);
      b.setAttribute("aria-pressed", String(b.dataset.mode === sendMode));
    });
    writeStored("pi.sendMode", sendMode);
  };
  sendmodeBar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest(".sendmode") as HTMLButtonElement | null;
    if (!b) return;
    applySendMode(b.dataset.mode || "send");
    setTimeout(() => workbench?.focusInput(), 0);
  });
  applySendMode(readStored("pi.sendMode") || "send");

  // —— 语言切换 + 语言包导入 ——
  const languageSelect = document.getElementById("language-select") as HTMLSelectElement;
  const languageImportBtn = document.getElementById("language-import-btn") as HTMLButtonElement;
  const languageFile = document.getElementById("language-file") as HTMLInputElement;

  const renderLanguageOptions = () => {
    languageSelect.textContent = "";
    const codes = ["zh", "en", ...Object.keys(langPacks).filter((c) => c !== "zh" && c !== "en")];
    for (const code of codes) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = langPacks[code]?.name || (code === "zh" ? "中文" : code === "en" ? "English" : code);
      languageSelect.appendChild(opt);
    }
    languageSelect.value = currentLang;
  };

  const applyLanguage = (lang: string) => {
    currentLang = lang;
    try {
      localStorage.setItem("pi.lang", lang);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = lang;
    document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n!);
    });
    document.querySelectorAll<HTMLElement>("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", t(el.dataset.i18nPh!));
      if (!(el as HTMLInputElement).labels?.length) el.setAttribute("aria-label", t(el.dataset.i18nPh!));
    });
    document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", t(el.dataset.i18nTitle!));
      el.setAttribute("aria-label", t(el.dataset.i18nTitle!));
    });
    refreshSettingsUI();
    applyWallpaper(wallpaperOn, false);
    renderLanguageOptions();
    onLanguageChange?.();
    sounds?.refreshLanguage();
    keybinds?.refreshLanguage();
    librarySettings?.refreshLanguage();
    agentMarket?.refreshLanguage();
  };

  languageSelect.addEventListener("change", () => applyLanguage(languageSelect.value));
  languageImportBtn.addEventListener("click", () => languageFile.click());
  languageFile.addEventListener("change", async () => {
    const f = languageFile.files?.[0];
    languageFile.value = "";
    if (!f) return;
    try {
      const { code, name, strings } = parseLanguagePack(await f.text());
      langPacks[code] = { name, strings };
      writeLangPacks(langPacks);
      renderLanguageOptions();
      applyLanguage(code);
    } catch {
      showToast(t("lang.importFailed"), 4000);
    }
  });

  // —— 模型人设导入（写入 pi 的 APPEND_SYSTEM.md）——
  const personaText = document.getElementById("persona-text") as HTMLTextAreaElement;
  const personaStatus = document.getElementById("persona-status") as HTMLDivElement;
  const personaFile = document.getElementById("persona-file") as HTMLInputElement;
  const personaImportBtn = document.getElementById("persona-import-btn") as HTMLButtonElement;
  const personaSaveBtn = document.getElementById("persona-save-btn") as HTMLButtonElement;
  const personaClearBtn = document.getElementById("persona-clear-btn") as HTMLButtonElement;

  invoke<string>("read_persona")
    .then((txt) => {
      personaText.value = txt || "";
    })
    .catch((error) => {
      personaStatus.textContent = String(error);
      personaSaveBtn.disabled = true;
      personaClearBtn.disabled = true;
    });
  personaImportBtn.addEventListener("click", () => personaFile.click());
  personaFile.addEventListener("change", async () => {
    const f = personaFile.files?.[0];
    personaFile.value = "";
    if (!f) return;
    personaText.value = await f.text();
    personaStatus.textContent = t("persona.loaded");
  });
  personaSaveBtn.addEventListener("click", async () => {
    try {
      await invoke("save_persona", { text: personaText.value });
      personaStatus.textContent = t("persona.saved");
      invoke("log_debug", { msg: `persona saved (${personaText.value.length} chars)` }).catch(() => {});
    } catch (e) {
      personaStatus.textContent = String(e);
    }
  });
  personaClearBtn.addEventListener("click", async () => {
    try {
      await invoke("save_persona", { text: "" });
      personaText.value = "";
      personaStatus.textContent = t("persona.cleared");
    } catch (e) {
      personaStatus.textContent = String(e);
    }
  });

  renderLanguageOptions();
  applyLanguage(currentLang);

  // —— 一键隐藏代码（隐藏终端，露出壁纸）——
  const hideToggle = document.getElementById("hide-toggle") as HTMLButtonElement;
  const applyHideTerminal = (hidden: boolean) => {
    document.body.classList.toggle("hide-terminal", hidden);
    hideToggle.replaceChildren(icon(hidden ? "eye-off" : "eye"));
    hideToggle.title = t(hidden ? "title.showCode" : "title.hideCode");
    hideToggle.setAttribute("aria-label", hideToggle.title);
    hideToggle.setAttribute("aria-pressed", String(hidden));
    writeStored("pi.hideTerminal", hidden ? "1" : "0");
    if (!hidden) setTimeout(focusTerminal, 0);
  };
  hideToggle.addEventListener("click", () => {
    applyHideTerminal(!document.body.classList.contains("hide-terminal"));
  });
  applyHideTerminal(readStored("pi.hideTerminal") === "1");

  // —— 模型强度（thinking level）下拉 ——
  const thinkingSelect = document.getElementById("thinking-select") as HTMLSelectElement;
  const THINKING_LEVELS: { value: string; zh: string; en: string }[] = [
    { value: "off", zh: "关", en: "off" },
    { value: "minimal", zh: "极低", en: "minimal" },
    { value: "low", zh: "低", en: "low" },
    { value: "medium", zh: "中", en: "medium" },
    { value: "high", zh: "高", en: "high" },
    { value: "max", zh: "极高", en: "max" },
  ];
  const renderThinkingOptions = () => {
    const prev = thinkingSelect.value || readStored("pi.thinking") || "medium";
    thinkingSelect.textContent = "";
    for (const lv of THINKING_LEVELS) {
      const opt = document.createElement("option");
      opt.value = lv.value;
      opt.textContent = currentLang === "en" ? lv.en : lv.zh;
      thinkingSelect.appendChild(opt);
    }
    thinkingSelect.value = THINKING_LEVELS.some((l) => l.value === prev) ? prev : "medium";
  };
  renderThinkingOptions();
  onLanguageChange = () => {
    refreshWindowControls();
    refreshRendererStatus();
    renderThinkingOptions();
    renderQuickbar();
    renderModelList();
    refreshCurrentModel();
    refreshConnectionStatus();
    applyHideTerminal(document.body.classList.contains("hide-terminal"));
    refreshWallpaperName();
  };
  thinkingSelect.addEventListener("change", () => {
    const level = thinkingSelect.value;
    writeStored("pi.thinking", level);
    workbench?.executeCommand(`/thinking ${level}`).catch((error) => showToast(String(error)));
    setTimeout(focusTerminal, 0);
  });

  // —— 终端/文字透明度 ——
  const opacityRange = document.getElementById("opacity-range") as HTMLInputElement;
  const opacityValue = document.getElementById("opacity-value") as HTMLSpanElement;
  const applyOpacity = (pct: number) => {
    const v = clampNumber(pct, 20, 100, 100);
    document.getElementById("terminal")!.style.opacity = String(v / 100);
    opacityValue.textContent = `${v}%`;
    writeStored("pi.opacity", String(v));
  };
  opacityRange.value = String(clampNumber(readStored("pi.opacity"), 20, 100, 100));
  opacityRange.addEventListener("input", () => applyOpacity(Number(opacityRange.value)));
  applyOpacity(Number(opacityRange.value));

  keybinds = setupKeybindingSettings({ invoke, translate: t, nativeReady: () => connected });
  librarySettings = setupLibrarySettings({ invoke, translate: t, toast: showToast });
  agentMarket = setupAgentMarket({ invoke, translate: t, changed: () => librarySettings?.refresh(), openLibrary: () => selectTab("agents") });
  const nativeCommandKey = (event: KeyboardEvent) => {
    if (!event.metaKey || !settingsPanel.hidden || !(event.target instanceof Element)
      || !event.target.closest("#terminal") || !keybinds?.nativeMatches(event)) return;
    const sequence = terminalKeySequence(event);
    if (!sequence) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void invoke("write_terminal", { data: sequence }).catch(() => {});
  };
  document.addEventListener("keydown", nativeCommandKey, true);

  // —— 文件拖拽添加：用 Tauri 专有拖放 API 拿到真实路径，拖进来就转成 @path 喂给 pi 输入框 ——
  const terminalEl = document.getElementById("terminal")!;
  // 写日志到 ~/.pi_app_debug.log，便于排查拖拽是否真的触发了。
  const debug = (msg: string) => {
    invoke("log_debug", { msg: `${new Date().toISOString()} ${msg}` }).catch(() => {});
  };
  debug("frontend ready; registering drag-drop");

  // macOS 必需：必须在 dragover/dragenter/drop 上 preventDefault，WKWebView 才会
  // 接受文件拖入，否则系统直接拒绝、Tauri 的 onDragDropEvent 根本不触发；
  // 挂在 window 上可以保证窗口任意位置放下都能接住。
  const acceptDrag = (e: Event) => e.preventDefault();
  window.addEventListener("dragover", acceptDrag);
  window.addEventListener("dragenter", acceptDrag);
  window.addEventListener("drop", acceptDrag);

  // pi 的 @ 引用支持带引号写法（编辑器补全正则里是 @"..."），
  // 路径含空格/引号/反斜杠时加引号，否则会被当成两个参数。
  if (isDesktop) getCurrentWebview()
    .onDragDropEvent((event) => {
      const p = event.payload as {
        type: string;
        paths?: string[];
        position?: unknown;
      };
      debug(`drag ${p.type} paths=${JSON.stringify(p.paths ?? [])} pos=${JSON.stringify(p.position ?? null)}`);
      if (p.type === "enter" || p.type === "over") {
        terminalEl.classList.add("drag-over");
        showToast("松开鼠标即可把文件加入输入框", 4000);
      } else if (p.type === "leave") {
        terminalEl.classList.remove("drag-over");
        toastEl.classList.remove("show");
      } else if (p.type === "drop") {
        terminalEl.classList.remove("drag-over");
        const paths = (p.paths || []).filter((x): x is string => typeof x === "string");
        if (paths.length > 0) {
          workbench?.addPaths(paths);
          showToast(`已添加 ${paths.length} 个文件`);
        } else {
          showToast("没有识别到文件路径", 4000);
        }
      }
    })
    .catch((e) => {
      console.warn("拖放 API 不可用", e);
      debug(`onDragDropEvent failed: ${String(e)}`);
      showToast("拖放 API 不可用", 5000);
    });

  const connectionStatus = document.getElementById("connection-status")!;
  const connectionError = document.getElementById("connection-error")!;
  const retryConnection = document.getElementById("retry-connection") as HTMLButtonElement;
  let connectionKey = isDesktop ? "ui.connecting" : "ui.browserPreview";
  const refreshConnectionStatus = () => {
    document.getElementById("connection-label")!.textContent = t(connectionKey);
    const environmentKey = isDesktop ? "ui.localProcess" : "ui.browserPreview";
    for (const id of ["runtime-label", "settings-environment"]) {
      const element = document.getElementById(id)!;
      element.removeAttribute("data-i18n");
      element.textContent = t(environmentKey);
    }
  };
  const setConnection = (key: string, state: string) => {
    connectionKey = key;
    connectionStatus.dataset.state = state;
    refreshConnectionStatus();
  };
  let terminalGeneration = 0;
  let startupPoll: ReturnType<typeof setTimeout> | undefined;
  // Retry and recovery must return to the workspace and session the user was actually using.
  let lastTarget: { cwd?: string; session?: string } = {};
  let libraryLoadedFor = "";
  const connect = async (cwd?: string, session?: string) => {
    if (connecting || connected || !isDesktop) return;
    lastTarget = { cwd, session };
    connecting = true;
    retryConnection.disabled = true;
    connectionError.hidden = true;
    setConnection("ui.connecting", "connecting");
    const generation = ++terminalGeneration;
    try {
      fitAddon.fit();
      const onData = new Channel<number[]>();
      const onExit = new Channel<string>();
      let exited = false;
      onData.onmessage = (data) => { if (generation === terminalGeneration) outputBatcher.push(new Uint8Array(data)); };
      onExit.onmessage = () => {
        if (generation !== terminalGeneration) return;
        exited = true;
        connected = false;
        sizeReporter.reset();
        setConnection("ui.disconnected", "error");
        document.getElementById("connection-error-text")!.textContent = t("ui.terminalExited");
        connectionError.hidden = false;
        workbench?.disconnected();
      };
      const info = await bridgeInvoke<{ cwd: string; executable: string; bridgeId: string }>("start_terminal", {
        rows: term.rows, cols: term.cols, onData, onExit, cwd, session,
      });
      connected = !exited;
      sizeReporter.reset();
      if (connected) setConnection("ui.connected", "connected");
      if (info.cwd) lastTarget = { cwd: info.cwd, session };
      updateRuntime(info);
      workbench?.setRuntime(info);
      const synchronize = (remaining: number) => {
        if (generation !== terminalGeneration || !connected) return;
        void workbench?.synchronize().catch(() => {});
        if (remaining > 0) startupPoll = setTimeout(() => synchronize(remaining - 1), 700);
      };
      synchronize(12);
      scheduleResize();
      if (connected) focusTerminal();
    } catch (error) {
      connected = false;
      setConnection("ui.connectionFailed", "error");
      document.getElementById("connection-error-text")!.textContent = String(error);
      connectionError.hidden = false;
      workbench?.disconnected();
    } finally {
      connecting = false;
      retryConnection.disabled = false;
    }
  };
  const updateRuntime = (info: { cwd: string; executable: string }) => {
    for (const id of ["workspace-path", "status-workspace", "runtime-cwd"]) {
      document.getElementById(id)!.textContent = info.cwd;
      document.getElementById(id)!.title = info.cwd;
    }
    document.getElementById("runtime-executable")!.textContent = info.executable || t("ui.notAvailable");
  };
  workbench = setupWorkbench({
    desktop: isDesktop,
    invoke,
    matchesShortcut: (id, event) => keybinds?.matches(id, event) ?? false,
    language: () => currentLang,
    mode: () => sendMode,
    toast: showToast,
    resize: scheduleResize,
    focusTerminal,
    settings: () => openSettings(),
    panelOpened: closeMobileSidebar,
    prepareCommand: () => {
      if (!settingsPanel.hidden) closeSettings();
      if (document.body.classList.contains("hide-terminal")) document.getElementById("hide-toggle")!.click();
    },
    stateChanged: (state) => {
      // Load the Agent picker once per Pi process; the library is served by Pi's GUI extension.
      if (state.connected && state.ready && libraryLoadedFor !== lastTarget.cwd + ":" + (state.sessionId || "")) {
        libraryLoadedFor = lastTarget.cwd + ":" + (state.sessionId || "");
        librarySettings?.refresh();
      }
      // Track the live session so a retry after a crash or /quit resumes it instead of starting fresh.
      if (state.cwd) lastTarget = { cwd: state.cwd, session: state.session || lastTarget.session };
      if (state.model && currentModelRef !== state.model) {
        currentModelRef = state.model;
        refreshCurrentModel();
        renderModelList();
      }
      if (state.thinking && [...thinkingSelect.options].some((option) => option.value === state.thinking)) {
        thinkingSelect.value = state.thinking;
      }
    },
    reconnect: async (cwd, session) => {
      if (connecting) throw new Error(t("ui.connecting"));
      await invoke("validate_terminal_target", { cwd, session });
      await invoke("stop_terminal");
      terminalGeneration++;
      clearTimeout(startupPoll);
      connected = false;
      workbench?.disconnected();
      outputBatcher.dispose();
      outputBatcher = createOutputBatcher((bytes, done) => term.write(bytes, done));
      await new Promise<void>((resolve) => term.write("", resolve));
      term.reset();
      await connect(cwd, session);
      if (!connected) throw new Error(t("ui.connectionFailed"));
      writeStored("pi.workspace", cwd);
    },
  });
  const previousLanguageChange = onLanguageChange;
  onLanguageChange = () => { previousLanguageChange?.(); workbench?.refreshStrings(); };
  if (isDesktop) {
    void bridgeInvoke<{ cwd: string; executable: string }>("get_runtime_info")
      .then(updateRuntime).catch(() => {});
    void connect(readStored("pi.workspace") || undefined);
  } else {
    document.getElementById("terminal-welcome")!.hidden = false;
    document.getElementById("runtime-executable")!.textContent = t("ui.notAvailable");
    refreshConnectionStatus();
  }
  retryConnection.addEventListener("click", () => {
    void connect(lastTarget.cwd || readStored("pi.workspace") || undefined, lastTarget.session);
  });
  document.getElementById("scroll-bottom")!.addEventListener("click", () => {
    term.scrollToBottom();
    focusTerminal();
  });
  const exportTerminal = async () => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      lines.push(buffer.getLine(index)?.translateToString(true) || "");
    }
    const text = lines.join("\n").trimEnd();
    if (!text) { showToast(t("ui.exportEmpty")); return; }
    const filename = `pi-terminal-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    if (isDesktop) {
      try {
        const path = await invoke<string>("export_terminal_log", { text, filename });
        showToast(`${currentLang === "en" ? "Saved" : "已保存"}: ${path}`, 5000);
      } catch (error) { showToast(String(error), 5000); }
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  document.getElementById("export-terminal")!.addEventListener("click", () => { void exportTerminal(); });
  document.getElementById("floating-settings")!.addEventListener("click", () => openSettings());
  document.addEventListener("keydown", (event) => {
    if (document.querySelector(".model-dialog-backdrop")) return;
    if (document.body.dataset.keyRecording) return;
    if (keybinds?.matches("gui.settings", event)) {
      event.preventDefault();
      if (settingsPanel.hidden) openSettings(); else closeSettings();
      return;
    }
    if (!settingsPanel.hidden) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSettings();
      } else if (event.key === "Tab") {
        const focusable = [...settingsPanel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select, textarea, summary, [tabindex="0"]',
        )].filter((element) => element.getClientRects().length && element.tabIndex >= 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    } else if (event.key === "Escape" && document.body.classList.contains("sidebar-open")) {
      closeMobileSidebar();
    }
  }, true);
  window.addEventListener("beforeunload", () => {
    clearTimeout(resizeTimer);
    clearTimeout(startupPoll);
    workbench?.dispose();
    sounds?.dispose();
    keybinds?.dispose();
    librarySettings?.dispose();
    agentMarket?.dispose();
    modelBulk?.dispose();
    document.removeEventListener("keydown", nativeCommandKey, true);
    cancelAnimationFrame(initialFitFrame);
    initialFitTimers.forEach(clearTimeout);
    outputBatcher.dispose();
    renderer.dispose();
    clearTimeout(toastTimer);
    clearTimeout(fullscreenTimer);
    window.removeEventListener("resize", onFullscreenResize);
    document.removeEventListener("fullscreenchange", onFullscreenResize);
    ro.disconnect();
    window.removeEventListener("resize", scheduleResize);
    term.dispose();
    wallpaperSelectionVersion++;
    if (customWallpaperUrl) URL.revokeObjectURL(customWallpaperUrl);
    if (wallpaperPreviewUrl) URL.revokeObjectURL(wallpaperPreviewUrl);
  });
}

main().catch((error) => {
  console.error(error);
  const panel = document.getElementById("connection-error")!;
  panel.hidden = false;
  document.getElementById("connection-error-text")!.textContent = String(error);
  document.getElementById("retry-connection")!.addEventListener("click", () => location.reload(), { once: true });
});
