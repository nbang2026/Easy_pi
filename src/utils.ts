export type SendMode = "send" | "control" | "queue";

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
