import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { redactUserText, safeUserError } from "../src-tauri/src/privacy.mjs";
import { redactWorkspaceText } from "../src-tauri/src/task-scheduler.mjs";

test("release resource lookup cannot embed or fall back to the developer source path", async () => {
  const source = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.equal((source.match(/env!\("CARGO_MANIFEST_DIR"\)/g) || []).length, 1);
  assert.match(source, /#\[cfg\(debug_assertions\)\]\s*\{\s*let development = PathBuf::from\(env!\("CARGO_MANIFEST_DIR"\)\)\.join\("\.\.\/agent-runtime"\);\s*if development\.is_dir\(\) \{ return Ok\(development\); \}\s*\}/);
});

test("user-facing errors redact credentials, private keys, local paths, and newlines", () => {
  const error = new Error([
    "Request failed for https://alice:password@example.test",
    "Authorization: Bearer abc.def.ghi",
    "api_key=private-value",
    "DB_PASSWORD=database-secret",
    "AWS_SECRET_ACCESS_KEY=aws-secret",
    "DATABASE_URL=postgresql://alice:db-secret@db.example.test/app",
    "sk-ant-abcdefghijklmnop",
    "-----BEGIN PRIVATE KEY-----secret-material-----END PRIVATE KEY-----",
    "/Users/alice/Projects/private/file.ts /home/bob/work/app",
  ].join("\n"));
  const clean = safeUserError(error);
  for (const secret of [
    "alice:password", "abc.def.ghi", "private-value", "database-secret", "aws-secret",
    "alice:db-secret", "sk-ant-abcdefghijklmnop",
    "secret-material", "/Users/alice/Projects", "/home/bob/work",
  ]) assert.equal(clean.includes(secret), false, clean);
  assert.equal(clean.includes("\n"), false);
  assert.match(clean, /\/Users\/\[redacted\]/);
  assert.match(clean, /\/home\/\[redacted\]/);
  assert.match(clean, /https:\/\/\[redacted\]@example\.test/);
  assert.match(clean, /postgresql:\/\/\[redacted\]@db\.example\.test\/app/);
});

test("workspace and scheduler output use the shared credential redactor", () => {
  const clean = redactWorkspaceText("DB_PASSWORD=database-secret DATABASE_URL=postgres://alice:db-secret@host/app");
  assert.doesNotMatch(clean, /database-secret|alice:db-secret/);
  assert.match(clean, /postgres:\/\/\[redacted\]@host\/app/);
});

test("workspace output preserves code indentation, line breaks and evidence paths", () => {
  const source = "1: function run() {\n2:     return '/Users/example/project/src/app.ts';\n3: }\n";
  assert.equal(redactWorkspaceText(source), source);
});

test("quoted credentials containing spaces are completely removed", () => {
  const clean = redactWorkspaceText('DB_PASSWORD="first secret second secret"\nconst next = true;');
  assert.equal(clean, 'DB_PASSWORD="[redacted]"\nconst next = true;');
});

test("truncated keys and quoted values are redacted through the end of input", () => {
  for (const text of [
    'DB_PASSWORD="first secret second secret',
    "-----BEGIN PRIVATE KEY-----\nfirst secret second secret",
  ]) {
    const clean = redactWorkspaceText(text);
    assert.doesNotMatch(clean, /first secret|second secret/);
    assert.match(clean, /\[redacted/);
  }
});

test("error formatting is bounded and falls back for empty values", () => {
  assert.equal(safeUserError(new Error(""), "Fallback"), "Fallback");
  assert.equal(safeUserError(`detail ${"x".repeat(100)}`, "Fallback", 32).length, 32);
  assert.equal(redactUserText("", "Fallback"), "Fallback");
});
