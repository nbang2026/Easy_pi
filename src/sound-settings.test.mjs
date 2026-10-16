import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { setupSoundSettings } from "./sound-settings.ts";
import { SoundError } from "./sound-packs.ts";

const pack=(name="My pack") => ({id:`custom-${crypto.randomUUID()}`,name,sounds:{click:{filename:"click.wav",bytes:new ArrayBuffer(8)}}});
const flush=async() => {await new Promise((resolve) => setImmediate(resolve));await new Promise((resolve) => setImmediate(resolve));};
function fixture(options={}) {
  const window=new Window({settings:{disableJavaScriptEvaluation:true,disableJavaScriptFileLoading:true,disableCSSFileLoading:true}});
  window.document.write(readFileSync(new URL("../index.html",import.meta.url),"utf8"));
  const old={document:globalThis.document,localStorage:globalThis.localStorage,Element:globalThis.Element};
  Object.assign(globalThis,{document:window.document,localStorage:window.localStorage,Element:window.Element});
  for (const [key,value] of Object.entries(options.preferences || {})) window.localStorage.setItem(key,value);
  const calls=[];
  let saved=[...(options.packs || [])];
  const player={
    setEventEnabled:(event,value) => calls.push(["eventEnabled",event,value]),
    setEnabled:(value) => calls.push(["enabled",value]),
    setVolume:(value) => calls.push(["volume",value]),
    play:async(event) => {calls.push(["play",event]);},
    prepare:async(value) => {calls.push(["prepare",value.id]);return {click:{}};},
    useBuiltin:(id) => calls.push(["builtin",id]),
    usePrepared:(value) => calls.push(["prepared",value]),
    dispose:() => calls.push(["dispose"]),
    ...options.player,
  };
  const store={
    list:async() => saved,
    save:async(value) => {calls.push(["save",value.id]);saved.push(value);},
    remove:async(id) => {calls.push(["remove",id]);saved=saved.filter((value) => value.id!==id);},
    ...options.store,
  };
  const controller=setupSoundSettings({translate:(key) => `${options.language?.() || "zh"}:${key}`,
    store,player,readPack:options.readPack || (async() => pack())});
  const el=(id) => window.document.getElementById(id);
  const change=(id) => el(id).dispatchEvent(new window.Event("change",{bubbles:true}));
  const choose=(file={name:"sounds.zip",size:16}) => {
    Object.defineProperty(el("sound-file"),"files",{value:[file],configurable:true});
    change("sound-file");
  };
  const trusted=(id) => {
    const event=new window.MouseEvent("click",{bubbles:true,cancelable:true});
    Object.defineProperty(event,"isTrusted",{value:true});
    el(id).dispatchEvent(event);
    return event;
  };
  return {window,controller,calls,el,change,choose,trusted,saved:() => saved,
    close(){controller.dispose();window.happyDOM.abort();Object.assign(globalThis,old);}};
}

test("sound settings are confined to appearance and keep the agreed composer layout", async () => {
  const f=fixture();await f.controller.ready;
  assert.equal(f.el("sound-switch").closest(".settings-pane").id,"pane-appearance");
  assert.equal(f.el("composer").nextElementSibling.id,"input-tools");
  assert.equal(f.el("model-open").closest(".input-tools").id,"input-tools");
  assert.equal(f.el("sound-pack").value,"builtin-soft");
  assert.equal(f.el("sound-volume").value,"25");
  assert.equal(f.el("sound-switch").checked,true);
  assert.ok(!f.calls.some(([name]) => name==="play"));
  f.close();
});

test("muting is immediate, enables no playback and persists across restart", async () => {
  const f=fixture();await f.controller.ready;
  f.el("sound-switch").checked=false;f.change("sound-switch");
  assert.deepEqual(f.calls.at(-1),["enabled",false]);
  assert.equal(f.window.localStorage.getItem("pi.soundEnabled"),"0");
  assert.equal(f.el("sound-preview").disabled,true);
  f.el("sound-switch").checked=true;f.change("sound-switch");
  assert.deepEqual(f.calls.at(-1),["play","toggle"]);
  f.close();
  const restarted=fixture({preferences:{"pi.soundEnabled":"0","pi.soundVolume":"12"}});
  await restarted.controller.ready;
  assert.equal(restarted.el("sound-switch").checked,false);
  assert.equal(restarted.el("sound-volume").value,"12");
  restarted.close();
});

test("volume and preview controls use the current settings and zero volume disables preview", async () => {
  const f=fixture();await f.controller.ready;
  f.el("sound-volume").value="0";f.el("sound-volume").dispatchEvent(new f.window.Event("input"));
  assert.equal(f.el("sound-volume-value").value,"0%");
  assert.equal(f.el("sound-preview").disabled,true);
  f.el("sound-volume").value="40";f.el("sound-volume").dispatchEvent(new f.window.Event("input"));
  f.el("sound-preview").click();
  assert.deepEqual(f.calls.at(-1),["play","click"]);
  assert.equal(f.window.localStorage.getItem("pi.soundVolume"),"40");
  f.close();
});

test("trusted button clicks retain their action while synthetic, disabled and hidden clicks are silent", async () => {
  const f=fixture();await f.controller.ready;
  let actions=0;f.el("frame-toggle").addEventListener("click",() => actions++);
  const event=f.trusted("frame-toggle");
  assert.equal(actions,1);assert.equal(event.defaultPrevented,false);
  const played=f.calls.filter(([name]) => name==="play").length;
  assert.equal(played,1);
  f.el("frame-toggle").click();f.trusted("composer-send");
  f.el("settings-panel").hidden=false;f.el("pane-appearance").hidden=false;
  f.trusted("sound-switch");
  assert.equal(f.calls.filter(([name]) => name==="play").length,played);
  assert.equal(actions,2);
  f.close();
});

test("custom packs restore silently, names remain text-safe and language refresh preserves selection", async () => {
  const value=pack("<img src=x onerror=bad()>");let language="zh";
  const f=fixture({packs:[value],preferences:{"pi.soundPack":value.id},language:() => language});
  await f.controller.ready;
  assert.equal(f.el("sound-pack").value,value.id);
  assert.ok(f.calls.some(([name]) => name==="prepared"));
  assert.ok(!f.calls.some(([name]) => name==="play"));
  assert.equal(f.el("sound-pack").querySelector("img"),null);
  assert.equal(f.el("sound-pack").lastElementChild.textContent,value.name);
  language="en";f.controller.refreshLanguage();
  assert.equal(f.el("sound-pack").firstElementChild.textContent,"en:sound.soft");
  assert.equal(f.el("sound-pack").value,value.id);
  f.close();
});

test("import validates audio before saving and selecting a sound pack", async () => {
  const value=pack();
  const f=fixture({readPack:async() => value});await f.controller.ready;
  f.choose();await flush();
  assert.deepEqual(f.calls.filter(([name]) => ["prepare","save","prepared"].includes(name)).map(([name]) => name),
    ["prepare","save","prepared"]);
  assert.equal(f.saved().length,1);
  assert.equal(f.el("sound-pack").value,value.id);
  assert.equal(f.window.localStorage.getItem("pi.soundPack"),value.id);
  assert.equal(f.el("sound-status").textContent,"zh:sound.imported");
  assert.equal(f.el("sound-file").value,"");
  f.close();
});

test("invalid audio and storage failures preserve the previous pack and do not record success", async () => {
  for (const options of [
    {player:{prepare:async() => {throw new SoundError("invalidAudio");}}},
    {store:{save:async() => {throw new SoundError("storageFailed");}}},
  ]) {
    const f=fixture(options);await f.controller.ready;
    f.choose();await flush();
    assert.equal(f.el("sound-pack").value,"builtin-soft");
    assert.equal(f.saved().length,0);
    assert.ok(!f.calls.some(([name]) => name==="prepared"));
    assert.notEqual(f.el("sound-status").textContent,"zh:sound.imported");
    assert.equal(f.el("sound-import").disabled,false);
    f.close();
  }
});

test("switching and removing custom packs use the actual stored pack and restore default playback", async () => {
  const value=pack();
  const f=fixture({packs:[value]});await f.controller.ready;
  f.el("sound-pack").value=value.id;f.change("sound-pack");await flush();
  assert.equal(f.el("sound-remove").disabled,false);
  f.el("sound-remove").click();await flush();
  assert.equal(f.el("sound-pack").value,"builtin-soft");
  assert.equal(f.saved().length,0);
  assert.equal(f.window.localStorage.getItem("pi.soundPack"),"builtin-soft");
  assert.equal(f.el("sound-remove").disabled,true);
  f.close();
});

test("missing or damaged stored packs fall back without disabling main application controls", async () => {
  const value=pack();
  const f=fixture({packs:[value],preferences:{"pi.soundPack":value.id},
    player:{prepare:async() => {throw new SoundError("invalidAudio");}}});
  await f.controller.ready;
  assert.equal(f.el("sound-pack").value,"builtin-soft");
  assert.equal(f.el("sound-status").textContent,"zh:sound.invalidAudio");
  assert.equal(f.el("frame-toggle").disabled,false);
  assert.equal(f.el("model-open").disabled,false);
  f.close();
});

test("the sound-pack limit is enforced without parsing or retaining a ninth import", async () => {
  let reads=0;
  const f=fixture({packs:Array.from({length:8},() => pack()),readPack:async() => {reads++;return pack();}});
  await f.controller.ready;f.choose();await flush();
  assert.equal(reads,0);
  assert.equal(f.el("sound-status").textContent,"zh:sound.tooMany");
  f.close();
});

test("disposal stops playback and pending imports cannot write or change the current pack", async () => {
  let resolve;const reading=new Promise((done) => {resolve=done;});
  const f=fixture({readPack:() => reading});await f.controller.ready;
  f.choose();f.controller.dispose();resolve(pack());await flush();
  assert.ok(!f.calls.some(([name]) => name==="save"));
  const count=f.calls.filter(([name]) => name==="play").length;
  f.trusted("frame-toggle");assert.equal(f.calls.filter(([name]) => name==="play").length,count);
  f.close();
});
test("trusted typing uses its own switch and keeps IME input uncancelled", async () => {
  const f=fixture();await f.controller.ready;
  const input=()=> {
    const event=new f.window.InputEvent("beforeinput",{inputType:"insertCompositionText",data:"你",isComposing:true,bubbles:true,cancelable:true});
    Object.defineProperty(event,"isTrusted",{value:true});f.el("composer-input").dispatchEvent(event);return event;
  };
  assert.equal(input().defaultPrevented,false);
  assert.deepEqual(f.calls.at(-1),["play","typing"]);
  f.el("sound-typing-switch").checked=false;f.change("sound-typing-switch");
  const count=f.calls.filter(([name])=>name==="play").length;input();
  assert.equal(f.calls.filter(([name])=>name==="play").length,count);
  assert.equal(f.window.localStorage.getItem("pi.soundTyping"),"0");
  f.close();
});
test("wheel sounds do not cancel scrolling, react to output, or run after the scroll switch is off", async () => {
  const f=fixture();await f.controller.ready;
  const input=f.el("composer-input");input.style.overflowY="auto";
  Object.defineProperties(input,{clientHeight:{value:60},scrollHeight:{value:400}});
  const wheel=()=> {
    const event=new f.window.WheelEvent("wheel",{deltaY:20,bubbles:true,cancelable:true});
    Object.defineProperty(event,"isTrusted",{value:true});input.dispatchEvent(event);return event;
  };
  assert.equal(wheel().defaultPrevented,false);
  assert.deepEqual(f.calls.at(-1),["play","scroll"]);
  const count=f.calls.filter(([name])=>name==="play").length;
  input.dispatchEvent(new f.window.Event("scroll",{bubbles:true}));wheel();
  assert.equal(f.calls.filter(([name])=>name==="play").length,count);
  f.el("sound-scroll-switch").checked=false;f.change("sound-scroll-switch");wheel();
  assert.equal(f.window.localStorage.getItem("pi.soundScroll"),"0");
  f.close();
});
