import "@xterm/xterm/css/xterm.css";
import "./style.css";
import "./workbench.css";
import "./claude-view.css";
import "./conversation-view.css";
import { Channel } from "@tauri-apps/api/core";
import { invoke as bridgeInvoke, isDesktop } from "./bridge";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { icon, renderIcons } from "./icons";
import { applyLocalizedControlLabels } from "./accessibility";
import { UI_STRINGS } from "./ui-strings";
import { clampNumber, formatUserError, isHttpUrl, parseLanguagePack } from "./utils";
import { CUSTOM_FONT_FAMILY, DEFAULT_TERMINAL_FONT_FAMILY, isSupportedFontFile, MAX_CUSTOM_FONT_BYTES, normalizeHexColor, normalizeWallpaperInk, wallpaperFontSize, wallpaperUiSize, wallpaperTheme } from "./wallpaper-appearance";
import { createOutputBatcher, createSizeReporter } from "./terminal-flow";
import { createRendererController } from "./terminal-renderer";
import { createPiRecovery } from "./pi-connection";
import { setupThinkingControls } from "./thinking-controls";
import { setupWorkbench } from "./workbench";
import { setupSendModeControls } from "./send-mode-controls";
import { setupSoundSettings } from "./sound-settings";
import { DEFAULT_WALLPAPER_ID, presetInk, setupWallpaperPresets, wallpaperPreset, type WallpaperPreset } from "./wallpaper-presets";
import { isWindowsPlatform, setupKeybindingSettings, terminalKeySequence } from "./keybinding-settings";
import { setupLibrarySettings } from "./library-settings";
import { setupSkillLibrary } from "./skill-library";
import "./skill-library.css";
import { setupAgentMarket } from "./agent-market";
import { setupHarnessSettings } from "./harness-settings";
import { createPiPermissions, type ToolApproval } from "./pi-permissions";
import { setupUsageSettings } from "./usage-settings";
import "./harness.css";
import { bindModelList, renderModelRows, type ModelInfo } from "./model-list";
import { confirmModelRemoval, confirmModelBatch, confirmPiRecovery, confirmSessionResume, editModelDialog, type ModelEditInfo } from "./model-dialog";
import { RESUME_KEY, readResumeTargets, storeResumeTarget } from "./session-recovery";
import { setupSystemSettings } from "./system-settings";
import { setupModelBulk } from "./model-bulk";
import { setupSettingsNavigation } from "./settings-navigation";
import { setupAgentRuntime } from "./agent-runtime";
import { setupAgentSessionStrip } from "./agent-session-strip";
import { setupPersonaSettings } from "./persona-settings";
import { setupConversationView, type ConversationEvent } from "./conversation-view";
import { createConversationSync } from "./conversation-sync";
import { listen } from "@tauri-apps/api/event";
import { setupThemePreference } from "./theme";
import "./theme.css";
import { setupComposerParticles, normalizeComposerParticleEffect } from "./composer-particles";
import { isPermissionError, setupPermissionDialog } from "./permission-dialog";
import "./permission-dialog.css";

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
    "title.hideCode": "返回对话视图",
    "title.showCode": "切换到终端视图",
    "title.thinking": "思考强度",
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
    "settings.personaWarn": "修改会自动应用到 Pi 的下一条消息；导入后也会立即生效。内容会发送给当前模型并占用上下文。",
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
    "persona.loading": "正在读取当前人设…",
    "persona.importing": "正在读取人设文件…",
    "persona.saving": "正在应用修改…",
    "persona.unsaved": "有未保存的修改。",
    "persona.saved": "已自动应用，Pi 从下一条消息开始使用。",
    "persona.cleared": "已清除，Pi 从下一条消息起不再使用。",
    "persona.loaded": "文件已导入并应用，Pi 从下一条消息开始使用。",
    "persona.applyNow": "立即应用",
    "persona.pending": "修改待自动应用；发送消息时也会先同步。",
    "persona.tooLarge": "人设内容不能超过 48 KB。",
    "persona.invalid": "人设内容包含不支持的空字符。",
    "persona.failed": "无法读取或保存人设。",
    "lang.importFailed": "语言包导入失败",
  },
  en: {
    "title.wallpaperToggle": "Toggle wallpaper",
    "title.settings": "Settings",
    "title.quickbar": "Quick commands",
    "title.hideCode": "Return to conversation view",
    "title.showCode": "Switch to terminal view",
    "title.thinking": "Thinking effort",
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
    "settings.personaWarn": "Changes are automatically applied to the next Pi message; imported files take effect immediately. The content is sent to the selected model and uses context.",
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
    "persona.loading": "Loading current persona…",
    "persona.importing": "Reading persona file…",
    "persona.saving": "Applying changes…",
    "persona.unsaved": "Unsaved changes.",
    "persona.saved": "Applied automatically. Pi will use it from the next message.",
    "persona.cleared": "Cleared. Pi will stop using it from the next message.",
    "persona.loaded": "File imported and applied. Pi will use it from the next message.",
    "persona.applyNow": "Apply now",
    "persona.pending": "Changes will auto-apply; sending also syncs them first.",
    "persona.tooLarge": "Persona content must be 48 KB or smaller.",
    "persona.invalid": "Persona content contains an unsupported null character.",
    "persona.failed": "Could not read or save the persona.",
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
  const themeSelect = document.getElementById("theme-select") as HTMLSelectElement;
  const theme = setupThemePreference(document.documentElement);
  themeSelect.value = theme.preference;
  themeSelect.addEventListener("change", () => theme.setPreference(themeSelect.value));
  renderIcons();
  const toastEl = document.getElementById("toast")!;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const showToast = (msg: string, ms = 3000) => {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  };
  const permissionDialog = setupPermissionDialog({ language: () => currentLang, allowAll: async () => {
    if (!harnessSettings) throw Error(currentLang === "en" ? "Permissions are not ready." : "权限设置尚未就绪。");
    await harnessSettings.allowAll("pi");
    showToast(currentLang === "en" ? "Full access is active for this engine." : "当前引擎的完全访问已生效。");
  } });
  const piPermissions = createPiPermissions({
    request: value => permissionDialog.request(value), language: () => currentLang, notice: showToast,
    answer: value => bridgeInvoke("gui_action", { action: "approval", text: JSON.stringify(value) }),
  });
  let sounds: ReturnType<typeof setupSoundSettings> | undefined;
  let connected = false;
  let connecting = false;
  let workbench: ReturnType<typeof setupWorkbench> | undefined;
  let keybinds: ReturnType<typeof setupKeybindingSettings> | undefined;
  let librarySettings: ReturnType<typeof setupLibrarySettings> | undefined;
  let piRecovery: ReturnType<typeof createPiRecovery> | undefined;
  let thinkingControls: ReturnType<typeof setupThinkingControls> | undefined;
  let skillLibrary: ReturnType<typeof setupSkillLibrary> | undefined;
  let agentMarket: ReturnType<typeof setupAgentMarket> | undefined;
  let harnessSettings: ReturnType<typeof setupHarnessSettings> | undefined;
  let usageSettings: ReturnType<typeof setupUsageSettings> | undefined;
  let systemSettings: ReturnType<typeof setupSystemSettings> | undefined;
  let agentRuntime: ReturnType<typeof setupAgentRuntime> | undefined;
  let conversationView: ReturnType<typeof setupConversationView> | undefined;
  let composerParticles: ReturnType<typeof setupComposerParticles> | undefined;
  let nextStepEnabled = false;
  let answerOutlineEnabled = true;
  let personaSettings: ReturnType<typeof setupPersonaSettings> | undefined;
  const agentSessionStrip = setupAgentSessionStrip({
    root: document.getElementById("agent-session-strip")!,
    language: () => currentLang,
    onSelect: (id) => {
      if (id === "main") workbench?.focusInput();
      else workbench?.selectAgent(id);
    },
  });
  const invoke = async <T = void>(command: string, args?: Record<string, unknown>, retried = false): Promise<T> => {
    try {
      const routed = agentRuntime && ["gui_action", "gui_status", "list_sessions", "run_diagnostics"].includes(command)
        ? await agentRuntime.route<T>(command, args)
        : undefined;
      if (routed !== undefined) return routed;
      return await (command === "write_terminal" && !connected
        ? Promise.reject(new Error(t(isDesktop ? "ui.disconnected" : "ui.previewOnly")))
        : bridgeInvoke<T>(command, args));
    } catch (error) {
      if (isDesktop && !retried && isPermissionError(error)) {
        const operation = typeof args?.action === "string" ? args.action : command;
        const allowed = await permissionDialog.request({
          title: t("ui.permissionRequired"),
          operation,
          detail: formatUserError(error),
          risk: /(?:delete|remove|write|edit|shell|command|download|install|network|export)/i.test(operation) ? "high" : "medium",
        });
        if (allowed) return invoke<T>(command, args, true);
      }
      if (command === "write_terminal") showToast(formatUserError(error), 4500);
      throw error;
    }
  };
  const term = new Terminal({
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
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
  const conversationListeners: (() => void)[] = [];
  const conversationInput = (prompt: string) => {
    const input = document.getElementById("composer-input") as HTMLTextAreaElement | null;
    const send = document.getElementById("composer-send") as HTMLButtonElement | null;
    if (!input || !send) return;
    if (document.getElementById("composer-attachments")?.childElementCount) {
      showToast(currentLang === "en"
        ? "Send or remove pending attachments before using answer actions."
        : "请先发送或移除待发送附件，再使用回答快捷操作。");
      return;
    }
    const draft = input.value;
    const updateDraft = (value: string) => {
      input.value = value;
      input.dataset.particleSuppressed = "true";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      delete input.dataset.particleSuppressed;
    };
    updateDraft(prompt);
    if (!send.disabled) send.click();
    updateDraft(draft);
  };
  conversationView = setupConversationView({
    root: document.getElementById("conversation-view")!,
    onContinue: () => conversationInput("请继续完成上一个任务，并从上次停下的位置继续。"),
    onRegenerate: () => conversationInput("请重新生成上一条回答，保持原任务目标不变。"),
    nextStepEnabled: () => nextStepEnabled,
    outlineEnabled: () => answerOutlineEnabled,
    onNextStep: () => conversationInput(currentLang === "en"
      ? "Based on your previous answer, suggest the single most useful next step and briefly explain why. Do not repeat the answer."
      : "基于你上一条回答，只提出一个最值得执行的下一步建议，并简要说明理由。不要重复原回答。"),
    onOutline: () => conversationInput(currentLang === "en"
      ? "Turn your previous answer into a clear, hierarchical outline. Preserve its key conclusions and steps without adding unrelated content."
      : "请把你上一条回答整理成清晰的分级大纲，保留关键结论和步骤，不添加无关内容。"),
    onNotice: showToast,
  });
  const conversationSync = createConversationSync({
    load: async () => {
      const value = await bridgeInvoke<{ data: { sessionId: string; messages: ConversationEvent[]; truncated?: boolean } }>("gui_action", { action: "history" });
      return value.data;
    },
    clear: () => conversationView?.clear(),
    restore: (messages) => conversationView?.restore(messages),
    consume: (event) => conversationView?.consume(event),
    notice: showToast,
  });
  if (isDesktop) {
    void listen<ToolApproval>("pi-gui-permission", event => {
      if ((agentRuntime?.engine() || "pi") === "pi") piPermissions.receive(event.payload);
    }).then(unlisten => conversationListeners.push(unlisten)).catch(() => {
      showToast(currentLang === "en" ? "Permission event connection failed; reconnect before running tools." : "权限通知连接失败，请重连后再运行工具。", 6000);
    });
    void listen<ConversationEvent & { bridgeId?: string }>("pi-gui-message", (event) => {
      if (agentRuntime?.engine() !== "pi") return;
      const activeBridge = workbench?.runtimeId?.() || "";
      if (activeBridge && event.payload.bridgeId && event.payload.bridgeId !== activeBridge) return;
      conversationSync.consume({ ...event.payload, type: "message" });
    }).then((unlisten) => conversationListeners.push(unlisten)).catch(() => {});
  }

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
    // 排队任务模式沿用用户配置的 Pi follow-up 快捷键。
    let out = data;
    if (data === "\r" && sendMode === "queue") {
      const sequence = keybinds?.sequence("app.message.followUp");
      if (!sequence) { showToast(currentLang === "en" ? "Configure a queue shortcut first." : "请先在快捷键设置中启用排队快捷键。", 4000); return; }
      out = sequence;
    }
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

  // 原始终端只有在终端视图中接收键盘焦点。
  document.getElementById("terminal")!.addEventListener("mousedown", () => {
    // 注意：这里不取消快捷指令高亮，否则在浮层里点一下就会丢掉状态，
    // 再点快捷按钮就无法正确"回首页"了。
    setTimeout(focusTerminal, 0);
  });

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

  const particleSelect = document.getElementById("composer-particle-effect") as HTMLSelectElement;
  const particleEffect = normalizeComposerParticleEffect(readStored("pi.composerParticleEffect") || "rainbow");
  particleSelect.value = particleEffect;
  composerParticles = setupComposerParticles({
    input: document.getElementById("composer-input") as HTMLTextAreaElement,
    host: document.getElementById("composer-input-wrap")!,
    initialEffect: particleEffect,
  });
  particleSelect.addEventListener("change", () => {
    const effect = normalizeComposerParticleEffect(particleSelect.value);
    particleSelect.value = effect;
    writeStored("pi.composerParticleEffect", effect);
    composerParticles?.setEffect(effect);
  });

  const nextStepSwitch = document.getElementById("conversation-next-step-switch") as HTMLInputElement;
  const outlineSwitch = document.getElementById("conversation-outline-switch") as HTMLInputElement;
  nextStepEnabled = readStored("pi.conversationNextStep") === "1";
  answerOutlineEnabled = readStored("pi.conversationOutline") !== "0";
  nextStepSwitch.checked = nextStepEnabled;
  outlineSwitch.checked = answerOutlineEnabled;
  nextStepSwitch.addEventListener("change", () => {
    nextStepEnabled = nextStepSwitch.checked;
    writeStored("pi.conversationNextStep", nextStepEnabled ? "1" : "0");
    conversationView?.refreshQuickActions();
  });
  outlineSwitch.addEventListener("change", () => {
    answerOutlineEnabled = outlineSwitch.checked;
    writeStored("pi.conversationOutline", answerOutlineEnabled ? "1" : "0");
    conversationView?.refreshQuickActions();
  });
  conversationView.refreshQuickActions();

  let wallpaperOn = readStored("pi.wallpaper") === "on";
  let fontSize = clampNumber(readStored("pi.fontSize"), 10, 28, 14);
  let wallpaperFont = wallpaperFontSize(readStored("pi.wallpaperFontSize"));
  let wallpaperUiFont = wallpaperUiSize(readStored("pi.wallpaperUiFontSize"));
  let wallpaperInk = normalizeWallpaperInk(readStored("pi.wallpaperInk"));
  let terminalFontColor = normalizeHexColor(readStored("pi.terminalFontColor"));
  let customFontFace: FontFace | null = null;
  let customFontName = "";
  let fontOperation = 0;
  let fontBusy = false;
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
    if (!settingsPanel.hidden) return;
    if (document.body.classList.contains("terminal-view")) term.focus();
    else (document.getElementById("composer-input") as HTMLTextAreaElement | null)?.focus();
  };
  let onWorkspaceLayoutChange: (() => void) | null = null;

  const fullscreenToggle = document.getElementById("fullscreen-toggle") as HTMLButtonElement;
  const workFullscreenToggle = document.getElementById("work-fullscreen-toggle") as HTMLButtonElement;
  const frameToggle = document.getElementById("frame-toggle") as HTMLButtonElement;
  const nativeWindow = isDesktop ? getCurrentWindow() : null;
  let fullscreen = false;
  let fullscreenTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshWindowControls = () => {
    fullscreenToggle.replaceChildren(icon(fullscreen ? "minimize" : "maximize"));
    fullscreenToggle.title = t(fullscreen ? "ui.exitFullscreen" : "ui.enterFullscreen");
    fullscreenToggle.setAttribute("aria-label", fullscreenToggle.title);
    fullscreenToggle.setAttribute("aria-pressed", String(fullscreen));
    workFullscreenToggle.replaceChildren(icon(fullscreen ? "minimize" : "maximize"));
    workFullscreenToggle.title = fullscreenToggle.title;
    workFullscreenToggle.setAttribute("aria-label", fullscreenToggle.title);
    workFullscreenToggle.setAttribute("aria-pressed", String(fullscreen));
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
    } catch (error) { showToast(`${t("ui.fullscreenFailed")}: ${formatUserError(error)}`, 4500); }
    finally { fullscreenToggle.disabled = false; focusTerminal(); }
  });
  workFullscreenToggle.addEventListener("click", () => fullscreenToggle.click());
  const applyFrameHidden = async (hidden: boolean, persist = true) => {
    document.body.classList.toggle("frame-hidden", hidden);
    document.body.classList.remove("sidebar-open");
    onWorkspaceLayoutChange?.();
    refreshWindowControls();
    scheduleResize();
    if (persist) writeStored("pi.frameHidden", hidden ? "1" : "0");
    if (nativeWindow) {
      try { await nativeWindow.setDecorations(!hidden); }
      catch (error) { showToast(`${t("ui.frameFailed")}: ${formatUserError(error)}`, 4500); }
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
    const defaultColor = wallpaperOn ? (wallpaperInk === "light" ? "#ffffff" : "#172421") : "#dbe0e4";
    const colorInput = document.getElementById("terminal-font-color") as HTMLInputElement;
    colorInput.value = terminalFontColor || defaultColor;
    document.getElementById("terminal-font-color-value")!.textContent = terminalFontColor || t("settings.defaultFontColor");
    (document.getElementById("terminal-font-color-reset") as HTMLButtonElement).disabled = !terminalFontColor;
    document.getElementById("custom-font-name")!.textContent = customFontName || t("settings.defaultFont");
    (document.getElementById("custom-font-import") as HTMLButtonElement).disabled = fontBusy;
    (document.getElementById("custom-font-reset") as HTMLButtonElement).disabled = fontBusy || !customFontFace;
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
    document.body.style.setProperty("--conversation-font-size", `${wallpaperOn ? wallpaperFont : fontSize}px`);
    if (terminalFontColor) document.body.style.setProperty("--conversation-custom-color", terminalFontColor);
    else document.body.style.removeProperty("--conversation-custom-color");
    const wallpaperBase = wallpaperTheme(wallpaperInk, workbenchTheme, terminalFontColor);
    const theme = wallpaperOn
      ? wallpaperBase
      : terminalFontColor
        ? { ...workbenchTheme, foreground: terminalFontColor, brightWhite: terminalFontColor }
        : workbenchTheme;
    term.options = {
      theme,
      fontFamily: customFontFace ? `"${CUSTOM_FONT_FAMILY}", ${DEFAULT_TERMINAL_FONT_FAMILY}` : DEFAULT_TERMINAL_FONT_FAMILY,
      minimumContrastRatio: wallpaperOn && !terminalFontColor ? 7 : 1,
      fontSize: wallpaperOn ? wallpaperFont : fontSize,
      fontWeight: wallpaperOn ? "500" : "400",
      lineHeight: wallpaperOn ? 1.15 : 1,
    };
    scheduleResize();
  };
  const terminalFontColorInput = document.getElementById("terminal-font-color") as HTMLInputElement;
  terminalFontColorInput.addEventListener("input", () => {
    terminalFontColor = normalizeHexColor(terminalFontColorInput.value);
    if (terminalFontColor) writeStored("pi.terminalFontColor", terminalFontColor);
    applyTerminalTypography();
    refreshSettingsUI();
  });
  document.getElementById("terminal-font-color-reset")!.addEventListener("click", () => {
    terminalFontColor = null;
    try { localStorage.removeItem("pi.terminalFontColor"); } catch { /* Storage may be unavailable. */ }
    applyTerminalTypography();
    refreshSettingsUI();
  });
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

  let assistantIconUrl = "";
  const assistantIconFile = document.getElementById("assistant-icon-file") as HTMLInputElement;
  const assistantIconImport = document.getElementById("assistant-icon-import") as HTMLButtonElement;
  const assistantIconReset = document.getElementById("assistant-icon-reset") as HTMLButtonElement;
  const applyAssistantIcon = (url: string) => {
    if (!url) return;
    if (assistantIconUrl && assistantIconUrl.startsWith("blob:")) URL.revokeObjectURL(assistantIconUrl);
    assistantIconUrl = url;
    conversationView?.setAssistantIcon(url);
    assistantIconReset.disabled = false;
  };
  assistantIconImport.addEventListener("click", () => assistantIconFile.click());
  assistantIconFile.addEventListener("change", () => {
    const file = assistantIconFile.files?.[0];
    assistantIconFile.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024) {
      showToast("图标必须是图片且不能超过 2 MB。", 4000);
      return;
    }
    void storeWallpaper(async () => {
      const image = await createImageBitmap(file);
      if (image.width < 16 || image.height < 16 || image.width > 2048 || image.height > 2048) {
        image.close(); throw new Error("图标尺寸需在 16×16 到 2048×2048 之间。");
      }
      image.close();
      await idbPut("assistant-icon", file);
      writeStored("pi.assistantIconName", file.name.slice(0, 80));
      applyAssistantIcon(URL.createObjectURL(file));
      showToast("模型图标已更新。");
    }).catch(error => showToast(formatUserError(error), 4500));
  });
  assistantIconReset.addEventListener("click", () => {
    void storeWallpaper(async () => {
      await idbDelete("assistant-icon");
      try { localStorage.removeItem("pi.assistantIconName"); } catch {}
      if (assistantIconUrl?.startsWith("blob:")) URL.revokeObjectURL(assistantIconUrl);
      assistantIconUrl = "";
      conversationView?.setAssistantIcon("/app-icon.png");
      assistantIconReset.disabled = true;
      showToast("已恢复默认模型图标。");
    }).catch(error => showToast(formatUserError(error), 4500));
  });
  void idbGet("assistant-icon").then(blob => {
    if (blob) { applyAssistantIcon(URL.createObjectURL(blob)); }
    else assistantIconReset.disabled = true;
  }).catch(() => { assistantIconReset.disabled = true; });

  const fontFileInput = document.getElementById("custom-font-file") as HTMLInputElement;
  const prepareFontFace = async (blob: Blob, name: string) => {
    const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (!isSupportedFontFile(name, blob.size, header)) throw new Error("Unsupported font file");
    return new FontFace(CUSTOM_FONT_FAMILY, await blob.arrayBuffer()).load();
  };
  const applyImportedFont = (face: FontFace, name: string) => {
    if (customFontFace) document.fonts.delete(customFontFace);
    customFontFace = face;
    customFontName = name;
    document.fonts.add(face);
    document.body.style.setProperty("--app-font-family", `"${CUSTOM_FONT_FAMILY}", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`);
    applyTerminalTypography();
    refreshSettingsUI();
  };
  const removeImportedFont = () => {
    if (customFontFace) document.fonts.delete(customFontFace);
    customFontFace = null;
    customFontName = "";
    document.body.style.removeProperty("--app-font-family");
    try { localStorage.removeItem("pi.customFontName"); } catch { /* Storage may be unavailable. */ }
    applyTerminalTypography();
    refreshSettingsUI();
  };
  document.getElementById("custom-font-import")!.addEventListener("click", () => fontFileInput.click());
  fontFileInput.addEventListener("change", async () => {
    const file = fontFileInput.files?.[0];
    fontFileInput.value = "";
    if (!file) return;
    const operation = ++fontOperation;
    fontBusy = true;
    refreshSettingsUI();
    try {
      if (file.size > MAX_CUSTOM_FONT_BYTES) {
        showToast(t("settings.fontImportTooLarge"));
        return;
      }
      let face: FontFace;
      try {
        face = await prepareFontFace(file, file.name);
      } catch {
        showToast(t("settings.fontImportInvalid"), 4500);
        return;
      }
      try {
        await storeWallpaper(() => idbPut("custom-font", file));
      } catch {
        document.fonts.delete(face);
        showToast(t("settings.fontStorageFailed"), 4500);
        return;
      }
      if (operation !== fontOperation) {
        document.fonts.delete(face);
        return;
      }
      writeStored("pi.customFontName", file.name);
      applyImportedFont(face, file.name);
      showToast(t("settings.fontImportSuccess"));
    } finally {
      if (operation === fontOperation) {
        fontBusy = false;
        refreshSettingsUI();
      }
    }
  });
  document.getElementById("custom-font-reset")!.addEventListener("click", async () => {
    if (fontBusy) return;
    const operation = ++fontOperation;
    fontBusy = true;
    refreshSettingsUI();
    try {
      await storeWallpaper(() => idbDelete("custom-font"));
      if (operation !== fontOperation) return;
      removeImportedFont();
      showToast(t("settings.defaultFont"));
    } catch {
      showToast(t("settings.fontStorageFailed"), 4500);
    } finally {
      if (operation === fontOperation) {
        fontBusy = false;
        refreshSettingsUI();
      }
    }
  });
  const savedFontOperation = fontOperation;
  void idbGet("custom-font").then(async (blob) => {
    if (!blob || savedFontOperation !== fontOperation) return;
    try {
      const name = readStored("pi.customFontName") || "custom-font";
      const face = await prepareFontFace(blob, name);
      if (savedFontOperation !== fontOperation) {
        document.fonts.delete(face);
        return;
      }
      applyImportedFont(face, name);
    } catch {
      showToast(t("settings.fontImportInvalid"), 4500);
    }
  }).catch(() => {});

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
  const settingsNavigation = setupSettingsNavigation(settingsPanel, (tab) => {
    currentTab = tab;
    keybinds?.cancel();
    if (tab === "agents") librarySettings?.refresh();
    if (tab === "market") void agentMarket?.open();
    if (tab === "skills") void skillLibrary?.open();
    if (tab === "harness") void harnessSettings?.refresh();
    if (tab === "usage") void usageSettings?.refresh();
    if (tab === "system") void systemSettings?.refresh();
  });
  const selectTab = settingsNavigation.select;
  const openSettings = (tab = currentTab) => {
    previousFocus = document.activeElement as HTMLElement;
    settingsPanel.hidden = false;
    document.getElementById("app-main")!.inert = true;
    document.getElementById("quickbar")!.inert = true;
    selectTab(tab, true);
    document.getElementById(`tab-${currentTab}`)!.focus();
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
  document.getElementById("permissions-open")!.addEventListener("click", () => openSettings("harness"));
  document.getElementById("wallpaper-type")!.addEventListener("click", () => openSettings("appearance"));
  settingsPanel.addEventListener("click", (event) => {
    if (event.target === settingsPanel) closeSettings();
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
  const providerList = document.getElementById("provider-list") as HTMLDivElement;
  const providerSearch = document.getElementById("provider-search") as HTMLInputElement;
  const providerContent = document.getElementById("provider-content") as HTMLDivElement;
  const providerEmpty = document.getElementById("provider-empty") as HTMLDivElement;
  const providerTitle = document.getElementById("provider-title") as HTMLHeadingElement;
  const providerKey = document.getElementById("provider-apikey") as HTMLInputElement;
  const providerBaseUrl = document.getElementById("provider-baseurl") as HTMLInputElement;
  const providerApi = document.getElementById("provider-api") as HTMLSelectElement;
  const providerKeyState = document.getElementById("provider-key-state") as HTMLParagraphElement;
  const providerSaveStatus = document.getElementById("provider-save-status") as HTMLSpanElement;
  const providerCreateStatus = document.getElementById("provider-create-status") as HTMLDivElement;
  const providerModelCount = document.getElementById("provider-model-count") as HTMLSpanElement;
  const providerVisibleCount = document.getElementById("provider-visible-count") as HTMLSpanElement;
  let allModels: ModelInfo[] = [];
  type ModelProvider = { id: string; api: string; baseurl: string; hasKey: boolean; modelCount: number };
  let allProviders: ModelProvider[] = [];
  let selectedProviderId = "";
  let currentModelRef = "";
  let modelsLoading = true;
  let modelsFailed = false;
  let modelBulk: ReturnType<typeof setupModelBulk> | undefined;
  const providerModels = () => allModels.filter((model) => model.provider === selectedProviderId);
  const renderProviders = () => {
    const query = providerSearch.value.trim().toLowerCase();
    const filtered = allProviders.filter((provider) => provider.id.toLowerCase().includes(query));
    providerList.replaceChildren();
    for (const provider of filtered) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "provider-item" + (provider.id === selectedProviderId ? " active" : "");
      if (provider.id === selectedProviderId) button.setAttribute("aria-current", "true");
      button.dataset.provider = provider.id;
      const badge = document.createElement("span");
      badge.className = "provider-mark";
      badge.textContent = provider.id.slice(0, 1).toUpperCase();
      const name = document.createElement("span");
      name.className = "provider-item-name";
      name.textContent = provider.id;
      const status = document.createElement("span");
      status.className = provider.hasKey ? "provider-key-dot configured" : "provider-key-dot";
      status.title = provider.hasKey ? t("ui.keyConfigured") : t("ui.keyMissing");
      status.setAttribute("aria-label", status.title);
      button.append(badge, name, status);
      providerList.append(button);
    }
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "provider-list-empty";
      empty.textContent = allProviders.length ? t("ui.noProviderMatch") : t("ui.noProvider");
      providerList.append(empty);
    }
  };
  const renderProviderDetails = () => {
    const provider = allProviders.find((entry) => entry.id === selectedProviderId);
    providerContent.hidden = !provider;
    providerEmpty.hidden = Boolean(provider);
    if (!provider) return;
    providerTitle.textContent = provider.id;
    providerModelCount.textContent = t("ui.providerModelCount").replace("{count}", String(provider.modelCount));
    providerKeyState.textContent = t(provider.hasKey ? "ui.keyConfiguredHint" : "ui.keyMissingHint");
    providerKey.placeholder = t(provider.hasKey ? "ui.keepExistingKey" : "ui.enterApiKey");
    providerBaseUrl.value = provider.baseurl;
    if ([...providerApi.options].some((option) => option.value === provider.api)) providerApi.value = provider.api;
    else {
      const option = document.createElement("option");
      option.value = provider.api; option.textContent = provider.api; providerApi.add(option); providerApi.value = provider.api;
    }
    providerSaveStatus.textContent = "";
    providerKey.value = "";
  };
  const refreshCurrentModel = () => {
    const model = allModels.find((entry) => entry.value === currentModelRef);
    const label = document.getElementById("current-model")!;
    label.removeAttribute("data-i18n");
    label.textContent = model?.name || (currentModelRef && currentModelRef !== "/" ? currentModelRef : t("ui.chooseModel"));
    document.getElementById("model-open")!.title = currentModelRef || t("ui.chooseModel");
  };

  const renderModelList = () => {
    const query = modelSearch.value.trim().toLowerCase();
    const providerItems = providerModels();
    const filtered = query
      ? providerItems.filter((m) => m.value.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
      : providerItems;
    providerVisibleCount.textContent = `(${filtered.length})`;
    modelList.textContent = "";
    if (filtered.length === 0) {
      modelBulk?.update(providerItems, filtered, modelsLoading);
      const empty = document.createElement("div");
      empty.className = "model-empty";
      empty.textContent = t(modelsLoading ? "ui.modelLoading" : modelsFailed ? "ui.modelFailed"
        : allModels.length === 0 ? "ui.modelEmpty" : "ui.modelNoMatch");
      modelList.appendChild(empty);
      return;
    }
    renderModelRows(modelList, filtered, currentModelRef, t, modelBulk?.selected);
    modelBulk?.update(providerItems, filtered, modelsLoading);
  };

  modelSearch.addEventListener("input", renderModelList);
  providerSearch.addEventListener("input", renderProviders);
  providerList.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".provider-item");
    if (!button || !allProviders.some((provider) => provider.id === button.dataset.provider)) return;
    selectedProviderId = button.dataset.provider!;
    renderProviders();
    renderProviderDetails();
    modelSearch.value = "";
    renderModelList();
  });
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
    error: (error) => showToast(formatUserError(error), 4500),
  });

  renderModelList();
  let modelLoadGeneration = 0;
  const loadModels = async (throwOnError = false) => {
    const generation = ++modelLoadGeneration;
    modelsLoading = true;
    modelsFailed = false;
    renderModelList();
    try {
      const data = await invoke<{ current: string; models: ModelInfo[]; providers?: ModelProvider[]; removedCount?: number }>("list_models");
      if (generation !== modelLoadGeneration) return;
      const restore = document.getElementById("models-restore") as HTMLButtonElement;
      restore.hidden = !data.removedCount;
      allModels = data.models || [];
      allProviders = data.providers || [];
      currentModelRef = data.current || currentModelRef;
      const currentProvider = currentModelRef.split("/", 1)[0];
      if (!allProviders.some((provider) => provider.id === selectedProviderId)) {
        selectedProviderId = allProviders.some((provider) => provider.id === currentProvider) ? currentProvider : allProviders[0]?.id || "";
      }
      renderProviders();
      renderProviderDetails();
      modelsLoading = false;
      renderModelList();
      refreshCurrentModel();
    } catch (error) {
      if (generation !== modelLoadGeneration) return;
      allModels = [];
      allProviders = [];
      selectedProviderId = "";
      renderProviders();
      renderProviderDetails();
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
    catch (error) { showToast(formatUserError(error), 4500); }
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
    error: (error) => showToast(formatUserError(error), 4500),
  });
  renderModelList();

  // Provider settings are saved separately from model entries; an empty key preserves the stored secret.
  const providerSaveButton = document.getElementById("provider-save-btn") as HTMLButtonElement;
  const saveProvider = async (quiet = false) => {
    if (!selectedProviderId) throw new Error(t("ui.noProvider"));
    const baseurl = providerBaseUrl.value.trim();
    if (baseurl && !isHttpUrl(baseurl)) throw new Error(t("ui.invalidUrl"));
    await invoke("save_model_provider", {
      provider: selectedProviderId,
      api: providerApi.value,
      baseurl,
      apikey: providerKey.value.trim(),
    });
    providerKey.value = "";
    if (!quiet) {
      await loadModels(true);
      providerSaveStatus.textContent = t("ui.providerSaved");
    }
  };
  providerSaveButton.addEventListener("click", async () => {
    providerSaveButton.disabled = true;
    providerSaveStatus.textContent = t("ui.savingProvider");
    try { await saveProvider(); }
    catch (error) { providerSaveStatus.textContent = formatUserError(error); }
    finally { providerSaveButton.disabled = false; }
  });
  const providerCreateButton = document.getElementById("provider-create-btn") as HTMLButtonElement;
  providerCreateButton.addEventListener("click", async () => {
    const id = (document.getElementById("provider-new-id") as HTMLInputElement).value.trim();
    const api = (document.getElementById("provider-new-api") as HTMLSelectElement).value;
    if (!id || /[\/\\\s\0]/.test(id)) {
      providerCreateStatus.textContent = t("ui.invalidProviderId");
      return;
    }
    if (allProviders.some((provider) => provider.id === id)) {
      selectedProviderId = id;
      renderProviders();
      renderProviderDetails();
      providerCreateStatus.textContent = t("ui.providerExists");
      return;
    }
    providerCreateButton.disabled = true;
    providerCreateStatus.textContent = t("ui.savingProvider");
    try {
      await invoke("create_model_provider", { provider: id, api });
      selectedProviderId = id;
      (document.getElementById("provider-new-id") as HTMLInputElement).value = "";
      (document.querySelector(".provider-create") as HTMLDetailsElement).open = false;
      await loadModels(true);
      providerCreateStatus.textContent = t("ui.providerAdded");
    } catch (error) { providerCreateStatus.textContent = formatUserError(error); }
    finally { providerCreateButton.disabled = false; }
  });

  // Add a model to the selected provider; connection fields stay in the provider panel.
  const modelAddBtn = document.getElementById("model-add-btn") as HTMLButtonElement;
  const modelAddStatus = document.getElementById("model-add-status") as HTMLDivElement;
  const inputValue = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
  modelAddBtn.addEventListener("click", async () => {
    const provider = selectedProviderId;
    const api = providerApi.value;
    const baseurl = providerBaseUrl.value.trim();
    const modelid = inputValue("model-add-id");
    const modelname = inputValue("model-add-name");
    if (!provider || !modelid) {
      modelAddStatus.textContent = t("ui.selectProviderAndModel");
      return;
    }
    if (baseurl && !isHttpUrl(baseurl)) {
      modelAddStatus.textContent = t("ui.invalidUrl");
      return;
    }
    modelAddBtn.disabled = true;
    modelAddStatus.textContent = t("ui.addingModel");
    try {
      await saveProvider(true);
      await invoke("add_custom_model", { provider, api, baseurl, apikey: "", modelids: modelid, modelname });
      modelAddStatus.textContent = t("ui.modelAdded").replace("{model}", `${provider}/${modelid}`);
      await loadModels(true);
      (document.getElementById("model-add-id") as HTMLInputElement).value = "";
      (document.getElementById("model-add-name") as HTMLInputElement).value = "";
    } catch (e) {
      modelAddStatus.textContent = `${t("ui.modelAddFailed")}: ${formatUserError(e)}`;
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
      await invoke("install_package", { source });
      pluginStatus.textContent = "已导入，执行 /reload 或重启 pi 后生效";
      invoke("log_debug", { msg: "install_package completed" }).catch(() => {});
    } catch (e) {
      pluginStatus.textContent = "导入失败，请检查来源、权限和网络设置。";
      invoke("log_debug", { msg: "install_package failed" }).catch(() => {});
    } finally {
      pluginInstallBtn.disabled = false;
    }
  });

  // —— 左侧快捷指令栏 ——
  const quickbar = document.getElementById("quickbar") as HTMLDivElement;
  const quickbarToggle = document.getElementById("quickbar-toggle") as HTMLButtonElement;
  const workSidebarToggle = document.getElementById("work-sidebar-toggle") as HTMLButtonElement;
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
    })().catch((error) => showToast(formatUserError(error), 5000)).finally(() => {
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
    workSidebarToggle.setAttribute("aria-expanded", String(open));
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
  workSidebarToggle.addEventListener("click", () => quickbarToggle.click());
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
    }).catch((error) => showToast(formatUserError(error), 5000));
  };
  document.getElementById("new-session")!.addEventListener("click", () => runSessionCommand("/new"));
  document.getElementById("welcome-session")!.addEventListener("click", () => runSessionCommand("/new"));
  document.getElementById("welcome-resume")!.addEventListener("click", () => runSessionCommand("/resume"));

  // —— 底部发送模式：发送 / 控制 / 排队任务 ——
  const sendModeControls = setupSendModeControls({
    root: document.getElementById("sendmode-bar")!,
    initial: readStored("pi.sendMode") || "send",
    changed: mode => { sendMode = mode; writeStored("pi.sendMode", mode); workbench?.refreshStrings(); },
    selected: () => { setTimeout(() => workbench?.focusInput(), 0); },
  });

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
    applyLocalizedControlLabels(document, t);
    refreshSettingsUI();
    applyWallpaper(wallpaperOn, false);
    renderLanguageOptions();
    onLanguageChange?.();
    sounds?.refreshLanguage();
    keybinds?.refreshLanguage();
    librarySettings?.refreshLanguage();
    agentMarket?.refreshLanguage();
    skillLibrary?.refreshLanguage();
    harnessSettings?.refreshLanguage();
    usageSettings?.refreshLanguage();
    systemSettings?.refreshLanguage();
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

  personaSettings = setupPersonaSettings({ invoke, translate: t, formatError: formatUserError });

  renderLanguageOptions();
  applyLanguage(currentLang);

  // —— 对话视图与终端视图互斥，避免原始输出叠在图形对话上 ——
  const hideToggle = document.getElementById("hide-toggle") as HTMLButtonElement;
  const applyHideTerminal = (hidden: boolean) => {
    document.body.classList.toggle("hide-terminal", hidden);
    document.body.classList.toggle("terminal-view", !hidden);
    hideToggle.replaceChildren(icon(hidden ? "terminal-square" : "bot"));
    hideToggle.title = t(hidden ? "title.showCode" : "title.hideCode");
    hideToggle.setAttribute("aria-label", hideToggle.title);
    hideToggle.setAttribute("aria-pressed", String(!hidden));
    writeStored("pi.terminalView", hidden ? "0" : "1");
    if (hidden) setTimeout(() => (document.getElementById("composer-input") as HTMLTextAreaElement | null)?.focus(), 0);
    else setTimeout(focusTerminal, 0);
  };
  hideToggle.addEventListener("click", () => {
    applyHideTerminal(!document.body.classList.contains("hide-terminal"));
  });
  applyHideTerminal(readStored("pi.terminalView") !== "1");

  thinkingControls = setupThinkingControls({invoke, language: () => currentLang, error: (error) => showToast(formatUserError(error))});
  onLanguageChange = () => {
    refreshWindowControls(); refreshRendererStatus(); thinkingControls?.refreshLanguage();
    renderQuickbar(); renderModelList(); refreshCurrentModel(); refreshConnectionStatus();
    applyHideTerminal(document.body.classList.contains("hide-terminal")); refreshWallpaperName();
  };

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
  librarySettings = setupLibrarySettings({ invoke, translate: t, toast: showToast, openMarket: () => selectTab("market") });
  skillLibrary = setupSkillLibrary({invoke, language: () => currentLang, toast: showToast, reconnect: async () => {
    if (!isDesktop) throw Error("浏览器预览未连接本地 Skill 商店服务。");
    await bridgeInvoke("skill_store_restart");
  }, reload: async () => {
    const state = workbench?.getState();
    if (!state?.connected || !state.ready || state.busy || state.commandPending) throw Error("Skill 已保存；请等待 Pi 空闲后重新加载。");
    const expected = await invoke<{data:{skills:{name:string;enabled:boolean}[];revision:number}}>("skill_store_action",{text:JSON.stringify({kind:"skills",action:"list"})});
    const expectedNames = expected.data.skills.filter((skill) => skill.enabled).map((skill) => skill.name);
    await workbench!.executeCommand("/reload");
    const deadline = Date.now() + 12000;
    let skillError = "";
    await new Promise((resolve) => setTimeout(resolve, 400));
    while (Date.now() < deadline) {
      const current = await invoke<{connected:boolean;ready:boolean;commandPending?:boolean;skills?:string[];skillRevision?:number;skillError?:string}>("gui_status");
      if (current.connected && current.ready && !current.commandPending && current.skillRevision === expected.data.revision && expectedNames.every((name) => current.skills?.includes(name))) return;
      skillError = current.skillError || "";
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Error(skillError || "Skill 已保存；Pi 尚未确认重新加载，可稍后重试。");
  }});
  agentMarket = setupAgentMarket({ invoke, translate: t, changed: () => librarySettings?.refresh(), openLibrary: () => selectTab("agents"),
    reconnect: async () => { await bridgeInvoke("skill_store_restart"); } });
  harnessSettings = setupHarnessSettings({ invoke, language: () => currentLang, engine: () => agentRuntime?.engine() || "pi", configured: () => librarySettings?.refresh() });
  usageSettings = setupUsageSettings({ invoke, language: () => currentLang });
  systemSettings = setupSystemSettings({ invoke, language: () => currentLang, notice: showToast, openPiUpdates: () => openSettings("system"),
    checkPiUpdate: isDesktop ? async () => {
      // Pi core checks must not be routed to the selected Claude engine.
      const response = await bridgeInvoke<{ data: unknown }>("gui_action", { action: "check_update" });
      return response.data;
    } : undefined });
  const nativeCommandKey = (event: KeyboardEvent) => {
    const primaryModifier = isWindowsPlatform() ? event.ctrlKey : event.metaKey;
    if (!primaryModifier || event.altKey || !settingsPanel.hidden || !(event.target instanceof Element)
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
      debug(`drag ${p.type} files=${Array.isArray(p.paths) ? p.paths.length : 0}`);
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
          const added = workbench?.addPaths(paths) ?? 0;
          showToast(added > 0 ? `已添加 ${added} 个文件` : "没有添加新文件，请检查路径、重复附件或数量上限");
        } else {
          showToast("没有识别到文件路径", 4000);
        }
      }
    })
    .catch((e) => {
      console.warn("拖放 API 不可用", e);
      debug("onDragDropEvent unavailable");
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
  let lastDiagnosticBridgeState: boolean | undefined;
  const refreshVisibleDiagnostics = () => {
    if (currentTab === "system") void systemSettings?.refresh();
  };
  // Retry and recovery must return to the workspace and session the user was actually using.
  let lastTarget: { cwd?: string; session?: string } = {};
  let savedResumeIdentity = "", resumeStorageFailed = false;
  let libraryLoadedFor = "";
  const connect = async (cwd?: string, session?: string) => {
    if (connecting || connected || !isDesktop) return;
    lastTarget = { cwd, session };
    connecting = true;
    retryConnection.disabled = true;
    connectionError.hidden = true;
    setConnection("ui.connecting", "connecting");
    // Do not probe an absent/previous process while native startup is pending.
    // Resume only after spawn succeeds so its actual error remains visible.
    piRecovery?.pause();
    const generation = ++terminalGeneration;
    try {
      if (document.getElementById("terminal")!.getClientRects().length) fitAddon.fit();
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
        refreshVisibleDiagnostics();
      };
      const info = await bridgeInvoke<{ cwd: string; executable: string; bridgeId: string }>("start_terminal", {
        rows: term.rows, cols: term.cols, onData, onExit, cwd, session,
      });
      if (generation !== terminalGeneration) return;
      connected = !exited;
      sizeReporter.reset();
      if (connected) setConnection("ui.connected", "connected");
      if (info.cwd) lastTarget = { cwd: info.cwd, session };
      updateRuntime(info);
      workbench?.setRuntime(info);
      refreshVisibleDiagnostics();
      const synchronize = (remaining: number) => {
        if (generation !== terminalGeneration || !connected) return;
        void workbench?.synchronize().catch(() => {});
        if (remaining > 0) startupPoll = setTimeout(() => synchronize(remaining - 1), 700);
      };
      synchronize(12);
      piRecovery?.monitor();
      scheduleResize();
      if (connected) focusTerminal();
    } catch (error) {
      if (generation !== terminalGeneration) return;
      connected = false;
      setConnection("ui.connectionFailed", "error");
      document.getElementById("connection-error-text")!.textContent = formatUserError(error, t("ui.connectionFailed"));
      connectionError.hidden = false;
      workbench?.disconnected();
      refreshVisibleDiagnostics();
    } finally {
      if (generation === terminalGeneration) { connecting = false; retryConnection.disabled = false; }
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
    engine: () => agentRuntime?.engine() || "pi",
    beforeSubmit: async (text) => {
      await personaSettings?.flush();
      await agentRuntime?.prepareForSubmit(text);
    },
    invoke,
    matchesShortcut: (id, event) => keybinds?.matches(id, event) ?? false,
    language: () => currentLang,
    mode: () => sendMode,
    toast: showToast,
    conversationSubmit: (text, attachments) => conversationView?.addUserMessage(text, attachments),
    resize: scheduleResize,
    focusTerminal,
    settings: () => openSettings(),
    panelOpened: closeMobileSidebar,
    prepareCommand: () => {
      if (!settingsPanel.hidden) closeSettings();
      if (document.body.classList.contains("terminal-view")) document.getElementById("hide-toggle")!.click();
    },
    stateChanged: (state) => {
      if (state.connected && (agentRuntime?.engine() || "pi") === "pi") systemSettings?.observePiUpdate(state.coreUpdate);
      const bridgeConnected = state.connected === true;
      if (lastDiagnosticBridgeState !== bridgeConnected) {
        lastDiagnosticBridgeState = bridgeConnected;
        refreshVisibleDiagnostics();
      }
      agentSessionStrip.update(state);
      const conversationBridge = workbench?.runtimeId() || "";
      if (state.connected && (agentRuntime?.engine() || "pi") === "pi" && conversationBridge && state.sessionId) {
        conversationSync.observe({ bridgeId: conversationBridge, sessionId: state.sessionId });
      } else if (state.connected === false || (agentRuntime?.engine() || "pi") !== "pi") conversationSync.observe();
      if (state.connected && (agentRuntime?.engine() || "pi") === "pi" && conversationBridge) {
        piPermissions.observe({ bridgeId: conversationBridge, sessionId: state.sessionId || "" }, state.approvals);
      } else piPermissions.observe();
      conversationView?.setState(state);
      harnessSettings?.observe(state.task, state.cwd);
      if (state.cwd) librarySettings?.setWorkspace(state.cwd);
      // Load the Agent picker once per Pi process; the library is served by Pi's GUI extension.
      if (state.connected && state.ready && libraryLoadedFor !== lastTarget.cwd + ":" + (state.sessionId || "")) {
        libraryLoadedFor = lastTarget.cwd + ":" + (state.sessionId || "");
        librarySettings?.refresh();
        if (!document.getElementById("pane-skills")!.hidden) void skillLibrary?.open();
        else void skillLibrary?.refresh();
      }
      // Track the live session so a retry after a crash or /quit resumes it instead of starting fresh.
      if (state.cwd) lastTarget = { cwd: state.cwd, session: state.session || (lastTarget.cwd === state.cwd ? lastTarget.session : undefined) };
      if (state.connected && state.cwd && state.session && !resumeStorageFailed) {
        const identity = JSON.stringify([state.cwd, state.session]);
        if (identity !== savedResumeIdentity) {
          try {
            const raw = localStorage.getItem(RESUME_KEY);
            let prior: ReturnType<typeof readResumeTargets>;
            try { prior = readResumeTargets(raw); }
            catch {
              localStorage.setItem(`${RESUME_KEY}.damaged`, raw || "");
              prior = [];
              showToast(currentLang === "en" ? "Recovery index rebuilt; original sessions and the damaged index are preserved." : "已重建恢复入口；原会话和损坏索引均已保留。", 7000);
            }
            localStorage.setItem(RESUME_KEY, storeResumeTarget(prior, { cwd: state.cwd, session: state.session, updatedAt: Date.now() }));
            savedResumeIdentity = identity;
          } catch (error) { resumeStorageFailed = true; showToast(formatUserError(error), 7000); }
        }
      }
      if (state.model && currentModelRef !== state.model) {
        currentModelRef = state.model;
        refreshCurrentModel();
        renderModelList();
      }
      thinkingControls?.update(state);
      if (state.connected && !connecting) {
        if (state.inputRecovery) {
          document.getElementById("connection-error-text")!.textContent = currentLang === "en"
            ? "The last input is unconfirmed. Stop it first, or restart Pi and review the restored session before resending. Your draft is preserved."
            : "上一条输入尚未确认，草稿已保留。请先停止；若仍未恢复，可重启 Pi，并核对恢复的会话后再发送。";
          retryConnection.textContent = currentLang === "en" ? "Restart Pi" : "重启 Pi";
          connectionError.hidden = false;
        } else if (!connectionError.hidden) { connectionError.hidden = true; setConnection("ui.connected", "connected"); }
      }
    },
    reconnect: async (cwd, session) => {
      if (connecting) throw new Error(t("ui.connecting"));
      await invoke("validate_terminal_target", { cwd, session });
      piRecovery?.pause();
      try { await invoke("stop_terminal"); }
      catch (error) { piRecovery?.monitor(); throw error; }
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
  agentRuntime = setupAgentRuntime({
    desktop: isDesktop,
    invoke,
    workbench: () => workbench ? {
      requireSwitch: forSubmission => workbench!.requireSwitch(forSubmission),
      engineChanged: () => workbench!.engineChanged(),
      setState: (value) => workbench!.setState(value),
      setRuntime: (value) => workbench!.setRuntime(value),
      runtimeId: () => workbench!.runtimeId(),
      getState: () => workbench!.getState(),
      refreshStrings: () => workbench!.refreshStrings(),
      observeEvent: value => workbench!.observeEvent(value),
    } : undefined,
    cwd: () => lastTarget.cwd || readStored("pi.workspace") || "",
    stopPi: async () => {
      piRecovery?.pause();
      terminalGeneration++;
      connecting = false;
      connected = false;
      await bridgeInvoke("stop_terminal", { force: true });
      workbench?.disconnected();
    },
    piConnecting: () => connecting,
    connectPi: async (cwd, session) => {
      await connect(cwd, session);
      if (!connected) throw Error(t("ui.connectionFailed"));
    },
    changed: () => { refreshConnectionStatus(); },
    status: updateRuntime,
    toast: showToast,
  });
  piRecovery = createPiRecovery({
    probe: () => bridgeInvoke("gui_status"),
    confirm: () => confirmPiRecovery(t, currentLang === "en"),
    invalidate: () => {
      terminalGeneration++; clearTimeout(startupPoll); connected = false; connecting = false; libraryLoadedFor = "";
      workbench?.disconnected();
    },
    stop: () => bridgeInvoke("stop_terminal", {force:true}),
    start: async () => {
      outputBatcher.dispose(); outputBatcher = createOutputBatcher((bytes, done) => term.write(bytes, done));
      term.reset();
      await connect(lastTarget.cwd || readStored("pi.workspace") || undefined, lastTarget.session);
      if (!connected) throw Error(document.getElementById("connection-error-text")!.textContent || t("ui.connectionFailed"));
    },
    stalled: (error) => {
      setConnection("ui.connectionFailed", "error");
      document.getElementById("connection-error-text")!.textContent = formatUserError(error, t("ui.connectionFailed"));
      retryConnection.textContent = currentLang === "en" ? "Restart Pi" : "重启 Pi";
      connectionError.hidden = false; workbench?.disconnected();
    },
    recovered: () => {
      if (connecting) return;
      connected = true;
      connectionError.hidden = true; setConnection("ui.connected", "connected");
      void workbench?.synchronize().catch(() => {});
      if (!document.getElementById("pane-skills")!.hidden) void skillLibrary?.open();
    },
  });
  const previousLanguageChange = onLanguageChange;
  onLanguageChange = () => { previousLanguageChange?.(); workbench?.refreshStrings(); thinkingControls?.refreshLanguage(); agentSessionStrip.refreshLanguage(); personaSettings?.refreshLanguage(); };
  if (isDesktop) {
    void bridgeInvoke<{ cwd: string; executable: string }>("get_runtime_info")
      .then(updateRuntime).catch(() => {});
    void skillLibrary.preload();
    void (async () => {
      const workspace = readStored("pi.workspace") || undefined;
      if (await agentRuntime?.restoreStoredEngine()) return;
      try {
        const targets = readResumeTargets(localStorage.getItem(RESUME_KEY));
        const target = workspace ? targets.find(row => row.cwd === workspace) : targets[0];
        if (target) {
          await bridgeInvoke("validate_terminal_target", { cwd: target.cwd, session: target.session });
          if (await confirmSessionResume(t, currentLang === "en", target.cwd, target.updatedAt)) {
            await connect(target.cwd, target.session); return;
          }
        }
      } catch (error) { showToast(formatUserError(error), 7000); }
      await connect(workspace);
    })();
  } else {
    document.getElementById("terminal-welcome")!.hidden = false;
    document.getElementById("runtime-executable")!.textContent = t("ui.notAvailable");
    refreshConnectionStatus();
  }
  retryConnection.addEventListener("click", () => {
    void piRecovery?.restart().catch((error) => showToast(formatUserError(error)));
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
        const exportedPath = await invoke<string>("export_terminal_log", { text, filename });
        const displayName = typeof exportedPath === "string" ? exportedPath.split(/[\\/]/).pop() || exportedPath : "";
        showToast(`${currentLang === "en" ? "Saved" : "已保存"}: ${displayName || (currentLang === "en" ? "Downloads folder" : "下载目录")}`, 5000);
      } catch (error) { showToast(formatUserError(error), 5000); }
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
    if (document.querySelector(".model-dialog-backdrop, .claude-view-modal, .permission-request-backdrop")) return;
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
    settingsNavigation.dispose();
    clearTimeout(resizeTimer);
    clearTimeout(startupPoll);
    workbench?.dispose();
    agentSessionStrip.dispose();
    conversationView?.dispose();
    conversationListeners.forEach((unlisten) => unlisten());
    sounds?.dispose();
    piPermissions.dispose();
    permissionDialog.dispose();
    keybinds?.dispose();
    librarySettings?.dispose();
    agentMarket?.dispose();
    skillLibrary?.dispose();
    thinkingControls?.dispose();
    piRecovery?.dispose();
    harnessSettings?.dispose();
    usageSettings?.dispose();
    systemSettings?.dispose();
    agentRuntime?.dispose();
    modelBulk?.dispose();
    document.removeEventListener("keydown", nativeCommandKey, true);
    cancelAnimationFrame(initialFitFrame);
    initialFitTimers.forEach(clearTimeout);
    outputBatcher.dispose();
    sendModeControls.dispose();
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
  document.getElementById("connection-error-text")!.textContent = formatUserError(error, "应用启动失败");
  document.getElementById("retry-connection")!.addEventListener("click", () => location.reload(), { once: true });
});
