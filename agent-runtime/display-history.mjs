const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

// JSON escaping is additive except when two chunks form one surrogate pair.
const appendedBytes = (tail, chunk) => {
  return jsonBytes(tail + chunk) - jsonBytes(tail);
};

export function createDisplayHistory({ maxBytes, maxEntries = 1000 }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("Invalid display history limits.");
  }
  let current, sizes = new WeakMap(), tails = new WeakMap(), bytes = 2, count = 0;
  const measure = history => {
    current = history;
    sizes = new WeakMap();
    tails = new WeakMap();
    bytes = 2 + Math.max(0, history.length - 1);
    for (const entry of history) {
      const size = jsonBytes(entry);
      sizes.set(entry, size); bytes += size;
      if (typeof entry.text === "string") tails.set(entry, entry.text.slice(-1));
    }
    count = history.length;
  };
  const evict = history => {
    let truncated = false;
    while (history.length && (history.length > maxEntries || bytes > maxBytes)) {
      const entry = history.shift();
      bytes -= sizes.get(entry) + (history.length ? 1 : 0);
      sizes.delete(entry); tails.delete(entry); truncated = true;
    }
    count = history.length;
    return truncated;
  };
  return {
    remember(history, value) {
      if (history !== current || history.length !== count) measure(history);
      const streamed = value.type === "text" || value.type === "thinking";
      const previous = streamed ? history.findLast(entry => entry.type === value.type
        && entry.messageId === value.messageId && entry.blockId === value.blockId && entry.runId === value.runId) : null;
      if (previous) {
        const oldSize = sizes.get(previous);
        let size;
        if (value.append && typeof previous.text === "string" && typeof value.text === "string") {
          size = oldSize + appendedBytes(tails.get(previous) || "", value.text);
          previous.text += value.text;
          if (value.text) tails.set(previous, value.text.slice(-1));
        } else {
          previous.text = value.append ? previous.text + value.text : value.text;
          size = jsonBytes(previous);
          if (typeof previous.text === "string") tails.set(previous, previous.text.slice(-1));
          else tails.delete(previous);
        }
        sizes.set(previous, size); bytes += size - oldSize;
      } else {
        const entry = { ...value, ...(streamed ? { append: false } : {}) };
        const size = jsonBytes(entry);
        bytes += size + (history.length ? 1 : 0);
        sizes.set(entry, size); history.push(entry);
        if (typeof entry.text === "string") tails.set(entry, entry.text.slice(-1));
      }
      return evict(history);
    },
    // Reconcile infrequent metadata changes before a durable snapshot.
    trim(history) { measure(history); return evict(history); },
  };
}
