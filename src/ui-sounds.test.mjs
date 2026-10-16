import assert from "node:assert/strict";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { Window } from "happy-dom";
import { IDBFactory } from "fake-indexeddb";
import {
  createSoundPackStore, isStoredSoundPack, MAX_SOUND_FILE, packFromEntries, readSoundPack, SoundError,
} from "./sound-packs.ts";
import { canScrollTarget, createSoundPlayer, isNativeTypingKey, isTypingInput, soundForTarget, soundPreferences, validateSoundBuffer } from "./ui-sounds.ts";

const bytes = () => new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]).buffer;
const pack = () => ({id:`custom-${crypto.randomUUID()}`,name:"Custom",sounds:{click:{filename:"click.wav",bytes:bytes()}}});
const fail = (code) => (error) => error instanceof SoundError && error.code === code;

function audioFixture(options = {}) {
  const buffers = [];
  const sources = [];
  const gains = [];
  let time = 0;
  let created = 0;
  const buffer = (duration = 0.1, channels = 1, rate = 48000) => {
    const samples = Array.from({length:channels}, () => new Float32Array(Math.ceil(duration * rate)));
    return {duration,numberOfChannels:channels,sampleRate:rate,getChannelData:(index) => samples[index]};
  };
  const context = {
    state:"running",sampleRate:48000,currentTime:1,destination:{},
    createBuffer(channels,length,rate) {const result=buffer(length/rate,channels,rate);buffers.push(result);return result;},
    createGain() {const result={gain:{value:1,setValueAtTime(){},linearRampToValueAtTime(){}},connect(){},disconnect(){}};gains.push(result);return result;},
    createBufferSource() {
      const result={buffer:null,onended:null,started:false,stopped:false,connect(){},disconnect(){},
        start(...args){this.started=true;this.startArgs=args;},stop(){this.stopped=true;this.onended?.();}};
      sources.push(result);return result;
    },
    async resume() {context.state="running";},
    async close() {context.state="closed";},
    async decodeAudioData() {return buffer();},
  };
  const errors = [];
  const player=createSoundPlayer({
    createContext:() => {created++;return context;},validateDuration:async() => {},
    now:() => time,onError:(error) => errors.push(error),...options,
  });
  return {player,context,buffers,sources,gains,errors,buffer,
    tick:() => {time+=50;},setTime:(value) => {time=value;},created:() => created};
}

test("sound preferences are bounded, persisted independently and default to a quiet enabled pack", () => {
  const prefs=(values) => soundPreferences({getItem:(key) => values[key] ?? null});
  assert.deepEqual(prefs({}),{enabled:true,typing:true,scroll:true,volume:25,packId:"builtin-soft"});
  assert.deepEqual(prefs({"pi.soundEnabled":"0","pi.soundVolume":"200","pi.soundPack":"evil"}),
    {enabled:false,typing:true,scroll:true,volume:100,packId:"builtin-soft"});
  assert.equal(prefs({"pi.soundVolume":"NaN"}).volume,25);
  assert.equal(prefs({"pi.soundVolume":"-5"}).volume,0);
  assert.equal(soundPreferences({getItem(){throw Error("blocked");}}).volume,25);
});

test("typing handles Chinese composition and native keys without sounding shortcuts, paste or secrets", () => {
  const window=new Window();const old=globalThis.Element;globalThis.Element=window.Element;
  try {
    window.document.body.innerHTML='<textarea id="composer"></textarea><input type="password" id="secret"><div id="terminal"><textarea id="native"></textarea></div>';
    const target=window.document.getElementById("composer");
    for(const inputType of ["insertText","insertCompositionText","insertFromComposition","deleteContentBackward"])
      assert.equal(isTypingInput({target,inputType,isComposing:true}),true);
    for(const inputType of ["insertFromPaste","insertFromDrop","historyUndo"])assert.equal(isTypingInput({target,inputType}),false);
    assert.equal(isTypingInput({target:window.document.getElementById("secret"),inputType:"insertText"}),false);
    const native=window.document.getElementById("native");
    assert.equal(isNativeTypingKey({target:native,key:"a"}),true);
    for(const extra of [{metaKey:true},{ctrlKey:true},{altKey:true},{isComposing:true}])
      assert.equal(isNativeTypingKey({target:native,key:"a",...extra}),false);
  } finally {globalThis.Element=old;window.happyDOM.abort();}
});
test("wheel feedback checks a real scrollable target and its boundaries, including native history", () => {
  const window=new Window();const old=globalThis.Element;globalThis.Element=window.Element;
  try {
    window.document.body.innerHTML='<div id="scroll" style="overflow-y:auto"><span id="child"></span></div><div id="terminal"></div>';
    const scroll=window.document.getElementById("scroll");
    Object.defineProperties(scroll,{clientHeight:{value:100},scrollHeight:{value:500}});
    assert.equal(canScrollTarget(scroll.firstChild,0,10),true);
    assert.equal(canScrollTarget(scroll.firstChild,0,-10),false);
    scroll.scrollTop=400;
    assert.equal(canScrollTarget(scroll,0,10),false);
    assert.equal(canScrollTarget(scroll,0,-10),true);
    assert.equal(canScrollTarget(window.document.getElementById("terminal"),0,-5,()=>true),true);
  } finally {globalThis.Element=old;window.happyDOM.abort();}
});
test("typing and scroll buffers stay short and cannot delay a button sound", async () => {
  const f=audioFixture();
  await f.player.play("typing");await f.player.play("scroll");await f.player.play("click");
  assert.equal(f.sources.length,3);
  assert.equal(f.sources[0].buffer.duration,0.025);
  assert.ok(Math.abs(f.sources[1].buffer.duration-0.035)<=1/48000+1e-9);
  assert.ok(f.sources.at(-1).started);
  assert.equal(f.sources.filter((source)=>source.started&&!source.stopped).length,2);
  f.player.setEventEnabled("typing",false);f.tick();await f.player.play("typing");
  assert.equal(f.sources.length,3);
  f.player.dispose();
});
test("legacy custom click clips fall back for typing and scroll with short duration caps", async () => {
  const f=audioFixture();
  const prepared={click:f.buffer(2)};
  f.player.usePrepared(prepared);
  await f.player.play("typing");await f.player.play("scroll");
  assert.equal(f.sources[0].startArgs[2],0.07);
  assert.equal(f.sources[1].startArgs[2],0.09);
  f.player.dispose();
});
test("custom sound manifests support optional typing and scroll without changing old pack versions", () => {
  const imported=packFromEntries({"soundpack.json":strToU8(JSON.stringify({version:1,name:"All",sounds:{click:"click.wav",typing:"typing.wav",scroll:"scroll.wav"}})),
    "click.wav":new Uint8Array(bytes()),"typing.wav":new Uint8Array(bytes()),"scroll.wav":new Uint8Array(bytes())},"sounds.zip");
  assert.ok(imported.sounds.typing&&imported.sounds.scroll);
  assert.equal(soundPreferences({getItem:(key)=>key==="pi.soundTyping"?"0":null}).typing,false);
});

test("button sounds use nested targets without consuming input, hidden, disabled or terminal controls", () => {
  const window=new Window();
  const previous=globalThis.Element;globalThis.Element=window.Element;
  try {
    window.document.body.innerHTML='<button id="a"><span>Click</span></button><button disabled id="disabled"></button>'
      +'<button data-sound="send" id="send"></button><input type="checkbox" id="toggle">'
      +'<div hidden><button id="hidden"></button></div><div id="terminal"><button id="native"></button></div>'
      +'<button data-sound="none" id="mute"></button><input id="text"><button id="panel-close"></button>';
    const target=(id) => window.document.getElementById(id);
    assert.equal(soundForTarget(target("a").firstChild),"click");
    assert.equal(soundForTarget(target("send")),"send");
    assert.equal(soundForTarget(target("toggle")),"toggle");
    assert.equal(soundForTarget(target("panel-close")),"close");
    for (const id of ["disabled","hidden","native","mute","text"]) assert.equal(soundForTarget(target(id)),undefined);
  } finally {globalThis.Element=previous;window.happyDOM.abort();}
});

test("ZIP manifests can use a wrapper folder and optional event files", () => {
  const imported=packFromEntries({
    "Soft/soundpack.json":strToU8(JSON.stringify({version:1,name:"My sounds",sounds:{click:"click.wav",send:"send.mp3"}})),
    "Soft/click.wav":new Uint8Array(bytes()),"Soft/send.mp3":new Uint8Array(bytes()),
  },"pack.zip");
  assert.equal(imported.name,"My sounds");
  assert.equal(imported.sounds.send.filename,"Soft/send.mp3");
  assert.ok(isStoredSoundPack(imported));
});

test("plain packs infer event filenames and a single audio file is a reusable click pack", async () => {
  const imported=packFromEntries({"folder/click.WAV":new Uint8Array(bytes()),"toggle.mp3":new Uint8Array(bytes())},"Simple.zip");
  assert.equal(imported.name,"Simple");
  assert.ok(imported.sounds.toggle);
  const single=await readSoundPack(new File([bytes()],"custom.wav"));
  assert.equal(single.name,"custom.wav");
  assert.ok(single.sounds.click);
});

test("malformed manifests, unsafe paths, missing click and ambiguous filenames are rejected", () => {
  for (const entries of [
    {"../click.wav":new Uint8Array(bytes())},
    {"C:/click.wav":new Uint8Array(bytes())},
    {"a\\click.wav":new Uint8Array(bytes())},
    {"soundpack.json":strToU8("{")},
    {"click.wav":new Uint8Array(bytes()),"nested/click.wav":new Uint8Array(bytes())},
    {"soundpack.json":strToU8(JSON.stringify({version:1,name:"x",sounds:{click:"../a.wav"}}))},
    {"soundpack.json":strToU8(JSON.stringify({version:1,name:"x",sounds:[]}))},
  ]) assert.throws(() => packFromEntries(entries,"pack.zip"));
  assert.throws(() => packFromEntries({"open.wav":new Uint8Array(bytes())},"pack.zip"),fail("missingClick"));
});

test("ZIP extraction enforces entry and uncompressed limits before decoding audio", async () => {
  const valid=zipSync({"click.wav":new Uint8Array(bytes()),"unrelated.js":strToU8("not executed")});
  assert.ok((await readSoundPack(new File([valid],"test.zip"))).sounds.click);
  const oversized=zipSync({"click.wav":new Uint8Array(MAX_SOUND_FILE+1)});
  await assert.rejects(readSoundPack(new File([oversized],"large.zip")),fail("tooLarge"));
  const many=Object.fromEntries(Array.from({length:49},(_,i) => [`unused-${i}.txt`,strToU8("x")]));
  await assert.rejects(readSoundPack(new File([zipSync(many)],"many.zip")),fail("tooLarge"));
  await assert.rejects(readSoundPack(new File([new Uint8Array([1,2,3])],"bad.zip")),fail("invalidPack"));
  await assert.rejects(readSoundPack(new File([valid],"bad.js")),fail("unsupportedAudio"));
});

test("IndexedDB packs round-trip audio bytes across store instances and can be removed", async () => {
  const factory=new IDBFactory();
  const first=createSoundPackStore(factory);
  const value=pack();
  await first.save(value);
  const second=createSoundPackStore(factory);
  assert.deepEqual(await second.list(),[value]);
  await second.remove(value.id);
  assert.deepEqual(await first.list(),[]);
  await assert.rejects(first.save({...value,sounds:{}}),fail("invalidPack"));
});

test("disabled and zero-volume sound playback never initializes audio", async () => {
  const f=audioFixture();
  f.player.setEnabled(false);await f.player.play();
  f.player.setEnabled(true);f.player.setVolume(0);await f.player.play();
  assert.equal(f.created(),0);
  f.player.dispose();
});

test("rapid clicks are throttled, buffers are reused and polyphony is bounded", async () => {
  const f=audioFixture();
  await f.player.play();await f.player.play();assert.equal(f.sources.length,1);
  f.tick();await f.player.play();f.tick();await f.player.play();
  assert.equal(f.created(),1);assert.equal(f.buffers.length,1);
  assert.equal(f.sources.filter((source) => source.started&&!source.stopped).length,2);
  f.player.setEnabled(false);
  assert.ok(f.sources.every((source) => source.stopped));
  f.player.dispose();
});

test("stale resumed clicks are dropped after mute, pack switch or a slow device wake", async () => {
  for (const action of ["mute","pack","slow"]) {
    const f=audioFixture();let resume;
    f.context.state="suspended";
    f.context.resume=() => new Promise((resolve) => {resume=() => {f.context.state="running";resolve();};});
    const playing=f.player.play();
    if (action==="mute") f.player.setEnabled(false);
    else if (action==="pack") f.player.useBuiltin("builtin-crisp");
    else f.setTime(250);
    resume();await playing;
    assert.equal(f.sources.length,0);
    f.player.dispose();
  }
});

test("custom audio is decoded once, peak-limited and falls back to its click for other events", async () => {
  const f=audioFixture();let decoded=0;
  const buffer=f.buffer();buffer.getChannelData(0).fill(1.5);
  f.context.decodeAudioData=async() => {decoded++;return buffer;};
  const prepared=await f.player.prepare(pack());
  assert.ok(buffer.getChannelData(0)[0]<=0.900001);
  f.player.usePrepared(prepared);await f.player.play("send");
  f.tick();await f.player.play("open");
  assert.equal(decoded,1);assert.equal(f.sources[0].buffer,prepared.click);
  f.player.setVolume(15);assert.equal(f.gains[0].gain.value,0.15);
  f.player.dispose();
});

test("audio duration and decoded limits reject unsupported or excessive custom clips", async () => {
  for (const values of [[4,1,48000],[NaN,1,48000],[0.2,3,48000],[0.2,1,192000]]) {
    const f=audioFixture();
    assert.throws(() => validateSoundBuffer(f.buffer(...values)),fail("invalidAudio"));
    f.player.dispose();
  }
  const f=audioFixture({validateDuration:async() => {throw new SoundError("invalidAudio");}});
  let decodes=0;f.context.decodeAudioData=async() => {decodes++;return f.buffer();};
  await assert.rejects(f.player.prepare(pack()),fail("invalidAudio"));
  assert.equal(decodes,0);
  f.player.dispose();
});

test("audio failures and disposal do not throw into click actions", async () => {
  const errors=[];
  const player=createSoundPlayer({createContext(){throw Error("no device");},onError:(error) => errors.push(error)});
  await player.play();assert.equal(errors[0].code,"audioUnavailable");
  player.dispose();await player.play();
  assert.equal(errors.length,1);
});

test("custom clip metadata is checked before decoding and temporary media URLs are always released", async () => {
  const previous=globalThis.Audio;
  const media=[];
  class MetadataAudio {
    preload="";
    duration=0.1;
    onloadedmetadata=null;
    onerror=null;
    constructor(){media.push(this);}
    set src(_value){queueMicrotask(() => this.onloadedmetadata?.());}
    removeAttribute(){this.released=true;}
    load(){}
  }
  globalThis.Audio=MetadataAudio;
  try {
    const f=audioFixture({validateDuration:undefined});
    let decodes=0;f.context.decodeAudioData=async() => {decodes++;return f.buffer();};
    await f.player.prepare(pack());
    assert.equal(decodes,1);assert.equal(media[0].released,true);
    MetadataAudio.prototype.duration=4;
    class LongAudio extends MetadataAudio {duration=4;}
    globalThis.Audio=LongAudio;
    await assert.rejects(f.player.prepare(pack()),fail("invalidAudio"));
    assert.equal(decodes,1);assert.equal(media[1].released,true);
    f.player.dispose();
  } finally {globalThis.Audio=previous;}
});
test("a pack's own typing and scroll clips play at their authored length", async () => {
  const f=audioFixture();
  f.player.usePrepared({click:f.buffer(2),typing:f.buffer(0.3),scroll:f.buffer(0.4)});
  await f.player.play("typing");await f.player.play("scroll");
  assert.equal(f.sources[0].startArgs[2],0.3);
  assert.equal(f.sources[1].startArgs[2],0.4);
  f.player.dispose();
});
