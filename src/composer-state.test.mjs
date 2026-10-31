import test from "node:test";
import assert from "node:assert/strict";
import { parseDraft, canSubmit, shouldSendOnEnter, sameDraft, normalizedState, isGuiShortcut } from "./composer-state.ts";

test("startup state keeps trust prompts visible before any session exists", () => {
  const state = normalizedState({ connected: true, ready: false, startupPhase: "project_trust", sessionId: "", approvals: [
    { type: "approval", requestId: "trust", sessionId: "", scope: "project_trust" },
  ] });
  assert.equal(state.startupPhase, "project_trust");
  assert.equal(state.approvals[0].scope, "project_trust");
  assert.equal(canSubmit(state, { text: "must wait", attachments: [] }, false, true), false);
  assert.equal(normalizedState({ startupPhase: "invalid" }).startupPhase, undefined);
});

test("session usage rejects non-finite values and leaves unknown cost unavailable", () => {
  assert.equal(normalizedState({usage:{tokens:NaN,cost:1}}).usage, undefined);
  assert.equal(normalizedState({usage:{tokens:Infinity,cost:1}}).usage, undefined);
  assert.deepEqual(normalizedState({usage:{tokens:15,cost:NaN}}).usage,{tokens:15,cost:null});
  assert.deepEqual(normalizedState({usage:{tokens:15,cost:0}}).usage,{tokens:15,cost:0});
  assert.equal(normalizedState({extensionCommands:-1}).extensionCommands,undefined);
});
test("draft parsing rejects corrupt data and unsafe attachment paths", () => {
  assert.deepEqual(parseDraft("broken"), {text: "", attachments: []});
  assert.deepEqual(parseDraft(JSON.stringify({text: "中文", attachments: ["/a", "/a", "../b", "/c\n", null]})),
    {text: "中文", attachments: ["/a"]});
  assert.equal(parseDraft(JSON.stringify({text: "x".repeat(300000)})).text.length, 262144);
});
test("draft attachments retain absolute POSIX, drive, UNC and extended Windows paths", () => {
  const paths = ["/project/中文.txt", "C:\\Users\\a\\file.txt", "d:/project/file.txt", "\\\\server\\share\\file.txt", "\\\\?\\C:\\project\\file.txt", "\\\\?\\UNC\\server\\share\\file.txt"];
  const rejected = ["relative.txt", "../file", "C:relative.txt", "\\root-relative.txt", "\\\\server", "\\\\?\\C:relative.txt", "\\\\?\\UNC\\server", "/file\r", "C:\\bad\nfile", "\\\\server\\share\\bad\0file", 42, null];
  assert.deepEqual(parseDraft(JSON.stringify({attachments:[...paths,...paths,...rejected]})).attachments, paths);
});

test("submission protects preview, selector, native draft, duplicate and blank input", () => {
  const draft = {text: "Hi", attachments: []};
  assert.equal(canSubmit({ready:true,busy:false}, draft, false, true), true);
  for (const state of [{ready:false,busy:false}, {ready:true,busy:false,nativeDraft:true}, {ready:true,busy:false,connected:false}, {ready:true,busy:false,commandPending:true}]) {
    assert.equal(canSubmit(state, draft, false, true), false);
  }
  assert.equal(canSubmit({ready:true,busy:true}, draft, false, true), true);
  assert.equal(canSubmit({ready:true,busy:false}, draft, true, true), false);
  assert.equal(canSubmit({ready:true,busy:false}, draft, false, false), false);
  assert.equal(canSubmit({ready:true,busy:false}, {text:" ",attachments:[]}, false, true), false);
});
test("Chinese input composition and Shift Enter never submit", () => {
  const event = {key:"Enter",shiftKey:false,isComposing:false};
  assert.equal(shouldSendOnEnter(event, false), true);
  assert.equal(shouldSendOnEnter({...event,shiftKey:true}, false), false);
  assert.equal(shouldSendOnEnter({...event,isComposing:true}, false), false);
  assert.equal(shouldSendOnEnter({...event,keyCode:229}, false), false);
  assert.equal(shouldSendOnEnter(event, true), false);
});
test("a late acknowledgement never clears newly edited input", () => {
  const before = {text:"old",attachments:["/a"]};
  assert.equal(sameDraft(before, {...before,text:"new"}), false);
  assert.equal(sameDraft(before, {...before,attachments:["/b"]}), false);
  assert.equal(sameDraft(before, {text:"old",attachments:["/a"]}), true);
});
test("untrusted state uses strict booleans", () => {
  assert.deepEqual(normalizedState(null), {ready:false,busy:false});
  assert.equal(normalizedState({ready:"true",busy:1}).ready, false);
});
test("macOS workbench uses Command and preserves Pi Control bindings", () => {
  assert.equal(isGuiShortcut({metaKey:false,altKey:false,ctrlKey:true}), false);
  assert.equal(isGuiShortcut({metaKey:true,altKey:false}), true);
  assert.equal(isGuiShortcut({metaKey:true,altKey:true}), false);
});
