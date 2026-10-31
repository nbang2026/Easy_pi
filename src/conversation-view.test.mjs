import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { setupConversationView } from "./conversation-view.ts";
import { createConversationSync } from "./conversation-sync.ts";

function fixture() {
  const window = new Window();
  window.document.write(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const previous = globalThis.document;
  globalThis.document = window.document;
  const root = window.document.getElementById("conversation-view");
  let continued = 0;
  const actions = { nextStep: 0, outline: 0, regenerate: 0 };
  const enabled = { nextStep: true, outline: true };
  const notices = [];
  const view = setupConversationView({
    root, onContinue: () => { continued++; },
    onRegenerate: () => { actions.regenerate++; },
    nextStepEnabled: () => enabled.nextStep, outlineEnabled: () => enabled.outline,
    onNextStep: () => { actions.nextStep++; }, onOutline: () => { actions.outline++; },
    onNotice: (value) => notices.push(value),
  });
  return { view, root, window, notices, actions, enabled, get continued() { return continued; }, close() {
    view.dispose(); globalThis.document = previous; window.happyDOM.abort();
  } };
}

test("conversation keeps whitespace, reconciles optimistic input and replaces streamed messages by identity", () => {
  const f = fixture();
  try {
    f.view.addUserMessage("hello");
    f.view.consume({ role: "user", text: "hello", messageId: "u1" });
    assert.equal(f.root.querySelectorAll(".conversation-user").length, 1);
    f.view.consume({ role: "assistant", messageId: "a1", text: "Hello", append: false });
    f.view.consume({ role: "assistant", messageId: "a1", text: " ", append: true });
    f.view.consume({ role: "assistant", messageId: "a1", text: "world\n", append: true });
    assert.equal(f.root.querySelector(".conversation-answer").textContent, "Hello world\n");
    const actions = f.root.querySelector(".conversation-actions");
    const firstAssistant = f.root.querySelector(".conversation-assistant");
    assert.equal(actions.parentElement, firstAssistant);
    assert.equal(firstAssistant.children[2], actions);
    assert.equal(actions.previousElementSibling, f.root.querySelector(".conversation-answer"));
    f.view.consume({ type: "message", role: "assistant", messageId: "a1", text: "Hello world\n" });
    assert.equal(f.root.querySelectorAll(".conversation-assistant").length, 1);
    assert.equal(f.root.querySelector(".conversation-answer").textContent, "Hello world\n");
    f.view.consume({ role: "assistant", messageId: "a2", text: "Next", append: false });
    f.view.consume({ type: "message", role: "system", text: "hidden" });
    assert.equal(f.root.querySelectorAll(".conversation-assistant").length, 2);
    assert.equal(actions.parentElement, f.root.querySelectorAll(".conversation-assistant")[1]);
    assert.equal(actions.previousElementSibling, f.root.querySelectorAll(".conversation-answer")[1]);
    assert.doesNotMatch(f.root.textContent, /hidden/);
  } finally { f.close(); }
});

test("long streamed answers reuse one text node instead of growing a DOM node per delta", () => {
  const f = fixture();
  try {
    f.view.consume({ role: "assistant", messageId: "long", text: "start", append: false });
    const answer = f.root.querySelector(".conversation-answer"), node = answer.firstChild;
    for (let i = 0; i < 500; i++) f.view.consume({ role: "assistant", messageId: "long", text: " delta", append: true });
    assert.equal(answer.childNodes.length, 1);
    assert.equal(answer.firstChild, node);
    assert.equal(answer.textContent, "start" + " delta".repeat(500));
  } finally { f.close(); }
});

test("answer actions sit immediately after the answer and before its expandable conclusion", () => {
  const f = fixture();
  try {
    f.view.consume({
      role: "assistant",
      messageId: "a1",
      text: "Details first.\n结论：完成。",
      append: false,
    });
    const answer = f.root.querySelector(".conversation-answer");
    const actions = f.root.querySelector(".conversation-actions");
    const conclusion = f.root.querySelector(".conversation-conclusion");
    assert.equal(actions.previousElementSibling, answer);
    assert.equal(actions.nextElementSibling, conclusion);
    assert.equal(conclusion.hidden, false);
  } finally { f.close(); }
});

test("truncated streaming output is announced once without changing the displayed text", () => {
  const f = fixture();
  try {
    f.view.consume({ role: "assistant", messageId: "a1", text: "partial", append: false, truncated: true });
    f.view.consume({ role: "assistant", messageId: "a1", text: "partial", append: false, truncated: true });
    assert.equal(f.root.querySelector(".conversation-answer").textContent, "partial");
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0], /120000/);
  } finally { f.close(); }
});

test("conversation menu omits inert actions and preserves useful secondary actions", () => {
  const f = fixture();
  try {
    const actions = f.root.querySelector(".conversation-actions");
    const menu = f.root.querySelector("#conversation-more-menu");
    assert.equal(actions.hidden, true);
    assert.deepEqual(
      [...menu.querySelectorAll("[role='menuitem'] span")].map(node => node.textContent),
      ["朗读回答", "重新生成", "导出回答", "清空对话"],
    );
    assert.equal(menu.querySelector("#conversation-share"), null);
    assert.equal(menu.querySelector("#conversation-like"), null);
    assert.equal(menu.querySelector("#conversation-dislike"), null);

    f.view.addUserMessage("task");
    assert.equal(actions.hidden, true);
    f.view.consume({ role: "assistant", messageId: "a1", text: "answer", append: false });
    assert.equal(actions.hidden, false);
    assert.equal(actions.parentElement, f.root.querySelector(".conversation-assistant"));
    f.root.querySelector("#conversation-more").click();
    f.root.querySelector("#conversation-speak").click();
    assert.equal(menu.hidden, true);

    f.view.clear();
    assert.equal(actions.hidden, true);
    assert.equal(menu.hidden, true);
  } finally { f.close(); }
});

test("floating answer actions follow independent preferences and run only when clicked", () => {
  const f = fixture();
  try {
    f.view.addUserMessage("task");
    f.view.consume({ role: "assistant", messageId: "a1", text: "Answer", append: false });
    const quick = f.root.querySelector("#conversation-quick-actions");
    const menu = f.root.querySelector("#conversation-quick-actions-menu");
    const toggle = f.root.querySelector("#conversation-quick-actions-toggle");
    const next = f.root.querySelector("#conversation-next-step");
    const outline = f.root.querySelector("#conversation-outline");
    const quickContinue = f.root.querySelector("#conversation-quick-continue");
    const quickRegenerate = f.root.querySelector("#conversation-quick-regenerate");
    const resetPosition = f.root.querySelector("#conversation-quick-reset-position");
    assert.equal(quick.hidden, false);
    assert.equal(next.hidden, false);
    assert.equal(outline.hidden, false);
    assert.equal(f.actions.nextStep, 0);
    assert.equal(f.actions.outline, 0);

    toggle.click();
    assert.equal(menu.hidden, false);
    outline.click();
    assert.equal(menu.hidden, true);
    assert.equal(f.actions.outline, 1);
    toggle.click();
    quickContinue.click();
    assert.equal(f.continued, 1);
    toggle.click();
    quickRegenerate.click();
    toggle.click();
    resetPosition.click();
    assert.equal(menu.hidden, true);

    f.enabled.nextStep = false;
    f.enabled.outline = true;
    f.view.refreshQuickActions();
    assert.equal(next.hidden, true);
    assert.equal(outline.hidden, false);
    f.enabled.outline = false;
    f.view.refreshQuickActions();
    assert.equal(quick.hidden, false);
  } finally { f.close(); }
});

test("history restores distinct turns and disposal removes action listeners", () => {
  const f = fixture();
  try {
    f.view.addUserMessage("pending");
    f.view.restore([
      { role: "user", text: "past", messageId: "u1" },
      { role: "assistant", text: "answer", messageId: "a1" },
    ]);
    assert.deepEqual([...f.root.querySelectorAll(".conversation-user-text")].map(node => node.textContent), ["past", "pending"]);
    f.root.querySelector("#conversation-continue").click();
    assert.equal(f.continued, 0);
    f.view.consume({ role: "assistant", text: "pending reply", messageId: "a2", append: false });
    f.root.querySelector("#conversation-continue").click();
    assert.equal(f.continued, 1);
    f.view.dispose();
    f.root.querySelector("#conversation-continue").click();
    assert.equal(f.continued, 1);
  } finally { f.close(); }
});

test("floating control drags in conversation coordinates and remains clickable after dragging", () => {
  const f = fixture();
  try {
    f.view.consume({ role: "assistant", text: "answer", append: false });
    const quick = f.root.querySelector("#conversation-quick-actions");
    const toggle = f.root.querySelector("#conversation-quick-actions-toggle");
    const menu = f.root.querySelector("#conversation-quick-actions-menu");
    f.root.getBoundingClientRect = () => ({ left: 240, top: 80, width: 600, height: 400 });
    Object.defineProperties(f.root, { clientWidth: { value: 600, configurable: true }, clientHeight: { value: 400, configurable: true } });
    toggle.getBoundingClientRect = () => ({ left: 784, right: 818, top: 432, bottom: 466, width: 34, height: 34 });
    const pointer = (type, x, y) => toggle.dispatchEvent(new f.window.PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true }));
    pointer("pointerdown", 800, 450);
    pointer("pointermove", 700, 400);
    assert.equal(quick.style.right, "122px");
    assert.equal(quick.style.bottom, "64px");
    pointer("pointerup", 700, 400);
    toggle.dispatchEvent(new f.window.MouseEvent("click", { detail: 1, bubbles: true }));
    assert.equal(menu.hidden, true);
    pointer("pointerdown", 700, 400);
    pointer("pointerup", 700, 400);
    toggle.dispatchEvent(new f.window.MouseEvent("click", { detail: 1, bubbles: true }));
    assert.equal(menu.hidden, false);
    assert.equal(f.window.document.activeElement.id, "conversation-quick-copy");
    Object.defineProperty(f.root, "clientWidth", { value: 120, configurable: true });
    f.window.dispatchEvent(new f.window.Event("resize"));
    assert.equal(quick.style.right, "78px");
    f.view.dispose();
    toggle.dataset.dragged = "true";
    let clicked = false;
    toggle.addEventListener("click", () => { clicked = true; });
    toggle.dispatchEvent(new f.window.MouseEvent("click", { detail: 1, bubbles: true }));
    assert.equal(clicked, true);
  } finally { f.close(); }
});

test("floating menu focuses a usable item when optional actions are disabled", () => {
  const f = fixture();
  try {
    f.enabled.nextStep = f.enabled.outline = false;
    f.view.consume({ role: "assistant", text: "answer", append: false });
    f.root.querySelector("#conversation-quick-actions-toggle").click();
    assert.equal(f.window.document.activeElement.id, "conversation-quick-copy");
  } finally { f.close(); }
});

test("busy and disconnected states disable task actions without losing the answer", () => {
  const f = fixture();
  try {
    f.view.consume({ role: "assistant", text: "answer", append: false });
    const clickTasks = () => {
      for (const id of ["conversation-continue", "conversation-regenerate", "conversation-quick-continue", "conversation-quick-regenerate", "conversation-next-step", "conversation-outline"]) {
        f.root.querySelector(`#${id}`).click();
      }
    };
    f.view.setState({ busy: true });
    clickTasks();
    f.root.querySelector("#conversation-clear").click();
    assert.equal(f.view.latestAnswer(), "answer");
    assert.equal(f.continued, 0);
    assert.deepEqual(f.actions, { nextStep: 0, outline: 0, regenerate: 0 });
    f.view.setState({ connected: false });
    clickTasks();
    assert.equal(f.continued, 0);
    assert.deepEqual(f.actions, { nextStep: 0, outline: 0, regenerate: 0 });
    f.view.setState({ connected: true, ready: true });
    clickTasks();
    assert.equal(f.continued, 2);
    assert.deepEqual(f.actions, { nextStep: 1, outline: 1, regenerate: 2 });
    f.enabled.outline = false;
    f.view.refreshQuickActions();
    f.root.querySelector("#conversation-outline").click();
    assert.equal(f.actions.outline, 1);
  } finally { f.close(); }
});

test("dragging back to the initial point restores the initial coordinates", () => {
  const f = fixture();
  try {
    f.view.consume({ role: "assistant", text: "answer", append: false });
    const quick = f.root.querySelector("#conversation-quick-actions");
    const toggle = f.root.querySelector("#conversation-quick-actions-toggle");
    f.root.getBoundingClientRect = () => ({ left: 240, top: 80, width: 600, height: 400 });
    Object.defineProperties(f.root, { clientWidth: { value: 600 }, clientHeight: { value: 400 } });
    toggle.getBoundingClientRect = () => ({ left: 784, right: 818, top: 432, bottom: 466, width: 34, height: 34 });
    const pointer = (type, x, y) => toggle.dispatchEvent(new f.window.PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true }));
    pointer("pointerdown", 800, 450);
    pointer("pointermove", 700, 400);
    pointer("pointermove", 800, 450);
    assert.equal(quick.style.right, "22px");
    assert.equal(quick.style.bottom, "14px");
    pointer("pointerup", 800, 450);
  } finally { f.close(); }
});

test("history loading rejects stale sessions and replays live events only after the current snapshot", async () => {
  const requests = [], restored = [], consumed = [], notices = [];
  const sync = createConversationSync({
    load: () => new Promise(resolve => requests.push(resolve)),
    clear() {}, restore: value => restored.push(value), consume: value => consumed.push(value),
    notice: value => notices.push(value),
  });
  sync.observe({ bridgeId: "b1", sessionId: "s1" });
  sync.consume({ bridgeId: "b1", sessionId: "s1", role: "assistant", text: "old" });
  sync.observe({ bridgeId: "b2", sessionId: "s2" });
  sync.consume({ bridgeId: "b1", sessionId: "s1", text: "stale" });
  sync.consume({ bridgeId: "b2", sessionId: "s2", role: "assistant", text: "current" });
  requests[0]({ sessionId: "s1", messages: [{ text: "old snapshot" }] });
  requests[1]({ sessionId: "s2", messages: [{ text: "new snapshot" }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(restored, [[{ text: "new snapshot" }]]);
  assert.deepEqual(consumed.map(event => event.text), ["current"]);
  assert.deepEqual(notices, []);
});

test("a full buffered answer replaces all older deltas without duplicating its tail", async () => {
  let resolve;
  const consumed = [];
  const sync = createConversationSync({
    load: () => new Promise(done => { resolve = done; }),
    clear() {}, restore() {}, consume: event => consumed.push(event), notice() {},
  });
  sync.observe({ bridgeId: "bridge", sessionId: "session" });
  const event = { bridgeId: "bridge", sessionId: "session", role: "assistant", messageId: "a1" };
  sync.consume({ ...event, text: "A", append: true });
  sync.consume({ ...event, text: "B", append: true });
  sync.consume({ ...event, role: "user", text: "other role", append: false });
  sync.consume({ ...event, text: "AB", append: false });
  sync.consume({ ...event, text: "C", append: true });
  resolve({ sessionId: "session", messages: [] });
  await new Promise(done => setImmediate(done));
  assert.deepEqual(consumed.map(({ role, text, append }) => ({ role, text, append })), [
    { role: "assistant", text: "AB", append: false },
    { role: "user", text: "other role", append: false },
    { role: "assistant", text: "C", append: true },
  ]);
});

