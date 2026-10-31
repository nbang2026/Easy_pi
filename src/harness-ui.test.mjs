import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { setupHarnessSettings } from "./harness-settings.ts";
import { setupUsageSettings } from "./usage-settings.ts";
import { HARNESS_DEFAULTS } from "../src-tauri/src/gui-harness.mjs";
import { aggregateUsage, usageRecord } from "../src-tauri/src/gui-usage.mjs";
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
  window.document.write(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const old = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, { document: window.document, window });
  return { window, el: id => window.document.getElementById(id),
    close() { window.happyDOM.abort(); Object.assign(globalThis, old); } };
}
test("execution settings persist typed limits, prohibit false acceptance and preserve unsaved controls", async () => {
  const f = fixture(), calls = [];
  let run = null;
  const ui = setupHarnessSettings({ language: () => "zh", invoke: async (_command, args) => {
    const value = JSON.parse(args.text); calls.push(value);
    return { data: value.action === "history" ? [] : { workspace: "/project", revision: "revision", settings: HARNESS_DEFAULTS, current: run } };
  } });
  try {
    assert.equal(calls.length, 0);
    await ui.refresh(); assert.equal(f.el("harness-pass").disabled, true);
    f.el("harness-maxToolCalls").value = "11"; f.el("harness-maxToolCalls").dispatchEvent(new f.window.Event("input", { bubbles: true }));
    await ui.refresh(); assert.equal(f.el("harness-maxToolCalls").value, "11");
    f.el("harness-form").dispatchEvent(new f.window.Event("submit", { bubbles: true, cancelable: true })); await flush();
    assert.equal(calls.find(call => call.action === "configure").settings.maxToolCalls, 11);
    run = { id: "run", state: "running", usage: { turns: 1, toolCalls: 2, tokens: 3, cost: 0, costKnown: false }, pending: [], events: [] };
    f.el("pane-harness").hidden = false; ui.observe(run);
    assert.equal(f.el("harness-save").disabled, true);
    assert.ok(f.el("harness-run").textContent.includes("费用不完整"));
    assert.equal(f.el("harness-pass").disabled, true);
    ui.observe({ ...run, state: "awaiting_verification" }); assert.equal(f.el("harness-pass").disabled, false);
  } finally { ui.dispose(); f.close(); }
});
test("unlimited hides and disables quota fields, preserves its draft and saves zero quotas without changing permissions", async () => {
  const f = fixture(), calls = [];
  let settings = { ...HARNESS_DEFAULTS, maxMinutes: 30, maxTurns: 100, maxToolCalls: 200, maxTokens: 500000, maxCost: 5 };
  const ui = setupHarnessSettings({ language: () => "zh", invoke: async (_command, args) => {
    const value = JSON.parse(args.text); calls.push(value);
    if (value.action === "history") return { data: [] };
    if (value.action === "configure") settings = value.settings;
    return { data: { workspace: "/project", revision: "r1", settings, current: null } };
  } });
  try {
    await ui.refresh();
    assert.equal(f.el("harness-limits").hidden, false);
    f.el("harness-unlimited").click();
    assert.equal(f.el("harness-limits").hidden, true);
    assert.equal(f.el("harness-maxMinutes").disabled, true);
    await ui.refresh();
    assert.equal(f.el("harness-unlimited").checked, true);
    f.el("harness-form").dispatchEvent(new f.window.Event("submit", { bubbles: true, cancelable: true })); await flush();
    const saved = calls.find(value => value.action === "configure").settings;
    assert.equal(saved.mode, HARNESS_DEFAULTS.mode);
    assert.ok(Object.entries(saved).filter(([key]) => key !== "mode").every(([, value]) => value === 0));
    assert.equal(f.el("harness-limits").hidden, true);
    f.el("harness-unlimited").click();
    assert.equal(f.el("harness-limits").hidden, false);
    assert.equal(f.el("harness-maxMinutes").disabled, false);
    assert.equal(f.el("harness-maxMinutes").value, "30");
    assert.equal(f.el("harness-maxMinutes").min, "0");
    f.el("harness-unlimited").click();
    f.el("harness-unlimited").click();
    assert.equal(f.el("harness-maxToolCalls").value, "200");
  } finally { ui.dispose(); f.close(); }
});

test("usage dashboard renders calendar/totals safely and exports through the native command", async () => {
  const f = fixture(), calls = [];
  const at = Date.now();
  const row = usageRecord({ id: "x", type: "message", message: { role: "assistant", timestamp: at, provider: "<img src=x>", model: "model", usage: { input: 5, output: 2, cacheRead: 3 } } }, "s");
  const data = aggregateUsage([row], {}, at);
  const ui = setupUsageSettings({ language: () => "zh", invoke: async (command, args) => {
    calls.push([command, args]);
    if (command === "export_usage_log") return "/Downloads/test.csv";
    const value = JSON.parse(args.text);
    return { data: value.action === "export" ? { content: "normalized,csv" } : data };
  } });
  try {
    assert.equal(calls.length, 0);
    await ui.refresh();
    assert.equal(f.el("usage-totals").children.length, 4);
    assert.ok(f.el("usage-selected").textContent.includes("费用未知"));
    assert.ok(f.el("usage-analysis-summary").textContent.includes("10 tokens"));
    assert.equal(f.el("usage-chart").querySelectorAll(".usage-trend-day").length, 1);
    f.window.document.querySelector('[data-usage-view="distribution"]').click();
    assert.equal(f.el("usage-chart").querySelectorAll(".usage-distribution li").length, 1);
    f.window.document.querySelector('[data-usage-metric="knownCost"]').click();
    assert.ok(f.el("usage-chart").textContent.includes("$0.0000"));
    f.window.document.querySelector('[data-usage-view="ranking"]').click();
    assert.equal(f.el("usage-chart").querySelectorAll(".usage-ranking tbody tr").length, 1);
    f.window.document.querySelector('[data-usage-view="trend"]').click();
    f.window.document.querySelector('[data-usage-metric="tokens"]').click();
    assert.ok(f.el("usage-chart").querySelectorAll(".usage-trend-segment").length > 0);
    const modelToggle = f.el("usage-legend").querySelector("input");
    modelToggle.click();
    assert.equal(f.el("usage-chart").querySelectorAll(".usage-trend-segment").length, 0);
    assert.equal(f.el("usage-table").querySelector("img"), null);
    assert.ok(f.el("usage-table").textContent.includes("<img src=x>"));
    assert.ok(f.el("usage-calendar").querySelectorAll("button").length >= 28);
    f.el("usage-csv").click(); await flush();
    assert.equal(calls.find(([command]) => command === "export_usage_log")[1].text, "normalized,csv");
    assert.ok(f.el("usage-message").textContent.includes("test.csv"));
    assert.ok(!f.el("usage-message").textContent.includes("/Downloads/"));
    f.el("usage-group").value = "sessions"; f.el("usage-group").dispatchEvent(new f.window.Event("change"));
    assert.ok(f.el("usage-table").textContent.includes("s"));
  } finally { ui.dispose(); f.close(); }
});
test("permissions are discoverable and Claude permissions never call Pi configuration", async () => {
  const f = fixture();
  let engine = "claude"; const calls = [];
  const ui = setupHarnessSettings({ language: () => "zh", engine: () => engine, invoke: async (command, args) => {
    calls.push({ command, args });
    return { cwd: "/project", sessionId: "claude-session", permissionMode: args.action === "permissions" ? args.payload.mode : "ask" };
  } });
  try {
    assert.ok(f.el("permissions-open"));
    await ui.refresh();
    assert.deepEqual(calls, [{ command: "claude_action", args: { action: "status" } }]);
    assert.equal(f.el("harness-save").disabled, true);
    assert.match(f.el("harness-message").textContent, /Claude.*独立审批/);
    assert.ok(f.el("harness-mode").querySelector('option[value="confirm"]'));
    assert.match(f.el("harness-mode").textContent, /Shell 逐次确认/);
    f.el("harness-full-access").click(); await flush();
    assert.deepEqual(calls[1], { command: "claude_action", args: { action: "permissions", payload: {
      mode: "full", expectedWorkspace: "/project", expectedSessionId: "claude-session",
    } } });
    assert.equal(f.el("harness-full-access").disabled, true);
    f.el("harness-restore-permissions").click(); await flush();
    assert.equal(calls[2].args.payload.mode, "ask");
  } finally { ui.dispose(); f.close(); }
});

test("one-click Pi permissions change immediately without saving unsaved task budgets", async () => {
  const f = fixture(), calls = [];
  let settings = { ...HARNESS_DEFAULTS }, revision = "r1";
  const ui = setupHarnessSettings({ language: () => "zh", invoke: async (command, args) => {
    assert.equal(command, "gui_action");
    const value = JSON.parse(args.text); calls.push(value);
    if (value.action === "history") return { data: [] };
    if (value.action === "permissions") { settings = { ...settings, mode: value.mode }; revision = "r2"; }
    return { data: { workspace: "/project", revision, settings, current: null } };
  } });
  try {
    await ui.refresh();
    f.el("harness-maxToolCalls").value = "17";
    f.el("harness-maxToolCalls").dispatchEvent(new f.window.Event("input", { bubbles: true }));
    f.el("harness-full-access").click(); await flush();
    assert.deepEqual(calls.find(value => value.action === "permissions"), { action: "permissions", mode: "autonomous", expectedWorkspace: "/project", expectedRevision: "r1" });
    assert.equal(f.el("harness-maxToolCalls").value, "17");
    assert.equal(settings.maxToolCalls, HARNESS_DEFAULTS.maxToolCalls);
    assert.equal(f.el("harness-mode").value, "autonomous");
    assert.equal(f.el("harness-restore-permissions").disabled, false);
    assert.equal(calls.some(value => value.action === "configure"), false);
    f.el("harness-restore-permissions").click(); await flush();
    assert.equal(calls.at(-1).mode, "confirm");
    assert.equal(calls.at(-1).expectedRevision, "r2");
  } finally { ui.dispose(); f.close(); }
});

test("Claude permission errors remain visible and leave the control retryable", async () => {
  const f = fixture();
  const ui = setupHarnessSettings({ language: () => "en", engine: () => "claude", invoke: async (_command, args) => {
    if (args.action === "permissions") throw Error("Permission target changed");
    return { cwd: "/project", sessionId: null, permissionMode: "ask" };
  } });
  try {
    await ui.refresh(); f.el("harness-full-access").click(); await flush();
    assert.match(f.el("harness-message").textContent, /Permission target changed/);
    assert.equal(f.el("harness-full-access").disabled, false);
    await assert.rejects(ui.allowAll("pi"), /引擎已切换|Engine changed/);
  } finally { ui.dispose(); f.close(); }
});

test("usage refresh ignores late responses after provider switches and reports errors without replacing data", async () => {
  const f = fixture(), pending = [];
  const ui = setupUsageSettings({ language: () => "en", invoke: () => new Promise(resolve => pending.push(resolve)) });
  try {
    const first = ui.refresh(), second = ui.refresh();
    const empty = aggregateUsage([], {}, Date.now());
    pending[1]({ data: empty }); await second;
    const before = f.el("usage-selected").textContent;
    pending[0]({ data: { ...empty, selected: { ...empty.selected, tokens: 999 } } }); await first;
    assert.equal(f.el("usage-selected").textContent, before);
  } finally { ui.dispose(); f.close(); }
});

test("usage trend tooltip exposes daily model detail on hover/focus and switches between tokens and cost", async () => {
  const f = fixture();
  const total = (overrides = {}) => ({
    records: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0,
    cost: 0, knownCost: 0, unknownCost: 0, cacheHit: null, ...overrides,
  });
  const first = { ...total({ records: 1, tokens: 100, knownCost: 0.5, cost: 0.5 }),
    id: "p/model-a", provider: "p", model: "model-a" };
  const later = { ...total({ records: 1, tokens: 40, knownCost: 0.2, cost: 0.2 }),
    id: "p/model-b", provider: "p", model: "model-b" };
  const data = {
    today: total(), last24Hours: total(), month: total(), all: total(),
    selected: total({ records: 2, tokens: 140, knownCost: 0.7, cost: 0.7 }),
    days: [], modelBreakdown: [first, later],
    trend: [
      { ...total({ records: 1, tokens: 100, knownCost: 0.5 }), name: "2026-10-17", models: [first] },
      { ...total({ records: 1, tokens: 40, knownCost: 0.2 }), name: "2026-10-18", models: [later] },
    ],
    sessions: [], tasks: [], rows: [], providers: ["p"], models: ["model-a", "model-b"],
    rowsTruncated: false, modelsTruncated: false, groupsTruncated: false,
  };
  const ui = setupUsageSettings({ language: () => "en", invoke: async () => ({ data }) });
  try {
    await ui.refresh();
    const days = f.el("usage-chart").querySelectorAll(".usage-trend-day");
    assert.equal(days.length, 2);
    const firstIntensity = Number(days[0].querySelector(".usage-trend-segment").dataset.intensity);
    const secondIntensity = Number(days[1].querySelector(".usage-trend-segment").dataset.intensity);
    assert.ok(firstIntensity > secondIntensity, "higher daily usage should use a stronger shade");
    assert.ok(Number(days[0].querySelector(".usage-trend-segment").style.opacity) > Number(days[1].querySelector(".usage-trend-segment").style.opacity));
    assert.equal(days[0].tabIndex, 0);
    assert.equal(days[1].tabIndex, -1);
    days[0].focus();
    let tooltip = f.window.document.querySelector(".usage-chart-tooltip");
    assert.ok(tooltip);
    assert.ok(tooltip.textContent.includes("10–17"));
    assert.ok(tooltip.textContent.includes("Total100"));
    assert.ok(tooltip.textContent.includes("p/model-a100"));
    assert.ok(tooltip.textContent.includes("p/model-b0"));
    assert.equal(days[0].getAttribute("aria-describedby"), tooltip.id);

    days[0].dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    assert.equal(f.window.document.activeElement.getAttribute("aria-label").includes("2026-10-18"), true);
    tooltip = f.window.document.querySelector(".usage-chart-tooltip");
    assert.ok(tooltip.textContent.includes("p/model-b40"));

    f.window.document.querySelector('[data-usage-metric="knownCost"]').click();
    f.el("usage-chart").querySelector(".usage-trend-day").focus();
    tooltip = f.window.document.querySelector(".usage-chart-tooltip");
    assert.ok(tooltip.textContent.includes("$0.5000"));
  } finally { ui.dispose(); f.close(); }
});
