export const MAX_PERSONA_BYTES = 48 * 1024;
const AUTO_SAVE_DELAY_MS = 350;

type Options = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  translate: (key: string) => string;
  formatError?: (error: unknown) => string;
};

export function validatePersona(value: string): string {
  if (value.includes("\0")) throw new Error("persona.invalid");
  if (new TextEncoder().encode(value).byteLength > MAX_PERSONA_BYTES) throw new Error("persona.tooLarge");
  return value;
}

export function setupPersonaSettings(options: Options) {
  const textarea = document.getElementById("persona-text") as HTMLTextAreaElement;
  const status = document.getElementById("persona-status") as HTMLDivElement;
  const file = document.getElementById("persona-file") as HTMLInputElement;
  const importButton = document.getElementById("persona-import-btn") as HTMLButtonElement;
  const saveButton = document.getElementById("persona-save-btn") as HTMLButtonElement;
  const clearButton = document.getElementById("persona-clear-btn") as HTMLButtonElement;
  let disposed = false;
  let importing = false;
  let loaded = false;
  let savedText = "";
  let editRevision = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let activeSave: Promise<void> | undefined;
  let statusKey = "persona.loading";
  let statusText = "";

  const currentText = () => textarea.value.trim() ? textarea.value : "";
  const render = () => {
    textarea.disabled = importing || !loaded;
    importButton.disabled = importing || !loaded;
    saveButton.disabled = importing || !loaded || !!activeSave || currentText() === savedText;
    clearButton.disabled = importing || !loaded || !!activeSave || (!savedText && !currentText());
    status.textContent = statusText || (statusKey ? options.translate(statusKey) : "");
  };
  const showError = (error: unknown) => {
    const key = error instanceof Error ? error.message : "";
    statusKey = "";
    statusText = key === "persona.tooLarge" || key === "persona.invalid"
      ? options.translate(key)
      : options.formatError?.(error) || options.translate("persona.failed");
  };
  const clearTimer = () => {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = undefined;
  };

  const persistCurrent = async (): Promise<void> => {
    if (disposed || !loaded) return;
    clearTimer();

    if (activeSave) {
      await activeSave.catch(() => {});
      if (disposed) return;
      if (currentText() !== savedText) return persistCurrent();
      return;
    }

    const snapshot = validatePersona(currentText());
    if (snapshot === savedText) {
      statusKey = snapshot ? "persona.saved" : "persona.cleared";
      statusText = "";
      render();
      return;
    }

    const revision = editRevision;
    statusKey = "persona.saving";
    statusText = "";
    render();
    const request = options.invoke("save_persona", { text: snapshot });
    activeSave = request.then(() => {});
    let failure: unknown;
    try {
      await activeSave;
      if (!disposed) {
        savedText = snapshot;
        statusKey = editRevision === revision
          ? (snapshot ? "persona.saved" : "persona.cleared")
          : "persona.pending";
        statusText = "";
      }
    } catch (error) {
      failure = error;
      if (!disposed && editRevision === revision) showError(error);
    } finally {
      activeSave = undefined;
      render();
    }

    if (disposed) return;
    if (editRevision !== revision) return persistCurrent();
    if (failure !== undefined) throw failure;
  };

  const scheduleSave = () => {
    clearTimer();
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void persistCurrent().catch(() => {});
    }, AUTO_SAVE_DELAY_MS);
  };
  const onInput = () => {
    editRevision += 1;
    if (currentText() === savedText) {
      clearTimer();
      statusKey = "";
      statusText = "";
    } else {
      statusKey = "persona.pending";
      statusText = "";
      scheduleSave();
    }
    render();
  };
  const onImport = () => file.click();
  const onFileChange = async () => {
    const selected = file.files?.[0];
    file.value = "";
    if (!selected || importing || !loaded) return;
    clearTimer();
    if (selected.size > MAX_PERSONA_BYTES) {
      showError(new Error("persona.tooLarge"));
      render();
      return;
    }
    importing = true;
    statusKey = "persona.importing";
    statusText = "";
    render();
    try {
      const content = validatePersona(await selected.text());
      if (activeSave) await activeSave.catch(() => {});
      if (disposed) return;
      textarea.value = content;
      editRevision += 1;
      importing = false;
      await persistCurrent();
      statusKey = "persona.loaded";
      statusText = "";
    } catch (error) {
      if (!disposed) showError(error);
    } finally {
      if (!disposed) {
        importing = false;
        render();
      }
    }
  };
  const onSave = () => { void persistCurrent().catch(() => {}); };
  const onClear = () => {
    if (importing || !loaded) return;
    clearTimer();
    textarea.value = "";
    editRevision += 1;
    statusKey = "persona.saving";
    statusText = "";
    render();
    void persistCurrent().catch(() => {});
  };

  textarea.addEventListener("input", onInput);
  importButton.addEventListener("click", onImport);
  file.addEventListener("change", onFileChange);
  saveButton.addEventListener("click", onSave);
  clearButton.addEventListener("click", onClear);
  render();

  void options.invoke("read_persona").then((value) => {
    if (disposed) return;
    if (typeof value !== "string") throw new Error("persona.failed");
    savedText = validatePersona(value);
    textarea.value = savedText;
    loaded = true;
    statusKey = "";
    statusText = "";
    render();
  }).catch((error) => {
    if (disposed) return;
    loaded = true;
    showError(error);
    render();
  });

  return {
    refreshLanguage: render,
    flush: persistCurrent,
    dispose() {
      disposed = true;
      clearTimer();
      textarea.removeEventListener("input", onInput);
      importButton.removeEventListener("click", onImport);
      file.removeEventListener("change", onFileChange);
      saveButton.removeEventListener("click", onSave);
      clearButton.removeEventListener("click", onClear);
    },
  };
}
