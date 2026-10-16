type Write = (bytes: Uint8Array, done: () => void) => void;
type Schedule = (flush: () => void) => () => void;

export function createOutputBatcher(
  write: Write,
  schedule: Schedule = (flush) => {
    const timer = setTimeout(flush, 4);
    return () => clearTimeout(timer);
  },
  maxBatch = 64 * 1024,
) {
  if (!Number.isInteger(maxBatch) || maxBatch < 1) throw new Error("Invalid output batch size");
  let chunks: Uint8Array[] = [];
  let head = 0;
  let offset = 0;
  let pending = 0;
  let writing = false;
  let closed = false;
  let cancel: (() => void) | undefined;

  const flush = () => {
    cancel = undefined;
    if (closed || writing || !pending) return;
    const bytes = new Uint8Array(Math.min(pending, maxBatch));
    let written = 0;
    while (written < bytes.length) {
      const chunk = chunks[head];
      const length = Math.min(chunk.length - offset, bytes.length - written);
      bytes.set(chunk.subarray(offset, offset + length), written);
      written += length;
      offset += length;
      if (offset === chunk.length) { head++; offset = 0; }
    }
    pending -= bytes.length;
    if (head === chunks.length) { chunks = []; head = 0; }
    else if (head > 128) { chunks = chunks.slice(head); head = 0; }
    writing = true;
    write(bytes, () => {
      writing = false;
      if (!closed && pending && !cancel) cancel = schedule(flush);
    });
  };

  return {
    push(bytes: Uint8Array) {
      if (closed || !bytes.length) return;
      chunks.push(bytes);
      pending += bytes.length;
      if (!writing && !cancel) cancel = schedule(flush);
    },
    dispose() {
      closed = true;
      cancel?.();
      cancel = undefined;
      chunks = [];
      pending = 0;
    },
  };
}

export function createSizeReporter(send: (rows: number, cols: number) => Promise<unknown>) {
  let last = "";
  let generation = 0;
  return {
    reset() { last = ""; generation++; },
    report(rows: number, cols: number) {
      if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) return;
      const key = `${rows}:${cols}`;
      if (last === key) return;
      last = key;
      const current = ++generation;
      void send(rows, cols).catch(() => {
        if (current === generation && last === key) last = "";
      });
    },
  };
}
