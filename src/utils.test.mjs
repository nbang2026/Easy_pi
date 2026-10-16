import assert from "node:assert/strict";
import test from "node:test";
import { bracketedPaste, clampNumber, isHttpUrl, normalizeSendMode, parseLanguagePack, toReference } from "./utils.ts";

test("stored numbers are finite and clamped", () => {
  assert.equal(clampNumber("Infinity", 10, 28, 14), 14);
  assert.equal(clampNumber(null, 10, 28, 14), 14);
  assert.equal(clampNumber("-10", 10, 28, 14), 10);
  assert.equal(clampNumber("90", 10, 28, 14), 28);
  assert.equal(clampNumber("17", 10, 28, 14), 17);
});
test("unknown send modes fall back to send", () => {
  assert.equal(normalizeSendMode("queue"), "queue");
  assert.equal(normalizeSendMode("control"), "control");
  assert.equal(normalizeSendMode("broken"), "send");
});
test("bracketed paste strips embedded escape sequences", () => {
  assert.equal(bracketedPaste("test\x1b[201~"), "\x1b[200~test[201~\x1b[201~");
});
test("file references preserve spaces, quotes and backslashes", () => {
  assert.equal(toReference("/a/b.ts"), "@/a/b.ts");
  assert.equal(toReference('/a/my "file".ts'), '@"/a/my \\"file\\".ts"');
  assert.equal(toReference("/a/my\\file.ts"), '@"/a/my\\\\file.ts"');
  assert.equal(toReference("/a/\nfile.ts"), "@/a/file.ts");
});
test("only HTTP URLs are accepted", () => {
  assert.equal(isHttpUrl("http://localhost:11434/v1"), true);
  assert.equal(isHttpUrl("https://example.com/v1"), true);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(isHttpUrl("not-a-url"), false);
});
test("language packs accept strings and reject malformed structures", () => {
  assert.equal(parseLanguagePack('{"code":"en-US","strings":{"a":"A"}}').code, "en-us");
  for (const text of ['{}', '{"code":"en","strings":[]}', '{"code":"en","strings":{"a":1}}', '{"code":"constructor","strings":{}}']) {
    assert.throws(() => parseLanguagePack(text));
  }
});
