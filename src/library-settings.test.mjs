import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { setupLibrarySettings } from "./library-settings.ts";

const flush=async()=>{await new Promise((done)=>setImmediate(done));await new Promise((done)=>setImmediate(done));};
function fixture(options={}) {
  const window=new Window({settings:{disableJavaScriptEvaluation:true,disableJavaScriptFileLoading:true,disableCSSFileLoading:true}});
  window.document.write(readFileSync(new URL("../index.html",import.meta.url),"utf8"));
  const old={window:globalThis.window,document:globalThis.document};
  Object.assign(globalThis,{window,document:window.document});
  window.confirm=()=>true;
  const data={settings:{memoryEnabled:true,autonomousDownloads:true},memories:options.memories||[],agents:options.agents||[]};
  const calls=[];
  const controller=setupLibrarySettings({translate:(key)=>key,invoke:async(command,args)=>{
    assert.equal(command,"gui_action");assert.equal(args.action,"library");
    const request=JSON.parse(args.text);calls.push(request);
    if(options.fail&&options.fail===request.action)throw Error("failed");
    if(request.kind==="list")return {data:structuredClone({...data,memories:data.memories.map((item)=>({...item,content:item.content.slice(0,160)}))})};
    if(request.kind==="settings"){Object.assign(data.settings,request);return {data:data.settings};}
    const items=request.kind==="memory"?data.memories:data.agents;
    if(request.action==="read")return {data:structuredClone(items.find((item)=>item.id===request.id))};
    if(request.action==="remove"){items.splice(items.findIndex((item)=>item.id===request.id),1);return {data:{removed:true}};}
    if(request.action==="download"){const item={id:crypto.randomUUID(),title:"Reviewer",content:"# Agent",updatedAt:Date.now()};items.push(item);return {data:structuredClone(item)};}
    const index=items.findIndex((item)=>item.id===request.id);
    const item={id:index<0?crypto.randomUUID():request.id,title:request.title,content:request.content,updatedAt:Date.now()};
    if(index<0)items.push(item);else items[index]=item;return {data:structuredClone(item)};
  }});
  const el=(id)=>window.document.getElementById(id);
  const change=(id)=>el(id).dispatchEvent(new window.Event("change",{bubbles:true}));
  return {window,controller,calls,data,el,change,close(){controller.dispose();window.happyDOM.abort();Object.assign(globalThis,old);}};
}
test("memory settings live in their own pane and read actual bridge data without startup side effects", async () => {
  const f=fixture();assert.equal(f.calls.length,0);f.controller.refresh();await flush();
  assert.equal(f.el("library-content").closest(".settings-pane").id,"pane-agents");
  assert.equal(f.el("memory-switch").checked,true);
  assert.equal(f.el("agent-download-row").hidden,true);
  assert.equal(f.el("composer").nextElementSibling.id,"input-tools");
  f.close();
});
test("GUI memory create, full read, edit and delete use persisted records instead of previews", async () => {
  const content="Long note ".repeat(100);
  const item={id:crypto.randomUUID(),title:"<img src=x>",content,updatedAt:1};
  const f=fixture({memories:[item]});f.controller.refresh();await flush();
  assert.equal(f.el("library-list").querySelector("img"),null);
  f.el("library-list").querySelector("button").click();await flush();
  assert.equal(f.el("library-content").value,content);
  f.el("library-content").value="edited";f.el("library-save").click();await flush();
  assert.equal(f.data.memories[0].content,"edited");
  f.el("library-remove").click();await flush();
  assert.equal(f.data.memories.length,0);
  assert.equal(f.el("library-content").value,"");
  f.close();
});
test("switching libraries preserves unsaved text and failed writes leave the editor available", async () => {
  const f=fixture({fail:"save"});f.controller.refresh();await flush();
  f.el("library-title").value="Draft";f.el("library-content").value="Keep me";
  f.el("library-kind").value="agent";f.change("library-kind");
  assert.equal(f.el("library-kind").value,"memory");
  assert.equal(f.el("library-status").textContent,"library.unsaved");
  f.el("library-save").click();await flush();
  assert.equal(f.el("library-content").value,"Keep me");
  assert.equal(f.el("library-save").disabled,false);
  assert.equal(f.el("library-status").textContent,"Error: failed");
  f.close();
});
test("download and authorization controls reach the service and refresh their persisted state", async () => {
  const f=fixture();f.controller.refresh();await flush();
  f.el("agent-download-switch").checked=false;f.change("agent-download-switch");await flush();
  assert.equal(f.data.settings.autonomousDownloads,false);
  f.el("library-kind").value="agent";f.change("library-kind");
  assert.equal(f.el("agent-download-row").hidden,false);
  f.el("agent-source").value="https://github.com/example/agents/blob/main/reviewer.md";
  f.el("agent-download").click();await flush();
  assert.equal(f.data.agents.length,1);
  assert.equal(f.el("library-title").value,"Reviewer");
  assert.equal(f.el("library-content").value,"# Agent");
  assert.equal(f.el("library-status").textContent,"library.downloaded");
  f.close();
});
test("the active Agent can be chosen from the library pane or the input-bar picker", async () => {
  const agents=[{id:"b",title:"Writer",content:"# W",updatedAt:1},{id:"a",title:"Reviewer",content:"# R",updatedAt:2}];
  const f=fixture({agents});f.controller.refresh();await flush();
  const picker=f.el("agent-select");
  assert.deepEqual([...picker.options].map((o)=>o.value),["","a","b"]);
  assert.equal(picker.value,"");
  f.el("library-kind").value="agent";f.change("library-kind");await flush();
  assert.equal(f.el("library-activate").hidden,true);
  f.el("library-list").querySelector("button").click();await flush();
  assert.equal(f.el("library-activate").hidden,false);
  assert.equal(f.el("library-activate-label").textContent,"library.activate");
  f.el("library-activate").click();await flush();
  assert.equal(f.calls.find((c)=>c.kind==="settings").activeAgent,"a");
  assert.equal(picker.value,"a");
  assert.ok(f.el("library-list").querySelector('[data-active="true"] .library-active-mark'));
  assert.equal(f.el("library-activate-label").textContent,"library.deactivate");
  picker.value="b";f.change("agent-select");await flush();
  assert.equal(f.data.settings.activeAgent,"b");assert.equal(picker.value,"b");
  picker.value="";f.change("agent-select");await flush();
  assert.equal(f.data.settings.activeAgent,"");
  f.close();
});
