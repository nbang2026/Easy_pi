import { invoke as nativeInvoke, isTauri } from "@tauri-apps/api/core";

export const isDesktop = isTauri();

export function invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isDesktop) return nativeInvoke<T>(command, args);
  const reads: Record<string, unknown> = {
    list_models: { current: "", models: [] },
    read_persona: "",
    read_keybindings: {},
    log_debug: undefined,
  };
  if (Object.prototype.hasOwnProperty.call(reads, command)) return Promise.resolve(reads[command] as T);
  return Promise.reject(new Error(
    document.documentElement.lang === "en"
      ? "Browser preview is not connected to the local Pi process."
      : "浏览器预览未连接本地 Pi 进程。",
  ));
}
