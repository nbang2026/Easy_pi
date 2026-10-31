import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentLibrary } from "../src-tauri/src/gui-library.mjs";
import { CODING_AGENT, MARKET_CATALOG } from "../src-tauri/src/gui-market.mjs";
import { setupLibrarySettings } from "./library-settings.ts";
import { UI_STRINGS } from "./ui-strings.ts";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
const flush = async () => { for (let i=0;i<5;i++) await new Promise((done)=>setImmediate(done)); };

test("built-in coding workflow persists and reaches context without importing or changing a model", async () => {
  const directory=await mkdtemp(join(tmpdir(),"easy-pi-coding-role-"));
  try {
    const library=createAgentLibrary({directory});
    const initial=await library.run({kind:"list"});
    assert.equal(initial.agents.length,0);assert.equal(MARKET_CATALOG.length,64);
    assert.equal(initial.builtinAgents[0].id,CODING_AGENT.id);
    await library.run({kind:"settings",activeAgent:CODING_AGENT.id});
    const fresh=createAgentLibrary({directory});
    const context=await fresh.run({kind:"context"});
    assert.equal(context.agent.content,CODING_AGENT.content);
    assert.match(context.agent.content,/model-independent/);
    assert.match(context.agent.content,/inspect evidence/);
    const stored=JSON.parse(await readFile(join(directory,"library.json"),"utf8"));
    assert.equal(stored.agents.length,0);assert.equal(stored.settings.activeAgent,CODING_AGENT.id);
    assert.equal(stored.settings.model,undefined);
    assert.deepEqual(await fresh.run({kind:"agent",action:"read",id:CODING_AGENT.id}),CODING_AGENT);
    await assert.rejects(fresh.run({kind:"settings",activeAgent:"builtin:unknown"}));
    await assert.rejects(fresh.run({kind:"settings",activeAgent:CODING_AGENT.id},"model"));
    await assert.rejects(fresh.run({kind:"agent",action:"remove",id:CODING_AGENT.id}));
    await assert.rejects(fresh.run({kind:"agent",action:"save",id:CODING_AGENT.id,title:"Override",content:"Override"}));
    await fresh.run({kind:"settings",activeAgent:""});
    assert.equal((await fresh.run({kind:"context"})).agent,null);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("Agent roles stay separate from the dedicated Pi, Claude, and automatic engine picker", async () => {
  const window=new Window();window.document.write(readFileSync(new URL("../index.html",import.meta.url),"utf8"));
  const old={document:globalThis.document,window:globalThis.window};Object.assign(globalThis,{document:window.document,window});
  let active="engine:claude";const calls=[];
  const ui=setupLibrarySettings({translate:(k)=>k,
    invoke:async(command,args)=>{calls.push(command);const request=JSON.parse(args.text);if(request.kind==="settings")active=request.activeAgent;return {data:request.kind==="list"?{settings:{memoryEnabled:true,autonomousDownloads:true,activeAgent:active},agents:[{id:"engine:claude",title:"Claude",content:"legacy engine option"}],memories:[],builtinAgents:[{id:CODING_AGENT.id,title:CODING_AGENT.title}]}:{activeAgent:active}};}
  });
  try {
    ui.refresh();await flush();const picker=window.document.getElementById("role-select");
    const enginePicker=window.document.getElementById("agent-select");
    assert.ok(window.document.getElementById("claude-connection"));
    assert.deepEqual([...picker.options].map((o)=>o.value),["",CODING_AGENT.id]);
    assert.deepEqual([...enginePicker.options].map((o)=>o.value),["auto","pi","claude"]);
    assert.equal(picker.value,"");
    assert.equal(picker.closest("label").classList.contains("is-active"),false);
    picker.value=CODING_AGENT.id;picker.dispatchEvent(new window.Event("change"));await flush();
    assert.equal(active,CODING_AGENT.id);
    assert.ok(calls.every((command)=>command==="gui_action"));
    picker.value="";picker.dispatchEvent(new window.Event("change"));await flush();
    assert.equal(active,"");
  } finally {ui.dispose();window.happyDOM.abort();Object.assign(globalThis,old);}
});

test("default core option enables automatic matching in Chinese and English", () => {
  assert.equal(UI_STRINGS.zh["library.noAgent"],"自动匹配");
  assert.equal(UI_STRINGS.en["library.noAgent"],"Auto match");
  const markup=readFileSync(new URL("../index.html",import.meta.url),"utf8");
  assert.ok(markup.includes('data-i18n="library.noAgent">自动匹配</option>'));
});
