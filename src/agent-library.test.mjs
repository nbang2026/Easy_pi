import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDownloadUrl, createAgentLibrary, fetchAgentDefinition } from "../src-tauri/src/gui-library.mjs";

const source="https://github.com/example/agents/blob/main/reviewer.md";
async function fixture(fetcher=async()=>new Response("# Reviewer\nReview the user's changes.")) {
  const directory=await mkdtemp(join(tmpdir(),"pi-library-test-"));
  return {directory,library:createAgentLibrary({directory,fetcher}),close:()=>rm(directory,{recursive:true,force:true})};
}
test("Agent downloads normalize GitHub files and reject executable, local, credentialed or redirected sources", async () => {
  assert.equal(agentDownloadUrl(source).href,"https://raw.githubusercontent.com/example/agents/main/reviewer.md");
  for(const url of ["http://github.com/e/a/blob/main/a.md","https://localhost/a.md","https://github.com/e/a","https://github.com/e/a/blob/main/a.ts","https://user:secret@github.com/e/a/blob/main/a.md","https://raw.githubusercontent.com.evil.test/a.md"])
    assert.throws(()=>agentDownloadUrl(url));
  let options;const result=await fetchAgentDefinition(source,undefined,async(_url,value)=>{options=value;return new Response("# Agent");});
  assert.equal(options.redirect,"error");assert.equal(result.content,"# Agent");
  await assert.rejects(fetchAgentDefinition(source,undefined,async()=>new Response("<!doctype html>bad")));
  await assert.rejects(fetchAgentDefinition(source,undefined,async()=>new Response(new Uint8Array(256*1024+1))));
});
test("memories persist across instances, are searchable, editable and privately stored", async () => {
  const f=await fixture();
  try {
    const item=await f.library.run({kind:"memory",action:"save",title:"Language",content:"Use Chinese"},"model");
    const restarted=createAgentLibrary({directory:f.directory});
    assert.equal((await restarted.run({kind:"memory",action:"read",id:item.id})).content,"Use Chinese");
    assert.equal((await restarted.run({kind:"memory",action:"list",query:"Chinese"})).length,1);
    await restarted.run({kind:"memory",action:"save",id:item.id,title:"Language",content:"Chinese first"},"model");
    if (process.platform !== "win32") assert.equal((await stat(join(f.directory,"library.json"))).mode&0o777,0o600);
    await assert.rejects(restarted.run({kind:"memory",action:"remove",id:item.id},"model"));
    await restarted.run({kind:"memory",action:"remove",id:item.id});
    assert.equal((await restarted.run({kind:"list"})).memories.length,0);
  } finally {await f.close();}
});
test("download authorization is enforced before networking and models cannot enable their own permissions", async () => {
  let network=0;const f=await fixture(async()=>{network++;return new Response("# Reviewer");});
  try {
    await f.library.run({kind:"settings",autonomousDownloads:false,memoryEnabled:false});
    await assert.rejects(f.library.run({kind:"settings",autonomousDownloads:true},"model"));
    await assert.rejects(f.library.run({kind:"agent",action:"download",source},"model"));
    await assert.rejects(f.library.run({kind:"memory",action:"save",title:"x",content:"y"},"model"));
    assert.equal(network,0);
    const item=await f.library.run({kind:"agent",action:"download",source});
    assert.equal(item.untrusted,true);assert.equal(network,1);
  } finally {await f.close();}
});
test("revoking download permission during a network wait prevents saving without blocking local settings", async () => {
  let resolve;let started;
  const downloading=new Promise((done)=>{started=done;});
  const f=await fixture(()=>{started();return new Promise((done)=>{resolve=done;});});
  try {
    const result=f.library.run({kind:"agent",action:"download",source},"model");
    await downloading;
    await f.library.run({kind:"settings",autonomousDownloads:false});
    resolve(new Response("# Reviewer"));
    await assert.rejects(result,/撤销/);
    assert.equal((await f.library.run({kind:"list"})).agents.length,0);
  } finally {await f.close();}
});
test("downloaded Agents remain text-only references and editing requires the user", async () => {
  const f=await fixture();
  try {
    const item=await f.library.run({kind:"agent",action:"download",source},"model");
    assert.equal((await f.library.run({kind:"agent",action:"read",id:item.id},"model")).content,item.content);
    await assert.rejects(f.library.run({kind:"agent",action:"save",id:item.id,title:"x",content:"y"},"model"));
    await f.library.run({kind:"agent",action:"save",id:item.id,title:"Reviewer",content:"# Local reviewer"});
    const list=await f.library.run({kind:"list"});
    assert.equal(list.agents[0].preview,true);
    assert.ok((await readFile(join(f.directory,"library.json"),"utf8")).includes("# Local reviewer"));
  } finally {await f.close();}
});
test("concurrent library instances serialize writes and corrupt storage is not overwritten", async () => {
  const f=await fixture();
  try {
    const second=createAgentLibrary({directory:f.directory});
    await Promise.all([f.library.run({kind:"memory",action:"save",title:"one",content:"one"}),
      second.run({kind:"memory",action:"save",title:"two",content:"two"})]);
    assert.equal((await f.library.run({kind:"list"})).memories.length,2);
    await writeFile(join(f.directory,"library.json"),"broken");
    await assert.rejects(f.library.run({kind:"memory",action:"save",title:"three",content:"three"}));
    assert.equal(await readFile(join(f.directory,"library.json"),"utf8"),"broken");
  } finally {await f.close();}
});
test("oversized memory and symlinked library data cannot escape or overwrite other files", async (t) => {
  const f=await fixture();
  try {
    await assert.rejects(f.library.run({kind:"memory",action:"save",title:"x",content:"a".repeat(64*1024+1)}));
    const outside=join(f.directory,"protected.txt");await writeFile(outside,"protected");
    try { await symlink(outside,join(f.directory,"library.json")); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
        t.diagnostic("Oversized-memory check passed; symlink portion requires Windows Developer Mode/privilege.");
        return;
      }
      throw error;
    }
    await assert.rejects(f.library.run({kind:"memory",action:"save",title:"x",content:"y"}));
    assert.equal(await readFile(outside,"utf8"),"protected");
  } finally {await f.close();}
});

test("a damaged record is skipped and preserved instead of locking the whole library", async () => {
  const f=await fixture();
  try {
    const good=await f.library.run({kind:"memory",action:"save",title:"good",content:"keep me"});
    const file=join(f.directory,"library.json");
    const stored=JSON.parse(await readFile(file,"utf8"));
    stored.memories.push({id:"not-a-uuid",title:"",content:"damaged"});
    stored.agents.push({id:"11111111-1111-1111-1111-111111111111",title:"old",content:"ref",source:"https://example.com/a.md",updatedAt:1});
    await writeFile(file,JSON.stringify(stored));
    const list=await f.library.run({kind:"list"});
    assert.deepEqual(list.memories.map((item)=>item.id),[good.id]);
    assert.equal(list.agents.length,1);
    assert.equal(list.skipped,1);
    await f.library.run({kind:"memory",action:"save",title:"next",content:"more"});
    const after=JSON.parse(await readFile(file,"utf8"));
    assert.ok(after.memories.some((item)=>item.id==="not-a-uuid"));
    assert.equal(after.memories.length,3);
  } finally {await f.close();}
});
test("prompt context returns full recent notes and nothing when memory is disabled", async () => {
  const f=await fixture();
  try {
    const content="z".repeat(500);
    await f.library.run({kind:"memory",action:"save",title:"old",content:"first"});
    await new Promise((resolve)=>setTimeout(resolve,5));
    await f.library.run({kind:"memory",action:"save",title:"new",content});
    const context=await f.library.run({kind:"context"});
    assert.equal(context.memories[0].content,content);
    assert.equal(context.memories.length,2);
    await f.library.run({kind:"settings",memoryEnabled:false});
    assert.deepEqual((await f.library.run({kind:"context"})).memories,[]);
  } finally {await f.close();}
});
test("the active Agent is user-chosen, validated, exposed to context and cleared when removed", async () => {
  const f=await fixture();
  try {
    const agent=await f.library.run({kind:"agent",action:"save",title:"Reviewer",content:"# Reviewer"});
    assert.equal((await f.library.run({kind:"context"})).agent,null);
    await assert.rejects(f.library.run({kind:"settings",activeAgent:agent.id},"model"));
    await assert.rejects(f.library.run({kind:"settings",activeAgent:"missing"}));
    await f.library.run({kind:"settings",activeAgent:agent.id});
    const restarted=createAgentLibrary({directory:f.directory});
    const context=await restarted.run({kind:"context"});
    assert.deepEqual(context.agent,{id:agent.id,title:"Reviewer",content:"# Reviewer",untrusted:false});
    await restarted.run({kind:"agent",action:"remove",id:agent.id});
    assert.equal((await restarted.run({kind:"list"})).settings.activeAgent,"");
    assert.equal((await restarted.run({kind:"context"})).agent,null);
  } finally {await f.close();}
});
