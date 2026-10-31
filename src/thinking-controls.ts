type ThinkingState = { ready?: boolean; busy?: boolean; connected?: boolean; model?: string; thinking?: string; thinkingSupported?: boolean; thinkingLevels?: string[] };
export function setupThinkingControls(options: {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  language(): string;
  error(error: unknown): void;
}) {
  const select = document.getElementById("thinking-select") as HTMLSelectElement;
  const labels: Record<string, [string, string]> = { off: ["关", "Off"], minimal: ["极低", "Minimal"], low: ["低", "Low"], medium: ["中", "Medium"], high: ["高", "High"], xhigh: ["极高", "Extra high"], max: ["极高", "Max"] };
  let state: ThinkingState = {};
  let pending = false, disposed = false, generation = 0;
  const levels = () => [...new Set(state.thinkingLevels || [])].filter((level) => level in labels);
  const render = () => {
    if (disposed) return;
    const english = options.language() === "en";
    const available = levels();
    select.replaceChildren();
    for (const level of available.length ? available : ["off"]) {
      const option = document.createElement("option"); option.value = level; option.textContent = labels[level][english ? 1 : 0]; select.append(option);
    }
    select.value = available.includes(state.thinking || "") ? state.thinking! : available.includes("off") ? "off" : available[0] || "off";
    const supported = state.thinkingSupported === true && available.some((level) => level !== "off");
    const disabled = pending || !state.connected || !state.ready || !!state.busy || !supported;
    select.disabled = disabled;
    select.closest("label")?.classList.toggle("is-active", supported && !!state.thinking && state.thinking !== "off");
    select.title = !state.connected ? (english ? "Connect the selected model first" : "请先连接当前模型")
      : !supported ? (english ? "The current model does not support native thinking" : "当前模型不支持原生深度思考")
      : pending || state.busy ? (english ? "Wait for the current task" : "请等待当前任务完成")
      : english ? "Thinking effort" : "思考强度";
    select.setAttribute("aria-label", english ? "Thinking effort" : "思考强度");
  };
  const change = async (level: string) => {
    if (disposed || pending || select.disabled || !levels().includes(level)) { render(); return; }
    const current = generation; pending = true; render();
    try {
      const response = await options.invoke<{ data: ThinkingState; state?: ThinkingState }>("gui_action", { action: "thinking", text: level });
      if (disposed || current !== generation) return;
      state = { ...state, ...response.state, ...response.data };
    } catch (error) { if (!disposed && current === generation) options.error(error); }
    finally { pending = false; render(); }
  };
  const onSelect = () => { const level = select.value; render(); void change(level); };
  select.addEventListener("change", onSelect); render();
  return {
    update(value: ThinkingState) {
      if (disposed) return;
      if (value.model !== state.model || value.connected !== state.connected) generation++;
      state = { ...value }; render();
    },
    refreshLanguage: render,
    dispose() { disposed = true; generation++; select.removeEventListener("change", onSelect); },
  };
}
