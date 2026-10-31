import test from "node:test";
import assert from "node:assert/strict";
import { createDisplayHistory } from "../agent-runtime/display-history.mjs";

function reference(history, value, maxBytes, maxEntries) {
  const previous = ["text", "thinking"].includes(value.type) ? history.findLast(entry => entry.type === value.type
    && entry.messageId === value.messageId && entry.blockId === value.blockId && entry.runId === value.runId) : null;
  if (previous) previous.text = value.append ? previous.text + value.text : value.text;
  else history.push({ ...value, ...(["text", "thinking"].includes(value.type) ? { append: false } : {}) });
  let truncated = false;
  while (history.length && (history.length > maxEntries || Buffer.byteLength(JSON.stringify(history)) > maxBytes)) {
    history.shift(); truncated = true;
  }
  return truncated;
}

test("incremental history matches exact JSON budgeting for escaped Unicode, replacement and trimming", () => {
  for (const maxBytes of [2, 151, 321, 2048]) {
    const budget = createDisplayHistory({ maxBytes, maxEntries: 9 });
    let actual = [], expected = [];
    const chunks = ["a", "中文", "\n\t\u0000", '"\\', "\ud83d", "\ude80", "🚀", "\udfff", " "];
    for (let i = 0; i < 1500; i++) {
      if (i === 750) { actual = structuredClone(actual); expected = structuredClone(expected); }
      const value = { type: i % 13 === 0 ? "tool" : i % 3 === 0 ? "thinking" : "text",
        messageId: String(Math.floor(i / 21)), blockId: String(i % 2), runId: String(Math.floor(i / 210)),
        text: chunks[i % chunks.length], append: i % 17 !== 0 };
      assert.equal(budget.remember(actual, value), reference(expected, value, maxBytes, 9));
      assert.deepEqual(actual, expected);
      assert.ok(Buffer.byteLength(JSON.stringify(actual)) <= maxBytes);
    }
  }
});

test("surrogate pairs split between streamed chunks use the exact serialized byte count", () => {
  const expected = [], actual = [];
  const budget = createDisplayHistory({ maxBytes: 110 });
  for (const text of ["\ud83d", "\ude80", "\ud83d", "", "\ude80", "\n", "\ud83d", "\ude80"]) {
    const value = { type: "text", messageId: "one", blockId: "0", runId: "one", text, append: true };
    assert.equal(budget.remember(actual, value), reference(expected, value, 110, 1000));
    assert.deepEqual(actual, expected);
  }
});

test("long streaming histories do not repeatedly serialize earlier tool entries", () => {
  let serialized = 0;
  const history = Array.from({ length: 500 }, (_, index) => ({ type: "tool", index,
    toJSON() { serialized++; return { type: this.type, index }; } }));
  const budget = createDisplayHistory({ maxBytes: 256 * 1024 });
  for (let i = 0; i < 20000; i++) budget.remember(history, {
    type: "text", messageId: "long", blockId: "0", runId: "run", append: true, text: "字",
  });
  assert.equal(serialized, 500);
  assert.equal(history.at(-1).text.length, 20000);
  assert.equal(budget.trim(history), false);
  assert.equal(serialized, 1000);
});

test("snapshot trim reconciles changed result metadata and restored histories", () => {
  const budget = createDisplayHistory({ maxBytes: 250 });
  const history = [];
  budget.remember(history, { type: "result", runId: "one" });
  budget.remember(history, { type: "user", text: "second" });
  history[0].error = "x".repeat(300);
  assert.equal(budget.trim(history), true);
  assert.deepEqual(history, [{ type: "user", text: "second" }]);
  const restored = [{ type: "user", text: "restored" }];
  budget.remember(restored, { type: "user", text: "next" });
  assert.equal(restored.length, 2);
});
