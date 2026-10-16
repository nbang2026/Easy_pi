import { icon } from "./icons.ts";

export type ModelEditInfo = { provider: string; id: string; name: string; api: string; baseurl: string; hasKey: boolean };
export type ModelEditValues = ModelEditInfo & { originalid: string; apikey: string };
type Translate = (key: string) => string;

function panel(title: string, t: Translate) {
  const previous = document.activeElement as HTMLElement | null;
  const backdrop = document.createElement("div");
  backdrop.className = "model-dialog-backdrop";
  const dialog = document.createElement("section");
  dialog.className = "model-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", title);
  const header = document.createElement("header");
  const heading = document.createElement("h2"); heading.textContent = title;
  const close = document.createElement("button"); close.type = "button"; close.className = "icon-button model-dialog-close";
  close.title = t("ui.close"); close.setAttribute("aria-label", close.title); close.append(icon("x"));
  header.append(heading, close);
  const body = document.createElement("div"); body.className = "model-dialog-body";
  const footer = document.createElement("footer");
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "model-dialog-cancel"; cancel.textContent = t("ui.cancelModelAction");
  footer.append(cancel); dialog.append(header, body, footer); backdrop.append(dialog); document.body.append(backdrop);
  let onCancel = () => {};
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); return; }
    if (event.key !== "Tab") return;
    const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)")];
    const first = controls[0]; const last = controls[controls.length - 1];
    if (!first) return;
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  backdrop.addEventListener("keydown", keydown);
  cancel.addEventListener("click", () => onCancel()); close.addEventListener("click", () => onCancel());
  cancel.focus();
  return { dialog, body, footer, cancel, close, cancelWith(handler: () => void) { onCancel = handler; },
    destroy() { backdrop.removeEventListener("keydown", keydown); backdrop.remove(); if (previous?.isConnected) previous.focus(); } };
}

export function confirmModelRemoval(name: string, value: string, t: Translate): Promise<boolean> {
  return new Promise((resolve) => {
    const ui = panel(t("ui.deleteModel"), t);
    const question = document.createElement("p"); question.className = "model-dialog-question";
    question.textContent = `${t("ui.deleteModelQuestion")} ${name}？`;
    const detail = document.createElement("p"); detail.className = "settings-hint"; detail.textContent = value;
    const note = document.createElement("p"); note.className = "settings-hint"; note.textContent = t("ui.deleteModelConfirm");
    ui.body.append(question, detail, note);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-button model-dialog-delete"; remove.textContent = t("ui.deleteModelAction");
    const finish = (result: boolean) => { ui.destroy(); resolve(result); };
    ui.cancelWith(() => finish(false)); remove.addEventListener("click", () => finish(true)); ui.footer.append(remove);
  });
}

export function confirmModelBatch(models: { name: string; value: string }[], clear: boolean, t: Translate): Promise<boolean> {
  return new Promise((resolve) => {
    const ui = panel(t(clear ? "ui.clearModels" : "ui.deleteSelectedModels"), t);
    const question = document.createElement("p"); question.className = "model-dialog-question";
    question.textContent = `${t(clear ? "ui.clearModelsQuestion" : "ui.deleteSelectedQuestion")} (${models.length})`;
    const items = document.createElement("ul"); items.className = "model-batch-targets";
    for (const model of models) { const item = document.createElement("li"); item.textContent = `${model.name} — ${model.value}`; items.append(item); }
    const note = document.createElement("p"); note.className = "settings-hint"; note.textContent = t("ui.bulkModelsHint");
    ui.body.append(question, items, note);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-button model-dialog-delete"; remove.textContent = t(clear ? "ui.confirmClearModels" : "ui.deleteModelAction");
    let settled = false;
    const finish = (result: boolean) => { if (settled) return; settled = true; ui.destroy(); resolve(result); };
    ui.cancelWith(() => finish(false)); remove.addEventListener("click", () => finish(true)); ui.footer.append(remove);
  });
}

export function editModelDialog(info: ModelEditInfo, t: Translate, save: (values: ModelEditValues) => Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    const ui = panel(t("ui.editModel"), t);
    const form = document.createElement("form"); form.className = "model-edit-form"; ui.body.append(form);
    function field(key: string, value: string, type = "text") {
      const label = document.createElement("label"); const text = document.createElement("span"); text.textContent = t(key);
      const input = document.createElement("input"); input.type = type; input.value = value; input.className = "settings-input"; input.autocomplete = "off"; input.spellcheck = false;
      label.append(text, input); form.append(label); return input;
    }
    const provider = field("ui.provider", info.provider); provider.readOnly = true;
    const name = field("ui.displayName", info.name); name.required = true; name.maxLength = 240;
    const id = field("ui.modelId", info.id); id.required = true; id.maxLength = 400;
    const protocolLabel = document.createElement("label"); const protocolText = document.createElement("span"); protocolText.textContent = t("ui.protocol");
    const api = document.createElement("select"); api.className = "settings-input";
    for (const value of [...new Set([info.api, "openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "mistral-conversations"].filter(Boolean))]) {
      const option = document.createElement("option"); option.value = value; option.textContent = value; api.append(option);
    }
    api.value = info.api; protocolLabel.append(protocolText, api); form.append(protocolLabel);
    const baseurl = field("ui.modelBaseUrl", info.baseurl, "url"); baseurl.placeholder = t("ui.keepProviderDefault");
    const key = field("ui.modelApiKey", "", "password"); key.placeholder = t("ui.keepExistingKey"); key.autocomplete = "new-password";
    const reveal = document.createElement("button"); reveal.type = "button"; reveal.className = "model-key-reveal"; reveal.textContent = t("ui.showModelKey"); reveal.setAttribute("aria-pressed", "false");
    reveal.addEventListener("click", () => { const shown = key.type === "password"; key.type = shown ? "text" : "password"; reveal.setAttribute("aria-pressed", String(shown)); }); key.parentElement!.append(reveal);
    const hint = document.createElement("p"); hint.className = "settings-hint"; hint.textContent = t("ui.modelEditHint");
    const error = document.createElement("p"); error.className = "model-dialog-error"; error.setAttribute("role", "alert"); ui.body.append(hint, error);
    const submit = document.createElement("button"); submit.type = "button"; submit.className = "primary-button model-dialog-save"; submit.textContent = t("ui.saveModel"); ui.footer.append(submit);
    let pending = false;
    ui.cancelWith(() => { if (!pending) { key.value = ""; ui.destroy(); resolve(false); } });
    const saveNow = async () => {
      if (pending || !form.reportValidity()) return;
      pending = true; error.textContent = "";
      const controls = [...ui.dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")]; controls.forEach((control) => { control.disabled = true; });
      try {
        await save({ ...info, originalid: info.id, id: id.value.trim(), name: name.value.trim(), api: api.value, baseurl: baseurl.value.trim(), apikey: key.value.trim() });
        key.value = ""; ui.destroy(); resolve(true);
      } catch (cause) { error.textContent = String(cause); }
      finally { pending = false; controls.forEach((control) => { control.disabled = false; }); }
    };
    submit.addEventListener("click", () => { void saveNow(); }); form.addEventListener("submit", (event) => { event.preventDefault(); void saveNow(); }); name.focus();
  });
}
