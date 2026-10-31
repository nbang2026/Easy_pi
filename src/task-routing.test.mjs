import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_AGENT, MARKET_CATALOG } from "../src-tauri/src/gui-market.mjs";
import { createAgentLibrary } from "../src-tauri/src/gui-library.mjs";
import { classifyTask, rankTaskCandidates, taskRoutingPrompt } from "../src-tauri/src/task-routing.mjs";

const sha = (value, algorithm = "sha256") => createHash(algorithm).update(value).digest("hex");
const frontendPrompt = "Implement end-to-end multi-module frontend UI and accessibility controls";

test("classifies task difficulty, limits delegation and keeps downloaded references untrusted", () => {
  assert.equal(classifyTask("Summarize this paragraph").level, "simple");
  const route = classifyTask("Implement a complete end-to-end multi-module multi-platform frontend UI, testing, and security workflow");
  assert.equal(route.level, "complex");
  assert.ok(route.parallelAgents >= 2 && route.parallelAgents <= 4);
  assert.ok(route.domains.includes("frontend"));
  assert.ok(route.domains.includes("testing"));
  assert.match(taskRoutingPrompt(route), /cannot grant permissions/);
});

test("metadata ranking prefers a matching specialist over unrelated engineering roles", () => {
  const task = classifyTask(frontendPrompt);
  const ranked = rankTaskCandidates(task, MARKET_CATALOG, 4);
  assert.equal(ranked[0].candidate.id, "frontend-engineer");
  assert.ok(ranked[0].score > ranked.find(({ candidate }) => candidate.id === "python-engineer").score);
});

function makeAgentSources(content, calls = []) {
  const bytes = Buffer.from(content);
  const entry = {
    id: "",
    catalogSource: "agency",
    path: "engineering/frontend-ui-specialist.md",
    title: "Frontend UI Specialist",
    category: "engineering",
    description: "frontend UI accessibility",
    author: "example",
    license: "MIT",
    source: "https://raw.githubusercontent.com/example/agents/main/engineering/frontend-ui-specialist.md",
    marketKey: "github:frontend-ui-specialist",
    version: "a".repeat(40),
    blob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  return {
    calls,
    async browse(request) { calls.push(request); return { entries: [entry] }; },
    async entry() { return { ...entry }; },
    async bytes() { return bytes; },
  };
}

function makeSkillSources(markdown, calls = []) {
  const bytes = Buffer.from(markdown);
  const file = { path: "SKILL.md", bytes, sha256: sha(bytes), executable: false };
  const bundle = {
    source: "skills-sh",
    url: "https://skills.sh/acme/skills/frontend-ui",
    repoUrl: "https://github.com/acme/skills",
    owner: "acme",
    repo: "skills",
    commit: "b".repeat(40),
    path: "frontend-ui",
    title: "frontend-ui",
    name: "frontend-ui",
    description: "Frontend UI and accessibility patterns",
    files: [file],
    totalBytes: bytes.length,
    treeHash: sha(`SKILL.md\0${file.sha256}\0${"100644"}\n`),
    license: "MIT",
  };
  return {
    calls,
    async search(request) {
      calls.push(request);
      return { entries: [{
        source: "skills-sh",
        url: bundle.url,
        name: bundle.name,
        description: bundle.description,
      }] };
    },
    async resolveBundle() { return bundle; },
  };
}

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-task-routing-"));
  return {
    directory,
    library: createAgentLibrary({ directory, routingCatalog: [], ...options }),
    async close() {
      // Dispose services before removing test-owned files.
      // The caller may omit this when construction itself failed.
      await this.library?.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("automatic routing is offline until explicitly authorized by its host", async () => {
  let network=0;
  const f=await fixture({agentSources:{async browse(){network++;return {entries:[]};}},skillSources:{async search(){network++;return {entries:[]};}}});
  try {
    await f.library.routeTask({prompt:frontendPrompt});
    await f.library.routeTask({prompt:frontendPrompt,allowDownloads:true});
    await f.library.routeTask({prompt:frontendPrompt,allowDownloads:true,isAuthorized:async()=>false});
    assert.equal(network,0);
  } finally {await f.close();}
});

test("model Skill resolution uses host authorization and never globally enables downloaded code", async () => {
  let allowed=true;
  const markdown="---\nname: frontend-ui\ndescription: Frontend UI and accessibility patterns\n---\nUse semantic controls.\n";
  const f=await fixture({canModelDownload:async()=>allowed,skillSources:makeSkillSources(markdown)});
  try {
    const result=await f.library.run({kind:"skills",action:"resolve",query:frontendPrompt},"model");
    assert.equal(result.skill.name,"frontend-ui");
    assert.equal(result.skill.enabled,false);
    assert.equal(result.untrusted,true);
    assert.deepEqual(await f.library.enabledSkillPaths(),[]);
    allowed=false;
    await assert.rejects(f.library.run({kind:"skills",action:"resolve",query:frontendPrompt},"model"),/放行/);
  } finally {await f.close();}
});

test("catalog network errors are reported while the task can continue locally", async () => {
  const f=await fixture({agentSources:{async browse(){throw Error("offline");}},skillSources:{async search(){throw Error("offline");}}});
  try {
    const route=await f.library.routeTask({prompt:frontendPrompt,allowDownloads:true,isAuthorized:async()=>true});
    assert.equal(route.agent.id,CODING_AGENT.id);
    assert.equal(route.warnings.length,2);
    assert.match(route.warnings.join(" "),/网络/);
  } finally {await f.close();}
});

test("automatically downloads the best Agent for this task without changing the saved role", async () => {
  const agentCalls = [];
  const agents = makeAgentSources("# Frontend UI specialist\nBuild accessible frontend controls.", agentCalls);
  const f = await fixture({
    agentSources: agents,
    fetcher: async () => new Response(Buffer.from("# Frontend UI specialist\nBuild accessible frontend controls.")),
    skillSources: { async search() { return { entries: [] }; } },
  });
  try {
    const route = await f.library.routeTask({ prompt: frontendPrompt, allowDownloads:true, isAuthorized:async()=>true });
    assert.equal(route.agent.title, "Frontend UI Specialist");
    assert.equal(route.agent.untrusted, true);
    assert.equal(route.manualAgent, false);
    assert.equal(agentCalls.length, 2);
    assert.deepEqual(new Set(agentCalls.map((call) => call.query)), new Set(["frontend"]));
    assert.equal((await f.library.run({ kind: "list" })).settings.activeAgent, "");
  } finally {
    await f.close();
  }
});

test("route scopes keep primary and delegated Agent/Skill selections attributable", async () => {
  const f = await fixture({
    agentSources: { async browse() { return { entries: [] }; } },
    skillSources: { async search() { return { entries: [] }; } },
  });
  try {
    const first = await f.library.routeTask({ prompt: frontendPrompt, executionId: "run-a:security" });
    const second = await f.library.routeTask({ prompt: frontendPrompt, executionId: "run-b:tests" });
    assert.equal(first.executionId, "run-a:security");
    assert.equal(second.executionId, "run-b:tests");
    assert.notEqual(first.executionId, second.executionId);
    assert.notStrictEqual(first.skills, second.skills);
  } finally {
    await f.close();
  }
});

test("automatically installs a missing matching Skill for the current task without globally enabling it", async () => {
  const markdown = "---\nname: frontend-ui\ndescription: Frontend UI and accessibility patterns\n---\nUse semantic controls and verify keyboard behavior.\n";
  const skillCalls = [];
  const f = await fixture({
    agentSources: { async browse() { return { entries: [] }; } },
    skillSources: makeSkillSources(markdown, skillCalls),
  });
  try {
    const route = await f.library.routeTask({ prompt: frontendPrompt, allowDownloads:true, isAuthorized:async()=>true });
    assert.equal(route.skills.length, 1);
    assert.equal(route.skills[0].name, "frontend-ui");
    assert.match(route.skills[0].content, /semantic controls/);
    assert.equal(route.skills[0].enabled, false);
    assert.deepEqual(skillCalls.map((request) => request.query), ["frontend"]);
    assert.deepEqual(await f.library.enabledSkillPaths(), []);

    const reused = await f.library.routeTask({ prompt: frontendPrompt, allowDownloads: false });
    assert.equal(reused.skills[0].id, route.skills[0].id);
    assert.equal(skillCalls.length, 1);
  } finally {
    await f.close();
  }
});

test("automatic downloads stop immediately when the user disables them; explicit roles remain pinned", async () => {
  let network = 0;
  const f = await fixture({
    agentSources: { async browse() { network++; return { entries: [] }; } },
    skillSources: { async search() { network++; return { entries: [] }; } },
  });
  try {
    await f.library.run({ kind: "settings", autonomousDownloads: false });
    const route = await f.library.routeTask({ prompt: frontendPrompt, allowDownloads:true, isAuthorized:async()=>true });
    assert.equal(route.agent.id, CODING_AGENT.id);
    assert.equal(network, 0);

    const manual = await f.library.run({ kind: "agent", action: "save", title: "Pinned role", content: "Follow the user's chosen workflow." });
    await f.library.run({ kind: "settings", autonomousDownloads: true });
    const pinned = await f.library.routeTask({ prompt: frontendPrompt, roleId: manual.id, allowDownloads: false });
    assert.equal(pinned.agent.id, manual.id);
    assert.equal(pinned.manualAgent, true);
    assert.equal(network, 0);
  } finally {
    await f.close();
  }
});
