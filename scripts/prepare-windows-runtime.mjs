import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pins = JSON.parse(await readFile(join(root, "scripts/windows-runtime-pins.json"), "utf8"));
export const lock = JSON.parse(await readFile(join(root, "scripts/windows-runtime.lock.json"), "utf8"));
export const runtimeRoot = join(root, pins.runtimeRoot);
export const required = [pins.nodePath, pins.entryPath];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isFile = async (path) => lstat(path).then((s) => s.isFile(), () => false);

export async function hashTree(directory) {
  const files = [];
  async function collect(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await collect(join(current, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
      else if (entry.isSymbolicLink()) throw new Error(`runtime symlink is not allowed: ${relative}`);
      else throw new Error(`unsupported file: ${relative}`);
    }
  }
  await collect(directory);
  files.sort();
  const digest = createHash("sha256");
  for (const relative of files) digest.update(relative).update("\0").update(await readFile(join(directory, relative))).update("\0");
  return digest.digest("hex");
}

export function validatePE(bytes) {
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") return false;
  const offset = bytes.readUInt32LE(0x3c);
  return offset + 6 <= bytes.length && bytes.toString("ascii", offset, offset + 4) === "PE\0\0" && bytes.readUInt16LE(offset + 4) === 0x8664;
}

export async function validateRuntime(runtime = runtimeRoot) {
  const failures = [];
  if (!await lstat(runtime).then((s) => s.isDirectory() && !s.isSymbolicLink(), () => false)) return [`runtime root is missing: ${runtime}`];
  for (const relative of required) if (!await isFile(join(runtime, relative))) failures.push(`missing file: ${relative}`);
  const pkg = await readFile(join(runtime, "app/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8").then(JSON.parse).catch(() => null);
  if (pkg?.name !== pins.piPackage || pkg?.version !== pins.piVersion) failures.push(`Pi package must be ${pins.piPackage}@${pins.piVersion}`);
  if (await isFile(join(runtime, pins.nodePath))) {
    const bytes = await readFile(join(runtime, pins.nodePath));
    if (!validatePE(bytes)) failures.push("node.exe must be a Windows x64 PE executable");
    if (sha256(bytes) !== lock.nodeExecutableSha256) failures.push("node.exe checksum mismatch");
  }
  if (await isFile(join(runtime, pins.entryPath)) && sha256(await readFile(join(runtime, pins.entryPath))) !== lock.entrySha256) failures.push("cli.js checksum mismatch");
  try {
    if (await hashTree(join(runtime, "app/node_modules")) !== lock.dependencyTreeSha256) failures.push("dependency tree checksum mismatch");
    if (await hashTree(join(runtime, "node")) !== lock.nodeTreeSha256) failures.push("Node runtime tree checksum mismatch");
  } catch (error) { failures.push(`runtime tree invalid: ${error.message}`); }
  return failures;
}

export function safeArchivePath(name) {
  return !name.includes("\\") && !name.startsWith("/") && !name.includes(":") && !name.split("/").some((part) => part === ".." || part === ".");
}

export async function prepareRuntime({ archive = process.env.PI_WINDOWS_RUNTIME_ARCHIVE || join(root, "runtime-assets/windows-x64-offline.zip"), destination = runtimeRoot } = {}) {
  const bytes = await readFile(archive);
  if (sha256(bytes) !== lock.archiveSha256) throw new Error("offline archive checksum mismatch");
  const entries = unzipSync(bytes, { filter: (file) => {
    if (!safeArchivePath(file.name)) throw new Error(`unsafe archive path: ${file.name}`);
    return /^[^/]+\/\.local\/(node\/|app\/node_modules\/)/.test(file.name) && !file.name.endsWith("/");
  }});
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), ".windows-runtime-"));
  try {
    for (const [name, content] of Object.entries(entries)) {
      const relative = name.slice(name.indexOf("/.local/") + "/.local/".length);
      const path = join(temporary, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    const failures = await validateRuntime(temporary);
    if (failures.length) throw new Error(failures.join("\n"));
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && (await realpath(process.argv[1]).catch(() => null)) === await realpath(fileURLToPath(import.meta.url))) {
  try {
    if (!process.argv.includes("--check")) {
      const failures = await validateRuntime();
      if (failures.length) await prepareRuntime();
    }
    const failures = await validateRuntime();
    if (failures.length) throw new Error(failures.join("\n"));
    console.log(`Windows runtime OK: Node ${pins.nodeVersion}, ${pins.piPackage}@${pins.piVersion}`);
  } catch (error) { console.error(`Windows runtime validation failed: ${error.message}`); process.exitCode = 1; }
}
