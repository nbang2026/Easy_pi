import test from "node:test";
import assert from "node:assert/strict";
import { createPiPermissions } from "./pi-permissions.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
const approval = (id = "a") => ({ type: "approval", requestId: id, bridgeId: "bridge", sessionId: "session", tool: "bash", operation: "printf safe", expiresAt: Date.now() + 120000 });
function fixture() {
  const dialogs = [], answers = [], notices = [];
  const controller = createPiPermissions({ language: () => "zh", notice: value => notices.push(value),
    request: value => new Promise(resolve => dialogs.push({ ...value, resolve })), answer: async value => { answers.push(value); } });
  controller.observe({ bridgeId: "bridge", sessionId: "session" });
  return { controller, dialogs, answers, notices };
}

test("Pi approvals bind bridge and session, wait for a click and send exactly one answer", async () => {
  const f = fixture();
  try {
    f.controller.receive({ ...approval(), bridgeId: "stale" });
    f.controller.receive({ ...approval(), sessionId: "stale" });
    assert.equal(f.dialogs.length, 0);
    f.controller.receive(approval()); f.controller.receive(approval());
    assert.equal(f.dialogs.length, 1); assert.equal(f.answers.length, 0);
    f.dialogs[0].resolve(true); await tick();
    assert.deepEqual(f.answers, [{ requestId: "a", sessionId: "session", allow: true }]);
    f.controller.observe({ bridgeId: "bridge", sessionId: "session" }, [approval()]);
    assert.equal(f.dialogs.length, 1);
    f.controller.receive({ ...approval(), type: "approval_resolved" });
    assert.equal(f.dialogs[0].signal.aborted, true);
  } finally { f.controller.dispose(); }
});

test("pre-session trust is shown separately from tools and invalidated when the session starts", async () => {
  const f = fixture();
  try {
    f.controller.observe({ bridgeId: "bridge", sessionId: "" });
    f.controller.receive({ ...approval("early-tool"), sessionId: "" });
    assert.equal(f.dialogs.length, 0);
    f.controller.receive({ ...approval("trust"), sessionId: "", scope: "project_trust" });
    assert.equal(f.dialogs.length, 1);
    assert.equal(f.dialogs[0].projectTrust, true);
    assert.equal(f.dialogs[0].toolApproval, false);
    assert.match(f.dialogs[0].title, /信任/);
    f.controller.observe({ bridgeId: "bridge", sessionId: "started" });
    f.dialogs[0].resolve(true); await tick();
    assert.equal(f.answers.length, 0);
  } finally { f.controller.dispose(); }
});

test("switches, disconnects and backend resolutions cancel stale dialogs without approving", async () => {
  for (const action of ["switch", "disconnect", "resolved", "snapshot"]) {
    const f = fixture();
    try {
      f.controller.receive(approval());
      if (action === "switch") f.controller.observe({ bridgeId: "new", sessionId: "new" });
      if (action === "disconnect") f.controller.observe();
      if (action === "resolved") f.controller.receive({ ...approval(), type: "approval_resolved" });
      if (action === "snapshot") f.controller.observe({ bridgeId: "bridge", sessionId: "session" }, []);
      assert.equal(f.dialogs[0].signal.aborted, true);
      f.dialogs[0].resolve(true); await tick();
      assert.equal(f.answers.length, 0);
    } finally { f.controller.dispose(); }
  }
});

test("live snapshots recover missed requests; expired or historical requests cannot be approved", async () => {
  const f = fixture();
  try {
    f.controller.receive({ ...approval("expired"), expiresAt: Date.now() - 1 });
    f.controller.observe({ bridgeId: "bridge", sessionId: "session" }, [approval("missed")]);
    assert.equal(f.dialogs.length, 1);
    f.dialogs[0].resolve(false); await tick();
    assert.equal(f.answers[0].allow, false);
  } finally { f.controller.dispose(); }
});
