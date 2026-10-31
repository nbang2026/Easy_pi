import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir, truncate, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillLibrary } from "../src-tauri/src/gui-skills.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const url = "https://github.com/example/skills/tree/main/reviewer";
const skill = (name = "reviewer", description = "Review complete projects.") => `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\nallowed-tools: Bash\nhooks:\n  before: run-something\ncontext: fork\nagent: dangerous\n---\n# Reviewer\nRead references/guide.md before reviewing.\n`;
function bundle(options = {}) {
  const files = Object.entries(options.files || { "SKILL.md": skill(options.name), "references/guide.md": "The complete guide.", "assets/icon.bin": new Uint8Array([0, 255, 128, 1]) }).map(([path, value]) => {
    const executable = value && typeof value === "object" && "bytes" in value ? value.executable === true : false;
    const input = value && typeof value === "object" && "bytes" in value ? value.bytes : value;
    const bytes = typeof input === "string" ? Buffer.from(input) : input;
    return { path, bytes, sha256: sha(bytes), ...(executable ? { executable: true } : {}) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const modeBound = files.some((file) => file.executable);
  return { source: "github", url, repoUrl: "https://github.com/example/skills", owner: "example", repo: "skills", commit: "a".repeat(40), path: "reviewer", files, treeHash: sha(files.map((file) => `${file.path}\0${file.sha256}${modeBound ? `\0${file.executable ? "100755" : "100644"}` : ""}\n`).join("")), totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0), warnings: [], license: "MIT", ...options, files };
}
async function fixture(resolveBundle = async () => bundle(), search = async (request) => ({ entries: [], page: request.page })) {
  const directory = await mkdtemp(join(tmpdir(), "pi-skill-storage-"));
  const sources = { resolveBundle, search, browse: async (request) => ({ entries: [], sources: [{ source: request.source, ok: true }], page: request.page, hasMore: false }) };
  const library = createSkillLibrary({ directory, sources });
  return { directory, sources, library, close: async () => { library.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
async function ready(library, request = { action: "preview", source: "github", url }) {
  const { jobId } = await library.run(request);
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await library.run({ action: "job", jobId });
    if (job.state !== "running") return job;
    await new Promise((done) => setTimeout(done, 1));
  }
  throw new Error("Preview did not complete.");
}
async function installed(library, request) {
  const job = await ready(library, request);
  assert.equal(job.state, "ready", job.error);
  return library.run({ action: "install", token: job.preview.token, hash: job.preview.hash, accepted: true });
}
async function stored(f) { return JSON.parse(await readFile(join(f.directory, "registry.json"), "utf8")); }
const version = (f, record, runtime = false) => join(f.directory, "versions", record.id, record.storageVersion, runtime ? "runtime" : "original", record.name);

test("preview file reads bind token and hash, reject unsafe/binary/large paths and stop after cancellation", async () => {
  const f = await fixture(async () => bundle({ files: {
    "SKILL.md": skill(), "references/guide.md": "<script>untrusted</script>",
    "assets/icon.bin": new Uint8Array([0, 1]), "assets/invalid.bin": new Uint8Array([255]),
    "references/large.txt": "a".repeat(1024 * 1024 + 1),
  } }));
  try {
    const job = await ready(f.library);
    assert.equal(job.state, "ready", job.error);
    const request = { action: "preview_read", token: job.preview.token, hash: job.preview.hash, path: "references/guide.md" };
    assert.deepEqual(await f.library.run(request), { path: request.path, content: "<script>untrusted</script>" });
    await assert.rejects(f.library.run({ ...request, hash: "wrong" }), /hash mismatch/);
    await assert.rejects(f.library.run({ ...request, token: "wrong" }), /expired|cancelled/);
    for (const path of ["../SKILL.md", "/SKILL.md", "references\\guide.md"]) await assert.rejects(f.library.run({ ...request, path }), /path/);
    await assert.rejects(f.library.run({ ...request, path: "missing.md" }), /does not exist/);
    for (const path of ["assets/icon.bin", "assets/invalid.bin"]) await assert.rejects(f.library.run({ ...request, path }), /Binary/);
    await assert.rejects(f.library.run({ ...request, path: "references/large.txt" }), /1 MiB/);
    await assert.rejects(f.library.run(request, "agent"), /user action/);
    await f.library.run({ action: "cancel", jobId: job.id });
    await assert.rejects(f.library.run(request), /expired|cancelled/);
  } finally { await f.close(); }
});

test("executable source files bind review hashes and retain owner-only permissions in both copies", async () => {
  const helper = "#!/bin/sh\nprintf 'ok\\n'\n";
  let executable = false;
  const f = await fixture(async () => bundle({ files: { "SKILL.md": skill(), "scripts/helper.sh": { bytes: helper, executable } } }));
  try {
    const regular = await ready(f.library);
    executable = true;
    const job = await ready(f.library);
    assert.equal(job.state, "ready", job.error);
    assert.notEqual(job.preview.treeHash, regular.preview.treeHash);
    assert.notEqual(job.preview.hash, regular.preview.hash);
    assert.equal(job.preview.files.find((file) => file.path === "scripts/helper.sh").executable, true);
    const result = await f.library.run({ action: "install", token: job.preview.token, hash: job.preview.hash, accepted: true });
    const registry = await stored(f), record = registry.skills[0];
    assert.equal(record.files.find((file) => file.path === "scripts/helper.sh").executable, true);
    if (process.platform !== "win32") {
      for (const runtime of [false, true]) {
        assert.equal((await stat(join(version(f, record, runtime), "scripts/helper.sh"))).mode & 0o777, 0o700);
        assert.equal((await stat(join(version(f, record, runtime), "SKILL.md"))).mode & 0o777, 0o600);
      }
      await chmod(join(version(f, record, true), "scripts/helper.sh"), 0o600);
      await assert.rejects(f.library.run({ action: "enable", id: result.skill.id, enabled: true }), /permissions/);
      await chmod(join(version(f, record, true), "scripts/helper.sh"), 0o700);
    }
    await f.library.run({ action: "enable", id: result.skill.id, enabled: true });
    record.files.find((file) => file.path === "scripts/helper.sh").executable = false;
    await writeFile(join(f.directory, "registry.json"), JSON.stringify(registry));
    await assert.rejects(f.library.run({ action: "list" }), /corrupt/);
  } finally { await f.close(); }
});

test("legacy registry files without executable metadata remain non-executable and reject unbound flags", async () => {
  const f = await fixture();
  try {
    const result = await installed(f.library);
    const registry = await stored(f);
    for (const file of registry.skills[0].files) assert.equal(file.executable, undefined);
    const restarted = createSkillLibrary({ directory: f.directory, sources: f.sources });
    try {
      await restarted.run({ action: "enable", id: result.skill.id, enabled: true });
      assert.equal((await restarted.enabledPaths()).length, 1);
      const legacy = await stored(f);
      legacy.skills[0].files[0].executable = true;
      await writeFile(join(f.directory, "registry.json"), JSON.stringify(legacy));
      await assert.rejects(restarted.run({ action: "list" }), /corrupt/);
    } finally { restarted.dispose(); }
  } finally { await f.close(); }
});

test("complete multifile preview installs disabled; enabling exposes only sanitized runtime SKILL and original reads stay full", async () => {
  let downloads = 0;
  const f = await fixture(async ({ onProgress }) => { downloads++; onProgress({ phase: "fetching", bytes: 999999999, files: 99999, binary: new Uint8Array(2 * 1024 * 1024), message: "x".repeat(10000) }); return bundle(); });
  try {
    const job = await ready(f.library);
    assert.equal(job.state, "ready", job.error);
    assert.equal(job.preview.content, skill());
    assert.equal(job.preview.files.length, 3);
    assert.equal(job.preview.files.some((file) => "bytes" in file), false);
    assert.ok(job.preview.warnings.some((warning) => warning.includes("allowed-tools")));
    assert.ok(JSON.stringify(job).length < 1024 * 1024);
    assert.deepEqual((await f.library.run({ action: "list" })).skills, []);
    await assert.rejects(f.library.run({ action: "install", token: job.preview.token, hash: "wrong", accepted: true }), /hash/);
    await assert.rejects(f.library.run({ action: "install", token: job.preview.token, hash: job.preview.hash }), /accept/);
    const result = await f.library.run({ action: "install", token: job.preview.token, hash: job.preview.hash, accepted: true });
    assert.equal(result.skill.enabled, false);
    assert.equal(downloads, 1, "install is local-only");
    assert.deepEqual(await f.library.enabledPaths(), []);
    const read = await f.library.run({ action: "read", id: result.skill.id }, "model");
    assert.equal(read.content, skill());
    assert.equal(read.files.length, 3);
    assert.equal((await f.library.run({ action: "read", id: result.skill.id, path: "references/guide.md" }, "model")).content, "The complete guide.");
    await assert.rejects(f.library.run({ action: "read", id: result.skill.id, path: "assets/icon.bin" }), /Binary/);
    const enable = await f.library.run({ action: "enable", id: result.skill.id, enabled: true });
    assert.equal(enable.enabled, true); assert.equal(enable.reloadRequired, true);
    const [path] = await f.library.enabledPaths();
    assert.equal(path.split(/[\\/]/).at(-1), "reviewer");
    assert.deepEqual(await f.library.enabledSkillSnapshot(), { revision: 2, paths: [path] });
    const runtime = await readFile(join(path, "SKILL.md"), "utf8");
    assert.match(runtime, /name: "reviewer"/); assert.match(runtime, /license: "MIT"/);
    for (const control of ["allowed-tools", "hooks", "context", "agent:"]) assert.ok(!runtime.includes(control));
    assert.ok(runtime.includes("Read references/guide.md"));
    assert.deepEqual(await readFile(join(path, "assets/icon.bin")), Buffer.from([0, 255, 128, 1]));
    const restarted = createSkillLibrary({ directory: f.directory, sources: f.sources });
    assert.deepEqual(await restarted.enabledPaths(), [path]);
    assert.equal((await restarted.run({ action: "list" }, "model")).revision, 2);
    if (process.platform !== "win32") assert.equal((await stat(join(f.directory, "registry.json"))).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

test("all network, preview polling and writes require user authority; model status/list/read do not write", async () => {
  let network = 0;
  const f = await fixture(async () => { network++; return bundle(); }, async () => { network++; return {}; });
  try {
    for (const action of ["browse", "search", "preview", "job", "cancel", "install", "enable", "remove", "update"]) await assert.rejects(f.library.run({ action, source: "all", query: "x" }, "model"), /user action/);
    assert.equal(network, 0);
    assert.deepEqual(await f.library.run({ action: "list" }, "model"), { skills: [], revision: 0 });
    assert.deepEqual(await f.library.run({ action: "status" }, "model"), { revision: 0, enabled: [], installed: 0 });
    assert.deepEqual(await readdir(f.directory), []);
    const result = await f.library.run(JSON.stringify({ action: " SEARCH ", source: "all", query: "review", page: "2", apiKey: "secret" }));
    assert.deepEqual(result, {}); assert.equal(network, 1);
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.close(); }
});

test("browse forwards source/page/refresh and cancellation without writing storage", async () => {
  const f = await fixture(); const calls = [];
  f.sources.browse = async (request) => { calls.push(request); return { entries: [], sources: [{ source: request.source, ok: true }], page: request.page, hasMore: false }; };
  const controller = new AbortController();
  try {
    const result = await f.library.run({ action: "browse", source: "skillsmp", page: "2", refresh: true }, "user", controller.signal);
    assert.equal(result.page, 2); assert.deepEqual(calls[0], { source: "skillsmp", page: 2, refresh: true, signal: controller.signal });
    await f.library.run({ action: "browse" }); assert.equal(calls[1].source, "all"); assert.equal(calls[1].page, 1); assert.equal(calls[1].refresh, false);
    for (const request of [{ action: "browse", page: 0 }, { action: "browse", refresh: "true" }, { action: "search", source: "all", refresh: "true" }]) await assert.rejects(f.library.run(request));
    assert.deepEqual(await readdir(f.directory), []);
    controller.abort(); await assert.rejects(f.library.run({ action: "browse" }, "user", controller.signal), /cancelled/);
  } finally { await f.close(); }
});

test("quoted and block scalar YAML is validated; execution metadata is removed without changing originals", async () => {
  for (const [frontmatter, expected] of [
    ["name: 'reviewer'\ndescription: >-\n  Review projects\n  with their context.\ncompatibility: 'Pi and Node'\nmetadata:\n  allowed-tools: Bash\n", "Review projects with their context."],
    ['name: "reviewer" # name\ndescription: |\n  First line\n  Second line\n', "First line\nSecond line"],
    ["name: reviewer\ndescription: 'User''s reviewer'\n", "User's reviewer"],
    ["name: reviewer\ndescription: Review all\n  project files.\n", "Review all project files."],
    [`name: reviewer\ndescription: ${JSON.stringify(`One${String.fromCharCode(0x2028)}two`)}\n`, `One${String.fromCharCode(0x2028)}two`],
  ]) {
    const original = `---\n${frontmatter}---\n# Body\n`;
    const f = await fixture(async () => bundle({ files: { "SKILL.md": original } }));
    try { const result = await installed(f.library); assert.equal(result.skill.description, expected); assert.equal((await f.library.run({ action: "read", id: result.skill.id })).content, original); }
    finally { await f.close(); }
  }
  for (const frontmatter of ["name: reviewer\ndescription: a\nname: other", "name: ../escape\ndescription: a", "name: Reviewer\ndescription: a", "name: reviewer\ndescription: [a]", "name: reviewer\ndescription: &ref x", "name: reviewer\ndescription: yes: no", "name: reviewer", "name: reviewer\ndescription: true"]) {
    const f = await fixture(async () => bundle({ files: { "SKILL.md": `---\n${frontmatter}\n---\nBody` } }));
    try { assert.equal((await ready(f.library)).state, "failed"); assert.deepEqual((await f.library.run({ action: "list" })).skills, []); }
    finally { await f.close(); }
  }
});

test("bundle validation rejects traversal, platform collisions, unpinned commits and bad checksums", async () => {
  const badBundles = [
    bundle({ files: { "SKILL.md": skill(), "../outside": "bad" } }),
    bundle({ files: { "SKILL.md": skill(), "assets\\escape": "bad" } }),
    bundle({ files: { "SKILL.md": skill(), "assets/%2e%2e/file": "bad" } }),
    bundle({ files: { "SKILL.md": skill(), "NUL.txt": "bad" } }),
    bundle({ files: { "SKILL.md": skill(), "a": "one", "A": "two" } }),
    bundle({ files: { "SKILL.md": skill(), "dir": "one", "dir/a": "two" } }),
    bundle({ commit: "main" }), bundle({ path: "../bad" }), bundle({ treeHash: "0".repeat(64) }),
    bundle({ repoUrl: "https://github.com/another/repo" }),
    bundle({ files: { "nested/SKILL.md": skill() } }),
    bundle({ files: { "SKILL.md": skill(), "nested/SKILL.md": skill("nested") } }),
    bundle({ files: { "SKILL.md": new Uint8Array([255, 255]) } }),
  ];
  const corrupt = bundle(); corrupt.files[0].sha256 = "0".repeat(64); badBundles.push(corrupt);
  for (const executable of ["true", 1, null, {}, []]) { const bad = bundle(); bad.files[0].executable = executable; badBundles.push(bad); }
  const unbound = bundle(); unbound.files[0].executable = true; badBundles.push(unbound);
  for (const bad of badBundles) {
    const f = await fixture(async () => bad);
    try { const job = await ready(f.library); assert.equal(job.state, "failed", JSON.stringify(bad.files.map((file) => file.path))); assert.deepEqual(await readdir(f.directory), []); }
    finally { await f.close(); }
  }
});

test("cancellation drops retained previews, ignores late downloads and bounds concurrent jobs/progress", async () => {
  const pending = [];
  const f = await fixture(({ onProgress }) => { onProgress({ phase: "x".repeat(1000), message: "m".repeat(10000), bytes: 1e9, files: 1e9, binary: new Uint8Array(2 * 1024 * 1024) }); return new Promise((done) => pending.push(done)); });
  try {
    const jobs = [];
    for (let i = 0; i < 4; i++) jobs.push(await f.library.run({ action: "preview", source: "github", url }));
    await assert.rejects(f.library.run({ action: "preview", source: "github", url }), /four/);
    const progress = (await f.library.run({ action: "job", jobId: jobs[0].jobId })).progress;
    assert.ok(JSON.stringify(progress).length < 1000); assert.ok(!("binary" in progress));
    assert.ok(progress.bytes <= 20 * 1024 * 1024); assert.ok(progress.files <= 256);
    await f.library.run({ action: "cancel", jobId: jobs[0].jobId });
    pending[0](bundle());
    await new Promise((done) => setTimeout(done, 5));
    assert.equal((await f.library.run({ action: "job", jobId: jobs[0].jobId })).state, "cancelled");
    for (const done of pending.slice(1)) done(bundle());
    await new Promise((done) => setTimeout(done, 5));
    const readyJob = await f.library.run({ action: "job", jobId: jobs[1].jobId });
    assert.equal(readyJob.state, "ready");
    await f.library.run({ action: "cancel", jobId: jobs[1].jobId });
    await assert.rejects(f.library.run({ action: "install", token: readyJob.preview.token, hash: readyJob.preview.hash, accepted: true }), /cancelled|expired/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.library.run({ action: "preview", source: "github", url }, "user", controller.signal), /cancelled/);
    assert.deepEqual((await f.library.run({ action: "list" })).skills, []);
  } finally { await f.close(); }
});

test("canonical duplicates across sites never overwrite; enabled skill names cannot collide", async () => {
  let next = bundle();
  const f = await fixture(async () => next);
  try {
    const first = await installed(f.library);
    next = bundle({ source: "skillstore", url: "https://skillstore.io/skills/example-reviewer" });
    const job = await ready(f.library, { action: "preview", source: "skillstore", url: next.url });
    assert.equal(job.state, "ready");
    await assert.rejects(f.library.run({ action: "install", ...job.preview, accepted: true }), /already installed/);
    assert.equal((await f.library.run({ action: "read", id: first.skill.id })).content, skill());
    next = bundle({ owner: "another", repoUrl: "https://github.com/another/skills", url: "https://github.com/another/skills/tree/main/reviewer" });
    const second = await installed(f.library);
    await f.library.run({ action: "enable", id: first.skill.id, enabled: true });
    await assert.rejects(f.library.run({ action: "enable", id: second.skill.id, enabled: true }), /already uses this name/);
    assert.equal((await f.library.run({ action: "list" })).skills.length, 2);
  } finally { await f.close(); }
});

test("corrupt registries and registry symlinks cannot overwrite or delete installed/user files", async () => {
  const f = await fixture();
  try {
    const result = await installed(f.library);
    const record = (await stored(f)).skills[0];
    const original = await readFile(join(version(f, record), "SKILL.md"), "utf8");
    await writeFile(join(f.directory, "registry.json"), "corrupt");
    for (const request of [{ action: "list" }, { action: "remove", id: result.skill.id, accepted: true }, { action: "enable", id: result.skill.id, enabled: false }]) await assert.rejects(f.library.run(request), /corrupt/);
    assert.equal(await readFile(join(f.directory, "registry.json"), "utf8"), "corrupt");
    assert.equal(await readFile(join(version(f, record), "SKILL.md"), "utf8"), original);
    await rm(join(f.directory, "registry.json"));
    const protectedPath = join(f.directory, "protected.json"); await writeFile(protectedPath, '{"protected":true}');
    await symlink(protectedPath, join(f.directory, "registry.json"));
    await assert.rejects(f.library.run({ action: "list" }));
    const job = await ready(f.library);
    await assert.rejects(f.library.run({ action: "install", token: job.preview.token, hash: job.preview.hash, accepted: true }));
    assert.equal(await readFile(protectedPath, "utf8"), '{"protected":true}');
  } finally { await f.close(); }
});

test("file symlinks and locally edited versions are never exposed as runtime or overwritten; remove preserves edits", async () => {
  let next = bundle();
  const f = await fixture(async () => next);
  try {
    const result = await installed(f.library);
    await f.library.run({ action: "enable", id: result.skill.id, enabled: true });
    const record = (await stored(f)).skills[0];
    const path = join(version(f, record), "references/guide.md");
    await writeFile(path, "user editing");
    next = bundle({ commit: "b".repeat(40) });
    await assert.rejects(f.library.run({ action: "update", id: record.id }), /modified|unsafe/);
    await assert.rejects(f.library.enabledPaths(), /modified|unsafe/);
    const removal = await f.library.run({ action: "remove", id: record.id, accepted: true });
    assert.equal(removal.removed, true); assert.ok(removal.warnings?.length);
    assert.equal(await readFile(path, "utf8"), "user editing");
    assert.deepEqual(await f.library.enabledPaths(), []);
    const second = await installed(f.library);
    const secondRecord = (await stored(f)).skills[0];
    const target = join(f.directory, "user.md"); await writeFile(target, "protected");
    const rootSkill = join(version(f, secondRecord, true), "SKILL.md"); await rm(rootSkill); await symlink(target, rootSkill);
    await assert.rejects(f.library.run({ action: "enable", id: second.skill.id, enabled: true }), /symlink/);
    await f.library.run({ action: "remove", id: second.skill.id, accepted: true });
    assert.equal(await readFile(target, "utf8"), "protected");
  } finally { await f.close(); }
});

test("update previews are bound to the previous revision, keep old enabled on failure, and switch only after accepted local install", async () => {
  let next = bundle(); let downloads = 0; const requests = [];
  const f = await fixture(async (request) => { requests.push(request); downloads++; if (next instanceof Error) throw next; return next; });
  try {
    const first = await installed(f.library);
    await f.library.run({ action: "enable", id: first.skill.id, enabled: true });
    const [oldPath] = await f.library.enabledPaths();
    next = new Error("upstream unavailable");
    assert.equal((await ready(f.library, { action: "update", id: first.skill.id })).state, "failed");
    assert.equal(requests.at(-1).latest, true);
    assert.deepEqual(requests.at(-1).entry, { owner: "example", repo: "skills", repoUrl: "https://github.com/example/skills", path: "reviewer" });
    assert.equal(requests.at(-1).source, "github");
    assert.deepEqual(await f.library.enabledPaths(), [oldPath]);
    next = bundle({ commit: "b".repeat(40), files: { "SKILL.md": skill("reviewer", "Updated review."), "references/new.md": "new" } });
    const stale = await ready(f.library, { action: "update", id: first.skill.id });
    await f.library.run({ action: "enable", id: first.skill.id, enabled: false });
    await assert.rejects(f.library.run({ action: "install", ...stale.preview, accepted: true }), /changed after preview/);
    await f.library.run({ action: "enable", id: first.skill.id, enabled: true });
    const job = await ready(f.library, { action: "update", id: first.skill.id });
    assert.deepEqual(await f.library.enabledPaths(), [oldPath]);
    const beforeInstall = downloads;
    const update = await f.library.run({ action: "install", token: job.preview.token, hash: job.preview.hash, accepted: true });
    assert.equal(downloads, beforeInstall); assert.equal(update.skill.enabled, true); assert.equal(update.skill.id, first.skill.id);
    assert.equal(update.skill.commit, "b".repeat(40));
    const [newPath] = await f.library.enabledPaths(); assert.notEqual(newPath, oldPath);
    assert.equal(await readFile(join(oldPath, "references/guide.md"), "utf8"), "The complete guide.");
    assert.equal(await readFile(join(newPath, "references/new.md"), "utf8"), "new");
    assert.equal((await f.library.run({ action: "read", id: first.skill.id })).content, skill("reviewer", "Updated review."));
    const readyUpdate = await ready(f.library, { action: "update", id: first.skill.id });
    const record = (await stored(f)).skills[0];
    await writeFile(join(version(f, record, true), "SKILL.md"), "edited after preview");
    await assert.rejects(f.library.run({ action: "install", ...readyUpdate.preview, accepted: true }), /modified|unsafe/);
    assert.equal((await f.library.run({ action: "list" })).skills[0].commit, "b".repeat(40));
  } finally { await f.close(); }
});

for (const action of ["update", "remove"]) for (const disableFirst of [false, true]) {
  test(`${action} preserves cached runtime helpers across instances${disableFirst ? " after disabling and restarting" : " while enabled"}`, async () => {
    let next = bundle({ files: { "SKILL.md": skill(), "references/guide.md": "Old guide.", "scripts/helper.mjs": "export default 'old';\n" } });
    const f = await fixture(async () => next);
    const reader = createSkillLibrary({ directory: f.directory, sources: f.sources });
    let writer = f.library;
    try {
      const first = await installed(writer);
      await writer.run({ action: "enable", id: first.skill.id, enabled: true });
      // A running Pi keeps these paths even when a different service changes the registry.
      const [oldPath] = await reader.enabledPaths();
      const oldSkill = await readFile(join(oldPath, "SKILL.md"), "utf8");
      if (disableFirst) {
        await writer.run({ action: "enable", id: first.skill.id, enabled: false });
        writer.dispose();
        writer = createSkillLibrary({ directory: f.directory, sources: f.sources });
      }
      if (action === "update") {
        next = bundle({ commit: "b".repeat(40), files: { "SKILL.md": skill("reviewer", "Updated review."), "scripts/helper.mjs": "export default 'new';\n" } });
        const result = await installed(writer, { action: "update", id: first.skill.id });
        assert.equal(result.skill.id, first.skill.id);
        assert.equal(result.skill.enabled, !disableFirst);
        assert.equal(await readFile(join(oldPath, "scripts/helper.mjs"), "utf8"), "export default 'old';\n");
        assert.ok(result.warnings?.some((warning) => /retained/i.test(warning)));
        const [record] = (await stored(f)).skills;
        assert.equal(record.commit, "b".repeat(40));
        const newPath = version(f, record, true);
        assert.notEqual(newPath, oldPath);
        assert.equal(await readFile(join(newPath, "scripts/helper.mjs"), "utf8"), "export default 'new';\n");
        assert.deepEqual(await reader.enabledPaths(), disableFirst ? [] : [newPath]);
        await assert.rejects(writer.run({ action: "read", id: first.skill.id, path: "references/guide.md" }), /does not exist/);
      } else {
        const result = await writer.run({ action: "remove", id: first.skill.id, accepted: true });
        assert.equal(result.removed, true);
        assert.equal(await readFile(join(oldPath, "scripts/helper.mjs"), "utf8"), "export default 'old';\n");
        assert.ok(result.warnings?.some((warning) => /retained/i.test(warning)));
        assert.deepEqual((await stored(f)).skills, []);
        assert.deepEqual((await writer.run({ action: "list" })).skills, []);
        assert.deepEqual(await reader.enabledPaths(), []);
        await assert.rejects(writer.run({ action: "read", id: first.skill.id }), /does not exist/);
      }
      assert.equal(await readFile(join(oldPath, "SKILL.md"), "utf8"), oldSkill);
      assert.equal(await readFile(join(oldPath, "references/guide.md"), "utf8"), "Old guide.");
      assert.equal(await readFile(join(oldPath, "scripts/helper.mjs"), "utf8"), "export default 'old';\n");
      writer.dispose();
      writer = createSkillLibrary({ directory: f.directory, sources: f.sources });
      await writer.run({ action: "list" }); await writer.enabledPaths();
      assert.equal(await readFile(join(oldPath, "scripts/helper.mjs"), "utf8"), "export default 'old';\n");
    } finally { reader.dispose(); writer.dispose(); await f.close(); }
  });
}

test("retired versions remain quota-accounted after removal even when never enabled", async () => {
  const f = await fixture();
  try {
    const first = await installed(f.library);
    const [record] = (await stored(f)).skills;
    await f.library.run({ action: "remove", id: first.skill.id, accepted: true });
    const helper = join(version(f, record), "references/guide.md");
    assert.equal(await readFile(helper, "utf8"), "The complete guide.");
    // Sparse length exercises the existing total-storage limit without a large allocation.
    await truncate(helper, 256 * 1024 * 1024);
    const job = await ready(f.library);
    assert.equal(job.state, "ready", job.error);
    await assert.rejects(f.library.run({ action: "install", ...job.preview, accepted: true }), /256 MiB/);
    assert.deepEqual((await stored(f)).skills, []);
    assert.equal((await stat(helper)).size, 256 * 1024 * 1024);
    assert.equal(await readFile(join(version(f, record, true), "references/guide.md"), "utf8"), "The complete guide.");
  } finally { await f.close(); }
});

test("cross-instance writes serialize and untracked manually created directories are preserved", async () => {
  const f = await fixture();
  const other = createSkillLibrary({ directory: f.directory, sources: { resolveBundle: async () => bundle({ owner: "other", repoUrl: "https://github.com/other/skills", url: "https://github.com/other/skills/tree/main/reviewer", name: "other-reviewer" }), search: async () => ({ entries: [] }) } });
  try {
    await mkdir(join(f.directory, "manual")); await writeFile(join(f.directory, "manual", "SKILL.md"), "user skill");
    const [a, b] = await Promise.all([ready(f.library), ready(other)]);
    await Promise.all([f.library.run({ action: "install", ...a.preview, accepted: true }), other.run({ action: "install", ...b.preview, accepted: true })]);
    assert.equal((await f.library.run({ action: "list" })).skills.length, 2);
    assert.equal((await stored(f)).revision, 2);
    for (const record of (await f.library.run({ action: "list" })).skills) await f.library.run({ action: "remove", id: record.id, accepted: true });
    assert.equal(await readFile(join(f.directory, "manual", "SKILL.md"), "utf8"), "user skill");
  } finally { other.dispose(); await f.close(); }
});

test("file, SKILL.md, bundle and file-count limits fail before installation", async () => {
  const cases = [
    bundle({ files: { "SKILL.md": skill(), "huge.bin": new Uint8Array(5 * 1024 * 1024 + 1) } }),
    bundle({ files: { "SKILL.md": skill() + "x".repeat(256 * 1024) } }),
    bundle({ files: { "SKILL.md": skill(), ...Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`file-${i}`, "x"])) } }),
    bundle({ files: { "SKILL.md": skill(), ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`large-${i}`, new Uint8Array(5 * 1024 * 1024)])) } }),
  ];
  for (const value of cases) {
    const f = await fixture(async () => value);
    try { assert.equal((await ready(f.library)).state, "failed"); assert.deepEqual(await readdir(f.directory), []); }
    finally { await f.close(); }
  }
});

test("read rejects path attacks and large text files without truncating SKILL.md", async () => {
  const content = skill() + "full skill body\n".repeat(5000);
  const f = await fixture(async () => bundle({ files: { "SKILL.md": content, "large.txt": "z".repeat(1024 * 1024 + 1) } }));
  try {
    const result = await installed(f.library);
    assert.equal((await f.library.run({ action: "read", id: result.skill.id }, "model")).content, content);
    for (const path of ["../registry.json", "/etc/passwd", "references\\x", "./SKILL.md", "large.txt"]) await assert.rejects(f.library.run({ action: "read", id: result.skill.id, path }, "model"));
  } finally { await f.close(); }
});

test("default source resolver downloads a full pinned bundle and updates the same canonical folder from HEAD", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-skill-source-integration-"));
  const originalSkill = skill();
  const revisedSkill = skill("reviewer", "Latest upstream description.");
  const initial = "a".repeat(40), latest = "b".repeat(40);
  const rootTree = "c".repeat(40), folderTree = "d".repeat(40);
  const requests = [];
  const bytesFor = (commit, path) => Buffer.from(path === "SKILL.md" ? commit === latest ? revisedSkill : originalSkill : "Complete helper reference.");
  const blob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const fetcher = async (input, options) => {
    const url = new URL(input); requests.push(url.href);
    assert.equal(options.redirect, "error");
    if (url.hostname === "api.github.com") {
      const prefix = "/repos/example/skills";
      assert.ok(url.pathname === prefix || url.pathname.startsWith(prefix + "/"));
      const route = decodeURIComponent(url.pathname.slice(prefix.length).replace(/^\//, ""));
      if (!route) return json({ private: false, default_branch: "main" });
      if (route.startsWith("commits/")) {
        const ref = route.slice("commits/".length);
        const commit = ref === initial ? initial : ref === "main" ? latest : null;
        if (!commit) return json({ message: "not found" });
        return json({ sha: commit, commit: { tree: { sha: rootTree } } });
      }
      if (route === `git/trees/${rootTree}` && !url.search) return json({ tree: [{ path: "reviewer", type: "tree", mode: "040000", sha: folderTree }] });
      if (route === `git/trees/${folderTree}`) {
        const recentCommit = [...requests].reverse().find((value) => value.includes("/commits/"));
        const commit = recentCommit?.endsWith("/main") ? latest : initial;
        return json({ truncated: false, tree: ["SKILL.md", "reference.md"].map((path) => ({ path, type: "blob", mode: path === "reference.md" ? "100755" : "100644", sha: blob(bytesFor(commit, path)), size: bytesFor(commit, path).length })) });
      }
    }
    if (url.hostname === "raw.githubusercontent.com") {
      const [, owner, repo, commit, folder, ...parts] = url.pathname.split("/");
      assert.equal(owner, "example"); assert.equal(repo, "skills"); assert.equal(folder, "reviewer");
      return new Response(bytesFor(commit, parts.join("/")));
    }
    throw new Error(`Unexpected mock request: ${url.href}`);
  };
  const library = createSkillLibrary({ directory, fetcher });
  try {
    const initialUrl = `https://github.com/example/skills/tree/${initial}/reviewer`;
    const first = await installed(library, { action: "preview", source: "all", url: initialUrl });
    assert.equal(first.skill.source, "github"); assert.equal(first.skill.commit, initial); assert.equal(first.skill.enabled, false);
    assert.equal(first.skill.files.find((file) => file.path === "reference.md").executable, true);
    await library.run({ action: "enable", id: first.skill.id, enabled: true });
    const [runtimePath] = await library.enabledPaths();
    if (process.platform !== "win32") assert.equal((await stat(join(runtimePath, "reference.md"))).mode & 0o777, 0o700);
    const updateJob = await ready(library, { action: "update", id: first.skill.id });
    assert.equal(updateJob.state, "ready", updateJob.error);
    assert.equal(updateJob.preview.commit, latest);
    assert.equal(updateJob.preview.content, revisedSkill);
    const downloads = requests.length;
    const result = await library.run({ action: "install", ...updateJob.preview, accepted: true });
    assert.equal(requests.length, downloads, "install must use only previewed local bytes");
    assert.equal(result.skill.enabled, true); assert.equal(result.skill.commit, latest);
    assert.equal((await library.run({ action: "read", id: first.skill.id })).content, revisedSkill);
  } finally { library.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("stable unsafe or corrupt store locks reject and preserve their files", async () => {
  const f = await fixture();
  try {
    const job = await ready(f.library);
    const lock = join(f.directory, ".write-lock"), protectedFile = join(f.directory, "protected-lock");
    await writeFile(protectedFile, "user lock contents"); await symlink(protectedFile, lock);
    await assert.rejects(f.library.run({ action: "install", ...job.preview, accepted: true }), /Unsafe skill store lock/);
    assert.equal(await readFile(protectedFile, "utf8"), "user lock contents");
    await rm(lock); await writeFile(lock, "invalid lock");
    await assert.rejects(f.library.run({ action: "install", ...job.preview, accepted: true }), /Invalid skill store lock/);
    assert.equal(await readFile(lock, "utf8"), "invalid lock");
  } finally { await f.close(); }
});

test("cancelling a preview while an install is queued prevents committing its bundle", async () => {
  const f = await fixture();
  try {
    const job = await ready(f.library);
    await writeFile(join(f.directory, ".write-lock"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const installing = f.library.run({ action: "install", token: job.preview.token, hash: job.preview.hash, accepted: true });
    await new Promise((done) => setTimeout(done, 5));
    await f.library.run({ action: "cancel", jobId: job.id });
    await rm(join(f.directory, ".write-lock"));
    await assert.rejects(installing, /cancelled|expired/);
    assert.deepEqual((await f.library.run({ action: "list" })).skills, []);
  } finally { await f.close(); }
});

test("expired preview tokens release their bundles and cannot be installed", async () => {
  const f = await fixture();
  const clock = Date.now;
  try {
    const job = await ready(f.library);
    assert.equal(job.state, "ready");
    const now = clock();
    Date.now = () => now + 16 * 60 * 1000;
    await assert.rejects(f.library.run({ action: "install", token: job.preview.token, hash: job.preview.hash, accepted: true }), /expired/);
    assert.equal((await f.library.run({ action: "job", jobId: job.id })).state, "failed");
    assert.deepEqual((await f.library.run({ action: "list" })).skills, []);
  } finally { Date.now = clock; await f.close(); }
});
