import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { normalizeAgentSessions, setupAgentSessionStrip } from "./agent-session-strip.ts";

test("agent session strip normalizes safe, unique child sessions", () => {
  const sessions = normalizeAgentSessions([
    { id: "subagent:run-1:api-review", label: "API review", status: "completed", color: "#43b9e7" },
    { agentId: "subagent:run-1:api-review", label: "duplicate", status: "failed" },
    { id: "subagent:run-1:ui", status: "running", activity: "Inspecting layout" },
    { id: "main", label: "must not replace main", status: "completed" },
    { id: "unsafe\0id", label: "<script>alert(1)</script>", status: "done" },
    null,
  ]);
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0].label, "API review");
  assert.equal(sessions[0].status, "completed");
  assert.equal(sessions[1].status, "running");
  assert.match(sessions[1].label, /^agent-/);
  assert.equal(sessions[2].status, "completed");
  assert.equal(sessions[2].label, "<script>alert(1)</script>");
  assert.match(sessions[0].color, /^#[0-9a-f]{6}$/i);
});

test("agent session status aliases remain bounded to the visible state set", () => {
  const [session] = normalizeAgentSessions([{ id: "x", status: "unexpected", activity: "work" }]);
  assert.equal(session.status, "ready");
  assert.equal(session.id, "x");
  assert.equal(session.activity, "work");
});

test("the main-session row collapses when there are no child agents", () => {
  const window = new Window();
  const previousDocument = globalThis.document;
  globalThis.document = window.document;
  const root = window.document.createElement("nav");
  const strip = setupAgentSessionStrip({ root, language: () => "zh" });
  try {
    strip.update({ connected: true, agents: [] });
    assert.equal(root.hidden, true);
    assert.equal(root.children.length, 0);

    strip.update({ connected: true, agents: [{ id: "subagent:api", label: "API" }] });
    assert.equal(root.hidden, false);
    assert.deepEqual([...root.querySelectorAll(".agent-session-name")].map((node) => node.textContent), ["主会话", "API"]);

    strip.update({ connected: false, agents: [{ id: "subagent:api", label: "API" }] });
    assert.equal(root.hidden, true);
    assert.equal(root.children.length, 0);
  } finally {
    strip.dispose();
    globalThis.document = previousDocument;
    window.happyDOM.abort();
  }
});
