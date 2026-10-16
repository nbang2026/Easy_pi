import { PI_KEYBINDINGS } from "./keybindings-data.ts";
import { icon } from "./icons.ts";

export const GUI_KEYBINDINGS = [
  { id: "gui.palette", def: "super+k", desc: "keybind.palette" },
  { id: "gui.files", def: "super+p", desc: "keybind.files" },
  { id: "gui.review", def: "super+r", desc: "keybind.review" },
  { id: "gui.composer", def: "super+j", desc: "keybind.composer" },
  { id: "gui.save", def: "super+s", desc: "keybind.save" },
  { id: "gui.settings", def: "super+,", desc: "settings.title" },
];
type Overrides = Record<string, string | string[]>;
const names: Record<string, string> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Escape: "escape",
  Enter: "enter", " ": "space", Tab: "tab", Backspace: "backspace", Delete: "delete",
  Home: "home", End: "end", PageUp: "pageUp", PageDown: "pageDown", Insert: "insert",
};
const symbolKeys: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
};

export function normalizeKeyCombo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const aliases: Record<string, string> = { cmd: "super", command: "super", meta: "super", option: "alt", opt: "alt", control: "ctrl", esc: "escape", pageup: "pageUp", pagedown: "pageDown" };
  const parts = value.toLowerCase().split("+").map((part) => aliases[part.trim()] || part.trim());
  const key = parts.pop();
  if (!key || !/^(?:[a-z0-9`\-=\\[\];',./]|space|enter|escape|tab|backspace|delete|up|down|left|right|home|end|pageUp|pageDown|insert|f(?:[1-9]|1[0-2]))$/.test(key)
    || parts.some((part) => !["ctrl", "alt", "shift", "super"].includes(part)) || new Set(parts).size !== parts.length) return null;
  return [...["ctrl", "alt", "shift", "super"].filter((part) => parts.includes(part)), key].join("+");
}

export function keyEventCombo(event: KeyboardEvent): string | null {
  if (event.isComposing || event.keyCode === 229 || /^(Control|Alt|Shift|Meta|CapsLock|Dead|Process|Unidentified)$/.test(event.key)) return null;
  const parts = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (event.metaKey) parts.push("super");
  let key = names[event.key] || event.key.toLowerCase();
  // macOS Option/Shift-modified keys expose glyphs rather than base key identities.
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  if (symbolKeys[event.code]) key = symbolKeys[event.code];
  return normalizeKeyCombo([...parts, key].join("+"));
}

export function terminalKeySequence(event: KeyboardEvent): string | undefined {
  const combo = keyEventCombo(event);
  if (!combo) return;
  const modifier = 1 + Number(!!event.shiftKey) + Number(!!event.altKey) * 2 + Number(!!event.ctrlKey) * 4 + Number(!!event.metaKey) * 8;
  const key = combo.split("+").pop()!;
  const arrows: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };
  if (arrows[key]) return `\x1b[1;${modifier}${arrows[key]}`;
  const codes: Record<string, number> = { enter: 13, tab: 9, escape: 27, backspace: 127, space: 32 };
  if (key.length === 1 || codes[key]) return `\x1b[${codes[key] || key.codePointAt(0)};${modifier}u`;
  const special: Record<string, number> = { insert: 2, delete: 3, pageUp: 5, pageDown: 6 };
  if (special[key]) return `\x1b[${special[key]};${modifier}~`;
  const functions: Record<string, number> = { f1: 11, f2: 12, f3: 13, f4: 14, f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24 };
  if (functions[key] && modifier === 1) return `\x1b[${functions[key]}~`;
}

export function setupKeybindingSettings(options: {
  invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T>;
  translate(key: string): string;
  nativeReady(): boolean;
  storage?: Storage;
}) {
  const storage = options.storage || localStorage;
  const search = document.getElementById("keybind-search") as HTMLInputElement;
  const list = document.getElementById("keybind-list")!;
  const status = document.getElementById("keybind-status")!;
  let overrides: Overrides = {};
  let gui: Overrides = {};
  let recording: string | null = null;
  let saving = false;
  let loading = true;
  let disposed = false;
  let messageKey = "";
  try {
    const stored = JSON.parse(storage.getItem("pi.guiKeybindings") || "{}");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const binding of GUI_KEYBINDINGS) {
        const value = stored[binding.id];
        if (Array.isArray(value) && value.length === 0) gui[binding.id] = [];
        else if (typeof value === "string" && normalizeKeyCombo(value)) gui[binding.id] = normalizeKeyCombo(value)!;
      }
    }
  } catch { /* Fall back to the native GUI defaults. */ }
  const bindings = [...GUI_KEYBINDINGS, ...PI_KEYBINDINGS];
  const keys = (id: string) => {
    const value = (id.startsWith("gui.") ? gui : overrides)[id];
    if (value !== undefined) return (Array.isArray(value) ? value : [value]).map(normalizeKeyCombo).filter(Boolean);
    const defaults = bindings.find((binding) => binding.id === id)?.def || "";
    return defaults.split("(")[0].split(",").map((key) => normalizeKeyCombo(key.trim())).filter(Boolean);
  };
  const matches = (id: string, event: KeyboardEvent) => {
    const combo = keyEventCombo(event);
    return !!combo && keys(id).includes(combo);
  };
  const message = (key: string, extra = "") => {
    messageKey = key;
    status.textContent = key ? options.translate(key) + extra : "";
  };
  const cancel = () => { recording = null; delete document.body.dataset.keyRecording; };
  const save = async (id: string, value?: string) => {
    if (saving || disposed) return;
    if (value) {
      if (id.startsWith("gui.") && !/ctrl|alt|super|f[0-9]+/.test(value)) { message("keybind.needsModifier"); return; }
      if (!id.startsWith("gui.") && /\+f[0-9]+$/.test(value)) { message("keybind.functionModifiers"); return; }
      if (/^super\+(q|w|m|h|space|tab)$/.test(value)) { message("keybind.systemReserved"); return; }
      const conflict = bindings.find((binding) => binding.id !== id
        && (id.startsWith("gui.") || binding.id.startsWith("gui.")) && keys(binding.id).includes(value));
      if (conflict) { message("keybind.conflict", ` ${conflict.id}`); return; }
    }
    saving = true; cancel(); render();
    try {
      if (id.startsWith("gui.")) {
        const updated = { ...gui, [id]: value ?? [] };
        storage.setItem("pi.guiKeybindings", JSON.stringify(updated));
        gui = updated;
        message("keybind.applied");
      } else {
        await options.invoke("set_keybinding", { action: id, keys: value ? [value] : [] });
        if (disposed) return;
        overrides[id] = value ?? [];
        if (options.nativeReady()) {
          try { await options.invoke("gui_action", { action: "keybindings" }); message("keybind.applied"); }
          catch { message("keybind.savedPending"); }
        } else message("keybind.savedPending");
      }
    } catch (error) { status.textContent = String(error); messageKey = ""; }
    finally { saving = false; if (!disposed) render(); }
  };
  const reset = async (id: string) => {
    if (saving || disposed) return;
    saving = true; cancel(); render();
    try {
      if (id.startsWith("gui.")) {
        const updated = { ...gui }; delete updated[id];
        storage.setItem("pi.guiKeybindings", JSON.stringify(updated)); gui = updated;
        message("keybind.applied");
      } else {
        await options.invoke("reset_keybinding", { action: id }); delete overrides[id];
        if (options.nativeReady()) {
          try { await options.invoke("gui_action", { action: "keybindings" }); message("keybind.applied"); }
          catch { message("keybind.savedPending"); }
        } else message("keybind.savedPending");
      }
    } catch (error) { status.textContent = String(error); messageKey = ""; }
    finally { saving = false; if (!disposed) render(); }
  };
  const render = () => {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    for (const binding of bindings.filter((binding) =>
      `${binding.id} ${binding.desc} ${options.translate(binding.desc)}`.toLowerCase().includes(query))) {
      const row = document.createElement("div"); row.className = "keybind-row";
      const description = document.createElement("div"); description.className = "keybind-desc";
      description.textContent = binding.id.startsWith("gui.") ? options.translate(binding.desc) : binding.desc;
      const id = document.createElement("span"); id.className = "keybind-id"; id.textContent = binding.id;
      description.append(id);
      const record = document.createElement("button");
      record.type = "button"; record.className = "keybind-key"; record.dataset.keybind = binding.id;
      record.disabled = saving || loading;
      record.classList.toggle("recording", recording === binding.id);
      record.classList.toggle("custom", (binding.id.startsWith("gui.") ? gui : overrides)[binding.id] !== undefined);
      record.textContent = recording === binding.id ? options.translate("ui.keyRecording") : keys(binding.id).join(", ") || options.translate("keybind.disabled");
      record.title = options.translate("keybind.record");
      record.setAttribute("aria-label", `${description.firstChild?.textContent}: ${record.textContent}`);
      record.addEventListener("click", () => {
        recording = binding.id; document.body.dataset.keyRecording = "1";
        message("keybind.recording"); render();
        list.querySelector<HTMLButtonElement>(`[data-keybind="${binding.id}"]`)?.focus();
      });
      record.addEventListener("contextmenu", (event) => { event.preventDefault(); void reset(binding.id); });
      row.append(description, record);
      for (const [symbol, label, run] of [
        ["ban", "keybind.disable", () => save(binding.id)],
        ["rotate-ccw", "ui.keyReset", () => reset(binding.id)],
      ] as const) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "icon-button keybind-reset"; button.disabled = saving || loading;
        button.title = options.translate(label); button.setAttribute("aria-label", `${button.title} ${binding.id}`);
        button.append(icon(symbol)); button.addEventListener("click", () => { void run(); }); row.append(button);
      }
      list.append(row);
    }
    if (!list.childElementCount) list.textContent = options.translate("ui.noActions");
  };
  const keyboard = (event: KeyboardEvent) => {
    if (!recording || disposed) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === "Escape") { cancel(); message(""); render(); return; }
    if (event.repeat) return;
    const combo = keyEventCombo(event);
    if (combo) void save(recording, combo);
    else if (/^F[0-9]+$/i.test(event.key)) message("keybind.unsupportedKey");
  };
  // Window capture precedes the workbench and modal handlers, including Command shortcuts.
  window.addEventListener("keydown", keyboard, true);
  const searchChanged = () => { cancel(); render(); };
  search.addEventListener("input", searchChanged);
  render();
  const ready = options.invoke<Overrides>("read_keybindings").then((value) => {
    if (disposed) return;
    if (value && typeof value === "object" && !Array.isArray(value)) overrides = value;
    render();
  }).catch((error) => { if (!disposed) status.textContent = String(error); })
    .finally(() => { loading = false; if (!disposed) render(); });
  return {
    ready, matches,
    nativeMatches: (event: KeyboardEvent) => PI_KEYBINDINGS.some((binding) => matches(binding.id, event)),
    refreshLanguage() { render(); if (messageKey) message(messageKey); },
    cancel() { cancel(); render(); },
    dispose() { disposed = true; cancel(); window.removeEventListener("keydown", keyboard, true); search.removeEventListener("input", searchChanged); },
  };
}
