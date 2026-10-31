const REDACTED = "[redacted]";

// Preserve line positions for workspace excerpts; error formatting is separate.
const lineBreaks = value => (value.match(/\r\n|\r|\n/g) || []).join("");
export function redactCredentials(value) {
  return String(value ?? "")
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/gi,
      match => `[redacted private key]${lineBreaks(match)}`)
    .replace(/\b(?:sk-ant-|sk-|sk_(?:live|test)_)[A-Za-z0-9_-]{8,}/gi, REDACTED)
    .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|npm_)[A-Za-z0-9_-]{8,}/gi, REDACTED)
    .replace(/\b(?:AIza)[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/\b(?:AKIA)[A-Z0-9]{12,}\b/g, REDACTED)
    .replace(/\b(?:xox[baprs]-)[A-Za-z0-9-]{8,}/g, REDACTED)
    .replace(/\b(?:ya29\.)[A-Za-z0-9._-]{12,}/g, REDACTED)
    .replace(/\b(Bearer|Basic)([ \t]+)[A-Za-z0-9+/_.~=-]+/gi, `$1$2${REDACTED}`)
    .replace(/((?:(?:[A-Za-z0-9.-]+[_-])*)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|authorization|private[_-]?key|webhook|secret(?:(?:[_-]?access)?[_-]?key)?|token)\b["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^,\s"';&}]+)/gi,
      (match, prefix) => {
        const value = match.slice(prefix.length);
        const quote = value[0] === "'" || value[0] === '"' ? value[0] : "";
        return `${prefix}${quote}${REDACTED}${lineBreaks(value)}${quote}`;
      })
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, `$1${REDACTED}@`);
}

/** Keep desktop errors concise and hide local paths as well as credentials. */
export function redactUserText(value, fallback = "") {
  const text = redactCredentials(typeof value === "string" ? value : fallback)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!text) return fallback;
  return text
    .replace(/\/Users\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?/g, "/Users/[redacted]")
    .replace(/\/home\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?/g, "/home/[redacted]")
    .replace(/\/root(?:\/[^\s"'<>]*)?/g, "/root/[redacted]")
    .replace(/\/(?:private\/)?var\/folders\/[^\s"'<>]+/g, "/var/folders/[redacted]")
    .replace(/[A-Za-z]:[\\/](?![\\/])[^\s"'<>]+/g, "[drive]:/[redacted]")
    .replace(/\\\\[^\\\s"'<>]+(?:\\[^\s"'<>]+)*/g, "[network-path-redacted]");
}

export function safeUserError(error, fallback = "操作失败", maxLength = 800) {
  const objectError = error && typeof error === "object" ? error : undefined;
  const raw = error instanceof Error ? error.message
    : typeof objectError?.message === "string" ? objectError.message
    : typeof error === "string" ? error : "";
  let text = raw;
  if (!text.trim()) text = fallback;
  else if (typeof error !== "string") {
    const name = typeof objectError?.name === "string" && objectError.name.trim()
      ? objectError.name.trim()
      : "Error";
    text = `${name}: ${text}`;
  }
  const clean = redactUserText(text, fallback);
  return clean.length > maxLength ? `${clean.slice(0, Math.max(0, maxLength - 1))}…` : clean;
}
