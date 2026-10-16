import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { bindModelList, renderModelRows } from "./model-list.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ confirm = true, remove = async () => {} } = {}) {
  const window = new Window();
  const previous = globalThis.document;
  globalThis.document = window.document;
  const list = window.document.createElement("div");
  window.document.body.append(list);
  const model = { provider: "relay", id: "namespace/test", name: "<img src=x>", value: "relay/namespace/test", deletable: true };
  renderModelRows(list, [model, { provider: "builtin", id: "one", name: "Built in", value: "builtin/one" }], model.value, (key) => key);
  const calls = []; const selections = []; const errors = []; const confirmations = [];
  const dispose = bindModelList(list, {
    translate: (key) => key,
    confirm: (message, value) => { confirmations.push([message, value]); return confirm; },
    remove: async (...args) => { calls.push(args); await remove(...args); },
    select: async (value) => { selections.push(value); },
    error: (error) => errors.push(String(error)),
  });
  return { window, list, calls, selections, errors, confirmations, close() { dispose(); globalThis.document = previous; window.happyDOM.abort(); } };
}

test("legacy and new model rows have edit/delete siblings and escaped names", async () => {
  const f = fixture();
  try {
    assert.equal(f.list.querySelectorAll(".model-delete").length, 2);
    assert.equal(f.list.querySelectorAll(".model-edit").length, 2);
    assert.equal(f.list.querySelector(".model-select .model-delete"), null);
    assert.equal(f.list.querySelector("img"), null);
    assert.match(f.list.querySelector(".model-delete").getAttribute("aria-label"), /deleteModel/);
    f.list.querySelector(".model-delete svg").dispatchEvent(new f.window.MouseEvent("click", { bubbles: true }));
    await flush();
    assert.deepEqual(f.calls, [["relay", "namespace/test"]]);
    assert.deepEqual(f.selections, []);
    assert.equal(f.confirmations[0][1], "relay/namespace/test");
  } finally { f.close(); }
});

test("cancelling model deletion leaves selection and configuration untouched", async () => {
  const f = fixture({ confirm: false });
  try {
    f.list.querySelector(".model-delete").click(); await flush();
    assert.deepEqual(f.calls, []); assert.deepEqual(f.selections, []);
    f.list.querySelector(".model-select").click(); await flush();
    assert.deepEqual(f.selections, ["relay/namespace/test"]);
  } finally { f.close(); }
});

test("pending deletion is single-flight and a failed write restores the controls", async () => {
  let reject;
  const waiting = new Promise((_, fail) => { reject = fail; });
  const f = fixture({ remove: () => waiting });
  try {
    const button = f.list.querySelector(".model-delete");
    button.click(); button.dispatchEvent(new f.window.MouseEvent("click", { bubbles: true }));
    f.list.querySelector(".model-select").click();
    await flush();
    assert.equal(f.calls.length, 1); assert.deepEqual(f.selections, []);
    assert.equal(f.list.getAttribute("aria-busy"), "true");
    reject(Error("read-only config")); await flush();
    assert.match(f.errors[0], /read-only/);
    assert.equal(button.disabled, false);
    assert.equal(f.list.hasAttribute("aria-busy"), false);
    assert.equal(f.list.querySelectorAll(".model-item").length, 2);
  } finally { f.close(); }
});

test("legacy model delete and edit do not require a custom ownership flag", async () => {
  const f = fixture();
  try {
    const rows = f.list.querySelectorAll(".model-item");
    rows[1].querySelector(".model-delete").click(); await flush();
    assert.deepEqual(f.calls, [["builtin", "one"]]);
    assert.deepEqual(f.selections, []);
  } finally { f.close(); }
});

test("pencil action targets a legacy provider and never switches its model", async () => {
  const window = new Window(); const previous = globalThis.document; globalThis.document = window.document;
  let dispose = () => {};
  try {
    const list = window.document.createElement("div"); window.document.body.append(list);
    renderModelRows(list, [{provider:"deepseek",id:"old",name:"Old",value:"deepseek/old"}], "", (key) => key);
    const edits = []; const selected = [];
    dispose = bindModelList(list, {confirm:()=>true,translate:(k)=>k,remove:async()=>{},edit:async(...args)=>{edits.push(args);},select:async(v)=>{selected.push(v);},error:(e)=>{throw e;}});
    list.querySelector(".model-edit svg").dispatchEvent(new window.MouseEvent("click",{bubbles:true})); await flush();
    assert.deepEqual(edits,[["deepseek","old"]]);assert.deepEqual(selected,[]);
  } finally {dispose();globalThis.document = previous;window.happyDOM.abort();}
});
