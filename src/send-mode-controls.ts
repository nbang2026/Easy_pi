import { normalizeSendMode } from "./utils.ts";

export function setupSendModeControls(options: {
  root: HTMLElement;
  initial: string;
  changed(mode: "send" | "control" | "queue"): void;
  selected(): void;
}) {
  const apply = (value: string) => {
    const mode = normalizeSendMode(value);
    options.root.querySelectorAll<HTMLButtonElement>("button.sendmode").forEach(button => {
      button.classList.toggle("active", button.dataset.mode === mode);
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    });
    options.changed(mode);
  };
  const click = (event: MouseEvent) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button.sendmode");
    if (!button || !options.root.contains(button) || button.disabled) return;
    apply(button.dataset.mode || "send");
    options.selected();
  };
  options.root.addEventListener("click", click);
  apply(options.initial);
  return { dispose: () => options.root.removeEventListener("click", click) };
}
