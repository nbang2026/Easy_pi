import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { setupClaudeView } from "./claude-view.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture({ invoke, lang = "en", translate } = {}) {
  const window = new Window({ url: "http://localhost:1423", settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  const document = window.document;
  document.documentElement.lang = lang;
  const focus = document.createElement("button"); document.body.append(focus); focus.focus();
  const container = document.createElement("div"); document.body.append(container);
  const calls = [], toasts = [], statuses = [];
  const view = setupClaudeView({ container, translate, toast: (message) => toasts.push(message), onStatus: (status) => statuses.push(status), invoke: async (command, args) => {
    calls.push({ command, args: structuredClone(args) });
    return invoke ? invoke(command, args) : { ok: true };
  } });
  return { window, document, container, focus, calls, toasts, statuses, view, $: (selector) => container.querySelector(selector), close() { view.dispose(); window.happyDOM.abort(); } };
}
const text = (value, extra = {}) => ({ type: "text", runId: "r1", messageId: "m1", blockId: "b1", text: value, append: true, ...extra });
const approval = (extra = {}) => ({ type: "approval", runId: "r1", approvalId: "a1", toolName: "Bash", input: { command: "pwd" }, ...extra });

test("allow-all sends scoped engine permissions once and remains unavailable for user questions", async () => {
  const f = fixture();
  try {
    f.view.handleEvent({ type: "status", cwd: "/project", sessionId: "s1", permissionMode: "ask" });
    f.view.handleEvent(approval());
    const full = f.$(".claude-view-full-access"); full.click(); full.click();
    await tick();
    assert.deepEqual(f.calls, [{ command: "claude_action", args: { action: "permissions", payload: {
      mode: "full", expectedWorkspace: "/project", expectedSessionId: "s1",
    } } }]);
    assert.equal(f.$('[role="dialog"]'), null);
    f.view.handleEvent(approval({ approvalId: "question", toolName: "AskUserQuestion", questions: [{ question: "Which?" }] }));
    assert.ok(f.$('[role="dialog"]'));
    assert.equal(f.$(".claude-view-full-access"), null);
    assert.equal(f.calls.some(value => value.args.action === "approval"), false);
  } finally { f.close(); }
});

test("production entrypoint streams by block, replaces final snapshots, scopes run identities, and escapes all content", () => {
  const f = fixture();
  try {
    f.view.handleEvent(text("<img src=x onerror=alert(1)>"));
    f.view.handleEvent(text(" tail"));
    assert.equal(f.$(".claude-view-text-content").textContent, "<img src=x onerror=alert(1)> tail");
    f.view.handleEvent(text("final <script>bad()</script>", { append: false }));
    f.view.handleEvent(text("final <script>bad()</script>", { append: false }));
    assert.equal(f.container.querySelectorAll(".claude-view-text-content").length, 1);
    assert.equal(f.$(".claude-view-text-content").textContent, "final <script>bad()</script>");
    f.view.handleEvent(text("!", { eventId: "delta-1" }));
    f.view.handleEvent(text("!", { eventId: "delta-1" }));
    assert.equal(f.$(".claude-view-text-content").textContent, "final <script>bad()</script>!");
    // Identical adjacent deltas without an event identity can be legitimate repeated text.
    f.view.handleEvent(text("ha")); f.view.handleEvent(text("ha"));
    assert.match(f.$(".claude-view-text-content").textContent, /!haha$/);
    f.view.handleEvent(text("Second run", { runId: "r2", append: false }));
    assert.equal(f.container.querySelectorAll(".claude-view-text-content").length, 2);
    assert.equal(f.$("img,script"), null);
  } finally { f.close(); }
});

test("thinking appears only for actual nonempty thinking payload and remains collapsible", () => {
  const f = fixture();
  try {
    f.view.handleEvent({ type: "status", ready: true, busy: true });
    f.view.handleEvent({ ...text(""), type: "thinking" });
    assert.equal(f.$(".claude-view-thinking"), null);
    f.view.handleEvent({ ...text("Observed reasoning summary"), type: "thinking" });
    f.view.handleEvent({ ...text(" continued"), type: "thinking" });
    const thinking = f.$("details.claude-view-thinking");
    assert.equal(thinking.open, false);
    assert.equal(thinking.querySelector(".claude-view-thinking-content").textContent, "Observed reasoning summary continued");
    thinking.open = true;
    f.view.handleEvent({ ...text("Final summary", { append: false }), type: "thinking" });
    assert.equal(thinking.open, true);
    assert.equal(thinking.querySelector(".claude-view-thinking-content").textContent, "Final summary");
    f.view.handleEvent({ ...text("", { append: false }), type: "thinking" });
    assert.equal(thinking.hidden, true);
  } finally { f.close(); }
});

test("tool updates reuse a card while text and tools preserve conversation order", () => {
  const f = fixture();
  try {
    f.view.handleEvent(text("Before"));
    f.view.handleEvent({ type: "tool", runId: "r1", toolId: "t1", name: "Read", input: { path: "<img src=x>" }, status: "running" });
    f.view.handleEvent({ type: "tool", runId: "r1", toolId: "t1", result: { text: "<script>x</script>" }, status: "complete" });
    f.view.handleEvent(text("After", { blockId: "b2", append: false }));
    const children = [...f.$(".claude-view-transcript").children].filter((item) => !item.hidden);
    assert.match(children[0].textContent, /Before/);
    assert.equal(children[1].tagName, "DETAILS");
    assert.match(children[2].textContent, /After/);
    assert.equal(f.container.querySelectorAll(".claude-view-tool").length, 1);
    assert.equal(f.$(".claude-view-tool-state").textContent, "Completed");
    assert.match(f.$(".claude-view-tool-input").textContent, /<img/);
    assert.match(f.$(".claude-view-tool-output").textContent, /<script/);
    assert.equal(f.$("img,script"), null);
  } finally { f.close(); }
});

for (const allow of [true, false]) test(`approval ${allow ? "allow" : "deny"} sends one explicit decision during repeat clicks and duplicate events`, async () => {
  const pending = deferred(); const f = fixture({ invoke: () => pending.promise });
  try {
    f.view.handleEvent(approval()); f.view.handleEvent(approval());
    assert.equal(f.calls.length, 0);
    assert.equal(f.container.querySelectorAll("[role=dialog]").length, 1);
    const accept = f.$(".claude-view-primary"), deny = f.$(".claude-view-deny");
    (allow ? accept : deny).click(); accept.click(); deny.click();
    f.document.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], { command: "claude_action", args: { action: "approval", payload: { approvalId: "a1", allow } } });
    pending.resolve({ ok: true }); await tick();
    assert.equal(f.$("[role=dialog]"), null);
    assert.equal(f.document.activeElement, f.focus);
    f.view.handleEvent(approval()); assert.equal(f.$("[role=dialog]"), null);
  } finally { f.close(); }
});

test("Escape and close explicitly reject approvals, restore focus, and contain keyboard events", async () => {
  const f = fixture(); let bubbled = 0;
  f.document.addEventListener("keydown", () => bubbled++);
  try {
    f.view.handleEvent(approval());
    const dialog = f.$("[role=dialog]");
    const deny = f.$(".claude-view-deny"), allow = f.$(".claude-view-primary");
    assert.equal(f.document.activeElement, deny);
    const full = f.$(".claude-view-full-access");
    allow.focus();
    allow.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(f.document.activeElement, full);
    full.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(f.document.activeElement, f.$(".claude-view-close"));
    f.document.activeElement.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(f.document.activeElement, full);
    f.focus.focus(); assert.ok(dialog.contains(f.document.activeElement));
    f.document.activeElement.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await tick();
    assert.equal(bubbled, 0); assert.equal(f.calls[0].args.payload.allow, false);
    assert.equal(f.document.activeElement, f.focus);
    f.view.handleEvent(approval({ approvalId: "a2" })); f.$(".claude-view-close").click(); await tick();
    assert.equal(f.calls[1].args.payload.allow, false);
  } finally { f.close(); }
});

test("AskUserQuestion requires every answer and sends selected labels plus Other text", async () => {
  const f = fixture();
  try {
    f.view.handleEvent(approval({ toolName: "AskUserQuestion", input: { questions: [
      { header: "Database", question: "Choose a store?", options: [{ label: "SQLite", description: "Local <img src=x>" }, { label: "Postgres" }] },
      { question: "Which features?", multiSelect: true, options: [{ label: "Search" }, { label: "Export" }] },
    ] } }));
    f.$(".claude-view-primary").click();
    assert.equal(f.calls.length, 0); assert.match(f.$("[role=dialog] [role=alert]").textContent, /every question/);
    const fields = f.container.querySelectorAll(".claude-view-question");
    fields[0].querySelector("input[type=radio]").click();
    const checks = fields[1].querySelectorAll("input[type=checkbox]"); checks[0].click(); checks[1].click();
    const other = fields[1].querySelector(".claude-view-other"); other.value = "Offline"; other.dispatchEvent(new f.window.Event("input", { bubbles: true }));
    f.$(".claude-view-primary").click(); await tick();
    assert.deepEqual(f.calls[0].args.payload, { approvalId: "a1", allow: true, answers: { "Choose a store?": "SQLite", "Which features?": "Search, Export, Offline" } });
    assert.equal(f.$("img"), null);
  } finally { f.close(); }
});

test("AskUserQuestion without valid questions never becomes a generic allow button", () => {
  const f = fixture();
  try {
    f.view.handleEvent(approval({ toolName: "AskUserQuestion", questions: [] }));
    f.$(".claude-view-primary").click();
    assert.equal(f.calls.length, 0); assert.match(f.$("[role=dialog] [role=alert]").textContent, /every question/);
  } finally { f.close(); }
});

test("approval resolution advances the queue without a write; a failed transport never sends a conflicting second decision", async () => {
  const f = fixture({ invoke: async () => { throw Error("secret transport response"); } });
  try {
    f.view.handleEvent(approval()); f.view.handleEvent(approval({ approvalId: "a2" }));
    f.view.handleEvent({ type: "approval_resolved", approvalId: "a1" });
    assert.equal(f.calls.length, 0);
    f.$(".claude-view-primary").click(); await tick();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.payload.approvalId, "a2");
    assert.equal(f.$("[role=dialog]"), null);
    f.view.handleEvent(approval({ approvalId: "a2" }));
    f.$(".claude-view-review").click();
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch(f.container.textContent, /secret transport/);
  } finally { f.close(); }
});

test("configure is single-instance, uses explicit memory-only credentials, clears inputs and does not retain the secret", async () => {
  const pending = deferred(); const f = fixture({ invoke: () => pending.promise });
  try {
    const saved = f.view.configure(); assert.equal(f.view.openConnection(), saved);
    const key = f.$("input[name=apiKey]"), model = f.$("input[name=model]"), base = f.$("input[name=baseUrl]");
    assert.equal(key.type, "password"); assert.equal(key.value, "");
    assert.equal(model.value, "deepseek-v4-flash");
    assert.equal(model.placeholder, "模型ID / model ID");
    assert.equal(base.value, "https://api.deepseek.com/anthropic");
    const protocol = f.$("select[name=protocol]"), thinking = f.$("select[name=thinking]");
    assert.equal(protocol.value, "deepseek-messages"); assert.equal(thinking.value, "auto");
    assert.equal(f.$("select[name=effort]").value, "");
    assert.equal(f.$("select[name=maxActiveSubagents]").value, "3");
    assert.deepEqual([...protocol.options].map((option) => option.value), ["deepseek-messages", "openai-completions", "anthropic-messages"]);
    assert.deepEqual([...thinking.options].map((option) => option.value), ["off", "on", "auto"]);
    assert.match(f.$("[role=dialog]").textContent, /Pi credentials are not inherited/);
    assert.match(f.$("[role=dialog]").textContent, /current model’s native capabilities/);
    key.value = "totally-private-credential"; model.value = "custom-model"; base.value = "https://api.example.test/v1";
    f.$(".claude-view-primary").click(); f.$(".claude-view-primary").click();
    assert.equal(key.value, ""); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], { command: "claude_action", args: { action: "configure", payload: { apiKey: "totally-private-credential", model: "custom-model", baseUrl: "https://api.example.test/v1", protocol: "deepseek-messages", thinking: "auto" } } });
    assert.equal(protocol.disabled, true); assert.equal(thinking.disabled, true);
    pending.resolve({ ok: true }); await saved;
    assert.equal(f.$("[role=dialog]"), null); assert.equal(key.value, "");
    assert.equal(f.window.localStorage.length, 0); assert.equal(f.window.sessionStorage.length, 0);
    assert.doesNotMatch(f.container.outerHTML, /totally-private-credential/);
    const again = f.view.configure();
    assert.equal(f.$("input[name=apiKey]").value, ""); assert.equal(f.$("input[name=model]").value, "custom-model");
    assert.equal(f.$("input[name=baseUrl]").value, "https://api.example.test/v1");
    assert.equal(f.$("select[name=protocol]").value, "deepseek-messages"); assert.equal(f.$("select[name=thinking]").value, "auto");
    f.$(".claude-view-cancel").click(); await again;
    assert.equal(f.document.activeElement, f.focus);
  } finally { f.close(); }
});

test("native Claude exposes only its supported connection protocol and omits the Pi parallelism setting", async () => {
  const f = fixture();
  try {
    f.view.setSession({ engine: "claude", model: "configured-claude", configured: true, ready: true, baseUrl: "" });
    const done = f.view.configure();
    const protocol = f.$("select[name=protocol]");
    assert.deepEqual([...protocol.options].map(option => option.value), ["anthropic-messages"]);
    assert.equal(protocol.closest("label").hidden, true);
    assert.equal(f.$("select[name=maxActiveSubagents]").closest("label").hidden, true);
    assert.equal(f.$("input[name=baseUrl]").value, "");
    assert.match(f.$(".claude-view-connection-help").textContent, /Claude/);
    f.$(".claude-view-primary").click(); await done;
    assert.deepEqual(f.calls[0].args.payload, { model: "configured-claude", baseUrl: "", protocol: "anthropic-messages", thinking: "auto" });
  } finally { f.close(); }
});

test("protocol changes select appropriate endpoints, preserve custom URLs, and allow native Anthropic defaults", async () => {
  const f = fixture();
  try {
    const done = f.view.configure();
    const protocol = f.$("select[name=protocol]"), base = f.$("input[name=baseUrl]");
    const changeProtocol = (value) => { protocol.value = value; protocol.dispatchEvent(new f.window.Event("change", { bubbles: true })); };
    assert.equal(base.required, true);
    changeProtocol("openai-completions"); assert.equal(base.value, "https://api.deepseek.com/v1");
    changeProtocol("anthropic-messages"); assert.equal(base.value, ""); assert.equal(base.required, false);
    assert.match(base.previousElementSibling.textContent, /optional/);
    changeProtocol("deepseek-messages"); assert.equal(base.value, "https://api.deepseek.com/anthropic");
    base.value = "https://proxy.example.test/custom";
    changeProtocol("openai-completions"); assert.equal(base.value, "https://proxy.example.test/custom");
    base.value = ""; f.$("input[name=apiKey]").value = "explicit-test-key";
    f.$(".claude-view-primary").click();
    assert.equal(f.calls.length, 0); assert.match(f.$("[role=dialog] [role=alert]").textContent, /Base URL/);
    assert.equal(f.document.activeElement, base);
    changeProtocol("anthropic-messages");
    f.$("input[name=model]").value = "custom-anthropic-model";
    f.$(".claude-view-primary").click(); await done;
    assert.deepEqual(f.calls[0].args.payload, { apiKey: "explicit-test-key", baseUrl: "", model: "custom-anthropic-model", protocol: "anthropic-messages", thinking: "auto" });
    const again = f.view.configure();
    assert.equal(f.$("select[name=protocol]").value, "anthropic-messages"); assert.equal(f.$("input[name=baseUrl]").value, "");
    f.$(".claude-view-cancel").click(); await again;
  } finally { f.close(); }
});

for (const thinking of ["off", "on", "auto"]) test(`selected thinking ${thinking} and optional effort reach the actual configure payload`, async () => {
  const f = fixture();
  try {
    const done = f.view.configure();
    const thinkingInput = f.$("select[name=thinking]"), effort = f.$("select[name=effort]");
    assert.deepEqual([...effort.options].map((option) => option.value), ["", "low", "high", "max"]);
    effort.value = "high";
    thinkingInput.value = thinking; thinkingInput.dispatchEvent(new f.window.Event("change", { bubbles: true }));
    assert.equal(effort.disabled, thinking === "off");
    f.$("input[name=apiKey]").value = "explicit-test-key";
    f.$(".claude-view-primary").click(); await done;
    assert.deepEqual(f.calls[0].args.payload, { apiKey: "explicit-test-key", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash", protocol: "deepseek-messages", thinking, ...(thinking === "off" ? {} : { effort: "high" }) });
    const again = f.view.configure();
    assert.equal(f.$("select[name=thinking]").value, thinking);
    assert.equal(f.$("select[name=effort]").value, thinking === "off" ? "" : "high");
    f.$(".claude-view-cancel").click(); await again;
  } finally { f.close(); }
});

test("connection requires an explicit key and model, and submits trimmed OpenAI-compatible settings", async () => {
  const f = fixture();
  try {
    const done = f.view.configure();
    const key = f.$("input[name=apiKey]"), model = f.$("input[name=model]"), base = f.$("input[name=baseUrl]"), protocol = f.$("select[name=protocol]");
    f.$(".claude-view-primary").click(); assert.equal(f.calls.length, 0); assert.equal(f.document.activeElement, key);
    key.value = " explicit-test-key "; model.value = " ";
    f.$(".claude-view-primary").click(); assert.equal(f.calls.length, 0); assert.equal(f.document.activeElement, model);
    model.value = " freeform-model "; base.value = " https://openai.example.test/v1 ";
    protocol.value = "openai-completions"; protocol.dispatchEvent(new f.window.Event("change", { bubbles: true }));
    f.$(".claude-view-primary").click(); await done;
    assert.deepEqual(f.calls[0].args.payload, { apiKey: "explicit-test-key", baseUrl: "https://openai.example.test/v1", model: "freeform-model", protocol: "openai-completions", thinking: "auto" });
  } finally { f.close(); }
});

test("setSession and status restore only supported nonsecret connection settings", async () => {
  const f = fixture();
  try {
    f.view.setSession({ ready: true, model: "restored-model", baseUrl: "https://proxy.example.test", protocol: "anthropic-messages", thinking: "on", effort: "max" });
    let done = f.view.configure();
    assert.equal(f.$("input[name=apiKey]").value, "");
    assert.equal(f.$("input[name=model]").value, "restored-model");
    assert.equal(f.$("input[name=baseUrl]").value, "https://proxy.example.test");
    assert.equal(f.$("select[name=protocol]").value, "anthropic-messages");
    assert.equal(f.$("select[name=thinking]").value, "on");
    assert.equal(f.$("select[name=effort]").value, "max");
    f.$(".claude-view-cancel").click(); await done;
    f.view.handleEvent({ type: "status", model: "next-model", baseUrl: "http://localhost:8000/v1", protocol: "openai-completions", thinking: "off", effort: null });
    done = f.view.configure();
    assert.equal(f.$("input[name=model]").value, "next-model");
    assert.equal(f.$("input[name=baseUrl]").value, "http://localhost:8000/v1");
    assert.equal(f.$("select[name=protocol]").value, "openai-completions");
    assert.equal(f.$("select[name=thinking]").value, "off");
    assert.equal(f.$("select[name=effort]").value, ""); assert.equal(f.$("select[name=effort]").disabled, true);
    f.$(".claude-view-cancel").click(); await done;
  } finally { f.close(); }
});

test("parallel Agent setting is editable without resending an already configured API key", async () => {
  const f = fixture();
  try {
    f.view.setSession({ ready: true, configured: true, maxActiveSubagents: 4 });
    const done = f.view.configure();
    const key = f.$("input[name=apiKey]"), limit = f.$("select[name=maxActiveSubagents]");
    assert.equal(key.required, false);
    assert.match(key.placeholder, /keep the current key/);
    assert.equal(limit.value, "4");
    limit.value = "2";
    f.$(".claude-view-primary").click(); await done;
    assert.deepEqual(f.calls[0].args.payload, {
      baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash",
      protocol: "deepseek-messages", thinking: "auto", maxActiveSubagents: 2,
    });
    f.view.setSession({ ready: true, configured: true, maxActiveSubagents: 2 });
    const again = f.view.configure();
    assert.equal(f.$("select[name=maxActiveSubagents]").value, "2");
    f.$(".claude-view-cancel").click(); await again;
  } finally { f.close(); }
});

test("subagent lifecycle updates one safe replayable entry with terminal status and result", () => {
  const f = fixture({ lang: "zh-CN" });
  try {
    const start = { type: "agent", runId: "r1", agentId: "child-12345678", status: "running" };
    f.view.handleEvent(start);
    f.view.handleEvent({ ...start, label: "<img src=x>", activity: "Using read" });
    f.view.handleEvent({ ...start, label: "<img src=x>", status: "completed", result: "<script>done()</script>" });
    assert.equal(f.container.querySelectorAll(".claude-view-agent").length, 1);
    assert.equal(f.$(".claude-view-agent-label").textContent, "<img src=x>");
    assert.equal(f.$(".claude-view-agent-state").textContent, "已完成");
    assert.equal(f.$(".claude-view-agent-activity").textContent, "Using read");
    assert.equal(f.$(".claude-view-agent-result").textContent, "<script>done()</script>");
    assert.equal(f.$("img,script"), null);
    f.view.setSession({ ready: true, history: [start, { ...start, status: "completed", result: "Restored result" }] });
    assert.equal(f.container.querySelectorAll(".claude-view-agent").length, 1);
    assert.match(f.$(".claude-view-agent-result").textContent, /Restored result/);
  } finally { f.close(); }
});

for (const lang of ["en", "zh-CN"]) test(`Agent conversation and connection labels are generic and accessible in ${lang}`, async () => {
  const f = fixture({ lang });
  try {
    assert.match(f.$("[role=log]").getAttribute("aria-label"), /Agent/);
    assert.doesNotMatch(f.container.textContent, /Claude/);
    f.view.handleEvent(text("Actual answer"));
    assert.equal(f.$(".claude-view-message-label").textContent, "Agent");
    const done = f.view.configure();
    const dialog = f.$("[role=dialog]");
    assert.match(dialog.querySelector("h2").textContent, /Agent/);
    assert.doesNotMatch(dialog.textContent, /Claude/);
    for (const name of ["protocol", "thinking", "effort", "maxActiveSubagents"]) {
      const select = f.$(`select[name=${name}]`);
      assert.equal(select.closest("label").textContent.length > 0, true);
      select.focus(); assert.equal(f.document.activeElement, select);
    }
    assert.match(f.$(".claude-view-connection-help").textContent, /DeepSeek/);
    f.$(".claude-view-cancel").click(); await done;
  } finally { f.close(); }
});

test("configure rejects remote HTTP and credential-bearing URLs, accepts loopback HTTP, and never echoes a host error", async () => {
  const f = fixture({ invoke: async () => { throw Error("host echoed totally-private-credential <img src=x>"); } });
  try {
    const configured = f.view.configure(); const key = f.$("input[name=apiKey]"), base = f.$("input[name=baseUrl]");
    key.value = "totally-private-credential";
    for (const url of ["http://example.test", "https://name:pass@example.test", "javascript:alert(1)", "https://example.test/?key=bad", "https://example.test/#bad"]) {
      base.value = url; f.$(".claude-view-primary").click(); assert.equal(f.calls.length, 0);
    }
    base.value = "http://127.0.0.1:9999/v1"; f.$(".claude-view-primary").click(); await tick();
    assert.equal(f.calls.length, 1); assert.equal(key.value, "");
    assert.match(f.$("[role=dialog]").textContent, /Could not save/);
    assert.doesNotMatch(f.container.textContent, /totally-private-credential|host echoed/);
    assert.equal(f.$("img"), null);
    f.$(".claude-view-primary").click(); assert.equal(f.calls.length, 1);
    f.$(".claude-view-close").click(); await configured;
  } finally { f.close(); }
});

test("configure cancellation clears drafts and pending success after close does not update the UI", async () => {
  const pending = deferred(); const f = fixture({ invoke: () => pending.promise });
  try {
    const done = f.view.configure(); const key = f.$("input[name=apiKey]"); key.value = "discard-me";
    f.$(".claude-view-primary").click();
    f.document.activeElement.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await done; assert.equal(key.value, ""); assert.equal(f.$("[role=dialog]"), null);
    pending.resolve({ ok: true }); await tick(); assert.equal(f.toasts.length, 0);
  } finally { f.close(); }
});

test("setSession replays safe user history and deduplicates by identity; status renders usage and sanitizes errors", () => {
  const f = fixture();
  try {
    const user = { type: "user", text: "<img src=x> request", messageId: "u1", attachments: [{ name: "<script>file</script>" }] };
    f.view.setSession({ ready: true, model: "claude-opus-5-5", cwd: "/project", history: [user, user, text("Stored answer", { append: false })] });
    assert.equal(f.container.querySelectorAll(".claude-view-user").length, 1);
    assert.match(f.$(".claude-view-attachments").textContent, /<script>/);
    f.view.handleEvent({ type: "result", runId: "r1", sessionId: "s1", usage: { input_tokens: 120, output_tokens: 44 }, cost: 0.1234, error: "bad sk-ant-very-secret-token" });
    assert.match(f.$(".claude-view-usage").textContent, /input 120.*output 44.*\$0.1234/);
    assert.doesNotMatch(f.$(".claude-view-bottom").textContent, /sk-ant/);
    assert.equal(f.statuses.at(-1).sessionId, "s1");
    assert.equal(f.$("img,script"), null);
    f.view.reset(); assert.equal(f.$(".claude-view-empty").hidden, false);
    assert.equal(f.$(".claude-view-usage").textContent, "");
  } finally { f.close(); }
});

test("translation falls back to the document language when the parent has no matching key", () => {
  const f = fixture({ lang: "zh-CN", translate: (key) => key });
  try { assert.match(f.$(".claude-view-status").textContent, /未连接/); }
  finally { f.close(); }
  const g = fixture({ translate: (key) => key === "claude.disconnected" ? "Custom status" : key });
  try { assert.equal(g.$(".claude-view-status").textContent, "Custom status"); }
  finally { g.close(); }
});

test("dispose removes dialogs without engine writes and ignores late async results and streamed events", async () => {
  const pending = deferred(); const f = fixture({ invoke: () => pending.promise });
  try {
    const configured = f.view.configure(); const key = f.$("input[name=apiKey]"); key.value = "dispose-secret";
    f.$(".claude-view-primary").click(); const statuses = f.statuses.length;
    f.view.dispose(); await configured;
    assert.equal(key.value, ""); assert.equal(f.container.childElementCount, 0);
    pending.resolve({ ok: true }); await tick();
    f.view.handleEvent(text("Late answer")); f.view.handleEvent(approval()); f.view.setSession({ ready: true }); await f.view.configure();
    assert.equal(f.calls.length, 1); assert.equal(f.statuses.length, statuses); assert.equal(f.toasts.length, 0);
    assert.equal(f.container.childElementCount, 0);
  } finally { f.close(); }
  const g = fixture();
  try { g.view.handleEvent(approval()); g.view.dispose(); assert.equal(g.calls.length, 0); }
  finally { g.close(); }
});

test("session reset during an approval submission cannot mutate the replacement session", async () => {
  const pending = deferred(); const f = fixture({ invoke: () => pending.promise });
  try {
    f.view.handleEvent(approval()); f.$(".claude-view-primary").click();
    f.view.setSession({ ready: true, history: [text("New session", { runId: "new" })] });
    pending.resolve({ ok: true }); await tick();
    assert.match(f.container.textContent, /New session/); assert.equal(f.$(".claude-view-approval"), null);
    assert.equal(f.$(".claude-view-status").textContent, "Ready");
  } finally { f.close(); }
});
