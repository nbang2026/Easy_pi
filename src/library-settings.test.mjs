import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { setupLibrarySettings } from "./library-settings.ts";

const flush=async()=>{await new Promise((done)=>setImmediate(done));await new Promise((done)=>setImmediate(done));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(options={}) {
  const window=new Window({settings:{disableJavaScriptEvaluation:true,disableJavaScriptFileLoading:true,disableCSSFileLoading:true}});
  window.document.write(readFileSync(new URL("../index.html",import.meta.url),"utf8"));
  const old={window:globalThis.window,document:globalThis.document};
  Object.assign(globalThis,{window,document:window.document});
  window.confirm=()=>true;
  const data={executionMode:options.executionMode,settings:{memoryEnabled:true,autonomousDownloads:true},memories:options.memories||[],agents:options.agents||[]};
  const calls=[];
  const controller=setupLibrarySettings({translate:(key)=>key,openMarket:options.openMarket,invoke:async(command,args)=>{
    assert.equal(command,"gui_action");assert.equal(args.action,"library");
    const request=JSON.parse(args.text);calls.push(request);
    if(options.fail&&options.fail===request.action)throw Error("failed");
    if(request.kind==="list"){
      const previews=(items)=>items.map((item)=>({...item,content:item.content.slice(0,160)}));
      return {data:structuredClone({...data,memories:previews(data.memories),agents:previews(data.agents)})};
    }
    if(request.kind==="settings"){Object.assign(data.settings,request);return {data:data.settings};}
    const items=request.kind==="memory"?data.memories:data.agents;
    if(request.action==="list"){
      if(options.query)return {data:await options.query(request)};
      const query=(request.query||"").toLowerCase().slice(0,200);
      return {data:structuredClone(items.filter((item)=>`${item.title} ${item.content}`.toLowerCase().includes(query)).map(({id,title,source,updatedAt})=>({id,title,source,updatedAt})))};
    }
    if(request.action==="read")return {data:structuredClone(items.find((item)=>item.id===request.id))};
    if(request.action==="remove"){items.splice(items.findIndex((item)=>item.id===request.id),1);return {data:{removed:true}};}
    if(request.action==="download"){const item={id:crypto.randomUUID(),title:"Reviewer",content:"# Agent",updatedAt:Date.now()};items.push(item);return {data:structuredClone(item)};}
    const index=items.findIndex((item)=>item.id===request.id);
    const item={id:index<0?crypto.randomUUID():request.id,title:request.title,content:request.content,updatedAt:Date.now()};
    if(index<0)items.push(item);else items[index]=item;return {data:structuredClone(item)};
  }});
  const el=(id)=>window.document.getElementById(id);
  const change=(id)=>el(id).dispatchEvent(new window.Event("change",{bubbles:true}));
  const search=(value)=>{el("library-search").value=value;el("library-search").dispatchEvent(new window.Event("input",{bubbles:true}));};
  const titles=()=>[...el("library-list").querySelectorAll("button span")].map((label)=>label.textContent);
  return {window,controller,calls,data,el,change,search,titles,close(){controller.dispose();window.happyDOM.abort();Object.assign(globalThis,old);}};
}
test("confirm mode shows the actual restricted permissions instead of pending", async () => {
  const f=fixture({executionMode:"confirm"});
  try {
    f.controller.refresh();await flush();
    assert.equal(f.el("download-effective").textContent,"library.downloadRestricted");
    assert.equal(f.el("memory-effective").textContent,"library.memoryReadOnly");
  } finally {f.close();}
});
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
test("authorization persists and local Agent downloads route to the single market", async () => {
  let opened=0;
  const f=fixture({openMarket:()=>opened++});f.controller.refresh();await flush();
  f.el("agent-download-switch").checked=false;f.change("agent-download-switch");await flush();
  assert.equal(f.data.settings.autonomousDownloads,false);
  f.el("library-kind").value="agent";f.change("library-kind");
  assert.equal(f.el("agent-download-row").hidden,false);
  assert.equal(f.el("agent-source"),null);
  f.el("library-open-market").click();await flush();
  assert.equal(opened,1);
  assert.equal(f.calls.some(call=>call.action==="download"),false);
  f.el("library-content").value="Keep draft";
  f.el("library-open-market").click();assert.equal(opened,1);
  assert.equal(f.el("library-status").textContent,"library.unsaved");
  f.close();
});
test("library search finds unique terms beyond 200 characters in memory and Agent bodies", async (context) => {
  const memory={id:"memory",title:"Long memory",content:"m".repeat(240)+" memory-tail-unique",updatedAt:1};
  const agent={id:"agent",title:"Long Agent",content:"a".repeat(240)+" agent-tail-unique",updatedAt:2};
  const f=fixture({memories:[memory],agents:[agent]});context.after(()=>f.close());
  context.mock.timers.enable({apis:["setTimeout"]});
  f.controller.refresh();await flush();
  f.search("memory-tail");context.mock.timers.tick(50);await flush();
  assert.equal(f.calls.filter((call)=>call.action==="list").length,0,"input is debounced");
  f.search(" MEMORY-TAIL-UNIQUE ");context.mock.timers.tick(500);await flush();
  assert.equal(f.calls.filter((call)=>call.action==="list").length,1,"rapid input is coalesced within a bounded delay");
  assert.equal(f.calls.at(-1).kind,"memory");assert.equal(f.calls.at(-1).query.trim().toLowerCase(),"memory-tail-unique");
  assert.deepEqual(f.titles(),[memory.title]);
  f.el("library-list").querySelector("button").click();await flush();
  assert.equal(f.el("library-content").value,memory.content,"search metadata still opens the complete record");
  f.el("library-kind").value="agent";f.change("library-kind");
  f.search("agent-tail-unique");context.mock.timers.tick(500);await flush();
  assert.equal(f.calls.at(-1).kind,"agent");assert.deepEqual(f.titles(),[agent.title]);
  assert.deepEqual([...f.el("role-select").options].map((option)=>option.value),["",agent.id],"filtered results do not replace the picker inventory");
});
test("query responses arriving out of order cannot replace newer results or unsaved edits", async (context) => {
  const items=[{id:"a",title:"Alpha",content:"alpha",updatedAt:1},{id:"b",title:"Beta",content:"beta",updatedAt:2}];
  const first=deferred(),second=deferred();
  const f=fixture({memories:items,query:(request)=>request.query==="alpha"?first.promise:second.promise});context.after(()=>f.close());
  context.mock.timers.enable({apis:["setTimeout"]});
  f.controller.refresh();await flush();
  f.el("library-list").querySelector("button").click();await flush();
  f.el("library-content").value="Keep this draft";
  f.search("alpha");context.mock.timers.tick(500);await flush();
  assert.equal(f.calls.at(-1).action,"list");assert.equal(f.el("library-list").getAttribute("aria-busy"),"true");
  assert.deepEqual(f.titles(),["Beta","Alpha"],"cached rows remain visible while the query runs");
  assert.equal(f.el("library-content").disabled,false,"search does not lock the editor");
  f.search("beta");context.mock.timers.tick(500);await flush();
  second.resolve([items[1]]);await flush();assert.deepEqual(f.titles(),["Beta"]);
  first.resolve([items[0]]);await flush();assert.deepEqual(f.titles(),["Beta"]);
  assert.equal(f.el("library-list").getAttribute("aria-busy"),"false");
  assert.equal(f.el("library-content").value,"Keep this draft");
  assert.equal(f.el("library-list").querySelector("button").getAttribute("aria-pressed"),"true");
});
test("typing, clearing, switching kind and disposal invalidate pending searches immediately", async (context) => {
  const memory={id:"m",title:"Memory",content:"body",updatedAt:1};
  const agent={id:"a",title:"Agent",content:"body",updatedAt:1};
  const pending=[];
  const f=fixture({memories:[memory],agents:[agent],query:()=>{const job=deferred();pending.push(job);return job.promise;}});context.after(()=>f.close());
  context.mock.timers.enable({apis:["setTimeout"]});
  f.controller.refresh();await flush();
  f.search("first");context.mock.timers.tick(500);await flush();assert.equal(pending.length,1);
  f.search("second");pending[0].resolve([{...memory,title:"Stale typing"}]);await flush();
  assert.deepEqual(f.titles(),["Memory"],"a response is stale before the next debounce fires");
  context.mock.timers.tick(500);await flush();assert.equal(pending.length,2);
  f.search("");pending[1].reject(Error("stale error"));await flush();
  assert.deepEqual(f.titles(),["Memory"]);assert.notEqual(f.el("library-status").textContent,"Error: stale error");
  f.search("body");context.mock.timers.tick(500);await flush();assert.equal(pending.length,3);
  f.el("library-kind").value="agent";f.change("library-kind");
  pending[2].resolve([{...memory,title:"Stale kind"}]);await flush();
  assert.deepEqual(f.titles(),["Agent"]);
  context.mock.timers.tick(500);await flush();assert.equal(pending.length,4);
  const html=f.el("library-list").innerHTML;
  f.controller.dispose();pending[3].resolve([{...agent,title:"Disposed"}]);await flush();
  assert.equal(f.el("library-list").innerHTML,html);
  f.search("after disposal");context.mock.timers.tick(500);await flush();assert.equal(pending.length,4);
});
test("refresh reruns the active full-body query while keeping cached rows and editor selection", async (context) => {
  const item={id:"m",title:"Selected",content:"x".repeat(240)+" needle",updatedAt:1};
  const next={...item,id:"n",title:"New match"};
  const refreshed=deferred();let queries=0;
  const f=fixture({memories:[item],query:()=>++queries===1?[item]:refreshed.promise});context.after(()=>f.close());
  context.mock.timers.enable({apis:["setTimeout"]});
  f.controller.refresh();await flush();f.el("library-list").querySelector("button").click();await flush();
  f.el("library-content").value="Draft stays";
  f.search("needle");context.mock.timers.tick(500);await flush();assert.equal(queries,1);
  f.data.memories.push(next);f.controller.refresh();await flush();
  assert.equal(queries,2,"inventory refresh also refreshes the active full-body search");
  assert.deepEqual(f.titles(),["Selected"],"cached query results survive refresh until the query resolves");
  assert.equal(f.el("library-list").getAttribute("aria-busy"),"true");
  refreshed.resolve([item,next]);await flush();
  assert.deepEqual(f.titles(),["Selected","New match"]);
  assert.equal(f.el("library-content").value,"Draft stays");
  assert.equal(f.el("library-list").querySelector("button").getAttribute("aria-pressed"),"true");
  assert.equal(f.el("library-refresh").disabled,false);
  f.search("");await flush();assert.deepEqual(f.titles(),["Selected","New match"]);
});
test("current query errors release busy state and allow a later search", async (context) => {
  const item={id:"m",title:"Memory",content:"body",updatedAt:1};
  let failed=true;
  const f=fixture({memories:[item],query:()=>{if(failed)throw Error("query failed");return [item];}});context.after(()=>f.close());
  context.mock.timers.enable({apis:["setTimeout"]});
  f.controller.refresh();await flush();f.search("body");context.mock.timers.tick(500);await flush();
  assert.equal(f.el("library-status").textContent,"Error: query failed");
  assert.equal(f.el("library-list").getAttribute("aria-busy"),"false");
  assert.equal(f.el("library-content").disabled,false);
  failed=false;f.search("memory");context.mock.timers.tick(500);await flush();assert.deepEqual(f.titles(),["Memory"]);
});
test("the active Agent can be chosen from the library pane or the input-bar picker", async () => {
  const agents=[{id:"b",title:"Writer",content:"# W",updatedAt:1},{id:"a",title:"Reviewer",content:"# R",updatedAt:2}];
  const f=fixture({agents});f.controller.refresh();await flush();
  const picker=f.el("role-select");
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
  picker.value="b";f.change("role-select");await flush();
  assert.equal(f.data.settings.activeAgent,"b");assert.equal(picker.value,"b");
  picker.value="";f.change("role-select");await flush();
  assert.equal(f.data.settings.activeAgent,"");
  f.close();
});
