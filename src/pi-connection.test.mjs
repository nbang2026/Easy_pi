import test from "node:test";
import assert from "node:assert/strict";
import { createPiRecovery } from "./pi-connection.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function setup(t, overrides = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const pending = new Set();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const handle = set(() => { pending.delete(handle); callback(...args); }, delay);
    pending.add(handle);
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => {
    pending.delete(handle);
    return clear(handle);
  });
  const calls = { probe: [], confirm: [], invalidate: [], stop: [], start: [], stalled: [], recovered: [] };
  const options = { pollMs: 100, timeoutMs: 20, graceMs: 10 };
  for (const name of Object.keys(calls)) {
    options[name] = (...args) => {
      calls[name].push(args);
      if (overrides[name]) return overrides[name](...args);
      if (name === "probe") return Promise.resolve({ connected: true, ready: true, processAlive: true });
      if (name === "confirm") return Promise.resolve(true);
      if (name === "stop" || name === "start") return Promise.resolve();
    };
  }
  const recovery = createPiRecovery(options);
  t.after(() => recovery.dispose());
  return { recovery, calls, pending, async advance(ms) { t.mock.timers.tick(ms); await flush(); } };
}

test("probes are bounded and concurrent checks/monitors share one active probe", async (t) => {
  const probe = deferred();
  const { recovery, calls, advance } = setup(t, { probe: () => probe.promise });
  recovery.monitor();
  recovery.monitor();
  await Promise.all([recovery.check(), recovery.check()]);
  assert.equal(calls.probe.length, 1);
  await advance(19);
  assert.equal(calls.stalled.length, 0);
  await advance(1);
  assert.equal(calls.stalled.length, 1);
  assert.ok(calls.stalled[0][0] instanceof Error);
  assert.equal(calls.stop.length, 0);
  assert.equal(calls.start.length, 0);
  assert.equal(calls.confirm.length, 0);
  probe.resolve({ connected: true });
  await flush();
  assert.equal(calls.recovered.length, 0, "a timed-out probe cannot report recovery later");
});

test("startup pauses absent-process checks and keeps the actual spawn error visible", async (t) => {
  const { recovery, calls, advance } = setup(t, { probe: async () => ({ connected: false, processAlive: false }) });
  recovery.pause();
  await recovery.check();
  await advance(15000);
  assert.equal(calls.probe.length, 0);
  assert.equal(calls.stalled.length, 0, "a pending or failed spawn must not be relabeled as an exited process");
  recovery.monitor();
  await flush();
  assert.equal(calls.probe.length, 1);
  assert.equal(calls.stalled.length, 1, "a real post-spawn exit is still reported");
});

test("pausing invalidates old probes without blocking immediate post-spawn monitoring", async (t) => {
  const stale = deferred();
  let count = 0;
  const { recovery, calls, advance } = setup(t, {
    probe: () => ++count === 1 ? stale.promise : Promise.resolve({ connected: true, processAlive: true }),
  });
  recovery.monitor();
  recovery.pause();
  recovery.monitor();
  await flush();
  stale.resolve({ connected: false, processAlive: false });
  await flush();
  assert.equal(calls.probe.length, 2);
  assert.equal(calls.stalled.length, 0);
  await advance(100);
  assert.equal(calls.probe.length, 3, "only the new generation schedules polling");
});

test("failed restart preserves its startup error instead of polling an absent process", async (t) => {
  const failure = Error("Pi executable could not be started");
  const { recovery, calls, advance } = setup(t, {
    start: async () => { throw failure; },
    probe: async () => ({ connected: false, processAlive: false }),
  });
  await assert.rejects(recovery.restart(), error => error === failure);
  await advance(15000);
  assert.deepEqual(calls.stalled, [[failure]]);
  assert.equal(calls.probe.length, 0);
});

test("a startup exit includes the native redacted error and exit code", async (t) => {
  const { recovery, calls } = setup(t, {
    probe: async () => ({ connected: false, processAlive: false, exitCode: 1,
      startupError: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package [redacted path]" }),
  });
  recovery.monitor();
  await flush();
  assert.match(calls.stalled.at(-1)[0].message, /退出码 1/);
  assert.match(calls.stalled.at(-1)[0].message, /ERR_MODULE_NOT_FOUND/);
  assert.match(calls.stalled.at(-1)[0].message, /草稿保留/);
});

test("monitoring resumed inside a failing start is paused again to preserve its error", async (t) => {
  const failure = Error("Pi startup failed");
  let recovery;
  const state = setup(t, { start: async () => { recovery.monitor(); throw failure; } });
  recovery = state.recovery;
  await assert.rejects(recovery.restart(), error => error === failure);
  await state.advance(15000);
  await recovery.check();
  assert.equal(state.calls.probe.length, 0);
  assert.deepEqual(state.calls.stalled, [[failure]]);
});

test("a lost bridge reports stalled after grace even while the process is alive", async (t) => {
  let status = { connected: true, processAlive: true };
  const { recovery, calls, advance } = setup(t, { probe: async () => status });
  await recovery.check();
  status = { connected: false, ready: false, processAlive: true };
  await recovery.check();
  await advance(9);
  await recovery.check();
  assert.equal(calls.stalled.length, 0);
  await advance(1);
  await recovery.check();
  assert.equal(calls.stalled.length, 1);
  assert.equal(calls.stop.length, 0, "monitoring must never kill a stalled process");
  assert.equal(calls.start.length, 0);
  status = { connected: true, ready: false, processAlive: true };
  await recovery.check();
  assert.deepEqual(calls.recovered, [[status]]);
});

test("a connected selector with ready false remains healthy and never restarts", async (t) => {
  const { recovery, calls, advance } = setup(t, {
    probe: async () => ({ connected: true, ready: false, busy: false, processAlive: true }),
  });
  recovery.monitor();
  await flush();
  await advance(100);
  await advance(100);
  assert.equal(calls.probe.length, 3);
  for (const name of ["stalled", "confirm", "invalidate", "stop", "start"]) assert.equal(calls[name].length, 0, name);
});

test("startup waits are distinguished from process exits without automatic restart", async (t) => {
  let status = { connected: false, processAlive: true, startupElapsedSeconds: 25 };
  const { recovery, calls, advance } = setup(t, { probe: async () => status });
  await recovery.check(); await advance(10); await recovery.check();
  assert.match(calls.stalled.at(-1)[0].message, /仍在运行.*25 秒/);
  assert.match(calls.stalled.at(-1)[0].message, /辅助工具下载/);
  status = { connected: false, processAlive: false, exitCode: 7 };
  await recovery.check();
  assert.match(calls.stalled.at(-1)[0].message, /退出码 7/);
  assert.equal(calls.start.length, 0);
  assert.equal(calls.stop.length, 0);
});

test("canceling explicit restart confirms once and makes no lifecycle mutations", async (t) => {
  const confirmation = deferred();
  const { recovery, calls } = setup(t, { confirm: () => confirmation.promise });
  const first = recovery.restart();
  const second = recovery.restart();
  assert.equal(recovery.busy(), true);
  assert.equal(calls.confirm.length, 1);
  for (const name of ["invalidate", "stop", "start"]) assert.equal(calls[name].length, 0, name);
  confirmation.resolve(false);
  await Promise.all([first, second]);
  assert.equal(recovery.busy(), false);
  for (const name of ["invalidate", "stop", "start"]) assert.equal(calls[name].length, 0, name);
});

test("pending restart is single flight, invalidates before stop, and awaits stop before start", async (t) => {
  const confirmation = deferred(), stopped = deferred(), started = deferred();
  const order = [];
  const { recovery, calls } = setup(t, {
    confirm: () => confirmation.promise,
    invalidate: () => order.push("invalidate"),
    stop: () => { order.push("stop"); return stopped.promise; },
    start: () => { order.push("start"); return started.promise; },
  });
  const restart = recovery.restart();
  await recovery.restart();
  assert.equal(calls.confirm.length, 1);
  assert.deepEqual(order, []);
  confirmation.resolve(true);
  await flush();
  assert.deepEqual(order, ["invalidate", "stop"]);
  await recovery.restart();
  await recovery.check();
  assert.equal(calls.probe.length, 0);
  assert.equal(calls.stop.length, 1);
  assert.equal(calls.start.length, 0);
  stopped.resolve();
  await flush();
  assert.deepEqual(order, ["invalidate", "stop", "start"]);
  assert.equal(recovery.busy(), true);
  await recovery.restart();
  assert.equal(calls.start.length, 1);
  started.resolve();
  await restart;
  assert.equal(recovery.busy(), false);
});

test("failed stop never starts a replacement and an explicit retry can recover", async (t) => {
  const error = new Error("stop failed");
  let attempts = 0;
  const { recovery, calls } = setup(t, {
    stop: async () => { if (++attempts === 1) throw error; },
  });
  await assert.rejects(recovery.restart(), (actual) => actual === error);
  assert.equal(calls.start.length, 0);
  assert.deepEqual(calls.stalled, [[error]]);
  assert.equal(recovery.busy(), false);
  await recovery.restart();
  assert.equal(calls.confirm.length, 2);
  assert.equal(calls.invalidate.length, 2);
  assert.equal(calls.stop.length, 2);
  assert.equal(calls.start.length, 1);
  assert.equal(recovery.busy(), false);
});

test("restart cancels the old poll generation and immediately probes the new process", async (t) => {
  const stale = deferred();
  let probes = 0;
  const { recovery, calls, advance } = setup(t, {
    probe: () => ++probes === 1 ? stale.promise : Promise.resolve({ connected: true, processAlive: true }),
  });
  recovery.monitor();
  assert.equal(calls.probe.length, 1);
  await recovery.restart();
  await flush();
  assert.equal(calls.probe.length, 2, "a stale in-flight poll must not block the replacement process probe");
  stale.resolve({ connected: false, processAlive: false });
  await flush();
  assert.equal(calls.stalled.length, 0, "old process status must not affect the new generation");
  await advance(100);
  assert.equal(calls.probe.length, 3, "stale completion must not create a second polling loop");
});

for (const outcome of ["connected", "exited", "rejected"]) {
  test(`restart ignores an old generation's ${outcome} response while stop is pending`, async (t) => {
    const stale = deferred(), stopped = deferred();
    let probes = 0;
    const { recovery, calls } = setup(t, {
      probe: () => ++probes === 1 ? stale.promise : Promise.resolve({ connected: true }),
      stop: () => stopped.promise,
    });
    recovery.monitor();
    const restart = recovery.restart();
    await flush();
    assert.equal(calls.stop.length, 1);
    if (outcome === "rejected") stale.reject(new Error("old bridge failed"));
    else stale.resolve({ connected: outcome === "connected", processAlive: outcome !== "exited" });
    await flush();
    assert.equal(calls.stalled.length, 0);
    assert.equal(calls.recovered.length, 0);
    assert.equal(calls.start.length, 0);
    stopped.resolve();
    await restart;
    assert.equal(calls.start.length, 1);
  });
}

test("dispose clears an in-flight probe timeout and ignores late success", async (t) => {
  const probe = deferred();
  const { recovery, calls, pending, advance } = setup(t, { probe: () => probe.promise });
  recovery.monitor();
  assert.equal(pending.size, 1);
  recovery.dispose();
  assert.equal(pending.size, 0, "disposing must clear the bounded probe timeout");
  probe.resolve({ connected: true, ready: true });
  await flush();
  await advance(1000);
  await recovery.check();
  recovery.monitor();
  await recovery.restart();
  assert.equal(calls.probe.length, 1);
  for (const name of ["stalled", "recovered", "confirm", "invalidate", "stop", "start"]) assert.equal(calls[name].length, 0, name);
  assert.equal(pending.size, 0);
});

for (const outcome of ["success", "failure"]) {
  test(`dispose ignores late probe ${outcome} and does not schedule another poll`, async (t) => {
    const probe = deferred();
    const { recovery, calls, pending, advance } = setup(t, { probe: () => probe.promise });
    recovery.monitor();
    recovery.dispose();
    if (outcome === "success") probe.resolve({ connected: false, processAlive: false });
    else probe.reject(new Error("late transport failure"));
    await flush();
    await advance(1000);
    assert.equal(calls.stalled.length, 0);
    assert.equal(calls.recovered.length, 0);
    assert.equal(calls.probe.length, 1);
    assert.equal(pending.size, 0);
  });
}

test("dispose clears scheduled polls and prevents a confirmed pending restart from mutating", async (t) => {
  const confirmation = deferred();
  const { recovery, calls, pending, advance } = setup(t, { confirm: () => confirmation.promise });
  recovery.monitor();
  await flush();
  assert.equal(pending.size, 1);
  const restart = recovery.restart();
  recovery.dispose();
  confirmation.resolve(true);
  await restart;
  await advance(1000);
  assert.equal(pending.size, 0);
  assert.equal(calls.probe.length, 1);
  for (const name of ["invalidate", "stop", "start"]) assert.equal(calls[name].length, 0, name);
});
