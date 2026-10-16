import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { setupModelBulk } from "./model-bulk.ts";
import { bindModelList, modelKey, renderModelRows } from "./model-list.ts";
const flush = () => new Promise((resolve) => setImmediate(resolve));
const models = [
  {provider:"legacy",id:"old/one",name:"Old one",value:"legacy/old/one"},
  {provider:"legacy",id:"old/two",name:"Old two",value:"legacy/old/two"},
  {provider:"custom",id:"new",name:"New",value:"custom/new"},
];
function fixture({ confirm = async () => true, remove = async () => {} } = {}) {
  const window = new Window(); const previous = globalThis.document; globalThis.document = window.document;
  const list = window.document.createElement("div");
  const all = window.document.createElement("input"); all.type = "checkbox";
  const selectedDelete = window.document.createElement("button"); const clear = window.document.createElement("button");
  const count = window.document.createElement("span"); window.document.body.append(all,selectedDelete,clear,count,list);
  const deleted = []; const confirmations = []; const errors = []; const switched = [];
  let changed = 0;
  const bulk = setupModelBulk({list,all,remove:selectedDelete,clear,count,translate:(key)=>key,
    confirm:async (items,clearing)=>{confirmations.push({items:[...items],clearing});return confirm(items,clearing);},
    deleteModels:async (items)=>{deleted.push(items);await remove(items);},
    changed:()=>{changed++;},error:(error)=>errors.push(String(error))});
  const unbind = bindModelList(list,{confirm:()=>true,translate:(k)=>k,remove:async()=>{},select:async(v)=>{switched.push(v);},error:(e)=>errors.push(String(e))});
  function render(visible = models, allModels = models, loading = false) {
    renderModelRows(list,visible,"",(key)=>key,bulk.selected); bulk.update(allModels,visible,loading);
  }
  render();
  return {window,list,all,selectedDelete,clear,count,bulk,deleted,confirmations,errors,switched,render,get changed(){return changed;},
    check(index,checked=true){const input=list.querySelectorAll(".model-checkbox")[index];input.checked=checked;input.dispatchEvent(new window.Event("change",{bubbles:true}));},
    close(){unbind();bulk.dispose();window.happyDOM.abort();globalThis.document=previous;}};
}

test("row checkbox selects without switching models and select-all is indeterminate", async () => {
  const f=fixture();try{
    f.check(0);assert.equal(f.bulk.selected.size,1);assert.equal(f.all.checked,false);assert.equal(f.all.indeterminate,true);
    assert.equal(f.selectedDelete.disabled,false);assert.match(f.count.textContent,/1/);assert.deepEqual(f.switched,[]);
    f.all.checked=true;f.all.dispatchEvent(new f.window.Event("change"));assert.equal(f.bulk.selected.size,3);assert.equal(f.all.checked,true);
    f.all.checked=false;f.all.dispatchEvent(new f.window.Event("change"));assert.equal(f.bulk.selected.size,0);assert.equal(f.selectedDelete.disabled,true);
  }finally{f.close();}
});

test("selections survive filtering and select-all only changes matching rows", async()=>{
  const f=fixture();try{
    f.check(2);f.render(models.slice(0,2));
    assert.equal(f.bulk.selected.size,1);assert.equal(f.all.checked,false);
    f.all.checked=true;f.all.dispatchEvent(new f.window.Event("change"));assert.equal(f.bulk.selected.size,3);
    f.all.checked=false;f.all.dispatchEvent(new f.window.Event("change"));assert.deepEqual([...f.bulk.selected],[modelKey(models[2])]);
    f.render();assert.equal(f.list.querySelectorAll(".model-checkbox")[2].checked,true);
  }finally{f.close();}
});

test("delete-selected submits exact provider and slash-containing IDs in one batch",async()=>{
  const f=fixture();try{
    f.check(0);f.check(2);f.selectedDelete.click();await flush();
    assert.deepEqual(f.deleted,[[{provider:"legacy",id:"old/one"},{provider:"custom",id:"new"}]]);
    assert.equal(f.confirmations.length,1);assert.equal(f.confirmations[0].clearing,false);assert.equal(f.bulk.selected.size,0);
    assert.equal(f.changed,1);assert.deepEqual(f.switched,[]);
  }finally{f.close();}
});

test("clear-all includes models hidden by search and requires confirmation",async()=>{
  const f=fixture();try{
    f.render([models[0]]);f.clear.click();await flush();
    assert.equal(f.confirmations[0].clearing,true);assert.equal(f.confirmations[0].items.length,3);assert.equal(f.deleted[0].length,3);
  }finally{f.close();}
});

test("cancelled clear does not write or lose selected rows",async()=>{
  const f=fixture({confirm:async()=>false});try{
    f.check(1);f.clear.click();await flush();
    assert.equal(f.deleted.length,0);assert.equal(f.bulk.selected.size,1);assert.equal(f.changed,0);assert.equal(f.clear.disabled,false);
  }finally{f.close();}
});

test("pending bulk deletion is single-flight and errors retain selection for retry",async()=>{
  let fail;const pending=new Promise((_,reject)=>{fail=reject;});
  const f=fixture({remove:()=>pending});try{
    f.check(0);f.selectedDelete.click();await flush();
    f.clear.dispatchEvent(new f.window.MouseEvent("click",{bubbles:true}));
    f.list.querySelector(".model-select").click();assert.equal(f.deleted.length,1);assert.deepEqual(f.switched,[]);
    assert.equal(f.all.disabled,true);assert.equal(f.list.querySelector(".model-checkbox").disabled,true);
    fail(Error("disk read-only"));await flush();
    assert.match(f.errors[0],/read-only/);assert.equal(f.bulk.selected.size,1);assert.equal(f.selectedDelete.disabled,false);
  }finally{f.close();}
});

test("loading and empty lists disable bulk actions; refreshed deletions prune selection",async()=>{
  const f=fixture();try{
    f.check(0);f.render(models,models,true);assert.equal(f.clear.disabled,true);
    f.render([],[],false);assert.equal(f.all.disabled,true);assert.equal(f.clear.disabled,true);assert.equal(f.bulk.selected.size,0);
  }finally{f.close();}
});
