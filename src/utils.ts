export type SendMode = "send" | "control" | "queue";

const REDACTED = "[redacted]";

/**
 * Convert an unknown failure into a short, single-line message safe to show in
 * the UI. Native errors can contain command output, credentials, or absolute
 * user paths, so every user-facing catch should pass through this helper.
 */
export function formatUserError(error: unknown, fallback = "操作失败"): string {
  const objectError = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : undefined;
  const rawMessage = error instanceof Error ? error.message
    : typeof objectError?.message === "string" ? objectError.message
    : typeof error === "string" ? error : "";
  let message = rawMessage;
  if (!message.trim()) message = fallback;
  else if (typeof error !== "string") {
    const name = typeof objectError?.name === "string" && objectError.name.trim() ? objectError.name.trim() : "Error";
    message = `${name}: ${message}`;
  }
  message = message
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  message = message
    .replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{8,}/gi, REDACTED)
    .replace(/\b(?:ghp_|github_pat_|glpat-|npm_)[A-Za-z0-9_-]{8,}/gi, REDACTED)
    .replace(/\b(?:AIza)[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/\b(?:AKIA)[A-Z0-9]{12,}\b/g, REDACTED)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, REDACTED)
    .replace(/\b(?:ya29\.)[A-Za-z0-9._-]{12,}/g, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{8,}/gi, (value) => `${value.split(/\s+/, 1)[0]} ${REDACTED}`)
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|secret|token)\b\s*[:=]\s*)(["']?)[^,\s"';&}]+/gi, `$1$2${REDACTED}`)
    .replace(/(https?:\/\/)[^/\s@]+@/gi, `$1${REDACTED}@`)
    .replace(/\/Users\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?/g, "/Users/[redacted]")
    .replace(/\/(?:private\/)?var\/folders\/[^\s"'<>]+/g, "/var/folders/[redacted]")
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "[drive]:/[redacted]")
    .replace(/\\\\[^\\\s"'<>]+(?:\\[^\s"'<>]+)*/g, "[network-path-redacted]");
  if (message.length > 800) message = `${message.slice(0, 797)}…`;
  return message || fallback;
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return value === null || value === "" || !Number.isFinite(number)
    ? fallback : Math.max(min, Math.min(max, number));
}

export function normalizeSendMode(value: unknown): SendMode {
  return value === "control" || value === "queue" ? value : "send";
}

export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(/\x1b/g, "")}\x1b[201~`;
}

export function toReference(path: string): string {
  const safe = path.replace(/[\x00-\x1f\x7f]/g, "");
  return /[\s"'\\]/.test(safe)
    ? `@"${safe.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : `@${safe}`;
}

export function isHttpUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}

export function parseLanguagePack(text: string): {
  code: string; name: string; strings: Record<string, string>;
} {
  const data = JSON.parse(text);
  const code = String(data.code || data.lang || data.locale || "").trim().toLowerCase();
  const name = String(data.name || code).slice(0, 80);
  const strings = data.strings || data.translations;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(code) || ["constructor", "prototype"].includes(code)
    || !strings || typeof strings !== "object" || Array.isArray(strings)
    || Object.values(strings).some((value) => typeof value !== "string")) {
    throw new Error("Invalid language pack");
  }
  return { code, name, strings };
}
