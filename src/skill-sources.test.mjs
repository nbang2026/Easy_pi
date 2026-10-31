import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createSkillSources } from "../src-tauri/src/skill-sources.mjs";

const COMMIT = "a".repeat(40), TREE = "b".repeat(40), FOLDER = "c".repeat(40);
const hash = (value, algorithm = "sha256") => createHash(algorithm).update(value).digest("hex");
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const skill = new TextEncoder().encode("---\nname: example\ndescription: A complete skill\n---\nRead references and run scripts only with permission.\n");
const blob = (path, bytes, mode = "100644") => ({ path, type: "blob", mode, sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), size: bytes.length });
function fixture({ files = [{ path: "SKILL.md", bytes: skill }, { path: "assets/logo.bin", bytes: new Uint8Array([0, 255, 128, 1]) }, { path: "LICENSE", bytes: new TextEncoder().encode("MIT license notice") }], tree, ref = "main", folder = "example", override } = {}) {
  const calls = [];
  const entries = tree || files.map(({ path, bytes, mode }) => blob(path, bytes, mode));
  const fetcher = async (value, options) => {
    const url = new URL(value); calls.push({ url, options });
    const replaced = override?.(url, options);
    if (replaced !== undefined) return replaced;
    if (url.hostname === "api.github.com") {
      const base = "/repos/acme/skills/";
      if (url.pathname === base.slice(0, -1)) return json({ default_branch: ref, private: false });
      if ([`${base}commits/${ref}`, `${base}commits/${COMMIT}`].includes(url.pathname)) return json({ sha: COMMIT, commit: { tree: { sha: TREE } } });
      if (url.pathname.startsWith(`${base}commits/`)) return json({ message: "Not found" }, 404);
      if (url.pathname === `${base}git/trees/${TREE}` && !url.search) return json({ tree: [{ path: folder, type: "tree", mode: "040000", sha: FOLDER }] });
      if (url.pathname === `${base}git/trees/${FOLDER}`) return json({ tree: entries, truncated: false });
      if (url.pathname === `${base}git/trees/${TREE}` && url.search) return json({ tree: entries.map((entry) => ({ ...entry, path: `${folder}/${entry.path}` })), truncated: false });
    }
    if (url.hostname === "raw.githubusercontent.com") {
      const prefix = `/acme/skills/${COMMIT}/${folder}/`;
      const file = files.find((item) => url.pathname === prefix + item.path);
      if (file) return new Response(file.bytes);
    }
    return json({ message: "Not found" }, 404);
  };
  return { sources: createSkillSources({ fetcher }), calls, files, fetcher };
}

test("all-source search normalizes the three public APIs and isolates unavailable sources", async () => {
  const calls = [];
  const sources = createSkillSources({ fetcher: async (value, options) => {
    const url = new URL(value); calls.push({ url, options });
    if (url.hostname === "skillstore.io") return json({ data: [{ slug: "acme-example", displayName: "example", description: "A skill", repo: `https://github.com/acme/skills/tree/${COMMIT}/example`, ref: "d".repeat(40), license: "MIT" }], pagination: { total: 21 } });
    if (url.hostname === "www.skills.sh") return json({ skills: [{ source: "acme/skills", skillId: "example", name: "Example", id: "internal", installs: 42 }] });
    return json({ success: false, error: { code: "SEARCH_INDEX_UNAVAILABLE" } });
  } });
  const result = await sources.search({ source: "all", query: "pdf & images", apiKey: "private-key" });
  assert.equal(result.entries.length, 2); assert.equal(result.hasMore, true);
  assert.equal(result.entries[0].name, "example"); assert.equal(result.entries[1].id, "example");
  assert.equal(result.sources[2].code, "SEARCH_INDEX_UNAVAILABLE");
  for (const { url, options } of calls) {
    assert.equal(url.searchParams.get("q"), "pdf & images"); assert.equal(url.searchParams.get("limit"), "20"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, url.hostname === "skillsmp.com" ? "Bearer private-key" : undefined);
  }
  const second = await sources.search({ source: "skills-sh", query: "pdf", page: 2 });
  assert.equal(second.hasMore, false); assert.equal(second.entries.length, 0); assert.equal(calls.length, 3);
});

test("SkillsMP search maps concrete GitHub URLs and reports HTTP retry delays", async () => {
  const sources = createSkillSources({ fetcher: async () => json({ success: true, data: { skills: [{ id: "123", name: "pdf", author: "acme", githubUrl: "https://github.com/acme/skills/tree/main/example", skillUrl: "https://skillsmp.com/skills/pdf", stars: 5 }], pagination: { total: 21 } } }) });
  const result = await sources.search({ source: "skillsmp", query: "pdf" });
  assert.equal(result.entries[0].repoUrl, "https://github.com/acme/skills/tree/main/example"); assert.equal(result.hasMore, true);
  const throttled = createSkillSources({ fetcher: async () => json({}, 429, { "Retry-After": "17" }) });
  const failed = await throttled.search({ source: "skillsmp", query: "x" });
  assert.equal(failed.sources[0].retryAfter, 17); assert.equal(failed.sources[0].code, "RATE_LIMITED");
});

const shRow = (id = "example", owner = "acme", count = "42") => `<a href="/${owner}/skills/${id}"><div><span>1</span></div><div><h3>${id}</h3><p>${owner}/skills</p></div><div><span>${count}</span></div></a>`;
const mpRow = (id = "skills-example", owner = "acme", description = "A skill &amp; useful &#x27;quotes&#39;") => `<li><a href="/creators/${owner}/skills/${id}"><span>Example &lt;safe&gt;</span><span><span dir="auto">${description}</span></span></a><span>Repository: </span><bdi>${owner}/skills</bdi><span>GitHub stars<!-- -->: </span><bdi>1,234</bdi></li>`;

test("browse reads actual keyword-free catalogs, caps each page and isolates source errors", async () => {
  const calls = [];
  const sources = createSkillSources({ fetcher: async (value, options) => {
    const url = new URL(value); calls.push({ url, options });
    if (url.hostname === "skillstore.io") return json({ data: Array.from({ length: 24 }, (_, i) => ({ slug: `acme-${i}`, name: `Skill ${i}`, repo: "https://github.com/acme/skills" })), pagination: { totalPages: 5 } });
    if (url.hostname === "www.skills.sh") return new Response(`<main>${Array.from({ length: 25 }, (_, i) => shRow(`example-${i}`)).join("")}</main>`);
    return json({}, 429, { "retry-after": "9" });
  } });
  const result = await sources.browse();
  assert.equal(result.page, 1); assert.equal(result.entries.length, 40); assert.equal(result.hasMore, true);
  assert.deepEqual(result.sources, [{ source: "skillstore", ok: true }, { source: "skills-sh", ok: true }, { source: "skillsmp", ok: false, error: "Skill source returned HTTP 429.", code: "RATE_LIMITED", retryAfter: 9 }]);
  assert.equal(result.entries[20].installs, 42); assert.equal(result.entries[20].repository, "acme/skills");
  for (const { url, options } of calls) { assert.equal(url.searchParams.has("q"), false); assert.equal(options.headers.Authorization, undefined); assert.equal(options.redirect, "error"); }
  assert.equal(calls[0].url.href, "https://skillstore.io/api/skills?limit=20&page=1");
  assert.equal(calls[1].url.href, "https://www.skills.sh/");
  assert.equal(calls[2].url.href, "https://skillsmp.com/skills/page/1");
  const second = await sources.browse({ source: "skills-sh", page: 2 });
  assert.equal(second.entries.length, 5); assert.equal(second.entries[0].id, "example-20"); assert.equal(second.hasMore, false); assert.equal(calls.length, 3);
  const third = await sources.browse({ source: "skills-sh", page: 3 });
  assert.deepEqual(third.entries, []); assert.equal(third.hasMore, false); assert.equal(calls.length, 3);
});

test("SkillsMP static index decodes text, requires safe paths/hosts and only advertises real next links", async () => {
  const calls = [];
  const sources = createSkillSources({ fetcher: async (value) => {
    const url = new URL(value); calls.push(url);
    const page = Number(url.pathname.split("/").at(-1));
    const html = `<head><script>${mpRow("in-script")}</script></head><main><script>${mpRow("in-body-script")}</script><template>${mpRow("in-template")}</template><a href="//evil.test/creators/acme/skills/evil"><span>evil</span></a><a href="https://skillsmp.com.evil.test/creators/acme/skills/evil"><span>evil</span></a>${mpRow("bad%2fpath")}${mpRow("%2e%2e")}${mpRow("example?token=secret")}${mpRow()}${mpRow()}<a href="https://evil.test/skills/page/${page + 1}">Next</a>${page === 1 ? '<a href="/skills/page/2">Next</a>' : ''}</main>`;
    return new Response(html);
  } });
  const first = await sources.browse({ source: "skillsmp" });
  assert.equal(first.entries.length, 1); assert.equal(first.hasMore, true);
  assert.equal(first.entries[0].name, "Example <safe>"); assert.equal(first.entries[0].description, "A skill & useful 'quotes'"); assert.equal(first.entries[0].stars, 1234);
  assert.equal(first.entries[0].repoUrl, "https://github.com/acme/skills"); assert.equal(first.entries[0].author, "acme");
  const second = await sources.browse({ source: "skillsmp", page: 2 });
  assert.equal(second.hasMore, false); assert.equal(calls[1].pathname, "/skills/page/2");
});

test("SkillsMP consumes every observed source-page row before following its real next link", async () => {
  const calls = [];
  const sources = createSkillSources({ fetcher: async (value) => {
    calls.push(value); const first = value.endsWith("/1");
    return new Response(`<ol>${Array.from({ length: first ? 100 : 3 }, (_, index) => mpRow(`example-${(first ? 0 : 100) + index}`)).join("")}</ol>${first ? '<a href="/skills/page/2">Next</a>' : ''}`);
  } });
  const ids = [];
  for (let page = 1; page <= 6; page++) {
    const result = await sources.browse({ source: "skillsmp", page });
    assert.equal(result.entries.length, page < 6 ? 20 : 3); assert.equal(result.hasMore, page < 6);
    ids.push(...result.entries.map((entry) => entry.id));
  }
  assert.equal(new Set(ids).size, 103); assert.equal(ids[100], "example-100");
  assert.deepEqual(calls, ["https://skillsmp.com/skills/page/1", "https://skillsmp.com/skills/page/2"]);
});

test("browse cache expires after sixty seconds and cancelled cache reads reject", async () => {
  let calls = 0;
  const sources = createSkillSources({ fetcher: async () => { calls++; return new Response(shRow()); } });
  await sources.browse({ source: "skills-sh" });
  const clock = Date.now;
  try {
    const time = clock(); Date.now = () => time + 60001;
    await sources.browse({ source: "skills-sh" }); assert.equal(calls, 2);
  } finally { Date.now = clock; }
  const controller = new AbortController(); controller.abort(new Error("Cancelled cache read"));
  await assert.rejects(sources.browse({ source: "skills-sh", signal: controller.signal }), /Cancelled cache read/);
});

test("search and browse requests time out at eight seconds with no timeout retry", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const method of ["search", "browse"]) {
      let calls = 0, started;
      const fetching = new Promise((resolve) => { started = resolve; });
      const sources = createSkillSources({ fetcher: async () => { calls++; started(); return new Promise(() => {}); } });
      const pending = sources[method]({ source: "skillstore" });
      await fetching; context.mock.timers.tick(8000);
      const result = await pending;
      assert.equal(result.sources[0].code, "TIMEOUT"); assert.equal(calls, 1);
    }
  } finally { context.mock.timers.reset(); }
});

test("browse cache is success-only, bounded, immutable to callers and refresh bypasses it", async () => {
  let calls = 0, fail = false;
  const sources = createSkillSources({ fetcher: async () => { calls++; return fail ? json({}, 503) : new Response(shRow()); } });
  const first = await sources.browse({ source: "skills-sh" }); first.entries[0].name = "tampered";
  assert.equal((await sources.browse({ source: "skills-sh" })).entries[0].name, "example"); assert.equal(calls, 1);
  await sources.browse({ source: "skills-sh", refresh: true }); assert.equal(calls, 2);
  fail = true;
  assert.equal((await sources.browse({ source: "skills-sh", refresh: true })).sources[0].ok, false);
  assert.equal((await sources.browse({ source: "skills-sh" })).sources[0].ok, false); assert.equal(calls, 4);
  const cached = createSkillSources({ fetcher: async () => { calls++; return json({ data: [], pagination: { hasMore: false } }); } });
  for (let page = 1; page <= 61; page++) await cached.browse({ source: "skillstore", page });
  const before = calls; await cached.browse({ source: "skillstore", page: 1 }); assert.equal(calls, before + 1);
});

test("search refresh bypasses the short cache without leaking credentials between sources", async () => {
  let calls = 0;
  const sources = createSkillSources({ fetcher: async (value, options) => {
    calls++; assert.equal(options.headers.Authorization, new URL(value).hostname === "skillsmp.com" ? "Bearer private-key" : undefined);
    return json({ skills: [] });
  } });
  await sources.search({ source: "skills-sh", query: "pdf", apiKey: "private-key" });
  await sources.search({ source: "skills-sh", query: "pdf", apiKey: "private-key" }); assert.equal(calls, 1);
  await sources.search({ source: "skills-sh", query: "pdf", refresh: true }); assert.equal(calls, 2);
});

test("HTML layout drift and malformed UTF-8 fail transparently without fake results", async () => {
  for (const body of ["<html><h1>Enable JavaScript</h1></html>", new Uint8Array([0xff, 0xfe])]) {
    const sources = createSkillSources({ fetcher: async () => new Response(body) });
    const result = await sources.browse({ source: "skillsmp" });
    assert.equal(result.entries.length, 0); assert.equal(result.sources[0].ok, false);
    assert.ok(["INVALID_RESPONSE", "INVALID_HTML"].includes(result.sources[0].code));
  }
});

test("SkillsMP detail ignores injected script links and rejects mismatched or ambiguous sources", async () => {
  for (const body of [
    `<script><a href="https://github.com/acme/skills/tree/main/example">Injected</a></script>`,
    '<a href="https://github.com/other/skills/tree/main/example">Wrong repository</a>',
    '<a href="https://github.com/acme/skills/tree/main/one">One</a><a href="https://github.com/acme/skills/tree/main/two">Two</a>',
  ]) {
    const f = fixture({ override: (url) => url.hostname === "skillsmp.com" ? new Response(body) : undefined });
    await assert.rejects(f.sources.resolveBundle({ source: "skillsmp", url: "https://skillsmp.com/creators/acme/skills/skills-example" }), { code: "SOURCE_NOT_FOUND" });
    assert.equal(f.calls.some(({ url }) => url.hostname === "api.github.com"), false);
  }
});

test("GitHub bundles are complete, binary-preserving, commit-pinned, deterministic and scoped", async () => {
  const f = fixture(); const progress = [];
  const bundle = await f.sources.resolveBundle({ source: "all", url: "https://github.com/acme/skills/tree/main/example", onProgress: (item) => progress.push(item) });
  assert.equal(bundle.source, "github"); assert.equal(bundle.path, "example"); assert.equal(bundle.commit, COMMIT);
  assert.equal(bundle.url, `https://github.com/acme/skills/tree/${COMMIT}/example`);
  assert.deepEqual(bundle.files.map((file) => file.path), ["LICENSE", "SKILL.md", "assets/logo.bin"]);
  assert.deepEqual(bundle.files[2].bytes, new Uint8Array([0, 255, 128, 1]));
  assert.equal(bundle.totalBytes, f.files.reduce((total, file) => total + file.bytes.length, 0));
  for (const file of bundle.files) assert.equal(file.sha256, hash(file.bytes));
  assert.equal(bundle.treeHash, hash(bundle.files.map((file) => `${file.path}\0${file.sha256}\n`).join("")));
  assert.equal(progress.at(-1).completed, 3);
  for (const { url, options } of f.calls) {
    assert.equal(options.redirect, "error"); assert.equal(options.headers.Authorization, undefined);
    if (url.hostname === "raw.githubusercontent.com") assert.ok(url.pathname.startsWith(`/acme/skills/${COMMIT}/example/`));
  }
});

test("GitHub executable bits survive source resolution", async () => {
  const helper = new TextEncoder().encode("#!/bin/sh\nprintf 'ok\\n'\n");
  const f = fixture({ files: [{ path: "SKILL.md", bytes: skill }, { path: "scripts/helper.sh", bytes: helper, mode: "100755" }] });
  const result = await f.sources.resolveBundle({ source: "github", url: `https://github.com/acme/skills/tree/${COMMIT}/example` });
  assert.equal(result.files.find((file) => file.path === "scripts/helper.sh").executable, true);
  assert.equal(result.files.find((file) => file.path === "SKILL.md").executable, false);
});

test("latest update resolves HEAD only for the installed pinned canonical identity", async () => {
  const f = fixture();
  const bundle = await f.sources.resolveBundle({ source: "github", url: `https://github.com/acme/skills/tree/${COMMIT}/example`, latest: true, entry: { owner: "acme", repo: "skills", path: "example" } });
  assert.equal(bundle.commit, COMMIT);
  assert.ok(f.calls.some(({ url }) => url.pathname.endsWith("/commits/main")));
  await assert.rejects(f.sources.resolveBundle({ source: "github", url: `https://github.com/acme/skills/tree/${COMMIT}/example`, latest: true, entry: { owner: "acme", repo: "skills", path: "other" } }), { code: "INVALID_REQUEST" });
});

test("skills.sh discovers the exact skill directory and surfaces ambiguous candidates", async () => {
  const f = fixture();
  const bundle = await f.sources.resolveBundle({ source: "skills-sh", url: "https://skills.sh/acme/skills/example" });
  assert.equal(bundle.path, "example"); assert.equal(bundle.source, "skills-sh");
  const ambiguous = fixture({ override: (url) => url.pathname.endsWith(`/git/trees/${TREE}`) && url.search ? json({ tree: [blob("one/example/SKILL.md", skill), blob("two/example/SKILL.md", skill)], truncated: false }) : undefined });
  await assert.rejects(ambiguous.sources.resolveBundle({ source: "skills-sh", url: "https://skills.sh/acme/skills/example" }), (error) => error.code === "AMBIGUOUS_SKILL" && error.candidates.length === 2);
  const truncated = fixture({ override: (url) => url.pathname.includes("git/trees") ? json({ tree: [], truncated: true }) : undefined });
  await assert.rejects(truncated.sources.resolveBundle({ source: "skills-sh", url: "https://skills.sh/acme/skills/example" }), { code: "TRUNCATED_TREE" });
});

test("Skillstore concrete repository revision wins over inconsistent metadata ref", async () => {
  const f = fixture({ override: (url) => {
    if (url.hostname !== "skillstore.io") return undefined;
    if (url.pathname.endsWith("/manifest")) return json({ source: { ref: "unrelated" }, signature: "unverified" });
    return json({ data: { repo: `https://github.com/acme/skills/tree/${COMMIT}/example`, ref: "different", name: "example", license: "MIT" } });
  } });
  const bundle = await f.sources.resolveBundle({ source: "skillstore", url: "https://www.skillstore.io/skills/acme-example" });
  assert.equal(bundle.commit, COMMIT); assert.equal(bundle.source, "skillstore"); assert.equal(bundle.license, "MIT");
  assert.equal(bundle.rawManifest.signature, "unverified");
  assert.equal(f.calls.some(({ url }) => url.pathname.includes("commits/different") || url.pathname.includes("commits/unrelated")), false);
});

test("SkillsMP creator pages resolve exact detail HTML to a pinned folder despite differing slugs", async () => {
  const f = fixture({ override: (url) => url.hostname === "skillsmp.com" ? new Response(`<main><a href="https://github.com/acme/skills">Repository</a><a href="https://github.com/acme/skills/tree/${COMMIT}/example">View source</a><a href="https://github.com/acme/skills/tree/${COMMIT}/example">Same source</a></main>`) : undefined });
  const bundle = await f.sources.resolveBundle({ source: "all", entry: { source: "skillsmp", name: "example", id: "skills-example", url: "https://skillsmp.com/creators/acme/skills/skills-example", repoUrl: "https://github.com/untrusted/other/tree/main/wrong" } });
  assert.equal(bundle.source, "skillsmp"); assert.equal(bundle.commit, COMMIT); assert.equal(bundle.path, "example");
  assert.equal(bundle.files.length, 3);
  assert.equal(f.calls.some(({ url }) => url.hostname === "skillsmp.com" && url.pathname.startsWith("/api/")), false);
});

test("transient network failures retry once without hiding permanent errors or cancellation", async () => {
  let calls = 0;
  const recovered = createSkillSources({ fetcher: async () => {
    if (++calls === 1) throw new TypeError("fetch failed");
    return json({ skills: [] });
  } });
  assert.equal((await recovered.search({ source: "skills-sh", query: "pdf" })).sources[0].ok, true);
  assert.equal(calls, 2);
  calls = 0;
  const offline = createSkillSources({ fetcher: async () => { calls++; throw new TypeError("fetch failed"); } });
  const result = await offline.search({ source: "skills-sh" });
  assert.equal(calls, 2);
  assert.equal(result.sources[0].code, "NETWORK_ERROR");
  assert.match(result.sources[0].error, /skills\.sh/);
  calls = 0;
  const blocked = createSkillSources({ fetcher: async () => { calls++; return json({}, 429); } });
  assert.equal((await blocked.search({ source: "skillsmp" })).sources[0].code, "RATE_LIMITED");
  assert.equal(calls, 1);
  calls = 0;
  const controller = new AbortController();
  const cancelled = createSkillSources({ fetcher: async () => { calls++; controller.abort(new Error("Cancelled")); throw new TypeError("fetch failed"); } });
  await assert.rejects(cancelled.search({ source: "skills-sh", signal: controller.signal }), /Cancelled/);
  assert.equal(calls, 1);
});

test("unsafe source URLs are rejected before networking", async () => {
  let calls = 0; const sources = createSkillSources({ fetcher: async () => { calls++; throw new Error("unexpected"); } });
  for (const url of ["http://github.com/acme/skills/tree/main/example", "https://user:secret@github.com/acme/skills/tree/main/example", "https://github.com:443/acme/skills/tree/main/example", "https://github.com.evil.test/acme/skills/tree/main/example", "https://localhost/a", "https://github.com/acme/skills/tree/main/%2e%2e/example", "https://github.com/acme/skills/tree/main/foo%2fbar", "https://github.com/acme/skills/tree/main/foo%5cbar", "https://github.com/acme/skills/tree/main/foo\\bar", "https://github.com/acme/skills/tree/main/example?token=secret", "https://github.com/acme/skills/tree/main/example#x"]) await assert.rejects(sources.resolveBundle({ source: "github", url }));
  assert.equal(calls, 0);
});

test("unsafe tree paths, symlinks, submodules and case collisions reject before raw downloads", async () => {
  const badTrees = [
    [blob("../escape", skill)], [blob("bad\\path", skill)], [blob("NUL.txt", skill)], [blob("trailing. ", skill)],
    [blob("assets/a:b", skill)], [blob(".git/config", skill)], [{ ...blob("SKILL.md", skill), mode: "120000" }],
    [{ path: "module", mode: "160000", type: "commit", sha: TREE }],
    [blob("SKILL.md", skill), blob("skill.MD", skill)],
    [blob("SKILL.md", skill), blob("assets", skill), blob("assets/x", skill)],
    [blob("SKILL.md", skill), blob("a/".repeat(12) + "file", skill)],
  ];
  for (const tree of badTrees) {
    const f = fixture({ tree });
    await assert.rejects(f.sources.resolveBundle({ source: "github", url: `https://github.com/acme/skills/tree/${COMMIT}/example` }));
    assert.equal(f.calls.some(({ url }) => url.hostname === "raw.githubusercontent.com"), false);
  }
});

test("bundle limits and Git object integrity are enforced", async () => {
  for (const tree of [
    Array.from({ length: 257 }, (_, i) => blob(i ? `file${i}` : "SKILL.md", skill)),
    [{ ...blob("SKILL.md", skill), size: 256 * 1024 + 1 }],
    [blob("SKILL.md", skill), { ...blob("big", skill), size: 5 * 1024 * 1024 + 1 }],
    [blob("SKILL.md", skill), ...Array.from({ length: 5 }, (_, i) => ({ ...blob(`large${i}`, skill), size: 5 * 1024 * 1024 }))],
  ]) {
    const f = fixture({ tree });
    await assert.rejects(f.sources.resolveBundle({ source: "github", url: `https://github.com/acme/skills/tree/${COMMIT}/example` }), { code: "SIZE_LIMIT" });
    assert.equal(f.calls.some(({ url }) => url.hostname === "raw.githubusercontent.com"), false);
  }
  const corrupt = fixture({ override: (url) => url.hostname === "raw.githubusercontent.com" ? new Response(new Uint8Array(skill.length)) : undefined });
  await assert.rejects(corrupt.sources.resolveBundle({ source: "github", url: `https://github.com/acme/skills/tree/${COMMIT}/example` }), (error) => ["HASH_MISMATCH", "SIZE_MISMATCH"].includes(error.code));
});

test("JSON requires strict UTF-8, responses are streamed with byte limits and redirects fail", async () => {
  const invalid = createSkillSources({ fetcher: async () => new Response(new Uint8Array([0xff, 0xfe])) });
  assert.equal((await invalid.search({ source: "skillstore" })).sources[0].code, "INVALID_JSON");
  const oversized = createSkillSources({ fetcher: async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)) });
  assert.equal((await oversized.search({ source: "skillstore" })).sources[0].code, "SIZE_LIMIT");
  const redirect = createSkillSources({ fetcher: async () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }) });
  assert.equal((await redirect.search({ source: "skillstore" })).sources[0].code, "REDIRECT_BLOCKED");
});

test("abort cancels stalled fetch/body reads and limits concurrency to six", async () => {
  const controller = new AbortController();
  const stalled = createSkillSources({ fetcher: () => new Promise(() => {}) });
  const pending = stalled.search({ source: "all", signal: controller.signal });
  controller.abort(new Error("Cancelled by caller"));
  await assert.rejects(pending, /Cancelled by caller/);
  let reading; const started = new Promise((resolve) => { reading = resolve; });
  const bodyController = new AbortController();
  const stream = createSkillSources({ fetcher: async () => new Response(new ReadableStream({ start() { reading(); }, pull() { return new Promise(() => {}); } })) });
  const readingResult = stream.search({ source: "skillsmp", signal: bodyController.signal });
  await started; bodyController.abort(); await assert.rejects(readingResult);
  let active = 0, maximum = 0;
  const many = createSkillSources({ fetcher: async () => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 2)); active--; return json({ skills: [] }); } });
  await Promise.all(Array.from({ length: 10 }, () => many.search({ source: "skills-sh", query: "x" })));
  assert.equal(maximum, 6);
});
