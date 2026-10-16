import { modelKey, type ModelInfo } from "./model-list.ts";

export function setupModelBulk(options: {
  list: HTMLElement; all: HTMLInputElement; remove: HTMLButtonElement; clear: HTMLButtonElement; count: HTMLElement;
  translate(key: string): string;
  confirm(models: ModelInfo[], clear: boolean): Promise<boolean>;
  deleteModels(models: { provider: string; id: string }[]): Promise<void>;
  changed(): void; error(error: unknown): void;
}) {
  const selected = new Set<string>();
  let models: ModelInfo[] = [];
  let visible: ModelInfo[] = [];
  let loading = true;
  let pending = false;
  const refresh = () => {
    const count = visible.filter((model) => selected.has(modelKey(model))).length;
    const busy = loading || pending || options.list.getAttribute("aria-busy") === "true";
    options.all.checked = visible.length > 0 && count === visible.length;
    options.all.indeterminate = count > 0 && count < visible.length;
    options.all.disabled = busy || visible.length === 0;
    options.remove.disabled = busy || selected.size === 0;
    options.clear.disabled = busy || models.length === 0;
    options.count.textContent = `${options.translate("ui.selectedModels")}: ${selected.size}`;
    options.list.querySelectorAll<HTMLInputElement>(".model-checkbox").forEach((input) => {
      const row = input.closest<HTMLElement>(".model-item")!;
      input.checked = selected.has(modelKey({ provider: row.dataset.provider!, id: row.dataset.modelId! }));
      input.disabled = busy;
    });
  };
  const onChange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (!input.classList.contains("model-checkbox") || loading || pending || options.list.getAttribute("aria-busy") === "true") return;
    const row = input.closest<HTMLElement>(".model-item");
    if (!row) return;
    const key = modelKey({ provider: row.dataset.provider!, id: row.dataset.modelId! });
    if (input.checked) selected.add(key); else selected.delete(key);
    refresh();
  };
  const onAll = () => {
    if (options.all.disabled) return;
    for (const model of visible) { if (options.all.checked) selected.add(modelKey(model)); else selected.delete(modelKey(model)); }
    refresh();
  };
  const execute = async (clear: boolean) => {
    if (loading || pending || options.list.getAttribute("aria-busy") === "true") return;
    const targets = models.filter((model) => clear || selected.has(modelKey(model)));
    if (!targets.length) return;
    pending = true; options.list.setAttribute("aria-busy", "true"); refresh();
    options.list.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true; });
    try {
      if (!await options.confirm(targets, clear)) return;
      await options.deleteModels(targets.map(({ provider, id }) => ({ provider, id })));
      for (const model of targets) selected.delete(modelKey(model));
      options.changed();
    } catch (error) { options.error(error); }
    finally {
      pending = false; options.list.removeAttribute("aria-busy");
      options.list.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = false; });
      refresh();
    }
  };
  const onRemove = () => { void execute(false); };
  const onClear = () => { void execute(true); };
  options.list.addEventListener("change", onChange); options.all.addEventListener("change", onAll);
  options.remove.addEventListener("click", onRemove); options.clear.addEventListener("click", onClear);
  const observer = new options.list.ownerDocument.defaultView!.MutationObserver(refresh); observer.observe(options.list, { attributes: true, attributeFilter: ["aria-busy"] });
  refresh();
  return {
    selected,
    update(next: ModelInfo[], filtered: ModelInfo[], isLoading: boolean) {
      models = next; visible = filtered; loading = isLoading;
      if (!loading) { const keys = new Set(models.map(modelKey)); for (const key of selected) { if (!keys.has(key)) selected.delete(key); } }
      refresh();
    },
    dispose() { observer.disconnect(); options.list.removeEventListener("change", onChange); options.all.removeEventListener("change", onAll); options.remove.removeEventListener("click", onRemove); options.clear.removeEventListener("click", onClear); },
  };
}
