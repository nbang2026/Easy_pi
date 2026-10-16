import assert from "node:assert/strict";
import test from "node:test";
import { createOutputBatcher, createSizeReporter } from "./terminal-flow.ts";

function fixture(maxBatch = 65536) {
  const jobs = [];
  const writes = [];
  const callbacks = [];
  const batcher = createOutputBatcher((bytes, done) => {
    writes.push(bytes);
    callbacks.push(done);
  }, (job) => {
    const entry = { job, canceled: false };
    jobs.push(entry);
    return () => { entry.canceled = true; };
  }, maxBatch);
  const tick = () => {
    const entry = jobs.shift();
    if (entry && !entry.canceled) entry.job();
  };
  const drain = () => {
    while (jobs.length || callbacks.length) {
      tick();
      callbacks.shift()?.();
    }
  };
  return { jobs, writes, callbacks, batcher, tick, drain };
}
test("small PTY chunks coalesce without dropping UTF-8, escape codes or their ordering", () => {
  const data = new TextEncoder().encode("\x1b[32m中文输入\x1b[0m\r\n".repeat(300));
  const f = fixture();
  for (const byte of data) f.batcher.push(Uint8Array.of(byte));
  assert.equal(f.jobs.length, 1);
  f.drain();
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0], data);
});
test("output batches stay bounded and wait for xterm parsing before sending another", () => {
  const f = fixture(32);
  const data = Uint8Array.from({ length: 145 }, (_, index) => index);
  f.batcher.push(data);
  f.tick();
  f.batcher.push(Uint8Array.of(255));
  assert.equal(f.writes.length, 1);
  assert.equal(f.jobs.length, 0);
  f.callbacks.shift()();
  f.drain();
  assert.deepEqual(Buffer.concat(f.writes), Buffer.concat([data, Uint8Array.of(255)]));
  assert.ok(f.writes.every((bytes) => bytes.length <= 32));
});
test("disposing cancels queued output and delayed callbacks cannot restart it", () => {
  const f = fixture(1);
  f.batcher.push(Uint8Array.of(1, 2));
  f.tick();
  f.batcher.dispose();
  f.callbacks.shift()();
  f.batcher.push(Uint8Array.of(3));
  f.drain();
  assert.equal(f.writes.length, 1);
  const pending = fixture();
  pending.batcher.push(Uint8Array.of(1));
  pending.batcher.dispose();
  pending.drain();
  assert.equal(pending.writes.length, 0);
});
test("output batch limits are validated", () => {
  assert.throws(() => fixture(0));
  assert.throws(() => fixture(Infinity));
});
test("terminal resizes only notify Pi when rows or columns change", async () => {
  const calls = [];
  const reporter = createSizeReporter(async (rows, cols) => calls.push([rows, cols]));
  for (let index = 0; index < 100; index++) reporter.report(30, 100);
  reporter.report(31, 100);
  reporter.report(31, 101);
  reporter.report(0, 0);
  assert.deepEqual(calls, [[30, 100], [31, 100], [31, 101]]);
  reporter.reset();
  reporter.report(31, 101);
  assert.equal(calls.length, 4);
});
test("failed resizes may retry and stale failures cannot invalidate a newer size", async () => {
  const calls = [];
  const failures = [];
  const reporter = createSizeReporter((rows, cols) => {
    calls.push([rows, cols]);
    return new Promise((_, reject) => failures.push(reject));
  });
  reporter.report(30, 100);
  reporter.report(31, 100);
  failures[0](new Error("old"));
  await Promise.resolve();
  reporter.report(31, 100);
  assert.equal(calls.length, 2);
  failures[1](new Error("current"));
  await Promise.resolve();
  reporter.report(31, 100);
  assert.equal(calls.length, 3);
});
test("a stale failed resize cannot invalidate a newer request for the same dimensions", async () => {
  const calls = [];
  const failures = [];
  const reporter = createSizeReporter((rows, cols) => {
    calls.push([rows, cols]);
    return new Promise((_, reject) => failures.push(reject));
  });
  reporter.report(30, 100);
  reporter.report(31, 100);
  reporter.report(30, 100);
  failures[0](new Error("stale"));
  await Promise.resolve();
  reporter.report(30, 100);
  assert.equal(calls.length, 3);
});
