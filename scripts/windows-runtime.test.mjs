import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pins, required, runtimeRoot, validateRuntime, safeArchivePath, validatePE, prepareRuntime, hashTree } from "./prepare-windows-runtime.mjs";

test("runtime pins use the required Windows x64 versions", () => {
  assert.equal(pins.nodeVersion, "22.22.2");
  assert.equal(pins.nodePlatform, "win-x64");
  assert.equal(pins.piVersion, "1.3.0");
  assert.deepEqual(required, ["node/node.exe", "app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"]);
});

test("staged runtime contains both executable anchors", async () => {
  assert.deepEqual(await validateRuntime(runtimeRoot), []);
});

test("validation fails closed for an incomplete tree", async () => {
  const failures = await validateRuntime(runtimeRoot + ".missing");
  assert.match(failures.join("\n"), /runtime root is missing/);
});

test("unsafe archive paths and non-x64 native binaries are rejected", () => {
  for (const name of ["../escape", "/absolute", "C:/drive", "safe/../../escape", "safe\\path"]) assert.equal(safeArchivePath(name), false);
  assert.equal(safeArchivePath("root/.local/node/node.exe"), true);
  assert.equal(validatePE(Buffer.from("not a PE")), false);
  const pe = Buffer.alloc(80); pe.write("MZ"); pe.writeUInt32LE(64, 0x3c); pe.write("PE\0\0", 64); pe.writeUInt16LE(0xaa64, 68);
  assert.equal(validatePE(pe), false); pe.writeUInt16LE(0x8664, 68); assert.equal(validatePE(pe), true);
});

test("archive checksum failure cannot replace an existing runtime", async () => {
  const temp = await mkdtemp(join(tmpdir(), "nbpi-archive-test-"));
  try {
    const archive = join(temp, "tampered.zip");
    await writeFile(archive, "corrupt archive");
    await assert.rejects(prepareRuntime({ archive, destination: runtimeRoot }), /checksum mismatch/);
    assert.deepEqual(await validateRuntime(runtimeRoot), []);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("tree hash detects changed dependency contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nbpi-hash-test-"));
  try {
    await writeFile(join(dir, "a.js"), "old");
    const before = await hashTree(dir);
    await writeFile(join(dir, "a.js"), "new");
    assert.notEqual(await hashTree(dir), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Windows source retains runtime configuration but automatic installer packaging is disabled", async () => {
  const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8"));
  assert.equal(config.bundle.resources["runtime/windows-x64"], "runtime/windows-x64");
  assert.match(config.build.beforeBuildCommand, /prepare-windows-runtime.*--check/);
  assert.equal(config.bundle.windows.webviewInstallMode.type, "offlineInstaller");
  const script = await readFile(new URL("./build-windows.ps1", import.meta.url), "utf8");
  assert.match(script, /LASTEXITCODE/); assert.match(script, /package-source/);
  assert.equal(config.bundle.active, false);
  assert.doesNotMatch(script, /tauri.*build|--bundles/);
  const ci = await readFile(new URL("../.github/workflows/windows.yml", import.meta.url), "utf8");
  assert.match(ci, /package-source/); assert.doesNotMatch(ci, /tauri build|--bundles|verify-windows-installer/);
});

test("source delivery does not enable legacy installer verification", async () => {
  const ci = await readFile(new URL("../.github/workflows/windows.yml", import.meta.url), "utf8");
  assert.match(ci, /easy_pi-windows-source/);
  assert.doesNotMatch(ci, /\.msi|\.exe|tauri build/);
});
