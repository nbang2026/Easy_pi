import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { setupSendModeControls } from "./send-mode-controls.ts";

test("all three mode buttons accept nested icon clicks and maintain one pressed mode", () => {
  const window = new Window();
  const root = window.document.createElement("div");
  root.innerHTML = ["send", "control", "queue"].map(mode => `<button class="sendmode" data-mode="${mode}"><svg><path></path></svg><span>${mode}</span></button>`).join("");
  const changes = []; let focused = 0;
  const controller = setupSendModeControls({ root, initial: "invalid", changed: mode => changes.push(mode), selected: () => focused++ });
  try {
    assert.equal(changes[0], "send");
    for (const mode of ["queue", "control", "send"]) {
      root.querySelector(`[data-mode="${mode}"] path`).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      assert.equal(changes.at(-1), mode);
      assert.equal(root.querySelectorAll('[aria-pressed="true"]').length, 1);
      assert.equal(root.querySelector(".active").dataset.mode, mode);
    }
    assert.equal(focused, 3);
    const button = root.querySelector('[data-mode="queue"]'); button.disabled = true;
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(changes.at(-1), "send");
    controller.dispose();
    root.querySelector('[data-mode="control"]').click();
    assert.equal(changes.at(-1), "send");
  } finally { controller.dispose(); window.happyDOM.abort(); }
});
