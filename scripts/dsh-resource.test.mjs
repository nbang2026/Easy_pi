import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareRuntime } from "./prepare-claude-runtime.mjs";

const version = "0.2.1-alpha.5";
const target = { platform: "darwin", arch: "arm64" };
const hash = (text) => createHash("sha256").update(text).digest("hex");

async function fixture(t) {
  const project = await mkdtemp(join(tmpdir(), "dsh-resource-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const source = join(project, "agent-runtime");
  const destination = join(project, "src-tauri", "claude-runtime");
  const put = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === "object" ? JSON.stringify(value, null, 2) : value);
  };
  const pkg = async (name, metadata, resources = {}) => {
    const path = join(source, "node_modules", name);
    await put(join(path, "package.json"), { name, version, ...metadata });
    await put(join(path, "LICENSE"), `License for ${name}`);
    for (const [file, content] of Object.entries(resources)) await put(join(path, file), content);
    return path;
  };
  const packageJson = { private: true, type: "module", engines: { node: ">=22.19.0" },
    dependencies: { "@deepseek-ai/dsh-sdk-client": version, "@deepseek-ai/dsh": version,
      "@anthropic-ai/claude-agent-sdk": "0.3.301" }, devDependencies: { "dev-only": "1.0.0" } };
  await put(join(source, "package.json"), packageJson);
  const lock = { lockfileVersion: 2, packages: {
    "native-darwin-arm64": [`native-darwin-arm64@${version}`, "", { os: "darwin", cpu: "arm64" }],
    "native-win32-x64": [`native-win32-x64@${version}`, "", { os: "win32", cpu: "x64" }],
  } };
  await put(join(source, "bun.lock"), lock);
  for (const file of ["claude-sidecar.mjs", "runtime.mjs", "dsh-runtime.mjs", "dsh-adapter.mjs", "display-history.mjs"]) await put(join(source, file), `// ${file}\n`);
  for (const name of ["gui-library.mjs", "gui-market.mjs", "gui-skills.mjs", "gui-usage.mjs", "pi-paths.mjs", "privacy.mjs", "skill-sources.mjs", "agent-sources.mjs", "task-routing.mjs"]) await put(join(project, "src-tauri", "src", name), `// shared ${name}\n`);
  await put(join(source, "NOTICE"), "Root runtime notice\n");
  await pkg("@deepseek-ai/dsh-sdk-client", { exports: { ".": { types: "./lib/index.d.ts", default: "./lib/index.js" } },
    dependencies: { "@deepseek-ai/dsh": version }, peerDependencies: { "runtime-peer": version } }, { "lib/index.js": "export {};\n" });
  await pkg("@deepseek-ai/dsh", { bin: { dsh: "lib/bin.js" }, dependencies: { "profile-plugin": version },
    optionalDependencies: { "native-darwin-arm64": version, "native-win32-x64": version } },
  { "lib/bin.js": "#!/usr/bin/env node\n", "profiles/sdk-minimal.yaml": "plugins: [profile-plugin]\n", "assets/template.txt": "runtime asset\n", NOTICE: "DSH notice\n" });
  await pkg("profile-plugin", { dependencies: { "runtime-leaf": version } }, { "lib/index.js": "export {};\n" });
  await pkg("runtime-leaf", {}, { "data/default.json": "{}\n" });
  await pkg("runtime-peer", {}, { "index.js": "export {};\n" });
  await pkg("native-darwin-arm64", { os: ["darwin"], cpu: ["arm64"] }, { "binding.node": "fixture native binary bytes\n" });
  await pkg("native-win32-x64", { os: ["win32"], cpu: ["x64"] }, { "binding.node": "fixture Windows binary bytes\n" });
  await pkg("@anthropic-ai/claude-agent-sdk", { version: "0.3.301", optionalDependencies: {
    "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.301", "@anthropic-ai/claude-agent-sdk-win32-x64": "0.3.301",
  } }, { "sdk.mjs": "Claude SDK\n" });
  await pkg("@anthropic-ai/claude-agent-sdk-darwin-arm64", { version: "0.3.301", os: ["darwin"], cpu: ["arm64"] }, { claude: "Claude executable\n" });
  await pkg("@anthropic-ai/claude-agent-sdk-win32-x64", { version: "0.3.301", os: ["win32"], cpu: ["x64"] }, { "claude.exe": "Claude executable\n" });
  await pkg("dev-only", {}, { "index.js": "dev tool\n" });
  const run = (options = {}) => prepareRuntime({ project, ...target, ...options });
  return { project, source, destination, put, pkg, packageJson, lock, run };
}

async function missing(path) { await assert.rejects(access(path), { code: "ENOENT" }); }

test("stages the exact DSH production closure, assets, notices, helpers, and manifest", async (t) => {
  const f = await fixture(t);
  const manifest = await f.run();
  assert.equal(manifest.engine, "claude");
  assert.equal(manifest.claudeSdkVersion, "0.3.301");
  assert.equal(manifest.claudeNativeEntry, "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
  assert.equal(manifest.sdkVersion, version);
  assert.equal(manifest.dshVersion, version);
  assert.equal(manifest.entry, "claude-sidecar.mjs");
  assert.equal(manifest.sdkEntry, "node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js");
  assert.equal(manifest.dshEntry, "node_modules/@deepseek-ai/dsh/lib/bin.js");
  assert.equal(manifest.target, "darwin-arm64");
  assert.equal(manifest.nodeRequirement, ">=22.19.0");
  assert.deepEqual(manifest.nativeDependencies.map((item) => item.name), ["@anthropic-ai/claude-agent-sdk-darwin-arm64", "native-darwin-arm64"]);
  assert.ok(manifest.licenses.includes("NOTICE"));
  assert.ok(manifest.licenses.includes("node_modules/@deepseek-ai/dsh/NOTICE"));
  for (const path of ["runtime.mjs", "dsh-runtime.mjs", "dsh-adapter.mjs", "gui-library.mjs", "gui-market.mjs", "gui-usage.mjs", "task-routing.mjs", "pi-paths.mjs", "privacy.mjs", "bun.lock",
    "node_modules/runtime-peer/index.js", "node_modules/runtime-leaf/data/default.json", "node_modules/@deepseek-ai/dsh/profiles/sdk-minimal.yaml",
    "node_modules/@deepseek-ai/dsh/assets/template.txt", "node_modules/native-darwin-arm64/binding.node"]) {
    assert.equal(manifest.files[path], hash(await readFile(join(f.destination, path))));
  }
  for (const name of ["dev-only", "native-win32-x64", "@anthropic-ai/claude-agent-sdk-win32-x64"]) await missing(join(f.destination, "node_modules", name));
  await access(join(f.destination, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"));
  assert.deepEqual(await f.run({ check: true }), manifest);
});

test("check detects tampering, extra files, source changes, and new source assets", async (t) => {
  const f = await fixture(t);
  await f.run();
  await f.put(join(f.destination, "dsh-runtime.mjs"), "tampered\n");
  await assert.rejects(f.run({ check: true }), /modified: dsh-runtime\.mjs/);
  await f.run();
  await f.put(join(f.destination, "unexpected.txt"), "extra\n");
  await assert.rejects(f.run({ check: true }), /inventory is incomplete/);
  await f.run();
  await f.put(join(f.source, "runtime.mjs"), "changed source\n");
  await assert.rejects(f.run({ check: true }), /source is stale: runtime\.mjs/);
  await f.run();
  await f.put(join(f.source, "node_modules/runtime-leaf/data/default.json"), "{\"changed\":true}\n");
  await assert.rejects(f.run({ check: true }), /source is stale: node_modules\/runtime-leaf\/data\/default.json/);
  await f.run();
  await f.put(join(f.source, "node_modules/@deepseek-ai/dsh/assets/new.txt"), "new asset\n");
  await assert.rejects(f.run({ check: true }), /source inventory is stale/);
});

test("optional adapter changes invalidate source freshness", async (t) => {
  const f = await fixture(t);
  await rm(join(f.source, "dsh-adapter.mjs"));
  const manifest = await f.run();
  assert.equal(manifest.files["dsh-adapter.mjs"], undefined);
  await f.put(join(f.source, "dsh-adapter.mjs"), "export {};\n");
  await assert.rejects(f.run({ check: true }), /source inventory is stale/);
});

test("uses target package metadata and fails when a required target optional native is missing", async (t) => {
  const f = await fixture(t);
  const windows = await f.run({ platform: "win32", arch: "x64" });
  assert.equal(windows.target, "win32-x64");
  assert.deepEqual(windows.nativeDependencies.map((item) => item.name), ["@anthropic-ai/claude-agent-sdk-win32-x64", "native-win32-x64"]);
  assert.deepEqual(await f.run({ platform: "win32", arch: "x64", check: true, runtime: f.destination }), windows);
  await missing(join(f.destination, "node_modules/native-darwin-arm64"));
  await assert.rejects(f.run({ check: true }), /target is stale/);
  await rm(join(f.source, "node_modules/native-win32-x64"), { recursive: true });
  await assert.rejects(f.run({ platform: "win32", arch: "x64" }), /Missing target-specific optional dependency native-win32-x64/);
  const unchanged = JSON.parse(await readFile(join(f.destination, "runtime-manifest.json"), "utf8"));
  assert.deepEqual(unchanged, windows);
  await f.pkg("native-win32-x64", { os: ["darwin"], cpu: ["arm64"] }, { "binding.node": "wrong host binary" });
  await assert.rejects(f.run({ platform: "win32", arch: "x64" }), /does not support win32-x64/);
});

test("runtime path override is validation-only", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ runtime: f.destination }), /only be used with --check/);
  await missing(f.destination);
});

test("validates exact SDK pins and installed versions without replacing the previous stage", async (t) => {
  const f = await fixture(t);
  const original = await f.run();
  f.packageJson.dependencies["@deepseek-ai/dsh-sdk-client"] = `^${version}`;
  await f.put(join(f.source, "package.json"), f.packageJson);
  await assert.rejects(f.run(), /pinned to exact published versions/);
  f.packageJson.dependencies["@deepseek-ai/dsh-sdk-client"] = version;
  await f.put(join(f.source, "package.json"), f.packageJson);
  const path = join(f.source, "node_modules/@deepseek-ai/dsh/package.json");
  const dsh = JSON.parse(await readFile(path, "utf8"));
  await f.put(path, { ...dsh, version: "0.2.1-alpha.4" });
  await assert.rejects(f.run(), /must match their exact pinned versions/);
  assert.deepEqual(JSON.parse(await readFile(join(f.destination, "runtime-manifest.json"), "utf8")), original);
  assert.deepEqual((await readdir(join(f.project, "src-tauri"))).sort(), ["claude-runtime", "src"]);
});

test("rejects installed dependency versions that differ from the lockfile", async (t) => {
  const f = await fixture(t);
  await f.run();
  const path = join(f.source, "node_modules/native-darwin-arm64/package.json");
  const metadata = JSON.parse(await readFile(path, "utf8"));
  await f.put(path, { ...metadata, version: "0.2.1-alpha.4" });
  await assert.rejects(f.run({ check: true }), /does not match bun\.lock/);
});

test("preserves nested production package versions and excludes nested dev packages", async (t) => {
  const f = await fixture(t);
  const nested = join(f.source, "node_modules/profile-plugin/node_modules/runtime-leaf");
  await f.put(join(nested, "package.json"), { name: "runtime-leaf", version: "0.1.0" });
  await f.put(join(nested, "LICENSE"), "nested production license");
  await f.put(join(nested, "index.js"), "nested production implementation");
  await f.put(join(f.source, "node_modules/profile-plugin/node_modules/dev-nested/package.json"), { name: "dev-nested", version: "1.0.0" });
  const manifest = await f.run();
  assert.ok(manifest.files["node_modules/profile-plugin/node_modules/runtime-leaf/index.js"]);
  await missing(join(f.destination, "node_modules/profile-plugin/node_modules/dev-nested"));
  await f.run({ check: true });
});

test("dereferences installed package links and rejects symlinks introduced into the stage", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const path = join(f.source, "node_modules/runtime-leaf/data");
  await symlink("default.json", join(path, "linked.json"));
  const manifest = await f.run();
  const staged = join(f.destination, "node_modules/runtime-leaf/data/linked.json");
  assert.equal((await lstat(staged)).isSymbolicLink(), false);
  assert.equal(manifest.files["node_modules/runtime-leaf/data/linked.json"], hash("{}\n"));
  await f.run({ check: true });
  await rm(staged);
  await symlink("default.json", staged);
  await assert.rejects(f.run({ check: true }), /non-file resource/);
});

test("rejects unsafe metadata entry paths and invalid targets", async (t) => {
  const f = await fixture(t);
  const path = join(f.source, "node_modules/@deepseek-ai/dsh/package.json");
  const dsh = JSON.parse(await readFile(path, "utf8"));
  await f.put(path, { ...dsh, bin: { dsh: "../../outside.js" } });
  await assert.rejects(f.run(), /escapes its package/);
  await assert.rejects(f.run({ platform: "win32", libc: "musl" }), /Unsupported runtime target/);
  await missing(f.destination);
});
