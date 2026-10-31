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
  // Match native textarea API values: happy-dom currently retains CR/CRLF in .value.
  const textareaValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value");
  Object.defineProperty(window.HTMLTextAreaElement.prototype,"value",{
    ...textareaValue,
    set(value) { textareaValue.set.call(this,String(value).replace(/\r\n?/g,"\n")); },
  });
  for(const [key,value] of Object.entries(storage)) window.localStorage.setItem(key,value);
  const events = new Map();
  const calls = [];
  const toasts = [];
  let submission;
  let statusResponse;
  let reconnect;
  let fileRead;
  let fileSave;
  let gitResponse;
  let engine = "pi";
  let mode = "queue", beforeSubmit;
  const invoke = async (command,args) => {
    calls.push({command,args});
    if (command === "gui_status") return statusResponse ? statusResponse() : {ready:true,connected:true,bridgeId:"current"};
    if (command === "gui_action") return submission ? submission(args) : {ok:true};
    if (command === "run_diagnostics") return {checkedAt:100,checks:[{name:"Pi",ok:true,detail:"Connected"}]};
    if (command === "list_sessions") return {sessions:[
      {path:"/session/one.jsonl",id:"one",cwd:"/project",title:"<img src=x> First session",modified:10},
      {path:"/session/two.jsonl",id:"two",cwd:"/other",title:"Other session",modified:5},
    ]};
    if (command === "list_workspace_files") return [
      {name:"hello.txt",path:"hello.txt",directory:false},
      {name:"other.txt",path:"other.txt",directory:false},
    ];
    if (command === "read_workspace_file") return fileRead ? fileRead(args) : {text:"original",revision:"revision-1"};
    if (command === "save_workspace_file") return fileSave ? fileSave(args) : "revision-2";
    if (command === "git_changes") return gitResponse ? gitResponse(args) : {branch:"feature",refs:["main","feature"],changes:[
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
    const sourceName = name.endsWith(".ts") ? name : `${name}.ts`;
    vm.runInNewContext(compile(sourceName), {...environment,exports,require:load});
    modules.set(name,exports);
    return exports;
  };
  const module = load("./workbench");
  const controller = module.setupWorkbench({
    desktop,engine:() => engine,invoke,language:() => "zh",mode:() => mode,toast:(value) => toasts.push(value),
    get beforeSubmit() { return beforeSubmit; },
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
    setMode: value => { mode = value; }, setBeforeSubmit: value => { beforeSubmit = value; },
    setEngine:(value) => { engine=value;controller.engineChanged();controller.setRuntime({cwd:"/project",bridgeId:"current"});ready(value === "pi" ? "/session/one.jsonl" : "agent:one"); },
    setStatus:(callback) => {statusResponse=callback;},
    setSubmission:(callback) => {submission=callback;},setReconnect:(callback) => {reconnect=callback;},
    setFileRead:(callback) => {fileRead=callback;},setFileSave:(callback) => {fileSave=callback;},
    setGit:(callback) => {gitResponse=callback;},
    close:() => {controller.dispose();window.happyDOM.abort();}};
}

test("startup status distinguishes initialization and GUI trust from native selectors", () => {
  const f = fixture();
  try {
    for (const [startupPhase, label] of [["initializing", /初始化/], ["project_trust", /信任弹窗/], ["session", /终端弹窗/]]) {
      f.controller.setState({ bridgeId: "current", connected: true, ready: false, busy: false, startupPhase });
      assert.match(f.el("agent-status").textContent, label);
      assert.equal(f.el("composer-send").disabled, true);
    }
  } finally { f.close(); }
});

test("workbench stays dismissed during a run and can be reopened manually", async () => {
  const f = fixture();
  try {
    assert.equal(f.el("work-open").closest("#work-tools-menu"), null);
    assert.equal(f.el("work-open").closest("[hidden]"), null);
    assert.equal(f.el("work-open").getAttribute("aria-expanded"), "false");
    const state = { bridgeId:"current",ready:true,connected:true,busy:true,cwd:"/project",session:"/session/one.jsonl" };
    f.controller.setState(state);
    assert.equal(f.el("tool-panel").hidden, false);
    assert.equal(f.el("work-open").getAttribute("aria-expanded"), "true");
    f.el("tool-close").click();
    f.controller.setState({ ...state, model:"updated model" });
    f.controller.setState(state);
    assert.equal(f.el("tool-panel").hidden, true);
    f.el("work-open").click();
    assert.equal(f.el("work-view").hidden, false);
    assert.equal(f.el("work-open").getAttribute("aria-expanded"), "true");
    f.el("work-open").click();
    assert.equal(f.el("tool-panel").hidden, true);
    assert.equal(f.el("work-open").getAttribute("aria-expanded"), "false");
    f.controller.setState({ ...state, busy:false });
    f.controller.setState(state);
    assert.equal(f.el("tool-panel").hidden, false);
  } finally { f.close(); }
});

test("workbench renders actual plan and successful artifacts, retaining collapsed sections", async () => {
  const f = fixture();
  try {
    f.controller.setState({ ready:true, connected:true, busy:true, cwd:"/project",session:"/session/one.jsonl", task:{
      id:"run-one",state:"running",plan:[{title:"Inspect",status:"completed"},{title:"Implement",status:"in_progress"},{title:"Verify",status:"pending"}],
      artifacts:["report.md","bundle.zip","../secret",".env"],events:[],
    } });
    assert.equal(f.el("work-progress-count").textContent,"1/3");
    assert.equal(f.el("work-overview").open,true);
    assert.equal(f.el("work-progress-list").querySelectorAll("li").length,3);
    assert.equal(f.el("work-artifact-count").textContent,"2");
    assert.equal(f.el("work-artifact-more").hidden,true);
    const section = f.el("work-progress-list").closest("details"); section.open = false;
    f.controller.observeEvent({type:"tool",toolId:"failed",name:"Write",input:{file_path:"bad.md"},status:"error"});
    assert.equal(section.open,false);
    assert.equal(f.el("work-artifact-count").textContent,"2");
    f.el("work-artifact-list").querySelectorAll(".file-row")[1].click(); await f.flush();
    const revealed=f.calls.find(call=>call.command==="reveal_workspace_file").args;
    assert.equal(revealed.root,"/project"); assert.equal(revealed.path,"bundle.zip");
    f.el("work-artifact-list").querySelector(".file-row").click(); await f.flush();
    assert.equal(f.calls.find(call=>call.command==="read_workspace_file").args.path,"report.md");
    f.ready("/session/two.jsonl"); f.el("work-open").click();
    assert.equal(f.el("work-artifact-count").textContent,"");
  } finally { f.close(); }
});

test("workbench artifact list previews five files and expands or collapses the remainder", () => {
  const f = fixture();
  try {
    f.controller.setState({ ready:true, connected:true, busy:true, cwd:"/project", session:"/session/one.jsonl", task:{
      id:"many-artifacts", state:"running", artifacts:["a.md","b.md","c.md","d.md","e.md","f.md","g.md"],
    } });
    const more = f.el("work-artifact-more");
    assert.equal(f.el("work-artifact-list").querySelectorAll(".file-row").length,5);
    assert.equal(more.hidden,false);
    assert.equal(more.textContent,"展开更多 (2)");
    more.click();
    assert.equal(f.el("work-artifact-list").querySelectorAll(".file-row").length,7);
    assert.equal(more.getAttribute("aria-expanded"),"true");
    assert.equal(more.textContent,"收起");
    more.click();
    assert.equal(f.el("work-artifact-list").querySelectorAll(".file-row").length,5);
    assert.equal(more.getAttribute("aria-expanded"),"false");
  } finally { f.close(); }
});

test("header reflects real workspace Git, session usage and skill errors; disconnect clears session metrics", async () => {
  const f = fixture();
  try {
    await f.flush();
    assert.equal(f.el("header-project").textContent, "project");
    assert.match(f.el("header-git").textContent, /feature.*1/);
    f.controller.setState({ ready:true, connected:true, busy:false, cwd:"/project",
      usage:{tokens:12345,cost:0.1234},skills:["review"],extensionCommands:2 });
    assert.match(f.el("header-usage").textContent, /12,345 tokens.*0.1234/);
    assert.match(f.el("header-extensions").textContent, /1 Skills.*2/);
    f.controller.setState({ ready:true, connected:true, busy:false, cwd:"/project",
      usage:{tokens:12345,cost:null},skillError:"<script>bad</script>" });
    assert.match(f.el("header-usage").textContent, /费用未提供/);
    assert.match(f.el("header-extensions").textContent, /加载异常/);
    assert.equal(f.el("header-extensions").title, "<script>bad</script>");
    assert.equal(f.el("header-extensions").querySelector("script"), null);
    f.controller.disconnected();
    assert.equal(f.el("header-usage").textContent, "");
    assert.equal(f.el("header-extensions").textContent, "");
  } finally { f.close(); }
});

test("late Git summary cannot replace the new workspace header", async () => {
  const f = fixture();
  let resolve;
  try {
    await f.flush();
    f.setGit(({root}) => root === "/slow" ? new Promise(done => {resolve=done;})
      : {branch:"new",changes:[],refs:[]});
    f.controller.setRuntime({cwd:"/slow"});
    f.controller.setRuntime({cwd:"C:\\new-project"});
    await f.flush();
    resolve({branch:"old",changes:[{}],refs:[]}); await f.flush();
    assert.equal(f.el("header-project").textContent,"new-project");
    assert.match(f.el("header-git").textContent,/new.*0/);
    assert.doesNotMatch(f.el("header-git").textContent,/old/);
  } finally { f.close(); }
});

test("all GUI ids are unique and composer owns a separate layout section", () => {
  const f=fixture();
  const ids=Array.from(f.document.querySelectorAll("[id]"),(node) => node.id);
  assert.equal(ids.length,new Set(ids).size);
  assert.equal(f.el("composer").previousElementSibling.id,"agent-session-strip");
  assert.equal(f.el("agent-session-strip").previousElementSibling.id,"terminal-stage");
  assert.equal(f.el("composer").nextElementSibling.id,"input-tools");
  assert.ok(f.el("input-tools").contains(f.el("model-open")));
  assert.ok(f.el("input-tools").contains(f.el("thinking-select")));
  assert.ok(f.el("input-tools").contains(f.el("work-tools-toggle")));
  assert.ok(f.el("input-tools").contains(f.el("work-open")));
  assert.equal(f.el("work-open").closest("#work-tools-menu"),null);
  assert.match(f.el("work-open").getAttribute("aria-controls"),/tool-panel/);
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
test("each send mode works while idle and running, with keyboard overrides and no repeat sends", async () => {
  const match = (id, event) => id === "tui.input.submit" ? event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    : id === "app.message.followUp" ? event.key === "Enter" && event.altKey : false;
  const f = fixture(true, match);
  try {
    for (const busy of [false, true]) for (const mode of ["send", "control", "queue"]) {
      f.controller.setState({ bridgeId: "current", ready: true, busy, connected: true, cwd: "/project", session: "/session/one.jsonl" });
      f.setMode(mode); f.input(`${mode}-${busy}`); f.el("composer-send").click(); await f.flush();
      assert.equal(f.actionCalls().at(-1).args.mode, mode);
      assert.equal(f.el("composer-input").value, "");
    }
    for (const [modifier, mode] of [[{}, "send"], [{ ctrlKey: true }, "control"], [{ metaKey: true }, "control"], [{ altKey: true }, "queue"]]) {
      f.setMode("send"); f.input("keyboard"); f.key("Enter", modifier); await f.flush();
      assert.equal(f.actionCalls().at(-1).args.mode, mode);
    }
    const count = f.actionCalls().length;
    f.input("held Enter"); f.key("Enter", { repeat: true }); await f.flush();
    assert.equal(f.actionCalls().length, count);
    assert.equal(f.el("composer-input").value, "held Enter");
  } finally { f.close(); }
});

test("mode selection is captured before preparation and session changes never overwrite another draft", async () => {
  const f = fixture(); let prepare, finish;
  try {
    f.setBeforeSubmit(() => new Promise(resolve => { prepare = resolve; }));
    f.setSubmission(() => new Promise(resolve => { finish = resolve; }));
    f.setMode("queue"); f.input("original request"); f.el("composer-send").click();
    f.setMode("control"); prepare(); await f.flush();
    assert.equal(f.actionCalls()[0].args.mode, "queue");
    f.ready("/session/two.jsonl"); f.input("second session draft");
    finish({ ok: true }); await f.flush();
    assert.equal(f.el("composer-input").value, "second session draft");
    f.ready("/session/one.jsonl");
    assert.equal(f.el("composer-input").value, "");
  } finally { f.close(); }
});

test("automatic idle routing may switch only during its own preparation, not during dispatch", async () => {
  const f = fixture(); let finish;
  try {
    f.setBeforeSubmit(() => {
      assert.throws(() => f.controller.requireSwitch());
      assert.doesNotThrow(() => f.controller.requireSwitch(true));
      f.setEngine("claude"); f.input("keep new engine draft");
    });
    f.setSubmission(() => new Promise(resolve => { finish = resolve; }));
    f.input("auto routed request"); f.el("composer-send").click(); await f.flush();
    assert.equal(f.actionCalls()[0].args.text, "auto routed request");
    assert.throws(() => f.controller.requireSwitch(true));
    finish({ ok: true }); await f.flush();
    assert.equal(f.el("composer-input").value, "keep new engine draft");
    f.setEngine("pi");
    assert.equal(f.el("composer-input").value, "");
  } finally { f.close(); }
});

test("command suggestions do not consume Chinese composition or keyCode 229", async () => {
  const f = fixture();
  try {
    f.input("/mo");
    assert.equal(f.el("composer-command-suggestions").hidden, false);
    f.key("Enter", { isComposing: true });
    const commit = new f.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(commit, "keyCode", { value: 229 }); f.el("composer-input").dispatchEvent(commit);
    await f.flush();
    assert.equal(f.el("composer-input").value, "/mo");
    assert.equal(f.actionCalls().length, 0);
  } finally { f.close(); }
});

test("Pi slash commands from the GUI composer use the command channel and clear on success", async () => {
  const f=fixture();
  f.input("/compact");
  f.el("composer-send").click();
  await f.flush();
  const command=f.calls.find((call)=>call.command==="gui_action"&&call.args.action==="command");
  assert.equal(command.args.text,"/compact");
  assert.equal(f.calls.some((call)=>call.command==="gui_action"&&call.args.action==="submit"),false);
  assert.equal(f.el("composer-input").value,"");
  assert.equal(f.el("composer-error").hidden,true);
  f.close();
});
test("a rejected Pi command keeps its draft visible for correction", async () => {
  const f=fixture();
  f.setSubmission(async() => {throw new Error("Unknown Pi command");});
  f.input("/not-a-command");
  f.el("composer-send").click();
  await f.flush();
  assert.equal(f.el("composer-input").value,"/not-a-command");
  assert.match(f.el("composer-error").textContent,/Unknown Pi command/);
  f.close();
});
test("shell commands stay out of the GUI and stale composer errors clear on edit", async () => {
  const f=fixture();
  f.input("!ls");
  f.el("composer-send").click();
  assert.equal(f.actionCalls().length,0);
  assert.equal(f.el("composer-error").hidden,false);
  f.input("ordinary message");
  assert.equal(f.el("composer-error").hidden,true);
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
test("unconfirmed-input recovery preserves drafts and exposes stop even without busy", async () => {
  const f = fixture();
  try {
    f.input("preserved after timeout");
    f.controller.setState({ ready: false, busy: false, connected: true, inputRecovery: true, cwd: "/project", session: "/session/one.jsonl" });
    assert.equal(f.el("composer-send").disabled, true);
    assert.equal(f.el("composer-stop").hidden, false);
    assert.throws(() => f.controller.requireSwitch());
    f.el("composer-stop").click(); await f.flush();
    assert.equal(f.actionCalls().at(-1).args.action, "stop");
    assert.equal(f.el("composer-input").value, "preserved after timeout");
    f.ready();
    assert.equal(f.el("composer-send").disabled, false);
    assert.equal(f.el("composer-stop").hidden, true);
  } finally { f.close(); }
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
test("native attachment paths share validation, show basenames and report only new additions", async () => {
  const f=fixture();try {
    const paths=["/project/posix.txt","C:\\Users\\a\\drive.txt","d:/forward.txt","\\\\server\\share\\unc.txt","\\\\?\\C:\\extended.txt","\\\\?\\UNC\\server\\share\\extended-unc.txt"];
    const invalid=["relative.txt","C:relative.txt","\\root.txt","\\\\server","\\\\?\\C:relative.txt","/bad\r","C:\\bad\nfile","/bad\0file"];
    assert.equal(f.controller.addPaths([...paths,...paths,...invalid]),6);
    assert.deepEqual(Array.from(f.el("composer-attachments").children,(chip)=>chip.querySelector("span").textContent),["posix.txt","drive.txt","forward.txt","unc.txt","extended.txt","extended-unc.txt"]);
    assert.equal(f.controller.addPaths(paths),0);
    assert.equal(f.controller.addPaths(Array.from({length:20},(_,index)=>`/extra/${index}`)),14);
    assert.equal(f.controller.addPaths(["/full"]),0);
    f.ready("/session/two.jsonl");f.ready();
    f.el("composer-send").click();await f.flush();
    assert.deepEqual(Array.from(f.actionCalls().at(-1).args.attachments).slice(0,6),paths);
    assert.equal(f.actionCalls().at(-1).args.attachments.length,20);
  }finally{f.close();}
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done,fail) => {resolve=done;reject=fail;});
  return {promise,resolve,reject};
};
const editFile = (f,value) => {
  f.el("file-editor-text").value=value;
  f.el("file-editor-text").dispatchEvent(new f.window.Event("input"));
};
const openEditor = async (f) => {
  f.el("files-open").click();await f.flush();
  f.el("file-list").querySelector("button").click();await f.flush();
};

test("a deferred read for B cannot overwrite edits made to A while B is loading", async () => {
  const f=fixture();try {
    await openEditor(f);
    const pending=deferred();f.setFileRead(()=>pending.promise);
    f.el("file-list").querySelectorAll("button")[1].click();await f.flush();
    const reads=f.calls.filter((call)=>call.command==="read_workspace_file");
    assert.equal(reads.length,2);assert.equal(reads[1].args.path,"other.txt");
    editFile(f,"unsaved A");
    pending.resolve({text:"content of B",revision:"revision-B"});await f.flush();
    assert.equal(f.el("file-editor-text").value,"unsaved A");
    assert.equal(f.el("file-save").disabled,false);
    assert.throws(()=>f.controller.requireSwitch(),/尚未保存|modified/);
  }finally{f.close();}
});

test("CRLF read is clean and saving an edit retains CRLF before and after reopening", async () => {
  const f=fixture();try {
    let native="first\r\nsecond\r\n";
    f.setFileRead(()=>({text:native,revision:"revision-1"}));
    f.setFileSave((args)=>{native=args.text;return "revision-2";});
    await openEditor(f);
    assert.equal(f.el("file-editor-text").value,"first\nsecond\n");
    assert.doesNotThrow(()=>f.controller.requireSwitch());
    editFile(f,"first\nsecond\n");assert.equal(f.el("file-save").disabled,true);
    editFile(f,"FIRST\nsecond\n");f.el("file-save").click();await f.flush();
    assert.equal(native,"FIRST\r\nsecond\r\n");
    assert.equal(f.el("file-save").disabled,true);
    let confirmed=false;f.window.confirm=()=>{confirmed=true;return false;};
    f.el("file-editor-close").click();assert.equal(confirmed,false);
    f.el("file-list").querySelector("button").click();await f.flush();
    assert.doesNotThrow(()=>f.controller.requireSwitch());
    editFile(f,"FIRST\nSECOND\n");f.el("file-save").click();await f.flush();
    assert.equal(native,"FIRST\r\nSECOND\r\n");
  }finally{f.close();}
});

test("mixed native line endings survive edits, insertion and a save acknowledgement during typing", async () => {
  const f=fixture();try {
    f.setFileRead(()=>({text:"one\r\ntwo\nthree\rfour\r\n",revision:"revision-1"}));
    await openEditor(f);
    editFile(f,"ONE\ntwo\nthree\nfour\n");
    editFile(f,"ONE\ninserted\ntwo\nthree\nfour\n");
    const pending=deferred();f.setFileSave(()=>pending.promise);
    f.el("file-save").click();
    assert.equal(f.calls.findLast((call)=>call.command==="save_workspace_file").args.text,"ONE\r\ninserted\r\ntwo\nthree\rfour\r\n");
    editFile(f,"ONE\ninserted\ntwo\nTHREE\nfour\n");
    pending.resolve("revision-2");await f.flush();
    assert.equal(f.el("file-editor-text").value,"ONE\ninserted\ntwo\nTHREE\nfour\n");
    assert.equal(f.el("file-save").disabled,false);
    f.setFileSave(()=>"revision-3");f.el("file-save").click();await f.flush();
    const save=f.calls.findLast((call)=>call.command==="save_workspace_file");
    assert.equal(save.args.expectedRevision,"revision-2");
    assert.equal(save.args.text,"ONE\r\ninserted\r\ntwo\nTHREE\rfour\r\n");
    assert.equal(f.el("file-save").disabled,true);
  }finally{f.close();}
});

test("closing or disposing while a file read is pending prevents a late editor reopen", async () => {
  for(const action of ["close","dispose"]){
    const f=fixture();try {
      await openEditor(f);
      const pending=deferred();f.setFileRead(()=>pending.promise);
      f.el("file-list").querySelector("button").click();await f.flush();
      if(action==="close")f.el("file-editor-close").click();else f.controller.dispose();
      const before=f.el("file-editor-text").value;
      pending.resolve({text:"late response",revision:"late"});await f.flush();
      assert.equal(f.el("file-editor-text").value,before);
      if(action==="close")assert.equal(f.el("file-editor").hidden,true);
    }finally{f.close();}
  }
});

test("a save acknowledged after closing and reopening the same path cannot clean the new editor", async () => {
  const f=fixture();try {
    await openEditor(f);editFile(f,"first save");
    const pending=deferred();f.setFileSave(()=>pending.promise);f.el("file-save").click();
    f.window.confirm=()=>true;f.el("file-editor-close").click();
    f.setFileRead(()=>({text:"reopened externally",revision:"revision-new"}));
    f.el("file-list").querySelector("button").click();await f.flush();
    pending.resolve("revision-old-save");await f.flush();
    assert.equal(f.el("file-editor-text").value,"reopened externally");
    assert.equal(f.el("file-save").disabled,true);
    assert.doesNotThrow(()=>f.controller.requireSwitch());
    editFile(f,"new editor change");f.setFileSave(()=>"revision-final");
    f.el("file-save").click();await f.flush();
    assert.equal(f.calls.findLast((call)=>call.command==="save_workspace_file").args.expectedRevision,"revision-new");
  }finally{f.close();}
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

test("composer shows slash command suggestions and inserts the selected command", () => {
  const f = fixture();
  try {
    f.input("/");
    const suggestions = f.el("composer-command-suggestions");
    assert.equal(suggestions.hidden, false);
    assert.ok(suggestions.querySelectorAll("button").length >= 4);
    f.key("ArrowDown");
    f.key("Enter");
    assert.match(f.el("composer-input").value, /^\/[a-z]+ $/);
    assert.equal(suggestions.hidden, true);
  } finally { f.close(); }
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

test("engine switch isolates drafts and Claude ignores native Pi stream events", async () => {
  const f=fixture();try{
    f.input("Pi draft");f.setEngine("claude");
    assert.equal(f.el("composer-input").value,"");
    f.input("Claude draft");f.controller.addPaths(["/project/reference.txt"]);
    f.events.get("pi-gui-state")?.({payload:{bridgeId:"current",ready:false,busy:true,connected:true,cwd:"/wrong"}});
    assert.equal(f.controller.getState().cwd,"/project");
    assert.equal(f.controller.getState().busy,false);
    await assert.rejects(f.controller.executeCommand("/reload"),/仅适用于/);
    f.setEngine("pi");assert.equal(f.el("composer-input").value,"Pi draft");
    f.setEngine("claude");assert.equal(f.el("composer-input").value,"Claude draft");
    f.el("composer-send").click();await f.flush();
    const sent=f.actionCalls().at(-1).args;
    assert.equal(sent.userText,"Claude draft");assert.deepEqual(Array.from(sent.attachments),["/project/reference.txt"]);
  }finally{f.close();}
});

test("bridge loss preserves the current session draft and command-pending state blocks switching", async () => {
  const f=fixture();try{
    f.input("Keep this session draft");f.controller.addPaths(["/project/keep.txt"]);
    f.controller.disconnected();
    assert.equal(f.el("composer-input").value,"Keep this session draft");
    assert.equal(f.el("composer-attachments").children.length,1);
    f.ready();assert.equal(f.el("composer-input").value,"Keep this session draft");
    f.controller.setState({bridgeId:"current",connected:true,ready:false,busy:false,commandPending:true,cwd:"/project",session:"/session/one.jsonl"});
    assert.throws(()=>f.controller.requireSwitch(),/切换|switch/);
    assert.equal(f.el("composer-send").disabled,true);
  }finally{f.close();}
});

test("late status response from before disconnect cannot re-enable the old session", async () => {
 const f=fixture();try{
  let resolve;const pending=new Promise((done)=>{resolve=done;});f.setStatus(()=>pending);
  const synchronization=f.controller.synchronize();f.controller.disconnected();
  resolve({bridgeId:"current",connected:true,ready:true,busy:false,cwd:"/project",session:"/session/one.jsonl"});
  await synchronization;assert.equal(f.controller.getState().connected,false);assert.equal(f.el("composer-send").disabled,true);
 }finally{f.close();}
});
