#!/usr/bin/env node
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = "@deepseek-ai/dsh-sdk-client";
const DSH = "@deepseek-ai/dsh";
const CLAUDE = "@anthropic-ai/claude-agent-sdk";
const ENTRY = "claude-sidecar.mjs";
const MANIFEST = "runtime-manifest.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const portable = (path) => path.replaceAll("\\", "/");
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const licenseFile = (path) => /(?:^|\/)(?:licen[sc]e|copying|notice|copyright)(?:\.|$)/i.test(path);

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function files(directory, prefix = "") {
  const result = [];
  for (const item of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) result.push(...await files(directory, path));
    else if (item.isFile()) result.push(path);
    else throw new Error(`Staged runtime contains a non-file resource: ${path}`);
  }
  return result.sort();
}

function targetOptions({ platform = process.platform, arch = process.arch, libc = "" }) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)
    || !["", "glibc", "musl"].includes(libc) || (libc && platform !== "linux")) throw new Error("Unsupported runtime target.");
  if (platform === "linux" && !libc) libc = process.platform === "linux"
    && !process.report?.getReport()?.header?.glibcVersionRuntime ? "musl" : "glibc";
  return { platform, arch, libc, target: `${platform}-${arch}${libc === "musl" ? "-musl" : ""}` };
}

function permits(values, value) {
  if (!values) return true;
  const list = Array.isArray(values) ? values : [values];
  return !list.includes(`!${value}`) && (list.every((item) => item.startsWith("!")) || list.includes(value) || list.includes("any"));
}
function compatible(metadata, target) {
  return permits(metadata.os, target.platform) && permits(metadata.cpu, target.arch)
    && (!metadata.libc || (target.platform === "linux" && permits(metadata.libc, target.libc)));
}
function platformSpecific(metadata) { return Boolean(metadata.os || metadata.cpu || metadata.libc); }

// Bun's text lockfile is JSON with trailing commas. Keep its package metadata so
// absent target-specific optional dependencies cannot silently become host binaries.
async function lockPackages(source) {
  const text = await readFile(join(source, "bun.lock"), "utf8");
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1")).packages || {};
}

async function dependencyPlan(source, rootPackage, target) {
  const locked = await lockPackages(source);
  const packages = new Map();
  const modules = join(source, "node_modules");
  async function locate(name, from) {
    if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name)) throw new Error(`Invalid dependency name: ${name}`);
    let directory = from;
    while (directory === source || directory.startsWith(`${source}${sep}`)) {
      const candidate = join(directory, "node_modules", name);
      if (await exists(join(candidate, "package.json"))) return candidate;
      if (directory === source) break;
      directory = dirname(directory);
    }
    return null;
  }
  function lockRecord(name, from) {
    const parent = portable(relative(modules, from)).replaceAll("/node_modules/", "/");
    const keys = [parent && `${parent}/${name}`, name].filter(Boolean);
    const record = keys.map((key) => locked[key]).find(Boolean);
    if (record) return record;
    const candidates = Object.entries(locked).filter(([key]) => key.endsWith(`/${name}`));
    return candidates.length === 1 ? candidates[0][1] : null;
  }
  function optionalMetadata(name, from) { return lockRecord(name, from)?.[2] || null; }
  async function visit(name, from, optional = false, peer = false) {
    const directory = await locate(name, from);
    if (!directory) {
      const metadata = optionalMetadata(name, from);
      if (optional && (!metadata || !platformSpecific(metadata) || !compatible(metadata, target))) return;
      if (peer && optional) return;
      throw new Error(`Missing ${optional ? "target-specific optional" : "production"} dependency ${name} for ${target.target}. Install the pinned dependencies for this target before staging.`);
    }
    const metadata = await json(join(directory, "package.json"));
    if (metadata.name !== name) throw new Error(`Installed dependency ${name} has unexpected package name ${metadata.name}.`);
    const installedKey = portable(relative(modules, directory)).replaceAll("/node_modules/", "/");
    const lockedName = (locked[installedKey] || lockRecord(name, from))?.[0];
    const lockedVersion = lockedName?.startsWith(`${name}@`) ? lockedName.slice(name.length + 1) : "";
    if (exactVersion.test(lockedVersion) && metadata.version !== lockedVersion) throw new Error(`Installed dependency ${name}@${metadata.version} does not match bun.lock ${lockedVersion}.`);
    if (!compatible(metadata, target)) {
      const lockedMetadata = optionalMetadata(name, from);
      if (optional && (!lockedMetadata || !platformSpecific(lockedMetadata) || !compatible(lockedMetadata, target))) return;
      throw new Error(`Dependency ${name}@${metadata.version} does not support ${target.target}; installed package metadata targets ${JSON.stringify({ os: metadata.os, cpu: metadata.cpu, libc: metadata.libc })}.`);
    }
    const path = portable(relative(source, directory));
    if (packages.has(path)) return;
    packages.set(path, { directory, path, metadata });
    const optionalDependencies = metadata.optionalDependencies || {};
    for (const dependency of Object.keys(metadata.dependencies || {})) {
      if (!(dependency in optionalDependencies)) await visit(dependency, directory);
    }
    for (const dependency of Object.keys(optionalDependencies)) await visit(dependency, directory, true);
    for (const dependency of Object.keys(metadata.peerDependencies || {})) {
      if (dependency in (metadata.dependencies || {}) || dependency in optionalDependencies) continue;
      await visit(dependency, directory, metadata.peerDependenciesMeta?.[dependency]?.optional === true, true);
    }
  }
  for (const name of Object.keys(rootPackage.dependencies || {})) await visit(name, source);
  for (const name of Object.keys(rootPackage.optionalDependencies || {})) await visit(name, source, true);
  return [...packages.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function safePackagePath(directory, path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\")) throw new Error("Invalid package entry path.");
  const absolute = resolve(directory, path);
  if (!absolute.startsWith(`${directory}${sep}`)) throw new Error(`Package entry escapes its package: ${path}`);
  return absolute;
}
function defaultExport(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(defaultExport).find(Boolean);
  if (value && typeof value === "object") return defaultExport(value.import) || defaultExport(value.node) || defaultExport(value.default);
}

async function runtimeMetadata(root, expected) {
  const sdkDirectory = join(root, "node_modules", SDK);
  const dshDirectory = join(root, "node_modules", DSH);
  const sdk = await json(join(sdkDirectory, "package.json"));
  const dsh = await json(join(dshDirectory, "package.json"));
  const claude = await json(join(root, "node_modules", CLAUDE, "package.json"));
  if (claude.version !== expected.claudeSdkVersion) throw new Error("Claude SDK must match its exact pinned version.");
  if (sdk.version !== expected.sdkVersion || dsh.version !== expected.dshVersion) throw new Error("Installed DSH and SDK must match their exact pinned versions.");
  const sdkEntry = defaultExport(sdk.exports?.["."] || sdk.exports) || sdk.main;
  const bin = typeof dsh.bin === "string" ? dsh.bin : dsh.bin?.dsh;
  for (const [directory, path] of [[sdkDirectory, sdkEntry], [dshDirectory, bin]]) {
    if (!(await stat(safePackagePath(directory, path))).isFile()) throw new Error(`Missing DSH runtime entry: ${path}`);
  }
  return { sdkEntry: portable(relative(root, safePackagePath(sdkDirectory, sdkEntry))),
    dshEntry: portable(relative(root, safePackagePath(dshDirectory, bin))) };
}

async function sourcePlan(project, target) {
  const source = join(project, "agent-runtime");
  const packageJson = await json(join(source, "package.json"));
  const sdkVersion = packageJson.dependencies?.[SDK], dshVersion = packageJson.dependencies?.[DSH];
  const claudeSdkVersion = packageJson.dependencies?.[CLAUDE];
  if (!exactVersion.test(claudeSdkVersion || "")) throw new Error("Claude SDK must be pinned to an exact published version.");
  if (!exactVersion.test(sdkVersion || "") || !exactVersion.test(dshVersion || "")) throw new Error("DSH and SDK must be pinned to exact published versions, including any prerelease suffix.");
  const sourceFiles = [ENTRY, "runtime.mjs", "dsh-runtime.mjs", "display-history.mjs", "package.json", "bun.lock"].map((path) => [join(source, path), path]);
  if (await exists(join(source, "dsh-adapter.mjs"))) sourceFiles.push([join(source, "dsh-adapter.mjs"), "dsh-adapter.mjs"]);
  for (const name of ["gui-library.mjs", "gui-market.mjs", "gui-skills.mjs", "gui-usage.mjs", "pi-paths.mjs", "privacy.mjs", "skill-sources.mjs", "agent-sources.mjs", "task-routing.mjs"]) sourceFiles.push([join(project, "src-tauri", "src", name), name]);
  // Preserve root notices as well as notices inside every production package.
  for (const item of await readdir(source, { withFileTypes: true })) if (item.isFile() && licenseFile(item.name)) sourceFiles.push([join(source, item.name), item.name]);
  const packages = await dependencyPlan(source, packageJson, target);
  const metadata = await runtimeMetadata(source, { sdkVersion, dshVersion, claudeSdkVersion });
  const claudeNativeEntry = `node_modules/${CLAUDE}-${target.target}/claude${target.platform === "win32" ? ".exe" : ""}`;
  for (const path of [`node_modules/${CLAUDE}/sdk.mjs`, claudeNativeEntry]) {
    if (!(await stat(join(source, path))).isFile()) throw new Error(`Missing Claude runtime entry: ${path}`);
  }
  const expected = {};
  for (const [original, path] of sourceFiles) expected[path] = sha(await readFile(original));
  for (const item of packages) {
    const collect = async (directory, prefix = "") => {
      for (const child of await readdir(directory, { withFileTypes: true })) {
        if (["node_modules", ".bin", ".cache"].includes(child.name)) continue;
        const original = join(directory, child.name), path = `${item.path}/${prefix}${child.name}`;
        // cp dereferences links; stat/readFile here account for their actual bytes.
        const info = child.isSymbolicLink() ? await stat(original) : child;
        if (info.isDirectory()) await collect(original, `${prefix}${child.name}/`);
        else if (info.isFile()) expected[path] = sha(await readFile(original));
        else throw new Error(`Unsupported dependency resource: ${original}`);
      }
    };
    await collect(item.directory);
  }
  const nativeDependencies = packages.filter((item) => platformSpecific(item.metadata)
    || Object.keys(expected).some((path) => path.startsWith(`${item.path}/`) && /\.(?:node|dll|dylib|so|exe)$/.test(path)))
    .map(({ path, metadata }) => ({ name: metadata.name, version: metadata.version, path,
      ...(metadata.os ? { os: metadata.os } : {}), ...(metadata.cpu ? { cpu: metadata.cpu } : {}), ...(metadata.libc ? { libc: metadata.libc } : {}) }));
  return { source, sourceFiles, packages, expected, sdkVersion, dshVersion, claudeSdkVersion, claudeNativeEntry, nativeDependencies, ...metadata,
    nodeRequirement: packageJson.engines?.node || ">=22.19.0" };
}

async function validateStage(root, plan, target) {
  const manifest = await json(join(root, MANIFEST));
  const fields = { version: 2, target: target.target, engine: "claude", sdkVersion: plan.sdkVersion, dshVersion: plan.dshVersion,
    claudeSdkVersion: plan.claudeSdkVersion, claudeNativeEntry: plan.claudeNativeEntry,
    entry: ENTRY, sdkEntry: plan.sdkEntry, dshEntry: plan.dshEntry, nodeRequirement: plan.nodeRequirement };
  for (const [key, value] of Object.entries(fields)) if (manifest[key] !== value) throw new Error(`Runtime manifest ${key} is stale or invalid.`);
  if (JSON.stringify(manifest.nativeDependencies) !== JSON.stringify(plan.nativeDependencies)) throw new Error("Runtime native dependency inventory is stale or invalid.");
  await runtimeMetadata(root, plan);
  const inventory = (await files(root)).filter((path) => path !== MANIFEST);
  if (JSON.stringify(inventory) !== JSON.stringify(Object.keys(manifest.files || {}).sort())) throw new Error("Staged runtime file inventory is incomplete.");
  if (JSON.stringify(inventory) !== JSON.stringify(Object.keys(plan.expected).sort())) throw new Error("Staged runtime source inventory is stale.");
  const licenses = inventory.filter(licenseFile);
  if (!licenses.length || JSON.stringify(licenses) !== JSON.stringify(manifest.licenses)) throw new Error("Runtime license inventory is incomplete.");
  for (const path of inventory) {
    if (sha(await readFile(join(root, path))) !== manifest.files[path]) throw new Error(`Staged runtime is incomplete or modified: ${path}`);
    if (manifest.files[path] !== plan.expected[path]) throw new Error(`Staged source is stale: ${path}`);
  }
  return manifest;
}

export async function prepareRuntime({ project = resolve(dirname(fileURLToPath(import.meta.url)), ".."), check = false, runtime, ...options } = {}) {
  project = resolve(project);
  const target = targetOptions(options);
  if (runtime && !check) throw new Error("--runtime can only be used with --check.");
  const destination = runtime ? resolve(runtime) : join(project, "src-tauri", "claude-runtime");
  const plan = await sourcePlan(project, target);
  if (check) return validateStage(destination, plan, target);
  const temporary = `${destination}.staging-${randomUUID()}`;
  const backup = `${destination}.backup-${randomUUID()}`;
  await mkdir(temporary, { recursive: true });
  try {
    for (const [original, path] of plan.sourceFiles) await cp(original, join(temporary, path));
    for (const item of plan.packages) {
      const output = join(temporary, item.path);
      await mkdir(dirname(output), { recursive: true });
      await cp(item.directory, output, { recursive: true, dereference: true,
        filter: (path) => !relative(item.directory, path).split(/[\\/]/).some((part) => ["node_modules", ".bin", ".cache"].includes(part)) });
    }
    const inventory = await files(temporary);
    const hashes = {};
    for (const path of inventory) hashes[path] = sha(await readFile(join(temporary, path)));
    await writeFile(join(temporary, MANIFEST), JSON.stringify({ version: 2, engine: "claude", sdkVersion: plan.sdkVersion,
      claudeSdkVersion: plan.claudeSdkVersion, claudeNativeEntry: plan.claudeNativeEntry,
      dshVersion: plan.dshVersion, target: target.target, entry: ENTRY, sdkEntry: plan.sdkEntry, dshEntry: plan.dshEntry,
      nodeRequirement: plan.nodeRequirement, nativeDependencies: plan.nativeDependencies,
      licenses: inventory.filter(licenseFile), files: hashes }, null, 2) + "\n");
    const manifest = await validateStage(temporary, plan, target);
    // Keep the complete previous stage available until the validated replacement
    // has been renamed into place. Restore it if that final rename fails.
    const previous = await exists(destination);
    if (previous) await rename(destination, backup);
    try { await rename(temporary, destination); }
    catch (error) {
      if (previous) await rename(backup, destination);
      throw error;
    }
    if (previous) await rm(backup, { recursive: true, force: true });
    return manifest;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function argumentsFor(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--check") options.check = true;
    else if (["--platform", "--arch", "--libc"].includes(args[index])) {
      const flag = args[index], value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
      options[flag.slice(2)] = value;
    } else if (args[index] === "--runtime") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --runtime.");
      options.runtime = resolve(value);
    } else throw new Error(`Unknown option: ${args[index]}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = argumentsFor(process.argv.slice(2));
    const manifest = await prepareRuntime(options);
    console.log(`${options.check ? "Claude runtime complete" : "Prepared Claude runtime"}: SDK ${manifest.claudeSdkVersion}, ${manifest.target}, ${Object.keys(manifest.files).length} resources. Requires Node ${manifest.nodeRequirement}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
