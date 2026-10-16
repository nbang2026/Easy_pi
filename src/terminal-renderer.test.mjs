import assert from "node:assert/strict";
import test from "node:test";
import { createRendererController } from "./terminal-renderer.ts";

test("renderer is reused and context loss restores the compatibility renderer", () => {
  const changes = [];
  let loads = 0, disposals = 0, removed = 0, lost;
  const controller = createRendererController(() => { loads++; }, () => ({
    onContextLoss(callback) {
      lost = callback;
      return { dispose() { removed++; } };
    },
    dispose() { disposals++; },
  }), (enabled) => changes.push(enabled));
  controller.setEnabled(true);
  controller.setEnabled(true);
  assert.equal(loads, 1);
  lost();
  assert.equal(disposals, 1);
  assert.equal(removed, 1);
  assert.deepEqual(changes, [true, false]);
  controller.dispose();
  assert.equal(disposals, 1);
});
test("unsupported graphics contexts leave the terminal in compatibility mode", () => {
  const changes = [];
  const controller = createRendererController(() => assert.fail("must not load"), () => {
    throw new Error("WebGL unavailable");
  }, (enabled) => changes.push(enabled));
  assert.doesNotThrow(() => controller.setEnabled(true));
  assert.deepEqual(changes, [false]);
});
test("an activation failure disposes the attempted addon and its listener", () => {
  let removed = 0, disposed = 0;
  const changes = [];
  const controller = createRendererController(() => { throw new Error("Activation failed"); }, () => ({
    onContextLoss() { return { dispose() { removed++; } }; },
    dispose() { disposed++; },
  }), (enabled) => changes.push(enabled));
  controller.setEnabled(true);
  assert.equal(removed, 1);
  assert.equal(disposed, 1);
  assert.deepEqual(changes, [false]);
});
