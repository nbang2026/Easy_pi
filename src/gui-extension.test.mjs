import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync(new URL("../src-tauri/src/gui-extension.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

async function fixture(existingFactory, memories = [], agent = null) {
  const handlers = new Map();
  const frames = [];
  let editor;
  let focus;
  let submitCalls = [];
  let reloads = 0;
  class MockTheme {
    bg(color, text) { return `<bg:${color}>${text}`; }
    fg(color, text) { return `<fg:${color}>${text}`; }
  }
  const originalBg = MockTheme.prototype.bg;
  const originalFg = MockTheme.prototype.fg;
  class MockEditor {
    actionHandlers = new Map();
    value = "";
    constructor() { editor = this; }
    getText() { return this.value; }
    setText(text) { this.value = text; }
    render(width) { return [`top:${width}`, this.value || "cursor", `bottom:${width}`]; }
  }
  class Socket extends EventEmitter {
    writable = true;
    destroyed = false;
    write(bytes) { frames.push(JSON.parse(bytes)); }
    unref() {}
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  const socket = new Socket();
  const exports = {};
  const tui = { getFocusedComponent: () => focus, requestRender() {} };
  const context = {
    hasUI: true, isIdle: () => true, hasPendingMessages: () => false, cwd: "/tmp", model: {provider:"test",id:"model"},
    sessionManager: { getSessionFile: () => "/tmp/real.jsonl", getSessionId: () => "real" },
    abort() { context.aborted = true; },
    ui: {
      getEditorComponent: () => existingFactory,
      setEditorComponent(factory) {
        editor = factory(tui, {}, {reload(){reloads++;}});
        editor.onSubmit = async (text) => { submitCalls.push(text); };
        editor.actionHandlers ??= new Map();
        editor.actionHandlers.set("app.message.followUp", async () => { submitCalls.push(`queue:${editor.getText()}`); editor.setText(""); });
        focus = editor;
      },
    },
  };
  const timer = () => ({unref() {}});
  let runtimeReady = false;
  const tools = new Map();
  const libraryRequests = [];
  vm.runInNewContext(compiled, {
    exports, require: (name) => name === "node:net" ? {createConnection: () => socket}
      : name === "@earendil-works/pi-coding-agent" ? {CustomEditor: MockEditor,Theme: MockTheme}
      : name === "@earendil-works/pi-ai" ? {Type:{Object:(value)=>value,String:()=>({type:"string"}),Optional:(value)=>value}}
      : name === "./gui-library.mjs" ? {createAgentLibrary:()=>({run:async(request,authority)=>{libraryRequests.push([request,authority]);return request.kind==="context"?{memoryEnabled:true,memories,agent}:{settings:{memoryEnabled:true},memories:[]};}})}
      : require(name),
    process: {env:{PI_GUI_SOCKET:"tcp://127.0.0.1:43210",PI_GUI_TOKEN:"secret"}},
    Buffer, URL, setInterval:timer, setTimeout:timer, clearInterval(){},clearTimeout(){},
  });
  exports.default({
    on:(name,handler) => handlers.set(name,handler),
    registerTool:(tool) => tools.set(tool.name, tool),
    getThinkingLevel() {
      if (!runtimeReady) throw new Error("Extension runtime not initialized");
      return "medium";
    },
  });
  socket.emit("connect");
  runtimeReady = true;
  await handlers.get("session_start")({}, context);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const send = async (id, action, text, mode = "send") => {
    socket.emit("data", Buffer.from(JSON.stringify({id,action,text,mode}) + "\n"));
    await flush();
    return frames.findLast((frame) => frame.id === id);
  };
  return {frames,socket,handlers,context,tui,tools,libraryRequests,theme:new MockTheme(),MockTheme,originalBg,originalFg,get editor(){return editor;},get reloads(){return reloads;},submitCalls,flush,send,
    focus: (value) => {focus=value;},shutdown: () => handlers.get("session_shutdown")({},context)};
}

test("native user input is transparent while other theme tokens and shutdown remain unchanged", async () => {
  const f=await fixture();
  assert.equal(f.theme.bg("userMessageBg","hi"),"\x1b[49mhi\x1b[49m");
  assert.equal(f.theme.fg("userMessageText","hi"),"\x1b[39mhi\x1b[39m");
  assert.equal(f.theme.bg("toolSuccessBg","result"),"<bg:toolSuccessBg>result");
  assert.equal(f.theme.fg("error","error"),"<fg:error>error");
  assert.equal(f.frames.findLast((frame) => frame.type==="state").transparentInput,true);
  f.shutdown();
  assert.equal(f.MockTheme.prototype.bg,f.originalBg);
  assert.equal(f.MockTheme.prototype.fg,f.originalFg);
});
test("native keybindings reload immediately without clearing the editor or reloading the session", async () => {
  const f=await fixture();f.editor.setText("keep draft");
  assert.equal((await f.send("keys","keybindings")).ok,true);
  assert.equal(f.reloads,1);assert.equal(f.editor.getText(),"keep draft");
  assert.deepEqual(f.submitCalls,[]);f.shutdown();
});
test("memory and Agent tools distinguish model authority from GUI permission edits", async () => {
  const f=await fixture();
  assert.equal(f.tools.size,2);
  await f.tools.get("gui_memory").execute("id",{action:"save",title:"Preference",content:"Use Chinese"});
  assert.equal(f.libraryRequests.at(-1)[1],"model");
  await assert.rejects(f.tools.get("gui_agent_library").execute("id",{action:"settings"}));
  const response=await f.send("library","library",JSON.stringify({kind:"settings",autonomousDownloads:false}));
  assert.equal(response.ok,true);assert.equal(f.libraryRequests.at(-1)[1],"user");
  f.shutdown();
});

test("bridge hello authenticates and native submit acknowledges once", async () => {
  const f = await fixture();
  assert.deepEqual(f.frames[0], {type:"hello",token:"secret"});
  assert.equal(f.frames[1].thinking, "");
  assert.equal(f.frames.findLast((frame) => frame.type === "state").thinking, "medium");
  assert.equal((await f.send("a","submit","中文输入")).ok, true);
  assert.deepEqual(f.submitCalls, ["中文输入"]);
  assert.equal((await f.send("a","submit","中文输入")).ok, true);
  assert.equal(f.submitCalls.length, 1);
  f.shutdown();
});
test("selectors and native drafts reject GUI input without replacing text", async () => {
  const f = await fixture();
  f.focus({});
  assert.equal((await f.send("a","submit","message")).ok, false);
  f.focus(f.editor);
  f.editor.setText("native draft");
  assert.equal((await f.send("b","submit","message")).ok, false);
  assert.equal(f.editor.getText(), "native draft");
  assert.equal(f.submitCalls.length, 0);
  f.shutdown();
});
test("busy follow-up uses the real editor action and stop calls abort", async () => {
  const f = await fixture();
  f.handlers.get("agent_start")({},f.context);
  assert.equal((await f.send("a","submit","next","queue")).ok, true);
  assert.deepEqual(f.submitCalls, ["queue:next"]);
  assert.equal((await f.send("b","stop")).ok, true);
  assert.equal(f.context.aborted, true);
  f.shutdown();
});
test("invalid input and async failures preserve the GUI-owned draft", async () => {
  const f = await fixture();
  assert.equal((await f.send("a","submit","/new")).ok, false);
  assert.equal((await f.send("b","command","/new\n/model")).ok, false);
  f.editor.onSubmit = async () => {throw new Error("blocked by Pi");};
  const response = await f.send("c","submit","Keep this");
  assert.equal(response.ok, false);
  assert.match(response.error, /blocked by Pi/);
  assert.equal(f.editor.getText(), "");
  f.shutdown();
});
test("UTF-8 messages split across transport chunks are preserved", async () => {
  const f = await fixture();
  const bytes = Buffer.from(JSON.stringify({id:"a",action:"submit",text:"中文",mode:"send"})+"\n");
  const split = bytes.indexOf(Buffer.from("中")) + 1;
  f.socket.emit("data", bytes.subarray(0, split));
  f.socket.emit("data", bytes.subarray(split));
  await f.flush();
  assert.deepEqual(f.submitCalls, ["中文"]);
  f.shutdown();
});
test("a pending request cannot be submitted twice", async () => {
  const f = await fixture();
  let complete;
  f.editor.onSubmit = () => new Promise((resolve) => {f.submitCalls.push("one");complete=resolve;});
  await f.send("a","submit","one");
  await f.send("a","submit","one");
  assert.equal(f.submitCalls.length, 1);
  complete();
  await f.flush();
  assert.equal(f.frames.filter((frame) => frame.id === "a").length, 1);
  f.shutdown();
});
test("commands reject while running and dispatch native selectors while idle", async () => {
  const f = await fixture();
  f.handlers.get("agent_start")({},f.context);
  assert.equal((await f.send("a","command","/model")).ok, false);
  f.handlers.get("agent_settled")({},f.context);
  assert.equal((await f.send("b","command","/model")).ok, true);
  assert.deepEqual(f.submitCalls, ["/model"]);
  f.shutdown();
});
test("a quick command replaces an existing selector using its actual Escape handler", async () => {
  const f = await fixture();
  let escapes = 0;
  f.focus({handleInput(data) {
    assert.equal(data, "\x1b");
    escapes++;
    f.focus(f.editor);
  }});
  assert.equal((await f.send("a","command","/settings")).ok, true);
  assert.equal(escapes, 1);
  assert.deepEqual(f.submitCalls, ["/settings"]);
  f.shutdown();
});
test("dismissing an already closed selector never interrupts an active task", async () => {
  const f = await fixture();
  f.handlers.get("agent_start")({},f.context);
  const response = await f.send("a","dismiss");
  assert.equal(response.ok, true);
  assert.equal(response.dismissed, false);
  assert.equal(f.context.aborted, undefined);
  f.shutdown();
});
test("compact presentation hides only the unused native input and can restore it", async () => {
  const f = await fixture();
  assert.equal(f.editor.render(80).length, 3);
  assert.equal((await f.send("compact", "presentation", "compact")).ok, true);
  assert.equal(f.editor.render(80).length, 0);
  f.editor.setText("terminal draft");
  assert.equal(f.editor.render(80).length, 3);
  f.editor.setText(" ");
  assert.equal(f.editor.render(80).length, 3);
  f.editor.setText("");
  assert.equal((await f.send("invalid", "presentation", "unknown")).ok, false);
  assert.equal((await f.send("native", "presentation", "native")).ok, true);
  assert.equal(f.editor.render(80).length, 3);
  f.shutdown();
});
test("a disconnected bridge restores native input without changing its keyboard handlers", async () => {
  const f = await fixture();
  const submit = f.editor.onSubmit;
  await f.send("compact", "presentation", "compact");
  f.socket.destroy();
  assert.equal(f.editor.render(80).length, 3);
  assert.equal(f.editor.onSubmit, submit);
  f.shutdown();
});

test("saved notes reach the system prompt in full, stay valid JSON and never pile up as session messages", async () => {
  const long="x".repeat(400);
  const memories=Array.from({length:8},(_,i)=>({id:`id-${i}`,title:`note ${i}`,content:`${long}${i}`}));
  const f=await fixture(undefined, memories);
  const first=await f.handlers.get("before_agent_start")({systemPrompt:"BASE"},f.context);
  assert.equal(first.message,undefined);
  assert.ok(first.systemPrompt.startsWith("BASE\n\n"));
  const notes=JSON.parse(first.systemPrompt.slice(first.systemPrompt.indexOf("\n[")+1));
  assert.equal(notes[0].content,`${long}0`);
  const big=await fixture(undefined, Array.from({length:8},(_,i)=>({id:`b-${i}`,title:"t".repeat(240),content:"y".repeat(5000)})));
  const result=await big.handlers.get("before_agent_start")({systemPrompt:""},big.context);
  const trimmed=JSON.parse(result.systemPrompt.slice(result.systemPrompt.indexOf("\n[")+1));
  assert.ok(trimmed.length>=1 && trimmed.length<8);
  assert.equal(f.libraryRequests.at(-1)[0].kind,"context");
  f.shutdown();big.shutdown();
});
test("the active Agent definition becomes the turn's role with safety framing and a size cap", async () => {
  const f=await fixture(undefined, [], {id:"a1",title:"Reviewer",content:"# Reviewer\nReview diffs.",untrusted:false});
  const result=await f.handlers.get("before_agent_start")({systemPrompt:"BASE"},f.context);
  assert.ok(result.systemPrompt.startsWith("BASE\n\n"));
  assert.match(result.systemPrompt,/"Reviewer"/);
  assert.match(result.systemPrompt,/<agent-definition>\n# Reviewer\nReview diffs.\n<\/agent-definition>/);
  assert.doesNotMatch(result.systemPrompt,/downloaded from the internet/);
  const web=await fixture(undefined, [], {id:"a2",title:"Web",content:"z".repeat(60000),untrusted:true});
  const big=await web.handlers.get("before_agent_start")({systemPrompt:"BASE"},web.context);
  assert.match(big.systemPrompt,/downloaded from the internet/);
  assert.match(big.systemPrompt,/\[Definition truncated\]/);
  assert.ok(big.systemPrompt.length<50000);
  const none=await fixture();
  assert.equal(await none.handlers.get("before_agent_start")({systemPrompt:"BASE"},none.context),undefined);
  f.shutdown();web.shutdown();none.shutdown();
});
test("busy survives agent_end between follow-up turns and delivery reflects the state at submit time", async () => {
  const f=await fixture();
  f.handlers.get("agent_start")({},f.context);
  f.handlers.get("agent_end")({},f.context);
  assert.equal(f.frames.findLast((frame)=>frame.type==="state").busy,true);
  assert.equal((await f.send("c","command","/model")).ok,false);
  f.editor.onSubmit=async()=>{f.handlers.get("agent_settled")({},f.context);};
  assert.equal((await f.send("s","submit","steer this")).delivery,"steer");
  assert.equal(f.frames.findLast((frame)=>frame.type==="state").busy,false);
  f.shutdown();
});
