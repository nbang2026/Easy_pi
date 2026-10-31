import test from "node:test";
import assert from "node:assert/strict";
import { readResumeTargets, storeResumeTarget } from "./session-recovery.ts";
test("recovery index retains a bounded latest session per project without storing conversation text", () => {
  let rows = [];
  for (let i = 0; i < 20; i++) rows = readResumeTargets(storeResumeTarget(rows, { cwd: `/project-${i}`, session: `/sessions/${i}.jsonl`, updatedAt: i }));
  assert.equal(rows.length, 12); assert.equal(rows[0].cwd, "/project-19");
  rows = readResumeTargets(storeResumeTarget(rows, { cwd: "/project-19", session: "/sessions/new.jsonl", updatedAt: 25, prompt: "private-message" }));
  assert.equal(rows.length, 12); assert.equal(rows[0].session, "/sessions/new.jsonl");
  assert.ok(!JSON.stringify(rows).includes("private-message"));
});
test("recovery index rejects corrupt/relative/traversal injection records and accepts Windows paths", () => {
  assert.deepEqual(readResumeTargets(null), []);
  for (const raw of ["bad", "{}", JSON.stringify({ version: 1, targets: [{ cwd: "/project", session: "--eval", updatedAt: 1 }] })])
    assert.throws(() => readResumeTargets(raw));
  assert.equal(readResumeTargets(storeResumeTarget([], { cwd: "C:\\project", session: "C:\\sessions\\s.jsonl", updatedAt: 1 })).length, 1);
});
