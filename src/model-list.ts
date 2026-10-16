import { icon } from "./icons.ts";

export type ModelInfo = { provider: string; id: string; name: string; value: string; deletable?: boolean; editable?: boolean };

export const modelKey = (model: Pick<ModelInfo, "provider" | "id">): string => JSON.stringify([model.provider, model.id]);

export function renderModelRows(list: HTMLElement, models: ModelInfo[], current: string, translate: (key: string) => string, selected: ReadonlySet<string> = new Set()): void {
  list.replaceChildren();
  for (const model of models) {
    const row = document.createElement("div");
    row.className = "model-item" + (model.value === current ? " active" : "");
    row.dataset.value = model.value;
    row.dataset.provider = model.provider;
    row.dataset.modelId = model.id;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox"; checkbox.className = "model-checkbox";
    checkbox.checked = selected.has(modelKey(model));
    checkbox.setAttribute("aria-label", `${translate("ui.selectModel")}: ${model.name}`);
    row.append(checkbox);
    const select = document.createElement("button");
    select.type = "button";
    select.className = "model-select";
    select.title = model.value;
    select.setAttribute("aria-pressed", String(model.value === current));
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = model.name;
    const sub = document.createElement("span");
    sub.className = "model-sub";
    sub.textContent = model.value;
    select.append(name, sub);
    row.append(select);
    for (const [action, symbol, key] of [["edit", "pencil", "ui.editModel"], ["delete", "trash-2", "ui.deleteModel"]]) {
      const button = document.createElement("button");
      button.type = "button"; button.className = `model-${action} icon-button`;
      button.title = translate(key); button.setAttribute("aria-label", `${button.title}: ${model.name}`);
      button.append(icon(symbol)); row.append(button);
    }
    list.append(row);
  }
}

export function bindModelList(list: HTMLElement, options: {
  confirm(message: string, value: string): boolean | Promise<boolean>;
  translate(key: string): string;
  remove(provider: string, id: string): Promise<void>;
  edit?(provider: string, id: string): Promise<void>;
  select(value: string): Promise<void>;
  error(error: unknown): void;
}): () => void {
  let pending = false;
  const click = async (event: Event) => {
    const target = event.target as Element | null;
    const button = target?.closest<HTMLButtonElement>("button");
    const row = button?.closest<HTMLElement>(".model-item");
    if (!button || !row || !list.contains(row) || button.disabled || pending || list.getAttribute("aria-busy") === "true") return;
    const removing = button.classList.contains("model-delete");
    const editing = button.classList.contains("model-edit");
    if (!removing && !editing && !button.classList.contains("model-select")) return;
    if (removing || editing) event.stopPropagation();
    pending = true;
    list.setAttribute("aria-busy", "true");
    list.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((control) => { control.disabled = true; });
    try {
      if (removing) {
        if (!await options.confirm(row.querySelector(".model-name")?.textContent || row.dataset.value!, row.dataset.value!)) return;
        await options.remove(row.dataset.provider!, row.dataset.modelId!);
      } else if (editing) await options.edit?.(row.dataset.provider!, row.dataset.modelId!);
      else await options.select(row.dataset.value!);
    } catch (error) { options.error(error); }
    finally {
      pending = false;
      list.removeAttribute("aria-busy");
      list.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((control) => { control.disabled = false; });
    }
  };
  list.addEventListener("click", click);
  return () => list.removeEventListener("click", click);
}
