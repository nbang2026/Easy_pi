import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { confirmModelRemoval, confirmModelBatch, editModelDialog } from "./model-dialog.ts";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const t = (key) => key;
function fixture() {
  const window = new Window(); const previous = globalThis.document; globalThis.document = window.document;
  const focus = window.document.createElement("button"); window.document.body.append(focus); focus.focus();
  return { window, document: window.document, focus, close() { globalThis.document = previous; window.happyDOM.abort(); } };
}
const info = { provider: "deepseek", id: "old-model", name: "Old model", api: "openai-completions", baseurl: "https://example.test/v1", hasKey: true };
test("application confirmation names the legacy model and supports cancel and delete without window.confirm", async () => {
  const f = fixture();
  try {
    const cancelled = confirmModelRemoval("<img src=x> old model", "deepseek/old-model", t);
    assert.equal(f.document.querySelector("img"), null);
    assert.match(f.document.querySelector("[role=dialog]").textContent, /old model/);
    assert.equal(f.document.activeElement.className, "model-dialog-cancel");
    f.document.querySelector(".model-dialog-cancel").click();
    assert.equal(await cancelled, false); assert.equal(f.document.querySelector("[role=dialog]"), null);
    assert.equal(f.document.activeElement, f.focus);
    const accepted = confirmModelRemoval("Old model", "deepseek/old-model", t);
    f.document.querySelector(".model-dialog-delete").click(); assert.equal(await accepted, true);
  } finally { f.close(); }
});
test("Escape cancels confirmation without reaching outer settings handlers", async () => {
  const f = fixture(); let bubbled = 0;
  try {
    f.document.addEventListener("keydown", () => { bubbled++; });
    const result = confirmModelRemoval("Old model", "deepseek/old-model", t);
    f.document.activeElement.dispatchEvent(new f.window.KeyboardEvent("keydown", {key:"Escape", bubbles:true, cancelable:true}));
    assert.equal(await result, false); assert.equal(bubbled, 0);
  } finally { f.close(); }
});
test("edit dialog preloads legacy model fields, keeps secret blank, saves exact identity, and retains draft on failure", async () => {
  const f = fixture(); const calls = []; let failed = true;
  try {
    const result = editModelDialog(info, t, async (values) => { calls.push(values); if (failed) throw Error("Cannot write model config"); });
    const inputs = f.document.querySelectorAll(".model-edit-form input");
    assert.equal(inputs[0].readOnly, true); assert.equal(inputs[1].value, "Old model");
    assert.equal(inputs[4].type, "password"); assert.equal(inputs[4].value, "");
    inputs[1].value = "Edited model"; inputs[2].value = "new-model";
    f.document.querySelector(".model-dialog-save").click(); await tick();
    assert.match(f.document.querySelector("[role=alert]").textContent, /Cannot write/);
    assert.equal(inputs[1].value, "Edited model");
    assert.equal(f.document.querySelector(".model-dialog-save").disabled, false);
    failed = false; f.document.querySelector(".model-dialog-save").click(); await tick();
    assert.equal(await result, true); assert.equal(calls[1].originalid, "old-model");
    assert.equal(calls[1].id, "new-model"); assert.equal(calls[1].name, "Edited model"); assert.equal(calls[1].apikey, "");
    assert.equal(f.document.querySelector("[role=dialog]"), null);
  } finally { f.close(); }
});
test("cancelling edit does not save credentials or configuration", async () => {
  const f = fixture(); let writes = 0;
  try {
    const result = editModelDialog(info, t, async () => { writes++; });
    const key = f.document.querySelector("input[type=password]");key.value = "new-unsaved-secret";
    f.document.querySelector(".model-dialog-close").click();
    assert.equal(await result, false); assert.equal(writes, 0); assert.equal(key.value, "");
  } finally { f.close(); }
});

test("bulk confirmation displays the full scope and remains cancellable",async()=>{
  const f=fixture();try{
    const targets=[{name:"<img src=x> old",value:"legacy/one"},{name:"New",value:"custom/two"}];
    const cancelled=confirmModelBatch(targets,true,t);
    assert.match(f.document.querySelector("[role=dialog]").textContent,/ui.clearModelsQuestion.*2/);
    assert.equal(f.document.querySelectorAll(".model-batch-targets li").length,2);assert.equal(f.document.querySelector("img"),null);
    f.document.querySelector(".model-dialog-cancel").click();assert.equal(await cancelled,false);
    const accepted=confirmModelBatch(targets,false,t);
    assert.match(f.document.querySelector("[role=dialog]").textContent,/ui.deleteSelectedModels/);
    f.document.querySelector(".model-dialog-delete").click();assert.equal(await accepted,true);
  }finally{f.close();}
});
