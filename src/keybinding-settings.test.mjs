import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { normalizeKeyCombo, keyEventCombo, setupKeybindingSettings, terminalKeySequence } from "./keybinding-settings.ts";

const flush=()=>new Promise((done)=>setImmediate(done));
function fixture(options={}) {
  const window=new Window();
  window.document.body.innerHTML='<input id="keybind-search"><div id="keybind-status"></div><div id="keybind-list"></div>';
  const old={window:globalThis.window,document:globalThis.document,localStorage:globalThis.localStorage};
  Object.assign(globalThis,{window,document:window.document,localStorage:window.localStorage});
  for (const [key,value] of Object.entries(options.storage||{})) window.localStorage.setItem(key,value);
  const calls=[];
  const controller=setupKeybindingSettings({
    nativeReady:()=>options.connected!==false,translate:(key)=>key,
    invoke:async(command,args)=>{calls.push([command,args]);if(options.fail===command)throw Error("failed");return command==="read_keybindings"?(options.overrides||{}):{};},
  });
  const record=(id)=>window.document.querySelector(`[data-keybind="${id}"]`).click();
  const key=(value,extra={})=>{
    const event=new window.KeyboardEvent("keydown",{key:value,bubbles:true,cancelable:true,...extra});
    window.document.body.dispatchEvent(event);return event;
  };
  return {window,controller,calls,record,key,
    close(){controller.dispose();window.happyDOM.abort();Object.assign(globalThis,old);}};
}
test("macOS key capture uses physical Option keys, canonical modifiers and valid Pi key IDs", () => {
  assert.equal(normalizeKeyCombo("shift+cmd+P"),"shift+super+p");
  assert.equal(normalizeKeyCombo("Ctrl+PageDown"),"ctrl+pageDown");
  for(const value of ["ctrl+ctrl+a","cmd+evil","../x","a+b","f13","f24",null,123])assert.equal(normalizeKeyCombo(value),null);
  assert.equal(keyEventCombo({key:"∂",code:"KeyD",altKey:true,ctrlKey:true}),"ctrl+alt+d");
  assert.equal(keyEventCombo({key:":",code:"Semicolon",shiftKey:true,ctrlKey:true}),"ctrl+shift+;");
  assert.equal(keyEventCombo({key:"+",code:"Equal",shiftKey:true,metaKey:true}),"shift+super+=");
  assert.equal(keyEventCombo({key:"Process",code:"KeyA",isComposing:true}),null);
  assert.equal(terminalKeySequence({key:"l",code:"KeyL",metaKey:true}),"\x1b[108;9u");
});
test("function-key forwarding emits only native Pi-supported sequences", () => {
  const codes=[11,12,13,14,15,17,18,19,20,21,23,24];
  for(const [index,code] of codes.entries())
    assert.equal(terminalKeySequence({key:`F${index+1}`}),`\x1b[${code}~`);
  assert.equal(terminalKeySequence({key:"F1",metaKey:true}),undefined);
  assert.equal(terminalKeySequence({key:"F13"}),undefined);
});
test("GUI bindings record ahead of workbench handlers, persist and apply immediately", async () => {
  const f=fixture();await f.controller.ready;
  let leaked=0;f.window.document.addEventListener("keydown",()=>leaked++,true);
  f.record("gui.palette");
  const event=f.key("b",{metaKey:true,code:"KeyB"});await flush();
  assert.equal(event.defaultPrevented,true);assert.equal(leaked,0);
  assert.equal(f.controller.matches("gui.palette",{key:"b",metaKey:true}),true);
  assert.equal(f.controller.matches("gui.palette",{key:"k",metaKey:true}),false);
  assert.equal(JSON.parse(f.window.localStorage.getItem("pi.guiKeybindings"))["gui.palette"],"super+b");
  assert.equal(f.window.document.getElementById("keybind-status").textContent,"keybind.applied");
  f.close();
});
test("Pi bindings preserve existing config and reload the actual manager without a session reload", async () => {
  const f=fixture({overrides:{"app.model.select":"ctrl+l"}});await f.controller.ready;
  f.record("app.model.select");f.key("b",{ctrlKey:true,shiftKey:true,code:"KeyB"});await flush();
  assert.ok(f.calls.some(([command,args])=>command==="set_keybinding"&&args.action==="app.model.select"&&args.keys[0]==="ctrl+shift+b"));
  assert.ok(f.calls.some(([command,args])=>command==="gui_action"&&args.action==="keybindings"));
  assert.equal(f.controller.matches("app.model.select",{key:"b",ctrlKey:true,shiftKey:true}),true);
  f.close();
});
test("cancel, modifiers, IME and repeats never write a shortcut", async () => {
  const f=fixture();await f.controller.ready;
  f.record("gui.palette");f.key("Control",{ctrlKey:true});f.key("Process",{isComposing:true});f.key("b",{metaKey:true,repeat:true});
  f.key("Escape");await flush();
  assert.equal(f.calls.filter(([command])=>command==="set_keybinding").length,0);
  assert.equal(f.window.localStorage.getItem("pi.guiKeybindings"),null);
  assert.equal(f.window.document.body.dataset.keyRecording,undefined);
  f.close();
});
test("system and GUI conflicts are rejected without changing the current shortcut", async () => {
  const f=fixture();await f.controller.ready;
  f.record("gui.palette");f.key("p",{metaKey:true});await flush();
  assert.match(f.window.document.getElementById("keybind-status").textContent,/conflict/);
  f.key("q",{metaKey:true});await flush();
  assert.match(f.window.document.getElementById("keybind-status").textContent,/systemReserved/);
  assert.equal(f.controller.matches("gui.palette",{key:"k",metaKey:true}),true);
  f.close();
});
test("a failed native save keeps the previous binding and disconnected saves report pending activation", async () => {
  const f=fixture({fail:"set_keybinding"});await f.controller.ready;
  f.record("app.model.select");f.key("b",{ctrlKey:true});await flush();
  assert.equal(f.controller.matches("app.model.select",{key:"l",ctrlKey:true}),true);
  f.close();
  const offline=fixture({connected:false});await offline.controller.ready;
  offline.record("app.model.select");offline.key("b",{ctrlKey:true});await flush();
  assert.equal(offline.window.document.getElementById("keybind-status").textContent,"keybind.savedPending");
  offline.close();
});
test("GUI settings restore valid overrides and discard malformed stored combinations", async () => {
  const f=fixture({storage:{"pi.guiKeybindings":JSON.stringify({"gui.palette":"cmd+b","gui.files":"bad+key","gui.review":[]})}});
  await f.controller.ready;
  assert.equal(f.controller.matches("gui.palette",{key:"b",metaKey:true}),true);
  assert.equal(f.controller.matches("gui.files",{key:"p",metaKey:true}),true);
  assert.equal(f.controller.matches("gui.review",{key:"r",metaKey:true}),false);
  f.close();
});
test("recording rejects unsupported native function combinations without persisting dead shortcuts", async () => {
  const f=fixture();await f.controller.ready;
  f.record("app.model.select");f.key("F13");await flush();
  assert.equal(f.window.document.getElementById("keybind-status").textContent,"keybind.unsupportedKey");
  f.key("F1",{metaKey:true});await flush();
  assert.equal(f.window.document.getElementById("keybind-status").textContent,"keybind.functionModifiers");
  assert.equal(f.calls.filter(([command])=>command==="set_keybinding").length,0);
  f.key("F1");await flush();
  assert.ok(f.calls.some(([command,args])=>command==="set_keybinding"&&args.keys[0]==="f1"));
  f.close();
});
