import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { Window } from "happy-dom";

const source = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
const compile = (name) => ts.transpileModule(source(name), {
  compilerOptions: { module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(desktop = true, matchesShortcut, storage = {}) {
  const window = new Window({url:"http://localhost:1423",settings:{
    disableJavaScriptEvaluation:true,disableJavaScriptFileLoading:true,disableCSSFileLoading:true,
  }});
  window.document.write(source("../index.html"));
  const document = window.document;
  for(const [key,value] of Object.entries(storage)) window.localStorage.setItem(key,value);
  const events = new Map();
  const calls = [];
  const toasts = [];
  let submission;
  let reconnect;
  const invoke = async (command,args) => {
    calls.push({command,args});
    if (command === "gui_action") return submission ? submission(args) : {ok:true};
    if (command === "run_diagnostics") return {checkedAt:100,checks:[{name:"Pi",ok:true,detail:"Connected"}]};
    if (command === "list_sessions") return {sessions:[
      {path:"/session/one.jsonl",id:"one",cwd:"/project",title:"<img src=x> First session",modified:10},
      {path:"/session/two.jsonl",id:"two",cwd:"/other",title:"Other session",modified:5},
    ]};
    if (command === "list_workspace_files") return [{name:"hello.txt",path:"hello.txt",directory:false}];
    if (command === "read_workspace_file") return {text:"original",revision:"revision-1"};
    if (command === "save_workspace_file") return "revision-2";
    if (command === "git_changes") return {branch:"feature",refs:["main","feature"],changes:[
      {path:"new.ts",oldPath:"old.ts",index:"R",worktree:"M",untracked:false},
    ]};
    if (command === "git_diff") return "@@ -1 +1 @@\n-old\n+new\n";
    return undefined;
  };
  const modules = new Map();
  const environment = {
    window,document,localStorage:window.localStorage,Notification:window.Notification,
    setTimeout,clearTimeout,console,Event:window.Event,
  };
  const load = (name) => {
    if (name === "@tauri-apps/api/event") return {listen:async(event,handler) => {events.set(event,handler);return () => events.delete(event);}};
    if (name === "./icons") return {icon:(name) => {
      const image=document.createElementNS("http://www.w3.org/2000/svg","svg");image.setAttribute("data-test-icon",name);return image;
    }};
    if (modules.has(name)) return modules.get(name);
    const exports = {};
    vm.runInNewContext(compile(name+".ts"), {...environment,exports,require:load});
    modules.set(name,exports);
    return exports;
  };
  const module = load("./workbench");
  const controller = module.setupWorkbench({
    desktop,invoke,language:() => "zh",mode:() => "queue",toast:(value) => toasts.push(value),
    matchesShortcut,
    resize(){},focusTerminal(){},reconnect:async(cwd,session) => {
      calls.push({command:"reconnect",args:{cwd,session}});
      if(reconnect) await reconnect(cwd,session);
    },
    settings(){},panelOpened(){},
  });
  controller.setRuntime({cwd:"/project",bridgeId:"current"});
  const ready = (session="/session/one.jsonl") => controller.setState({
    bridgeId:"current",ready:true,busy:false,connected:true,cwd:"/project",session,
  });
  ready();
  const el = (id) => document.getElementById(id);
  const input = (value) => {el("composer-input").value=value;el("composer-input").dispatchEvent(new window.Event("input"));};
  const key = (name,options={}) => el("composer-input").dispatchEvent(new window.KeyboardEvent("keydown",{key:name,bubbles:true,cancelable:true,...options}));
  const flush = async () => {await new Promise((resolve) => setImmediate(resolve));await new Promise((resolve) => setImmediate(resolve));};
  const actionCalls = () => calls.filter((call) => call.command === "gui_action" && call.args.action !== "presentation");
  return {window,document,controller,events,calls,toasts,el,input,key,flush,ready,actionCalls,
    setSubmission:(callback) => {submission=callback;},setReconnect:(callback) => {reconnect=callback;},
    close:() => {controller.dispose();window.happyDOM.abort();}};
}

test("all GUI ids are unique and composer owns a separate layout section", () => {
  const f=fixture();
  const ids=Array.from(f.document.querySelectorAll("[id]"),(node) => node.id);
  assert.equal(ids.length,new Set(ids).size);
  assert.equal(f.el("composer").previousElementSibling.id,"terminal-stage");
  assert.equal(f.el("composer").nextElementSibling.id,"input-tools");
  assert.ok(f.el("input-tools").contains(f.el("model-open")));
  assert.ok(f.el("input-tools").contains(f.el("thinking-select")));
  assert.ok(f.el("input-tools").contains(f.el("work-tools-toggle")));
  assert.equal(f.el("model-open").closest(".terminal-toolbar"),null);
  f.close();
});
test("GUI composer submits real content with file references and protects Chinese IME", async () => {
  const f=fixture();
  f.input("中文消息");
  f.controller.addPaths(["/project/a file.txt"]);
  f.key("Enter",{isComposing:true});
  f.key("Enter",{shiftKey:true});
  assert.equal(f.actionCalls().length,0);
  f.key("Enter");
  await f.flush();
  assert.equal(f.actionCalls().length,1);
  assert.equal(f.actionCalls()[0].args.mode,"queue");
  assert.match(f.actionCalls()[0].args.text,/中文消息\n@"\/project\/a file.txt"/);
  assert.equal(f.el("composer-input").value,"");
  f.close();
});
test("failed submission preserves text and removable attachments", async () => {
  const f=fixture();
  f.setSubmission(async() => {throw new Error("Pi rejected it");});
  f.input("keep me");f.controller.addPaths(["/project/a"]);
  f.el("composer-send").click();await f.flush();
  assert.equal(f.el("composer-input").value,"keep me");
  assert.match(f.el("composer-error").textContent,/Pi rejected/);
  assert.equal(f.el("composer-attachments").children.length,1);
  f.el("composer-attachments").querySelector("button").click();
  assert.equal(f.el("composer-attachments").children.length,0);
  f.close();
});
test("submission is single-flight and a late acknowledgement retains a newer draft", async () => {
  const f=fixture();
  let finish;
  f.setSubmission(() => new Promise((resolve) => {finish=resolve;}));
  f.input("first");f.el("composer-send").click();f.key("Enter");
  assert.equal(f.actionCalls().length,1);
  f.input("second");finish({ok:true});await f.flush();
  assert.equal(f.el("composer-input").value,"second");
  f.close();
});
test("session drafts and state identities cannot leak across switches", () => {
  const f=fixture();
  f.input("session one");
  f.ready("/session/two.jsonl");assert.equal(f.el("composer-input").value,"");
  f.input("session two");f.ready("/session/one.jsonl");
  assert.equal(f.el("composer-input").value,"session one");
  f.controller.setState({bridgeId:"old",ready:false,busy:false,connected:false});
  assert.equal(f.el("composer-send").disabled,false);
  f.close();
});
test("native selector state prevents sending and stop uses Pi abort", async () => {
  const f=fixture();
  f.input("draft");
  f.controller.setState({bridgeId:"current",ready:false,busy:true,connected:true,session:"/session/one.jsonl",cwd:"/project"});
  assert.equal(f.el("composer-send").disabled,true);
  f.el("composer-stop").click();await f.flush();
  assert.equal(f.actionCalls()[0].args.action,"stop");
  f.close();
});
test("real sessions use text-safe titles, pin/archive presentation and actual resume", async () => {
  const f=fixture();f.el("history-open").click();await f.flush();
  assert.equal(f.el("history-list").querySelectorAll(".session-row").length,1);
  assert.match(f.el("history-list").textContent,/<img src=x>/);
  assert.equal(f.el("history-list").querySelector("img"),null);
  f.el("history-list").querySelector('button[title="归档"]').click();
  assert.equal(f.el("history-list").querySelectorAll(".session-row").length,0);
  f.el("archive-toggle").click();
  assert.equal(f.el("history-list").querySelectorAll(".session-row").length,1);
  f.el("archive-toggle").click();
  f.el("history-scope").value="all";f.el("history-scope").dispatchEvent(new f.window.Event("change"));
  f.el("history-list").querySelector(".session-open").click();await f.flush();
  assert.equal(f.calls.findLast((call) => call.command === "reconnect").args.session,"/session/two.jsonl");
  f.close();
});
test("file editor saves with a revision and attaches the real path", async () => {
  const f=fixture();f.el("files-open").click();await f.flush();
  f.el("file-list").querySelector("button").click();await f.flush();
  assert.equal(f.el("file-editor-text").value,"original");
  f.el("file-editor-text").value="edited";f.el("file-editor-text").dispatchEvent(new f.window.Event("input"));
  const reads=f.calls.filter((call) => call.command === "read_workspace_file").length;
  f.el("file-list").querySelector("button").click();await f.flush();
  assert.equal(f.el("file-editor-text").value,"edited");
  assert.equal(f.calls.filter((call) => call.command === "read_workspace_file").length,reads);
  f.el("file-save").click();await f.flush();
  const save=f.calls.find((call) => call.command === "save_workspace_file");
  assert.equal(save.args.expectedRevision,"revision-1");
  assert.equal(save.args.text,"edited");
  f.el("file-reference").click();
  assert.match(f.el("composer-attachments").textContent,/hello.txt/);
  f.close();
});
test("review and rename staging call the backend, branch comparison is read-only", async () => {
  const f=fixture();f.el("review-open").click();await f.flush();
  f.el("review-list").querySelector("button").click();await f.flush();
  assert.match(f.el("diff-content").textContent,/\+new/);
  f.el("diff-stage").click();await f.flush();
  assert.equal(f.calls.find((call) => call.command === "git_stage").args.oldPath,"old.ts");
  f.el("review-mode").value="branch";f.el("review-mode").dispatchEvent(new f.window.Event("change"));await f.flush();
  f.el("review-list").querySelector("button").click();await f.flush();
  assert.equal(f.el("diff-stage").hidden,true);
  assert.equal(f.calls.findLast((call) => call.command === "git_diff").args.base,"main");
  f.close();
});
test("startup verification is automatic, repeat state does not repeat checks", async () => {
  const f=fixture();await f.flush();
  assert.equal(f.calls.filter((call) => call.command === "run_diagnostics").length,1);
  f.ready();await f.flush();
  assert.equal(f.calls.filter((call) => call.command === "run_diagnostics").length,1);
  f.el("diagnostics-open").click();await f.flush();
  assert.equal(f.el("diagnostics-view").hidden,false);
  assert.equal(f.el("diagnostics-list").querySelectorAll(".diagnostic-row").length,3);
  f.close();
});
test("browser preview never pretends it sent a message", async () => {
  const f=fixture(false);f.input("preview draft");
  assert.equal(f.el("composer-send").disabled,true);
  f.key("Enter");await f.flush();
  assert.equal(f.actionCalls().length,0);
  f.close();
});
test("command palette supports keyboard selection and closes cleanly", async () => {
  const f=fixture();f.el("palette-open").click();
  assert.equal(f.el("command-palette").hidden,false);
  f.el("palette-search").value="自动检验";f.el("palette-search").dispatchEvent(new f.window.Event("input"));
  f.el("palette-search").dispatchEvent(new f.window.KeyboardEvent("keydown",{key:"Enter",bubbles:true}));
  await f.flush();
  assert.equal(f.el("command-palette").hidden,true);
  assert.equal(f.el("diagnostics-view").hidden,false);
  f.close();
});
test("work tools open from the input row, use keyboard navigation and open real panels", async () => {
  const f=fixture();
  f.el("work-tools-toggle").click();
  assert.equal(f.el("work-tools-menu").hidden,false);
  assert.equal(f.el("work-tools-toggle").getAttribute("aria-expanded"),"true");
  assert.equal(f.document.activeElement.id,"files-open");
  f.el("files-open").dispatchEvent(new f.window.KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));
  assert.equal(f.document.activeElement.id,"review-open");
  f.el("review-open").click();await f.flush();
  assert.equal(f.el("work-tools-menu").hidden,true);
  assert.equal(f.el("review-view").hidden,false);
  f.el("work-tools-toggle").click();
  f.document.activeElement.dispatchEvent(new f.window.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
  assert.equal(f.el("work-tools-menu").hidden,true);
  assert.equal(f.document.activeElement.id,"work-tools-toggle");
  f.el("sidebar-history-open").click();await f.flush();
  assert.equal(f.el("history-view").hidden,false);
  f.close();
});
test("composer mode synchronizes native input presentation and restores native editing", async () => {
  const f=fixture();await f.flush();
  const modes=() => f.calls.filter((call) => call.command==="gui_action" && call.args.action==="presentation");
  assert.equal(modes().length,1);
  assert.equal(modes()[0].args.text,"compact");
  f.ready();await f.flush();
  assert.equal(modes().length,1);
  f.el("composer-toggle").click();await f.flush();
  assert.equal(modes().at(-1).args.text,"native");
  assert.equal(f.el("composer-toggle").getAttribute("aria-checked"),"false");
  f.el("composer-toggle").click();await f.flush();
  assert.equal(modes().at(-1).args.text,"compact");
  f.close();
});
test("reloaded native presentation is reapplied and reconnect reruns diagnostics", async () => {
  const f=fixture();await f.flush();
  const modes=() => f.calls.filter((call) => call.command==="gui_action" && call.args.action==="presentation");
  f.controller.setState({bridgeId:"current",ready:true,busy:false,connected:true,compactEditor:false,cwd:"/project",session:"/session/one.jsonl"});
  await f.flush();
  assert.equal(modes().length,2);
  f.controller.setState({bridgeId:"current",ready:false,busy:false,connected:false});
  f.ready();await f.flush();
  assert.equal(f.calls.filter((call) => call.command==="run_diagnostics").length,2);
  assert.equal(modes().at(-1).args.text,"compact");
  f.close();
});
test("work tools close without stealing input focus when clicking outside", () => {
  const f=fixture();
  f.el("work-tools-toggle").click();
  f.el("composer-input").focus();
  f.el("composer-input").dispatchEvent(new f.window.PointerEvent("pointerdown",{bubbles:true}));
  assert.equal(f.el("work-tools-menu").hidden,true);
  assert.equal(f.document.activeElement.id,"composer-input");
  assert.equal(f.document.querySelector(".sidebar-command-group:not(.sidebar-recents)").hasAttribute("open"),false);
  f.close();
});
test("sidebar recents collapse, retain safe titles and resume the chosen real session", async () => {
  const f=fixture();await f.flush();
  assert.equal(f.el("sidebar-recents-list").querySelectorAll("button").length,2);
  assert.equal(f.el("sidebar-recents-list").querySelector("img"),null);
  assert.equal(f.el("sidebar-recents-list").querySelector('[aria-current="true"]').dataset.session,"/session/one.jsonl");
  f.el("sidebar-recents").open=false;f.el("sidebar-recents").dispatchEvent(new f.window.Event("toggle"));
  assert.equal(f.window.localStorage.getItem("pi.historyCollapsed"),"true");
  f.el("sidebar-recents").open=true;f.el("sidebar-recents").dispatchEvent(new f.window.Event("toggle"));
  await f.flush();
  f.el("sidebar-recents-list").querySelectorAll("button")[1].click();await f.flush();
  assert.deepEqual(f.calls.find((call)=>call.command==="reconnect").args,{cwd:"/other",session:"/session/two.jsonl"});
  f.close();
});
test("recent-session switching is serialized and a failed switch can be retried", async () => {
  const f=fixture();await f.flush();
  let reject;
  f.setReconnect(()=>new Promise((_,fail)=>{reject=fail;}));
  const row=f.el("sidebar-recents-list").querySelectorAll("button")[1];
  row.click();row.click();await f.flush();
  assert.equal(f.calls.filter((call)=>call.command==="reconnect").length,1);
  assert.ok(f.toasts.some((message)=>message.includes("正在切换")));
  reject(new Error("connection unavailable"));await f.flush();
  f.setReconnect(undefined);row.click();await f.flush();
  assert.equal(f.calls.filter((call)=>call.command==="reconnect").length,2);
  f.close();
});
test("saved history collapse restores at startup and repeated native state preserves recent rows", async () => {
  const f=fixture(true,undefined,{"pi.historyCollapsed":"true"});await f.flush();
  assert.equal(f.el("sidebar-recents").open,false);
  assert.equal(f.calls.filter((call)=>call.command==="list_sessions").length,0);
  f.el("sidebar-recents").open=true;f.el("sidebar-recents").dispatchEvent(new f.window.Event("toggle"));
  await f.flush();
  const row=f.el("sidebar-recents-list").firstChild;
  f.ready();f.ready();await f.flush();
  assert.equal(f.el("sidebar-recents-list").firstChild,row);
  const reads=f.calls.filter((call)=>call.command==="list_sessions").length;
  f.ready();await f.flush();
  assert.equal(f.calls.filter((call)=>call.command==="list_sessions").length,reads);
  f.close();
});
test("configured GUI and composer shortcuts replace defaults while keeping CJK composition safe", async () => {
  const match=(id,event)=>id==="gui.palette"?event.metaKey&&event.key==="b"
    :id==="tui.input.submit"?event.ctrlKey&&event.key==="Enter"
    :id==="tui.input.newLine"?event.ctrlKey&&event.key==="j"
    :id==="app.message.followUp"?event.altKey&&event.key==="Enter":false;
  const f=fixture(true,match);await f.flush();
  f.input("line");f.key("j",{ctrlKey:true});
  assert.equal(f.el("composer-input").value,"line\n");
  f.input("message");f.key("Enter");await f.flush();
  assert.equal(f.actionCalls().length,0);
  f.key("Enter",{ctrlKey:true,isComposing:true});await f.flush();
  assert.equal(f.actionCalls().length,0);
  f.key("Enter",{ctrlKey:true});await f.flush();
  assert.equal(f.actionCalls()[0].args.text,"message");
  const event=new f.window.KeyboardEvent("keydown",{key:"b",metaKey:true,bubbles:true,cancelable:true});
  f.el("terminal").dispatchEvent(event);
  assert.equal(f.el("command-palette").hidden,false);
  f.close();
});
test("Pi Control keys are not consumed while macOS Command opens the workbench", () => {
  const f=fixture();
  for (const key of ["p","r","j","k"]) {
    const event=new f.window.KeyboardEvent("keydown",{key,ctrlKey:true,bubbles:true,cancelable:true});
    f.el("terminal").dispatchEvent(event);
    assert.equal(event.defaultPrevented,false);
    assert.equal(f.el("command-palette").hidden,true);
    assert.equal(f.el("tool-panel").hidden,true);
  }
  const command=new f.window.KeyboardEvent("keydown",{key:"k",metaKey:true,bubbles:true,cancelable:true});
  f.el("terminal").dispatchEvent(command);
  assert.equal(command.defaultPrevented,true);
  assert.equal(f.el("command-palette").hidden,false);
  f.close();
});
test("a second save while one is in flight does not reuse the stale revision", async () => {
  const f=fixture();f.el("files-open").click();await f.flush();
  f.el("file-list").querySelector("button").click();await f.flush();
  f.el("file-editor-text").value="edited";f.el("file-editor-text").dispatchEvent(new f.window.Event("input"));
  f.el("file-save").click();f.el("file-save").click();
  f.el("file-save").disabled=false;f.el("file-save").click();
  await f.flush();
  assert.equal(f.calls.filter((call) => call.command === "save_workspace_file").length,1);
  assert.equal(f.el("file-save").disabled,true);
  f.close();
});
test("the IME-commit Enter (keyCode 229) does not run a palette command", async () => {
  const f=fixture();f.el("palette-open").click();
  f.el("palette-search").value="自动检验";f.el("palette-search").dispatchEvent(new f.window.Event("input"));
  const commit=new f.window.KeyboardEvent("keydown",{key:"Enter",bubbles:true});
  Object.defineProperty(commit,"keyCode",{value:229});
  f.el("palette-search").dispatchEvent(commit);await f.flush();
  assert.equal(f.el("command-palette").hidden,false);
  f.close();
});
