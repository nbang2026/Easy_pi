import test from "node:test";
import assert from "node:assert/strict";
import { createWorkProgress, workspaceOutputPath } from "./work-progress.ts";

test("artifact paths reject escapes, sensitive files and normalize Windows workspace paths", () => {
  for (const path of ["../outside", "/project-other/a", "./.env", "a/.ssh/key", "a/private.pem", ".codex/settings", ".npmrc", "secret.json", ".", "./"]) {
    assert.equal(workspaceOutputPath(path,"/project"),undefined,path);
  }
  assert.equal(workspaceOutputPath("./report.md","/project"),"report.md");
  assert.equal(workspaceOutputPath("c:\\Work\\project\\report.md","C:\\Work\\project"),"report.md");
  assert.equal(workspaceOutputPath("/report.md","/"),"report.md");
});

test("only successful output tools create artifacts; tool completions retain their inputs", () => {
  const progress=createWorkProgress();
  progress.event({type:"tool",runId:"one",toolId:"a",name:"Write",input:{file_path:"/project/report.md"},status:"running"},"/project");
  assert.deepEqual(progress.snapshot().artifacts,[]);
  progress.event({type:"tool",runId:"one",toolId:"a",name:"Tool",status:"complete"},"/project");
  progress.event({type:"tool",runId:"one",toolId:"b",name:"Write",input:{file_path:"bad.md"},status:"error"},"/project");
  progress.event({type:"tool",runId:"one",toolId:"c",name:"Read",input:{file_path:"input.md"},status:"complete"},"/project");
  assert.deepEqual(progress.snapshot().artifacts,["report.md"]);
  assert.equal(progress.snapshot().steps[0].status,"completed");
  assert.match(progress.snapshot().steps[0].title,/Write/);
});

test("plans update after success and stale events cannot overwrite a newer run", () => {
  const progress=createWorkProgress();
  progress.event({type:"tool",runId:"one",toolId:"plan",name:"TodoWrite",input:{todos:[{content:"Inspect",status:"completed"},{content:"Fix",status:"in_progress"}]},status:"running"},"/project");
  assert.equal(progress.snapshot().steps.length,1);
  progress.event({type:"tool",runId:"one",toolId:"plan",name:"TodoWrite",status:"complete"},"/project");
  assert.equal(progress.snapshot().steps[1].title,"Fix");
  progress.task({id:"one",state:"cancelled"},"/project");
  assert.equal(progress.snapshot().steps[1].status,"cancelled");
  progress.event({type:"tool",runId:"two",toolId:"new",name:"Read",status:"running"},"/project");
  progress.event({type:"tool",runId:"one",toolId:"late",name:"Write",status:"complete",input:{path:"late.md"}},"/project");
  assert.deepEqual(progress.snapshot().artifacts,[]);
  assert.equal(progress.snapshot().steps[0].id,"new");
  progress.reset();assert.deepEqual(progress.snapshot(),{steps:[],artifacts:[]});
});
